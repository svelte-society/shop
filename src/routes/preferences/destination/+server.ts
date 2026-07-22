import { dev } from '$app/environment';
import type { RequestHandler } from './$types';
import { isSupportedDestination } from '$lib/domain/destinations';
import { readBoundedFormData } from '$lib/server/security/bounded-form.server';
import { DESTINATION_COOKIE } from '$lib/server/storefront/destination.server';

const FORM_LIMIT_BYTES = 4_096;
const COOKIE_MAX_AGE_SECONDS = 31_536_000;

function safeReturnPath(value: string): string | null {
	if (
		value.length < 1 ||
		value.length > 2_048 ||
		!value.startsWith('/') ||
		value.startsWith('//')
	) {
		return null;
	}
	const parsed = new URL(value, 'https://shop.invalid');
	return parsed.origin === 'https://shop.invalid'
		? `${parsed.pathname}${parsed.search}${parsed.hash}`
		: null;
}

function strictFields(data: FormData): { country: string; returnTo: string } | null {
	const entries = [...data.entries()];
	if (entries.length !== 2) return null;
	const country = data.getAll('country');
	const returnTo = data.getAll('returnTo');
	if (
		country.length !== 1 ||
		returnTo.length !== 1 ||
		typeof country[0] !== 'string' ||
		typeof returnTo[0] !== 'string'
	) {
		return null;
	}
	return { country: country[0], returnTo: returnTo[0] };
}

export function _createDestinationPreferencePost(secure = !dev): RequestHandler {
	return async ({ request, cookies }) => {
		let data: FormData;
		try {
			data = await readBoundedFormData(request, FORM_LIMIT_BYTES);
		} catch {
			return new Response(null, { status: 400 });
		}

		const fields = strictFields(data);
		if (!fields || !/^[A-Z]{2}$/u.test(fields.country)) {
			return new Response(null, { status: 400 });
		}

		if (!isSupportedDestination(fields.country)) {
			return new Response(null, { status: 400 });
		}

		const returnTo = safeReturnPath(fields.returnTo);
		if (!returnTo) return new Response(null, { status: 400 });

		cookies.set(DESTINATION_COOKIE, fields.country, {
			path: '/',
			maxAge: COOKIE_MAX_AGE_SECONDS,
			httpOnly: true,
			sameSite: 'lax',
			secure
		});
		return new Response(null, { status: 303, headers: { location: returnTo } });
	};
}

export const POST: RequestHandler = _createDestinationPreferencePost();
