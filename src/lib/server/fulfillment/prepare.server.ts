import * as crypto from 'node:crypto';
import { isSupportedDestination } from '$lib/domain/destinations';
import type { OrderWithLines } from '$lib/domain/orders';
import type { StripeFulfillmentGateway } from '$lib/server/stripe/gateway';
import { StripeFulfillmentError } from '$lib/server/stripe/client.server';
import {
	buildStyriaPayload,
	hashStyriaPayload,
	StyriaPayloadError
} from '$lib/server/styria/payload';
import type { StyriaOrderPayload } from '$lib/server/styria/types';
import type { ApprovalRepository } from './approvals.server';
import type { FulfillmentRepository } from './repository.server';

const APPROVAL_LIFETIME_MS = 10 * 60 * 1_000;

export type PreparationNotice = { code: string; message: string };

export type ReadyPreparationResult = {
	status: 'ready';
	orderId: string;
	approvalId: string;
	expiresAt: string;
	payloadHash: string;
	payload: StyriaOrderPayload;
	warnings: PreparationNotice[];
	blockers: [];
};

export type BlockedPreparationResult = {
	status: 'blocked';
	orderId: string;
	approvalId: null;
	expiresAt: null;
	payloadHash: null;
	payload: null;
	warnings: PreparationNotice[];
	blockers: [PreparationNotice, ...PreparationNotice[]];
};

export type PreparationResult = ReadyPreparationResult | BlockedPreparationResult;

export interface PreparationService {
	prepare(orderId: string, now?: Date): Promise<PreparationResult>;
}

export type PreparationDependencies = {
	fulfillment: Pick<FulfillmentRepository, 'inspect'>;
	stripe: StripeFulfillmentGateway;
	approvals: ApprovalRepository;
	brandName: string;
	comment: string;
};

export class PreparationError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = 'PreparationError';
	}
}

