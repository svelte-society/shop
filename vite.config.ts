import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { fileURLToPath } from 'node:url';

const CATALOG_GATEWAY_MODULE_ID = '$lib/server/catalog/runtime-gateway.server';

type FixtureEnvironment = Record<string, string | undefined>;

export function resolveCatalogFixtureAlias(
	environment: FixtureEnvironment,
	fixtureModulePath: string
): string | null {
	if (environment.TEST_CATALOG_FIXTURE !== 'true') return null;
	if (environment.NODE_ENV !== 'test') {
		throw new Error('TEST_CATALOG_FIXTURE_REQUIRES_NODE_ENV_TEST');
	}

	return fixtureModulePath;
}

export default defineConfig(() => {
	const fixtureModulePath = fileURLToPath(
		new URL('./tests/fixtures/catalog-server.ts', import.meta.url)
	);
	const runtimeGatewayModulePath = fileURLToPath(
		new URL('./src/lib/server/catalog/runtime-gateway.server.ts', import.meta.url)
	);
	const catalogFixtureAlias = resolveCatalogFixtureAlias(process.env, fixtureModulePath);

	return {
		plugins: [
			...(catalogFixtureAlias
				? [
						{
							name: 'test-catalog-gateway-injection',
							enforce: 'pre' as const,
							resolveId(source: string) {
								return source === CATALOG_GATEWAY_MODULE_ID ||
									source === runtimeGatewayModulePath ||
									source === runtimeGatewayModulePath.slice(0, -3)
									? catalogFixtureAlias
									: null;
							}
						}
					]
				: []),
			tailwindcss(),
			sveltekit({
				compilerOptions: {
					// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
					runes: ({ filename }) =>
						filename.split(/[/\\]/).includes('node_modules') ? undefined : true
				},
				adapter: adapter()
			})
		],
		test: {
			expect: { requireAssertions: true },
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						name: 'client',
						browser: {
							enabled: true,
							provider: playwright(),
							instances: [{ browser: 'chromium' as const, headless: true }]
						},
						include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
						exclude: ['src/lib/server/**']
					}
				},

				{
					extends: './vite.config.ts',
					test: {
						name: 'server',
						environment: 'node',
						include: ['src/**/*.{test,spec}.{js,ts}'],
						exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
					}
				}
			]
		}
	};
});
