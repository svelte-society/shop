import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

async function text(path: string): Promise<string> {
	return readFile(resolve(root, path), 'utf8');
}

describe('Coolify production package', () => {
	it('starts the adapter-node build with the pinned pnpm and Node 24 contract', async () => {
		const packageJson = JSON.parse(await text('package.json')) as {
			packageManager?: string;
			scripts?: Record<string, string>;
		};
		const dockerfile = await text('Dockerfile');

		expect(packageJson.packageManager).toBe('pnpm@10.28.1');
		expect(packageJson.scripts?.start).toBe('node build');
		expect(dockerfile).toMatch(/^FROM node:24-bookworm-slim AS base$/m);
		expect(dockerfile).toContain('corepack prepare pnpm@10.28.1 --activate');
		expect(dockerfile).toContain('RUN pnpm install --frozen-lockfile');
		expect(dockerfile).toContain('RUN pnpm build');
		expect(dockerfile).toContain('RUN pnpm prune --prod');
		expect(dockerfile).toContain('CMD ["node", "build"]');
	});

	it('runs as one non-root process with only persistent data writable', async () => {
		const dockerfile = await text('Dockerfile');

		expect(dockerfile).toContain('ENV HOST=0.0.0.0');
		expect(dockerfile).toContain('ENV PORT=3000');
		expect(dockerfile).toContain('ENV DATABASE_PATH=/data/shop.sqlite');
		expect(dockerfile).toContain('ENV TMPDIR=/data/tmp');
		expect(dockerfile).toContain('--uid 10001');
		expect(dockerfile).toContain('--gid 10001');
		expect(dockerfile).toContain('USER shop');
		expect(dockerfile).toContain('VOLUME ["/data"]');
		expect(dockerfile).toContain("fetch('http://127.0.0.1:3000/health/live')");
		expect(dockerfile).not.toMatch(/(?:RUN|CMD)\s+(?:npm|bun)\b/u);
	});

	it('excludes local state, secrets, and development-only artifacts from the image', async () => {
		const ignore = await text('.dockerignore');

		for (const pattern of [
			'.git',
			'.svelte-kit',
			'node_modules',
			'.env*',
			'!.env.example',
			'*.sqlite*',
			'*-wal',
			'*-shm',
			'coverage',
			'test-results',
			'playwright-report',
			'scripts/dev-test-catalog.mjs'
		]) {
			expect(ignore).toContain(pattern);
		}
	});

	it('tests fail-closed bootstrap, health, persistence, headers, and SIGTERM cleanup', async () => {
		const script = await text('tests/integration/docker-health.sh');

		for (const token of [
			'--env "DATABASE_BOOTSTRAP=$bootstrap"',
			'start_container "$BOOTSTRAP_CONTAINER" "$PRIMARY_VOLUME" true true',
			'start_container "$NORMAL_CONTAINER" "$PRIMARY_VOLUME" false false',
			'/health/live',
			'/health/ready',
			'10001:10001',
			'APPLICATION_SCHEDULER_STOPPED',
			'APPLICATION_DATABASE_CLOSED',
			'strict-transport-security',
			'content-security-policy',
			'SELECT COUNT(*) AS count FROM orders',
			'docker stop'
		]) {
			expect(script).toContain(token);
		}
		for (const token of [
			'SHOP_BUILD_SECRET_CANARY',
			'docker history --no-trunc',
			'--filter "volume=$PRIMARY_VOLUME"',
			'docker top'
		]) {
			expect(script).toContain(token);
		}
	});

	it('keeps the stalled-provider SIGTERM proof on host loopback and outside Docker networking', async () => {
		const packageJson = JSON.parse(await text('package.json')) as {
			scripts?: Record<string, string>;
		};
		const dockerScript = await text('tests/integration/docker-health.sh');

		expect(packageJson.scripts?.['test:shutdown']).toBe(
			'pnpm build && node tests/integration/process-shutdown.mjs'
		);
		expect(packageJson.scripts?.test).toContain('test:shutdown');
		const processScript = await text('tests/integration/process-shutdown.mjs');
		for (const token of [
			"listen(0, '127.0.0.1',",
			"spawn(process.execPath, ['build']",
			"child.kill('SIGTERM')",
			'APPLICATION_SCHEDULER_STOPPED',
			'APPLICATION_DATABASE_CLOSED',
			"database.pragma('quick_check')",
			'outbox_jobs',
			'job_leases',
			'job_runs'
		]) {
			expect(processScript).toContain(token);
		}
		for (const token of [
			'blocked-provider',
			'BLOCKED_PROVIDER_',
			'--add-host',
			'NODE_EXTRA_CA_CERTS',
			'PROVIDER_PID'
		]) {
			expect(dockerScript).not.toContain(token);
		}
		expect(dockerScript).toContain(
			'start_container "$SHUTDOWN_CONTAINER" "$PRIMARY_VOLUME" false true'
		);
		expect(dockerScript).toContain('WHERE completed_at IS NULL AND next_attempt_at <= ?');
	});

	it('publishes the shop only on host loopback for Cloudflare Tunnel', async () => {
		const compose = await text('docker-compose.coolify.yml');
		const plan = await text('docs/superpowers/plans/2026-07-19-coolify-loopback-deployment.md');

		expect(compose).toContain('dockerfile: Dockerfile');
		expect(compose).toContain('"127.0.0.1:7178:3000"');
		expect(compose).not.toMatch(/^\s*-\s*["']?7178:3000["']?\s*$/mu);
		expect(compose).toContain('shop-data:/data');
		expect(compose).toContain('stop_grace_period: 45s');
		expect(compose).toContain('HOST: 0.0.0.0');
		expect(compose).toContain('PORT: 3000');
		expect(compose).toContain('DATABASE_PATH: /data/shop.sqlite');
		expect(compose).toContain('STOREFRONT_ENABLED: ${STOREFRONT_ENABLED:-false}');
		expect(compose).toContain('CHECKOUT_ENABLED: ${CHECKOUT_ENABLED:-false}');
		expect(compose).toContain('MCP_ENABLED: ${MCP_ENABLED:-false}');
		expect(compose).toContain('SCHEDULER_ENABLED: ${SCHEDULER_ENABLED:-false}');
		expect(compose).not.toMatch(/^\s*networks:/mu);
		expect(plan).toContain(
			'rtk docker compose --env-file .env.example -f docker-compose.coolify.yml config --quiet'
		);
		expect(plan).not.toContain(
			'rtk docker compose --env-file .env.test -f docker-compose.coolify.yml config --quiet'
		);
	});

	it('documents the Cloudflare Tunnel loopback handoff without a static CSP override', async () => {
		const runbook = await text('docs/operations/coolify.md');

		for (const token of [
			'shop.sveltesociety.dev',
			'ORIGIN=https://shop.sveltesociety.dev',
			'ADDRESS_HEADER=X-Forwarded-For',
			'XFF_DEPTH',
			'DATABASE_BOOTSTRAP=true',
			'DATABASE_BOOTSTRAP=false',
			'/data',
			'10001:10001',
			'http://localhost:7178',
			'127.0.0.1:7178:3000',
			'docker-compose.coolify.yml',
			'https://coolify.io/docs/applications/build-packs/docker-compose',
			'https://coolify.io/docs/knowledge-base/persistent-storage',
			'https://coolify.io/docs/knowledge-base/health-checks'
		]) {
			expect(runbook).toContain(token);
		}
		for (const token of [
			'curl --fail --silent --show-error --connect-timeout 5 --max-time 20',
			'-D "$VERIFY_DIR/html.headers"',
			'-o "$VERIFY_DIR/index.html"',
			'ASSET_PATH="$(grep -Eo',
			'case "$ASSET_PATH" in',
			'ASSET_URL="https://shop.sveltesociety.dev$ASSET_PATH"',
			'-D "$VERIFY_DIR/asset.headers"',
			'"$ASSET_URL"',
			'for HEADERS in "$VERIFY_DIR/html.headers" "$VERIFY_DIR/asset.headers"',
			'assert_header "$HEADERS" strict-transport-security',
			'max-age=31536000; includeSubDomains',
			'assert_header "$HEADERS" x-content-type-options nosniff',
			'assert_header "$HEADERS" x-frame-options DENY',
			'assert_header "$HEADERS" referrer-policy strict-origin-when-cross-origin',
			'assert_header "$HEADERS" permissions-policy',
			'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()',
			'tolower(actual) == tolower(expected)',
			'header_value "$VERIFY_DIR/html.headers" content-security-policy',
			"'nonce-[A-Za-z0-9+/_=-]+'",
			'grep -Fqi "\'unsafe-inline\'"'
		]) {
			expect(runbook).toContain(token);
		}
		expect(
			runbook.match(/curl --fail --silent --show-error --connect-timeout 5 --max-time 20/gu)
		).toHaveLength(2);
		expect(runbook).toContain('nonce');
		expect(runbook).not.toMatch(/middlewares\.[^.]+\.headers\.contentSecurityPolicy/u);
	});

	it('documents runtime-only secrets and stop-first single-volume deployment', async () => {
		const runbook = await text('docs/operations/coolify.md');
		for (const name of [
			'STRIPE_SECRET_KEY',
			'STRIPE_WEBHOOK_SECRET',
			'STYRIA_APP_ID',
			'STYRIA_SECRET_KEY',
			'PLUNK_SECRET_KEY',
			'MCP_BEARER_TOKEN',
			'S3_ACCESS_KEY_ID',
			'S3_SECRET_ACCESS_KEY',
			'BACKUP_ENCRYPTION_KEY_BASE64'
		]) {
			expect(runbook).toMatch(new RegExp(`\\| ${name} \\| Secret \\| OFF \\| ON \\|`));
		}
		for (const token of [
			'Build Secrets',
			'BuildKit',
			'automatic deployments',
			'webhook deployments',
			'45s',
			'docker ps --filter "volume=$VOLUME_NAME"',
			'exactly one'
		]) {
			expect(runbook).toContain(token);
		}
	});
});
