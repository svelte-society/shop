import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{ statusCode: number, rawHeaders: string[] }} ResponseRecord
 * @typedef {{ kind: 'html' } | { kind: 'asset', assetUrl: string | URL }} VerificationOptions
 * @typedef {{
 *   connectTimeoutMs: number,
 *   responseTimeoutMs: number,
 *   maxBodyBytes: number,
 *   maxRedirects: number
 * }} RequestOptions
 * @typedef {{ responses: ResponseRecord[], body: string }} RequestResult
 * @typedef {RequestResult & { url: URL }} FinalRequestResult
 */

export const EXPECTED_SECURITY_HEADERS = Object.freeze({
	'strict-transport-security': 'max-age=31536000; includeSubDomains',
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy':
		'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()'
});

const acceptedAssetTypes = Object.freeze({
	'.js': Object.freeze(['application/javascript', 'text/javascript']),
	'.mjs': Object.freeze(['application/javascript', 'text/javascript']),
	'.css': Object.freeze(['text/css']),
	'.woff': Object.freeze(['font/woff']),
	'.woff2': Object.freeze(['font/woff2']),
	'.ttf': Object.freeze(['font/ttf']),
	'.otf': Object.freeze(['font/otf'])
});

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const defaultRequestOptions = Object.freeze({
	connectTimeoutMs: 5_000,
	responseTimeoutMs: 20_000,
	maxBodyBytes: 2 * 1024 * 1024,
	maxRedirects: 5
});

/** @param {string} message */
function error(message) {
	return new Error(`PUBLIC_SECURITY_VERIFICATION_FAILED: ${message}`);
}

/** @param {ResponseRecord} response */
function normalizedRawHeaders(response) {
	if (!Array.isArray(response.rawHeaders) || response.rawHeaders.length % 2 !== 0) {
		throw error('invalid raw headers');
	}
	return response.rawHeaders;
}

/**
 * @param {ResponseRecord} response
 * @param {string} wanted
 * @returns {string}
 */
function singleRawHeader(response, wanted) {
	const rawHeaders = normalizedRawHeaders(response);
	const values = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		const name = rawHeaders[index];
		const value = rawHeaders[index + 1];
		if (typeof name !== 'string' || typeof value !== 'string') {
			throw error('invalid raw headers');
		}
		if (name.toLowerCase() === wanted.toLowerCase()) values.push(value.trim());
	}
	if (values.length > 1) throw error(`duplicate ${wanted} header`);
	if (values.length === 0) throw error(`missing ${wanted} header`);
	return values[0];
}

/** @param {ResponseRecord} response */
function verifyExactSecurityHeaders(response) {
	for (const [name, expected] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
		const actual = singleRawHeader(response, name);
		if (actual !== expected) {
			throw error(`incorrect ${name} header`);
		}
	}
}

/**
 * @param {string} value
 * @returns {Map<string, string[]>}
 */
function parseCsp(value) {
	const directives = new Map();
	for (const section of value.split(';')) {
		const tokens = section.trim().split(/\s+/u).filter(Boolean);
		if (tokens.length === 0) continue;
		const [nameToken, ...sources] = tokens;
		const name = nameToken.toLowerCase();
		if (directives.has(name)) throw error(`duplicate HTML CSP directive ${name}`);
		directives.set(name, sources);
	}
	return directives;
}

/** @param {string[]} tokens */
function nonceTokens(tokens) {
	return tokens.filter((token) => /^'nonce-[A-Za-z0-9+/_=-]+'$/u.test(token));
}

/** @param {ResponseRecord} response */
function verifyHtmlCsp(response) {
	const value = singleRawHeader(response, 'content-security-policy');
	const directives = parseCsp(value);
	for (const tokens of directives.values()) {
		if (tokens.some((token) => token.toLowerCase() === "'unsafe-inline'")) {
			throw error('HTML CSP contains unsafe-inline');
		}
	}

	const scriptNonces = nonceTokens(directives.get('script-src') ?? []);
	const styleNonces = nonceTokens(directives.get('style-src') ?? []);
	if (scriptNonces.length !== 1) throw error('HTML CSP requires exactly one script-src nonce');
	if (styleNonces.length > 1) throw error('HTML CSP allows at most one style-src nonce');
	if (styleNonces.length === 1 && scriptNonces[0] !== styleNonces[0]) {
		throw error('HTML CSP nonce mismatch');
	}

	const frameAncestors = directives.get('frame-ancestors') ?? [];
	if (frameAncestors.length !== 1 || frameAncestors[0].toLowerCase() !== "'none'") {
		throw error('HTML CSP requires frame-ancestors none');
	}
}

/**
 * @param {string | URL} assetUrl
 * @returns {readonly string[]}
 */
