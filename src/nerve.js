/* Copyright © 2016 Kuali, Inc. - All Rights Reserved
 * You may use and modify this code under the terms of the Kuali, Inc.
 * Pre-Release License Agreement. You may not distribute it.
 *
 * You should have received a copy of the Kuali, Inc. Pre-Release License
 * Agreement with this file. If not, please write to license@kuali.co.
 */

const os = require('os')
const {
  get,
  findKey,
  isFunction,
  isString,
  isPlainObject,
  noop
} = require('lodash')
const nats = require('node-nats-streaming')
const shortid = require('shortid')

const CLIENT_CONNECTION_MAP = {}
const TEST = process.env.NODE_ENV === 'test'
const ERRORS = {
  CLIENT_ID: 'stan: clientID already registered',
  CONNECTION: 'NatsError: Could not connect to server'
}
const LOGGER = {
  info: console.log, // eslint-disable-line
  warn: console.log, // eslint-disable-line
  error: console.log // eslint-disable-line
}

async function getInstance (server, cluster, appName, logger = LOGGER) {
  const clientId = getClientId(appName)
  const inst = CLIENT_CONNECTION_MAP[clientId]

  if (inst) {
    return inst
  }

  const promise = new Promise((resolve, reject) => {
    const nerve = new Nerve(server, cluster, clientId, logger)
    nerve
      .connect()
      .then(() => {
        resolve(nerve)
      })
      .catch(err => {
        logger.error({ err }, 'Failed to connect Nerve')
        reject(err)
        delete CLIENT_CONNECTION_MAP[clientId]
      })
  })
  CLIENT_CONNECTION_MAP[clientId] = promise
  return promise
}

/* Nats Event Receptor, Validator and Emitter */
class Nerve {
  constructor (server, cluster, clientId, logger = LOGGER) {
    this.connect = this.connect.bind(this)
    this.reconnect = this.reconnect.bind(this)
    this.close = this.close.bind(this)
    this._onConnect = this._onConnect.bind(this)
    this._onClose = this._onClose.bind(this)
    this._onError = this._onError.bind(this)
    this._pub = this._pub.bind(this)
    this._enqueue = this._enqueue.bind(this)
    this._dequeue = this._dequeue.bind(this)

    this.id = shortid.generate()
    this.backlog = []
    this.notifyOnConnect = []
    this.notifyOnClose = []
    this.notifyOnError = []
    this.server = server || 'nats://127.0.0.1:4222'
    this.cluster = cluster
    this.clientId = clientId
    this.isConnecting = false
    this.conn = undefined
    this.requestClose = false
    this.publisher = {
      publish: this._enqueue,
      quit: () => ({ status: 'not ready' })
    }
    this.logger = logger
  }

  connect () {
    if (this.isConnecting) {
      return new Promise((resolve, reject) => {
        this.notifyOnConnect.push(() => {
          resolve(this.conn)
        })
        this.notifyOnClose.push(() => {
          resolve(this.conn)
        })
        this.notifyOnError.push(err => {
          reject(err)
        })
      })
    }
    if (this.conn && this.conn.nc && this.conn.nc.connected) {
      return Promise.resolve(this.conn)
    }
    this.isConnecting = true
    return new Promise((resolve, reject) => {
      const conn = nats.connect(this.cluster, this.clientId, {
        url: this.server,
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000
      })
      conn.on('connect', () => {
        this._onConnect(conn)
        resolve(conn)
      })
      conn.on('close', () => {
        resolve(this._onClose(conn))
      })
      conn.on('error', err => {
        this._onError(err, conn)
        reject(err)
      })
    })
  }

  reconnect () {
    this.attemptingReconnect = true
    this.publisher.publish = this._enqueue
    const startTime = Date.now()
    return proceedWhen(
      () => {
        this.logger.info('Nerve attempting to reconnect...', {
          ranAt: Date.now() - startTime,
          connected: get(this.conn, 'nc.connected')
        })
        this.connect().catch(noop)
        return get(this.conn, 'nc.connected')
      },
      640000,
      200
    ).then(() => {
      this.logger.info('Nerve reconnected')
      this.attemptingReconnect = false
    })
  }

