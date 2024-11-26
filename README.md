
# Socketit

**Socketit**: A simple and powerful toolkit for WebSocket communication.

![Socketit Logo](http://github.com/kedemd/socketit/raw/main/socketit.svg)

## Features

- Supports **request-response** and **publish-subscribe** patterns.
- Built-in **timeout handling** for requests.
- Customizable **routes** for handling WebSocket messages.
- Automatic **reconnection** for clients.
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
    port: 8080,
    routes: {
        echo: (data) => data, // Echoes back the received data
    },
});

server.on('connection', (channel) => {
    console.log('New client connected');

    channel.on('disconnected', () => {
        console.log('Client disconnected');
    });
});

server.start().then(() => {
    console.log('Server is running on port 8080');
});
```

### Client Example

```javascript
const { Client } = require('socketit');

const client = new Client('ws://localhost:8080', {
    routes: {
        greeting: (data) => {
            console.log('Server says:', data);
        },
    },
});

client.on('connected', (channel) => {
    console.log('Connected to server');
    
    channel.request('echo', { message: 'Hello, server!' })
        .then((response) => {
            console.log('Server responded:', response);
        })
        .catch((err) => {
            console.error('Request failed:', err.message);
        });
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
- `routes` (object): An object defining methods to handle incoming messages. For example:
  ```javascript
  {
      echo: (data) => data
  }
  ```

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
  - `routes` (object): An object defining methods to handle incoming messages.

#### Methods

- **`.close()`**: Closes the WebSocket connection.

---

### Channel

#### Methods

- **`.request(method, data, options)`**
  - Sends a request to the server and waits for a response.
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
