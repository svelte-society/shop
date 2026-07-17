import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { resolve } from 'node:path';

const fixtures = resolve(import.meta.dirname, '../fixtures');
const server = createServer(
	{
		key: readFileSync(resolve(fixtures, 'provider-key.pem')),
		cert: readFileSync(resolve(fixtures, 'provider-cert.pem'))
	},
	(request) => {
		console.log('BLOCKED_PROVIDER_ACCEPTED');
		request.socket.once('close', () => console.log('BLOCKED_PROVIDER_ABORTED'));
		request.socket.on('error', () => undefined);
		// Deliberately withhold response headers and body until the client aborts.
	}
);

server.listen(0, '0.0.0.0', () => {
	const address = server.address();
	if (!address || typeof address === 'string') process.exit(1);
	console.log(`BLOCKED_PROVIDER_LISTENING=${address.port}`);
});

process.once('SIGTERM', () => server.close(() => process.exit(0)));
