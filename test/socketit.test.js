const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { Server, Client } = require('../socketit');

async function createServerAndClient(serverOptions = {}, clientOptions = {}) {
    const server = new Server({ port: 0, ...serverOptions });
    await server.start();

    const address = server.server.address();
    const client = new Client(`ws://127.0.0.1:${address.port}`, {
        autoReconnect: false,
        pingInterval: 0,
        ...clientOptions,
    });

    const [channel] = await once(client, 'connected');
    return { server, client, channel, port: address.port };
}

async function closePair(server, client) {
    if (client) {
        client.close();
    }

    if (server) {
        await server.stop();
    }
}

test('request resolves with handler result', async () => {
    const { server, client, channel } = await createServerAndClient({
        routes: {
            echo: async (data) => ({ echoed: data }),
        },
    });

    try {
        const result = await channel.request('echo', { hello: 'world' });
        assert.deepEqual(result, { echoed: { hello: 'world' } });
    } finally {
        await closePair(server, client);
    }
});

test('request rejects for missing route with status code', async () => {
    const { server, client, channel } = await createServerAndClient();

    try {
        await assert.rejects(
            channel.request('missing-route', null),
            (error) => error.code === 404 && /not found/.test(error.message)
        );
    } finally {
        await closePair(server, client);
    }
});

test('request rejects when handler throws', async () => {
    const { server, client, channel } = await createServerAndClient({
        routes: {
            explode: async () => {
                throw new Error('boom');
            },
        },
    });

    try {
        await assert.rejects(
            channel.request('explode'),
            (error) => error.code === 500 && error.message === 'boom'
        );
    } finally {
        await closePair(server, client);
    }
});

test('request times out when no response arrives', async () => {
    const { server, client, channel } = await createServerAndClient({
        routes: {
            stall: () => new Promise(() => {}),
        },
    });

    try {
        await assert.rejects(
            channel.request('stall', null, { timeout: 50 }),
            /Request timed out after 50ms/
        );
    } finally {
        await closePair(server, client);
    }
});

test('publish is fire-and-forget and invokes route', async () => {
    let received;
    const publishReceived = new Promise((resolve) => {
        received = resolve;
    });

    const { server, client, channel } = await createServerAndClient({
        routes: {
            notify: async (data) => {
                received(data);
            },
        },
    });

    try {
        const published = channel.publish('notify', { event: 'created' });
        assert.equal(published, true);
        assert.deepEqual(await publishReceived, { event: 'created' });
    } finally {
        await closePair(server, client);
    }
});

test('pending requests are rejected when the socket closes', async () => {
    const { server, client, channel } = await createServerAndClient({
        routes: {
            wait: () => new Promise(() => {}),
        },
    });

    try {
        const pending = channel.request('wait', null, { timeout: 1000 });
        setTimeout(() => {
            server.stop().catch(() => undefined);
        }, 20);

        await assert.rejects(
            pending,
            /Socket closed/
        );
    } finally {
        await closePair(server, client);
    }
});

test('client reconnects automatically and can request again', async () => {
    const server = new Server({
        port: 0,
        routes: {
            pingValue: async () => 'ok',
        },
    });
    await server.start();
    const { port } = server.server.address();

    const client = new Client(`ws://127.0.0.1:${port}`, {
        reconnectInterval: 50,
        pingInterval: 0,
    });

    const [firstChannel] = await once(client, 'connected');
    const disconnected = once(client, 'disconnected');
    const reconnected = once(client, 'connected');

    for (const channel of server.channels) {
        channel.close();
    }

    await disconnected;
    const [secondChannel] = await reconnected;

    try {
        assert.notEqual(secondChannel, firstChannel);
        const result = await secondChannel.request('pingValue');
        assert.equal(result, 'ok');
    } finally {
        await closePair(server, client);
    }
});

test('manual close prevents reconnect', async () => {
    const { server, client } = await createServerAndClient();

    let reconnected = false;
    client.on('connected', () => {
        reconnected = true;
    });

    client.close();
    await once(client, 'disconnected');
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
        assert.equal(reconnected, false);
    } finally {
        await server.stop();
    }
});

