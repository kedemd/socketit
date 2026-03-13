# Socketit

Simple WebSocket messaging for Node.js.

![Socketit Logo](http://github.com/kedemd/socketit/raw/main/socketit.svg)

Socketit keeps two ideas intentionally small and explicit:

- **`request()`** is request/reply.
- **`publish()`** is fire-and-forget.

The library provides a tiny API on top of [`ws`](https://www.npmjs.com/package/ws), with:

- async route handlers
- optional middleware
- request timeouts
- abortable requests
- automatic client reconnects
- ping-based health checks
- graceful shutdown behavior
- pluggable serialization/deserialization
- protocol validation and better error propagation

## Installation

```bash
npm install socketit
```

## Usage

## Quick start

### Server

```javascript
const { Server } = require('socketit');

const server = new Server({
  port: 8080,
  routes: {
    echo: async (data) => data,
    reverse: async (data) => String(data).split('').reverse().join(''),
    notify: async (data, channel) => {
      console.log('publish received:', data);
      channel.publish('server-log', { received: true });
    }
  }
});

server.on('connection', (channel) => {
  console.log('client connected');

  channel.on('disconnected', () => {
    console.log('client disconnected');
  });
});

server.start().then(() => console.log('server listening on :8080'));
```

### Client

```javascript
const { Client } = require('socketit');

const client = new Client('ws://127.0.0.1:8080', {
  routes: {
    'server-log': async (data) => {
      console.log('publish from server:', data);
    }
  }
});

client.on('connected', async (channel) => {
  console.log('connected');

  try {
    const echoed = await channel.request('echo', { message: 'hello' });
    console.log('echo:', echoed);

    const reversed = await channel.request('reverse', 'socketit');
    console.log('reverse:', reversed);

    channel.publish('notify', { source: 'client' });
  } catch (error) {
    console.error('request failed:', error.message);
  }
});

client.on('disconnected', () => console.log('disconnected'));
```

## API

### Server

#### Constructor

```javascript
new Server(options)
```

**Options**:
- `port` (number): The port for the WebSocket server. Default is `8080`.
- `host` (string): Host/interface to bind to.
- `externalServer` (http/https server instance): Provide your own server. If you need TLS, create an `https` server yourself and pass it here.
- `routes` (object): Route handlers for incoming `request()` and `publish()` messages. For example:
  ```javascript
  {
    echo: async (data, channel) => data
  }
  ```
- `middleware` (array): Optional async middleware chain. Each middleware receives `(ctx, next, channel)`.
- `serializer` (function): Encodes outgoing messages. Default is `JSON.stringify`.
- `deserializer` (function): Decodes incoming messages. Default is `JSON.parse`.
- `requestTimeout` (number): Default timeout for outgoing requests.
- `maxPayload` (number): Maximum allowed incoming WebSocket payload size in bytes. Default is `1048576`.
- `perMessageDeflate` (boolean): Enable WebSocket compression. Default is `false`.
- `wsOptions` (object): Extra options passed to `ws`.

#### Methods

- **`.start()`**: Starts the WebSocket server. Returns a `Promise` that resolves when the server is ready.
- **`.stop()`**: Stops the server. Returns a `Promise` that resolves when the server has stopped.

#### Events

- `connection(channel, request)`
- `listening(port, host)`
- `error(error)`
- `clientError(error, channel, request)`
- `clientProtocolError(error, channel, request)`

---

### Client

#### Constructor

```javascript
new Client(url, options)
```

**Parameters**:
- `url` (string): The WebSocket server URL.
- `options` (object): Configuration options.
  - `autoReconnect` (boolean): Automatically reconnect on disconnection. Default is `true`.
  - `reconnectInterval` (number): Delay between reconnect attempts. Default is `5000` ms.
  - `pingInterval` (number): Interval for built-in `ping` health checks. Set to `0` to disable. Default is `10000` ms.
  - `requestTimeout` (number): Default timeout for outgoing requests.
  - `maxPayload` (number): Maximum allowed incoming WebSocket payload size in bytes. Default is `1048576`.
  - `rejectUnauthorized` (boolean): Allow self-signed certificates. Default is `true`.
  - `perMessageDeflate` (boolean): Enable WebSocket compression. Default is `false`.
  - `routes` (object): Route handlers the server can call on this client.
  - `middleware` (array): Optional async middleware chain for inbound messages.
  - `serializer` (function): Encodes outgoing messages. Default is `JSON.stringify`.
  - `deserializer` (function): Decodes incoming messages. Default is `JSON.parse`.
  - `wsOptions` (object): Extra options passed to `ws`.

#### Methods

- **`.close()`**: Closes the WebSocket connection.
- **`.terminate()`**: Immediately terminates the WebSocket connection.

#### Events

- `connected(channel)`
- `disconnected(code, reason)`
- `error(error)`
- `protocolError(error)`

---

### Channel

#### Methods

- **`.request(method, data, options)`**
  - Sends a request and waits for a reply.
  - **Parameters**:
    - `method` (string): Route name.
    - `data` (any): Data to send with the request.
    - `options` (object): Additional options for the request.
      - `timeout` (number): Timeout in milliseconds. Default is `5000`.
      - `signal` (`AbortSignal`): Cancels the request when aborted.
  - Resolves with the route result.
  - Rejects on timeout, missing route, route error, or disconnect.

- **`.publish(method, data)`**
  - Sends a message without waiting for a reply.
  - **Parameters**:
    - `method` (string): Route name.
    - `data` (any): Data to send.
  - Returns `true` if the message was sent and `false` otherwise.

- **`.close()`**
  - Closes the underlying WebSocket connection.

- **`.terminate()`**
  - Immediately terminates the underlying connection.

- **`.setRoute(method, handler)`**
  - Adds or replaces a route handler at runtime.

- **`.removeRoute(method)`**
  - Removes a route handler.

- **`.use(middleware)`**
  - Adds middleware to the channel.

#### Events

- `connected`
- `disconnected(code, reason)`
- `error(error)`
- `protocolError(error)`

## Notes

- Socketit does not create TLS certificates for you. For `wss://`, pass an existing `https` server via `externalServer`.
- The built-in `ping` route returns `'pong'` and is used by the client heartbeat.
- Route handlers receive `(data, channel, ctx)`.
- Middleware receives `(ctx, next, channel)` where `ctx` contains at least `type`, `method`, and `data`.
- `publish()` intentionally does not create a reply path.
- Custom serializers must return a `string`, `Buffer`, `ArrayBuffer`, or typed-array view.

## Development

```bash
npm test
node example.js
```

## License

This project is licensed under the [MIT License](./LICENSE).

Made with ❤️ by [Kedem](https://github.com/kedemd)
