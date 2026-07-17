import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_SESSION_LIMITS, createBoundedMcpSessionManagers } from './session-managers.server';

function controller() {
	return {
		enqueue: vi.fn(),
		close: vi.fn(),
		error: vi.fn(),
		desiredSize: 1
	} as unknown as ReadableStreamDefaultController;
}

describe('bounded MCP session managers', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('defines conservative one-admin limits exactly', () => {
		expect(MCP_SESSION_LIMITS).toEqual({
			maxInfoSessions: 128,
			maxStreams: 16,
			infoIdleTtlMs: 30 * 60_000,
			streamMaxLifetimeMs: 10 * 60_000
		});
	});

	it('caps initialized info sessions and evicts the least-recently-used session', async () => {
		let now = 0;
		const managers = createBoundedMcpSessionManagers({
			maxInfoSessions: 2,
			maxStreams: 2,
			infoIdleTtlMs: 1_000,
			streamMaxLifetimeMs: 1_000,
			now: () => now
		});

		managers.info.setClientInfo('one', { name: 'one', version: '1' });
		managers.info.setClientCapabilities('one', {});
		now = 1;
		managers.info.setClientInfo('two', { name: 'two', version: '1' });
		await managers.info.getClientInfo('one');
		now = 2;
		managers.info.setClientInfo('three', { name: 'three', version: '1' });

		expect(managers.info.size()).toBe(2);
		await expect(managers.info.getClientInfo('two')).rejects.toThrow('MCP_SESSION_INFO_NOT_FOUND');
		await expect(managers.info.getClientInfo('one')).resolves.toMatchObject({ name: 'one' });
		await expect(managers.info.getClientInfo('three')).resolves.toMatchObject({ name: 'three' });
	});

	it('expires idle info and removes all per-session metadata', async () => {
		let now = 0;
		const managers = createBoundedMcpSessionManagers({
			maxInfoSessions: 2,
			maxStreams: 2,
			infoIdleTtlMs: 100,
			streamMaxLifetimeMs: 1_000,
			now: () => now
		});
		managers.info.setClientInfo('stale', { name: 'private-person', version: '1' });
		managers.info.setClientCapabilities('stale', { experimental: { privateToken: true } });
		managers.info.setLogLevel('stale', 'debug');
		managers.info.addSubscription('stale', 'private://resource');

		now = 101;

		await expect(managers.info.getClientInfo('stale')).rejects.toThrow(
			'MCP_SESSION_INFO_NOT_FOUND'
		);
		expect(managers.info.size()).toBe(0);
		expect(await managers.info.getSubscriptions('private://resource')).toEqual([]);
	});

	it('caps active streams, closes the oldest deterministically, and preserves one per session', async () => {
		const managers = createBoundedMcpSessionManagers({
			maxInfoSessions: 4,
			maxStreams: 2,
			infoIdleTtlMs: 1_000,
			streamMaxLifetimeMs: 1_000
		});
		const first = controller();
		const second = controller();
		const third = controller();

		await managers.streams.create('one', first);
		await managers.streams.create('two', second);
		await managers.streams.create('three', third);

		expect(managers.streams.size()).toBe(2);
		expect(first.close).toHaveBeenCalledOnce();
		expect(second.close).not.toHaveBeenCalled();
		expect(await managers.streams.has('one')).toBe(false);
		expect(await managers.streams.has('two')).toBe(true);
		expect(await managers.streams.has('three')).toBe(true);
		expect(() => managers.streams.create('two', controller())).toThrow('MCP_STREAM_ALREADY_EXISTS');
	});

	it('closes a matching active stream when info-cap eviction removes its session', () => {
		const managers = createBoundedMcpSessionManagers({
			maxInfoSessions: 1,
			maxStreams: 2,
			infoIdleTtlMs: 1_000,
			streamMaxLifetimeMs: 1_000
		});
		const evicted = controller();
		managers.info.setClientInfo('oldest', { name: 'oldest', version: '1' });
		managers.streams.create('oldest', evicted);

		managers.info.setClientInfo('replacement', { name: 'replacement', version: '1' });

		expect(evicted.close).toHaveBeenCalledOnce();
		expect(managers.streams.size()).toBe(0);
		expect(managers.info.size()).toBe(1);
	});

	it('enforces the stream maximum lifetime and cross-cleans session info', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const managers = createBoundedMcpSessionManagers({
			maxInfoSessions: 2,
			maxStreams: 2,
			infoIdleTtlMs: 10_000,
			streamMaxLifetimeMs: 100
		});
		const stream = controller();
		managers.info.setClientInfo('expiring', { name: 'client', version: '1' });
		await managers.streams.create('expiring', stream);

		await vi.advanceTimersByTimeAsync(101);

		expect(stream.close).toHaveBeenCalledOnce();
		expect(managers.streams.size()).toBe(0);
		await expect(managers.info.getClientInfo('expiring')).rejects.toThrow(
			'MCP_SESSION_INFO_NOT_FOUND'
		);
	});

	it('DELETE/cancel-style stream deletion closes the stream and removes info', async () => {
		const managers = createBoundedMcpSessionManagers({
			maxInfoSessions: 2,
			maxStreams: 2,
			infoIdleTtlMs: 1_000,
			streamMaxLifetimeMs: 1_000
		});
		const stream = controller();
		managers.info.setClientInfo('deleted', { name: 'client', version: '1' });
		await managers.streams.create('deleted', stream);

		await managers.streams.delete('deleted');

		expect(stream.close).toHaveBeenCalledOnce();
		expect(managers.streams.size()).toBe(0);
		expect(managers.info.size()).toBe(0);
	});
});
