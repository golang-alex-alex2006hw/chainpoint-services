/* Copyright (C) 2017 Tierion
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// load all environment variables into env object
const env = require('./lib/parse-env.js')('audit')

const rp = require('request-promise-native')
const registeredNode = require('./lib/models/RegisteredNode.js')
const nodeAuditLog = require('./lib/models/NodeAuditLog.js')
const utils = require('./lib/utils.js')
const calendarBlock = require('./lib/models/CalendarBlock.js')
const auditChallenge = require('./lib/models/AuditChallenge.js')
const crypto = require('crypto')
const rnd = require('random-number-csprng')
const MerkleTools = require('merkle-tools')
const cnsl = require('consul')
const _ = require('lodash')
const heartbeats = require('heartbeats')

// TweetNaCl.js
// see: http://ed25519.cr.yp.to
// see: https://github.com/dchest/tweetnacl-js#signatures
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

// the fuzz factor for anchor interval meant to give each core instance a random chance of being first
const maxFuzzyMS = 1000

// the amount of credits to top off all Nodes with daily
const creditTopoffAmount = 86400

// create a heartbeat for every 200ms
// 1 second heartbeats had a drift that caused occasional skipping of a whole second
// decreasing the interval of the heartbeat and checking current time resolves this
let heart = heartbeats.createHeart(200)

let consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
console.log('Consul connection established')

// The merkle tools object for building trees and generating proof paths
const merkleTools = new MerkleTools()

// pull in variables defined in shared database models
let regNodeSequelize = registeredNode.sequelize
let RegisteredNode = registeredNode.RegisteredNode
let nodeAuditSequelize = nodeAuditLog.sequelize
let NodeAuditLog = nodeAuditLog.NodeAuditLog
let calBlockSequelize = calendarBlock.sequelize
let CalendarBlock = calendarBlock.CalendarBlock
let auditChallengeSequelize = auditChallenge.sequelize
let AuditChallenge = auditChallenge.AuditChallenge

// The age of the last successful audit before a new audit should be performed for a Node
const NODE_NEW_AUDIT_INTERVAL_MIN = 30 // 30 minutes

// The acceptable time difference between Node and Core for a timestamp to be considered valid, in milliseconds
const ACCEPTABLE_DELTA_MS = 5000 // 5 seconds

// The maximum age of a node audit response to accept
const MAX_NODE_RESPONSE_CHALLENGE_AGE_MIN = 75

// The minimum credit balance to receive awards and be publicly advertised
const MIN_PASSING_CREDIT_BALANCE = 10800

let challengeLockOpts = {
  key: env.CHALLENGE_LOCK_KEY,
  lockwaittime: '60s',
  lockwaittimeout: '60s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'challenge-lock',
    ttl: '30s'
  }
}

let challengeLock = consul.lock(_.merge({}, challengeLockOpts, { value: 'challenge' }))

let auditLockOpts = {
  key: env.AUDIT_LOCK_KEY,
  lockwaittime: '120s',
  lockwaittimeout: '120s',
  lockretrytime: '100ms',
  session: {
    behavior: 'delete',
    checks: ['serfHealth'],
    lockdelay: '1ms',
    name: 'audit-lock',
    ttl: '60s' // at 30s, the lock was deleting before large audit processes would complete
  }
}

let auditLock = consul.lock(_.merge({}, auditLockOpts, { value: 'audit' }))

function registerLockEvents (lock, lockName, acquireFunction) {
  lock.on('acquire', () => {
    console.log(`${lockName} acquired`)
    acquireFunction()
  })

  lock.on('error', (err) => {
    console.error(`${lockName} error - ${err}`)
  })

  lock.on('release', () => {
    console.log(`${lockName} release`)
  })
}

// LOCK HANDLERS : challenge
registerLockEvents(challengeLock, 'challengeLock', async () => {
  try {
    let newChallengeIntervalMinutes = 60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR
    // check if the last challenge is at least newChallengeIntervalMinutes - oneMinuteMS old
    // if not, return and release lock
    let mostRecentChallenge = await AuditChallenge.findOne({ order: [['time', 'DESC']] })
    if (mostRecentChallenge) {
      let oneMinuteMS = 60000
      let currentMS = Date.now()
      let ageMS = currentMS - mostRecentChallenge.time
      let lastChallengeTooRecent = (ageMS < (newChallengeIntervalMinutes * 60 * 1000 - oneMinuteMS))
      if (lastChallengeTooRecent) {
        let ageSec = Math.round(ageMS / 1000)
        console.log(`No work: ${newChallengeIntervalMinutes} minutes must elapse between each new audit challenge. The last one was generated ${ageSec} seconds ago.`)
        return
      }
    }
    await generateAuditChallengeAsync()
  } catch (error) {
    console.error(`Unable to generate audit challenge: ${error.message}`)
  } finally {
    // always release lock
    challengeLock.release()
  }
})

// LOCK HANDLERS : challenge
registerLockEvents(auditLock, 'auditLock', async () => {
  try {
    await auditNodesAsync()
  } catch (error) {
    console.error(`Unable to perform node audits: ${error.message}`)
  } finally {
    // always release lock
    auditLock.release()
  }
})

// Retrieve all registered Nodes with public_uris for auditing.
async function auditNodesAsync () {
  let nodesReadyForAudit = []
  try {
    let lastAuditCutoff = Date.now() - (NODE_NEW_AUDIT_INTERVAL_MIN * 60 * 1000)
    nodesReadyForAudit = await RegisteredNode.findAll(
      {
        where: {
          $or: [
            { lastAuditAt: null },
            { lastAuditAt: { $lte: lastAuditCutoff } }
          ]
        }
      })

    console.log(`${nodesReadyForAudit.length} public Nodes ready for audit were found`)
  } catch (error) {
    console.error(`Could not retrieve public Node list: ${error.message}`)
  }

  // iterate through each Node, requesting an answer to the challenge
  for (let x = 0; x < nodesReadyForAudit.length; x++) {
    // perform the minimum credit check
    let currentCreditBalance = nodesReadyForAudit[x].tntCredit
    let minCreditsPass = (currentCreditBalance >= MIN_PASSING_CREDIT_BALANCE)

    // if there is no public_uri set for this Node, fail all remaining audit tests and continue to the next
    if (!nodesReadyForAudit[x].publicUri) {
      let coreAuditTimestamp = Date.now()
      try {
        await NodeAuditLog.create({
          tntAddr: nodesReadyForAudit[x].tntAddr,
          publicUri: null,
          auditAt: coreAuditTimestamp,
          publicIPPass: false,
          nodeMSDelta: null,
          timePass: false,
          calStatePass: false,
          minCreditsPass: minCreditsPass
        })
        await RegisteredNode.update({ lastAuditAt: coreAuditTimestamp }, { where: { tntAddr: nodesReadyForAudit[x].tntAddr } })
      } catch (error) {
        console.error(`NodeAudit error: ${nodesReadyForAudit[x].tntAddr}: ${error.message} `)
      }
      continue
    }

    // perform the /config checks for the Node
    let coreAuditTimestamp = Date.now()
    let nodeResponse
    let options = {
      headers: [
        {
          name: 'Content-Type',
          value: 'application/json'
        }
      ],
      method: 'GET',
      uri: `${nodesReadyForAudit[x].publicUri}/config`,
      json: true,
      gzip: true,
      timeout: 2500,
      resolveWithFullResponse: true
    }

    try {
      nodeResponse = await rp(options)
      coreAuditTimestamp = Date.now()
    } catch (error) {
      if (error.statusCode) {
        console.log(`NodeAudit: GET failed with status code ${error.statusCode} for ${nodesReadyForAudit[x].publicUri}: ${error.message}`)
      } else {
        console.log(`NodeAudit: GET failed for ${nodesReadyForAudit[x].publicUri}: ${error.message}`)
      }
      try {
        await NodeAuditLog.create({
          tntAddr: nodesReadyForAudit[x].tntAddr,
          publicUri: nodesReadyForAudit[x].publicUri,
          auditAt: coreAuditTimestamp,
          publicIPPass: false,
          nodeMSDelta: null,
          timePass: false,
          calStatePass: false,
          minCreditsPass: minCreditsPass
        })
        await RegisteredNode.update({ lastAuditAt: coreAuditTimestamp }, { where: { tntAddr: nodesReadyForAudit[x].tntAddr } })
      } catch (error) {
        console.error(`NodeAudit error: ${nodesReadyForAudit[x].tntAddr}: ${error.message} `)
      }
      continue
    }

    if (!nodeResponse.body.calendar) {
      console.log(`NodeAudit: GET failed with missing calendar data for ${nodesReadyForAudit[x].publicUri}`)
      try {
        await NodeAuditLog.create({
          tntAddr: nodesReadyForAudit[x].tntAddr,
          publicUri: nodesReadyForAudit[x].publicUri,
          auditAt: coreAuditTimestamp,
          publicIPPass: false,
          nodeMSDelta: null,
          timePass: false,
          calStatePass: false,
          minCreditsPass: minCreditsPass
        })
        await RegisteredNode.update({ lastAuditAt: coreAuditTimestamp }, { where: { tntAddr: nodesReadyForAudit[x].tntAddr } })
      } catch (error) {
        console.error(`NodeAudit error: ${nodesReadyForAudit[x].tntAddr}: ${error.message} `)
      }
      continue
    }
    if (!nodeResponse.body.time) {
      console.log(`NodeAudit: GET failed with missing time for ${nodesReadyForAudit[x].publicUri}`)
      try {
        await NodeAuditLog.create({
          tntAddr: nodesReadyForAudit[x].tntAddr,
          publicUri: nodesReadyForAudit[x].publicUri,
          auditAt: coreAuditTimestamp,
          publicIPPass: false,
          nodeMSDelta: null,
          timePass: false,
          calStatePass: false,
          minCreditsPass: minCreditsPass
        })
        await RegisteredNode.update({ lastAuditAt: coreAuditTimestamp }, { where: { tntAddr: nodesReadyForAudit[x].tntAddr } })
      } catch (error) {
        console.error(`NodeAudit error: ${nodesReadyForAudit[x].tntAddr}: ${error.message} `)
      }
      continue
    }

    try {
      // We've gotten this far, so at least auditedPublicIPAt has passed
      let publicIPPass = true

      // check if the Node timestamp is withing the acceptable range
      let nodeAuditTimestamp = Date.parse(nodeResponse.body.time)
      let timePass = false
      let nodeMSDelta = (nodeAuditTimestamp - coreAuditTimestamp)
      if (Math.abs(nodeMSDelta) <= ACCEPTABLE_DELTA_MS) {
        timePass = true
      }

      let calStatePass = false
      // When a node first comes online, and is still syncing the calendar
      // data, it will not have yet generated the challenge response, and
      // audit_response will be null. In these cases, simply fail the calStatePass
      // audit. If audit_response is not null, verify the cal state for the Node
      if (nodeResponse.body.calendar.audit_response && nodeResponse.body.calendar.audit_response !== 'null') {
        let nodeAuditResponse = nodeResponse.body.calendar.audit_response.split(':')
        let nodeAuditResponseTimestamp = nodeAuditResponse[0]
        let nodeAuditResponseSolution = nodeAuditResponse[1]

        // make sure the audit reponse is newer than MAX_CHALLENGE_AGE_MINUTES
        let coreAuditChallenge
        let minTimestamp = coreAuditTimestamp - (MAX_NODE_RESPONSE_CHALLENGE_AGE_MIN * 60 * 1000)
        if (parseInt(nodeAuditResponseTimestamp) >= minTimestamp) {
          coreAuditChallenge = await AuditChallenge.findOne({ where: { time: nodeAuditResponseTimestamp } })
        }

        // check if the Node challenge solution is correct
        if (coreAuditChallenge) {
          let coreChallengeSolution = nacl.util.decodeUTF8(coreAuditChallenge.solution)
          nodeAuditResponseSolution = nacl.util.decodeUTF8(nodeAuditResponseSolution)

          if (nacl.verify(nodeAuditResponseSolution, coreChallengeSolution)) {
            calStatePass = true
          }
        } else {
          console.error(`NodeAudit: No audit challenge record found for time ${nodeAuditResponseTimestamp} in ${nodeResponse.body.calendar.audit_response}`)
        }
      }

      // update the Node audit results in RegisteredNode
      try {
        await NodeAuditLog.create({
          tntAddr: nodesReadyForAudit[x].tntAddr,
          publicUri: nodesReadyForAudit[x].publicUri,
          auditAt: coreAuditTimestamp,
          publicIPPass: publicIPPass,
          nodeMSDelta: nodeMSDelta,
          timePass: timePass,
          calStatePass: calStatePass,
          minCreditsPass: minCreditsPass
        })
        await RegisteredNode.update({ lastAuditAt: coreAuditTimestamp }, { where: { tntAddr: nodesReadyForAudit[x].tntAddr } })
      } catch (error) {
        throw new Error(`Could not update Node Audit results: ${error.message}`)
      }

      let results = {}
      results.auditAt = coreAuditTimestamp
      results.publicIPPass = publicIPPass
      results.timePass = timePass
      results.calStatePass = calStatePass
      results.minCreditsPass = minCreditsPass

      console.log(`Audit complete for ${nodesReadyForAudit[x].tntAddr} at ${nodesReadyForAudit[x].publicUri}: ${JSON.stringify(results)}`)
    } catch (error) {
      console.error(`NodeAudit error: ${nodesReadyForAudit[x].tntAddr}: ${error.message} `)
    }
  }
}

// Generate a new audit challenge for the Nodes. Audit challenges should be refreshed hourly.
// Audit challenges include a timestamp, minimum block height, maximum block height, and a nonce
async function generateAuditChallengeAsync () {
  try {
    let currentBlockHeight
    let topBlock = await CalendarBlock.findOne({ attributes: ['id'], order: [['id', 'DESC']] })
    if (topBlock) {
      currentBlockHeight = parseInt(topBlock.id, 10)
    } else {
      console.error('Cannot generate challenge, no genesis block found.')
      return
    }
    // calulcate min and max values with special exception for low block count
    let challengeTime = Date.now()
    let challengeMaxBlockHeight = currentBlockHeight > 2000 ? currentBlockHeight - 1000 : currentBlockHeight
    let randomNum = await rnd(10, 1000)
    let challengeMinBlockHeight = challengeMaxBlockHeight - randomNum
    if (challengeMinBlockHeight < 0) challengeMinBlockHeight = 0
    let challengeNonce = crypto.randomBytes(32).toString('hex')

    let challengeSolution = await calculateChallengeSolutionAsync(challengeMinBlockHeight, challengeMaxBlockHeight, challengeNonce)

    let newChallenge = await AuditChallenge.create({
      time: challengeTime,
      minBlock: challengeMinBlockHeight,
      maxBlock: challengeMaxBlockHeight,
      nonce: challengeNonce,
      solution: challengeSolution
    })
    let auditChallenge = `${newChallenge.time}:${newChallenge.minBlock}:${newChallenge.maxBlock}:${newChallenge.nonce}:${newChallenge.solution}`
    console.log(`New challenge generated: ${auditChallenge}`)
  } catch (error) {
    console.error((`Could not generate audit challenge: ${error.message}`))
  }
}

async function calculateChallengeSolutionAsync (min, max, nonce) {
  let blocks = await CalendarBlock.findAll({ where: { id: { $between: [min, max] } }, order: [['id', 'ASC']] })

  if (blocks.length === 0) throw new Error('No blocks returned to create challenge tree')

  merkleTools.resetTree()

  // retrieve all block hashes from blocks array
  let leaves = blocks.map((block) => {
    let blockHashBuffer = Buffer.from(block.hash, 'hex')
    return blockHashBuffer
  })
  // add the nonce to the head of the leaves array
  leaves.unshift(Buffer.from(nonce, 'hex'))

  // Add every hash in leaves to new Merkle tree
  merkleTools.addLeaves(leaves)
  merkleTools.makeTree()

  // calculate the merkle root, the solution to the challenge
  let challengeSolution = merkleTools.getMerkleRoot().toString('hex')

  return challengeSolution
}

async function performCreditTopoffAsync (creditAmount) {
  try {
    await RegisteredNode.update({ tntCredit: creditAmount }, { where: { tntCredit: { $lt: creditAmount } } })
    console.log(`All Nodes topped off to ${creditAmount} credits`)
  } catch (error) {
    console.error(`Unable to perform credit topoff: ${error.message}`)
  }
}

/**
 * Opens a storage connection
 **/
