# Coolify Loopback Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision a dedicated Coolify project and one Svelte Society Shop application reachable only from the Coolify host at `http://localhost:7178` for Cloudflare Tunnel forwarding.

**Architecture:** Keep the Node container listening on `0.0.0.0:3000`. A repository-owned Docker Compose definition builds the existing Dockerfile, binds `127.0.0.1:7178:3000`, and mounts one named volume at `/data`. Coolify receives no domain and does not deploy until the reviewed repository and required runtime secrets exist.

**Tech Stack:** Coolify 4.1.2 REST API, Docker Compose, Dockerfile, Node 24, pnpm 10.28.1, SvelteKit adapter-node, SQLite, Cloudflare Tunnel, Vitest.

## Global Constraints

- Use Node `>=24 <25` and pnpm `10.28.1`; never use npm or Bun.
- Never use Smerch.
- Project name is exactly `Svelte Society Shop`; environment is exactly `production`.
- Container listens on `0.0.0.0:3000`; host publishes only `127.0.0.1:7178:3000`.
- Cloudflare Tunnel origin is exactly `http://localhost:7178`.
- Run exactly one application container and one Node process against one `/data` volume.
- Keep `STOREFRONT_ENABLED`, `CHECKOUT_ENABLED`, `MCP_ENABLED`, and `SCHEDULER_ENABLED` false during initial deployment.
- Keep `TEST_CATALOG_FIXTURE=false` outside local fixture previews.
- Keep every secret runtime-only. Never write the Coolify API token, Stripe keys, Plunk keys, Styria keys, MCP token, withdrawal key, or backup key to Git, plan files, shell history, logs, or API response files.
- Use Coolify project/application API mutations only after exact-name/UUID preflight checks.
- Do not create or deploy the Coolify application until `https://github.com/svelte-society/shop` exists and `main` contains the reviewed commits.

---

### Task 1: Add the loopback Docker Compose deployment contract

**Files:**
- Create: `docker-compose.coolify.yml`
- Modify: `tests/integration/coolify-package.spec.ts`
- Modify: `docs/operations/coolify.md`

**Interfaces:**
- Consumes: existing `Dockerfile`, `.env.example`, `/health/live`, `/health/ready`, and `/data/shop.sqlite` runtime contract.
- Produces: `docker-compose.coolify.yml`, the source file Coolify loads with build pack `dockercompose`.

- [ ] **Step 1: Write the failing Compose contract test**

Add this test inside `describe('Coolify production package', ...)` in `tests/integration/coolify-package.spec.ts`:

```ts
it('publishes the shop only on host loopback for Cloudflare Tunnel', async () => {
	const compose = await text('docker-compose.coolify.yml');

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
});
```

- [ ] **Step 2: Run the test and verify the missing-file failure**

Run:

```bash
rtk pnpm vitest run --config vitest.integration.config.ts tests/integration/coolify-package.spec.ts
```

Expected: FAIL because `docker-compose.coolify.yml` does not exist.

- [ ] **Step 3: Create the Compose definition**

Create `docker-compose.coolify.yml` with this exact content:

