#!/usr/bin/env bash
set -euo pipefail

# Import Marketsflow users → Xyrra Supabase public.old_users
#
# Required env:
#   MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
#   SUPABASE_DB_URL  e.g. postgresql://postgres.[ref]:[password]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres
#
# Optional:
#   INCLUDE_DELETED=1   include soft-deleted users (deleted_at IS NOT NULL)
#   DRY_RUN=1           export only; do not write to Supabase
#
# Example (local MAMP copy of marketsflow_production):
#   MYSQL_HOST=127.0.0.1 MYSQL_PORT=8889 MYSQL_USER=root MYSQL_PASSWORD=root \
#   MYSQL_DATABASE=marketsflow_production \
#   SUPABASE_DB_URL='postgresql://postgres.[ref]:[password]@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres' \
#   ./scripts/import-old-users-from-marketsflow.sh
#
# Example (production MySQL via SSH tunnel):
#   ssh -N -L 3307:127.0.0.1:3306 root@49.13.215.38
#   MYSQL_HOST=127.0.0.1 MYSQL_PORT=3307 MYSQL_USER=... MYSQL_PASSWORD=... \
#   MYSQL_DATABASE=marketsflow_production SUPABASE_DB_URL='...' \
#   ./scripts/import-old-users-from-marketsflow.sh

: "${MYSQL_HOST:?MYSQL_HOST is required}"
: "${MYSQL_PORT:?MYSQL_PORT is required}"
: "${MYSQL_USER:?MYSQL_USER is required}"
: "${MYSQL_PASSWORD:?MYSQL_PASSWORD is required}"
: "${MYSQL_DATABASE:?MYSQL_DATABASE is required}"
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is required}"

TSV_FILE="$(mktemp /tmp/xyrra-old-users.XXXXXX.tsv)"

cleanup() {
  rm -f "$TSV_FILE"
}
trap cleanup EXIT

WHERE_CLAUSE="WHERE deleted_at IS NULL"
if [[ "${INCLUDE_DELETED:-0}" == "1" ]]; then
  WHERE_CLAUSE=""
fi

echo "Exporting from MySQL ${MYSQL_DATABASE}.users …"

mysql \
  -h "$MYSQL_HOST" \
  -P "$MYSQL_PORT" \
  -u "$MYSQL_USER" \
  -p"$MYSQL_PASSWORD" \
  "$MYSQL_DATABASE" \
  -N -B \
  -e "
    SELECT
      id,
      name,
      first_name,
      last_name,
      email,
      created_at
    FROM users
    ${WHERE_CLAUSE}
    ORDER BY id
  " > "$TSV_FILE"

ROW_COUNT="$(wc -l < "$TSV_FILE" | tr -d ' ')"
echo "Exported ${ROW_COUNT} users."

if [[ "$ROW_COUNT" == "0" ]]; then
  echo "Nothing to import."
  exit 0
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 — sample rows:"
  head -3 "$TSV_FILE"
  exit 0
fi

echo "Loading into Supabase public.old_users …"

psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 <<SQL
create temp table old_users_import (
  old_id bigint,
  name text,
  f_name text,
  l_name text,
  email text,
  created timestamptz
);

\\copy old_users_import(old_id, name, f_name, l_name, email, created) FROM '${TSV_FILE}' WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N');

insert into public.old_users (old_id, name, f_name, l_name, email, created)
select
  old_id,
  nullif(btrim(name), ''),
  nullif(btrim(f_name), ''),
  nullif(btrim(l_name), ''),
  nullif(btrim(email), ''),
  coalesce(created, now())
from old_users_import
on conflict (old_id) do update set
  name = excluded.name,
  f_name = excluded.f_name,
  l_name = excluded.l_name,
  email = excluded.email,
  created = excluded.created;

select count(*) as total_old_users from public.old_users;
SQL

echo "Import complete."
