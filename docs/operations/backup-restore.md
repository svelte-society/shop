# Encrypted backup and restore

The application creates one encrypted SQLite backup each day at 02:30 UTC from the existing
single scheduler process. The job uses SQLite online backup, runs `PRAGMA quick_check` against
the snapshot, encrypts it with AES-256-GCM, uploads the object and its SHA-256 companion, verifies
both through object listing, removes all local temporary files, and then prunes backup objects
strictly older than 30 rolling days.

The stable scheduler alert is `BACKUP_FAILED`. Provider errors, credentials, encryption keys,
object contents, and database contents are not included in logs. A failed run leaves the source
database untouched and retries only at the next daily cadence.

During shutdown, the scheduler cancels its next backup timer, aborts any active S3 request, and
waits for cleanup before SQLite closes. SQLite's online backup call is not abortable; if shutdown
arrives during that call, shutdown waits for it to return, then the service observes cancellation
and starts no encryption or S3 phase.

## Storage and key contract

Set these as Coolify runtime variables. Store the three secret values in secret storage, not in
the image, build arguments, shell history, or command line.

```text
S3_ENDPOINT=https://<S3-compatible-endpoint>
S3_BUCKET=<bucket>
S3_REGION=eu-north-1
S3_ACCESS_KEY_ID=<secret>
S3_SECRET_ACCESS_KEY=<secret>
S3_PREFIX=svelte-society-shop
S3_FORCE_PATH_STYLE=false
BACKUP_ENCRYPTION_KEY_BASE64=<base64-encoded-32-byte-secret>
```

`S3_ENDPOINT` must be an exact HTTPS URL. `BACKUP_ENCRYPTION_KEY_BASE64` must decode to exactly
32 bytes. Generate it in a protected operator environment and enter the output directly into
Coolify secret storage:

```bash
openssl rand -base64 32
```

Never paste that output into a restore command. The restore program reads it from the environment.

Withdrawal records add a second, independent key contract. `WITHDRAWAL_DATA_KEY` encrypts the PII
inside SQLite; `BACKUP_ENCRYPTION_KEY_BASE64` encrypts the complete SQLite backup object. Generate,
store, escrow, and audit them separately. Reusing one value for both layers defeats that separation.
The backup key alone can restore the database file but cannot decrypt an active withdrawal payload.
The withdrawal key alone cannot decrypt the backup object.

The version-1 withdrawal payload format has no online rotation mechanism. Retain the exact
production `WITHDRAWAL_DATA_KEY` in protected recovery storage while any active payload can be
present in live data or retained backups. Permanent loss makes unpurged withdrawal customer and
reconciliation data unrecoverable. Public references and message metadata remain, but are not a
PII recovery path. Purged payloads are intentionally unrecoverable even when a current application
key is available.

Scheduled backups use the first UTC key shape. The stop-first local-order deletion procedure creates
an immutable pre-deletion backup with the second shape; its UUID suffix prevents a same-second
scheduled or deletion backup from overwriting it. Both forms have a checksum companion:

```text
<prefix>/YYYY/MM/DD/shop-YYYYMMDDTHHmmssZ.sqlite.ssbk
<prefix>/YYYY/MM/DD/shop-YYYYMMDDTHHmmssZ-<uuid>.sqlite.ssbk
<prefix>/YYYY/MM/DD/shop-YYYYMMDDTHHmmssZ.sqlite.ssbk.sha256
<prefix>/YYYY/MM/DD/shop-YYYYMMDDTHHmmssZ-<uuid>.sqlite.ssbk.sha256
```

The encrypted object is `SSBK1`: five ASCII magic bytes, a 12-byte random IV, a 16-byte GCM tag,
then ciphertext. The companion contains the lower-case SHA-256 of the complete encrypted object.
When selecting a restore candidate, list the objects for the intended UTC date and record the exact
full `.sqlite.ssbk` key, its matching `.sha256` key, the backup purpose (scheduled or pre-deletion),
and the immutable application image in the incident record. Do not infer the candidate from a
timestamp-only filename or drop a UUID suffix. Verify the selected pair's object metadata and
checksum before running the offline restore; a pre-deletion backup is evidence tied to that deletion
and must be identified as such in the restore approval.

## Restore procedure

Restore is destructive and offline. Do not run it from the live application container.

