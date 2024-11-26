const { Server, Client } = require('./socketit');

// Start a secure WebSocket server
const server = new Server({
    port: 8443,
    tls: true, // Enable TLS
    // No cert/key provided; it will generate self-signed certificates
    routes: {
        hello: async (data) => `Hello, ${data.name || 'World'}!`,
    },
    perMessageDeflate: true
});

server.start().then(() => {
    console.log('Server started on port 8443 with TLS');
});

// Connect a WebSocket client
const client = new Client('wss://localhost:8443', {
    rejectUnauthorized: false, // Allow self-signed certificates
    perMessageDeflate: true
});

client.on('connected', async (channel) => {
    console.log('Client connected to server');

    // Test a request-response route
    try {
        const response = await channel.request('hello', { name: 'Test' });
        console.log('Response from server:', response);
    } catch (err) {
        console.error('Error:', err.message);
    }

    // Test the ping route
    try {
        const pingResponse = await channel.request('ping');
        console.log('Ping response:', pingResponse);
    } catch (err) {
        console.error('Ping failed:', err.message);
    }

    // Close the client and server
    client.close();
    server.stop().then(() => console.log('Server stopped'));
});

client.on('error', (err) => console.error('Client error:', err.message));
client.on('disconnected', () => console.log('Client disconnected'));