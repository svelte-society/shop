export type PolicySection = {
	heading: string;
	paragraphs: string[];
	links?: Array<{ label: string; href: string }>;
};

export type PolicyDocument = {
	title: string;
	effectiveDate: string;
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

function shippingDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'Shipping',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Where we ship',
				paragraphs: [
					'We ship only to destinations currently supported by our fulfillment partner: the European Union except Slovenia, and selected destinations across Asia. Availability is enforced at checkout and may change if a fulfillment or carrier route is suspended.'
				]
			},
			{
				heading: 'Currency and shipping rate',
				paragraphs: [
					'All store prices and charges are in EUR. The country shown in “Deliver to” controls the storefront tax projection.',
					'When an order contains one total unit, the current amount is shown before checkout. Shipping is free when an order contains two or more total units.',
					'For an EU destination, the storefront displays shipping with that country’s standard VAT projection. Stripe confirms the exact tax from the complete delivery and business details at checkout.'
				]
			},
			{
				heading: 'Delivery estimates',
				paragraphs: [
					`European Union: ${config.deliveryEstimateEu}.`,
					`Supported Asian destinations: ${config.deliveryEstimateAsia}.`,
					'These are estimates, not guaranteed delivery dates. We share tracking when the carrier provides it; tracking may not be available for every destination.'
				]
			},
			{
				heading: 'Tax and non-EU import charges',
				paragraphs: [
					'Final tax is calculated at checkout from the delivery and business details provided there.',
					"Deliveries outside the EU may be charged import VAT, customs duties, brokerage fees, or carrier charges after checkout. These charges are not collected by this shop and are the recipient's responsibility. Check your local import rules before ordering."
				]
			},
			{
				heading: 'Shipping support',
				paragraphs: [`For order help, contact ${config.supportEmail}.`],
				links: [{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` }]
			}
		]
	};
}

function returnsDocument(config: PolicyContentConfig): PolicyDocument {
	const sellerAddress = `${config.sellerAddressLine1}, ${config.sellerPostalCode} ${config.sellerCity}, ${config.sellerCountry}`;
	return {
		title: 'Returns and withdrawal',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Contact us first',
				paragraphs: [
					`Contact ${config.supportEmail} before sending anything back so we can review the request and provide the correct return instructions. This approval-first handling step does not limit your statutory right to give a clear withdrawal or complaint notice within the applicable time limit.`
				],
				links: [{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` }]
			},
			{
				heading: 'EU right of withdrawal',
				paragraphs: [
					'If you are an eligible EU consumer buying at a distance, you normally have 14 days to notify us that you are withdrawing. For goods, the period starts when you or a person you name takes possession of the goods. If one order arrives in separate parts, it starts when the final part arrives.',
					'You may use the model withdrawal notice below or another clear statement. Send the notice before the withdrawal period ends. After notifying us, return the goods without undue delay and no later than 14 days after the notice.',
					'We currently claim no merchandise-specific exclusion from the statutory right of withdrawal. Any future exclusion requires qualified legal review before it is published.'
				],
				links: [
					{ label: 'Submit a withdrawal notice', href: '/withdraw' },
					{ label: 'Swedish Distance Contracts Act', href: distanceContractsAct },
					{ label: 'EU Consumer Rights Directive', href: consumerRightsDirective }
				]
			},
			{
				heading: 'Model withdrawal notice',
				paragraphs: [
					'Use these details only if you want to withdraw from the contract:',
					`To: ${config.sellerLegalName}, ${sellerAddress}, ${config.sellerEmail}.`,
					'I/We notify you that I/we withdraw from the contract for the sale of these goods: [describe the goods].',
					'Ordered on: [date]. Received on: [date].',
					'Name of consumer: [name]. Address of consumer: [address].',
					'Date: [date]. Signature of consumer: [only if sent on paper].'
				]
			},
			{
				heading: 'Return postage',
				paragraphs: [
					'For a statutory change-of-mind withdrawal, you pay the direct return postage. Use the return instructions we provide so the parcel goes to the correct location.',
					'For a valid complaint about a damaged or incorrect item, we pay the necessary return postage. Do not buy replacement postage until we have confirmed the return method.'
				]
			},
			{
				heading: 'Orders outside the EU',
				paragraphs: [
					'We offer no voluntary returns or exchanges for change of mind outside the EU. This does not limit mandatory rights that may apply to faulty, damaged, incorrect, or misdescribed goods, or other non-waivable consumer rights in your jurisdiction. Contact support before sending anything back.'
				]
			},
			{
				heading: 'Damaged or incorrect item',
				paragraphs: [
					`Contact ${config.supportEmail} with the order reference, a description of the problem, and useful photographs. Depending on the circumstances and your mandatory rights, the remedy may be correction, replacement, a price reduction, or a refund.`,
					'Your statutory complaint rights are separate from the right of withdrawal.'
				],
				links: [{ label: 'Konsumentverket guidance on faulty goods', href: consumerComplaints }]
			},
			{
				heading: 'Refunds',
				paragraphs: [
					'Refunds are processed manually through Stripe. For an accepted withdrawal, we refund eligible payments without undue delay and within the statutory deadline. We may wait until the goods arrive or you provide evidence that they were sent, whichever happens first.',
					'We use the original payment method unless you expressly agree to another method that does not add a fee. Extra delivery cost above the least expensive standard delivery option is not refundable.'
				]
			}
		]
	};
}

function privacyDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'Privacy',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Who is responsible',
				paragraphs: [
					`${config.sellerLegalName}, registration number ${config.sellerRegistrationNumber}, is responsible for the shop's handling of personal data. Contact ${config.supportEmail} with privacy questions.`
				],
				links: [{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` }]
			},
			{
				heading: 'What the shop handles',
				paragraphs: [
					'Stripe handles checkout identity, contact, delivery, tax, and payment details. The shop keeps local operational state such as internal order and draft IDs, provider references, product-line snapshots, country, amounts, fulfillment status, support outcomes, and delivery status.',
					'SQLite does not store customer names, postal addresses, phone numbers, VAT numbers, or payment-method data. Those details are retrieved from Stripe only when needed for fulfillment or support.',
					'Structured logs contain operational events such as request IDs, route templates, stable error codes, and job outcomes. Secret values and unnecessary customer details are not intended for logs.'
				]
			},
			{
				heading: 'Services used',
				paragraphs: [
					'Stripe provides catalog, checkout, payment, tax, receipts, and invoices. Styria receives the details needed to manufacture and fulfill approved orders. Plunk sends operational and shipping emails. The shipping carriers receive the details needed to deliver parcels.',
					'When configured, Umami measures limited storefront activity. The shop sends allowlisted route-level events and removes query parameters before analytics collection.',
					'Encrypted S3-compatible backups protect local operational records for recovery. Information is shared with these services for the operational purposes described here; each service also handles data under its own terms and legal duties.'
				]
			},
			{
				heading: 'Purposes and legal bases',
				paragraphs: [
					'We use order information to perform the sales contract, take payment, manufacture and deliver goods, provide order support, and handle returns.',
					'We keep information when necessary for legal obligations. We also rely on legitimate interests for service security, fraud prevention, operational reliability, support records, recovery, and proportionate storefront measurement, after considering customer privacy.'
				]
			},
			{
				heading: 'Retention',
				paragraphs: [
					'Encrypted backups roll off after 30 days. Personal withdrawal case fields are encrypted while the case is active and are scheduled for purge 90 days after closure.',
					'Provider records and structured logs are retained according to the applicable provider settings, operating schedule, contracts, and legal duties. Contact us for current details about a particular order.'
				]
			},
			{
				heading: 'International transfers',
				paragraphs: [
					'Some service providers may process data outside the EU/EEA. Where that happens, the transfer must use an applicable legal mechanism, such as an adequacy decision or approved contractual safeguards. Contact us for current provider and safeguard information.'
				]
			},
			{
				heading: 'Your rights',
				paragraphs: [
					'Depending on the circumstances, you may ask for access, correction, erasure, restriction, or portability of your personal data, or object to processing. A right may be limited where continued processing is required by law or another applicable exception.',
					`Contact ${config.supportEmail} to make a request. You may also complain to the Swedish Authority for Privacy Protection (IMY). We may need enough information to verify that the request concerns you.`
				],
				links: [
					{ label: 'GDPR full text at IMY', href: gdprFullText },
					{ label: 'Your data protection rights at IMY', href: imyRights }
				]
			}
		]
	};
}

function termsDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'Terms of sale',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Seller',
				paragraphs: [
					`${config.sellerLegalName}, registration number ${config.sellerRegistrationNumber}, VAT number ${config.sellerVatNumber}.`,
					`${config.sellerAddressLine1}, ${config.sellerPostalCode} ${config.sellerCity}, ${config.sellerCountry}. Merchant email: ${config.sellerEmail}.`
				],
				links: [{ label: `Email ${config.sellerEmail}`, href: `mailto:${config.sellerEmail}` }]
			},
			{
				heading: 'Products and ordering',
				paragraphs: [
					'The shop sells official Svelte Society apparel and accessories. Product descriptions, variants, quantities, and current availability appear on the product and checkout pages.',
					'An order is accepted after Stripe confirms successful payment. We will contact you if a paid order cannot be fulfilled.'
				]
			},
			{
				heading: 'Prices, VAT, and shipping',
				paragraphs: [
					'Prices are in EUR. The country shown in “Deliver to” controls the storefront tax projection. For EU destinations, displayed prices include that country’s standard VAT projection; Stripe confirms exact tax from the complete delivery and business details at checkout. For supported destinations outside the EU, displayed prices exclude EU VAT and import charges may still be assessed after checkout.',
					'The current shipping amount is shown before checkout for one total unit and is free for two or more total units. Changing “Deliver to” can change the displayed merchandise, shipping, and total prices. The Shipping page contains delivery estimates and the complete notice about charges outside the EU.'
				],
				links: [{ label: 'Read the Shipping policy', href: '/shipping' }]
			},
			{
				heading: 'Payment, receipt, and invoice',
				paragraphs: [
					'Stripe processes payment. Stripe provides the payment receipt and, when available for the transaction, the invoice. The shop does not store payment-method data in its local SQLite database.'
				]
			},
			{
				heading: 'Destinations and fulfillment',
				paragraphs: [
					'We accept delivery addresses in the European Union except Slovenia, and in selected destinations across Asia currently supported by Styria. Availability is enforced at checkout and may change if a fulfillment or carrier route is suspended.',
					'Paid orders enter manual review before submission to Styria for manufacture and fulfillment. Estimates are not guarantees, and we do not promise a fixed public review window. Tracking is sent when it becomes available.'
				]
			},
			{
				heading: 'Support, complaints, and returns',
				paragraphs: [
					`Contact ${config.supportEmail} for order support. Returns, EU withdrawal, damaged or incorrect items, postage, and manual refunds are explained on the Returns page.`,
					'For an eligible EU withdrawal, unless we have offered to collect the goods, you must send them back or hand them over to us or our designated recipient in Sweden without undue delay and no later than 14 days after notifying us. You are responsible for the direct return postage. We recommend using a tracked service. Please contact us before sending the parcel so we can provide complete return instructions. Not contacting us first does not invalidate an otherwise timely statutory return or limit your right to notify us of withdrawal by another clear statement.'
				],
				links: [
					{ label: `Email ${config.supportEmail}`, href: `mailto:${config.supportEmail}` },
					{ label: 'Read the Returns policy', href: '/returns' }
				]
			},
			{
				heading: 'Governing terms',
				paragraphs: [
					'Swedish law governs these terms. This choice does not remove mandatory consumer rights that apply where you live. If a term conflicts with a mandatory consumer rule, the mandatory rule applies.'
				]
			}
		]
	};
}

function aboutDocument(config: PolicyContentConfig): PolicyDocument {
	return {
		title: 'About the Society Shop',
		effectiveDate: config.policyEffectiveDate,
		sections: [
			{
				heading: 'Made for the community',
				paragraphs: [
					'Official Svelte Society merchandise for expressing community identity at meetups, at your desk, and wherever Svelte people gather.'
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
		about: aboutDocument(config)
	};
}
