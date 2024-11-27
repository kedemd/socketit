
# Socketit

**Socketit**: A simple and powerful toolkit for WebSocket communication.

![Socketit Logo](http://github.com/kedemd/socketit/raw/main/socketit.svg)

## Features

- Supports **request-response** and **publish-subscribe** patterns with `async` handlers.
- Built-in **timeout handling** for requests.
- Customizable **routes** for handling WebSocket messages.
- Automatic **reconnection** for clients.
- Built-in **TLS support** with options for self-signed certificates.
- **Compression** with `permessage-deflate`.
- Ping mechanism to ensure connection health.
- Works with Node.js.

## Installation

```bash
npm install socketit
```

## Usage

### Server Example

```javascript
const { Server } = require('socketit');

const server = new Server({
    port: 8888,
    routes: {
        echo: async (data) => data, // Async handler to echo back data
        reverse: async (data) => data.split('').reverse().join(''), // Reverse a string
    },
});

server.on('connection', (channel) => {
    console.log('New client connected');

    channel.on('disconnected', () => {
        console.log('Client disconnected');
    });
});

server.start().then(() => {
    console.log('Server is running on port 8443 with TLS');
});
```

### Client Example

```javascript
const { Client } = require('socketit');

const client = new Client('wss://localhost:8443', {
    rejectUnauthorized: false, // Allow self-signed certificates
    routes: {
        greeting: async (data) => {
            console.log('Server says:', data);
        },
    },
});

client.on('connected', async (channel) => {
    console.log('Connected to server');

    try {
        const response = await channel.request('echo', { message: 'Hello, server!' });
        console.log('Server responded:', response);

        const reversed = await channel.request('reverse', 'Hello');
        console.log('Reversed string:', reversed);
    } catch (err) {
        console.error('Request failed:', err.message);
    }
});

client.on('disconnected', () => {
    console.log('Disconnected from server');
});
```

## API

### Server

#### Constructor

```javascript
new Server(options)
```

**Options**:
- `port` (number): The port for the WebSocket server. Default is `8080`.
- `externalServer` (http/https server instance): The server to use. If you need TLS, pass an https server
- `routes` (object): An object defining methods to handle incoming messages. For example:
  ```javascript
  {
      echo: async (data) => data
  }
  ```
- `perMessageDeflate` (boolean): Enable WebSocket compression. Default is `false`.

#### Methods

- **`.start()`**: Starts the WebSocket server. Returns a `Promise` that resolves when the server is ready.
- **`.stop()`**: Stops the server. Returns a `Promise` that resolves when the server has stopped.

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
  - `rejectUnauthorized` (boolean): Allow self-signed certificates. Default is `true`.
  - `perMessageDeflate` (boolean): Enable WebSocket compression. Default is `false`.
  - `routes` (object): An object defining methods to handle incoming messages.

#### Methods

- **`.close()`**: Closes the WebSocket connection.

---

### Channel

#### Methods

- **`.request(method, data, options)`**
  - Sends a request to the server and waits for a response.
  - **Supports async handlers**.
  - **Parameters**:
    - `method` (string): The name of the method to call.
    - `data` (any): Data to send with the request.
    - `options` (object): Additional options for the request.
      - `timeout` (number): Timeout for the request in milliseconds.

- **`.publish(method, data)`**
  - Sends a message to the server without expecting a response.
  - **Parameters**:
    - `method` (string): The name of the method to call.
    - `data` (any): Data to send.

- **`.on(event, listener)`**
  - Listens for events (`connected`, `disconnected`, etc.).
  - **Parameters**:
    - `event` (string): The event name.
    - `listener` (function): The callback function.

## License

This project is licensed under the [MIT License]().

---

Made with ❤️ by [Kedem](https://github.com/kedemd)
