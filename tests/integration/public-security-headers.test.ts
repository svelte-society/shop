import { describe, expect, it } from 'vitest';
import {
	discoverImmutableAsset,
	resolveSameOriginRedirect,
	verifyResponseSequence
} from '../../scripts/verify-public-security-headers.mjs';

const securityHeaders: Readonly<Record<string, string>> = Object.freeze({
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy':
		'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()'
});

const validCsp =
	"default-src 'self'; script-src 'self' 'nonce-shared123'; style-src 'self' 'nonce-shared123'; frame-ancestors 'none'";

type ResponseFixture = {
	statusCode: number;
	rawHeaders: string[];
};

function rawHeaders(
	options: {
		contentType?: string;
		csp?: string | null;
		omit?: string;
		override?: Readonly<Record<string, string>>;
		append?: readonly [string, string][];
	} = {}
): string[] {
	const values: Record<string, string> = {
		...securityHeaders,
		'content-type': options.contentType ?? 'text/html; charset=utf-8'
	};
	if (options.csp !== null) values['content-security-policy'] = options.csp ?? validCsp;
	if (options.omit) delete values[options.omit];
	Object.assign(values, options.override);

	const result = Object.entries(values).flatMap(([name, value], index) => [
		index % 2 === 0 ? name.toUpperCase() : name,
		value
	]);
	for (const [name, value] of options.append ?? []) result.push(name, value);
	return result;
}

function response(
	options: Parameters<typeof rawHeaders>[0] & { statusCode?: number } = {}
): ResponseFixture {
	return {
		statusCode: options.statusCode ?? 200,
		rawHeaders: rawHeaders(options)
	};
}

describe('public security header verification', () => {
	it('accepts exact HTML policies and matching script/style nonces', () => {
		expect(() => verifyResponseSequence([response()], { kind: 'html' })).not.toThrow();
	});

	it.each([
		['https://shop.sveltesociety.dev/_app/immutable/app.js', 'application/javascript'],
		['https://shop.sveltesociety.dev/_app/immutable/app.css', 'text/css; charset=utf-8'],
		['https://shop.sveltesociety.dev/_app/immutable/font.woff2', 'font/woff2']
	])('accepts the expected content type for %s', (assetUrl, contentType) => {
		expect(() =>
			verifyResponseSequence([response({ contentType, csp: null })], { kind: 'asset', assetUrl })
		).not.toThrow();
	});

	it('rejects a missing required security header', () => {
		expect(() =>
			verifyResponseSequence([response({ omit: 'strict-transport-security' })], { kind: 'html' })
		).toThrow(/missing strict-transport-security/iu);
	});

	it('rejects a wrong required security header value', () => {
		expect(() =>
			verifyResponseSequence(
				[
					response({
						override: { 'referrer-policy': 'origin' }
					})
				],
				{ kind: 'html' }
			)
		).toThrow(/incorrect referrer-policy/iu);
	});

	it('rejects duplicate required raw security headers', () => {
		expect(() =>
			verifyResponseSequence(
				[
					response({
						append: [['Strict-Transport-Security', securityHeaders['strict-transport-security']]]
					})
				],
				{ kind: 'html' }
			)
		).toThrow(/duplicate strict-transport-security/iu);
	});

	it('does not let informational response headers satisfy the final response', () => {
		const informational = response({ statusCode: 103 });
		const final = response({ omit: 'x-frame-options' });

		expect(() => verifyResponseSequence([informational, final], { kind: 'html' })).toThrow(
			/missing x-frame-options/iu
		);
	});

	it('rejects a nonce that appears only outside script-src and style-src', () => {
		const csp =
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'nonce-shared123'; frame-ancestors 'none'";
		expect(() => verifyResponseSequence([response({ csp })], { kind: 'html' })).toThrow(
			/script-src nonce/iu
		);
	});

	it('rejects mismatched script-src and style-src nonces', () => {
		const csp =
			"default-src 'self'; script-src 'nonce-script123'; style-src 'nonce-style123'; frame-ancestors 'none'";
		expect(() => verifyResponseSequence([response({ csp })], { kind: 'html' })).toThrow(
			/nonce mismatch/iu
		);
	});

	it('rejects unsafe-inline anywhere in HTML CSP', () => {
		const csp = `${validCsp}; img-src 'unsafe-inline'`;
		expect(() => verifyResponseSequence([response({ csp })], { kind: 'html' })).toThrow(
			/unsafe-inline/iu
		);
	});

	it('requires frame-ancestors none in HTML CSP', () => {
		const csp = validCsp.replace("frame-ancestors 'none'", "frame-ancestors 'self'");
		expect(() => verifyResponseSequence([response({ csp })], { kind: 'html' })).toThrow(
			/frame-ancestors/iu
		);
	});

	it('rejects an incorrect immutable asset content type', () => {
		expect(() =>
			verifyResponseSequence([response({ contentType: 'text/html', csp: null })], {
				kind: 'asset',
				assetUrl: 'https://shop.sveltesociety.dev/_app/immutable/app.js'
			})
		).toThrow(/asset content-type/iu);
	});

	it('rejects a weakened required security policy on an immutable asset', () => {
		expect(() =>
			verifyResponseSequence(
				[
					response({
						contentType: 'application/javascript',
						csp: null,
						override: { 'strict-transport-security': 'max-age=300' }
					})
				],
				{ kind: 'asset', assetUrl: 'https://shop.sveltesociety.dev/_app/immutable/app.js' }
			)
		).toThrow(/incorrect strict-transport-security/iu);
	});

	it.each([
		'<script src=/_app/immutable/app.js></script>',
		'<div data-src="/_app/immutable/app.js"></div>',
		'<p>src="/_app/immutable/app.js"</p>',
		'<script src="https://cdn.example/_app/immutable/app.js"></script>',
		'<script src="/assets/app.js"></script>',
		'<img src="/_app/immutable/image.png">'
	])('rejects invalid immutable asset discovery from %s', (html) => {
		expect(() => discoverImmutableAsset(html, 'https://shop.sveltesociety.dev/')).toThrow(
			/immutable asset/iu
		);
	});

	it.each([
		[
			'<script src="/_app/immutable/app.js"></script>',
			'https://shop.sveltesociety.dev/_app/immutable/app.js'
		],
		[
			[
				'<script src=/_app/immutable/unquoted.js></script>',
				'<img src="/_app/immutable/ignored.png">',
				'<link href="/_app/immutable/app.css" rel="stylesheet">'
			].join(''),
			'https://shop.sveltesociety.dev/_app/immutable/app.css'
		]
	])('derives only a supported quoted src or href immutable asset', (html, expected) => {
		expect(discoverImmutableAsset(html, 'https://shop.sveltesociety.dev/').href).toBe(expected);
	});

	it('allows same-origin redirects and rejects cross-origin redirects', () => {
		expect(
			resolveSameOriginRedirect(
				'https://shop.sveltesociety.dev/start',
				'/final',
				'https://shop.sveltesociety.dev'
			).href
		).toBe('https://shop.sveltesociety.dev/final');
		expect(() =>
			resolveSameOriginRedirect(
				'https://shop.sveltesociety.dev/start',
				'https://example.com/final',
				'https://shop.sveltesociety.dev'
			)
		).toThrow(/cross-origin redirect/iu);
	});
});
