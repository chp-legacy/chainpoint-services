/* Copyright (C) 2018 Tierion
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
const env = require('./lib/parse-env.js')('nist')

const BEACON = require('nist-randomness-beacon')
const cnsl = require('consul')

let consul = null

let getNistLatest = () => {
  BEACON.last((err, res) => {
    if (err) {
      console.error(err)
    } else {
      // Only collect beacon with valid signature!
      if (res && res.timeStamp && res.seedValue && res.validSignature) {
        let timeAndSeed = `${res.timeStamp.toString()}:${res.seedValue}`.toLowerCase()

        // The latest NIST value will always be stored under
        // a known key which can always be used if present.
        // It will be updated every minute if the service API
        // is available. Clients that are watching this key
        // should gracefully handle null values for this key.
        consul.kv.get(env.NIST_KEY, function (err, result) {
          if (err) {
            console.error(err)
          } else {
            // Only write to the key if the value changed.
            if (!result || result.Value !== timeAndSeed) {
              console.log(`New NIST value received: ${timeAndSeed}`)
              consul.kv.set(env.NIST_KEY, timeAndSeed, function (err, result) {
                if (err) throw err
              })
            }
          }
        })
      }
    }
  })
}

function startIntervals () {
  setInterval(() => {
    try {
      getNistLatest()
    } catch (error) {
      console.error('getNistLatest: caught err: ', error.message)
    }
  }, env.NIST_INTERVAL_MS)
}

async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init consul
    consul = cnsl({ host: env.CONSUL_HOST, port: env.CONSUL_PORT })
    console.log('Consul connection established')
    // get initial value for service start
    getNistLatest()
    // init interval functions
    startIntervals()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

start()
