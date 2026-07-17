#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-svelte-society-shop:test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SUFFIX="$$"
PRIMARY_VOLUME="svelte-society-shop-data-${SUFFIX}"
SAFETY_VOLUME="svelte-society-shop-safety-${SUFFIX}"
NETWORK="svelte-society-shop-network-${SUFFIX}"
SAFETY_CONTAINER="svelte-society-shop-safety-${SUFFIX}"
BOOTSTRAP_CONTAINER="svelte-society-shop-bootstrap-${SUFFIX}"
SHUTDOWN_CONTAINER="svelte-society-shop-shutdown-${SUFFIX}"
NORMAL_CONTAINER="svelte-society-shop-normal-${SUFFIX}"
PERSISTENCE_CONTAINER="svelte-society-shop-persistence-${SUFFIX}"
CONTAINERS=(
	"$SAFETY_CONTAINER"
	"$BOOTSTRAP_CONTAINER"
	"$SHUTDOWN_CONTAINER"
	"$NORMAL_CONTAINER"
	"$PERSISTENCE_CONTAINER"
)
VOLUMES=("$PRIMARY_VOLUME" "$SAFETY_VOLUME")
PROVIDER_LOG="/tmp/svelte-society-shop-provider-${SUFFIX}.log"
PROVIDER_PID=""

