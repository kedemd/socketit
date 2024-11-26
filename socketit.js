const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const { EventEmitter } = require('events');

class Channel extends EventEmitter {
    constructor(ws, options = {}) {
        super();
        this.ws = ws;
        this.options = {
            routes: {},
            ...options,
        };
        this.routes = {
            ping: async () => 'pong',
            ...this.options.routes,
        };
        this.pendingRequests = new Map();
        this._setupWebSocket();
    }

    _setupWebSocket() {
        this.ws.on('message', (data) => this._onMessage(data));
        this.ws.on('close', (code, reason) => this._onClose(code, reason));
        this.ws.on('error', (error) => this._onError(error));
        this.ws.on('open', () => this._onOpen());

        if (this.isOnline) {
            this._onOpen();
        }
    }

    get isOnline() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    _onOpen() {
        this.emit('connected');
    }

    _onClose(code, reason) {
        this.ws.removeAllListeners(); // Clean up all listeners on error
        this.emit('disconnected', code, reason);
    }

    _onError(error) {
        this.ws.removeAllListeners(); // Clean up all listeners on error
        this.emit('error', error);
    }

    async _onMessage(data) {
        let message;
        try {
            message = JSON.parse(data);
        } catch (err) {
            console.error('Failed to parse message:', data);
            return;
        }

        if (message.type === 'response') {
            const { ack, code, data } = message;
            const pending = this.pendingRequests.get(ack);
            if (pending) {
                this.pendingRequests.delete(ack);
                if (code === 200) {
                    pending.resolve(data);
                } else {
                    pending.reject(new Error(data.message || 'Error'));
                }
            }
        } else if (message.type === 'request' || message.type === 'publish') {
            const { id, method, data } = message;
            const routeHandler = this.routes[method];
            if (routeHandler) {
                try {
                    const result = await routeHandler(data, this);
                    if (message.type === 'request') {
                        this._send({
                            type: 'response',
                            ack: id,
                            code: 200,
                            data: result,
                        });
                    }
                } catch (err) {
                    if (message.type === 'request') {
                        try {
                            this._send({
                                type: 'response',
                                ack: id,
                                code: 500,
                                data: {message: err.message},
                            });
                        } catch(err){
                            console.error('Failed to send error response: 500', err);
                        }
                    }
                }
            } else {
                if (message.type === 'request') {
                    this._send({
                        type: 'response',
                        ack: id,
                        code: 404,
                        data: { message: `Method '${method}' not found` },
                    });
                }
            }
        }
    }

    _send(message) {
        if (this.isOnline) {
            this.ws.send(JSON.stringify(message));
        } else {
            throw new Error('WebSocket is not open');
        }
    }

    request(method, data, options = {}) {
        const id = uuidv4();
        const message = {
            type: 'request',
            id,
            method,
            data,
        };

        const timeout = options.timeout || 5000;
        let timer;

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            try {
                this._send(message);
            } catch (error) {
                this.pendingRequests.delete(id);
                return reject(error);
            }

            timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timed out after ${timeout}ms`));
            }, timeout);
        }).finally(() => {
            clearTimeout(timer);
        });
    }

    publish(method, data) {
        const message = {
            type: 'publish',
            method,
            data,
        };
        try {
            this._send(message);
        } catch (error) {
            console.error('Failed to publish message:', error);
        }
    }

    close() {
        if (this.ws) {
            this.ws.close();
        }
    }
}

class Server extends EventEmitter {
    constructor(options = {}) {
        super();
        this.options = {
            port: 8080,
            ...options,
        };
        this.routes = {
            ...this.options.routes,
        };
        this.channels = new Set();
        this.wss = null;
    }

    start() {
        return new Promise((resolve, reject) => {
            this.wss = new WebSocket.Server({ port: this.options.port });

            this.wss.on('connection', (ws, req) => {
                const channel = new Channel(ws, { routes: this.routes });
                this.channels.add(channel);

                channel.on('disconnected', () => {
                    this.channels.delete(channel);
                });

                this.emit('connection', channel, req);
            });

            this.wss.on('listening', () => {
                this.emit('listening', this.options.port);
                resolve();
            });

            this.wss.on('error', (err) => {
                this.emit('error', err);
                reject(err);
            });
        });
    }

    stop() {
        return new Promise((resolve, reject) => {
            if (this.wss) {
                this.wss.close((err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            } else {
                resolve();
            }
        });
    }
}

class Client extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.url = url;
        this.options = {
            autoReconnect: true,
            reconnectInterval: 5000,
            pingInterval: 10000,
            routes: {},
            ...options,
        };
        this.ws = null;
        this.channel = null;
        this.pingIntervalId = null;
        this._connect();
    }

    _connect() {
        this.ws = new WebSocket(this.url, {
            rejectUnauthorized: this.options.rejectUnauthorized || false,
        });

        this.ws.on('open', () => {
            this.channel = new Channel(this.ws, { routes: this.options.routes });
            this.channel.on('disconnected', () => this._onDisconnected());
            this.emit('connected', this.channel);
            if (this.options.pingInterval) {
                this._startPing();
            }
        });

        this.ws.on('error', (err) => {
            this.emit('error', err);
        });

        this.ws.on('close', () => {
            this._onDisconnected();
        });
    }

    _onDisconnected() {
        if (this.ws) {
            this.ws.removeAllListeners(); // Clean up listeners
        }

        this.emit('disconnected');
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
            this.pingIntervalId = null;
        }
        if (this.options.autoReconnect) {
            setTimeout(() => this._connect(), this.options.reconnectInterval);
        }
    }

    _startPing() {
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
        }
        this.pingIntervalId = setInterval(() => {
            if (this.channel && this.channel.isOnline) {
                this.channel
                    .request('ping', null, { timeout: this.options.pingInterval / 2 })
                    .catch((err) => {
                        console.error('Ping failed:', err.message);
                        this.ws.close();
                    });
            }
        }, this.options.pingInterval);
    }

    close() {
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
        }
        if (this.ws) {
            this.ws.close();
        }
    }
}

module.exports = {
    Server,
    Client,
    Channel
};
