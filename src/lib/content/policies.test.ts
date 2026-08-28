import { describe, expect, it } from 'vitest';
import { createPolicyDocuments, type PolicyDocument } from './policies';

function text(document: PolicyDocument): string {
	return [
		document.title,
		document.summary,
		document.effectiveDate,
		...document.sections.flatMap((section) => [
			section.heading,
			...section.paragraphs,
			...(section.links ?? []).flatMap((link) => [link.label, link.href])
		])
	].join('\n');
}

describe('source-controlled policy documents', () => {
	it('uses plain text and explicit links rather than HTML strings', () => {
		const documents = createPolicyDocuments();

		for (const [key, document] of Object.entries(documents)) {
			expect(document.summary).toEqual(expect.any(String));
			expect(document.summary.length).toBeGreaterThan(20);
			expect(document.effectiveDate).toBe(key === 'about' ? undefined : '2026-07-19');
			expect(document.sections.length).toBeGreaterThan(0);
			for (const section of document.sections) {
				expect(section.heading).not.toMatch(/[<>]/u);
				expect(section.paragraphs.every((paragraph) => typeof paragraph === 'string')).toBe(true);
				expect(section.paragraphs.join('\n')).not.toMatch(/<\/?[a-z][^>]*>/iu);
				for (const link of section.links ?? []) {
					expect(link).toEqual({ label: expect.any(String), href: expect.any(String) });
					expect(link.href).toMatch(/^(?:https:\/\/|mailto:|\/)/u);
				}
			}
		}
	});

	it('publishes provider-owned shipping rules without a fixed public price promise', () => {
		const shipping = text(createPolicyDocuments().shipping);

		expect(shipping).toContain('Where we deliver, what shipping costs');
		expect(shipping).toContain('EUR');
		expect(shipping).toContain('European Union except Slovenia');
		expect(shipping).toContain('Great Britain');
		expect(shipping).toContain('Asian countries available in the delivery-country picker');
		expect(shipping).not.toContain('United States');
		expect(shipping).toContain('selected delivery country');
		expect(shipping).toContain('Shipping for one item is shown in your cart');
		expect(shipping).not.toMatch(/EUR\s+\d/u);
		expect(shipping).toContain('two or more items');
		expect(shipping).toContain('Estimated delivery: usually 5–7 business days');
		expect(shipping).toContain('Great Britain: 4–6 working days.');
		expect(shipping).toContain(
			'Supported Asian destinations: Production normally takes 1–5 business days'
		);
		expect(shipping).toContain('followed by roughly 6–10 business days in transit');
		expect(shipping).toContain('final amount is confirmed at checkout');
		expect(shipping).toContain('customs duties, brokerage fees, or carrier charges');
		expect(shipping).toContain('estimates, not guarantees');
		expect(shipping).not.toMatch(/tax projection|total units|fulfillment partner/iu);
	});

	it('keeps the terms aligned with provider-owned shipping and destination pricing', () => {
		const terms = text(createPolicyDocuments().terms);

		expect(terms).toContain('selected delivery country');
		expect(terms).toContain('Shipping for one item is shown in your cart');
		expect(terms).toContain('free when you order two or more items');
		expect(terms).not.toMatch(/Shipping (?:costs|is) EUR\s+\d/u);
		expect(terms).not.toMatch(/tax projection|total units|manual review|SQLite/iu);
	});

	it('publishes approval-first returns instructions without inventing a merchandise exclusion', () => {
		const returns = text(createPolicyDocuments().returns);

		expect(returns).toContain('How to request a return, who pays postage');
		expect(returns).toContain('Before sending anything back');
		expect(returns).toContain('You may still notify us by any other clear statement');
		expect(returns).toContain('14 days');
		expect(returns).toContain('Model withdrawal notice');
		expect(
			createPolicyDocuments().returns.sections.flatMap((section) => section.links ?? [])
		).toContainEqual({ label: 'Use the withdrawal form', href: '/withdraw' });
		expect(returns).toContain('Ordered on');
		expect(returns).toContain('Received on');
		expect(returns).toContain('Name of consumer');
		expect(returns).toContain('Address of consumer');
		expect(returns).toContain('Damaged or incorrect item');
		expect(returns).toContain('we pay the necessary return postage');
		expect(returns).toContain('You pay the direct return postage');
		expect(returns).not.toContain('merchandise-specific exclusion');
		expect(returns).not.toContain('processed manually');
		expect(returns).toContain('outside the EU');
		expect(returns).toContain('do not offer returns or exchanges for change of mind');
		expect(returns).toContain('faulty, damaged, incorrect, or misdescribed goods');
	});

	it('describes the actual privacy services, local minimization, retention, bases, transfers, and rights', () => {
		const privacy = text(createPolicyDocuments().privacy);

		for (const expected of [
			'Stripe',
			'production partner',
			'Resend',
			'delivery carriers',
			'self-hosted analytics',
			'technical logs',
			'encrypted backups',
			'contract',
			'legal obligations',
			'legitimate interests',
			'outside the EU/EEA',
			'access',
			'correction',
			'erasure',
			'restriction',
			'object',
			'portability',
			'merch@sveltesociety.dev'
		]) {
			expect(privacy).toContain(expected);
		}
		expect(privacy).not.toMatch(/Plunk/iu);
		expect(privacy).not.toMatch(/Styria/iu);
		expect(privacy).not.toMatch(/Umami/iu);
		expect(privacy).toContain(
			'We do not keep your name, postal address, phone number, VAT number, or payment details in the shop’s own database'
		);
		expect(privacy).toContain('Encrypted backups are kept for up to 30 days');
		expect(privacy).toContain('details submitted through the withdrawal form');
		expect(privacy).toContain('90 days after closure');
		expect(privacy).not.toMatch(
			/SQLite|S3-compatible|route templates|stable error codes|local operational state|allowlisted/iu
		);
		const services = createPolicyDocuments().privacy.sections.find(
			(section) => section.heading === 'Who receives your data'
		);
		expect(new Set(services?.paragraphs).size).toBe(services?.paragraphs.length);
	});

	it('renders the reviewed source-owned delivery estimates with clean sentence endings', () => {
		const shipping = text(createPolicyDocuments().shipping);

		expect(shipping).toContain(
			'European Union: Estimated delivery: usually 5–7 business days. Delivery times are estimates and aren’t guaranteed.'
		);
		expect(shipping).toContain(
			'Supported Asian destinations: Production normally takes 1–5 business days, followed by roughly 6–10 business days in transit.'
		);
		expect(shipping).not.toContain('..');
	});

	it('identifies the configured seller and states the scoped commercial terms', () => {
		const termsDocument = createPolicyDocuments().terms;
		const terms = text(termsDocument);

		for (const expected of [
			'Svelte Summit AB',
			'559490-8336',
			'SE559490833601',
			'Hummelhaga 13',
			'153 95 Järna',
			'merch@sveltesociety.dev',
			'apparel and accessories',
			'EUR',
			'VAT',
			'Stripe',
			'receipt',
			'invoice',
			'European Union except Slovenia',
			'Great Britain',
			'selected destinations across Asia',
			'prepare your order for production',
			'merch@sveltesociety.dev',
			'mandatory consumer rights'
		]) {
			expect(terms).toContain(expected);
		}
		expect(terms).not.toMatch(/Styria/iu);
		expect(terms).not.toContain('United States');
		expect(
			termsDocument.sections.find((section) => section.heading === 'Returns and order problems')
				?.paragraphs
		).toContain(
			'Eligible EU consumers can notify us of withdrawal within the legal deadline. After notifying us, send the goods to the return address we provide in Sweden within 14 days. You pay the direct return postage, and we recommend tracked shipping. Contact us first for the complete return instructions. You may still notify us by any other clear statement.'
		);
		expect(terms).not.toContain('24-hour');
	});

	it('keeps About short and makes no funding claim', () => {
		const about = createPolicyDocuments().about;
		const aboutText = text(about);

		expect(aboutText).toContain('Official Svelte Society merchandise, made for the community');
		expect(aboutText).toContain('wear the Svelte mark');
		expect(aboutText.toLowerCase()).not.toContain('fund');
		expect(about.effectiveDate).toBeUndefined();
		expect(about.sections).toHaveLength(1);
		expect(about.sections[0].paragraphs).toHaveLength(1);
	});
});
