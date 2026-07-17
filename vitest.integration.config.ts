import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
	resolve: {
		alias: {
			'$env/dynamic/private': resolve('tests/fixtures/private-env.ts'),
			$lib: resolve('src/lib')
		}
	},
	test: {
		name: 'integration',
		environment: 'node',
		include: ['tests/integration/**/*.{test,spec}.ts']
	}
});
