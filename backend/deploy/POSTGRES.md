# PostgreSQL deployment and recovery

Production requires PostgreSQL 16+ and `DATABASE_URL`. Install dependencies from
`package-lock.json` using `npm ci --omit=dev --ignore-scripts`. There is no automatic
fallback to SQLite. Local preview can still use the in-memory SQLite adapter.

The VPS uses a Unix socket, `listen_addresses=''`, peer authentication and an
unprivileged database role matching OS user `dao-coffee`. The schema belongs to
the separate NOLOGIN role `dao_owner`. Runtime privileges are in
`backend/db/runtime-grants.sql`; the application cannot create/drop tables or
delete the submission history. Never grant it superuser/ownership.

Example non-secret local connection:
`postgresql:///dao_coffee?host=/var/run/postgresql&user=dao-coffee`.
Keep this alongside existing Bitrix settings in root-owned mode-0600
`/etc/dao-coffee/api.env`. Do not replace the existing webhook/configuration.

For the 1 GiB shared VPS: 20 PostgreSQL connections maximum, 64 MiB shared_buffers,
2 MiB work_mem, 32 MiB maintenance_work_mem, 4 API pool connections. PostgreSQL
statement/error logging must not print payloads. Application errors omit driver
details. Pool/statement timeouts bound failures; readiness checks schema access.

## Test before cutover

Use a separate empty database named `dao_*_test`. `POSTGRES_TEST_URL` selects it:
`node --test backend/test/postgres.test.mjs`. These tests reset ONLY its
`dao_website` schema and use mock senders. Never use production credentials.
Run `npm run check` and `npm test` as well. Verify the same mock flow under the
actual unprivileged runtime role before production.

## One-time offline import

1. Prepare a versioned release and its dependencies; keep the current release.
2. Temporarily return JSON 503 for `/api/leads` at Nginx. Keep the static site online.
3. Stop `dao-coffee-api` gracefully and verify its process is gone.
4. Use SQLite's backup API, verify `PRAGMA quick_check`, retain the WAL-aware
   backup and copy it to private off-server storage. Back up the environment,
   systemd unit and Nginx configuration without printing secrets.
5. In the empty production database, apply `postgres-schema.sql` as `dao_owner`
   and then `runtime-grants.sql` as admin. Schema creation fails if it exists.
6. Run `DATABASE_URL=<migration-role connection> node backend/db/import-sqlite.mjs
   <private SQLite backup>`. Migration needs insertion/sequence rights; do not
   grant migration ownership to the runtime. It never contacts Bitrix. It verifies
   all snapshots, keys, hashes, timestamps, CRM IDs and attempts before COMMIT.
   Nonempty targets, invalid snapshots and conflicting confirmed CRM IDs abort.
7. Set production `DATABASE_URL`, remove the SQLite systemd Environment entry,
   switch the release symlink, reload systemd and start API. Verify `/readyz`,
   PostgreSQL connections and aggregate counts. Do not create a synthetic real
   CRM deal as part of this migration.
8. Restore the ordinary Nginx API location. Keep old SQLite closed and archived.

Legacy `processing` imports as `uncertain`; no old lease is restored. Historical
routes remain NULL, so unfinished legacy requests require operator review before
resuming. Confirmed requests replay their existing ID without any CRM writes.
Do not automatically replay the old database into Bitrix.

## Rollback and backups

Before opening intake, a failed switch can return to the previous release and
SQLite only after stopping the new API and confirming PostgreSQL accepted no new
requests/state changes. Once new PostgreSQL traffic is admitted, the old SQLite
snapshot is stale: repair forward or explicitly migrate all new records back.
Do not blindly switch the code/storage back or replay a stale backup into CRM.

Install `postgres-backup.sh` as `/usr/local/sbin/dao-postgres-backup` with root
ownership and the two `dao-postgres-backup` units. Daily custom-format pg_dump
archives are mode 0600 under `/var/backups/dao-coffee`, retained for 30 days.
Check `systemctl status dao-postgres-backup.timer` and service failures. Restore a
dump to a separate database to test it. Local backups do not survive loss of the
VPS; initial pre/post-migration copies are also saved privately on the operator's
Mac. Continuous off-server backup needs a separately configured destination.
