#!/usr/bin/env bash
# Run on the approved VPS only. Never invoke with bash -x.
set +x
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ ${EUID} == 0 ]] || fail 'Run as root on the approved VPS.'
[[ $(uname -s) == Linux && -r /etc/os-release && -d /run/systemd/system ]] || fail 'Requires Linux with systemd.'
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || fail 'This resource-limit profile requires cgroup v2.'
# This is a root-owned OS file, not project configuration or credentials.
. /etc/os-release
case "${ID}:${VERSION_ID}" in
  debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) ;;
  *) fail 'Supported preflight: Debian 12/13 or Ubuntu 22.04/24.04. Review other OS releases separately.' ;;
esac
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) fail 'Review this CPU architecture separately.' ;; esac
command -v ss >/dev/null || fail 'Missing ss (iproute2): install the distro package and rerun preflight.'

task_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state_dir=/var/lib/dao-monitoring-install
repo_file=/etc/apt/sources.list.d/dao-grafana.list
key_file=/etc/apt/keyrings/dao-grafana.asc
packages=(grafana prometheus prometheus-node-exporter)
units=(grafana-server.service prometheus.service prometheus-node-exporter.service)
repo_line='deb [signed-by=/etc/apt/keyrings/dao-grafana.asc] https://apt.grafana.com stable main'

fresh_host() {
  for package in "${packages[@]}"; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      fail "Existing $package installation: review/migrate manually; this installer is fresh-only."
    fi
  done
  for path in /etc/grafana /etc/prometheus /var/lib/grafana /var/lib/prometheus "$state_dir"; do
    [[ ! -e $path ]] || fail "Existing state at $path: review manually, do not overwrite it."
  done
  for unit in "${units[@]}"; do
    [[ ! -e /etc/systemd/system/"$unit" && ! -d /etc/systemd/system/"$unit".d ]] || fail "Existing override for $unit."
    [[ $(systemctl show "$unit" -p LoadState --value 2>/dev/null) == not-found ]] || fail "Existing systemd unit $unit: review it manually before installing."
  done
  for port in 3000 9090 9100; do
    [[ -z $(ss -H -ltn "sport = :$port") ]] || fail "Port $port is already in use."
  done
}

