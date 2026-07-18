#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-svelte-society-shop:test}"
SUFFIX="$$"
TEMPORARY_DIRECTORY="$(mktemp -d)"
WITHDRAWAL_DATA_KEY="$(
	node --input-type=module --eval \
		"import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64'))"
)"
MCP_BEARER_TOKEN="$(
	node --input-type=module --eval \
		"import { randomBytes } from 'node:crypto'; process.stdout.write(randomBytes(32).toString('hex'))"
)"
TLS_PROXY_PID=""
PRIMARY_VOLUME="svelte-society-shop-data-${SUFFIX}"
SAFETY_VOLUME="svelte-society-shop-safety-${SUFFIX}"
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

cleanup() {
	if [[ -n "$TLS_PROXY_PID" ]]; then
		kill "$TLS_PROXY_PID" >/dev/null 2>&1 || true
		wait "$TLS_PROXY_PID" >/dev/null 2>&1 || true
	fi
	for container in "${CONTAINERS[@]}"; do
		docker rm --force "$container" >/dev/null 2>&1 || true
	done
	for volume in "${VOLUMES[@]}"; do
		docker volume rm "$volume" >/dev/null 2>&1 || true
	done
	rm -rf "$TEMPORARY_DIRECTORY"
}
trap cleanup EXIT INT TERM

SHOP_BUILD_SECRET_CANARY="shop-build-secret-canary-${SUFFIX}"
docker build --build-arg SHOP_BUILD_SECRET_CANARY="$SHOP_BUILD_SECRET_CANARY" -t "$IMAGE" .
IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
printf 'Docker image digest: %s\n' "$IMAGE_DIGEST"
if {
	docker image inspect "$IMAGE"
	docker history --no-trunc "$IMAGE"
} | grep -F "$SHOP_BUILD_SECRET_CANARY"; then
	printf 'Build canary leaked into image config or history\n' >&2
	exit 1
fi
docker volume create "$PRIMARY_VOLUME" >/dev/null
docker volume create "$SAFETY_VOLUME" >/dev/null

