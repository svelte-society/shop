import type { Context } from 'tmcp';

type SessionInfo = NonNullable<Context['sessionInfo']>;
type ClientInfo = SessionInfo['clientInfo'];
type ClientCapabilities = SessionInfo['clientCapabilities'];
type LogLevel = SessionInfo['logLevel'];

type SessionLimits = {
	maxInfoSessions: number;
	maxStreams: number;
	infoIdleTtlMs: number;
	streamMaxLifetimeMs: number;
};

export const MCP_SESSION_LIMITS: Readonly<SessionLimits> = Object.freeze({
	maxInfoSessions: 128,
	maxStreams: 16,
	infoIdleTtlMs: 30 * 60_000,
	streamMaxLifetimeMs: 10 * 60_000
});

type SessionManagerOptions = Partial<SessionLimits> & {
	now?: () => number;
};

type InfoEntry = {
	clientInfo?: ClientInfo;
	clientCapabilities?: ClientCapabilities;
	logLevel?: LogLevel;
	subscriptions: Set<string>;
	lastTouchedAt: number;
};

function positiveInteger(value: number, code: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
	return value;
}

class BoundedInfoSessionManager {
	readonly #entries = new Map<string, InfoEntry>();
	readonly #maxSessions: number;
	readonly #idleTtlMs: number;
	readonly #now: () => number;
	#onEvict: (id: string) => void = () => undefined;

	constructor(options: { maxSessions: number; idleTtlMs: number; now: () => number }) {
		this.#maxSessions = options.maxSessions;
		this.#idleTtlMs = options.idleTtlMs;
		this.#now = options.now;
	}

	setOnEvict(onEvict: (id: string) => void): void {
		this.#onEvict = onEvict;
	}

	#remove(id: string, evicted: boolean): void {
		if (!this.#entries.delete(id)) return;
		if (evicted) this.#onEvict(id);
	}

	#prune(now: number): void {
		for (const [id, entry] of this.#entries) {
			if (entry.lastTouchedAt + this.#idleTtlMs > now) continue;
			this.#remove(id, true);
		}
	}

	#touch(id: string, entry: InfoEntry, now: number): InfoEntry {
		entry.lastTouchedAt = now;
		this.#entries.delete(id);
		this.#entries.set(id, entry);
		return entry;
	}

	#ensure(id: string): InfoEntry {
		const now = this.#now();
		this.#prune(now);
		const current = this.#entries.get(id);
		if (current) return this.#touch(id, current, now);
		if (this.#entries.size >= this.#maxSessions) {
			const oldest = this.#entries.keys().next().value as string | undefined;
			if (oldest !== undefined) this.#remove(oldest, true);
		}
		const entry: InfoEntry = { subscriptions: new Set(), lastTouchedAt: now };
		this.#entries.set(id, entry);
		return entry;
	}

	#require(id: string): InfoEntry {
		const now = this.#now();
		this.#prune(now);
		const entry = this.#entries.get(id);
		if (!entry) throw new Error('MCP_SESSION_INFO_NOT_FOUND');
		return this.#touch(id, entry, now);
	}

	async getClientInfo(id: string): Promise<ClientInfo> {
		const value = this.#require(id).clientInfo;
		if (value === undefined) throw new Error('MCP_SESSION_INFO_NOT_FOUND');
		return value;
	}

	setClientInfo(id: string, clientInfo: ClientInfo): void {
		this.#ensure(id).clientInfo = clientInfo;
	}

	async getClientCapabilities(id: string): Promise<ClientCapabilities> {
		const value = this.#require(id).clientCapabilities;
		if (value === undefined) throw new Error('MCP_SESSION_INFO_NOT_FOUND');
		return value;
	}

	setClientCapabilities(id: string, clientCapabilities: ClientCapabilities): void {
		this.#ensure(id).clientCapabilities = clientCapabilities;
	}

	async getLogLevel(id: string): Promise<LogLevel> {
		const value = this.#require(id).logLevel;
		if (value === undefined) throw new Error('MCP_SESSION_INFO_NOT_FOUND');
		return value;
	}

	setLogLevel(id: string, logLevel: LogLevel): void {
		this.#ensure(id).logLevel = logLevel;
	}

	async getSubscriptions(uri: string): Promise<string[]> {
		this.#prune(this.#now());
		const sessions: string[] = [];
		for (const [id, entry] of this.#entries) {
			if (entry.subscriptions.has(uri)) sessions.push(id);
		}
		return sessions;
	}

	addSubscription(id: string, uri: string): void {
		this.#ensure(id).subscriptions.add(uri);
	}

	removeSubscription(id: string, uri: string): void {
		this.#require(id).subscriptions.delete(uri);
	}

	delete(id: string): void {
		this.#remove(id, false);
	}

	size(): number {
		this.#prune(this.#now());
		return this.#entries.size;
	}
}

