import type { FulfillmentStatus, OrderWithLines } from '$lib/domain/orders';
import type {
	FulfillmentRepository,
	OrderWithLinesAndEvents
} from '$lib/server/fulfillment/repository.server';
import type { StyriaGateway } from '$lib/server/styria/gateway';
import { canonicalJson, styriaCountryName } from '$lib/server/styria/payload';
import type { StyriaOrder } from '$lib/server/styria/types';

const AMBIGUOUS_ERROR_CODE = 'STYRIA_CREATE_AMBIGUOUS';
const EVIDENCE_ERROR_CODE = 'STYRIA_RECONCILIATION_EVIDENCE_INVALID';
const RECORD_ERROR_CODE = 'STYRIA_RECONCILIATION_RECORD_FAILED';

export interface ReconciliationService {
	reconcile(
		orderId: string,
		now?: Date
	): Promise<{
		outcome: 'reconciled' | 'not_found' | 'ambiguous';
		matches: number;
		fulfillmentStatus: FulfillmentStatus;
	}>;
}

export type ReconciliationDependencies = {
	fulfillment: Pick<FulfillmentRepository, 'inspect' | 'recordSubmitted' | 'requireReview'>;
	styria: StyriaGateway;
};

export type StyriaSubmissionEvidence = {
	externalId: string;
	createdAfter: Date;
	destinationCountry: string;
	lineSummary: string[];
};

export class ReconciliationError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'ReconciliationError';
	}
}

function fail(code: string): never {
	throw new ReconciliationError(code);
}

function isExactString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		value === value.trim() &&
		!/[\r\n]/.test(value)
	);
}

function validDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function hasSearchableOrderShape(value: unknown): value is StyriaOrder {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		isExactString(value.id, 200) &&
		'external_id' in value &&
		(value.external_id === null || isExactString(value.external_id, 200)) &&
		'created_at' in value &&
		isExactString(value.created_at, 100) &&
		'status' in value &&
		isExactString(value.status, 100) &&
		'deleted' in value &&
		typeof value.deleted === 'boolean' &&
		'shipping_address' in value &&
		typeof value.shipping_address === 'object' &&
		value.shipping_address !== null &&
		'country' in value.shipping_address &&
		isExactString(value.shipping_address.country, 200) &&
		'items' in value &&
		Array.isArray(value.items)
	);
}

function submissionEvidenceTimestamp(order: OrderWithLinesAndEvents): Date {
	const paidEvents = order.events.filter(
		(event) => event.action === 'paid_order_recorded' || event.action === 'paid_order_converged'
	);
	if (
		paidEvents.length === 0 ||
		paidEvents.some(
			(event) =>
				event.orderId !== order.id ||
				event.actor !== 'stripe-webhook' ||
				event.result !== 'succeeded' ||
				event.errorCode !== null ||
				!validDate(event.createdAt)
		)
	) {
		throw new Error('paid-order audit invalid');
	}
	return new Date(
		paidEvents
			.map((event) => event.createdAt)
			.sort((left, right) => left.getTime() - right.getTime())[0]
	);
}

function itemSummary(item: StyriaOrder['items'][number]): string {
	return canonicalJson({
		description: item.description,
		designPositions: Object.keys(item.designs).sort(),
		pn: item.pn,
		quantity: item.quantity,
		retailPrice: item.retailPrice
	});
}

function expectedLineSummary(order: OrderWithLines): string[] {
	return order.lines
		.map((line) =>
			itemSummary({
				pn: line.styriaProductNumber,
				quantity: line.quantity,
				retailPrice: line.unitAmount / 100,
				description: `Design reference: ${line.designReference}`,
				designs: line.designPlacements
			})
		)
		.sort();
}

export function buildStyriaSubmissionEvidence(
	order: OrderWithLinesAndEvents
): StyriaSubmissionEvidence {
	try {
		return {
			externalId: order.checkoutSessionId,
			createdAfter: submissionEvidenceTimestamp(order),
			destinationCountry: styriaCountryName(order.destinationCountry),
			lineSummary: expectedLineSummary(order)
		};
	} catch {
		fail(EVIDENCE_ERROR_CODE);
	}
}

