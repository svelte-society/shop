import { describe, expect, it } from 'vitest';
import { resolveCatalogFixtureAlias } from '../../vite.config';

describe('catalog fixture isolation', () => {
	it('injects the fixture only for an explicit test runtime', () => {
		expect(
			resolveCatalogFixtureAlias(
				{ NODE_ENV: 'test', TEST_CATALOG_FIXTURE: 'true' },
				'/workspace/tests/fixtures/catalog-server.ts'
			)
		).toBe('/workspace/tests/fixtures/catalog-server.ts');

		expect(
			resolveCatalogFixtureAlias(
				{ NODE_ENV: 'test', TEST_CATALOG_FIXTURE: 'false' },
				'/workspace/tests/fixtures/catalog-server.ts'
			)
		).toBeNull();
	});

	it.each(['production', 'development', undefined])(
		'fails fast when the fixture flag is set under NODE_ENV=%s',
		(nodeEnv) => {
			expect(() =>
				resolveCatalogFixtureAlias(
					{ NODE_ENV: nodeEnv, TEST_CATALOG_FIXTURE: 'true' },
					'/workspace/tests/fixtures/catalog-server.ts'
				)
			).toThrowError('TEST_CATALOG_FIXTURE_REQUIRES_NODE_ENV_TEST');
		}
	);
});
