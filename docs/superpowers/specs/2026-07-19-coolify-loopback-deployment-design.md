# Coolify Loopback Deployment Design

**Date:** 2026-07-19  
**Status:** Approved for implementation planning

## Goal

Deploy Svelte Society Shop as a dedicated Coolify project. Cloudflare Tunnel runs directly on the
Coolify host and reaches the shop at `http://localhost:7178`. No application port is reachable on
the host's public interfaces.

## Coolify topology

- Project name: `Svelte Society Shop`
- Environment: `production`
- Server: Coolify `localhost`
- Resource: one Docker Compose application built from this repository
- Replicas: exactly one
- Coolify/Traefik domain: none
- Cloudflare Tunnel origin: `http://localhost:7178`

The container continues listening on `0.0.0.0:3000`. Docker Compose publishes it as
`127.0.0.1:7178:3000`. Binding the application itself to container localhost would prevent Docker
port forwarding from reaching it.

## Persistence and lifecycle

A named Docker volume mounts at `/data`. SQLite remains at `/data/shop.sqlite`; temporary files use
`/data/tmp`. The container runs as UID/GID `10001:10001`, retains the existing healthcheck, receives
`SIGTERM`, and gets a 45-second stop grace period. Deployments must never run two shop processes
against the same volume.

## Configuration

Coolify owns runtime environment values. Secrets remain runtime-only and never enter the Compose
file, build arguments, repository, logs, or deployment API payloads beyond Coolify environment
variable endpoints.

Initial rollout flags:

```text
STOREFRONT_ENABLED=false
CHECKOUT_ENABLED=false
MCP_ENABLED=false
SCHEDULER_ENABLED=false
TEST_CATALOG_FIXTURE=false
```

The application keeps `PORT=3000`, `HOST=0.0.0.0`, `DATABASE_PATH=/data/shop.sqlite`, and
`TMPDIR=/data/tmp`. Public origin and host validation use `https://shop.sveltesociety.dev` even
though Cloudflare forwards to the local HTTP origin.

## Provisioning sequence

1. Create the `Svelte Society Shop` Coolify project and its `production` environment through the
   authenticated Coolify API.
2. Add a repository Docker Compose definition containing the loopback port mapping, persistent
   volume, healthcheck inheritance, and stop grace period.
3. Publish this repository to an approved Git remote. Do not create an application until that source
   or an immutable published image exists.
4. Create the Coolify application from the approved source and configure runtime variables.
5. Deploy with all commerce flags off.
6. Verify `curl http://localhost:7178/health/live` on the Coolify host returns `200` and that port
   `7178` is not bound to a public interface.
7. Point Cloudflare Tunnel at `http://localhost:7178`, then verify public host/origin enforcement and
   `/health/ready`.

## Failure handling

- Project creation is idempotent by checking for an exact existing project name before creating it.
- Application creation stops if no approved Git source or immutable image exists.
- Deployment stops if the loopback mapping, single-replica constraint, or `/data` volume differs
  from this design.
- Health failure leaves commerce flags off and prevents Cloudflare cutover.
- API tokens are never committed. Any token pasted into chat is rotated after provisioning.

## Verification

- Validate Compose syntax before commit.
- Run the repository's Docker health integration test.
- Inspect the deployed container's port binding and volume mount through Coolify and the host.
- Confirm liveness locally at port `7178` and externally through Cloudflare.
- Restart and redeploy once; confirm SQLite volume persistence.