```yaml
services:
  shop:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    stop_grace_period: 45s
    ports:
      - "127.0.0.1:7178:3000"
    volumes:
      - shop-data:/data
    environment:
      HOST: 0.0.0.0
      PORT: 3000
      ORIGIN: ${ORIGIN}
      PRODUCTION_ORIGIN: ${PRODUCTION_ORIGIN}
      HOST_ALLOWLIST: ${HOST_ALLOWLIST}
      ADDRESS_HEADER: ${ADDRESS_HEADER:-X-Forwarded-For}
      XFF_DEPTH: ${XFF_DEPTH}
      BODY_SIZE_LIMIT: ${BODY_SIZE_LIMIT:-1M}
      SHUTDOWN_TIMEOUT: ${SHUTDOWN_TIMEOUT:-30}
      TMPDIR: /data/tmp
      STOREFRONT_ENABLED: ${STOREFRONT_ENABLED:-false}
      CHECKOUT_ENABLED: ${CHECKOUT_ENABLED:-false}
      MCP_ENABLED: ${MCP_ENABLED:-false}
      SCHEDULER_ENABLED: ${SCHEDULER_ENABLED:-false}
      TEST_CATALOG_FIXTURE: ${TEST_CATALOG_FIXTURE:-false}
      SUPPORT_EMAIL: ${SUPPORT_EMAIL}
      ADMIN_EMAIL: ${ADMIN_EMAIL}
      STRIPE_SECRET_KEY: ${STRIPE_SECRET_KEY:-}
      STRIPE_WEBHOOK_SECRET: ${STRIPE_WEBHOOK_SECRET:-}
      STRIPE_PAID_SHIPPING_RATE_ID: ${STRIPE_PAID_SHIPPING_RATE_ID:-}
      STRIPE_FREE_SHIPPING_RATE_ID: ${STRIPE_FREE_SHIPPING_RATE_ID:-}
      DATABASE_PATH: /data/shop.sqlite
      DATABASE_BOOTSTRAP: ${DATABASE_BOOTSTRAP:-false}
      WITHDRAWAL_DATA_KEY: ${WITHDRAWAL_DATA_KEY}
      MCP_BEARER_TOKEN: ${MCP_BEARER_TOKEN:-}
      STYRIA_APP_ID: ${STYRIA_APP_ID:-}
      STYRIA_SECRET_KEY: ${STYRIA_SECRET_KEY:-}
      STYRIA_BASE_URL: ${STYRIA_BASE_URL:-https://styriashirts.eu}
      STYRIA_TIMEOUT_MS: ${STYRIA_TIMEOUT_MS:-10000}
      STYRIA_BRAND_NAME: ${STYRIA_BRAND_NAME:-Svelte Society}
      PLUNK_SECRET_KEY: ${PLUNK_SECRET_KEY}
      PLUNK_BASE_URL: ${PLUNK_BASE_URL:-https://next-api.useplunk.com}
      PLUNK_FROM_NAME: ${PLUNK_FROM_NAME:-Svelte Society Shop}
      PLUNK_FROM_EMAIL: ${PLUNK_FROM_EMAIL}
      S3_ENDPOINT: ${S3_ENDPOINT:-}
      S3_BUCKET: ${S3_BUCKET:-}
      S3_REGION: ${S3_REGION:-eu-north-1}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:-}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:-}
      S3_PREFIX: ${S3_PREFIX:-svelte-society-shop}
      S3_FORCE_PATH_STYLE: ${S3_FORCE_PATH_STYLE:-false}
      BACKUP_ENCRYPTION_KEY_BASE64: ${BACKUP_ENCRYPTION_KEY_BASE64:-}
      UMAMI_SCRIPT_URL: ${UMAMI_SCRIPT_URL:-}
      UMAMI_CONNECT_ORIGIN: ${UMAMI_CONNECT_ORIGIN:-}
      UMAMI_WEBSITE_ID: ${UMAMI_WEBSITE_ID:-}
      CATALOG_IMAGE_ORIGINS: ${CATALOG_IMAGE_ORIGINS:-}
      SOCIETY_ASSET_ORIGINS: ${SOCIETY_ASSET_ORIGINS:-}
      SELLER_LEGAL_NAME: ${SELLER_LEGAL_NAME}
      SELLER_REGISTRATION_NUMBER: ${SELLER_REGISTRATION_NUMBER}
      SELLER_VAT_NUMBER: ${SELLER_VAT_NUMBER}
      SELLER_ADDRESS_LINE1: ${SELLER_ADDRESS_LINE1}
      SELLER_POSTAL_CODE: ${SELLER_POSTAL_CODE}
      SELLER_CITY: ${SELLER_CITY}
      SELLER_COUNTRY: ${SELLER_COUNTRY:-Sweden}
      SELLER_EMAIL: ${SELLER_EMAIL}
      DELIVERY_ESTIMATE_EU: ${DELIVERY_ESTIMATE_EU}
      DELIVERY_ESTIMATE_US: ${DELIVERY_ESTIMATE_US}
      POLICY_EFFECTIVE_DATE: ${POLICY_EFFECTIVE_DATE}

volumes:
  shop-data:
```