function fail(code: string): never {
	throw new PreparationError(code);
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

function warningNotices(order: OrderWithLines): PreparationNotice[] {
	if (order.paymentStatus === 'partially_refunded') {
		return [
			{
				code: 'PAYMENT_PARTIALLY_REFUNDED',
				message: 'The order has been partially refunded; review before submission.'
			}
		];
	}
	if (order.paymentStatus === 'refunded') {
		return [
			{
				code: 'PAYMENT_REFUNDED',
				message: 'The order has been fully refunded; review before submission.'
			}
		];
	}
	return [];
}

function hasImmutableDesign(order: OrderWithLines): boolean {
	return (
		Array.isArray(order.lines) &&
		order.lines.length > 0 &&
		order.lines.every((line) => {
			if (!isExactString(line.designReference, 500)) return false;
			if (
				typeof line.designPlacements !== 'object' ||
				line.designPlacements === null ||
				Array.isArray(line.designPlacements)
			) {
				return false;
			}
			const placements = Object.entries(line.designPlacements);
			return (
				placements.length > 0 &&
				placements.every(([position, url]) => {
					if (!isExactString(position, 200) || !isExactString(url, 2_000)) return false;
					try {
						const parsed = new URL(url);
						return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
					} catch {
						return false;
					}
				})
			);
		})
	);
}

function localBlockers(order: OrderWithLines): PreparationNotice[] {
	const blockers: PreparationNotice[] = [];
	if (order.fulfillmentStatus !== 'pending_review') {
		blockers.push({
			code: 'FULFILLMENT_STATUS_NOT_PREPARABLE',
			message: 'Order fulfillment is not pending review.'
		});
	}
	if (!hasImmutableDesign(order)) {
		blockers.push({
			code: 'IMMUTABLE_DESIGN_MISSING',
			message: 'An immutable checkout design snapshot is missing or invalid.'
		});
	}
	if (!isSupportedDestination(order.destinationCountry)) {
		blockers.push({
			code: 'DESTINATION_COUNTRY_UNSUPPORTED',
			message: 'The destination country is not supported for fulfillment.'
		});
	}
	return blockers;
}

function blockedResult(
	orderId: string,
	warnings: PreparationNotice[],
	blockers: PreparationNotice[]
): BlockedPreparationResult {
	if (blockers.length === 0) fail('FULFILLMENT_PREPARATION_FAILED');
	return {
		status: 'blocked',
		orderId,
		approvalId: null,
		expiresAt: null,
		payloadHash: null,
		payload: null,
		warnings,
		blockers: blockers as [PreparationNotice, ...PreparationNotice[]]
	};
}

function payloadBlocker(code: string): PreparationNotice {
	if (code === 'STYRIA_COUNTRY_UNSUPPORTED') {
		return {
			code: 'DESTINATION_COUNTRY_UNSUPPORTED',
			message: 'The destination country is not supported for fulfillment.'
		};
	}
	if (code === 'STYRIA_ORDER_SNAPSHOT_INVALID') {
		return {
			code: 'ORDER_SNAPSHOT_INVALID',
			message: 'The immutable order snapshot cannot produce a Styria payload.'
		};
	}
	return {
		code: 'FULFILLMENT_DETAILS_INVALID',
		message: 'Current Stripe fulfillment details do not match the order.'
	};
}

export class FulfillmentPreparationService implements PreparationService {
	constructor(private readonly dependencies: PreparationDependencies) {}

	async prepare(orderId: string, now = new Date()): Promise<PreparationResult> {
		if (!isExactString(orderId, 200) || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
			fail('FULFILLMENT_PREPARATION_INVALID');
		}

		let inspected: ReturnType<FulfillmentRepository['inspect']>;
		try {
			inspected = this.dependencies.fulfillment.inspect(orderId);
		} catch {
			fail('FULFILLMENT_ORDER_READ_FAILED');
		}
		if (!inspected) fail('FULFILLMENT_ORDER_NOT_FOUND');
		const order: OrderWithLines = inspected;
		const warnings = warningNotices(order);
		const blockers = localBlockers(order);
		if (blockers.length > 0) return blockedResult(orderId, warnings, blockers);

		let details;
		try {
			details = await this.dependencies.stripe.retrieveFulfillmentDetails(order.checkoutSessionId);
		} catch (error) {
			if (error instanceof StripeFulfillmentError) {
				if (error.code === 'STRIPE_FULFILLMENT_DESTINATION_UNSUPPORTED') {
					return blockedResult(orderId, warnings, [payloadBlocker('STYRIA_COUNTRY_UNSUPPORTED')]);
				}
				if (error.code === 'STRIPE_FULFILLMENT_DETAILS_INVALID') {
					return blockedResult(orderId, warnings, [payloadBlocker('STYRIA_FULFILLMENT_INVALID')]);
				}
			}
			fail('FULFILLMENT_DETAILS_RETRIEVAL_FAILED');
		}

		let payload: StyriaOrderPayload;
		try {
			payload = buildStyriaPayload({
				order,
				fulfillment: { recipient: details.recipient, address: details.address },
				brandName: this.dependencies.brandName,
				comment: this.dependencies.comment
			});
		} catch (error) {
			if (error instanceof StyriaPayloadError) {
				return blockedResult(orderId, warnings, [payloadBlocker(error.code)]);
			}
			fail('FULFILLMENT_PAYLOAD_BUILD_FAILED');
		}

		let payloadHash: string;
		try {
			payloadHash = hashStyriaPayload(payload);
		} catch {
			fail('FULFILLMENT_PAYLOAD_HASH_FAILED');
		}
		const expiresAt = new Date(now.getTime() + APPROVAL_LIFETIME_MS);
		if (!Number.isFinite(expiresAt.getTime())) fail('FULFILLMENT_PREPARATION_INVALID');
		const approvalId = crypto.randomBytes(32).toString('base64url');
		try {
			this.dependencies.approvals.create({
				approvalId,
				orderId,
				payloadHash,
				expiresAt
			});
		} catch {
			fail('SUBMISSION_APPROVAL_CREATE_FAILED');
		}

		return {
			status: 'ready',
			orderId,
			approvalId,
			expiresAt: expiresAt.toISOString(),
			payloadHash,
			payload,
			warnings,
			blockers: []
		};
	}
}
