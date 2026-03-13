const http = require('http');
const WebSocket = require('ws');
const { EventEmitter, once } = require('events');
const { v4: uuidv4 } = require('uuid');

const DEFAULT_REQUEST_TIMEOUT = 5000;

const MESSAGE_TYPES = {
    REQUEST: 'request',
    RESPONSE: 'response',
    PUBLISH: 'publish',
};

function normalizeCloseReason(reason) {
    if (!reason) return '';
    if (typeof reason === 'string') return reason;
    if (Buffer.isBuffer(reason)) return reason.toString();
    return String(reason);
}

function createErrorMessage(data, fallback = 'Request failed') {
    if (data && typeof data === 'object' && typeof data.message === 'string' && data.message) {
        return data.message;
    }

    if (typeof data === 'string' && data) {
        return data;
    }

    return fallback;
}

function createRpcError(message, code, data) {
    const err = new Error(message);
    if (code !== undefined) err.code = code;
    if (data !== undefined) err.data = data;
    return err;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getBoundServerPort(server, fallbackPort) {
    if (!server || typeof server.address !== 'function') {
        return fallbackPort;
    }

    const address = server.address();
    if (address && typeof address === 'object' && typeof address.port === 'number') {
        return address.port;
    }

    return fallbackPort;
}

function isValidSerializedPayload(payload) {
    return typeof payload === 'string'
        || Buffer.isBuffer(payload)
        || payload instanceof ArrayBuffer
        || ArrayBuffer.isView(payload);
}

class Channel extends EventEmitter {
    constructor(ws, options = {}) {
        super();

        this.ws = ws;
        this.options = {
            routes: {},
            middleware: [],
            requestTimeout: DEFAULT_REQUEST_TIMEOUT,
            maxPayload: 1024 * 1024,
            serializer: JSON.stringify,
            deserializer: JSON.parse,
            ...options,
        };

        this.routes = {
            ping: async () => 'pong',
            ...this.options.routes,
        };

        this.middleware = Array.isArray(this.options.middleware)
            ? [...this.options.middleware]
            : [];

        this.pendingRequests = new Map();

        this._closed = false;
        this._openEmitted = false;
        this._destroyed = false;

        this._boundOnOpen = () => this._onOpen();
        this._boundOnMessage = (data, isBinary) => this._onMessage(data, isBinary);
        this._boundOnClose = (code, reason) => this._onClose(code, reason);
        this._boundOnError = (error) => this._onError(error);

        this._attachSocketListeners();

        if (this.isOnline) {
            this._onOpen();
        }
    }

    get isOnline() {
        return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    get isClosed() {
        return this._closed;
    }

    setRoute(method, handler) {
        if (typeof method !== 'string' || !method) {
            throw new TypeError('method must be a non-empty string');
        }
        if (typeof handler !== 'function') {
            throw new TypeError('handler must be a function');
        }

        this.routes[method] = handler;
        return this;
    }

    removeRoute(method) {
        delete this.routes[method];
        return this;
    }

    use(fn) {
        if (typeof fn !== 'function') {
            throw new TypeError('middleware must be a function');
        }
        this.middleware.push(fn);
        return this;
    }

    _attachSocketListeners() {
        this.ws.on('open', this._boundOnOpen);
        this.ws.on('message', this._boundOnMessage);
        this.ws.on('close', this._boundOnClose);
        this.ws.on('error', this._boundOnError);
    }

    _detachSocketListeners() {
        if (!this.ws) return;

        this.ws.removeListener('open', this._boundOnOpen);
        this.ws.removeListener('message', this._boundOnMessage);
        this.ws.removeListener('close', this._boundOnClose);
        this.ws.removeListener('error', this._boundOnError);
    }

    _onOpen() {
        if (this._closed || this._openEmitted) return;
        this._openEmitted = true;
        this.emit('connected');
    }

    _onError(error) {
        this.emit('error', error);
    }

    _onClose(code, reason) {
        if (this._closed) return;

        this._closed = true;

        const normalizedReason = normalizeCloseReason(reason);
        const message = `Socket closed${code ? ` (${code})` : ''}${normalizedReason ? `: ${normalizedReason}` : ''}`;

        this._rejectAllPending(createRpcError(message, 'SOCKET_CLOSED'));
        this._detachSocketListeners();

        this.emit('disconnected', code, normalizedReason);
    }

    _rejectAllPending(error) {
        for (const pending of this.pendingRequests.values()) {
            if (pending.timer) clearTimeout(pending.timer);
            if (pending.abortCleanup) pending.abortCleanup();
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }

    _encode(message) {
        const payload = this.options.serializer(message);

        if (!isValidSerializedPayload(payload)) {
            throw new TypeError('serializer must return a string, Buffer, ArrayBuffer, or typed array');
        }

        return payload;
    }

    _decode(raw) {
        const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
        return this.options.deserializer(text);
    }

    _send(message) {
        if (!this.isOnline) {
            throw createRpcError('WebSocket is not open', 'SOCKET_NOT_OPEN');
        }

        const payload = this._encode(message);
        this.ws.send(payload);
    }

    _safeSend(message) {
        try {
            this._send(message);
            return true;
        } catch (error) {
            this.emit('error', error);
            return false;
        }
    }

    async _onMessage(raw) {
        let message;

        try {
            message = this._decode(raw);
        } catch (error) {
            this.emit('protocolError', createRpcError('Failed to parse incoming message', 'INVALID_JSON'));
            return;
        }

        if (!isPlainObject(message) || typeof message.type !== 'string') {
            this.emit('protocolError', createRpcError('Received malformed message', 'INVALID_MESSAGE'));
            return;
        }

        switch (message.type) {
            case MESSAGE_TYPES.RESPONSE:
                this._handleResponse(message);
                break;
            case MESSAGE_TYPES.REQUEST:
                await this._handleIncomingRequest(message);
                break;
            case MESSAGE_TYPES.PUBLISH:
                await this._handleIncomingPublish(message);
                break;
            default:
                this.emit(
                    'protocolError',
                    createRpcError(`Unsupported message type '${message.type}'`, 'UNSUPPORTED_MESSAGE_TYPE')
                );
        }
    }

    _handleResponse(message) {
        const { ack, code, data } = message;

        if (typeof ack !== 'string' || typeof code !== 'number') {
            this.emit('protocolError', createRpcError('Received malformed response message', 'INVALID_RESPONSE'));
            return;
        }

        const pending = this.pendingRequests.get(ack);
        if (!pending) return;

        this.pendingRequests.delete(ack);

        if (pending.timer) clearTimeout(pending.timer);
        if (pending.abortCleanup) pending.abortCleanup();

        if (code >= 200 && code < 300) {
            pending.resolve(data);
            return;
        }

        pending.reject(createRpcError(createErrorMessage(data), code, data));
    }

    async _handleIncomingRequest(message) {
        const { id, method, data } = message;

        if (typeof id !== 'string' || !id) {
            this.emit('protocolError', createRpcError('Received request without a valid id', 'INVALID_REQUEST'));
            return;
        }

        if (typeof method !== 'string' || !method) {
            this._safeSend({
                type: MESSAGE_TYPES.RESPONSE,
                ack: id,
                code: 400,
                data: { message: 'Invalid request method' },
            });
            return;
        }

        try {
            const result = await this._dispatch({
                type: MESSAGE_TYPES.REQUEST,
                id,
                method,
                data,
            });

            this._safeSend({
                type: MESSAGE_TYPES.RESPONSE,
                ack: id,
                code: 200,
                data: result,
            });
        } catch (error) {
            this._safeSend({
                type: MESSAGE_TYPES.RESPONSE,
                ack: id,
                code: Number.isInteger(error.code) ? error.code : 500,
                data: {
                    message: error && error.message ? error.message : 'Internal error',
                    ...(error && error.data !== undefined ? { details: error.data } : {}),
                },
            });
        }
    }

    async _handleIncomingPublish(message) {
        const { method, data } = message;

        if (typeof method !== 'string' || !method) {
            this.emit('protocolError', createRpcError('Received publish with invalid method', 'INVALID_PUBLISH'));
            return;
        }

        try {
            await this._dispatch({
                type: MESSAGE_TYPES.PUBLISH,
                method,
                data,
            });
        } catch (error) {
            this.emit('error', error);
        }
    }

    async _dispatch(ctx) {
        const handler = this.routes[ctx.method];

        if (!handler) {
            if (ctx.type === MESSAGE_TYPES.REQUEST) {
                throw createRpcError(`Method '${ctx.method}' not found`, 404, {
                    method: ctx.method,
                });
            }
            return undefined;
        }

        const middlewareStack = [...this.middleware];

        let index = -1;

        const runner = async (i) => {
            if (i <= index) {
                throw new Error('next() called multiple times');
            }

            index = i;

            if (i === middlewareStack.length) {
                return handler(ctx.data, this, ctx);
            }

            const fn = middlewareStack[i];
            return fn(ctx, () => runner(i + 1), this);
        };

        return runner(0);
    }

    request(method, data, options = {}) {
        if (typeof method !== 'string' || !method) {
            return Promise.reject(new TypeError('method must be a non-empty string'));
        }

        const timeout = Number.isFinite(options.timeout) && options.timeout > 0
            ? options.timeout
            : this.options.requestTimeout;

        const signal = options.signal;
        const id = uuidv4();

        const message = {
            type: MESSAGE_TYPES.REQUEST,
            id,
            method,
            data,
        };

        return new Promise((resolve, reject) => {
            if (this._closed) {
                reject(createRpcError('Channel is closed', 'CHANNEL_CLOSED'));
                return;
            }

            if (signal?.aborted) {
                reject(createRpcError('Request aborted', 'ABORT_ERR'));
                return;
            }

            const pending = {
                resolve,
                reject,
                timer: null,
                abortCleanup: null,
            };

            this.pendingRequests.set(id, pending);

            if (timeout > 0) {
                pending.timer = setTimeout(() => {
                    this.pendingRequests.delete(id);
                    if (pending.abortCleanup) pending.abortCleanup();
                    reject(createRpcError(`Request timed out after ${timeout}ms`, 'TIMEOUT'));
                }, timeout);
            }

            if (signal) {
                const onAbort = () => {
                    this.pendingRequests.delete(id);
                    if (pending.timer) clearTimeout(pending.timer);
                    reject(createRpcError('Request aborted', 'ABORT_ERR'));
                };

                signal.addEventListener('abort', onAbort, { once: true });
                pending.abortCleanup = () => {
                    signal.removeEventListener('abort', onAbort);
                };
            }

            try {
                this._send(message);
            } catch (error) {
                this.pendingRequests.delete(id);
                if (pending.timer) clearTimeout(pending.timer);
                if (pending.abortCleanup) pending.abortCleanup();
                reject(error);
            }
        });
    }

    publish(method, data) {
        if (typeof method !== 'string' || !method) {
            return false;
        }

        return this._safeSend({
            type: MESSAGE_TYPES.PUBLISH,
            method,
            data,
        });
    }

    close(code, reason) {
        if (!this.ws || this._closed) return;
        this.ws.close(code, reason);
    }

    terminate() {
        if (!this.ws || this._closed) return;
        this.ws.terminate();
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._closed = true;

        this._rejectAllPending(createRpcError('Channel destroyed', 'CHANNEL_DESTROYED'));
        this._detachSocketListeners();

        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
            try {
                this.ws.terminate();
            } catch (_) {}
        }

        this.ws = null;
        this.removeAllListeners();
    }
}

class Server extends EventEmitter {
    constructor(options = {}) {
        super();

        this.options = {
            port: 8080,
            host: undefined,
            externalServer: null,
            routes: {},
            middleware: [],
            requestTimeout: DEFAULT_REQUEST_TIMEOUT,
            serializer: JSON.stringify,
            deserializer: JSON.parse,
            maxPayload: 1024 * 1024,
            perMessageDeflate: false,
            wsOptions: {},
            ...options,
        };

        this.server = null;
        this.wss = null;
        this.channels = new Set();
        this.started = false;
    }

    async start() {
        if (this.started) {
            throw new Error('Server has already been started');
        }

        this.server = this.options.externalServer || http.createServer();

        const serverOptions = {
            ...this.options.wsOptions,
            perMessageDeflate: this.options.perMessageDeflate,
            maxPayload: this.options.maxPayload,
            server: this.server,
        };

        delete serverOptions.port;
        delete serverOptions.host;
        delete serverOptions.noServer;

        this.wss = new WebSocket.Server(serverOptions);

        this.wss.on('connection', (ws, req) => {
            const channel = new Channel(ws, {
                routes: this.options.routes,
                middleware: this.options.middleware,
                serializer: this.options.serializer,
                deserializer: this.options.deserializer,
                requestTimeout: this.options.requestTimeout,
                maxPayload: this.options.maxPayload,
            });

            this.channels.add(channel);

            channel.on('disconnected', () => {
                this.channels.delete(channel);
            });

            channel.on('error', (err) => {
                this.emit('clientError', err, channel, req);
            });

            channel.on('protocolError', (err) => {
                this.emit('clientProtocolError', err, channel, req);
            });

            this.emit('connection', channel, req);
        });

        this.wss.on('error', (err) => this.emit('error', err));

        if (this.options.externalServer) {
            this.started = true;
            this.emit('listening', getBoundServerPort(this.server, this.options.port), this.options.host);
            return;
        }

        await new Promise((resolve, reject) => {
            const onError = (err) => {
                this.server.removeListener('listening', onListening);
                reject(err);
            };

            const onListening = () => {
                this.server.removeListener('error', onError);
                resolve();
            };

            this.server.once('error', onError);
            this.server.once('listening', onListening);
            this.server.listen(this.options.port, this.options.host);
        });

        this.server.on('error', (err) => this.emit('error', err));

        this.started = true;
        this.emit('listening', getBoundServerPort(this.server, this.options.port), this.options.host);
    }

    broadcast(method, data) {
        let count = 0;

        for (const channel of this.channels) {
            if (channel.publish(method, data)) {
                count += 1;
            }
        }

        return count;
    }

    async stop() {
        if (!this.wss) {
            this.started = false;
            return;
        }

        const channels = Array.from(this.channels);
        const disconnects = channels.map((channel) => {
            if (channel.isClosed || !channel.ws) {
                return Promise.resolve();
            }

            return once(channel, 'disconnected').catch(() => undefined);
        });

        for (const channel of channels) {
            channel.close(1001, 'Server shutting down');
        }

        await new Promise((resolve, reject) => {
            this.wss.close((err) => (err ? reject(err) : resolve()));
        });

        await Promise.allSettled(disconnects);

        this.channels.clear();
        this.wss.removeAllListeners();
        this.wss = null;

        if (this.server && !this.options.externalServer) {
            await new Promise((resolve, reject) => {
                this.server.close((err) => (err ? reject(err) : resolve()));
            });
            this.server.removeAllListeners();
            this.server = null;
        }

        this.started = false;
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
            requestTimeout: DEFAULT_REQUEST_TIMEOUT,
            routes: {},
            middleware: [],
            maxPayload: 1024 * 1024,
            serializer: JSON.stringify,
            deserializer: JSON.parse,
            rejectUnauthorized: true,
            perMessageDeflate: false,
            wsOptions: {},
            ...options,
        };

        this.ws = null;
        this.channel = null;
        this.pingTimer = null;
        this.reconnectTimer = null;

        this._closedManually = false;
        this._connecting = false;
        this._disconnectHandled = false;

        this._connect();
    }

    _connect() {
        if (this._connecting) return;
        this._connecting = true;
        this._disconnectHandled = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.ws = new WebSocket(this.url, {
            rejectUnauthorized: this.options.rejectUnauthorized,
            perMessageDeflate: this.options.perMessageDeflate,
            maxPayload: this.options.maxPayload,
            ...this.options.wsOptions,
        });

        this.ws.once('open', () => {
            this._connecting = false;
            this._closedManually = false;

            this.channel = new Channel(this.ws, {
                routes: this.options.routes,
                middleware: this.options.middleware,
                requestTimeout: this.options.requestTimeout,
                serializer: this.options.serializer,
                deserializer: this.options.deserializer,
                maxPayload: this.options.maxPayload,
            });

            this.channel.on('error', (err) => this.emit('error', err));
            this.channel.on('protocolError', (err) => this.emit('protocolError', err));
            this.channel.on('disconnected', (code, reason) => this._handleDisconnect(code, reason));

            if (this.options.pingInterval > 0) {
                this._startPing();
            }

            this.emit('connected', this.channel);
        });

        this.ws.once('error', (err) => {
            this._connecting = false;
            this.emit('error', err);
        });

        this.ws.once('close', (code, reason) => {
            this._connecting = false;
            this._handleDisconnect(code, normalizeCloseReason(reason));
        });
    }

    _handleDisconnect(code, reason) {
        if (this._disconnectHandled) return;
        this._disconnectHandled = true;
        this._connecting = false;

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        this.channel = null;
        this.emit('disconnected', code, reason);

        if (!this._closedManually && this.options.autoReconnect) {
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this._connect();
            }, this.options.reconnectInterval);
        }
    }

    _startPing() {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
        }

        this.pingTimer = setInterval(() => {
            if (!this.channel || !this.channel.isOnline) return;

            this.channel
                .request('ping', null, {
                    timeout: Math.max(1000, Math.floor(this.options.pingInterval / 2)),
                })
                .catch(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.close(1011, 'Ping timeout');
                    }
                });
        }, this.options.pingInterval);
    }

    close(code = 1000, reason = 'Client closing') {
        this._closedManually = true;
        this._connecting = false;
        this._disconnectHandled = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close(code, reason);
        } else if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.terminate();
        } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            queueMicrotask(() => this._handleDisconnect(code, reason));
        }
    }

    terminate() {
        this._closedManually = true;
        this._connecting = false;
        this._disconnectHandled = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        if (this.ws) {
            this.ws.terminate();
        } else {
            queueMicrotask(() => this._handleDisconnect(1006, 'Client terminated'));
        }
    }
}

module.exports = {
    Server,
    Client,
    Channel,
};