import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		name: 'integration',
		environment: 'node',
		include: ['tests/integration/**/*.{test,spec}.ts']
	}
});
