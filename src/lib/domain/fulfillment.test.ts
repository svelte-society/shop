import { describe, expect, it } from 'vitest';
import { assertTransition, mapStyriaStatus, type FulfillmentStatus } from './fulfillment';

const statuses: FulfillmentStatus[] = [
	'pending_review',
	'submitting',
	'submitted',
	'awaiting_vendor_payment',
	'in_production',
	'shipped',
	'review_required',
	'cancelled'
];

const allowed: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
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

describe('fulfillment transitions', () => {
	it('accepts every explicitly allowed transition', () => {
		for (const from of statuses) {
			for (const to of allowed[from]) {
				expect(() => assertTransition(from, to), `${from} -> ${to}`).not.toThrow();
			}
		}
	});

	it('rejects self transitions and every lifecycle skip outside the table', () => {
		for (const from of statuses) {
			for (const to of statuses.filter((candidate) => !allowed[from].includes(candidate))) {
				expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrowError(
					'FULFILLMENT_TRANSITION_INVALID'
				);
			}
		}
	});
});

describe('Styria status mapping', () => {
	it('maps received to the manual vendor-payment wait without a submitted intermediate state', () => {
		expect(mapStyriaStatus({ status: 'received', deleted: false, trackingNumber: null })).toBe(
			'awaiting_vendor_payment'
		);
	});

	it.each(['in progress', 'paid', 'stock allocation', 'printing', 'quality control'])(
		'maps %s to production',
		(status) => {
			expect(mapStyriaStatus({ status, deleted: false, trackingNumber: null })).toBe(
				'in_production'
			);
		}
	);

	it('maps a usable tracking number to shipped', () => {
		expect(
			mapStyriaStatus({ status: 'quality control', deleted: false, trackingNumber: 'TRACK-123' })
		).toBe('shipped');
	});

	it.each([
		{ status: 'received', deleted: true, trackingNumber: null },
		{ status: 'refunded', deleted: false, trackingNumber: null },
		{ status: 'internal order query', deleted: false, trackingNumber: null }
	])('requires review for deleted, refunded, and internal-query orders', (input) => {
		expect(mapStyriaStatus(input)).toBe('review_required');
	});

	it('requires review for an unknown provider status', () => {
		expect(
			mapStyriaStatus({ status: 'provider surprise', deleted: false, trackingNumber: null })
		).toBe('review_required');
	});
});
