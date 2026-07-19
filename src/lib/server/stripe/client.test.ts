import { describe, expect, it, vi } from 'vitest';
import { createStripeFulfillmentGateway, type StripeFulfillmentClient } from './client.server';

function sessionFixture() {
	return {
		id: 'cs_test_fulfillment',
		object: 'checkout.session',
		customer_details: {
			business_name: 'Analytical Engines AB',
			individual_name: 'Ada Lovelace'
		},
		customer: {
			id: 'cus_test_fulfillment',
			object: 'customer',
			business_name: 'Analytical Engines AB',
			email: 'ada@example.test',
			name: 'Ada Lovelace',
			phone: '+46 70 123 45 67',
			shipping: {
				name: 'Ada Lovelace',
				phone: '+46 70 123 45 67',
				address: {
					line1: 'Sveltegatan 5',
					line2: 'Suite 3',
					city: 'Stockholm',
					state: 'Stockholm',
					postal_code: '111 22',
					country: 'SE'
				}
			}
		}
	};
}

class ContractStripeClient implements StripeFulfillmentClient {
	readonly calls: Array<{ id: string; params: unknown; options: unknown }> = [];
	failure: unknown;

	constructor(readonly session: ReturnType<typeof sessionFixture>) {}

	readonly checkout = {
		sessions: {
			retrieve: async (id: string, params?: unknown, options?: unknown): Promise<unknown> => {
				this.calls.push({
					id,
					params: structuredClone(params),
					options: structuredClone(options)
				});
				if (this.failure !== undefined) throw this.failure;
				return structuredClone(this.session);
			}
		}
	};
}

async function expectStableCode(promise: Promise<unknown>, code: string): Promise<void> {
	await expect(promise).rejects.toMatchObject({
		name: 'StripeFulfillmentError',
		message: code,
		code
	});
}

