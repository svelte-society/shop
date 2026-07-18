import { pathToFileURL } from 'node:url';

export const TEST_E2E_BUILD_ENV = Object.freeze({
	NODE_ENV: 'test',
	TEST_CATALOG_FIXTURE: 'true',
	TEST_E2E_BUILD_OUT: 'build-e2e'
});

/**
 * Build one immutable fixture artifact before Playwright starts its scenario servers.
 *
 * @param {{
 *   environment?: Record<string, string | undefined>;
 *   loadVite?: () => Promise<{ build(): Promise<unknown> }>;
 * }} [options]
 */
export async function buildTestE2e(options = {}) {
	const environment = options.environment ?? process.env;
	const loadVite = options.loadVite ?? (() => import('vite'));

	Object.assign(environment, TEST_E2E_BUILD_ENV);
	const { build } = await loadVite();
	await build();
}

async function run() {
	try {
		await buildTestE2e();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) void run();
