import { describe, expect, it } from 'vitest';
import type { WithdrawalInspection } from './receipt.server';
import {
	WITHDRAWAL_LEGAL_STATUS_COPY,
	withdrawalMessage,
	type WithdrawalMessageContentInput
} from './messages.server';

const inspection: WithdrawalInspection = {
	id: 'case_123',
	reference: 'WDR-AAAAAAAAAAAAAAAAAAAAAA',
	status: 'submitted',
	revision: 1,
	scope: 'specific_items',
	eligibility: 'pending',
	outcomeCode: null,
	createdAt: new Date('2026-07-17T08:30:00.000Z'),
	updatedAt: new Date('2026-07-17T08:30:00.000Z'),
	reconciledAt: null,
	closedAt: null,
	piiPurgeDueAt: null,
	purgedAt: null,
	payload: {
		fullName: 'Customer <script>&',
		receiptEmail: 'customer@example.com',
		enteredOrderReference: 'ORDER-<42>&',
		items: [{ description: 'Orange <hoodie> & cap', quantity: 2 }],
		reconciliation: {
			internalOrderReference: 'ord_private',
			countryCode: 'SE',
			customerInstructions: 'Send to Return & Co <Dock 2>.',
			returnOutcome: null,
			parcelReference: null
		}
	}
};

const base = {
	inspection,
	supportEmail: 'merch@sveltesociety.dev',
	productionOrigin: new URL('https://merch.sveltesociety.dev'),
	seller: {
		legalName: 'Seller <AB> & Co',
		registrationNumber: 'SE-<123>',
		addressLine1: 'Registered & Street <1>',
		postalCode: '123 45',
		city: 'Stockholm',
		country: 'Sweden',
		email: 'seller@example.com'
	}
} satisfies Omit<WithdrawalMessageContentInput, 'kind' | 'originalKind'>;

describe('withdrawalMessage', () => {
	it('builds a receipt that confirms submission without claiming approval or a refund', () => {
		const message = withdrawalMessage({ ...base, kind: 'receipt' });

		expect(message.to).toBe('customer@example.com');
		expect(message.subject).toBe('Withdrawal notice received — WDR-AAAAAAAAAAAAAAAAAAAAAA');
		expect(message.text).toContain('This receipt confirms submission only.');
		expect(message.text).toContain('It is not an approval and does not confirm or start a refund.');
		expect(message.text).not.toContain('Your withdrawal is approved');
		expect(message.text).not.toContain('Your refund has started');
	});

	it('builds eligible instructions with the required registered-address warning', () => {
		const message = withdrawalMessage({ ...base, kind: 'eligible_instructions' });

		expect(message.text).toContain(WITHDRAWAL_LEGAL_STATUS_COPY.eligible_instructions);
		expect(WITHDRAWAL_LEGAL_STATUS_COPY.eligible_instructions).toBe(
			"Your withdrawal is eligible for the EU change-of-mind process. Follow the return instructions below. Do not send the parcel to the seller's registered address unless the instructions say so."
		);
		expect(message.text).toContain('Send to Return & Co <Dock 2>.');
	});

	it('uses the approved non-EU decision and support address exactly', () => {
		const message = withdrawalMessage({ ...base, kind: 'ineligible_decision' });

		expect(WITHDRAWAL_LEGAL_STATUS_COPY.ineligible_decision).toBe(
			'This order is not eligible for a change-of-mind return. Damaged or incorrect-item support remains available at merch@sveltesociety.dev.'
		);
		expect(message.text).toContain(WITHDRAWAL_LEGAL_STATUS_COPY.ineligible_decision);
		expect(message.text.match(/merch@sveltesociety\.dev/g)).toHaveLength(1);
	});

	it('builds a support handoff without characterizing it as a voluntary return', () => {
		const message = withdrawalMessage({ ...base, kind: 'support_handoff' });

		expect(message.text).toContain(WITHDRAWAL_LEGAL_STATUS_COPY.support_handoff);
		expect(message.text).toContain('merch@sveltesociety.dev');
		expect(message.text).not.toContain('eligible for the EU change-of-mind process');
	});

	it.each(['receipt', 'eligible_instructions', 'ineligible_decision', 'support_handoff'] as const)(
		'renders a resend using its original %s copy',
		(originalKind) => {
			const original = withdrawalMessage({ ...base, kind: originalKind });
			const resend = withdrawalMessage({ ...base, kind: 'resend', originalKind });

			expect(resend).toEqual(original);
		}
	);

	it('escapes every customer and seller string in paragraph HTML and keeps destination/body ephemeral', () => {
		const message = withdrawalMessage({ ...base, kind: 'eligible_instructions' });

		expect(message.html).toContain('Customer &lt;script&gt;&amp;');
		expect(message.html).toContain('ORDER-&lt;42&gt;&amp;');
		expect(message.html).toContain('Orange &lt;hoodie&gt; &amp; cap');
		expect(message.html).toContain('Return &amp; Co &lt;Dock 2&gt;.');
		expect(message.html).not.toContain('<script>');
		expect(Object.keys(message).sort()).toEqual(['html', 'subject', 'text', 'to']);
	});
});
