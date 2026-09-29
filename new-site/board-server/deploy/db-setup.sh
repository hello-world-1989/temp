#!/bin/bash
# Run once on Debian-1-1 (as root): creates the 事件墙 database and role in its PostgreSQL.
# The password is read from Parameter Store (/end-gfw/board/DB_PASSWORD), so it never appears
# in a command line or in SSM command history. The role may only connect over TLS from the
# Lightsail private network (172.26.0.0/16); pg_hba lines are added before the generic ones.
set -euo pipefail
cd /
pw=$(python3 -c "import boto3; print(boto3.client('ssm', region_name='us-east-1').get_parameter(Name='/end-gfw/board/DB_PASSWORD', WithDecryption=True)['Parameter']['Value'])")
psql_su() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qAt "$@"; }
if psql_su -c "select 1 from pg_roles where rolname = 'end_gfw_board'" | grep -q 1; then
  printf "alter role end_gfw_board with login password '%s';\n" "$pw" | psql_su
else
  printf "create role end_gfw_board with login password '%s';\n" "$pw" | psql_su
fi
psql_su -c "select 1 from pg_database where datname = 'end_gfw_board'" | grep -q 1 || psql_su -c 'create database end_gfw_board owner end_gfw_board'
psql_su -d end_gfw_board -c 'revoke all on database end_gfw_board from public'

hba=$(psql_su -c 'show hba_file')
if ! grep -q 'end_gfw_board' "$hba"; then
  cp -a "$hba" "$hba.pre-board"
  python3 - "$hba" <<'PY'
import sys
path = sys.argv[1]
lines = open(path).read().split('\n')
block = [
    '# 事件墙 (Debian-1-2): only over TLS from the Lightsail private network',
    'hostssl end_gfw_board end_gfw_board 172.26.0.0/16 scram-sha-256',
    'host    end_gfw_board all           0.0.0.0/0     reject',
    'host    end_gfw_board all           ::/0          reject',
    'host    all           end_gfw_board 0.0.0.0/0     reject',
    'host    all           end_gfw_board ::/0          reject',
]
i = next(k for k, l in enumerate(lines) if l.split()[:1] in (['host'], ['hostssl'], ['hostnossl']))
open(path, 'w').write('\n'.join(lines[:i] + block + lines[i:]))
PY
  psql_su -c 'select pg_reload_conf()' >/dev/null
fi
psql_su -c "select count(*) from pg_hba_file_rules where error is not null" | grep -qx 0 || { echo "pg_hba has errors"; exit 1; }
echo "database ready"
