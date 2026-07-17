import { describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.server';

describe('structured server logger', () => {
	it('writes one redacted JSON object with stable operational fields', () => {
		const write = vi.fn();
		const log = createLogger(write);

		log({
			level: 'error',
			code: 'HTTP_REQUEST_FAILED',
			fields: {
				request_id: 'req_123',
				method: 'POST',
				pathname: '/checkout',
				status: 500,
				duration_ms: 8,
				authorization: 'Bearer private',
				email: 'private@example.test'
			}
		});

		expect(write).toHaveBeenCalledOnce();
		const serialized = write.mock.calls[0][0] as string;
		expect(JSON.parse(serialized)).toEqual({
			level: 'error',
			code: 'HTTP_REQUEST_FAILED',
			request_id: 'req_123',
			method: 'POST',
			pathname: '/checkout',
			status: 500,
			duration_ms: 8,
			authorization: '[REDACTED]',
			email: '[REDACTED]'
		});
		expect(serialized).not.toContain('private');
	});

	it('never throws when fields are cyclic or hostile', () => {
		const write = vi.fn();
		const log = createLogger(write);
		const fields: Record<string, unknown> = {};
		fields.loop = fields;

		expect(() => log({ level: 'warn', code: 'SECURITY_EVENT', fields })).not.toThrow();
		expect(write).toHaveBeenCalledOnce();
	});
});