start_container() {
	local name="$1"
	local volume="$2"
	local bootstrap="$3"
	local scheduler="$4"
	local mcp="${5:-false}"
	local arguments=(
		docker run --detach
		--name "$name"
		--publish 127.0.0.1::3000
		--volume "$volume:/data"
		--env "DATABASE_BOOTSTRAP=$bootstrap"
		--env "SCHEDULER_ENABLED=$scheduler"
		--env S3_ENDPOINT=https://s3.docker-health.test
		--env S3_BUCKET=docker-health-backups
		--env S3_REGION=eu-north-1
		--env S3_ACCESS_KEY_ID=docker-health-access
		--env S3_SECRET_ACCESS_KEY=docker-health-private
		--env S3_PREFIX=shop-backups
		--env S3_FORCE_PATH_STYLE=true
		--env BACKUP_ENCRYPTION_KEY_BASE64=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
		--env SHUTDOWN_TIMEOUT=30
		--env STOREFRONT_ENABLED=false
		--env CHECKOUT_ENABLED=false
		--env "MCP_ENABLED=$mcp"
		--env "MCP_BEARER_TOKEN=$MCP_BEARER_TOKEN"
		--env PRODUCTION_ORIGIN=https://shop.sveltesociety.dev
		--env ORIGIN=https://shop.sveltesociety.dev
		--env HOST_ALLOWLIST=shop.sveltesociety.dev
		--env SUPPORT_EMAIL=merch@sveltesociety.dev
		--env "WITHDRAWAL_DATA_KEY=$WITHDRAWAL_DATA_KEY"
		--env STRIPE_SECRET_KEY=sk_test_docker_health
		--env STRIPE_WEBHOOK_SECRET=whsec_docker_health
		--env STYRIA_APP_ID=docker-health
		--env STYRIA_SECRET_KEY=docker-health
		--env STYRIA_BASE_URL=https://styriashirts.eu
		--env STYRIA_BRAND_NAME='Svelte Society'
		--env PLUNK_SECRET_KEY=docker-health
		--env PLUNK_BASE_URL=https://127.0.0.1:1
		--env 'PLUNK_FROM_NAME=Svelte Society Shop'
		--env PLUNK_FROM_EMAIL=merch@sveltesociety.dev
		--env 'SELLER_LEGAL_NAME=Svelte School AB'
		--env SELLER_REGISTRATION_NUMBER=docker-health-registration
		--env SELLER_VAT_NUMBER=docker-health-vat
		--env 'SELLER_ADDRESS_LINE1=Docker Health Street 1'
		--env 'SELLER_POSTAL_CODE=123 45'
		--env 'SELLER_CITY=Stockholm'
		--env SELLER_COUNTRY=Sweden
		--env SELLER_EMAIL=merch@sveltesociety.dev
		--env 'DELIVERY_ESTIMATE_EU=Docker health EU estimate'
		--env 'DELIVERY_ESTIMATE_US=Docker health US estimate'
		--env POLICY_EFFECTIVE_DATE=2026-07-18
	)
	if [[ "$scheduler" == true ]]; then
		arguments+=(
			--env ADMIN_EMAIL=merch@sveltesociety.dev
		)
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

submit_synthetic_withdrawal() {
	local name="$1"
	local port proxy_port base_url csrf receipt_token status
	local cookie_jar="$TEMPORARY_DIRECTORY/withdrawal-cookies.txt"
	local landing="$TEMPORARY_DIRECTORY/withdrawal-landing.html"
	local confirmation="$TEMPORARY_DIRECTORY/withdrawal-confirmation.html"
	local confirmation_headers="$TEMPORARY_DIRECTORY/withdrawal-confirmation-headers.txt"
	local receipt="$TEMPORARY_DIRECTORY/withdrawal-receipt.txt"
	local tls_key="$TEMPORARY_DIRECTORY/loopback-tls.key"
	local tls_certificate="$TEMPORARY_DIRECTORY/loopback-tls.crt"
	port="$(container_port "$name")"
	proxy_port=$((40000 + SUFFIX % 20000))
	base_url="https://localhost:${proxy_port}"
	openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
		-subj '/CN=localhost' \
		-addext 'subjectAltName=DNS:localhost' \
		-keyout "$tls_key" \
		-out "$tls_certificate" >/dev/null 2>&1
	node --input-type=module --eval '
		import { readFileSync } from "node:fs";
		import { connect } from "node:net";
		import { createServer } from "node:tls";
		const [keyPath, certificatePath, backendPort, proxyPort] = process.argv.slice(1);
		const server = createServer(
			{ key: readFileSync(keyPath), cert: readFileSync(certificatePath) },
			(client) => {
				const upstream = connect(Number(backendPort), "127.0.0.1");
				client.pipe(upstream).pipe(client);
			}
		);
		server.listen(Number(proxyPort), "127.0.0.1");
	' "$tls_key" "$tls_certificate" "$port" "$proxy_port" &
	TLS_PROXY_PID=$!
	for _ in $(seq 1 30); do
		status="$(
			curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
				--header 'Host: shop.sveltesociety.dev' \
				"${base_url}/health/live" || true
		)"
		[[ "$status" == 200 ]] && break
		sleep 1
	done
	[[ "$status" == 200 ]]
	curl --fail --silent --show-error \
		--insecure \
		--header 'Host: shop.sveltesociety.dev' \
		--cookie-jar "$cookie_jar" \
		--output "$landing" \
		"${base_url}/withdraw"
	csrf="$(
		grep -Eo 'name="csrfToken" value="[A-Za-z0-9_-]{43}"' "$landing" |
			head -n 1 |
			cut -d '"' -f 4
	)"
	if [[ ! "$csrf" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
		printf 'Withdrawal CSRF token was not rendered\n' >&2
		return 1
	fi
	status="$(
		curl --silent --show-error \
			--insecure \
			--request POST \
			--header 'Host: shop.sveltesociety.dev' \
			--header 'Origin: https://shop.sveltesociety.dev' \
			--cookie "$cookie_jar" \
			--cookie-jar "$cookie_jar" \
			--data-urlencode "csrfToken=$csrf" \
			--data-urlencode 'fullName=Docker Withdrawal Canary' \
			--data-urlencode 'receiptEmail=docker-withdrawal@example.test' \
			--data-urlencode 'enteredOrderReference=DOCKER-WITHDRAWAL-ORDER' \
			--data-urlencode 'scope=entire_order' \
			--dump-header "$confirmation_headers" \
			--output "$confirmation" \
			--write-out '%{http_code}' \
			"${base_url}/withdraw?/confirm"
	)"
	if [[ "$status" != 200 ]]; then
		printf 'Synthetic withdrawal confirmation returned %s\n' "$status" >&2
		return 1
	fi
	WITHDRAWAL_REFERENCE="$(
		grep -Eo 'WDR-[A-Za-z0-9_-]{22}' "$confirmation" | head -n 1 || true
	)"
	if [[ ! "$WITHDRAWAL_REFERENCE" =~ ^WDR-[A-Za-z0-9_-]{22}$ ]]; then
		printf 'Synthetic withdrawal reference was not rendered\n' >&2
		docker exec "$name" node --input-type=module --eval '
			import Database from "better-sqlite3";
			const database = new Database("/data/shop.sqlite", { readonly: true, fileMustExist: true });
			const row = database.prepare("SELECT COUNT(*) AS count FROM withdrawal_cases").get();
			database.close();
			process.stderr.write(`Persisted withdrawal case count: ${row?.count ?? "invalid"}\n`);
		'
		grep -Eo 'Withdrawal notice received|We could not submit the notice|This form expired|temporarily unavailable' \
			"$confirmation" >&2 || true
		return 1
	fi
	receipt_token="$(
		awk '$6 == "withdrawal_receipt_session" { print $7; exit }' "$cookie_jar"
	)"
	if [[ ! "$receipt_token" =~ ^v1\.[0-9]+\.[A-Za-z0-9_-]{43}$ ]]; then
		printf 'Submitting cookie jar did not receive a valid receipt session\n' >&2
		grep -Eio '^set-cookie: [^=]+' "$confirmation_headers" >&2 || true
		awk '$6 != "" { print "Cookie jar metadata:", $6, "path=" $3, "secure=" $4 }' \
			"$cookie_jar" >&2
		return 1
	fi
	status="$(
		curl --silent --show-error \
			--insecure \
			--header 'Host: shop.sveltesociety.dev' \
			--cookie "$cookie_jar" \
			--output "$receipt" \
			--write-out '%{http_code}' \
			"${base_url}/withdraw/receipt/${WITHDRAWAL_REFERENCE}"
	)"
	[[ "$status" == 200 ]]
	grep -F 'Docker Withdrawal Canary' "$receipt" >/dev/null
	grep -F 'DOCKER-WITHDRAWAL-ORDER' "$receipt" >/dev/null
	status="$(
		curl --silent --show-error \
			--insecure \
			--header 'Host: shop.sveltesociety.dev' \
			--output /dev/null \
			--write-out '%{http_code}' \
			"${base_url}/withdraw/receipt/${WITHDRAWAL_REFERENCE}"
	)"
	[[ "$status" == 404 ]]
	kill "$TLS_PROXY_PID"
	wait "$TLS_PROXY_PID" >/dev/null 2>&1 || true
	TLS_PROXY_PID=""
}

