/* Copyright 2017 Tierion
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*     http://www.apache.org/licenses/LICENSE-2.0
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

const Sequelize = require('sequelize-cockroachdb')

const envalid = require('envalid')

const env = envalid.cleanEnv(process.env, {
  COCKROACH_HOST: envalid.str({ devDefault: 'roach1', desc: 'CockroachDB host or IP' }),
  COCKROACH_PORT: envalid.num({ default: 26257, desc: 'CockroachDB port' }),
  COCKROACH_DB_NAME: envalid.str({ default: 'chainpoint', desc: 'CockroachDB name' }),
  COCKROACH_DB_USER: envalid.str({ default: 'chainpoint', desc: 'CockroachDB user' }),
  COCKROACH_DB_PASS: envalid.str({ default: '', desc: 'CockroachDB password' }),
  COCKROACH_AUDIT_CHALLENGE_TABLE_NAME: envalid.str({ default: 'chainpoint_audit_challenges', desc: 'CockroachDB table name' }),
  COCKROACH_TLS_CA_CRT: envalid.str({ devDefault: '', desc: 'CockroachDB TLS CA Cert' }),
  COCKROACH_TLS_CLIENT_KEY: envalid.str({ devDefault: '', desc: 'CockroachDB TLS Client Key' }),
  COCKROACH_TLS_CLIENT_CRT: envalid.str({ devDefault: '', desc: 'CockroachDB TLS Client Cert' })
})

// Connect to CockroachDB through Sequelize.
let sequelizeOptions = {
  dialect: 'postgres',
  host: env.COCKROACH_HOST,
  port: env.COCKROACH_PORT,
  logging: false
}

// Present TLS client certificate to production cluster
if (env.isProduction) {
  sequelizeOptions.dialectOptions = {
    ssl: {
      rejectUnauthorized: false,
      ca: env.COCKROACH_TLS_CA_CRT,
      key: env.COCKROACH_TLS_CLIENT_KEY,
      cert: env.COCKROACH_TLS_CLIENT_CRT
    }
  }
}

let sequelize = new Sequelize(env.COCKROACH_DB_NAME, env.COCKROACH_DB_USER, env.COCKROACH_DB_PASS, sequelizeOptions)

// Define the model and the table it will be stored in.
var AuditChallenge = sequelize.define(env.COCKROACH_AUDIT_CHALLENGE_TABLE_NAME,
  {
    time: {
      comment: 'Audit time in milliseconds since unix epoch',
      primaryKey: true,
      type: Sequelize.INTEGER, // is 64 bit in CockroachDB
      validate: {
        isInt: true
      },
      field: 'time',
      allowNull: false,
      unique: true
    },
    minBlock: {
      comment: 'The minimum block height included in the challenge calculation',
      type: Sequelize.INTEGER, // is 64 bit in CockroachDB
      validate: {
        isInt: true
      },
      field: 'min_block',
      allowNull: false
    },
    maxBlock: {
      comment: 'The maximum block height included in the challenge calculation',
      type: Sequelize.INTEGER, // is 64 bit in CockroachDB
      validate: {
        isInt: true
      },
      field: 'max_block',
      allowNull: false
    },
    nonce: {
      comment: 'The random nonce hex string included in the challenge calculation',
      type: Sequelize.TEXT,
      validate: {
        is: ['^([a-f0-9]{2})+$', 'i']
      },
      field: 'nonce',
      allowNull: false
    },
    solution: {
      comment: 'The solution for this challenge calculation',
      type: Sequelize.TEXT,
      validate: {
        is: ['^([a-f0-9]{2})+$', 'i']
      },
      field: 'solution',
      allowNull: false
    }
  },
  {
    // No automatic timestamp fields, we add our own 'timestamp' so it is
    // known prior to save so it can be included in the block signature.
    timestamps: false,
    // Disable the modification of table names; By default, sequelize will automatically
    // transform all passed model names (first parameter of define) into plural.
    // if you don't want that, set the following
    freezeTableName: true
  }
)

module.exports = {
  sequelize: sequelize,
  AuditChallenge: AuditChallenge
}