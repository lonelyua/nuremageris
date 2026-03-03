#!/bin/bash
# Applies stored procedure SQL files from /docker-entrypoint-procs/
# This script is executed by the PostgreSQL Docker entrypoint on first container
# start, after 001_schema.sql has been applied.
set -e

PROCS_DIR="/docker-entrypoint-procs"

if [ ! -d "$PROCS_DIR" ]; then
  echo "002_procs.sh: $PROCS_DIR not mounted, skipping stored procedures."
  exit 0
fi

echo "002_procs.sh: applying stored procedures from $PROCS_DIR ..."
for f in $(ls "$PROCS_DIR"/*.sql 2>/dev/null | sort); do
  echo "  -> $f"
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
done
echo "002_procs.sh: done."