export function expectedAssetContentTypes(assetUrl) {
	const url = assetUrl instanceof URL ? assetUrl : new URL(assetUrl);
	const pathname = url.pathname.toLowerCase();
	for (const [extension, contentTypes] of Object.entries(acceptedAssetTypes)) {
		if (pathname.endsWith(extension)) return contentTypes;
	}
	throw error(`unsupported immutable asset type ${url.pathname}`);
}

/**
 * @param {ResponseRecord} response
 * @param {string | URL} assetUrl
 */
function verifyAssetContentType(response, assetUrl) {
	const rawContentType = singleRawHeader(response, 'content-type');
	const mediaType = rawContentType.split(';', 1)[0].trim().toLowerCase();
	const expected = expectedAssetContentTypes(assetUrl);
	if (!expected.includes(mediaType)) throw error(`incorrect asset content-type ${rawContentType}`);
}

/**
 * @param {readonly ResponseRecord[]} responses
 * @returns {ResponseRecord}
 */
export function selectFinalResponse(responses) {
	if (!Array.isArray(responses) || responses.length === 0) {
		throw error('missing HTTP response');
	}
	const finalResponses = responses.filter(
		(response) => Number.isInteger(response?.statusCode) && response.statusCode >= 200
	);
	if (finalResponses.length !== 1) throw error('expected exactly one final HTTP response');
	return finalResponses[0];
}

/**
 * @param {readonly ResponseRecord[]} responses
 * @param {VerificationOptions} options
 * @returns {ResponseRecord}
 */
export function verifyResponseSequence(responses, options) {
	const response = selectFinalResponse(responses);
	if (response.statusCode !== 200)
		throw error(`unexpected final HTTP status ${response.statusCode}`);
	verifyExactSecurityHeaders(response);
	if (options?.kind === 'html') {
		verifyHtmlCsp(response);
	} else if (options?.kind === 'asset') {
		verifyAssetContentType(response, options.assetUrl);
	} else {
		throw error('invalid response verification kind');
	}
	return response;
}

/**
 * @param {string} html
 * @param {string | URL} pageUrl
 * @returns {URL}
 */