assert_bearer_mcp_withdrawal_list() {
	local name="$1"
	local port status session_id
	local headers="$TEMPORARY_DIRECTORY/mcp-initialize-headers.txt"
	local initialize="$TEMPORARY_DIRECTORY/mcp-initialize.txt"
	local tools="$TEMPORARY_DIRECTORY/mcp-tools.txt"
	local cases="$TEMPORARY_DIRECTORY/mcp-withdrawal-cases.txt"
	port="$(container_port "$name")"
	status="$(
		curl --silent --show-error \
			--request POST \
			--header 'Host: shop.sveltesociety.dev' \
			--header 'Origin: https://shop.sveltesociety.dev' \
			--header 'Content-Type: application/json' \
			--header 'Accept: application/json, text/event-stream' \
			--header 'Authorization: Bearer invalid-docker-health-token' \
			--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docker-health","version":"1.0.0"}}}' \
			--output /dev/null \
			--write-out '%{http_code}' \
			"http://127.0.0.1:${port}/mcp"
	)"
	[[ "$status" == 401 ]]
	curl --fail --silent --show-error \
		--request POST \
		--header 'Host: shop.sveltesociety.dev' \
		--header 'Origin: https://shop.sveltesociety.dev' \
		--header 'Content-Type: application/json' \
		--header 'Accept: application/json, text/event-stream' \
		--header "Authorization: Bearer $MCP_BEARER_TOKEN" \
		--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"docker-health","version":"1.0.0"}}}' \
		--dump-header "$headers" \
		--output "$initialize" \
		"http://127.0.0.1:${port}/mcp"
	session_id="$(awk 'tolower($1) == "mcp-session-id:" { gsub("\\r", "", $2); print $2; exit }' "$headers")"
	[[ -n "$session_id" ]]
	grep -F '"protocolVersion":"2025-06-18"' "$initialize" >/dev/null
	curl --fail --silent --show-error \
		--request POST \
		--header 'Host: shop.sveltesociety.dev' \
		--header 'Origin: https://shop.sveltesociety.dev' \
		--header 'Content-Type: application/json' \
		--header 'Accept: application/json, text/event-stream' \
		--header "Authorization: Bearer $MCP_BEARER_TOKEN" \
		--header "mcp-session-id: $session_id" \
		--data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
		--output "$tools" \
		"http://127.0.0.1:${port}/mcp"
	grep -F '"name":"list_withdrawal_cases"' "$tools" >/dev/null
	curl --fail --silent --show-error \
		--request POST \
		--header 'Host: shop.sveltesociety.dev' \
		--header 'Origin: https://shop.sveltesociety.dev' \
		--header 'Content-Type: application/json' \
		--header 'Accept: application/json, text/event-stream' \
		--header "Authorization: Bearer $MCP_BEARER_TOKEN" \
		--header "mcp-session-id: $session_id" \
		--data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_withdrawal_cases","arguments":{"limit":10}}}' \
		--output "$cases" \
		"http://127.0.0.1:${port}/mcp"
	grep -F "$WITHDRAWAL_REFERENCE" "$cases" >/dev/null
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
	});
	insert.immediate();
	database.close();
	if (!row || row.count < 3) process.exit(1);