- [ ] **Step 4: Validate Compose syntax**

Run:

```bash
rtk docker compose --env-file .env.test -f docker-compose.coolify.yml config --quiet
```

Expected: exit `0`. Missing production-only values may render as empty test values; no secret may appear in output because `--quiet` prints nothing.

- [ ] **Step 5: Replace obsolete routing assertions with the Cloudflare loopback contract**

In `tests/integration/coolify-package.spec.ts`, change the documentation test to require these tokens:

```ts
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
```

Rename the final test to `documents runtime-only secrets and stop-first single-volume deployment`, retain its secret-table assertions, and remove requirements for `immutable image`, Traefik router labels, and Docker Image resource wording.

- [ ] **Step 6: Update the Coolify runbook**

Replace the opening resource settings in `docs/operations/coolify.md` with:

```markdown
## Resource settings

- Project: `Svelte Society Shop`; environment: `production`.
- Source: `https://github.com/svelte-society/shop`, branch `main`.
- Build pack: Docker Compose; file: `/docker-compose.coolify.yml`.
- Server: Coolify `localhost`.
- Domain: leave empty. Cloudflare Tunnel owns public routing.
- Container port: `3000`; host binding: `127.0.0.1:7178:3000`.
- Cloudflare Tunnel origin: `http://localhost:7178`.
- Replicas: exactly `1`; never scale the `shop` service.
- Auto deploy: off. Deploy only through the stop-first procedure.
- Persistent storage: Compose volume `shop-data` mounted at `/data`.
- Stop grace period: `45s`; adapter-node uses `SHUTDOWN_TIMEOUT=30`.
- Container health: the Dockerfile healthcheck calls `GET /health/live`.
- Deployment gate: `GET https://shop.sveltesociety.dev/health/ready` returns `200`.
```

Replace the Traefik static-header section with a `Cloudflare Tunnel and headers` section that states:

````markdown
## Cloudflare Tunnel and headers

Cloudflare Tunnel runs directly on the Coolify host and forwards
`shop.sveltesociety.dev` to `http://localhost:7178`. The Compose mapping binds
port `7178` only to `127.0.0.1`; do not change it to `7178:3000` or add a
Coolify domain.

Dynamic HTML retains the application's nonce-bearing CSP. Because this path
bypasses Coolify Traefik, configure Cloudflare response-header transforms for
static assets to add HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, the strict referrer policy, and the permissions policy.
Do not add or overwrite Content-Security-Policy at Cloudflare.

On the Coolify host, verify:

```sh
curl --fail http://localhost:7178/health/live
ss -ltnp | grep '127.0.0.1:7178'
! ss -ltnp | grep -E '(^|[[:space:]])(0\.0\.0\.0|\[::\]):7178'
```
````

Update deployment and rollback language to use the reviewed `main` commit and Compose resource while retaining the stop-first zero-container volume ownership checks.

- [ ] **Step 7: Run focused tests**

Run:

```bash
rtk pnpm vitest run --config vitest.integration.config.ts tests/integration/coolify-package.spec.ts
rtk pnpm check
```

Expected: both exit `0`.

- [ ] **Step 8: Commit the Compose contract**

```bash
rtk git add docker-compose.coolify.yml tests/integration/coolify-package.spec.ts docs/operations/coolify.md
rtk git commit -m "feat: add Coolify loopback deployment"
```

### Task 2: Publish the reviewed repository

**Files:**
- Modify: local Git configuration only; no tracked file changes.

**Interfaces:**
- Consumes: clean `main` containing Task 1.
- Produces: public repository `https://github.com/svelte-society/shop`, remote name `origin`, and pushed `main`.

- [ ] **Step 1: Verify repository scope and clean state**

```bash
rtk git status --short --branch
rtk gh auth status
rtk gh repo view svelte-society/shop --json nameWithOwner,isPrivate,url,defaultBranchRef
```