1. Disable external traffic or place the service in the existing maintenance state. Record the
   immutable application image and the full backup object key selected for restore.
2. Stop the application container cleanly in Coolify. Confirm it has exited, and confirm no other
   container or process has the persistent `/data` volume attached. The restore confirmations do
   not detect a running process; they record that the operator performed these checks.
3. Create a root-readable environment file outside the repository containing the S3 variables,
   `BACKUP_ENCRYPTION_KEY_BASE64`, and the production `WITHDRAWAL_DATA_KEY`. Set its mode to `0600`.
   The offline restore command consumes only the backup key, but the restarted application needs
   the withdrawal key to inspect active cases. Do not put either encryption key or the
   object-storage secret on the command line.
4. Run a one-shot container from the same reviewed image, with the application stopped and the same
   persistent volume mounted at `/data`:

```bash
docker run --rm \
  --volume <coolify-data-volume>:/data \
  --env-file /root/shop-restore.env \
  --entrypoint node \
  <immutable-image> \
  scripts/restore-backup.mjs \
  --key '<prefix>/YYYY/MM/DD/shop-YYYYMMDDTHHmmssZ.sqlite.ssbk' \
  --confirm-app-stopped \
  --confirm-replace
```

The command downloads the encrypted object and checksum, verifies SHA-256, authenticates and
decrypts into `/data/shop.restore.tmp`, runs `PRAGMA quick_check`, and closes SQLite. It copies the
current database's complete logical state (including committed pages in a crash-left WAL) through
SQLite online backup to a unique noncanonical `shop.pre-restore.<timestamp>.sqlite.building-*`
file. Only after chmod `0600`, `quick_check`, sidecar cleanup, and file synchronization succeed is
that file atomically renamed to `/data/shop.pre-restore.<timestamp>.sqlite` and the directory
synchronized. A failure before that boundary removes both the building file and any canonical
candidate, so an invalid rollback artifact is never advertised.

Before committing the restore, the command atomically quarantines active WAL/SHM files, with
rollback if either quarantine rename fails. It copies the verified canonical pre-restore database
through a synchronized prior-install temporary file, atomically installs that standalone prior
logical state at `/data/shop.sqlite`, synchronizes the directory, and then removes quarantined
sidecars. The final commit boundary is the atomic rename of the verified restore over
`/data/shop.sqlite` followed by a data-directory sync. An ordinary precommit quarantine, removal,
or final-rename failure therefore leaves `shop.sqlite` opening as the prior logical database and
retains the verified canonical pre-restore copy. Success emits only
`{"event":"restore_completed"}`.

If the final rename succeeds but its directory sync fails, the command emits
`{"event":"restore_failed","error_code":"RESTORE_STATE_UNCERTAIN"}`. This state requires operator
action: keep the application stopped, do not retry the restore or restart the application, inspect
both `/data/shop.sqlite` and the retained canonical pre-restore database with `quick_check` and
reviewed aggregate queries, and then perform the rollback procedure below. The rollback is
mandatory even if the restored rows appear present, because the final directory entry was not
durably confirmed. Preserve all files for incident analysis until rollback and readiness checks
complete.

5. Before restarting, verify the restored file with a one-shot container:

```bash
docker run --rm \
  --volume <coolify-data-volume>:/data \
  --entrypoint node \
  <immutable-image> \
  --input-type=module --eval '
    import Database from "better-sqlite3";
    const db = new Database("/data/shop.sqlite", { readonly: true, fileMustExist: true });
    try {
      const result = db.pragma("quick_check");
      if (result.length !== 1 || result[0].quick_check !== "ok") process.exit(1);
    } finally {
      db.close();
    }
  '
```

6. Restart the same immutable application image with `DATABASE_PATH=/data/shop.sqlite`,
   `DATABASE_BOOTSTRAP=false`, and commerce feature flags unchanged. Startup applies every pending
   committed migration before scheduler activation.
7. Require readiness and the expected business row counts before reopening traffic. Readiness
   verifies the exact migration ledger as well as SQLite integrity, writes, volume, and disk:

```bash
curl --fail --silent --show-error https://shop.sveltesociety.dev/health/ready
```

Run reviewed, non-PII aggregate queries for the restored incident scope (for example counts by
order state) from an operator-only one-shot container. Do not paste customer rows into tickets or
logs.

