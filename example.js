const { Server, Client } = require('./socketit');

async function main() {
    const server = new Server({
        port: 8080,
        routes: {
            hello: async (data) => `Hello, ${data && data.name ? data.name : 'World'}!`,
            notify: async (data) => {
                console.log('publish received on server:', data);
            },
        },
    });

    server.on('connection', () => {
        console.log('Client connected to server');
    });

    await server.start();
    console.log('Server started on ws://127.0.0.1:8080');

    const client = new Client('ws://127.0.0.1:8080', {
        pingInterval: 0,
        routes: {
            announcement: async (data) => {
                console.log('publish received on client:', data);
            },
        },
    });

    client.on('error', (err) => console.error('Client error:', err.message));
    client.on('disconnected', () => console.log('Client disconnected'));

    client.on('connected', async (channel) => {
        console.log('Client connected');

        try {
            const response = await channel.request('hello', { name: 'Socketit' });
            console.log('Response from server:', response);

            const pingResponse = await channel.request('ping');
            console.log('Ping response:', pingResponse);

            channel.publish('notify', { type: 'demo-event' });
        } catch (err) {
            console.error('Request failed:', err.message);
        } finally {
            client.close();
            await server.stop();
            console.log('Server stopped');
        }
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