Expected: worktree clean. Repository either exists as public or `gh repo view` reports not found. If authentication reports `not repo-scoped`, stop and obtain GitHub repository scope; do not create a personal fallback repository.

- [ ] **Step 2: Create the public organization repository when absent**

```bash
rtk gh repo create svelte-society/shop \
  --public \
  --description "Standalone Svelte Society merchandise shop" \
  --source . \
  --remote origin
```

Expected: repository URL `https://github.com/svelte-society/shop`. If it already exists, use `rtk git remote add origin git@github.com:svelte-society/shop.git` instead.

- [ ] **Step 3: Push reviewed main**

```bash
rtk git push --set-upstream origin main
rtk gh repo view svelte-society/shop --json nameWithOwner,isPrivate,url,defaultBranchRef
```

Expected: `isPrivate` is `false`; default branch points to `main`; remote main contains the local HEAD.

### Task 3: Create the idempotent Coolify project

**Files:**
- None. External Coolify state only.

**Interfaces:**
- Consumes: `COOLIFY_API_TOKEN` supplied only through the protected process environment.
- Produces: Coolify project `Svelte Society Shop`, one `production` environment, and recorded project/environment UUIDs.

- [ ] **Step 1: Load and validate the token without printing it**

In a protected interactive shell, export `COOLIFY_API_TOKEN`, then run:

```bash
rtk zsh -lc ': "${COOLIFY_API_TOKEN:?COOLIFY_API_TOKEN must be set}"'
```

Expected: exit `0` and no output. Never place the token literal in a command, file, commit, or captured log.

- [ ] **Step 2: Check for an exact existing project before mutation**

```bash
rtk zsh -lc '
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    https://coolify.sveltesociety.dev/api/v1/projects |
  node --input-type=module --eval '\''
    let body = "";
    for await (const chunk of process.stdin) body += chunk;
    const matches = JSON.parse(body).filter((project) => project.name === "Svelte Society Shop");
    if (matches.length > 1) process.exit(2);
    if (matches.length === 1) process.stdout.write(`${matches[0].uuid}\n`);
  '\''
'
```

Expected: no output when absent, or exactly one project UUID. Exit `2` means duplicate state; stop for manual reconciliation.

- [ ] **Step 3: Create the project only when absent**

```bash
rtk zsh -lc '
  curl --fail --silent --show-error \
    --request POST \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '\''{"name":"Svelte Society Shop","description":"Standalone Svelte Society merchandise shop"}'\'' \
    https://coolify.sveltesociety.dev/api/v1/projects
'
```

Expected when created: HTTP `201` JSON containing one project UUID. Skip this step when Step 2 found an existing exact match.

- [ ] **Step 4: Verify the production environment**

Use the project UUID returned or discovered above:

```bash
rtk zsh -lc '
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    "https://coolify.sveltesociety.dev/api/v1/projects/$COOLIFY_PROJECT_UUID/environments"
'
```

Expected: exactly one environment named `production`. If absent, create it with:

```bash
rtk zsh -lc '
  curl --fail --silent --show-error \
    --request POST \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '\''{"name":"production"}'\'' \
    "https://coolify.sveltesociety.dev/api/v1/projects/$COOLIFY_PROJECT_UUID/environments"
'
```

Expected: HTTP `201` with one environment UUID. Export it as `COOLIFY_ENVIRONMENT_UUID` without writing it to a tracked file.

- [ ] **Step 5: Verify through the Coolify MCP**

Call `mcp__coolify__list_projects` and confirm one project named `Svelte Society Shop`. Record only project/environment UUIDs in the operator handoff; do not record the API token.

### Task 4: Create the Coolify application and verify the loopback origin

**Files:**
- None. External Coolify and host state only.

**Interfaces:**
- Consumes: public Git repository, Coolify project/environment UUIDs, server UUID `uw888w8`, and production values matching `.env.example`.
- Produces: undeployed application `Svelte Society Shop`, then one healthy deployed container reachable at `http://localhost:7178` after secrets are supplied.