case ${1:-} in
  --prepare)
    [[ $# == 1 ]] || fail 'Usage: install.sh --prepare'
    fresh_host
    if [[ -e $repo_file ]]; then
      [[ $(cat "$repo_file") == "$repo_line" ]] || fail 'Repository file differs; review it manually.'
    fi
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl python3
    temp_key=$(mktemp)
    trap 'rm -f -- "$temp_key"' EXIT
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://apt.grafana.com/gpg.key -o "$temp_key"
    # Published at https://apt.grafana.com/; fail closed if the key is rotated.
    fingerprint=$(gpg --batch --show-keys --with-colons "$temp_key" | awk -F: '$1 == "pub" {primary=1; next} primary && $1 == "fpr" {print $10; primary=0}')
    [[ $fingerprint == B53AE77BADB630A683046005963FA27710458545 ]] || fail 'Grafana signing-key fingerprint changed. Verify official rotation before updating this installer.'
    install -d -m 0755 /etc/apt/keyrings
    install -m 0644 "$temp_key" "$key_file"
    printf '%s\n' "$repo_line" > "$repo_file"
    chmod 0644 "$repo_file"
    apt-get update
    printf '\nReview the exact versions AND their signed repository origins below.\n'
    apt-cache policy "${packages[@]}"
    printf '\nNext: install.sh --install GRAFANA_VERSION PROMETHEUS_VERSION NODE_EXPORTER_VERSION\n'
    ;;
  --install)
    [[ $# == 4 ]] || fail 'Usage: install.sh --install GRAFANA_VERSION PROMETHEUS_VERSION NODE_EXPORTER_VERSION'
    fresh_host
    [[ -f $repo_file && -f $key_file && $(cat "$repo_file") == "$repo_line" ]] || fail 'Run --prepare and review package origins first.'
    for version in "$2" "$3" "$4"; do
      [[ $version =~ ^[0-9][A-Za-z0-9.+:~_-]*$ ]] || fail 'Supply exact versions from apt-cache policy, not placeholders.'
    done
    printf 'Choose a unique password saved in your password manager; input is hidden.\n' > /dev/tty
    IFS= read -r -s -p 'Initial dao-admin password (at least 16 characters): ' admin_password < /dev/tty
    printf '\n' > /dev/tty
    [[ ${#admin_password} -ge 16 && $admin_password != [[:space:]]* && $admin_password != *[[:space:]] && $admin_password != *$'\r'* ]] || fail 'Password needs at least 16 characters and no surrounding whitespace.'
    IFS= read -r -s -p 'Repeat password: ' password_confirmation < /dev/tty
    printf '\n' > /dev/tty
    [[ $admin_password == "$password_confirmation" ]] || fail 'Passwords differ.'
    unset password_confirmation
    # Persistent masks also prevent an accidental reboot from exposing defaults.
    systemctl mask "${units[@]}"
    printf 'Services remain masked if installation fails. Unmask only after configuration and secrets are complete.\n'
    apt-get install -y --no-install-recommends "grafana=$2" "prometheus=$3" "prometheus-node-exporter=$4"
    install -d -m 0700 "$state_dir"
    dpkg-query -W -f='${Package}=${Version}\n' "${packages[@]}" > "$state_dir/versions.txt"
    # Explicit holds keep monitoring updates in the manual maintenance workflow.
    apt-mark hold "${packages[@]}"
    for binary in /usr/bin/prometheus /usr/bin/promtool /usr/bin/prometheus-node-exporter; do
      [[ -x $binary ]] || fail "Package layout differs: missing $binary. Services remain masked."
    done
    getent passwd grafana >/dev/null
    getent passwd prometheus >/dev/null
    cp -a /etc/grafana/grafana.ini "$state_dir/grafana.ini.package-default"
    install -d -o root -g grafana -m 0750 /etc/grafana/dao-secrets
    printf '%s' "$admin_password" > /etc/grafana/dao-secrets/admin-password
    unset admin_password
    openssl rand -hex 32 > /etc/grafana/dao-secrets/secret-key
    chown root:grafana /etc/grafana/dao-secrets/admin-password /etc/grafana/dao-secrets/secret-key
    chmod 0640 /etc/grafana/dao-secrets/admin-password /etc/grafana/dao-secrets/secret-key
    install -o root -g grafana -m 0640 "$task_dir/grafana/grafana.ini" /etc/grafana/grafana.ini
    install -d -o root -g grafana -m 0750 /etc/grafana/provisioning/datasources /etc/grafana/provisioning/dashboards
    install -o root -g grafana -m 0640 "$task_dir/grafana/provisioning/datasources/dao-prometheus.yml" /etc/grafana/provisioning/datasources/
    install -o root -g grafana -m 0640 "$task_dir/grafana/provisioning/dashboards/dao-host.yml" /etc/grafana/provisioning/dashboards/
    install -d -o root -g grafana -m 0750 /var/lib/grafana/dashboards
    install -o root -g grafana -m 0640 "$task_dir/grafana/dashboards/dao-host.json" /var/lib/grafana/dashboards/
    install -o root -g prometheus -m 0640 "$task_dir/prometheus.yml" /etc/prometheus/dao-prometheus.yml
    install -d -o prometheus -g prometheus -m 0750 /var/lib/prometheus/dao-metrics
    for unit in "${units[@]}"; do
      install -d -m 0755 /etc/systemd/system/"$unit".d
      install -m 0644 "$task_dir/systemd/${unit%.service}.conf" /etc/systemd/system/"$unit".d/dao-monitoring.conf
    done
    /usr/bin/promtool check config /etc/prometheus/dao-prometheus.yml
    python3 -m json.tool /var/lib/grafana/dashboards/dao-host.json > /dev/null
    systemctl daemon-reload
    systemctl unmask "${units[@]}"
    # No enable/start before secrets, private listeners and resource limits exist.
    systemctl enable --now "${units[@]}"
    printf 'Installed. Run validate.sh; keep 3000/9090/9100 closed in external firewalls.\n'
    ;;
  *) fail 'Usage: install.sh --prepare | --install GRAFANA_VERSION PROMETHEUS_VERSION NODE_EXPORTER_VERSION' ;;
esac
