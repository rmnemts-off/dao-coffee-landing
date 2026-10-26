#!/bin/sh
# Root-owned; backups contain personal data. No payloads/credentials in logs.
set -eu
umask 077
directory=/var/backups/dao-coffee
install -d -m 0700 "$directory"
temporary=$(mktemp "$directory/.postgres.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM
runuser -u postgres -- pg_dump --format=custom --dbname=dao_coffee > "$temporary"
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$directory/postgres-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Retain 30 days of complete backups; incomplete temporary files are not backups.
find "$directory" -maxdepth 1 -type f -name 'postgres-*.dump' -mtime +30 -delete
echo 'DAO PostgreSQL backup completed'