async function openStorageConnectionAsync () {
  let dbConnected = false
  while (!dbConnected) {
    try {
      await regNodeSequelize.sync({ logging: false })
      await nodeAuditSequelize.sync({ logging: false })
      await calBlockSequelize.sync({ logging: false })
      await auditChallengeSequelize.sync({ logging: false })
      console.log('Sequelize connection established')
      dbConnected = true
    } catch (error) {
      // catch errors when attempting to establish connection
      console.error('Cannot establish Sequelize connection. Attempting in 5 seconds...')
      await utils.sleep(5000)
    }
  }
}

async function checkForGenesisBlockAsync () {
  let genesisBlock
  while (!genesisBlock) {
    try {
      genesisBlock = await CalendarBlock.findOne({ where: { id: 0 } })
      // if the genesis block does not exist, wait 5 seconds and try again
      if (!genesisBlock) await utils.sleep(5000)
    } catch (error) {
      console.error(`Unable to query calendar: ${error.message}`)
      process.exit(1)
    }
  }
  console.log(`Genesis block found, calendar confirmed to exist`)
}

function setGenerateNewChallengeInterval () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NEW_AUDIT_CHALLENGES_PER_HOUR
  let newChallengeMinutes = []
  let minuteOfHour = 0
  // offset interval to spread the work around the clock a little bit,
  // to prevent everuything from happening at the top of the hour
  let offset = Math.floor((60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR) / 2)
  while (minuteOfHour < 60) {
    let offsetMinutes = minuteOfHour + offset + ((minuteOfHour + offset) < 60 ? 0 : -60)
    newChallengeMinutes.push(offsetMinutes)
    minuteOfHour += (60 / env.NEW_AUDIT_CHALLENGES_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (newChallengeMinutes.includes(currentMinute)) {
        let randomFuzzyMS = await rnd(0, maxFuzzyMS)
        setTimeout(() => {
          try {
            challengeLock.acquire()
          } catch (error) {
            console.error('challengeLock.acquire(): caught err: ', error.message)
          }
        }, randomFuzzyMS)
      }
    }
  })
}

