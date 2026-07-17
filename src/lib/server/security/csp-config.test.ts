import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { svelteKitOptions } from '../../../../vite.config';

describe('SvelteKit CSP configuration', () => {
	it('uses the supported nonce mode for generated hydration scripts with restrictive defaults', () => {
		expect(svelteKitOptions.csp).toEqual({
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'base-uri': ['self'],
				'connect-src': ['self'],
				'font-src': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'frame-src': ['none'],
				'img-src': ['self'],
				'manifest-src': ['self'],
				'media-src': ['self'],
				'object-src': ['none'],
				'script-src': ['self'],
				'style-src': ['self'],
				'worker-src': ['self']
			}
		});
	});

	it('contains no manually-authored inline script or style attribute in the app shell', async () => {
		const template = await readFile('src/app.html', 'utf8');

		expect(template).not.toMatch(/<script\b/iu);
		expect(template).not.toMatch(/\sstyle=/iu);
		expect(template).not.toContain('unsafe-inline');
	});

	it('serves the favicon from self instead of an inlined data URL', async () => {
		const layout = await readFile('src/routes/+layout.svelte', 'utf8');

		expect(layout).toContain('<link rel="icon" href="/brand/svelte-society.svg" />');
		expect(layout).not.toContain("import favicon from '$lib/assets/favicon.svg'");
	});
});
