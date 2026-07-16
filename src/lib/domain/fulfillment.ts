import { RepositoryError, type FulfillmentStatus } from './orders';

export type { FulfillmentStatus } from './orders';

const ALLOWED: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
	pending_review: ['submitting', 'review_required', 'cancelled'],
	submitting: ['awaiting_vendor_payment', 'review_required'],
	submitted: [
		'awaiting_vendor_payment',
		'in_production',
		'shipped',
		'review_required',
		'cancelled'
	],
	awaiting_vendor_payment: ['in_production', 'shipped', 'review_required', 'cancelled'],
	in_production: ['shipped', 'review_required', 'cancelled'],
	shipped: ['review_required'],
	review_required: [
		'pending_review',
		'awaiting_vendor_payment',
		'in_production',
		'shipped',
		'cancelled'
	],
	cancelled: ['review_required']
};

const IN_PRODUCTION_STATUSES = new Set([
	'in progress',
	'paid',
	'stock allocation',
	'printing',
	'quality control'
]);

const REVIEW_STATUSES = new Set(['refunded', 'internal order query']);

export function assertTransition(from: FulfillmentStatus, to: FulfillmentStatus): void {
	if (!ALLOWED[from]?.includes(to)) throw new RepositoryError('FULFILLMENT_TRANSITION_INVALID');
}

export function mapStyriaStatus(input: {
	status: string;
	deleted: boolean;
	trackingNumber: string | null;
}): FulfillmentStatus {
	const status = typeof input?.status === 'string' ? input.status.trim().toLowerCase() : '';
	if (input?.deleted === true || REVIEW_STATUSES.has(status)) return 'review_required';
	if (typeof input?.trackingNumber === 'string' && input.trackingNumber.trim().length > 0) {
		return 'shipped';
	}
	if (status === 'received') return 'awaiting_vendor_payment';
	if (IN_PRODUCTION_STATUSES.has(status)) return 'in_production';
	return 'review_required';
}