  close () {
    return new Promise((resolve, reject) => {
      this.requestClose = true
      this.notifyOnClose.push(() => {
        delete CLIENT_CONNECTION_MAP[this.clientId]
        resolve(this.conn)
      })
      this.notifyOnError.push(err => {
        reject(err)
      })
      if (this.conn) {
        this.conn.close()
      } else {
        resolve()
      }
    })
  }

  subscribe (channel, x, y, z) {
    const args = [x, y, z]
    const callback = args.find(arg => isFunction(arg))
    const group = args.find(arg => isString(arg))
    const _opts = args.find(arg => isPlainObject(arg)) || {}

    const opts = this.conn.subscriptionOptions()
    if (_opts.durableName) opts.setDurableName(_opts.durableName)
    const startOpts = [
      'startWithLastReceived',
      'deliverAllAvailable',
      'startAtSequence',
      'startTime',
      'startAtTimeDelta'
    ]
    const startOpt = findKey(_opts, (value, key) => {
      return startOpts.includes(key)
    })

    if (startOpt) {
      const fnName = startOpt.charAt(0).toUpperCase() + startOpt.slice(1)
      opts[`set${fnName}`](_opts[startOpt])
    } else {
      opts.setDeliverAllAvailable()
    }
    opts.setManualAckMode(_opts.manualAckMode)
    if (_opts.ackWait !== undefined) opts.setAckWait(_opts.ackWait)
    if (_opts.maxInFlight !== undefined) opts.setMaxInFlight(_opts.maxInFlight)
    const subscription = this.conn.subscribe(channel, group, opts)
    subscription.on('message', callback)
    subscription.on('error', err => {
      this.logger.error({ err, channel, x, y, z }, 'Nerve Subscribe Error!')
    })
    return subscription
  }

  isConnected () {
    return !!this.conn.nc.connected
  }

  equals (nerve) {
    return nerve.id === this.id
  }

  _onConnect (conn) {
    this.conn = conn
    this.isConnecting = false
    this._dequeue()
    this.publisher.publish = this._pub
    while (this.notifyOnConnect.length) {
      this.notifyOnConnect.shift()()
    }
  }

  _onClose () {
    while (this.notifyOnClose.length) {
      this.notifyOnClose.shift()()
    }
    this.publisher.publish = this._enqueue
    if (this.requestClose) return { closed: true }
    return this.reconnect()
  }

  _onError (err) {
    this.isConnecting = false
    const errorMessage = err.toString()
    while (this.notifyOnError.length) {
      this.notifyOnError.shift()(err)
    }
    if (errorMessage === ERRORS.CLIENT_ID) {
      this.requestClose = true
      this.logger.error(err)
    } else if (errorMessage.startsWith(ERRORS.CONNECTION)) {
      if (!this.attemptingReconnect) {
        this.reconnect()
      }
    } else {
      this.logger.error(err)
    }
  }

  _pub (channel, message) {
    return new Promise((resolve, reject) => {
      const msg =
        typeof message === 'string' ? message : JSON.stringify(message)
      this.conn.publish(channel, msg, (err, guid) => {
        if (err) {
          if (err.message === 'stan: publish ack timeout') {
            this.logger.warn(
              { channel, msg },
              'This message was not acknowledged before the specified timeout.'
            )
          } else {
            reject(err)
          }
        } else {
          resolve(guid)
        }
      })
    })
  }

  _enqueue (channel, value) {
    this.backlog.push({ channel, value })
  }

  _dequeue () {
    this.backlog.forEach(({ channel, value }) => this._pub(channel, value))
    this.backlog = []
  }
}

function getClientId (appName) {
  const host = os
    .hostname()
    .replace(/\./g, '-')
    .toLowerCase()
  return `${appName}_${host}_${TEST ? process.pid : ''}`
}

function proceedWhen (cb, timeout = 2000, backoff = 10) {
  return new Promise((resolve, reject) => {
    let _interval
    let _timeout = setTimeout(() => {
      clearTimeout(_interval)
      reject(new Error('Timout error waiting for event'))
    }, timeout)
    function exponentialBackoff (_backoff) {
      _interval = setTimeout(() => {
        if (cb()) {
          clearTimeout(_timeout)
          resolve(true)
        } else {
          exponentialBackoff(_backoff * 2)
        }
      }, _backoff)
    }
    exponentialBackoff(backoff)
  })
}

module.exports = { getInstance, Nerve, getClientId, proceedWhen }