- [ ] **Step 1: Create the application without deploying it**

Preflight `mcp__coolify__list_applications` for an exact name and repository match. When absent, run:

```bash
rtk zsh -lc '
  payload="$(node --input-type=module --eval '\''
    process.stdout.write(JSON.stringify({
      project_uuid: process.env.COOLIFY_PROJECT_UUID,
      server_uuid: "uw888w8",
      environment_name: "production",
      environment_uuid: process.env.COOLIFY_ENVIRONMENT_UUID,
      git_repository: "https://github.com/svelte-society/shop",
      git_branch: "main",
      build_pack: "dockercompose",
      ports_exposes: "3000",
      name: "Svelte Society Shop",
      description: "Standalone Svelte Society merchandise shop",
      domains: "",
      autogenerate_domain: false,
      is_auto_deploy_enabled: false,
      instant_deploy: false,
      docker_compose_location: "/docker-compose.coolify.yml"
    }));
  '\'')"
  curl --fail --silent --show-error \
    --request POST \
    -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    https://coolify.sveltesociety.dev/api/v1/applications/public
'
```

Expected: HTTP `201` with one application UUID. Export it as `COOLIFY_APPLICATION_UUID`. Do not deploy yet.

- [ ] **Step 2: Verify application configuration**

Call `mcp__coolify__get_application` with the application UUID.

Expected: name `Svelte Society Shop`, build pack `dockercompose`, repository `https://github.com/svelte-society/shop`, branch `main`, no FQDN/domain, and status stopped or exited.

- [ ] **Step 3: Configure runtime values in Coolify**

Use `.env.example` as the name inventory. Set non-secret values in Coolify and lock every secret as runtime-only. At minimum, complete every startup requirement before first bootstrap: database path/bootstrap flag, public origin/host values, four feature flags, support email, withdrawal key, seller identity/policy values, Plunk values, and the deployed Stripe endpoint signing secret required by readiness. Add the Stripe server key and shipping-rate IDs, Styria, S3, and MCP secrets only when their associated launch gates are ready.

Expected: no empty value among variables required unconditionally by `src/lib/server/app.server.ts`; all four commerce flags remain false.

- [ ] **Step 4: Bootstrap the SQLite volume**

Set `DATABASE_BOOTSTRAP=true`, deploy once, verify `/data/shop.sqlite` exists and is owned by `10001:10001`, then stop. Set `DATABASE_BOOTSTRAP=false` and deploy the same commit again.

Expected: one container only; `/health/live` returns `200`; `/health/ready` returns `200` after the second deployment.

Restart the application once without changing the volume, then verify `/health/ready` still returns `200` and `/data/shop.sqlite` retains the same inode and nonzero size.

- [ ] **Step 5: Verify host-only reachability on the Coolify server**

Run in the Coolify host console:

```bash
curl --fail --silent --show-error http://localhost:7178/health/live
ss -ltnp | grep '127.0.0.1:7178'
! ss -ltnp | grep -E '(^|[[:space:]])(0\.0\.0\.0|\[::\]):7178'
```

Expected: liveness body returned; first socket check matches loopback; public-interface check exits `0` because it finds nothing.

- [ ] **Step 6: Configure and verify Cloudflare Tunnel**

Set the `shop.sveltesociety.dev` tunnel service to `http://localhost:7178`. Keep Coolify domain empty.

Run:

```bash
curl --fail --silent --show-error https://shop.sveltesociety.dev/health/live
curl --fail --silent --show-error https://shop.sveltesociety.dev/health/ready
```

Expected: both return `200`; storefront remains disabled.

- [ ] **Step 7: Run final local verification and record handoff**

```bash
rtk pnpm lint
rtk pnpm check
rtk pnpm test:integration
rtk pnpm build
rtk git status --short --branch
```

Expected: every command exits `0`; worktree clean. Record project, environment, and application UUIDs plus the deployed Git commit. Rotate the Coolify API token supplied through chat and update any authorized automation that still needs access.
