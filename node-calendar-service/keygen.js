#!/usr/bin/env node

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

// A deterministic signing keypair generator for Ed25519 keys.
//
// Usage: Generate (offline) a VERY secure passphrase.
//
// It is recommended to use a 12 word Diceware passphrase
// for ~155 bits of entropy.
//
// See : https://www.rempe.us/diceware/#eff
//
// This sessionKeys script will use Scrypt to derive enough key material for
// eight signing keypairs. Each pair will be printed as Base64 encoded
// key bytes. Keys encoded this way are directly usable on
// the https://tweetnacl.js.org/#/sign website for testing.
//
// Given the same username ('ops@tierion.com') and passphrase
// this script can be run again to re-generate all of the keypairs
// deterministically.
//
// IMPORTANT : Store the passphrase safely!!! It is recommended to
// split this key and share it amongst several key trusted individuals.
// If this passphrase is ever compromised, all of the generated keys are
// compromised as well and must be taken out of service. If a particular
// keypair is compromised, but the master passphrase is safe, you can just
// rotate to the next keypair in line and discontinue use of the previous.

const crypto = require('crypto')
const nacl = require('tweetnacl')
nacl.util = require('tweetnacl-util')

// See : https://github.com/grempe/session-keys-js
var sessionKeys = require('session-keys')

// Omit the first two arguments (node and path)
var args = process.argv.slice(2)

if (args.length < 1) {
  console.error('Usage : ./keygen.sh "My secure passphrase in quotes"')
  process.exit(1)
}

let username = 'ops@tierion.com'
// the passphrase arg can be quoted or just a list of words
let passphrase = args.join(' ').trim()
let date = new Date()

// Calculate the hash of the signing public key bytes
// to allow lookup of the pubKey using all or part
// of the hash.
let calcSigningPubKeyHash = (pubKey) => {
  return crypto.createHash('sha256').update(pubKey).digest('hex')
}

sessionKeys.generate(username, passphrase, function (err, keys) {
  if (err) {
    console.error('sessionKeys error : ', err)
  }

  console.log()
  console.log('SIGNING KEY GENERATION')
  console.log('**************')
  console.log('generated at : ', date.toISOString())
  console.log('username : ', username)
  console.log('passphrase : ', passphrase)

  console.log()
  console.log('Signing Keys')
  console.log('--------------')
  console.log()

  var i
  for (i = 0; i < 8; i++) {
    console.log('secret key      (b64)', i, ' : ', keys.naclSigningKeyPairsBase64[i].secretKey)
    console.log('public key      (b64)', i, ' : ', keys.naclSigningKeyPairsBase64[i].publicKey)
    // calculate the hash of the public key bytes for key lookup fingerprint
    console.log('public key hash (hex)', i, ' : ', calcSigningPubKeyHash(keys.naclSigningKeyPairs[i].publicKey))
    console.log('')
  }
})
