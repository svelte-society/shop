import { describe, expect, it, vi } from 'vitest';
import type { PlunkGateway, PlunkSendInput } from './gateway';
import {
	createShippingEmailSender,
	shippingEmailMessage,
	type ShippingEmailInput
} from './shipping-email';

const input: ShippingEmailInput = {
	recipientEmail: 'ada@example.test',
	productSummary: '2 × Community Tee (M)',
	trackingNumber: 'TRACK-2042',
	supportEmail: 'merch@sveltesociety.dev'
};
const from = { name: 'Svelte Society Shop', email: 'merch@sveltesociety.dev' };

describe('shipping email', () => {
	it('builds the exact clear customer message from the verified sender with support reply-to', () => {
		expect(shippingEmailMessage(input, from, 'https://shop.sveltesociety.dev')).toEqual({
			to: 'ada@example.test',
			from,
			replyTo: 'merch@sveltesociety.dev',
			subject: 'Your Svelte Society order is on the way',
			html:
				'<p>Your Svelte Society merch has shipped.</p>' +
				'<p>2 × Community Tee (M)</p>' +
				'<p>Tracking: TRACK-2042</p>' +
				'<p>Thanks for being part of the Svelte community.</p>' +
				'<p><a href="https://shop.sveltesociety.dev/withdraw">Withdraw from this purchase</a>.</p>' +
				'<p>Questions? Email merch@sveltesociety.dev.</p>'
		});
	});

	it('escapes message fields and never forwards unrelated address, phone, or VAT input', () => {
		const unsafe = {
			...input,
			productSummary: '<script>Community & Tee</script>',
			trackingNumber: 'TRACK-<2042>',
			address: 'Currentgatan 9',
			phone: '+46 70 123 45 67',
			vatId: 'SE123456789001'
		} as ShippingEmailInput & Record<string, string>;

		const message = shippingEmailMessage(unsafe, from, 'https://shop.sveltesociety.dev');

		expect(message.html).toContain('&lt;script&gt;Community &amp; Tee&lt;/script&gt;');
		expect(message.html).toContain('TRACK-&lt;2042&gt;');
		expect(JSON.stringify(message)).not.toContain('Currentgatan');
		expect(JSON.stringify(message)).not.toContain('+46 70');
		expect(JSON.stringify(message)).not.toContain('SE123456789001');
		expect(message.html).not.toContain('ORDER-2042');
	});

	it('returns the Plunk provider delivery ID only after the provider accepts the message', async () => {
		const send = vi.fn(async (message: PlunkSendInput) => {
			expect(message.subject).toBe('Your Svelte Society order is on the way');
			return { deliveryId: 'plunk_delivery_2042' };
		});
		const sender = createShippingEmailSender(
			{ send } satisfies PlunkGateway,
			from,
			'https://shop.sveltesociety.dev'
		);

		await expect(sender.send(input)).resolves.toEqual({ deliveryId: 'plunk_delivery_2042' });
		expect(send).toHaveBeenCalledWith(
			shippingEmailMessage(input, from, 'https://shop.sveltesociety.dev')
		);
	});
});
