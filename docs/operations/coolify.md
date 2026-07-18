# Coolify deployment

This service runs as one adapter-node process and one Coolify replica. SQLite is
the fulfillment system of record, so two application processes must never share
the volume. Coolify application deployments normally use a rolling overlap when
health checks pass; there is no rolling-update toggle assumed by this runbook.
Production therefore uses the stop-first immutable-image procedure below.

The relevant current Coolify references are the official guides for the
[Dockerfile build pack](https://coolify.io/docs/applications/build-packs/dockerfile),
[environment variables](https://coolify.io/docs/knowledge-base/environment-variables),
[persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage),
[health checks](https://coolify.io/docs/knowledge-base/health-checks), and
[rolling updates](https://coolify.io/docs/knowledge-base/rolling-updates), and
[Traefik custom middlewares](https://coolify.io/docs/knowledge-base/proxy/traefik/custom-middlewares).

## Resource settings

- Build recipe: the reviewed repository `Dockerfile`, built and published by the
  release pipeline before the production outage.
- Production resource type: `Docker Image`, pinned to the reviewed immutable tag
  and recorded registry digest.
- Domain: `https://shop.sveltesociety.dev` with Coolify-managed HTTPS.
- Container port: `3000`. Do not publish it directly on the host.
- Replicas: exactly `1`; do not use a second worker or process manager.
- In **Advanced → Operations**, set **Stop Grace Period** to **45 seconds**.
  Adapter-node has `SHUTDOWN_TIMEOUT=30`, so Coolify leaves 15 seconds of
  platform headroom after the application deadline.
- Persistent storage: one named volume with destination path `/data`.
- Container health: the image healthcheck calls `GET /health/live`. Coolify gives
  a Dockerfile healthcheck precedence over a UI healthcheck.
- Deployment gate: `GET https://shop.sveltesociety.dev/health/ready` must return
  `200` after bootstrap. Liveness can remain `200` while readiness is deliberately
  `503`.

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
a known external address, inspect Traefik's forwarding chain and the app's
rate-limit/log address, and confirm the selected address is the known client.
Repeat after any proxy/CDN topology change. Never trust a leftmost value supplied
by the client.

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
```

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
SELLER_LEGAL_NAME=Svelte School AB
SELLER_REGISTRATION_NUMBER=<reviewed-value>
SELLER_VAT_NUMBER=<reviewed-value>
SELLER_ADDRESS_LINE1=<reviewed-value>
SELLER_POSTAL_CODE=<reviewed-value>
SELLER_CITY=<reviewed-value>
SELLER_COUNTRY=Sweden
SELLER_EMAIL=merch@sveltesociety.dev
DELIVERY_ESTIMATE_EU=<reviewed-value>
DELIVERY_ESTIMATE_US=<reviewed-value>
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
4. Restart the same immutable image against the same `/data` volume and verify the case still
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
4. Change to `DATABASE_BOOTSTRAP=false` and redeploy the same image against the
   same volume. Readiness must become `200` before any feature flag is enabled.

Never leave bootstrap set to `true`, and never use it to recover a missing
volume. If a normal or rollback container reports a missing database, keep it
out of service and restore or reattach the correct volume.

## Security headers for static assets

SvelteKit generates a per-response nonce CSP for dynamic HTML. Adapter-node
serves built static assets before SvelteKit server hooks, so the Coolify HTTPS
router must add the non-CSP baseline headers to every response. Do not define a
Traefik CSP header: it would overwrite the dynamic nonce-bearing policy.

For a standard Coolify application, open **Container Labels**, uncheck
**Readonly labels**, add these definitions, then append the middleware to the
actual generated HTTPS router. Preserve every generated label and any existing
middleware such as `gzip`:

```text
traefik.http.middlewares.shop-security.headers.stsSeconds=31536000
traefik.http.middlewares.shop-security.headers.stsIncludeSubdomains=true
traefik.http.middlewares.shop-security.headers.contentTypeNosniff=true
traefik.http.middlewares.shop-security.headers.frameDeny=true
traefik.http.middlewares.shop-security.headers.referrerPolicy=strict-origin-when-cross-origin
traefik.http.middlewares.shop-security.headers.permissionsPolicy=accelerometer=(),autoplay=(),camera=(),display-capture=(),encrypted-media=(),fullscreen=(),geolocation=(),gyroscope=(),magnetometer=(),microphone=(),payment=(),publickey-credentials-get=(),usb=()
traefik.http.routers.https-0-<resource-uuid>.middlewares=gzip,shop-security
```

`https-0-<resource-uuid>` is a placeholder. Copy the router key Coolify actually
generated; do not paste a guessed UUID. Coolify warns that disabling Readonly
labels also disables future label auto-generation. After each domain or proxy
change, compare the editable labels with **Reset Labels to Defaults** before
redeploying so routing labels are not lost.

Verify through public HTTPS after redeployment:

```sh
curl -fsS -D - -o /dev/null https://shop.sveltesociety.dev/
curl -fsS -D - -o /dev/null https://shop.sveltesociety.dev/_app/immutable/<real-built-asset>
```

Both responses must include HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, the strict referrer policy, and the permissions policy.
The HTML response must also include the application's nonce-bearing CSP without
`unsafe-inline`. The static subresource may omit CSP; it must have the proxy
baseline headers. Use a real asset path from the deployed HTML, not the
placeholder above.

## Deploy and rollback

Coolify's documented rolling update starts the replacement before stopping the
old container. That is unsafe for this SQLite volume. Use this operator-owned
workflow for every production deployment:

1. Disable **Auto Deploy** in **Advanced**. Disable any Git-provider or manually
   configured webhook deployments as well, and verify the deployment queue is
   empty. Keep automatic deployments and webhook deployments off for this resource.
2. From the reviewed commit, run all checks, build the Dockerfile, publish an
   immutable image such as `ghcr.io/svelte-society/shop:<full-git-sha>`, record
   its registry digest, and complete any required encrypted off-host backup.
   Do this before the outage window. Never deploy a mutable `latest` tag.
3. Configure/select that exact reviewed immutable image in the production
   Docker Image resource, but do not start a deployment yet. Keep exactly one
   replica and `DATABASE_BOOTSTRAP=false`.
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
5. Deploy the recorded digest/tag. Require container health and
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
previous immutable image, repeat the zero-container volume check, and attach the
same `/data` volume with `DATABASE_BOOTSTRAP=false`. Confirm the older image
supports the applied schema,
then require readiness and the HTTPS checks. If it does not support the current
schema, follow the reviewed restore procedure instead of starting it. A missing
database is a restore/volume incident; bootstrap is not rollback recovery.
