/* global describe, it */

process.env.NODE_ENV = 'test'

// test related packages
var expect = require('chai').expect

var server = require('../server')

describe('Consume Hash Messages', () => {
  it('should do nothing with null message', (done) => {
    server.setHASHES([])
    let msg = null
    server.consumeHashMessage(msg)
    let hashes = server.getHASHES()
    expect(hashes.length).to.equal(0)
    done()
  })

  it('should generate one state object with a one hash message', (done) => {
    server.setHASHES([])
    let msg = {}
    msg.content = Buffer.from(JSON.stringify({
      'hash_id': '6d627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4'
    }))
    server.consumeHashMessage(msg)
    let hashes = server.getHASHES()
    expect(hashes.length).to.equal(1)
    expect(hashes[0]).to.have.property('hash_id')
      .and.to.equal('6d627180-1883-11e7-a8f9-edb8c212ef23')
    expect(hashes[0]).to.have.property('hash')
      .and.to.equal('ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4')
    expect(hashes[0]).to.have.property('msg')
      .and.to.equal(msg)
    done()
  })
})

describe('Aggregate', () => {
  it('should do nothing with null amqpChannel', async () => {
    server.setAMQPChannel(null)
    server.setHASHES([1])
    await server.aggregateAsync()
    let hashes = server.getHASHES()
    expect(hashes.length).to.equal(1)
  })

  it('should do nothing with empty hashes', async () => {
    server.setAMQPChannel({})
    server.setHASHES([])
    await server.aggregateAsync()
    let hashes = server.getHASHES()
    expect(hashes.length).to.equal(0)
  })

  it('should create a valid states object message with one proof', async () => {
    let result = null
    server.setAMQPChannel({
      sendToQueue: function (q, message, opt, callback) {
        result = JSON.parse(message.toString())
      },
      ack: function () { }
    })

    let msg = {}
    msg.content = Buffer.from(JSON.stringify({
      'hash_id': '6d627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4'
    }))
    let hashObj = {
      'hash_id': '6d627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4',
      'msg': msg
    }
    server.setHASHES([hashObj])
    await server.aggregateAsync()
    let hashes = server.getHASHES()
    expect(hashes.length).to.equal(0)
    expect(result).to.not.equal(null)
    expect(result).has.property('agg_id').and.is.a('string')
    expect(result).has.property('agg_root').and.is.a('string')
    expect(result).has.property('proofData').and.is.a('array')
    expect(result.proofData.length).to.equal(1)
    expect(result.proofData[0]).has.property('hash_id').and.is.a('string').and.to.equal('6d627180-1883-11e7-a8f9-edb8c212ef23')
    expect(result.proofData[0]).has.property('hash').and.is.a('string').and.to.equal('ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4')
    expect(result.proofData[0]).has.property('proof').and.is.a('array')
    expect(result.proofData[0].proof.length).to.equal(2)
  })

  it('should create a valid states object message with two proofs', async () => {
    let result = null
    server.setAMQPChannel({
      sendToQueue: function (q, message, opt, callback) {
        result = JSON.parse(message.toString())
      },
      ack: function () { }
    })

    let msg1 = {}
    let msg2 = {}
    msg1.content = Buffer.from(JSON.stringify({
      'hash_id': '6d627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4'
    }))
    msg2.content = Buffer.from(JSON.stringify({
      'hash_id': 'a0627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'aa10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4'
    }))
    let hashObj1 = {
      'hash_id': '6d627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4',
      'msg': msg1
    }
    let hashObj2 = {
      'hash_id': 'a0627180-1883-11e7-a8f9-edb8c212ef23',
      'hash': 'aa10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4',
      'msg': msg2
    }

    server.setHASHES([hashObj1, hashObj2])
    await server.aggregateAsync()
    let hashes = server.getHASHES()
    expect(hashes.length).to.equal(0)
    expect(result).to.not.equal(null)
    expect(result).has.property('agg_id').and.is.a('string')
    expect(result).has.property('agg_root').and.is.a('string')
    expect(result).has.property('proofData').and.is.a('array')
    expect(result.proofData.length).to.equal(2)
    expect(result.proofData[0]).has.property('hash_id').and.is.a('string').and.to.equal('6d627180-1883-11e7-a8f9-edb8c212ef23')
    expect(result.proofData[0]).has.property('hash').and.is.a('string').and.to.equal('ed10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4')
    expect(result.proofData[0]).has.property('proof').and.is.a('array')
    expect(result.proofData[0].proof.length).to.equal(4)
    expect(result.proofData[1]).has.property('hash_id').and.is.a('string').and.to.equal('a0627180-1883-11e7-a8f9-edb8c212ef23')
    expect(result.proofData[1]).has.property('hash').and.is.a('string').and.to.equal('aa10960ccc613e4ad0533a813e2027924afd051f5065bb5379a80337c69afcb4')
    expect(result.proofData[1]).has.property('proof').and.is.a('array')
    expect(result.proofData[1].proof.length).to.equal(4)
  })
})
