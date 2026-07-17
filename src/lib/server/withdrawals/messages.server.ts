import type { WithdrawalSellerIdentity } from '$lib/config/private.server';
import type { WithdrawalMessageKind } from './repository.server';
import type { WithdrawalInspection } from './receipt.server';

type OriginalWithdrawalMessageKind = Exclude<WithdrawalMessageKind, 'resend'>;

export type WithdrawalMessageContentInput = {
	kind: WithdrawalMessageKind;
	originalKind?: OriginalWithdrawalMessageKind;
	inspection: WithdrawalInspection;
	productionOrigin: URL;
	supportEmail: string;
	seller: WithdrawalSellerIdentity;
};

export type WithdrawalMessagePreview = {
	to: string;
	subject: string;
	text: string;
	html: string;
};

export const WITHDRAWAL_LEGAL_STATUS_COPY = {
	eligible_instructions:
		"Your withdrawal is eligible for the EU change-of-mind process. Follow the return instructions below. Do not send the parcel to the seller's registered address unless the instructions say so.",
	ineligible_decision:
		'This order is not eligible for a change-of-mind return. Damaged or incorrect-item support remains available at merch@sveltesociety.dev.',
	support_handoff:
		'We will handle this request through damaged or incorrect-item support. Support remains available at merch@sveltesociety.dev.'
} as const;

function fail(): never {
	throw new Error('WITHDRAWAL_MESSAGE_INVALID');
}

function exactString(value: unknown, maximum = 2_000): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maximum &&
		value === value.trim() &&
		!/\p{Cc}/u.test(value)
	);
}

function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function paragraphHtml(paragraphs: string[]): string {
	return paragraphs
		.map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>')}</p>`)
		.join('');
}

function originalKind(input: WithdrawalMessageContentInput): OriginalWithdrawalMessageKind {
	if (input.kind === 'resend') {
		if (!input.originalKind) fail();
		return input.originalKind;
	}
	if (input.originalKind !== undefined) fail();
	return input.kind;
}

function commonParagraphs(inspection: WithdrawalInspection): string[] {
	const itemSummary =
		inspection.scope === 'entire_order'
			? 'Scope: Entire order'
			: `Items:\n${inspection.payload.items
					.map((item) => `${item.quantity} × ${item.description}`)
					.join('\n')}`;
	return [
		`Hello ${inspection.payload.fullName},`,
		`Withdrawal reference: ${inspection.reference}`,
		`Entered order reference: ${inspection.payload.enteredOrderReference}`,
		itemSummary
	];
}

function messageContent(
	kind: OriginalWithdrawalMessageKind,
	input: WithdrawalMessageContentInput
): { subject: string; paragraphs: string[] } {
	const { inspection } = input;
	const common = commonParagraphs(inspection);
	switch (kind) {
		case 'receipt': {
			const receiptUrl = new URL(
				`/withdraw/receipt/${inspection.reference}`,
				input.productionOrigin
			);
			return {
				subject: `Withdrawal notice received — ${inspection.reference}`,
				paragraphs: [
					...common,
					`We received your withdrawal notice at ${inspection.createdAt.toISOString()}.`,
					'This receipt confirms submission only. It is not an approval and does not confirm or start a refund.',
					`Receipt: ${receiptUrl.toString()}`,
					`Seller: ${input.seller.legalName}, registration ${input.seller.registrationNumber}, ${input.seller.addressLine1}, ${input.seller.postalCode} ${input.seller.city}, ${input.seller.country}.`,
					`Merchant email: ${input.seller.email}`
				]
			};
		}
		case 'eligible_instructions': {
			const instructions = inspection.payload.reconciliation?.customerInstructions;
			if (!exactString(instructions, 5_000)) fail();
			return {
				subject: `Withdrawal return instructions — ${inspection.reference}`,
				paragraphs: [...common, WITHDRAWAL_LEGAL_STATUS_COPY.eligible_instructions, instructions]
			};
		}
		case 'ineligible_decision':
			return {
				subject: `Withdrawal eligibility decision — ${inspection.reference}`,
				paragraphs: [...common, WITHDRAWAL_LEGAL_STATUS_COPY.ineligible_decision]
			};
		case 'support_handoff':
			return {
				subject: `Withdrawal support handoff — ${inspection.reference}`,
				paragraphs: [...common, WITHDRAWAL_LEGAL_STATUS_COPY.support_handoff]
			};
	}
}

export function withdrawalMessage(input: WithdrawalMessageContentInput): WithdrawalMessagePreview {
	if (
		!input ||
		!input.inspection ||
		!exactString(input.inspection.payload?.receiptEmail, 320) ||
		!exactString(input.inspection.reference, 100) ||
		!(input.productionOrigin instanceof URL) ||
		input.productionOrigin.protocol !== 'https:' ||
		!exactString(input.supportEmail, 320) ||
		!input.seller
	) {
		fail();
	}
	const content = messageContent(originalKind(input), input);
	const text = `${content.paragraphs.join('\n\n')}\n`;
	return {
		to: input.inspection.payload.receiptEmail,
		subject: content.subject,
		text,
		html: paragraphHtml(content.paragraphs)
	};
}
