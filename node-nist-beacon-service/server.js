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

const zmq = require('zeromq')
const BEACON = require('nist-randomness-beacon')
const connections = require('./lib/connections.js')
const utils = require(`./lib/utils.js`)

let nistLatest = null

async function getNistLatestAsync () {
  try {
    let result = await BEACON.getMostRecentPulse()

    // A pulse object being returned without error implies
    // a well formatted, content and signature verified pulse
    let timestampMS = new Date(result.pulse.timeStamp).getTime()
    let timeAndSeed = `${timestampMS}:${result.pulse.localRandomValue}`.toLowerCase()

    nistLatest = timeAndSeed
    console.log(`New NIST value generated: ${timeAndSeed}`)
  } catch (error) {
    console.error(`NIST beacon error : ${error.message}`)
  }
}

function startIntervals () {
  let intervals = [{
    function: async () => {
      try {
        await getNistLatestAsync()
      } catch (error) {
        console.error(`getNistLatest : caught err : ${error.message}`)
      }
    },
    immediate: true, // run this once immediately
    ms: env.NIST_INTERVAL_MS
  }]
  connections.startIntervals(intervals)
}

function initNISTSockets () {
  const responseSocket = zmq.socket(`rep`) // init response socket to handle direct NIST requests from other services on startup
  const publishSocket = zmq.socket(`pub`) // init publish socket to handle broadcasting new NIST values

  responseSocket.bindSync(env.NIST_RES_0MQ_SOCKET_URI)
  publishSocket.bindSync(env.NIST_PUB_0MQ_SOCKET_URI)

  responseSocket.on(`message`, function (msg) {
    console.log(`Received NIST value request : ${nistLatest}`)
    responseSocket.send(nistLatest)
  })

  const topic = `nist`
  let currentNIST = null

  setInterval(function () {
    // ensure that the NIST value has not already been broadcasted
    if (currentNIST !== nistLatest) {
      console.log(`Broadcasting new NIST value : ${nistLatest}`)
      publishSocket.send([topic, nistLatest])
      currentNIST = nistLatest
    }
  }, env.NIST_INTERVAL_MS)
}

async function start () {
  if (env.NODE_ENV === 'test') return
  try {
    // init interval functions
    startIntervals()
    // wait until first valid NIST value is received
    let currentNIST = nistLatest
    while (currentNIST === null) {
      console.log(`Waiting for initial NIST value`)
      await utils.sleep(1000)
      currentNIST = nistLatest
    }
    console.log(`Initial NIST value : ${nistLatest}`)
    // init ZeroMQ sockets
    initNISTSockets()
    console.log('startup completed successfully')
  } catch (error) {
    console.error(`An error has occurred on startup: ${error.message}`)
    process.exit(1)
  }
}

start()