type StreamEntry = {
	controller: ReadableStreamDefaultController;
	timer: ReturnType<typeof setTimeout>;
};

class BoundedStreamSessionManager {
	readonly #entries = new Map<string, StreamEntry>();
	readonly #maxStreams: number;
	readonly #maxLifetimeMs: number;
	#onDelete: (id: string) => void = () => undefined;
	readonly #encoder = new TextEncoder();

	constructor(options: { maxStreams: number; maxLifetimeMs: number }) {
		this.#maxStreams = options.maxStreams;
		this.#maxLifetimeMs = options.maxLifetimeMs;
	}

	setOnDelete(onDelete: (id: string) => void): void {
		this.#onDelete = onDelete;
	}

	create(id: string, controller: ReadableStreamDefaultController): void {
		if (this.#entries.has(id)) throw new Error('MCP_STREAM_ALREADY_EXISTS');
		if (this.#entries.size >= this.#maxStreams) {
			const oldest = this.#entries.keys().next().value as string | undefined;
			if (oldest !== undefined) this.delete(oldest);
		}
		const timer = setTimeout(() => this.delete(id), this.#maxLifetimeMs);
		timer.unref?.();
		this.#entries.set(id, { controller, timer });
	}

	delete(id: string): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		this.#entries.delete(id);
		clearTimeout(entry.timer);
		try {
			entry.controller.close();
		} catch {
			// The response consumer may have already closed the controller.
		}
		this.#onDelete(id);
	}

	has(id: string): boolean {
		return this.#entries.has(id);
	}

	send(sessions: string[] | undefined, data: string): void {
		const encoded = this.#encoder.encode(data);
		for (const [id, entry] of [...this.#entries]) {
			if (sessions !== undefined && !sessions.includes(id)) continue;
			try {
				entry.controller.enqueue(encoded);
			} catch {
				this.delete(id);
			}
		}
	}

	size(): number {
		return this.#entries.size;
	}
}

export type BoundedMcpSessionManagers = {
	info: BoundedInfoSessionManager;
	streams: BoundedStreamSessionManager;
};

export function createBoundedMcpSessionManagers(
	options: SessionManagerOptions = {}
): BoundedMcpSessionManagers {
	const maxInfoSessions = positiveInteger(
		options.maxInfoSessions ?? MCP_SESSION_LIMITS.maxInfoSessions,
		'MCP_MAX_INFO_SESSIONS_INVALID'
	);
	const maxStreams = positiveInteger(
		options.maxStreams ?? MCP_SESSION_LIMITS.maxStreams,
		'MCP_MAX_STREAMS_INVALID'
	);
	const infoIdleTtlMs = positiveInteger(
		options.infoIdleTtlMs ?? MCP_SESSION_LIMITS.infoIdleTtlMs,
		'MCP_INFO_TTL_INVALID'
	);
	const streamMaxLifetimeMs = positiveInteger(
		options.streamMaxLifetimeMs ?? MCP_SESSION_LIMITS.streamMaxLifetimeMs,
		'MCP_STREAM_LIFETIME_INVALID'
	);
	const now = options.now ?? Date.now;
	const info = new BoundedInfoSessionManager({
		maxSessions: maxInfoSessions,
		idleTtlMs: infoIdleTtlMs,
		now
	});
	const streams = new BoundedStreamSessionManager({
		maxStreams,
		maxLifetimeMs: streamMaxLifetimeMs
	});
	info.setOnEvict((id) => streams.delete(id));
	streams.setOnDelete((id) => info.delete(id));
	return { info, streams };
}
