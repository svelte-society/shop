import { describe, expect, it } from 'vitest';
import { _createDestinationPreferencePost } from './+server';

const runtimeEnv = { STYRIA_SUPPORTED_COUNTRIES: 'SE,DE,JP' };

function fixture(production = false) {
	const sets: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
	const handler = _createDestinationPreferencePost(runtimeEnv, production);
	return {
		handler,
		sets,
		cookies: {
			set(name: string, value: string, options: Record<string, unknown>) {
				sets.push({ name, value, options });
			}
		}
	};
}

async function post(body: string, options: { production?: boolean; contentLength?: string } = {}) {
	const current = fixture(options.production);
	const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
	if (options.contentLength !== undefined) headers.set('content-length', options.contentLength);
	const response = await current.handler({
		request: new Request('https://shop.sveltesociety.dev/preferences/destination', {
			method: 'POST',
			headers,
			body
		}),
		cookies: current.cookies
	} as unknown as Parameters<typeof current.handler>[0]);
	return { ...current, response };
}

describe('POST /preferences/destination', () => {
	it('stores a valid country then redirects to the supplied local return path', async () => {
		const { response, sets } = await post('country=DE&returnTo=%2Fcart', { production: true });

		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('/cart');
		expect(sets).toEqual([
			{
				name: 'shop_destination_v1',
				value: 'DE',
				options: {
					path: '/',
					maxAge: 31_536_000,
					httpOnly: true,
					sameSite: 'lax',
					secure: true
				}
			}
		]);
	});

	it.each([
		'country=DE&returnTo=%2F%2Fevil.example',
		'country=DE&returnTo=https%3A%2F%2Fevil.example',
		'country=DE&country=JP&returnTo=%2Fcart',
		'country=DE&returnTo=%2Fcart&extra=value',
		'country=DE',
		'returnTo=%2Fcart',
		'country=de&returnTo=%2Fcart',
		'country=US&returnTo=%2Fcart'
	])('rejects an invalid or unsafe form shape: %s', async (body) => {
		const { response, sets } = await post(body);

		expect(response.status).toBe(400);
		expect(sets).toEqual([]);
	});

	it('rejects a payload over 4 KiB before parsing it', async () => {
		const { response, sets } = await post(
			`country=DE&returnTo=%2Fcart&padding=${'x'.repeat(4_096)}`
		);

		expect(response.status).toBe(400);
		expect(sets).toEqual([]);
	});
});
