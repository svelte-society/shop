import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 4173;
const PREVIEW_URL = `http://${HOST}:${PORT}/`;

export const TEST_CATALOG_PREVIEW_ENV = Object.freeze({
	NODE_ENV: 'test',
	TEST_CATALOG_FIXTURE: 'true',
	TEST_CATALOG_SCENARIO: 'available',
	STOREFRONT_ENABLED: 'true',
	CHECKOUT_ENABLED: 'false',
	PRODUCTION_ORIGIN: 'https://shop.sveltesociety.dev',
	SUPPORT_EMAIL: 'merch@sveltesociety.dev',
	STRIPE_SECRET_KEY: 'sk_test_catalog_fixture',
	STRIPE_WEBHOOK_SECRET: 'whsec_test_fixture',
	STRIPE_PAID_SHIPPING_RATE_ID: 'shr_test_paid',
	STRIPE_FREE_SHIPPING_RATE_ID: 'shr_test_free'
});

/**
 * @typedef {{
 *   listen(): Promise<unknown>;
 *   close(): Promise<unknown>;
 * }} PreviewServer
 */

/**
 * @typedef {{
 *   createServer(config: {
 *     server: { host: string; port: number; strictPort: boolean };
 *   }): Promise<PreviewServer>;
 * }} PreviewViteModule
 */

/**
 * Apply the fixture guard and dummy private values only when the preview is explicitly started.
 *
 * @param {Record<string, string | undefined>} environment
 */
export function applyTestCatalogEnvironment(environment) {
	Object.assign(environment, TEST_CATALOG_PREVIEW_ENV);
	return environment;
}

/**
 * @param {{
 *   environment?: Record<string, string | undefined>;
 *   loadVite?: () => Promise<PreviewViteModule>;
 *   output?: Pick<Console, 'log'>;
 * }} [options]
 */
export async function startTestCatalogPreview(options = {}) {
	const environment = options.environment ?? process.env;
	const loadVite = options.loadVite ?? (() => import('vite'));
	const output = options.output ?? console;
	const inheritedSigtermListeners = new Set(process.listeners('SIGTERM'));

	applyTestCatalogEnvironment(environment);
	const { createServer } = await loadVite();
	const server = await createServer({
		server: { host: HOST, port: PORT, strictPort: true }
	});
	// Vite registers its own SIGTERM exit handler; the launcher closes the server before exiting.
	for (const listener of process.listeners('SIGTERM')) {
		if (!inheritedSigtermListeners.has(listener)) process.off('SIGTERM', listener);
	}

	try {
		await server.listen();
	} catch (listenError) {
		try {
			await server.close();
		} catch (closeError) {
			throw new AggregateError(
				[listenError, closeError],
				'Test catalog preview failed to listen and close cleanly.',
				{ cause: closeError }
			);
		}
		throw listenError;
	}
	output.log(`Test catalog preview: ${PREVIEW_URL}`);
	return server;
}

async function run() {
	let server;
	try {
		server = await startTestCatalogPreview();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	let closing = false;
	/** @param {'SIGINT' | 'SIGTERM'} signal */
	const shutdown = async (signal) => {
		if (closing) return;
		closing = true;
		const keepAlive = setInterval(() => undefined, 1_000);
		process.off('SIGINT', handleSigint);
		process.off('SIGTERM', handleSigterm);

		try {
			await server.close();
			console.log(`Test catalog preview stopped (${signal}).`);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		} finally {
			clearInterval(keepAlive);
			process.exit(process.exitCode ?? 0);
		}
	};
	const handleSigint = () => void shutdown('SIGINT');
	const handleSigterm = () => void shutdown('SIGTERM');

	process.once('SIGINT', handleSigint);
	process.once('SIGTERM', handleSigterm);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) void run();
