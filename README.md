# nats-nerve
High level driver for nats-streaming-server. 

Nerve makes sending and receiving messages easy. The example below demonstrates:
  * Creating a persistent connection to the Nats Streaming Server
  * Creating a subscription to a channel
  * Publishing a message to a channel
```js
const { getInstance } = require('nats-nerve')
const SERVER = 'nats://127.0.0.1:4222'
const CLUSTER = 'test-cluster'
const APP_NAME = 'test'

async function test () {
  const nerve = await getInstance(SERVER, CLUSTER, APP_NAME)
  const subscription = nerve.subscribe('channel', message => {
    console.log(message.getData())
  })
  await nerve.publisher.publish('channel', 'Hello, World!')
}

test()
```

## Durable Subscriptions
Nats Streaming Server will keep track of the messages that have been delivered
to your client if you configure a durable subscription:
```js
...
const opts = { durableName: 'keepers' }
const subscription = nerve.subscribe(channel, opts, message => {
  console.log(message.getData())
})
...
```

The subscription can be suspended:
```js
await subscription.close()
```

Re-subscribing to a suspended (or closed) subscription picks up any undelivered
messages. It is done simply by re-creating the durable subscription:
```js
...
const opts = { durableName: 'keepers' }
const subscription = nerve.subscribe(channel, opts, message => {
  console.log(message.getData())
})
...
```

Durable subscriptions can be reset or discarded by unsubscribing:
```js
...
await new Promise(resolve => {
  subscription.unsubscribe()
  subscription.on('unsubscribed', resolve)
})
...
```

Durable subscriptions have more delivery options. These should be specified on
the options object passed to the subscribe function. They are:

| Option  | Example Value | Description |
| ------- | ------------- | ----------- |
| `startWithLastReceived` | `true` | Subscribe starting with the most recently published value |
| `deliverAllAvailable` | `true` | Receive all stored values in order |
| `startAtSequence` | `22` | Receive all messages starting at a specific sequence number |
| `startTime` | `new Date(2016, 7, 8)` | Subscribe starting at a specific time |
| `startAtTimeDelta` | `30000` | Subscribe starting at a specific amount of time in the past (e.g. 30 seconds ago) |

## Groups (Clustered Clients)
Nats Streaming Server can send a message to a single client amongst a group.
This can be done by configuring the subscription with a group like this:
```js
...
const subscription = nerve.subscribe(channel, 'myGroupName', message => {
  console.log(message.getData())
})
...
```

## About Nerve
I called it nerve because it passes messages like your nervous system. I thought
this was really clever the first time that I thought of it: _N_ats _E_vent
_R_eceptor, _V_alidator and _E_mitter.
