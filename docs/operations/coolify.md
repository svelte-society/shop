# Coolify deployment

This service runs as one adapter-node process and one Coolify replica. SQLite is
the fulfillment system of record, so two application processes must never share
the volume. Deploy with the Dockerfile build pack and keep rolling/multi-replica
deployment disabled.

The relevant current Coolify references are the official guides for the
[Dockerfile build pack](https://coolify.io/docs/applications/build-packs/dockerfile),
[persistent storage](https://coolify.io/docs/knowledge-base/persistent-storage),
[health checks](https://coolify.io/docs/knowledge-base/health-checks), and
[Traefik custom middlewares](https://coolify.io/docs/knowledge-base/proxy/traefik/custom-middlewares).

## Resource settings

- Source: the shop repository and release branch, with `/` as the base directory.
- Build pack: `Dockerfile`.
- Domain: `https://shop.sveltesociety.dev` with Coolify-managed HTTPS.
- Container port: `3000`. Do not publish it directly on the host.
- Replicas: exactly `1`; do not use a second worker or process manager.
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

Store secret values as Coolify secrets. Do not set secrets as Docker build
arguments or include them in deployment commands. Keep `.env.example` as the
authoritative name inventory.

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

These values remain unset until the encrypted backup task is deployed:

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

1. Run automated checks and take the required encrypted off-host backup before
   a migration-bearing release.
2. Build the image before stopping the live process. Keep feature flags off for
   the first production deployment.
3. Stop the existing container before attaching `/data` to the replacement.
   Do not use a rolling overlap: even with one configured replica, overlap would
   briefly create two writers.
4. Deploy with `DATABASE_BOOTSTRAP=false`. Require container health and
   `/health/ready = 200`, then run the HTTPS/header checks.
5. Enable features only in the controlled launch order.

For rollback, turn checkout off, stop the current container, select the reviewed
previous image, and attach the same `/data` volume with
`DATABASE_BOOTSTRAP=false`. Confirm the older image supports the applied schema,
then require readiness and the HTTPS checks. If it does not support the current
schema, follow the reviewed restore procedure instead of starting it. A missing
database is a restore/volume incident; bootstrap is not rollback recovery.