'
stop_within_timeout "$BOOTSTRAP_CONTAINER"
assert_shutdown_logs "$BOOTSTRAP_CONTAINER" false

# Docker verifies a normal scheduler-enabled shutdown with no due work. The stalled
# provider cancellation proof runs entirely on host loopback in process-shutdown.mjs.
docker run --rm --volume "$PRIMARY_VOLUME:/data" --entrypoint node "$IMAGE" \
	--input-type=module --eval '
		import Database from "better-sqlite3";
		const database = new Database("/data/shop.sqlite", { readonly: true, fileMustExist: true });
		const due = database.prepare(`SELECT COUNT(*) AS count FROM outbox_jobs
			WHERE completed_at IS NULL AND next_attempt_at <= ?`).get(new Date().toISOString());
		database.close();
		if (!due || due.count !== 0) process.exit(1);
	'
start_container "$SHUTDOWN_CONTAINER" "$PRIMARY_VOLUME" false true
wait_http_status "$SHUTDOWN_CONTAINER" /health/live 200
wait_http_status "$SHUTDOWN_CONTAINER" /health/ready 200
stop_within_timeout "$SHUTDOWN_CONTAINER"
assert_shutdown_logs "$SHUTDOWN_CONTAINER" true
[[ "$(docker inspect --format '{{.State.ExitCode}}' "$SHUTDOWN_CONTAINER")" == 0 ]]
assert_quick_check

# The same volume becomes ready only after bootstrap is turned off. The stalled-provider
# proof is host-only, so routine image checks keep the scheduler off.
start_container "$NORMAL_CONTAINER" "$PRIMARY_VOLUME" false false true
wait_http_status "$NORMAL_CONTAINER" /health/live 200
wait_http_status "$NORMAL_CONTAINER" /health/ready 200
wait_http_status "$NORMAL_CONTAINER" /withdraw 200
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

submit_synthetic_withdrawal "$NORMAL_CONTAINER"
assert_bearer_mcp_withdrawal_list "$NORMAL_CONTAINER"

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
	const withdrawal = database.prepare(
		"SELECT COUNT(*) AS count FROM withdrawal_cases WHERE public_reference = ?"
	).get(process.argv[1]);
	database.close();
	if (!row || row.count !== 1 || !withdrawal || withdrawal.count !== 1) process.exit(1);
' "$WITHDRAWAL_REFERENCE"
stop_within_timeout "$PERSISTENCE_CONTAINER"
assert_shutdown_logs "$PERSISTENCE_CONTAINER" false

printf 'Docker bootstrap, withdrawal route, receipt authorization, bearer MCP, persistence, headers, UID, and SIGTERM checks passed.\n'
