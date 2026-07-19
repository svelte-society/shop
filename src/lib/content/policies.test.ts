import { describe, expect, it } from 'vitest';
import { createPolicyDocuments, type PolicyDocument } from './policies';

const config = {
	sellerLegalName: 'Svelte School AB',
	sellerRegistrationNumber: 'reviewed-registration',
	sellerVatNumber: 'reviewed-vat-number',
	sellerAddressLine1: 'Reviewed street 1',
	sellerPostalCode: '123 45',
	sellerCity: 'Reviewed city',
	sellerCountry: 'Sweden',
	sellerEmail: 'merchant@example.com',
	supportEmail: 'merch@sveltesociety.dev',
	deliveryEstimateEu: 'Reviewed EU estimate',
	deliveryEstimateAsia: 'Reviewed Asia estimate',
	policyEffectiveDate: '2026-07-17'
};

function text(document: PolicyDocument): string {
	return [
		document.title,
		document.effectiveDate,
		...document.sections.flatMap((section) => [
			section.heading,
			...section.paragraphs,
			...(section.links ?? []).flatMap((link) => [link.label, link.href])
		])
	].join('\n');
}

describe('configured policy documents', () => {
	it('uses plain text and explicit links rather than HTML strings', () => {
		const documents = createPolicyDocuments(config);

		for (const document of Object.values(documents)) {
			expect(document.effectiveDate).toBe('2026-07-17');
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

	it('publishes the configured shipping regions, rates, estimates, and non-EU import notice', () => {
		const shipping = text(createPolicyDocuments(config).shipping);

		expect(shipping).toContain('EUR');
		expect(shipping).toContain('European Union except Slovenia');
		expect(shipping).toContain('selected destinations across Asia');
		expect(shipping).not.toContain('United States');
		expect(shipping).toContain('EUR 10');
		expect(shipping).toContain('one total unit');
		expect(shipping).toContain('two or more total units');
		expect(shipping).toContain('Reviewed EU estimate');
		expect(shipping).toContain('Reviewed Asia estimate');
		expect(shipping).toContain('Final tax is calculated at checkout');
		expect(shipping).toContain('customs duties, brokerage fees, or carrier charges');
		expect(shipping).toContain('not guaranteed delivery dates');
	});

	it('publishes approval-first returns instructions without inventing a merchandise exclusion', () => {
		const returns = text(createPolicyDocuments(config).returns);

		expect(returns).toContain('Contact merch@sveltesociety.dev before sending anything back');
		expect(returns).toContain('does not limit your statutory right');
		expect(returns).toContain('14 days');
		expect(returns).toContain('Model withdrawal notice');
		expect(
			createPolicyDocuments(config).returns.sections.flatMap((section) => section.links ?? [])
		).toContainEqual({ label: 'Submit a withdrawal notice', href: '/withdraw' });
		expect(returns).toContain('Ordered on');
		expect(returns).toContain('Received on');
		expect(returns).toContain('Name of consumer');
		expect(returns).toContain('Address of consumer');
		expect(returns).toContain('Damaged or incorrect item');
		expect(returns).toContain('we pay the necessary return postage');
		expect(returns).toContain('you pay the direct return postage');
		expect(returns).toContain('We currently claim no merchandise-specific exclusion');
		expect(returns).toContain('Refunds are processed manually');
		expect(returns).toContain('outside the EU');
		expect(returns).toContain('no voluntary returns or exchanges for change of mind');
		expect(returns).toContain('faulty, damaged, incorrect, or misdescribed goods');
	});

	it('describes the actual privacy services, local minimization, retention, bases, transfers, and rights', () => {
		const privacy = text(createPolicyDocuments(config).privacy);

		for (const expected of [
			'Stripe',
			'Styria',
			'Plunk',
			'shipping carriers',
			'Umami',
			'structured logs',
			'local operational state',
			'S3-compatible backups',
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
		expect(privacy).toContain(
			'SQLite does not store customer names, postal addresses, phone numbers, VAT numbers, or payment-method data'
		);
		expect(privacy).toContain('Encrypted backups roll off after 30 days');
		expect(privacy).toContain('withdrawal case fields are encrypted while the case is active');
		expect(privacy).toContain('90 days after closure');
		expect(privacy).not.toContain('no automatic deletion schedule in this MVP');
	});

	it('identifies the configured seller and states the scoped commercial terms', () => {
		const termsDocument = createPolicyDocuments(config).terms;
		const terms = text(termsDocument);

		for (const expected of [
			'Svelte School AB',
			'reviewed-registration',
			'reviewed-vat-number',
			'Reviewed street 1',
			'123 45 Reviewed city',
			'merchant@example.com',
			'apparel and accessories',
			'EUR',
			'VAT',
			'Stripe',
			'receipt',
			'invoice',
			'European Union except Slovenia',
			'selected destinations across Asia',
			'Styria',
			'manual review',
			'merch@sveltesociety.dev',
			'mandatory consumer rights'
		]) {
			expect(terms).toContain(expected);
		}
		expect(terms).not.toContain('United States');
		expect(
			termsDocument.sections.find(
				(section) => section.heading === 'Support, complaints, and returns'
			)?.paragraphs
		).toContain(
			'For an eligible EU withdrawal, unless we have offered to collect the goods, you must send them back or hand them over to us or our designated recipient in Sweden without undue delay and no later than 14 days after notifying us. You are responsible for the direct return postage. We recommend using a tracked service. Please contact us before sending the parcel so we can provide complete return instructions. Not contacting us first does not invalidate an otherwise timely statutory return or limit your right to notify us of withdrawal by another clear statement.'
		);
		expect(terms).not.toContain('24-hour');
	});

	it('keeps About short and makes no funding claim', () => {
		const about = createPolicyDocuments(config).about;
		const aboutText = text(about);

		expect(aboutText).toContain('Official Svelte Society merchandise');
		expect(aboutText).toContain('community identity');
		expect(aboutText.toLowerCase()).not.toContain('fund');
		expect(about.sections).toHaveLength(1);
		expect(about.sections[0].paragraphs).toHaveLength(1);
	});
});
