# Coolify deployment

This service runs as one adapter-node process and one Coolify replica. SQLite is
the fulfillment system of record, so two application processes must never share
the volume. Coolify application deployments normally use a rolling overlap when
health checks pass; there is no rolling-update toggle assumed by this runbook.
Production therefore uses the stop-first Compose procedure below.

The relevant current Coolify references are the official guides for the
[Docker Compose build pack](https://coolify.io/docs/applications/build-packs/docker-compose),
[environment variables](https://coolify.io/docs/knowledge-base/environment-variables),
[persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage),
[health checks](https://coolify.io/docs/knowledge-base/health-checks), and
[rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates).

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

The image runs as UID/GID `10001:10001`. A newly created named volume is seeded
from the image's `/data` directory with the correct ownership. For an existing
bind mount, stop the application and set its host directory recursively to
`10001:10001` before starting the container. Never make `/app` writable. In a
Coolify console, verify:

```sh
id
stat -c '%u:%g %a %n' /data /data/tmp /data/shop.sqlite
test -w /data
test ! -w /app
```

## Environment

Store secret values as locked Coolify secrets. Coolify enables both Build
Variable and Runtime Variable for new values by default, so explicitly change
every row below to runtime-only in Normal view. Keep `.env.example` as the
authoritative name inventory.

| Name | Storage | Build Variable | Runtime Variable | Purpose |
| --- | --- | --- | --- | --- |
| STRIPE_SECRET_KEY | Secret | OFF | ON | Stripe server API |
| STRIPE_WEBHOOK_SECRET | Secret | OFF | ON | Stripe webhook verification |
| STYRIA_APP_ID | Secret | OFF | ON | Styria API identity |
| STYRIA_SECRET_KEY | Secret | OFF | ON | Styria request signing |
| PLUNK_SECRET_KEY | Secret | OFF | ON | Plunk email API |
| WITHDRAWAL_DATA_KEY | Secret | OFF | ON | Withdrawal PII encryption and receipt sessions |
| MCP_BEARER_TOKEN | Secret | OFF | ON | Internal MCP bearer authentication |
| S3_ACCESS_KEY_ID | Secret | OFF | ON | Encrypted backup storage |
| S3_SECRET_ACCESS_KEY | Secret | OFF | ON | Encrypted backup storage |
| BACKUP_ENCRYPTION_KEY_BASE64 | Secret | OFF | ON | AES-256-GCM backup encryption |

Never pass a real secret with `--build-arg`; Coolify documents that build args
can be recorded in image metadata. This application does not need secrets while
building. If a future build genuinely needs one, enable Coolify **Build Secrets**
with Docker **BuildKit**, consume the ephemeral secret mount, and keep Runtime
Variable off unless the running application also needs it. Do not fall back to
build args if BuildKit is unavailable.

Before publishing an image, run the non-secret canary check below. The same
check is automated by `tests/integration/docker-health.sh`:

```sh
IMAGE=shop-build-canary:test
SHOP_BUILD_SECRET_CANARY=not-a-secret-build-canary-value
docker build --build-arg SHOP_BUILD_SECRET_CANARY="$SHOP_BUILD_SECRET_CANARY" -t "$IMAGE" .
if { docker image inspect "$IMAGE"; docker history --no-trunc "$IMAGE"; } |
  grep -F "$SHOP_BUILD_SECRET_CANARY"; then
  echo 'Build canary leaked into image config or history' >&2
  exit 1
fi
```

### Runtime, routing, and feature flags

```text
HOST=0.0.0.0
PORT=3000
ORIGIN=https://shop.sveltesociety.dev
PRODUCTION_ORIGIN=https://shop.sveltesociety.dev
HOST_ALLOWLIST=shop.sveltesociety.dev
ADDRESS_HEADER=X-Forwarded-For
XFF_DEPTH=<operator-verified-positive-integer>
BODY_SIZE_LIMIT=1M
SHUTDOWN_TIMEOUT=30
TMPDIR=/data/tmp
STOREFRONT_ENABLED=false
CHECKOUT_ENABLED=false
MCP_ENABLED=false
SCHEDULER_ENABLED=false
TEST_CATALOG_FIXTURE=false
SUPPORT_EMAIL=merch@sveltesociety.dev
ADMIN_EMAIL=merch@sveltesociety.dev
```

`ADDRESS_HEADER=X-Forwarded-For` delegates address parsing to adapter-node. The
application does not parse `X-Forwarded-For`. Determine `XFF_DEPTH` from the
right side of the received chain: it is the verified number of trusted proxies
between the public client and Node, not a guessed constant. Send a request from
a known external address, inspect Cloudflare Tunnel's forwarding chain and the
app's rate-limit/log address, and confirm the selected address is the known
client. Repeat after any Cloudflare Tunnel/CDN topology change. Never trust a
leftmost value supplied by the client.

### SQLite

```text
DATABASE_PATH=/data/shop.sqlite
DATABASE_BOOTSTRAP=false
```

`DATABASE_BOOTSTRAP` is an explicit one-time switch, not a migration toggle for
normal deployments. Normal releases and every rollback use `false`. With
`false`, a missing database fails readiness and is not recreated.

### Withdrawal encryption

Generate a fresh production key in a protected operator shell, then paste only its output into the
locked, runtime-only `WITHDRAWAL_DATA_KEY` secret:

```sh
node --input-type=module --eval "import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64') + '\n')"
```

```text
WITHDRAWAL_DATA_KEY=<canonical-base64-for-exactly-32-random-bytes>
```

This is the version-1 application data key. It encrypts withdrawal customer and reconciliation
payloads and derives short-lived receipt-session authentication. It is not the backup key:
`BACKUP_ENCRYPTION_KEY_BASE64` must be generated independently and stored separately. Preserve the
withdrawal key in the production secret store and protected recovery inventory for as long as any
active withdrawal payload can exist in live data or retained backups.

Version 1 has no online key rotation or key identifier migration workflow. A future rotation must
first ship a reviewed offline or dual-key migration and prove active-case and backup recovery; do
not replace this value in place. Losing it permanently makes every unpurged withdrawal payload in
the live database and backups undecryptable. Neither the public reference nor the encrypted backup
key can recover that data.

### Stripe

```text
STRIPE_SECRET_KEY=<secret>
STRIPE_WEBHOOK_SECRET=<secret>
STRIPE_PAID_SHIPPING_RATE_ID=<shipping-rate-id>
STRIPE_FREE_SHIPPING_RATE_ID=<shipping-rate-id>
```

### Internal MCP

```text
MCP_BEARER_TOKEN=<64-lowercase-hex-secret>
```

Keep `MCP_ENABLED=false` until the production MCP verification gate is complete.
Rotate the Coolify value and the Codex host value together.

### Styria

```text
STYRIA_APP_ID=<secret>
STYRIA_SECRET_KEY=<secret>
STYRIA_BASE_URL=https://styriashirts.eu
STYRIA_TIMEOUT_MS=10000
STYRIA_BRAND_NAME=Svelte Society
STYRIA_SUPPORTED_COUNTRIES=<reviewed-uppercase-comma-separated-ISO-alpha-2-list>
```

The initial reviewed value is the EU except Slovenia plus the supported Asian destinations listed
in `docs/superpowers/specs/2026-07-19-styria-supported-asia-destinations-design.md`. Keep `US` absent
while Styria marks that route unavailable.

### Plunk

```text
PLUNK_SECRET_KEY=<secret>
PLUNK_BASE_URL=https://next-api.useplunk.com
PLUNK_FROM_NAME=Svelte Society Shop
PLUNK_FROM_EMAIL=merch@sveltesociety.dev
```

### Backup storage

The enabled scheduler requires these encrypted-backup values:

```text
S3_ENDPOINT=<https-endpoint>
S3_BUCKET=<bucket>
S3_REGION=eu-north-1
S3_ACCESS_KEY_ID=<secret>
S3_SECRET_ACCESS_KEY=<secret>
S3_PREFIX=svelte-society-shop
S3_FORCE_PATH_STYLE=false
BACKUP_ENCRYPTION_KEY_BASE64=<secret>
```

Generate the backup key independently from `WITHDRAWAL_DATA_KEY`; never reuse either value for the
other purpose.

### Analytics and browser asset origins

```text
UMAMI_SCRIPT_URL=<exact-https-script-url-or-empty>
UMAMI_CONNECT_ORIGIN=<exact-https-origin-or-empty>
UMAMI_WEBSITE_ID=<site-id-or-empty>
CATALOG_IMAGE_ORIGINS=<comma-separated-exact-https-origins>
SOCIETY_ASSET_ORIGINS=<comma-separated-exact-https-origins>
```

### Seller and policy content

```text
SELLER_LEGAL_NAME=Svelte Summit AB
SELLER_REGISTRATION_NUMBER=<reviewed-value>
SELLER_VAT_NUMBER=<reviewed-value>
SELLER_ADDRESS_LINE1=<reviewed-value>
SELLER_POSTAL_CODE=<reviewed-value>
SELLER_CITY=<reviewed-value>
SELLER_COUNTRY=Sweden
SELLER_EMAIL=merch@sveltesociety.dev
DELIVERY_ESTIMATE_EU=<reviewed-value>
DELIVERY_ESTIMATE_ASIA=Production normally takes 1–5 business days, followed by roughly 6–10 business days in transit
POLICY_EFFECTIVE_DATE=<reviewed-ISO-date>
```

## Withdrawal-only rollout gate

Deploy and prove the online withdrawal function before considering a commerce launch. Keep
`STOREFRONT_ENABLED=false` and `CHECKOUT_ENABLED=false` throughout this gate; the `/withdraw` and
receipt routes remain available independently of those flags.

1. Confirm exactly one replica, one process, and the persistent `/data` volume. Set
   `WITHDRAWAL_DATA_KEY`, the seller identity, support address, and Plunk values as reviewed
   runtime variables. Leave `MCP_ENABLED=false` and `SCHEDULER_ENABLED=false` for the first route
   check.
2. Deploy stop-first. Require `GET /health/live` and `GET /health/ready` to return `200` while `/`
   remains unavailable because the storefront is off.
3. Open `/withdraw` through public HTTPS. Submit a synthetic notice through review and explicit
   confirmation, retain the submitting browser cookie, record the `WDR-…` reference, and download
   its durable receipt. Confirm another browser without that cookie cannot retrieve the receipt.
4. Restart the same reviewed `main` commit against the same `/data` volume and verify the case still
   exists. If enabling internal MCP for operator verification, set one fresh bearer token, restart
   stop-first, and prove authenticated `list_withdrawal_cases` and `inspect_withdrawal_case`; then
   disable it again unless the reviewed operational workflow requires it.
5. Inspect only PII-free aggregate state and structured logs. A Plunk outage may leave the receipt
   queued, but must not remove the accepted case or browser receipt. Follow
   [withdrawal operations](withdrawals.md) for reconciliation and resend.

This gate proves route availability and storage safety only. It does not constitute legal or
accounting approval and does not authorize changing `CHECKOUT_ENABLED`.

## First-volume bootstrap

Use this sequence only for an empty production volume:

1. Create and mount the named volume at `/data`. Keep all four commerce flags
   off and set `DATABASE_BOOTSTRAP=true`.
2. Start one container. Request `/health/live` and expect `200`; request
   `/health/ready` and expect `503`. That red readiness is intentional. The app
   creates `/data/shop.sqlite`, applies migrations, and does not start the
   scheduler or accept checkout.
3. Verify `/data/shop.sqlite` exists, is owned by `10001:10001`, and the logs do
   not report an active scheduler. Stop the container cleanly.
4. Change to `DATABASE_BOOTSTRAP=false` and redeploy the same reviewed `main`
   commit against the same volume. Readiness must become `200` before any
   feature flag is enabled.

Never leave bootstrap set to `true`, and never use it to recover a missing
volume. If a normal or rollback container reports a missing database, keep it
out of service and restore or reattach the correct volume.

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

After deployment and every rollback, run the repository-owned Node 24 verifier:

```sh
pnpm verify:public-headers
```

The verifier uses Node's raw HTTP response headers and exits nonzero on any
failure. Connection time is bounded to 5 seconds and each response to 20
seconds. It follows at most five same-origin HTTPS redirects and rejects
cross-origin redirects. Only the final HTTP response is verified; informational
responses cannot satisfy a check. Duplicate raw required security headers are
rejected rather than combined.

For both public HTML and the checked immutable asset, the required values are
exactly HSTS `max-age=31536000; includeSubDomains`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, referrer policy
`strict-origin-when-cross-origin`, and permissions policy
`accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=()`.

The verifier derives the asset only from a quoted `src` or `href` value under
`/_app/immutable/` in the downloaded HTML and requires the content type expected
for the selected JavaScript, CSS, or font extension. HTML CSP must contain exactly
one `script-src` nonce and must not contain `unsafe-inline`. Extracted production
styles need no nonce; if `style-src` contains one, it must match the script nonce.
HTML CSP must also set `frame-ancestors 'none'`. The immutable asset may omit CSP.
Do not add or overwrite CSP at Cloudflare.

## Deploy and rollback

Coolify's documented rolling update starts the replacement before stopping the
old container. That is unsafe for this SQLite volume. Use this operator-owned
workflow for every production deployment:

1. Disable **Auto Deploy** in **Advanced**. Disable any Git-provider or manually
   configured webhook deployments as well, and verify the deployment queue is
   empty. Keep automatic deployments and webhook deployments off for this resource.
2. Review and merge the intended commit to `main`, run all checks from that
   reviewed `main` commit, and complete any required encrypted off-host backup.
   Do this before the outage window.
3. In the Docker Compose resource, select that reviewed `main` commit but do
   not start a deployment yet. Keep exactly one replica and
   `DATABASE_BOOTSTRAP=false`.
4. Use Coolify **Stop** on the current resource. On the Docker host, set the
   actual named volume and verify no running or stopped container still owns it:

   ```sh
   VOLUME_NAME=<coolify-generated-volume-name>
   docker ps --filter "volume=$VOLUME_NAME" --format '{{.ID}} {{.Names}}'
   docker ps -a --filter "volume=$VOLUME_NAME" --format '{{.ID}} {{.Names}} {{.Status}}'
   test -z "$(docker ps -aq --filter "volume=$VOLUME_NAME")"
   ```

   Both listings must be empty. If a stopped old container remains, confirm its
   Coolify resource labels and remove that exact old container before proceeding.
   Do not start the replacement while any old container or process mounts `/data`.
5. Deploy the selected reviewed `main` commit. Require container health and
   `/health/ready = 200`, then prove exactly one running container with exactly
   one application process mounts the volume:

   ```sh
   ids="$(docker ps -q --filter "volume=$VOLUME_NAME")"
   test "$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l)" -eq 1
   container_id="$ids"
   docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container_id"
   test "$(docker top "$container_id" -eo pid,comm | awk 'NR > 1 { n++ } END { print n + 0 }')" -eq 1
   ```

   Run the public HTTPS/header checks and only then reopen traffic or enable
   features in the controlled launch order.

For rollback, turn checkout off, stop the current container, select the reviewed
previous `main` commit in the Compose resource, repeat the zero-container volume
check, and attach the same `/data` volume with `DATABASE_BOOTSTRAP=false`.
Confirm the older commit supports the applied schema,
then require readiness and the HTTPS checks. If it does not support the current
schema, follow the reviewed restore procedure instead of starting it. A missing
database is a restore/volume incident; bootstrap is not rollback recovery.