function setPerformNodeAuditInterval () {
  let currentMinute = new Date().getUTCMinutes()

  // determine the minutes of the hour to run process based on NODE_AUDIT_ROUNDS_PER_HOUR
  let nodeAuditRoundsMinutes = []
  let minuteOfHour = 0
  while (minuteOfHour < 60) {
    nodeAuditRoundsMinutes.push(minuteOfHour)
    minuteOfHour += (60 / env.NODE_AUDIT_ROUNDS_PER_HOUR)
  }

  heart.createEvent(1, async function (count, last) {
    let now = new Date()

    // if we are on a new minute
    if (now.getUTCMinutes() !== currentMinute) {
      currentMinute = now.getUTCMinutes()
      if (nodeAuditRoundsMinutes.includes(currentMinute)) {
        let randomFuzzyMS = await rnd(0, maxFuzzyMS)
        setTimeout(() => {
          try {
            auditLock.acquire()
          } catch (error) {
            console.error('auditLock.acquire(): caught err: ', error.message)
          }
        }, randomFuzzyMS)
      }
    }
  })
}

function setPerformCreditTopoffInterval () {
  let currentDay = new Date().getUTCDate()

  heart.createEvent(5, async function (count, last) {
    let now = new Date()

    // if we are on a new day
    if (now.getUTCDate() !== currentDay) {
      currentDay = now.getUTCDate()
      await performCreditTopoffAsync(creditTopoffAmount)
    }
  })
}

async function startIntervalsAsync () {
  // attempt to generate a new audit chalenge on startup
  let randomFuzzyMS = await rnd(0, maxFuzzyMS)
  setTimeout(() => {
    try {
      challengeLock.acquire()
    } catch (error) {
      console.error('challengeLock.acquire(): caught err: ', error.message)
    }
  }, randomFuzzyMS)

  setGenerateNewChallengeInterval()
  setPerformNodeAuditInterval()
  setPerformCreditTopoffInterval()
}

// process all steps need to start the application
async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init DB
    await openStorageConnectionAsync()
    // ensure at least 1 calendar block exist
    await checkForGenesisBlockAsync()
    // perform initial credit topoff
    // await performCreditTopoffAsync(creditTopoffAmount)
    // start main processing
    await startIntervalsAsync()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
