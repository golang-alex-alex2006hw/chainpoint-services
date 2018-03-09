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
const env = require('./lib/parse-env.js')('task-handler')

const r = require('redis')
const nodeResque = require('node-resque')
const utils = require('./lib/utils.js')
const exitHook = require('exit-hook')
const { URL } = require('url')
const debugPkg = require('debug')

// The age of a running job, in miliseconds, for it to be considered stuck/timed out
// This is neccesary to allow resque to determine what is a valid running job, and what
// has been 'stuck' due to service crash/restart. Jobs found in the state are added to the fail queue.
// Workers found with jobs in this state are deleted.
const TASK_TIMEOUT_MS = 60000 // 1 minute timeout

var debug = {
  general: debugPkg('task-handler:general'),
  worker: debugPkg('task-handler:worker'),
  multiworker: debugPkg('task-handler:multiworker')
}
// direct debug to output over STDOUT
debugPkg.log = console.info.bind(console)

const cachedProofState = require('./lib/models/cachedProofStateModels.js')

// This value is set once the connection has been established
let redis = null

const jobs = {
  'prune_agg_states': {
    perform: pruneAggStatesRangeAsync
  },
  'prune_cal_states': {
    perform: pruneCalStatesRangeAsync
  },
  'prune_anchor_btc_agg_states': {
    perform: pruneAnchorBTCAggStatesRangeAsync
  },
  'prune_btctx_states': {
    perform: pruneBTCTxStatesRangeAsync
  },
  'prune_btchead_states': {
    perform: pruneBTCHeadStatesRangeAsync
  }
}

async function pruneAggStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneAggStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from agg_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from agg_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneCalStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneCalStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from cal_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from cal_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneAnchorBTCAggStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneAnchorBTCAggStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from anchor_btc_agg_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from anchor_btc_agg_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneBTCTxStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneBTCTxStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from btctx_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from btctx_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

async function pruneBTCHeadStatesRangeAsync (startTime, endTime) {
  try {
    let delCount = await cachedProofState.pruneBTCHeadStatesRangeAsync(startTime, endTime)
    return `Deleted ${delCount} rows from btchead_states between ${startTime} and ${endTime}`
  } catch (error) {
    let errorMessage = `Could not delete rows from btchead_states between ${startTime} and ${endTime} : ${error.message}`
    throw errorMessage
  }
}

/**
 * Opens a Redis connection
 *
 * @param {string} connectionString - The connection string for the Redis instance, an Redis URI
 */
function openRedisConnection (redisURI) {
  redis = r.createClient(redisURI)
  redis.on('ready', async () => {
    debug.general('Redis connection established')
  })
  redis.on('error', async (err) => {
    console.error(`A redis error has ocurred: ${err}`)
    redis.quit()
    redis = null
    console.error('Cannot establish Redis connection. Attempting in 5 seconds...')
    await utils.sleep(5000)
    openRedisConnection(redisURI)
  })
}

async function cleanUpWorkersAndRequequeJobsAsync (connectionDetails) {
  const queue = new nodeResque.Queue({ connection: connectionDetails })
  await queue.connect()
  // Delete stuck workers and move their stuck job to the failed queue
  await queue.cleanOldWorkers(TASK_TIMEOUT_MS)
  // Get the count of jobs in the failed queue
  let failedCount = await queue.failedCount()
  // Retrieve failed jobs in batches of 100
  // First, determine the batch ranges to retrieve
  let batchSize = 100
  let failedBatches = []
  for (let x = 0; x < failedCount; x += batchSize) {
    failedBatches.push({ start: x, end: x + batchSize - 1 })
  }
  // Retrieve the failed jobs for each batch and collect in 'failedJobs' array
  let failedJobs = []
  for (let x = 0; x < failedBatches.length; x++) {
    let failedJobSet = await queue.failed(failedBatches[x].start, failedBatches[x].end)
    failedJobs = failedJobs.concat(failedJobSet)
  }
  // For each job, remove the job from the failed queue and requeue to its original queue
  for (let x = 0; x < failedJobs.length; x++) {
    debug.worker(`Requeuing job: ${failedJobs[x].payload.queue} : ${failedJobs[x].payload.class} : ${failedJobs[x].error}`)
    await queue.retryAndRemoveFailed(failedJobs[x])
  }
}

async function initResqueWorkerAsync () {
  let redisReady = (redis !== null)
  while (!redisReady) {
    await utils.sleep(100)
    redisReady = (redis !== null)
  }

  const redisURI = new URL(env.REDIS_CONNECT_URI)
  const connectionDetails = {
    host: redisURI.hostname,
    port: redisURI.port,
    namespace: 'resque'
  }
  var multiWorkerConfig = {
    connection: connectionDetails,
    queues: ['task-handler-queue'],
    minTaskProcessors: 10,
    maxTaskProcessors: 100
  }

  await cleanUpWorkersAndRequequeJobsAsync(connectionDetails)

  const multiWorker = new nodeResque.MultiWorker(multiWorkerConfig, jobs)

  multiWorker.on('start', (workerId) => { debug.worker(`worker[${workerId}] : started`) })
  multiWorker.on('end', (workerId) => { debug.worker(`worker[${workerId}] : ended`) })
  multiWorker.on('cleaning_worker', (workerId, worker, pid) => { debug.worker(`worker[${workerId}] : cleaning old worker : ${worker}`) })
  // multiWorker.on('poll', (workerId, queue) => { debug.worker(`worker[${workerId}] : polling : ${queue}`) })
  // multiWorker.on('job', (workerId, queue, job) => { debug.worker(`worker[${workerId}] : working job : ${queue} : ${JSON.stringify(job)}`) })
  multiWorker.on('reEnqueue', (workerId, queue, job, plugin) => { debug.worker(`worker[${workerId}] : re-enqueuing job : ${queue} : ${JSON.stringify(job)}`) })
  multiWorker.on('success', (workerId, queue, job, result) => { debug.worker(`worker[${workerId}] : success : ${queue} : ${result}`) })
  multiWorker.on('failure', (workerId, queue, job, failure) => { console.error(`worker[${workerId}] : failure : ${queue} : ${failure}`) })
  multiWorker.on('error', (workerId, queue, job, error) => { console.error(`worker[${workerId}] : error : ${queue} : ${error}`) })
  // multiWorker.on('pause', (workerId) => { debug.worker(`worker[${workerId}] : paused`) })
  multiWorker.on('internalError', (error) => { console.error(`multiWorker : intneral error : ${error}`) })
  // multiWorker.on('multiWorkerAction', (verb, delay) => { debug.multiworker(`*** checked for worker status : ${verb} : event loop delay : ${delay}ms)`) })

  multiWorker.start()

  exitHook(async () => {
    await multiWorker.end()
  })

  debug.general('Resque worker connection established')
}

// process all steps need to start the application
async function start () {
  try {
    // init Redis
    openRedisConnection(env.REDIS_CONNECT_URI)
    // init Resque worker
    await initResqueWorkerAsync()
    debug.general('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

// get the whole show started
start()
