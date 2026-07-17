# Codex MCP operations

The shop exposes one internal Streamable HTTP MCP endpoint at
`https://shop.sveltesociety.dev/mcp`. The ChatGPT desktop app, Codex CLI, and
Codex IDE extension use the same Codex host configuration. This is an internal
single-administrator connection; it is not a ChatGPT web Plugin and it does not
use OAuth.

Keep `MCP_ENABLED=false` in production until the Phase 4 security and recovery
gates pass. Production checkout must remain disabled for the same period.

## Generate and install the bearer secret

Generate 256 bits directly into the current shell environment. Process
substitution keeps the bearer in shell memory, not on disk, while producing no
terminal stdout. The command text stored in shell history contains only the
variable name, never the generated value:

```sh
IFS= read -r SVELTE_SHOP_MCP_TOKEN < <(openssl rand -hex 32)
export SVELTE_SHOP_MCP_TOKEN
```

The preferred handoff is an approved secret manager that can inject the value
as Coolify `MCP_BEARER_TOKEN` and local `SVELTE_SHOP_MCP_TOKEN` without revealing
it. If that integration is unavailable, a controlled macOS session can copy the
in-memory value to the volatile clipboard without passing the value as a command
argument or printing it:

```sh
printf '%s' "$SVELTE_SHOP_MCP_TOKEN" | pbcopy
```

Paste it directly into the Coolify secret field, then start or restart the local
Codex host from the environment containing `SVELTE_SHOP_MCP_TOKEN`. Clear the
clipboard immediately after both handoffs and remove the value from the parent
shell when the Codex host has inherited it:

```sh
printf '' | pbcopy
unset SVELTE_SHOP_MCP_TOKEN
```

Clipboard managers may retain copied values after the system clipboard is
cleared. Treat that as a disclosure risk: disable clipboard history for this
operation or use the approved secret manager instead. Never paste either value
into `config.toml`, this repository, SQLite, a command argument, a log, a
screenshot, or an MCP result. Coolify must expose the matching value to the Node
container as `MCP_BEARER_TOKEN`.

## Codex configuration

Add this exact block to the Codex host's `config.toml`:

```toml
[mcp_servers.svelte_society_shop]
url = "https://shop.sveltesociety.dev/mcp"
bearer_token_env_var = "SVELTE_SHOP_MCP_TOKEN"
default_tools_approval_mode = "writes"
```

The ChatGPT desktop app, Codex CLI, and IDE extension share this configuration
for the same Codex host. In the desktop app, restart after saving the server. In
the CLI, use `/mcp` to inspect the connected server. `writes` leaves read-only
tools available without a write prompt and requires approval for tools that are
not marked read-only, including preparation because it creates a ten-minute
approval record.

## Enable and verify

1. Deploy through Coolify with `MCP_ENABLED=false`. Confirm `/mcp` returns `404`
   before authentication or protocol handling.
2. Install the secret on both hosts and configure Codex, while keeping
   production checkout disabled.
3. Set `MCP_ENABLED=true` and redeploy.
4. From Codex, verify `initialize` identifies `svelte-society-shop`, then verify
   `tools/list` exposes the eight fulfillment tools.
5. Call `list_pending_orders`, then `inspect_order` without shipping details.
   Confirm neither result contains an authorization value, customer address, or
   phone number.
6. Call `prepare_styria_submission` for a test order. Confirm Codex prompts for
   the write and returns a ten-minute approval only after approval is granted.
   Do not submit a production Styria order during this smoke test.
7. Send an invalid bearer from a controlled client. Confirm `401 Unauthorized`,
   `WWW-Authenticate: Bearer`, an empty response body, and no token echo in the
   response or application logs.
8. Search the verification-period logs for authorization headers and both test
   token values. Redaction passes only when neither supplied nor configured
   bearer appears.

Do not put a real bearer in a curl example, shell history, or captured test
output. The automated integration suite covers local initialize, tools/list,
one read tool, preparation, disabled `404`, invalid-token `401`, and token
non-echo. The live check covers HTTPS routing and the actual Codex approval UI.

## Rotate safely

Static-token rotation has no overlap window, so use a short maintenance window:

1. Retain the previous token in the approved secret manager for rollback. Do
   not print or export it.
2. Set `MCP_ENABLED=false` and redeploy; verify `/mcp` returns `404`.
3. Generate the replacement into shell memory with the process-substitution
   procedure above. Use the approved secret manager, or the controlled volatile
   clipboard with clipboard history disabled.
4. Replace Coolify `MCP_BEARER_TOKEN` and the Codex-host
   `SVELTE_SHOP_MCP_TOKEN` without printing the value or placing it in a command
   argument. Do not change the TOML block.
5. Restart the Codex host, redeploy the container, then set `MCP_ENABLED=true`
   and redeploy.
6. Repeat initialize, tools/list, read, preparation approval, invalid-token
   `401`, and redaction checks.
7. Clear the clipboard, unset the parent-shell value, and delete the previous
   secret from the approved secret manager only after every check passes.

Rollback: set `MCP_ENABLED=false`, restore the previous secret on both hosts,
restart Codex, redeploy the container, re-enable MCP, and repeat the verification
checks. Keep checkout disabled throughout rotation and rollback.

## Live-host verification record

The live HTTPS/Codex check requires an authorized deployment or HTTPS tunnel and
a real secret. Neither was available to this task, and no global Codex config,
public tunnel, deployment, or secret was created. The shell also had no `codex`
binary on `PATH`; the live gate remains manual.

| Date       | Client version | Pass/fail |
| ---------- | -------------- | --------- |
| 2026-07-17 | unavailable    | PENDING   |

When the gate runs, replace the pending row with only its date, exact client
version, and `PASS` or `FAIL`. Do not record endpoint responses, order data,
tool arguments, headers, or secrets here.
