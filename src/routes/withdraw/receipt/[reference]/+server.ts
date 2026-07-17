import type { RequestHandler } from './$types';
import { applicationLifecycle, type WithdrawalRuntime } from '$lib/server/app.server';
import {
	renderWithdrawalReceiptText,
	verifyReceiptSession,
	WITHDRAWAL_RECEIPT_COOKIE
} from '$lib/server/withdrawals/receipt.server';

type ReceiptDependencies = {
	now: () => Date;
	getRuntime: () => Pick<WithdrawalRuntime, 'dataKey' | 'reader' | 'seller'> | null;
};

function unavailable(status: 404 | 503): Response {
	return new Response('Receipt unavailable.', {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
}

export function _createWithdrawalReceiptEndpoint(
	overrides: Partial<ReceiptDependencies> = {}
): RequestHandler {
	const dependencies: ReceiptDependencies = {
		now: () => new Date(),
		getRuntime: () => applicationLifecycle.current()?.withdrawal ?? null,
		...overrides
	};
	return async ({ params, cookies }) => {
		const runtime = dependencies.getRuntime();
		if (!runtime) return unavailable(503);
		const reference = params.reference;
		const token = cookies.get(WITHDRAWAL_RECEIPT_COOKIE) ?? '';
		const now = dependencies.now();
		if (!verifyReceiptSession(reference, token, now, runtime.dataKey)) return unavailable(404);
		try {
			const inspection = runtime.reader.inspectActive(reference, now);
			const body = renderWithdrawalReceiptText(inspection, runtime.seller);
			return new Response(body, {
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'content-disposition': `attachment; filename="${reference}-withdrawal-receipt.txt"`
				}
			});
		} catch (error) {
			return unavailable(
				error instanceof Error && error.message === 'WITHDRAWAL_CASE_NOT_FOUND' ? 404 : 503
			);
		}
	};
}

export const GET = _createWithdrawalReceiptEndpoint();
