import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'$env/dynamic/private': resolve('tests/fixtures/private-env.ts'),
			$lib: resolve('src/lib')
		}
	},
	test: {
		name: 'real-s3-child',
		environment: 'node',
		include: ['tests/fixtures/real-s3-drill-child.test.ts']
	}
});
