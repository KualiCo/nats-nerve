/* Copyright © 2016 Kuali, Inc. - All Rights Reserved
 * You may use and modify this code under the terms of the Kuali, Inc.
 * Pre-Release License Agreement. You may not distribute it.
 *
 * You should have received a copy of the Kuali, Inc. Pre-Release License
 * Agreement with this file. If not, please write to license@kuali.co.
 */
const assert = require('assert')
const shortid = require('shortid')
const Promise = require('bluebird')
const { Nerve, getInstance, getClientId, proceedWhen } = require('./nerve')

describe('Nerve', () => {
  const appName = 'nats-nerve'
  const server = 'nats://127.0.0.1:4222'
  const cluster = 'test-cluster'

  function getAppName () {
    return `${shortid.generate()}_${appName}`
  }

  let logger
  beforeEach(() => {
    logger = {
      trace: console.log, // eslint-disable-line
      debug: console.log, // eslint-disable-line
      info: console.log, // eslint-disable-line
      warn: console.log, // eslint-disable-line
      error: console.log, // eslint-disable-line
      fatal: console.log // eslint-disable-line
    }
  })

  it('can construct', async () => {
    const appName = getAppName()
    const nerve = await getInstance(server, cluster, appName, logger)
    assert.equal(nerve.cluster, cluster)
    assert.equal(nerve.clientId, getClientId(appName))
    assert.equal(nerve.isConnecting, false)
    assert.equal(nerve.isConnected(), true)
    await nerve.close()
  })

  it('if the connection is unexpectedly closed it reconnects', async () => {
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    nerve.conn.close()
    let isReconnected = false
    nerve.notifyOnConnect.push(() => {
      isReconnected = true
    })
    await proceedWhen(() => isReconnected)
    await nerve.close()
  })

  it('defaults the server if it is undefined', async () => {
    const nerve = await getInstance(undefined, cluster, getAppName(), logger)
    assert.equal(nerve.isConnected(), true)
    await nerve.close()
  })

  it('errors if the server is not up', async () => {
    logger.error = () => {
      /* do nothing */
    }
    try {
      await getInstance('nats://127.0.0.1:4333', cluster, getAppName(), logger)
      assert.fail()
    } catch (err) {
      assert.ok(err)
    }
  })

  it('does not try to connect if it is already connecting', async () => {
    const clientId = getClientId(getAppName())
    const nerve = new Nerve(server, cluster, clientId)
    const promise1 = nerve.connect()
    const promise2 = nerve.connect()
    expect(promise1).toEqual(promise2)
    const [p1, p2] = await Promise.all([promise1, promise2])
    expect(p1).toEqual(p2)
    await nerve.close()
  })

  it('returns the connection if it already has been created', async () => {
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    const conn1 = await nerve.connect()
    const conn2 = await nerve.connect()
    assert.equal(conn1, conn2)
    await nerve.close()
  })

  it('reuses an instance when connecting with the same client id', async () => {
    const appName = getAppName()
    const nerve1 = await getInstance(server, cluster, appName, logger)
    const nerve2 = await getInstance(server, cluster, appName, logger)
    assert.ok(nerve1.equals(nerve2))
    await nerve1.close()
  })

  it('can publish and subscribe', async () => {
    const channel = new Date().toISOString()
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    await nerve.connect()
    let received = false
    const subscription = nerve.subscribe(channel, msg => {
      received = msg.getData() === 'hi'
    })
    await nerve.publisher.publish(channel, 'hi')
    await proceedWhen(() => received)
    await unsubscribe(subscription)
    await nerve.close()
  })

  it('can publish and subscribe objects', async () => {
    const channel = new Date().toISOString()
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    await nerve.connect()
    let received = false
    const subscription = nerve.subscribe(channel, msg => {
      const data = JSON.parse(msg.getData())
      received = data.id === 1 && data.payload === 'hi'
    })
    try {
      await nerve.publisher.publish(channel, { id: 1, payload: 'hi' })
    } catch (err) {
      console.log('published message was never acknowledged :3:')
    }
    await proceedWhen(() => received)
    await unsubscribe(subscription)
    await nerve.close()
  })

  it('can reset a durable subscription by unsubscribing', async () => {
    const channel = shortid.generate()
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    await nerve.connect()
    const received = [0, 0, 0, 0, 0]
    const opts = { durableName: shortid.generate() }
    await nerve.publisher.publish(channel, { id: 0, payload: 'hi, 0!' })
    const subscription1 = nerve.subscribe(channel, opts, msg => {
      const data = JSON.parse(msg.getData())
      received[data.id]++
    })
    await nerve.publisher.publish(channel, { id: 1, payload: 'hi, 1!' })
    await nerve.publisher.publish(channel, { id: 2, payload: 'hi, 2!' })
    await proceedWhen(() => !!received[2])

    /**
     * This is the magic here. If the subscription is unsubscribed, then
     * subscribing to the same channel as the same client with the same
     * durableName does not continue the subscription, it starts it over.
     */
    await unsubscribe(subscription1)

    await nerve.publisher.publish(channel, { id: 3, payload: 'hi, 3!' })
    const subscription2 = nerve.subscribe(channel, opts, msg => {
      const data = JSON.parse(msg.getData())
      received[data.id]++
    })
    await nerve.publisher.publish(channel, { id: 4, payload: 'hi, 4!' })
    await proceedWhen(() => !!received[4])
    await unsubscribe(subscription2)
    await nerve.close()
    expect(received).toEqual([2, 2, 2, 1, 1])
  })

  it('can continue a durable subscription after closing', async () => {
    const channel = shortid.generate()
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    await nerve.connect()
    const received = [0, 0, 0, 0, 0]
    const opts = { durableName: shortid.generate() }
    await nerve.publisher.publish(channel, { id: 0, payload: 'hi, 0!' })
    const subscription1 = nerve.subscribe(channel, opts, msg => {
      const data = JSON.parse(msg.getData())
      received[data.id]++
    })
    await nerve.publisher.publish(channel, { id: 1, payload: 'hi, 1!' })
    await nerve.publisher.publish(channel, { id: 2, payload: 'hi, 2!' })
    await proceedWhen(() => !!received[2])

    /**
     * This is the magic here. If the subscription is closed but not
     * unsubscribed, then subscribing to the same channel as the same client
     * with the same durableName does continue the subscription. It just takes
     * over where it left off.
     */
    await subscription1.close()

    await nerve.publisher.publish(channel, { id: 3, payload: 'hi, 3!' })
    const subscription2 = nerve.subscribe(channel, opts, msg => {
      const data = JSON.parse(msg.getData())
      received[data.id]++
    })
    await nerve.publisher.publish(channel, { id: 4, payload: 'hi, 4!' })
    await proceedWhen(() => !!received[4])
    await unsubscribe(subscription2)
    await nerve.close()
    expect(received).toEqual([1, 1, 1, 1, 1])
  })

  it('can handle disconnects', async () => {
    const channel = new Date().toISOString()
    const durableName = `random-${+new Date()}`
    const nerve = await getInstance(server, cluster, getAppName(), logger)

    nerve.publisher.publish(channel, '0')
    await nerve.connect()
    nerve.publisher.publish(channel, '1')
    await nerve.close()
    nerve.publisher.publish(channel, '2')
    await nerve.connect()
    nerve.publisher.publish(channel, '3')

    const received = [false, false, false, false]
    const subscription = nerve.subscribe(channel, { durableName }, msg => {
      const value = +msg.getData()
      received[value] = !received[value]
    })

    await proceedWhen(
      () => received[0] && received[1] && received[2] && received[3]
    )
    await unsubscribe(subscription)
    await nerve.close()
  })

  it('attempts reconnect if unable to connect', async () => {
    let done = false
    logger.info = jest
      .fn()
      .mockImplementationOnce(() => 'one')
      .mockImplementationOnce(() => {
        done = true
        return 'two'
      })
    class NatsError extends Error {
      constructor (message) {
        super(message)
        this.name = 'NatsError'
      }
    }

    try {
      const nerve = await getInstance(server, cluster, getAppName(), logger)
      nerve.conn.emit('error', new NatsError('Could not connect to server'))
    } catch (err) {
      /* no nothing */
    }
    await proceedWhen(() => done)
    expect(logger.info.mock.calls[0][0]).toBe(
      'Nerve attempting to reconnect...'
    )
    expect(logger.info.mock.calls[1][0]).toBe('Nerve reconnected')
  })

  it('proceedWhen times out', async () => {
    const nerve = await getInstance(server, cluster, getAppName(), logger)
    let timeoutError = false
    try {
      await proceedWhen(() => false, 5, 1)
    } catch (err) {
      timeoutError = true
    }
    await proceedWhen(() => timeoutError)
    await nerve.connect()
    await nerve.close()
  })
})

function unsubscribe (subscription) {
  return new Promise((resolve, reject) => {
    subscription.unsubscribe()
    subscription.on('unsubscribed', () => {
      resolve()
    })
  })
}
