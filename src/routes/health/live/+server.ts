import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
	new Response(JSON.stringify({ status: 'live' }), {
		status: 200,
		headers: {
			'cache-control': 'no-store',
			'content-type': 'application/json'
		}
	});