For withdrawal recovery, select one known active synthetic case and one known purged synthetic
case from the drill inventory. Through the authenticated operator interface, prove the active case
decrypts with its customer and reconciliation fields intact. Prove the purged case retains only
its PII-free summary/history and cannot load encrypted payload data. Do not print either case's PII
to terminal output, CI logs, or tickets. A decrypt alert after restore is a stop condition: keep
commerce disabled, verify that the exact historical `WITHDRAWAL_DATA_KEY` was restored, and follow
the decrypt-failure procedure in [withdrawal operations](withdrawals.md). Never substitute a newly
generated key.

## Roll back the restore

The restore deliberately retains `/data/shop.pre-restore.<timestamp>.sqlite`. It is a standalone,
materialized SQLite database containing the prior committed logical state; it does not depend on
the old `shop.sqlite-wal` or `shop.sqlite-shm` files.

1. Put the service back into maintenance, stop the application container, and again prove no
   process has `/data` open.
2. Preserve the failed restored database for investigation with SQLite online backup so committed
   WAL pages are included. Copy the selected standalone pre-restore file to a temporary file on the
   same volume, remove the stopped database's stale sidecars, and atomically replace the database:

```bash
docker run --rm \
  --volume <coolify-data-volume>:/data \
  --entrypoint node \
  <immutable-image> \
  --input-type=module --eval '
    import Database from "better-sqlite3";
    import { chmod, copyFile, open, rename, rm } from "node:fs/promises";
    const selected = process.argv[1];
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(/[-:]/g, "") + "Z";
    const failed = new Database("/data/shop.sqlite", { fileMustExist: true });
    try { await failed.backup(`/data/shop.failed-restore.${stamp}.sqlite`); }
    finally { failed.close(); }
    await copyFile(selected, "/data/shop.rollback.tmp");
    await chmod("/data/shop.rollback.tmp", 0o600);
    const rollback = await open("/data/shop.rollback.tmp", "r");
    try { await rollback.sync(); } finally { await rollback.close(); }
    await Promise.all([
      rm("/data/shop.sqlite-wal", { force: true }),
      rm("/data/shop.sqlite-shm", { force: true })
    ]);
    await rename("/data/shop.rollback.tmp", "/data/shop.sqlite");
    const directory = await open("/data", "r");
    try { await directory.sync(); } finally { await directory.close(); }
  ' \
  /data/shop.pre-restore.<timestamp>.sqlite
```

3. Restart with `DATABASE_BOOTSTRAP=false`. Require successful migration startup, readiness, and
   reviewed aggregate row counts before reopening traffic.

## Automated restore drill

`tests/integration/backup-restore-drill.test.ts` is the self-cleaning production-shaped drill. Its
failure cases use a temporary file transport, and its full path uses a bounded host-local
S3-compatible HTTPS server with the production `createS3BackupStore` and
`createRestoreStoreFromEnvironment` factories and real signed AWS SDK requests. The real-client
portion runs in an isolated child process which trusts only the fixture certificate through
`NODE_EXTRA_CA_CERTS`; it never disables TLS verification or mutates the parent process TLS
environment. The drill proves:

- SQLite online backup of a migrated WAL database;
- exact encryption/checksum compatibility with the offline restore program;
- checksum and authenticated-decryption corruption rejection without replacement;
- both destructive confirmation gates before any store construction;
- noncanonical pre-copy construction, `quick_check`, chmod/fsync-before-publication, and cleanup on
  injected backup, verification, and sync failures;
- committed crash-left WAL recovery into the standalone prior-database copy, atomic sidecar
  quarantine/rollback, deterministic prior-state installation before the final rename, and a clean
  restored restart;
- exact prior/restored file states after sidecar cleanup failure, final-rename failure, and a
  post-rename sync failure reported as `RESTORE_STATE_UNCERTAIN`;
- real PUT/GET bodies, paginated LIST, encrypted/checksum pair deletion, and HTTPS fixture teardown;
- restored migration ledger and exact row-count assertions; and
- application readiness against the restored `/data/shop.sqlite` analogue.
- active withdrawal payload recovery with the original withdrawal key and purged-case
  non-recoverability after restore.

Run it with:

```bash
pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/backup-restore-drill.test.ts
```
