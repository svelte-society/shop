export type PolicySection = {
	heading: string;
	paragraphs: string[];
	links?: Array<{ label: string; href: string }>;
};

export type PolicyDocument = {
	title: string;
	summary: string;
	effectiveDate?: string;
	sections: PolicySection[];
};

export type PolicyContentConfig = {
	sellerLegalName: string;
	sellerRegistrationNumber: string;
	sellerVatNumber: string;
	sellerAddressLine1: string;
	sellerPostalCode: string;
	sellerCity: string;
	sellerCountry: string;
	sellerEmail: string;
	supportEmail: string;
	deliveryEstimateEu: string;
	deliveryEstimateAsia: string;
	policyEffectiveDate: string;
};

export type PolicyDocuments = {
	shipping: PolicyDocument;
	returns: PolicyDocument;
	privacy: PolicyDocument;
	terms: PolicyDocument;
	about: PolicyDocument;
};

const distanceContractsAct =
	'https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-200559-om-distansavtal-och-avtal-utanfor_sfs-2005-59/';
const consumerRightsDirective =
	'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0083';
const consumerComplaints = 'https://www.konsumentverket.se/konsumentratt-process/reklamera-vara/';
const gdprFullText =
	'https://www.imy.se/verksamhet/dataskydd/det-har-galler-enligt-gdpr/introduktion-till-gdpr/dataskyddsforordningen-i-fulltext/';
const imyRights = 'https://www.imy.se/privatperson/dataskydd/dina-rattigheter/';

function sentence(value: string): string {
	return `${value.trim().replace(/[.!?]+$/u, '')}.`;
}

function shippingDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'Shipping',
		summary: 'Where we deliver, what shipping costs, and when to expect your order.',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Where we ship',
				paragraphs: [
					'We currently ship to the European Union except Slovenia, and to the Asian countries available in the delivery-country picker. If a country is not available at checkout, we cannot ship there.',
					'Available destinations may change if a carrier route is paused.'
				]
			},
			{
				heading: 'Shipping price',
				paragraphs: [
					'All prices and charges are in EUR. Choose your delivery country to see prices for that destination.',
					'Shipping for one item is shown in your cart. Shipping is free when you order two or more items.'
				]
			},
			{
				heading: 'Delivery estimates',
				paragraphs: [
					`European Union: ${sentence(config.deliveryEstimateEu)}`,
					`Supported Asian destinations: ${sentence(config.deliveryEstimateAsia)}`,
					'These times are estimates, not guarantees. We send tracking when the carrier provides it, although tracking may not be available for every destination.'
				]
			},
			{
				heading: 'VAT and import charges',
				paragraphs: [
					'For EU orders, prices include VAT for your selected delivery country. The final amount is confirmed at checkout from your delivery details.',
					'Orders outside the EU may be charged import VAT, customs duties, brokerage fees, or carrier charges after checkout. These charges are not included in your order total and are your responsibility. Check your local import rules before ordering.'
				]
			},
			{
				heading: 'Need help?',
				paragraphs: [`For help with an order, email ${config.supportEmail}.`],
				links: [{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` }]
			}
		]
	};
}

function returnsDocument(config: PolicyContentConfig): PolicyDocument {
	const sellerAddress = `${config.sellerAddressLine1}, ${config.sellerPostalCode} ${config.sellerCity}, ${config.sellerCountry}`;
	return {
		title: 'Returns and withdrawal',
		summary: 'How to request a return, who pays postage, and when refunds are sent.',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Start a return',
				paragraphs: [
					`Before sending anything back, email ${config.supportEmail} or use the withdrawal form. We will confirm where and how to return your order. You may still notify us by any other clear statement within the applicable time limit.`
				],
				links: [
					{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` },
					{ label: 'Use the withdrawal form', href: '/withdraw' }
				]
			},
			{
				heading: 'EU change-of-mind returns',
				paragraphs: [
					'If you are an eligible EU consumer, you normally have 14 days after receiving your order to tell us that you want to withdraw. If an order arrives in parts, the period starts when the final part arrives.',
					'After telling us, send the goods to the return address we provide in Sweden within 14 days. You pay the direct return postage, and we recommend tracked shipping.'
				],
				links: [
					{ label: 'Swedish Distance Contracts Act', href: distanceContractsAct },
					{ label: 'EU Consumer Rights Directive', href: consumerRightsDirective }
				]
			},
			{
				heading: 'Damaged or incorrect items',
				paragraphs: [
					`Email ${config.supportEmail} with your order reference, a description of the problem, and useful photographs. For a valid complaint, we pay the necessary return postage. Wait for us to confirm the return method before buying postage.`,
					'Depending on the problem and your rights, we may offer a correction, replacement, price reduction, or refund.'
				],
				links: [{ label: 'Konsumentverket guidance on faulty goods', href: consumerComplaints }]
			},
			{
				heading: 'Orders outside the EU',
				paragraphs: [
					'We do not offer returns or exchanges for change of mind outside the EU. This does not affect rights that may apply to faulty, damaged, incorrect, or misdescribed goods, or other rights that cannot be waived where you live.'
				]
			},
			{
				heading: 'Refunds',
				paragraphs: [
					'When a refund is due, we return eligible payments to the original payment method within the legal deadline. We may wait until the goods arrive or you provide evidence that they were sent, whichever happens first.',
					'If you chose delivery that cost more than our least expensive standard option, the extra delivery cost is not refundable.'
				]
			},
			{
				heading: 'Model withdrawal notice',
				paragraphs: [
					'If you prefer not to use the online form, you can send this statement:',
					`To: ${config.sellerLegalName}, ${sellerAddress}, ${config.sellerEmail}.`,
					'I/We notify you that I/we withdraw from the contract for the sale of these goods: [describe the goods].',
					'Ordered on: [date]. Received on: [date].',
					'Name of consumer: [name]. Address of consumer: [address].',
					'Date: [date]. Signature of consumer: [only if sent on paper].'
				]
			}
		]
	};
}

function privacyDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'Privacy',
		summary: 'What we collect, why we use it, and how to exercise your data rights.',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Who is responsible for your data',
				paragraphs: [
					`${config.sellerLegalName}, registration number ${config.sellerRegistrationNumber}, is responsible for how this shop uses personal data. Email ${config.supportEmail} with privacy questions.`
				],
				links: [{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` }]
			},
			{
				heading: 'What we collect',
				paragraphs: [
					'At checkout, Stripe collects your name, contact details, delivery address, tax information, and payment details.',
					'We keep the order information needed to run the shop, such as what you bought, the amounts paid, delivery country, order and shipping status, and support history. We do not keep your name, postal address, phone number, VAT number, or payment details in the shop’s own database. We retrieve contact and delivery details from Stripe only when needed to fulfil your order or provide support.',
					'We also keep limited technical logs to keep the shop secure and reliable. These logs are designed not to contain secrets or unnecessary customer details.'
				]
			},
			{
				heading: 'Who receives your data',
				paragraphs: [
					'Stripe handles checkout, payment, tax, receipts, and invoices. Our production partner and delivery carriers receive the contact, address, and order details needed to make and deliver your order.',
					'Plunk sends order and shipping emails. We use self-hosted analytics to understand how the shop is used. These analytics do not include order or payment details.',
					'We keep encrypted backups so the shop can recover from data loss. Each provider also handles data under its own terms and legal duties.'
				]
			},
			{
				heading: 'Why we use your data',
				paragraphs: [
					'We use order information to fulfil our contract with you: taking payment, making and delivering your order, providing support, and handling returns.',
					'We keep information when needed to meet legal obligations. We rely on legitimate interests for security, fraud prevention, reliable operation, support records, recovery, and limited measurement of how the shop is used.'
				]
			},
			{
				heading: 'How long we keep it',
				paragraphs: [
					'Encrypted backups are kept for up to 30 days. Personal details submitted through the withdrawal form are encrypted while the case is open and deleted 90 days after closure.',
					'Stripe and our other providers keep their own records according to their settings, agreements, and legal obligations. Contact us if you need details about a particular order.'
				]
			},
			{
				heading: 'Data outside the EU/EEA',
				paragraphs: [
					'Some providers may process data outside the EU/EEA. When this happens, the transfer must use a lawful mechanism, such as an adequacy decision or approved contractual safeguards. Contact us for current information about providers and safeguards.'
				]
			},
			{
				heading: 'Your rights',
				paragraphs: [
					'Depending on the situation, you can ask for access, correction, erasure, restriction, or portability of your personal data, or object to how it is used. Some rights have exceptions, including when we must keep information by law.',
					`Email ${config.supportEmail} to make a request. We may ask for enough information to confirm that the data belongs to you. You can also complain to the Swedish Authority for Privacy Protection (IMY).`
				],
				links: [
					{ label: 'Read the GDPR at IMY', href: gdprFullText },
					{ label: 'Read about your data rights at IMY', href: imyRights }
				]
			}
		]
	};
}

function termsDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'Terms of sale',
		summary: 'The main terms that apply when you buy from the Society Shop.',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Seller',
				paragraphs: [
					`${config.sellerLegalName}, registration number ${config.sellerRegistrationNumber}, VAT number ${config.sellerVatNumber}.`,
					`${config.sellerAddressLine1}, ${config.sellerPostalCode} ${config.sellerCity}, ${config.sellerCountry}. Email: ${config.sellerEmail}.`
				],
				links: [{ label: `Email ${config.sellerEmail}`, href: `mailto:${config.sellerEmail}` }]
			},
			{
				heading: 'Placing an order',
				paragraphs: [
					'The shop sells official Svelte Society apparel and accessories. The product page and checkout show the description, available size or option, price, and quantity.',
					'Your order is accepted when payment succeeds. If we cannot fulfil a paid order, we will contact you.'
				]
			},
			{
				heading: 'Prices, VAT, and shipping',
				paragraphs: [
					'All prices are in EUR and depend on your selected delivery country. EU prices include local VAT. Prices outside the EU do not include EU VAT, and import charges may apply after checkout.',
					'Shipping for one item is shown in your cart. Shipping is free when you order two or more items. See Shipping for delivery times and information about charges outside the EU.'
				],
				links: [{ label: 'Read about shipping', href: '/shipping' }]
			},
			{
				heading: 'Payment and receipts',
				paragraphs: [
					'Payment is handled securely by Stripe. Stripe emails your receipt and, when available, an invoice. We do not store your card details.'
				]
			},
			{
				heading: 'Delivery',
				paragraphs: [
					'We deliver to the European Union except Slovenia, and to selected destinations across Asia. The delivery-country picker shows the countries currently available.',
					'After payment, we prepare your order for production. Delivery times are estimates, not guarantees. We send tracking when it becomes available.'
				]
			},
			{
				heading: 'Returns and order problems',
				paragraphs: [
					`Email ${config.supportEmail} if your order is damaged, incorrect, or otherwise needs support. The Returns page explains change-of-mind returns, faulty items, postage, and refunds.`,
					'Eligible EU consumers can notify us of withdrawal within the legal deadline. After notifying us, send the goods to the return address we provide in Sweden within 14 days. You pay the direct return postage, and we recommend tracked shipping. Contact us first for the complete return instructions. You may still notify us by any other clear statement.'
				],
				links: [
					{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` },
					{ label: 'Read about returns', href: '/returns' }
				]
			},
			{
				heading: 'Applicable law',
				paragraphs: [
					'Swedish law applies to these terms. This does not remove mandatory consumer rights where you live. If these terms conflict with a mandatory consumer rule, that rule applies.'
				]
			}
		]
	};
}

function aboutDocument(): PolicyDocument {
	return {
		title: 'About the Shop',
		summary: 'Official Svelte Society merchandise, made for the community.',
		sections: [
			{
				heading: 'Made for Svelte people',
				paragraphs: [
					'The Society Shop gives Svelte developers, meetup organizers, and community members a simple way to wear the Svelte mark wherever they gather.'
				]
			}
		]
	};
}

export function createPolicyDocuments(config: PolicyContentConfig): PolicyDocuments {
	return {
		shipping: shippingDocument(config),
		returns: returnsDocument(config),
		privacy: privacyDocument(config),
		terms: termsDocument(config),
		about: aboutDocument()
	};
}