test('server stop closes all channels', async () => {
    const { server, client } = await createServerAndClient();
    const disconnected = once(client, 'disconnected');

    await server.stop();
    await disconnected;

    assert.equal(server.channels.size, 0);

    client.close();
});

test('invalid request method rejects immediately', async () => {
    const { server, client, channel } = await createServerAndClient();

    try {
        await assert.rejects(channel.request(''), /method must be a non-empty string/);
        assert.equal(channel.publish(''), false);
    } finally {
        await closePair(server, client);
    }
});

test('middleware can transform request flow before route handler', async () => {
    const { server, client, channel } = await createServerAndClient({
        middleware: [
            async (ctx, next) => {
                ctx.data = { ...ctx.data, throughMiddleware: true };
                return next();
            },
        ],
        routes: {
            inspect: async (data, _channel, ctx) => ({
                method: ctx.method,
                type: ctx.type,
                data,
            }),
        },
    });

    try {
        const result = await channel.request('inspect', { original: true });
        assert.deepEqual(result, {
            method: 'inspect',
            type: 'request',
            data: {
                original: true,
                throughMiddleware: true,
            },
        });
    } finally {
        await closePair(server, client);
    }
});

test('request supports AbortSignal cancellation', async () => {
    const { server, client, channel } = await createServerAndClient({
        routes: {
            stall: () => new Promise(() => {}),
        },
    });

    try {
        const controller = new AbortController();
        const pending = channel.request('stall', null, { signal: controller.signal, timeout: 1000 });
        controller.abort();

        await assert.rejects(
            pending,
            (error) => error.code === 'ABORT_ERR' && error.message === 'Request aborted'
        );
    } finally {
        await closePair(server, client);
    }
});

test('custom serializer and deserializer are propagated through client and server', async () => {
    const serializer = (message) => JSON.stringify({ wrapped: message });
    const deserializer = (payload) => JSON.parse(payload).wrapped;

    const { server, client, channel } = await createServerAndClient({
        serializer,
        deserializer,
        routes: {
            echo: async (data) => data,
        },
    }, {
        serializer,
        deserializer,
    });

    try {
        const result = await channel.request('echo', { codec: 'ok' });
        assert.deepEqual(result, { codec: 'ok' });
    } finally {
        await closePair(server, client);
    }
});

test('server listening event reports the actual bound port', async () => {
    const server = new Server({ port: 0 });
    const listening = once(server, 'listening');

    try {
        await server.start();
        const [port] = await listening;
        assert.equal(port, server.server.address().port);
        assert.notEqual(port, 0);
    } finally {
        await server.stop();
    }
});

test('invalid serializer output is surfaced as a send error', async () => {
    const { server, client, channel } = await createServerAndClient({}, {
        serializer: () => ({ invalid: true }),
    });

    try {
        const errorEvent = once(client, 'error');
        const published = channel.publish('notify', { test: true });
        const [error] = await errorEvent;

        assert.equal(published, false);
        assert.match(error.message, /serializer must return/i);
    } finally {
        await closePair(server, client);
    }
});

test('server maxPayload rejects oversized frames', async () => {
    const server = new Server({
        port: 0,
        maxPayload: 128,
        routes: {
            echo: async (data) => data,
        },
    });
    await server.start();
    const { port } = server.server.address();

    const client = new Client(`ws://127.0.0.1:${port}`, {
        autoReconnect: false,
        pingInterval: 0,
    });

    const [channel] = await once(client, 'connected');
    const disconnected = once(client, 'disconnected');

    try {
        const payload = 'x'.repeat(2048);
        await assert.rejects(channel.request('echo', payload, { timeout: 1000 }));
        await disconnected;
    } finally {
        await closePair(server, client);
    }
});

test('server wsOptions cannot override internal server binding', async () => {
    const foreignServer = require('http').createServer();
    const server = new Server({
        port: 0,
        wsOptions: {
            server: foreignServer,
        },
    });

    try {
        await server.start();
        assert.equal(server.wss.options.server, server.server);
        assert.notEqual(server.wss.options.server, foreignServer);
    } finally {
        await server.stop();
        foreignServer.close();
    }
});