export function isConsistentStyriaOrder(
	order: StyriaOrder,
	evidence: StyriaSubmissionEvidence
): boolean {
	try {
		const createdAt = new Date(order.created_at);
		const lineSummary = order.items.map(itemSummary).sort();
		return (
			order.external_id === evidence.externalId &&
			Number.isFinite(createdAt.getTime()) &&
			createdAt.getTime() >= evidence.createdAfter.getTime() &&
			order.deleted === false &&
			order.shipping_address.country === evidence.destinationCountry &&
			lineSummary.length === evidence.lineSummary.length &&
			lineSummary.every((item, index) => item === evidence.lineSummary[index])
		);
	} catch {
		return false;
	}
}

export class StyriaReconciliationService implements ReconciliationService {
	constructor(private readonly dependencies: ReconciliationDependencies) {}

	private requireReview(orderId: string, now: Date, errorCode = AMBIGUOUS_ERROR_CODE): void {
		try {
			this.dependencies.fulfillment.requireReview(orderId, errorCode, now);
		} catch {
			fail('STYRIA_RECONCILIATION_STATE_FAILED');
		}
	}

	private evidenceOrRequireReview(
		order: OrderWithLinesAndEvents,
		now: Date
	): StyriaSubmissionEvidence {
		try {
			return buildStyriaSubmissionEvidence(order);
		} catch {
			if (order.fulfillmentStatus === 'submitting') {
				this.requireReview(order.id, now, EVIDENCE_ERROR_CODE);
			}
			fail(EVIDENCE_ERROR_CODE);
		}
	}

	async reconcile(
		orderId: string,
		now = new Date()
	): ReturnType<ReconciliationService['reconcile']> {
		if (!isExactString(orderId, 200) || !validDate(now)) {
			fail('STYRIA_RECONCILIATION_INVALID');
		}

		let order: OrderWithLinesAndEvents | null;
		try {
			order = this.dependencies.fulfillment.inspect(orderId);
		} catch {
			fail('STYRIA_RECONCILIATION_ORDER_READ_FAILED');
		}
		if (!order) fail('STYRIA_RECONCILIATION_ORDER_NOT_FOUND');
		if (order.fulfillmentStatus !== 'review_required' && order.fulfillmentStatus !== 'submitting') {
			fail('STYRIA_RECONCILIATION_NOT_ALLOWED');
		}

		const evidence = this.evidenceOrRequireReview(order, now);
		let providerMatches: StyriaOrder[];
		try {
			providerMatches = await this.dependencies.styria.searchByExternalId(
				evidence.externalId,
				evidence.createdAfter
			);
			if (!Array.isArray(providerMatches) || !providerMatches.every(hasSearchableOrderShape)) {
				throw new Error('invalid search result');
			}
		} catch {
			if (order.fulfillmentStatus === 'submitting') this.requireReview(orderId, now);
			fail('STYRIA_RECONCILIATION_FAILED');
		}
		const matches = providerMatches.filter((match) => match.external_id === evidence.externalId);

		if (matches.length === 1 && isConsistentStyriaOrder(matches[0], evidence)) {
			try {
				this.dependencies.fulfillment.recordSubmitted(
					orderId,
					matches[0].id,
					matches[0].status,
					now
				);
			} catch {
				if (order.fulfillmentStatus === 'submitting') {
					this.requireReview(orderId, now, RECORD_ERROR_CODE);
				}
				fail(RECORD_ERROR_CODE);
			}
			return {
				outcome: 'reconciled',
				matches: 1,
				fulfillmentStatus: 'awaiting_vendor_payment'
			};
		}

		if (order.fulfillmentStatus === 'submitting') this.requireReview(orderId, now);

		return {
			outcome: matches.length === 0 ? 'not_found' : 'ambiguous',
			matches: matches.length,
			fulfillmentStatus: 'review_required'
		};
	}
}
