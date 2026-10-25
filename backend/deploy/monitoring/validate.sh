#!/usr/bin/env bash
set -euo pipefail
# Read-only checks on the deployed host; never sends a lead or contacts Bitrix24.
[[ $(uname -s) == Linux && -d /run/systemd/system ]] || { printf 'Run on the Linux VPS.\n' >&2; exit 1; }
for unit in grafana-server prometheus prometheus-node-exporter; do
  systemctl is-active --quiet "$unit"
done
for port in 3000 9090 9100; do
  bindings=$(ss -H -ltn "sport = :$port" | awk '{print $4}')
  [[ $bindings == "127.0.0.1:$port" ]] || { printf 'Unexpected listener on %s: expected only IPv4 loopback.\n' "$port" >&2; exit 1; }
done
curl --fail --silent --show-error --max-time 10 http://localhost:3000/api/health | python3 -c 'import json,sys; assert json.load(sys.stdin).get("database") == "ok"'
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:9090/-/ready > /dev/null
curl --fail --silent --show-error --max-time 10 'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22node%22%7D' | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["data"]["result"]; assert d["status"] == "success" and len(r)==1 and r[0]["value"][1]=="1", "node scrape not ready; wait 30 seconds and retry"'
code=$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' http://localhost:3000/api/search)
[[ $code == 401 ]] || { printf 'Grafana API unexpectedly allowed an anonymous request (HTTP %s).\n' "$code" >&2; exit 1; }
printf 'PASS: services active, all listeners private, Grafana database ready, node target up, anonymous API denied.\n'
printf 'Also verify the dashboard via SSH tunnel and verify these ports are unreachable from another machine.\n'
