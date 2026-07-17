import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import Umami from './Umami.svelte';

afterEach(() => {
	document.head.querySelectorAll('script[data-website-id]').forEach((script) => script.remove());
});

describe('Umami', () => {
	it('loads the exact configured tracker without automatic tracking or visible UI', () => {
		const view = render(Umami, {
			scriptUrl: 'https://analytics.sveltesociety.dev/script.js',
			websiteId: 'society-storefront',
			connectOrigin: 'https://analytics-api.sveltesociety.dev'
		});

		const script = document.head.querySelector<HTMLScriptElement>(
			'script[data-website-id="society-storefront"]'
		);
		expect(script?.getAttribute('src')).toBe('https://analytics.sveltesociety.dev/script.js');
		expect(script?.defer).toBe(true);
		expect(script?.dataset.autoTrack).toBe('false');
		expect(script?.dataset.doNotTrack).toBe('true');
		expect(script?.dataset.excludeSearch).toBe('true');
		expect(script?.dataset.hostUrl).toBe('https://analytics-api.sveltesociety.dev');
		expect(view.container.textContent).toBe('');
	});

	it('uses the script origin when no separate connect origin is configured', () => {
		render(Umami, {
			scriptUrl: 'https://analytics.sveltesociety.dev/script.js',
			websiteId: 'society-storefront',
			connectOrigin: null
		});

		const script = document.head.querySelector<HTMLScriptElement>(
			'script[data-website-id="society-storefront"]'
		);
		expect(script?.hasAttribute('data-host-url')).toBe(false);
	});
});