cleanup() {
	if [[ -n "$PROVIDER_PID" ]]; then
		kill "$PROVIDER_PID" >/dev/null 2>&1 || true
		wait "$PROVIDER_PID" >/dev/null 2>&1 || true
	fi
	rm -f "$PROVIDER_LOG"
	for container in "${CONTAINERS[@]}"; do
		docker rm --force "$container" >/dev/null 2>&1 || true
	done
	for volume in "${VOLUMES[@]}"; do
		docker volume rm "$volume" >/dev/null 2>&1 || true
	done
	docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

SHOP_BUILD_SECRET_CANARY="shop-build-secret-canary-${SUFFIX}"
docker build --build-arg SHOP_BUILD_SECRET_CANARY="$SHOP_BUILD_SECRET_CANARY" -t "$IMAGE" .
if {
	docker image inspect "$IMAGE"
	docker history --no-trunc "$IMAGE"
} | grep -F "$SHOP_BUILD_SECRET_CANARY"; then
	printf 'Build canary leaked into image config or history\n' >&2
	exit 1
fi
docker volume create "$PRIMARY_VOLUME" >/dev/null
docker volume create "$SAFETY_VOLUME" >/dev/null
docker network create "$NETWORK" >/dev/null

start_container() {
	local name="$1"
	local volume="$2"
	local bootstrap="$3"
	local scheduler="$4"
	local plunk_base_url="${5:-https://next-api.useplunk.com}"
	local arguments=(
		docker run --detach
		--name "$name"
		--network "$NETWORK"
		--publish 127.0.0.1::3000
		--volume "$volume:/data"
		--env "DATABASE_BOOTSTRAP=$bootstrap"
		--env "SCHEDULER_ENABLED=$scheduler"
		--env SHUTDOWN_TIMEOUT=30
		--env STOREFRONT_ENABLED=false
		--env CHECKOUT_ENABLED=false
		--env MCP_ENABLED=false
		--env PRODUCTION_ORIGIN=https://shop.sveltesociety.dev
		--env ORIGIN=https://shop.sveltesociety.dev
		--env HOST_ALLOWLIST=shop.sveltesociety.dev
		--env SUPPORT_EMAIL=merch@sveltesociety.dev
		--env STRIPE_WEBHOOK_SECRET=whsec_docker_health
	)
	if [[ "$scheduler" == true ]]; then
		arguments+=(
			--env STRIPE_SECRET_KEY=sk_test_docker_health
			--env STYRIA_APP_ID=docker-health
			--env STYRIA_SECRET_KEY=docker-health
			--env STYRIA_BASE_URL=https://styriashirts.eu
			--env PLUNK_SECRET_KEY=docker-health
			--env "PLUNK_BASE_URL=$plunk_base_url"
			--env "PLUNK_FROM_NAME=Svelte Society Shop"
			--env PLUNK_FROM_EMAIL=merch@sveltesociety.dev
			--env ADMIN_EMAIL=merch@sveltesociety.dev
		)
		if [[ "$plunk_base_url" != https://next-api.useplunk.com ]]; then
			arguments+=(
				--add-host blocked-provider:host-gateway
				--volume "$ROOT/tests/fixtures/provider-cert.pem:/fixtures/provider-cert.pem:ro"
				--env NODE_EXTRA_CA_CERTS=/fixtures/provider-cert.pem
			)
		fi
	fi
	arguments+=("$IMAGE")
	"${arguments[@]}" >/dev/null
}

container_port() {
	local mapping
	mapping="$(docker port "$1" 3000/tcp)"
	printf '%s\n' "${mapping##*:}"
}

wait_http_status() {
	local name="$1"
	local path="$2"
	local expected="$3"
	local port status
	port="$(container_port "$name")"
	for _ in $(seq 1 60); do
		status="$(
			curl --silent --output /dev/null --write-out '%{http_code}' \
				--header 'Host: shop.sveltesociety.dev' \
				"http://127.0.0.1:${port}${path}" || true
		)"
		if [[ "$status" == "$expected" ]]; then
			return 0
		fi
		sleep 1
	done
	printf 'Expected %s from %s%s, received %s\n' "$expected" "$name" "$path" "$status" >&2
	docker logs "$name" >&2 || true
	return 1
}

wait_container_healthy() {
	local name="$1"
	local status
	for _ in $(seq 1 70); do
		status="$(docker inspect --format '{{.State.Health.Status}}' "$name")"
		if [[ "$status" == healthy ]]; then
			return 0
		fi
		if [[ "$status" == unhealthy ]]; then
			docker inspect --format '{{json .State.Health.Log}}' "$name" >&2
			return 1
		fi
		sleep 1
	done
	printf 'Container %s did not become healthy\n' "$name" >&2
	return 1
}

stop_within_timeout() {
	local name="$1"
	local started finished elapsed
	started="$(date +%s)"
	docker stop --time 31 "$name" >/dev/null
	finished="$(date +%s)"
	elapsed=$((finished - started))
	if ((elapsed >= 30)); then
		printf 'SIGTERM shutdown took %ss, expected less than SHUTDOWN_TIMEOUT=30\n' "$elapsed" >&2
		return 1
	fi
}

stop_within_seconds() {
	local name="$1"
	local maximum="$2"
	local started finished elapsed
	started="$(date +%s)"
	docker stop --time 31 "$name" >/dev/null
	finished="$(date +%s)"
	elapsed=$((finished - started))
	if ((elapsed >= maximum)); then
		printf 'SIGTERM shutdown took %ss, expected less than %ss\n' "$elapsed" "$maximum" >&2
		docker logs "$name" >&2 || true
		[[ ! -f "$PROVIDER_LOG" ]] || cat "$PROVIDER_LOG" >&2
		return 1
	fi
}

wait_for_file_log() {
	local token="$1"
	for _ in $(seq 1 60); do
		if [[ -f "$PROVIDER_LOG" ]] && grep -F "$token" "$PROVIDER_LOG" >/dev/null; then
			return 0
		fi
		sleep 1
	done
	printf 'Provider did not log %s\n' "$token" >&2
	[[ ! -f "$PROVIDER_LOG" ]] || cat "$PROVIDER_LOG" >&2
	return 1
}

assert_quick_check() {
	docker run --rm --volume "$PRIMARY_VOLUME:/data" --entrypoint node "$IMAGE" \
		--input-type=module --eval '
			import Database from "better-sqlite3";
			const database = new Database("/data/shop.sqlite", { readonly: true, fileMustExist: true });
			const result = database.pragma("quick_check");
			database.close();
			if (result.length !== 1 || result[0].quick_check !== "ok") process.exit(1);
		'
}

assert_single_volume_owner() {
	local name="$1"
	local ids container_count process_count
	ids="$(docker ps --filter "volume=$PRIMARY_VOLUME" --format '{{.ID}}')"
	container_count="$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')"
	[[ "$container_count" == 1 ]]
	[[ "$ids" == "$(docker inspect --format '{{.Id}}' "$name" | cut -c1-12)" ]]
	[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}1{{end}}{{end}}' "$name")" == 1 ]]
	for _ in $(seq 1 30); do
		process_count="$(docker top "$name" -eo pid,comm | awk 'NR > 1 { count++ } END { print count + 0 }')"
		if [[ "$process_count" == 1 ]]; then
			return 0
		fi
		sleep 1
	done
	printf 'Expected exactly one process in the sole /data owner, found %s\n' "$process_count" >&2
	return 1
}

assert_shutdown_logs() {
	local name="$1"
	local scheduler_active="$2"
	local scheduler_count=0
	local logs scheduler_line database_line
	if [[ "$scheduler_active" == true ]]; then
		scheduler_count=1
	fi
	logs="$(docker logs "$name" 2>&1)"
	printf '%s\n' "$logs" | grep -F 'APPLICATION_SCHEDULER_STOPPED' >/dev/null
	printf '%s\n' "$logs" | grep -F 'APPLICATION_DATABASE_CLOSED' >/dev/null
	printf '%s\n' "$logs" | grep -F "\"scheduler_count\":${scheduler_count}" >/dev/null
	scheduler_line="$(printf '%s\n' "$logs" | awk '/APPLICATION_SCHEDULER_STOPPED/{print NR; exit}')"
	database_line="$(printf '%s\n' "$logs" | awk '/APPLICATION_DATABASE_CLOSED/{print NR; exit}')"
	if [[ -z "$scheduler_line" || -z "$database_line" || "$scheduler_line" -ge "$database_line" ]]; then
		printf 'Shutdown events are missing or out of order for %s\n' "$name" >&2
		return 1
	fi
}

# A normal or rollback deployment must fail closed when its database is absent.
start_container "$SAFETY_CONTAINER" "$SAFETY_VOLUME" false false
wait_http_status "$SAFETY_CONTAINER" /health/live 200
wait_http_status "$SAFETY_CONTAINER" /health/ready 503
docker exec "$SAFETY_CONTAINER" node --input-type=module --eval \
	'import { existsSync } from "node:fs"; if (existsSync("/data/shop.sqlite")) process.exit(1);'
stop_within_timeout "$SAFETY_CONTAINER"

# A fresh volume is created and migrated only in the explicit one-time mode.
# Scheduler configuration is intentionally true here to prove bootstrap still suppresses it.
start_container "$BOOTSTRAP_CONTAINER" "$PRIMARY_VOLUME" true true
wait_http_status "$BOOTSTRAP_CONTAINER" /health/live 200
wait_http_status "$BOOTSTRAP_CONTAINER" /health/ready 503
docker exec "$BOOTSTRAP_CONTAINER" node --input-type=module --eval '
	import Database from "better-sqlite3";
	const database = new Database("/data/shop.sqlite");
	const row = database.prepare("SELECT COUNT(*) AS count FROM _migrations").get();
	const now = "2026-07-17T00:00:00.000Z";
	const insert = database.transaction(() => {
		database.prepare(`INSERT INTO checkout_drafts (
			id, stripe_checkout_session_id, contract_version, currency, total_unit_count,
			shipping_mode, created_at, expires_at, completed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			"draft_docker_persist", "cs_docker_persist", 1, "eur", 1,
			"paid", now, "2026-07-18T00:00:00.000Z", now
		);
		database.prepare(`INSERT INTO orders (
			id, stripe_checkout_session_id, stripe_payment_intent_id, stripe_customer_id,
			checkout_draft_id, currency, subtotal_amount, discount_amount, shipping_amount,
			tax_amount, total_amount, destination_country, payment_status,
			fulfillment_status, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			"ord_docker_persist", "cs_docker_persist", "pi_docker_persist", "cus_docker_persist",
			"draft_docker_persist", "eur", 2500, 0, 500, 625, 3625, "SE", "paid",
			"pending_review", now
		);
		database.prepare(`INSERT INTO order_lines (
			order_id, line_index, stripe_product_id, stripe_price_id, product_name,
			variant_label, sku, styria_product_number, design_reference, design_json,
			quantity, unit_amount, currency
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
			"ord_docker_persist", 0, "prod_docker", "price_docker", "Svelte Society Tee",
			"M", "TEE-M", "STYRIA-TEE", "design-docker", "{}", 1, 2500, "eur"
		);
		database.prepare(`INSERT INTO outbox_jobs (
			kind, idempotency_key, order_id, next_attempt_at
		) VALUES (?, ?, ?, ?)`).run(
			"paid-order-alert", "paid-order-alert:ord_docker_persist",
			"ord_docker_persist", "2020-01-01T00:00:00.000Z"
		);
	});
	insert.immediate();
	database.close();
	if (!row || row.count < 3) process.exit(1);
'
stop_within_timeout "$BOOTSTRAP_CONTAINER"
assert_shutdown_logs "$BOOTSTRAP_CONTAINER" false

# A trusted test TLS fixture accepts the scheduler's Plunk request but never returns
# response headers. Provider-observed socket close proves SIGTERM aborts real in-flight
# I/O rather than racing SQLite close against detached background work.
node "$ROOT/tests/integration/blocked-provider.mjs" >"$PROVIDER_LOG" 2>&1 &
PROVIDER_PID="$!"
wait_for_file_log BLOCKED_PROVIDER_LISTENING
PROVIDER_PORT="$(sed -n 's/^BLOCKED_PROVIDER_LISTENING=//p' "$PROVIDER_LOG" | tail -n 1)"
start_container \
	"$SHUTDOWN_CONTAINER" \
	"$PRIMARY_VOLUME" \
	false \
	true \
	"https://blocked-provider:$PROVIDER_PORT"
wait_http_status "$SHUTDOWN_CONTAINER" /health/live 200
wait_http_status "$SHUTDOWN_CONTAINER" /health/ready 200
wait_for_file_log BLOCKED_PROVIDER_ACCEPTED
stop_within_seconds "$SHUTDOWN_CONTAINER" 5
wait_for_file_log BLOCKED_PROVIDER_ABORTED
assert_shutdown_logs "$SHUTDOWN_CONTAINER" true
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$SHUTDOWN_CONTAINER")" == 0 ]]
docker run --rm --volume "$PRIMARY_VOLUME:/data" --entrypoint node "$IMAGE" \
	--input-type=module --eval '
		import Database from "better-sqlite3";
		const database = new Database("/data/shop.sqlite", { readonly: true, fileMustExist: true });
		const job = database.prepare(`SELECT attempt_count, completed_at, last_error_code
			FROM outbox_jobs WHERE idempotency_key = ?`).get("paid-order-alert:ord_docker_persist");
		const leases = database.prepare("SELECT COUNT(*) AS count FROM job_leases").get();
		const run = database.prepare(`SELECT result, finished_at FROM job_runs
			WHERE name = ? ORDER BY id DESC LIMIT 1`).get("outbox");
		database.close();
		if (!job || job.attempt_count !== 1 || job.completed_at !== null || job.last_error_code !== "PLUNK_UNAVAILABLE") process.exit(1);
		if (!leases || leases.count !== 0) process.exit(1);
		if (!run || run.result !== "completed" || run.finished_at === null) process.exit(1);
	'
assert_quick_check

# The same volume becomes ready only after bootstrap is turned off. The destructive
# provider test already exercised the scheduler, so routine image checks keep it off.
start_container "$NORMAL_CONTAINER" "$PRIMARY_VOLUME" false false
wait_http_status "$NORMAL_CONTAINER" /health/live 200
wait_http_status "$NORMAL_CONTAINER" /health/ready 200
wait_container_healthy "$NORMAL_CONTAINER"
assert_single_volume_owner "$NORMAL_CONTAINER"

[[ "$(docker exec "$NORMAL_CONTAINER" id -u):$(docker exec "$NORMAL_CONTAINER" id -g)" == 10001:10001 ]]
[[ "$(docker exec "$NORMAL_CONTAINER" stat --format '%u:%g' /data)" == 10001:10001 ]]
[[ "$(docker exec "$NORMAL_CONTAINER" stat --format '%u:%g' /data/shop.sqlite)" == 10001:10001 ]]
docker exec "$NORMAL_CONTAINER" sh -c 'test -w /data && test -w /data/tmp && test ! -w /app'
docker exec "$NORMAL_CONTAINER" sh -c '
	test ! -e /app/node_modules/vitest
	test ! -e /app/node_modules/@sveltejs/kit
	test ! -e /app/scripts/dev-test-catalog.mjs
	test ! -e /app/.env
'

port="$(container_port "$NORMAL_CONTAINER")"
headers="$(
	curl --silent --show-error --dump-header - --output /dev/null \
		--header 'Host: shop.sveltesociety.dev' \
		"http://127.0.0.1:${port}/"
)"
printf '%s\n' "$headers" | grep -Eiq '^strict-transport-security: max-age=31536000; includeSubDomains'
printf '%s\n' "$headers" | grep -Eiq '^x-content-type-options: nosniff'
printf '%s\n' "$headers" | grep -Eiq '^x-frame-options: DENY'
printf '%s\n' "$headers" | grep -Eiq '^referrer-policy: strict-origin-when-cross-origin'
printf '%s\n' "$headers" | grep -Eiq '^permissions-policy:'
printf '%s\n' "$headers" | grep -Eiq '^content-security-policy:.*nonce-'
if printf '%s\n' "$headers" | grep -Eiq '^content-security-policy:.*unsafe-inline'; then
	printf 'Production CSP unexpectedly allows unsafe-inline\n' >&2
	exit 1
fi

stop_within_timeout "$NORMAL_CONTAINER"
assert_shutdown_logs "$NORMAL_CONTAINER" false

# Reopening the stopped process database verifies the shutdown marker reflects a
# cleanly closed, intact SQLite file rather than process teardown alone.
assert_quick_check

# A new production container on the same named volume sees the valid order row.
start_container "$PERSISTENCE_CONTAINER" "$PRIMARY_VOLUME" false false
wait_http_status "$PERSISTENCE_CONTAINER" /health/ready 200
docker exec "$PERSISTENCE_CONTAINER" node --input-type=module --eval '
	import Database from "better-sqlite3";
	const database = new Database("/data/shop.sqlite", { readonly: true, fileMustExist: true });
	const row = database.prepare("SELECT COUNT(*) AS count FROM orders WHERE id = ?").get("ord_docker_persist");
	database.close();
	if (!row || row.count !== 1) process.exit(1);
'
stop_within_timeout "$PERSISTENCE_CONTAINER"
assert_shutdown_logs "$PERSISTENCE_CONTAINER" false

printf 'Docker bootstrap, health, persistence, headers, and SIGTERM checks passed.\n'
