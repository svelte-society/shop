import type { RequestHandler } from './$types';
import { checkReadiness, type ReadinessResult } from '$lib/server/health/readiness.server';

type ReadinessCheck = () => Promise<ReadinessResult>;

const failedChecks: ReadinessResult['checks'] = {
	configuration: 'failed',
	database: 'failed',
	migrations: 'failed',
	volume: 'failed',
	disk: 'failed'
};

export function _createReadinessGet(check: ReadinessCheck): RequestHandler {
	return async () => {
		let result: ReadinessResult;
		try {
			result = await check();
		} catch {
			result = { ready: false, checks: failedChecks };
		}

		return new Response(
			JSON.stringify({
				status: result.ready ? 'ready' : 'not_ready',
				checks: result.checks
			}),
			{
				status: result.ready ? 200 : 503,
				headers: {
					'cache-control': 'no-store',
					'content-type': 'application/json'
				}
			}
		);
	};
}

export const GET = _createReadinessGet(checkReadiness);