describe('Stripe fulfillment details', () => {
	it('rejects a current address omitted from the injected Styria allowlist', async () => {
		const session = sessionFixture();
		session.customer.shipping.address.country = 'JP';

		await expectStableCode(
			createStripeFulfillmentGateway(new ContractStripeClient(session), [
				'SE'
			]).retrieveFulfillmentDetails('cs_test_fulfillment'),
			'STRIPE_FULFILLMENT_DESTINATION_UNSUPPORTED'
		);
	});

	it('retrieves the complete current customer and shipping details transiently', async () => {
		const client = new ContractStripeClient(sessionFixture());

		await expect(
			createStripeFulfillmentGateway(client).retrieveFulfillmentDetails('cs_test_fulfillment')
		).resolves.toEqual({
			recipient: {
				firstName: 'Ada',
				lastName: 'Lovelace',
				company: 'Analytical Engines AB',
				phone: '+46 70 123 45 67'
			},
			address: {
				line1: 'Sveltegatan 5',
				line2: 'Suite 3',
				city: 'Stockholm',
				state: 'Stockholm',
				postalCode: '111 22',
				countryCode: 'SE'
			},
			email: 'ada@example.test'
		});
		expect(client.calls).toEqual([
			{ id: 'cs_test_fulfillment', params: { expand: ['customer'] }, options: undefined }
		]);
	});

	it('uses the current Customer phone when the optional shipping phone is absent', async () => {
		const session = sessionFixture();
		session.customer.shipping.phone = null as unknown as string;

		await expect(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			)
		).resolves.toMatchObject({ recipient: { phone: '+46 70 123 45 67' } });
	});

	it('uses the legacy shipping phone when the current Customer phone is absent', async () => {
		const session = sessionFixture();
		session.customer.phone = null as unknown as string;

		await expect(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			)
		).resolves.toMatchObject({ recipient: { phone: '+46 70 123 45 67' } });
	});

	it('uses a shutdown-safe five-second no-retry request when given a scheduler signal', async () => {
		const client = new ContractStripeClient(sessionFixture());
		const signal = new AbortController().signal;

		await createStripeFulfillmentGateway(client).retrieveFulfillmentDetails(
			'cs_test_fulfillment',
			signal
		);

		expect(client.calls[0]).toEqual({
			id: 'cs_test_fulfillment',
			params: { expand: ['customer'] },
			options: { maxNetworkRetries: 0, timeout: 5_000 }
		});
	});

	it('normalizes absent optional company, address line two, and non-US state', async () => {
		const session = sessionFixture();
		session.customer.business_name = null as unknown as string;
		session.customer.shipping.address.line2 = null as unknown as string;
		session.customer.shipping.address.state = null as unknown as string;

		await expect(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			)
		).resolves.toMatchObject({
			recipient: { company: '' },
			address: { line2: '', state: '' }
		});
	});

	it('normalizes empty optional company, address line two, and non-US state', async () => {
		const session = sessionFixture();
		session.customer.business_name = '';
		session.customer.shipping.address.line2 = '';
		session.customer.shipping.address.state = '';

		await expect(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			)
		).resolves.toMatchObject({
			recipient: { company: '' },
			address: { line2: '', state: '' }
		});
	});

	it('accepts single-character first and last name tokens', async () => {
		const session = sessionFixture();
		session.customer.shipping.name = 'A B';

		await expect(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			)
		).resolves.toMatchObject({ recipient: { firstName: 'A', lastName: 'B' } });
	});

	it.each([
		['email', (session: ReturnType<typeof sessionFixture>) => (session.customer.email = '')],
		[
			'recipient name',
			(session: ReturnType<typeof sessionFixture>) => (session.customer.shipping.name = 'Ada')
		],
		[
			'phone',
			(session: ReturnType<typeof sessionFixture>) => {
				session.customer.phone = '';
				session.customer.shipping.phone = '';
			}
		],
		[
			'address line',
			(session: ReturnType<typeof sessionFixture>) => (session.customer.shipping.address.line1 = '')
		],
		[
			'city',
			(session: ReturnType<typeof sessionFixture>) => (session.customer.shipping.address.city = '')
		],
		[
			'postcode',
			(session: ReturnType<typeof sessionFixture>) =>
				(session.customer.shipping.address.postal_code = '')
		],
		[
			'US state',
			(session: ReturnType<typeof sessionFixture>) => {
				session.customer.shipping.address.country = 'US';
				session.customer.shipping.address.state = '';
			}
		]
	])('rejects a missing %s with a stable error', async (_label, mutate) => {
		const session = sessionFixture();
		mutate(session);

		await expectStableCode(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			),
			'STRIPE_FULFILLMENT_DETAILS_INVALID'
		);
	});

	it('rejects conflicting current and legacy phone values with a stable error', async () => {
		const session = sessionFixture();
		session.customer.shipping.phone = '+46 70 999 99 99';

		await expectStableCode(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			),
			'STRIPE_FULFILLMENT_DETAILS_INVALID'
		);
	});

	it('rejects an unsupported destination with a stable error', async () => {
		const session = sessionFixture();
		session.customer.shipping.address.country = 'GB';

		await expectStableCode(
			createStripeFulfillmentGateway(new ContractStripeClient(session)).retrieveFulfillmentDetails(
				'cs_test_fulfillment'
			),
			'STRIPE_FULFILLMENT_DESTINATION_UNSUPPORTED'
		);
	});

	it('redacts provider failures and does not log customer data', async () => {
		const client = new ContractStripeClient(sessionFixture());
		client.failure = new Error('ada@example.test Sveltegatan 5 raw Stripe response');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		try {
			const operation =
				createStripeFulfillmentGateway(client).retrieveFulfillmentDetails('cs_test_fulfillment');
			await expectStableCode(operation, 'STRIPE_FULFILLMENT_RETRIEVAL_FAILED');
			await expect(operation).rejects.not.toThrow(/ada@example|Sveltegatan|raw Stripe/);
			expect(consoleError).not.toHaveBeenCalled();
			expect(consoleLog).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
			consoleLog.mockRestore();
		}
	});

	it('rejects an invalid current Customer business name with a stable redacted error', async () => {
		const session = sessionFixture();
		session.customer.business_name = 'Private Company AB\nraw Stripe field';
		const operation = createStripeFulfillmentGateway(
			new ContractStripeClient(session)
		).retrieveFulfillmentDetails('cs_test_fulfillment');

		await expectStableCode(operation, 'STRIPE_FULFILLMENT_DETAILS_INVALID');
		await expect(operation).rejects.not.toThrow(/Private Company|raw Stripe/);
	});

	it('re-reads current Customer business name while the Session snapshot remains stale', async () => {
		const session = sessionFixture();
		const client = new ContractStripeClient(session);
		const gateway = createStripeFulfillmentGateway(client);

		const first = await gateway.retrieveFulfillmentDetails('cs_test_fulfillment');
		session.customer.business_name = 'Current Engines AB';
		const second = await gateway.retrieveFulfillmentDetails('cs_test_fulfillment');

		expect(session.customer_details.business_name).toBe('Analytical Engines AB');
		expect(first.recipient.company).toBe('Analytical Engines AB');
		expect(second.recipient.company).toBe('Current Engines AB');
		expect(client.calls).toHaveLength(2);
	});

	it('retrieves Stripe again for every action and retains no cached fulfillment response', async () => {
		const session = sessionFixture();
		const client = new ContractStripeClient(session);
		const gateway = createStripeFulfillmentGateway(client);

		const first = await gateway.retrieveFulfillmentDetails('cs_test_fulfillment');
		session.customer.shipping.address.line1 = 'Currentgatan 9';
		const second = await gateway.retrieveFulfillmentDetails('cs_test_fulfillment');

		expect(first.address.line1).toBe('Sveltegatan 5');
		expect(second.address.line1).toBe('Currentgatan 9');
		expect(client.calls).toHaveLength(2);
	});
});
