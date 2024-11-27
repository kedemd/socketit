const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const { v4: uuidv4 } = require('uuid');

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
        this.ws.removeAllListeners();
        this.emit('disconnected', code, reason);
    }

    _onError(error) {
        this.ws.removeAllListeners();
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
                        this._send({
                            type: 'response',
                            ack: id,
                            code: 500,
                            data: { message: err.message },
                        });
                    }
                }
            } else if (message.type === 'request') {
                this._send({
                    type: 'response',
                    ack: id,
                    code: 404,
                    data: { message: `Method '${method}' not found` },
                });
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
            externalServer: null,
            perMessageDeflate: true,
            ...options,
        };
        this.routes = { ...this.options.routes };
        this.channels = new Set();
        this.server = null;
        this.wss = null;
    }

    start() {
        return new Promise((resolve, reject) => {
            try {
                this.server = this.options.externalServer || require('http').createServer();
                this.wss = new WebSocket.Server({ server: this.server, perMessageDeflate: this.options.perMessageDeflate });

                this.wss.on('connection', (ws, req) => {
                    const channel = new Channel(ws, { routes: this.routes });
                    this.channels.add(channel);

                    channel.on('disconnected', () => {
                        this.channels.delete(channel);
                    });

                    this.emit('connection', channel, req);
                });

                this.server.on('error', (err) => {
                    this.emit('error', err);
                    reject(err);
                });

                if (!this.options.externalServer) {
                    this.server.listen(this.options.port, () => {
                        this.emit('listening', this.options.port);
                        resolve();
                    });
                } else {
                    resolve();
                }
            } catch (error) {
                reject(error);
            }
        });
    }

    stop() {
        return new Promise((resolve, reject) => {
            if (this.wss) {
                this.wss.close((err) => {
                    if (err) return reject(err);
                    if (this.server && !this.options.externalServer) {
                        this.server.close((serverErr) => {
                            if (serverErr) return reject(serverErr);
                            resolve();
                        });
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
            rejectUnauthorized: true,
            perMessageDeflate: true,
            ...options,
        };
        this.ws = null;
        this.channel = null;
        this.pingIntervalId = null;
        this._manualClose = false; // Track if close was called manually
        this._connect();
    }

    _connect() {
        this.ws = new WebSocket(this.url, {
            rejectUnauthorized: this.options.rejectUnauthorized,
            perMessageDeflate: this.options.perMessageDeflate
        });

        this.ws.on('open', () => {
            this._manualClose = false;
            this.channel = new Channel(this.ws, { routes: this.options.routes });
            this.channel.on('disconnected', () => this._onDisconnected());
            this.emit('connected', this.channel);
            if (this.options.pingInterval) {
                this._startPing();
            }
        });

        this.ws.on('error', (err) => this.emit('error', err));
        this.ws.on('close', () => this._onDisconnected());
    }

    _onDisconnected() {
        if (this.ws) {
            this.ws.removeAllListeners();
        }

        this.emit('disconnected');
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
            this.pingIntervalId = null;
        }

        if (!this._manualClose && this.options.autoReconnect) {
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
                    .catch(() => this.ws.close());
            }
        }, this.options.pingInterval);
    }

    close() {
        this._manualClose = true; // Indicate manual closure
        if (this.pingIntervalId) {
            clearInterval(this.pingIntervalId);
        }
        if (this.ws) {
            this.ws.close();
        }
    }
}

module.exports = { Server, Client, Channel };