export function discoverImmutableAsset(html, pageUrl) {
	if (typeof html !== 'string') throw error('public HTML body is invalid');
	const page = pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
	const tagPattern = /<[A-Za-z][^<>]*>/gu;
	const attributePattern = /\s(?:src|href)\s*=\s*(["'])(\/_app\/immutable\/[^"'<>\\\s]+)\1/giu;
	for (const tag of html.matchAll(tagPattern)) {
		for (const attribute of tag[0].matchAll(attributePattern)) {
			const asset = new URL(attribute[2], page);
			if (asset.origin !== page.origin || !asset.pathname.startsWith('/_app/immutable/')) continue;
			try {
				expectedAssetContentTypes(asset);
				return asset;
			} catch {
				// Keep looking for a supported JavaScript, CSS, or font asset.
			}
		}
	}
	throw error('no supported quoted immutable asset found in public HTML');
}

/**
 * @param {string | URL} currentUrl
 * @param {string} location
 * @param {string | URL} allowedOrigin
 * @returns {URL}
 */
export function resolveSameOriginRedirect(currentUrl, location, allowedOrigin) {
	if (typeof location !== 'string' || location.length === 0 || /[\r\n]/u.test(location)) {
		throw error('redirect location is invalid');
	}
	const current = currentUrl instanceof URL ? currentUrl : new URL(currentUrl);
	const expectedOrigin = new URL(allowedOrigin).origin;
	const next = new URL(location, current);
	if (next.origin !== expectedOrigin) throw error(`cross-origin redirect to ${next.origin}`);
	if (next.protocol !== 'https:' || next.username || next.password) {
		throw error('redirect target is not safe HTTPS');
	}
	next.hash = '';
	return next;
}

/**
 * @param {string | URL} extractedAssetUrl
 * @param {string | URL} finalAssetUrl
 * @returns {URL}
 */
export function validateFinalAssetUrl(extractedAssetUrl, finalAssetUrl) {
	const extracted =
		extractedAssetUrl instanceof URL ? extractedAssetUrl : new URL(extractedAssetUrl);
	const final = finalAssetUrl instanceof URL ? finalAssetUrl : new URL(finalAssetUrl);
	if (final.origin !== extracted.origin || !final.pathname.startsWith('/_app/immutable/')) {
		throw error('final asset URL must remain on the immutable path');
	}
	const extractedTypes = expectedAssetContentTypes(extracted);
	const finalTypes = expectedAssetContentTypes(final);
	if (extractedTypes.join('\n') !== finalTypes.join('\n')) {
		throw error('final asset type differs from the extracted asset type');
	}
	return final;
}

/**
 * @param {URL} url
 * @param {RequestOptions} options
 * @returns {Promise<RequestResult>}
 */
function requestOnce(url, options) {
	return new Promise((resolve, reject) => {
		/** @type {ResponseRecord[]} */
		const responses = [];
		/** @type {Buffer[]} */
		const chunks = [];
		let receivedBytes = 0;
		let settled = false;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let responseTimer;
		const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const request = transport(url, {
			method: 'GET',
			headers: {
				accept: '*/*',
				'user-agent': 'svelte-society-public-security-verifier/1'
			}
		});

		const cleanUp = () => {
			clearTimeout(connectTimer);
			clearTimeout(responseTimer);
		};
		/** @param {unknown} cause */
		const fail = (cause) => {
			if (settled) return;
			settled = true;
			cleanUp();
			reject(cause instanceof Error ? cause : error(String(cause)));
		};
		/** @param {RequestResult} result */
		const succeed = (result) => {
			if (settled) return;
			settled = true;
			cleanUp();
			resolve(result);
		};
		const startResponseTimer = () => {
			clearTimeout(connectTimer);
			if (responseTimer) return;
			responseTimer = setTimeout(() => {
				request.destroy(error(`response timed out after ${options.responseTimeoutMs}ms`));
			}, options.responseTimeoutMs);
		};
		const connectTimer = setTimeout(() => {
			request.destroy(error(`connection timed out after ${options.connectTimeoutMs}ms`));
		}, options.connectTimeoutMs);

		request.once('socket', (socket) => {
			if (!socket.connecting) {
				startResponseTimer();
				return;
			}
			socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', startResponseTimer);
		});
		request.on('information', (information) => {
			responses.push({
				statusCode: information.statusCode,
				rawHeaders: information.rawHeaders ?? []
			});
		});
		request.once('response', (response) => {
			startResponseTimer();
			responses.push({ statusCode: response.statusCode ?? 0, rawHeaders: response.rawHeaders });
			response.on(
				'data',
				/** @param {Buffer} chunk */ (chunk) => {
					receivedBytes += chunk.length;
					if (receivedBytes > options.maxBodyBytes) {
						response.destroy(error(`response exceeded ${options.maxBodyBytes} bytes`));
						return;
					}
					chunks.push(chunk);
				}
			);
			response.once('error', fail);
			response.once('end', () => {
				succeed({
					responses,
					body: Buffer.concat(chunks).toString('utf8')
				});
			});
		});
		request.once('error', fail);
		request.end();
	});
}

/**
 * @param {string | URL} startUrl
 * @param {Partial<RequestOptions>} [requestOptions]
 * @returns {Promise<FinalRequestResult>}
 */
export async function requestFinalResponse(startUrl, requestOptions = {}) {
	const options = { ...defaultRequestOptions, ...requestOptions };
	let current = startUrl instanceof URL ? new URL(startUrl) : new URL(startUrl);
	const allowedOrigin = current.origin;
	for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount += 1) {
		const result = await requestOnce(current, options);
		const response = selectFinalResponse(result.responses);
		if (!redirectStatuses.has(response.statusCode)) return { ...result, url: current };
		if (redirectCount === options.maxRedirects) throw error('too many redirects');
		const location = singleRawHeader(response, 'location');
		current = resolveSameOriginRedirect(current, location, allowedOrigin);
	}
	throw error('too many redirects');
}

/**
 * @param {string | URL} origin
 * @param {Partial<RequestOptions>} [requestOptions]
 * @returns {Promise<{ htmlUrl: URL, assetUrl: URL }>}
 */
export async function verifyPublicSecurityHeaders(origin, requestOptions = {}) {
	const publicOrigin = new URL(origin);
	if (
		publicOrigin.protocol !== 'https:' ||
		publicOrigin.username ||
		publicOrigin.password ||
		publicOrigin.pathname !== '/' ||
		publicOrigin.search ||
		publicOrigin.hash
	) {
		throw error('origin must be an exact HTTPS origin');
	}

	const htmlResult = await requestFinalResponse(publicOrigin, requestOptions);
	verifyResponseSequence(htmlResult.responses, { kind: 'html' });
	const assetUrl = discoverImmutableAsset(htmlResult.body, htmlResult.url);
	const assetResult = await requestFinalResponse(assetUrl, requestOptions);
	validateFinalAssetUrl(assetUrl, assetResult.url);
	verifyResponseSequence(assetResult.responses, { kind: 'asset', assetUrl });
	return { htmlUrl: htmlResult.url, assetUrl: assetResult.url };
}

async function main() {
	if (process.argv.length !== 3) {
		throw error('usage: node scripts/verify-public-security-headers.mjs <https-origin>');
	}
	const result = await verifyPublicSecurityHeaders(process.argv[2]);
	process.stdout.write(`Verified public security headers for ${result.htmlUrl.origin}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((cause) => {
		console.error(cause instanceof Error ? cause.message : String(cause));
		process.exitCode = 1;
	});
}
