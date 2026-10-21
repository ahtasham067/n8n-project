#!/usr/bin/env bash
# Purge deprecated n8n Data Tables (Appointments, Doctors) from n8n SQLite after export.
# Requires backup at backups/legacy-data-tables-export.json and n8n_data volume backup.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXPORT="$ROOT/backups/legacy-data-tables-export.json"
if [[ ! -f "$EXPORT" ]]; then
  echo "Missing $EXPORT — export legacy rows before purge." >&2
  exit 1
fi
echo "Stopping n8n..."
docker stop n8n >/dev/null
docker cp n8n:/home/node/.n8n/database.sqlite /tmp/n8n_purge.sqlite 2>/dev/null || \
  docker run --rm -v n8n_data:/data alpine cat /data/database.sqlite > /tmp/n8n_purge.sqlite
python3 << 'PY'
import sqlite3
con = sqlite3.connect('/tmp/n8n_purge.sqlite')
cur = con.cursor()
tables = [
  'data_table_user_1tLS1N4K93xGHwfs',
  'data_table_user_gC8JDQIgpzSnxdTl',
]
for t in tables:
    try:
        cur.execute(f'DELETE FROM "{t}"')
        print('cleared', t, cur.rowcount, 'rows')
    except Exception as e:
        print('skip', t, e)
for dt_id in ('1tLS1N4K93xGHwfs', 'gC8JDQIgpzSnxdTl'):
    cur.execute('DELETE FROM data_table_column WHERE dataTableId=?', (dt_id,))
    cur.execute('DELETE FROM data_table WHERE id=?', (dt_id,))
    print('removed metadata for', dt_id)
con.commit()
con.close()
print('purge complete')
PY
docker run --rm -i -v n8n_data:/data alpine sh -c 'cat > /data/database.sqlite' < /tmp/n8n_purge.sqlite
echo "Starting n8n..."
docker start n8n >/dev/null
echo "Done. Legacy Data Tables purged from n8n SQLite."
