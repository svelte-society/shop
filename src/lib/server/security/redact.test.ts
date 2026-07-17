import { describe, expect, it } from 'vitest';
import { redact } from './redact';

describe('redact', () => {
	it('deeply redacts case-varied sensitive keys while retaining stable operational fields', () => {
		const input = {
			request_id: 'req_01JTEST',
			method: 'POST',
			pathname: '/webhooks/stripe',
			status: 500,
			duration_ms: 12,
			code: 'STRIPE_WEBHOOK_INTERNAL_ERROR',
			country_code: 'SE',
			item_count: 2,
			Authorization: 'Bearer top-secret',
			COOKIE: 'session=private',
			stripeSecret: 'sk_live_private',
			providerSignature: 't=1,v1=private',
			customerEmail: 'person@example.test',
			fullNAME: 'Private Person',
			shippingAddress: { line1: 'Private street 1' },
			PhoneNumber: '+46 70 123 45 67',
			VatId: 'SE123456789001',
			rawBody: '{"private":true}',
			providerPayload: { id: 'pi_private', status: 'paid' }
		};

		expect(redact(input)).toEqual({
			request_id: 'req_01JTEST',
			method: 'POST',
			pathname: '/webhooks/stripe',
			status: 500,
			duration_ms: 12,
			code: 'STRIPE_WEBHOOK_INTERNAL_ERROR',
			country_code: 'SE',
			item_count: 2,
			Authorization: '[REDACTED]',
			COOKIE: '[REDACTED]',
			stripeSecret: '[REDACTED]',
			providerSignature: '[REDACTED]',
			customerEmail: '[REDACTED]',
			fullNAME: '[REDACTED]',
			shippingAddress: '[REDACTED]',
			PhoneNumber: '[REDACTED]',
			VatId: '[REDACTED]',
			rawBody: '[REDACTED]',
			providerPayload: '[REDACTED]'
		});
	});

	it('redacts sensitive scalar values even when hidden under untrusted neutral keys', () => {
		expect(
			redact({
				detail: 'contact person@example.test using Bearer private-token',
				value: '+46 70 123 45 67',
				error: new Error('sk_live_private at /data/shop.sqlite')
			})
		).toEqual({
			detail: '[REDACTED]',
			value: '[REDACTED]',
			error: '[REDACTED]'
		});
	});

	it('removes withdrawal customer and transport data while retaining public case metadata', () => {
		expect(
			redact({
				reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
				status: 'reviewing',
				last_error_code: 'WITHDRAWAL_DECRYPT_FAILED',
				fullName: 'Private Customer',
				receiptEmail: 'private.customer@example.test',
				enteredOrderReference: 'PRIVATE-ORDER-42',
				items: [{ description: 'Private orange hoodie', quantity: 2 }],
				messagePreview: 'Hello Private Customer',
				cookies: 'withdrawal_receipt_session=private',
				requestBody: '{"receiptEmail":"private.customer@example.test"}'
			})
		).toEqual({
			reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
			status: 'reviewing',
			last_error_code: 'WITHDRAWAL_DECRYPT_FAILED',
			fullName: '[REDACTED]',
			receiptEmail: '[REDACTED]',
			enteredOrderReference: '[REDACTED]',
			items: '[REDACTED]',
			messagePreview: '[REDACTED]',
			cookies: '[REDACTED]',
			requestBody: '[REDACTED]'
		});
	});

	it.each(['reference', 'public_reference'])(
		'redacts a private token hidden under the public withdrawal key %s',
		(key) => {
			expect(redact({ [key]: 'private-withdrawal-token' })).toEqual({
				[key]: '[REDACTED]'
			});
		}
	);

	it('retains only exact public withdrawal reference values under withdrawal reference keys', () => {
		expect(
			redact({
				reference: 'WDR-AbCdEfGhIjKlMnOpQrSt_1',
				public_reference: 'WDR-0123456789abcdefghij-_'
			})
		).toEqual({
			reference: 'WDR-AbCdEfGhIjKlMnOpQrSt_1',
			public_reference: 'WDR-0123456789abcdefghij-_'
		});
	});

	it.each(['/customer/person%40example.test', '/customer/46701234567'])(
		'redacts personal data embedded in a pathname value %s',
		(pathname) => {
			expect(redact({ pathname })).toEqual({ pathname: '[REDACTED]' });
		}
	);

	it.each([
		'/customer/person%2540example.test',
		'/customer/person%252540example.test',
		'/customer/%42earer%2520private-token',
		'/customer/%2577hsec_private',
		'/customer/%252B46%252070%2520123%252045%252067',
		'/customer/safe%250d%250ainjected',
		'/customer/safe%25250d%25250ainjected'
	])('redacts recursively or mixed-encoded credential, PII, and control data %s', (pathname) => {
		expect(redact({ pathname })).toEqual({ pathname: '[REDACTED]' });
	});

	it('fails closed when a pathname exceeds the bounded decoding depth', () => {
		expect(redact({ pathname: '/customer/%2525252540' })).toEqual({
			pathname: '[REDACTED]'
		});
	});

	it('handles cycles, throwing getters, and hostile proxies without throwing', () => {
		const cyclic: Record<string, unknown> = { status: 'pending_review' };
		cyclic.self = cyclic;
		Object.defineProperty(cyclic, 'customerEmail', {
			enumerable: true,
			get() {
				throw new Error('private getter value');
			}
		});
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('private proxy value');
				}
			}
		);

		expect(() => redact({ payload: hostile })).not.toThrow();
		expect(redact(cyclic)).toEqual({
			status: 'pending_review',
			self: '[REDACTED]',
			customerEmail: '[REDACTED]'
		});
	});

	it('does not mutate nested or frozen input', () => {
		const nested = Object.freeze({ status: 'paid', email: 'private@example.test' });
		const input = Object.freeze({ order_id: 'ord_123', nested });

		const output = redact(input);

		expect(input.nested).toBe(nested);
		expect(input.nested.email).toBe('private@example.test');
		expect(output).not.toBe(input);
		expect(output).toEqual({
			order_id: 'ord_123',
			nested: { status: 'paid', email: '[REDACTED]' }
		});
	});
});
