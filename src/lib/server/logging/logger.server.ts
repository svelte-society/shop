import { redact } from '$lib/server/security/redact';

export type LogEvent = {
	level: 'info' | 'warn' | 'error';
	code: string;
	fields?: Record<string, unknown>;
};

type LogWriter = (serialized: string, level: LogEvent['level']) => void;

function defaultWriter(serialized: string, level: LogEvent['level']): void {
	console[level](serialized);
}

export function createLogger(write: LogWriter = defaultWriter): (event: LogEvent) => void {
	return (event) => {
		try {
			const code = /^[A-Z][A-Z0-9_]{1,127}$/u.test(event.code) ? event.code : 'LOG_EVENT_INVALID';
			const fields = event.fields === undefined ? {} : redact(event.fields);
			const safeFields =
				fields !== null && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
			write(JSON.stringify({ ...safeFields, level: event.level, code }), event.level);
		} catch {
			try {
				write(JSON.stringify({ level: 'error', code: 'LOG_SERIALIZATION_FAILED' }), 'error');
			} catch {
				// Logging must never break the request boundary.
			}
		}
	};
}

export const log = createLogger();
