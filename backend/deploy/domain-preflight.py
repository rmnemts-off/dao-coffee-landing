#!/usr/bin/env python3
"""Check DNS/HTTP-01; optionally issue the certificate. Never changes CRM."""
import argparse
import http.client
import ipaddress
import importlib.util
import json
from pathlib import Path
import secrets
import socket
import subprocess

spec = importlib.util.spec_from_file_location('prepare_domain', Path(__file__).with_name('prepare-domain.py'))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--webroot', type=Path, default=Path('/var/lib/letsencrypt'))
    parser.add_argument('--issue', action='store_true', help='After successful checks, request the domain certificate; do not activate it')
    args = parser.parse_args()
    data = json.loads((args.bundle / 'domain.json').read_text())
    expected = str(ipaddress.IPv4Address(data['ipv4']))
    names = [data['domain']] + data['aliases']
    if len(set(names)) != len(names) or any(renderer.domain_name(name) != name for name in names):
        parser.error('Invalid or duplicate hostname in domain.json')
    # Read the exact generated bundle only; no arbitrary URL/proxy is followed.
    for name in names:
        addresses = {item[4][0] for item in socket.getaddrinfo(name, 80, type=socket.SOCK_STREAM)}
        if addresses != {expected}:
            raise SystemExit(f'DNS not ready for {name}: {sorted(addresses)}; expected only {expected}. Check A, CNAME and stale AAAA records.')
        print(f'DNS OK: {name} -> {expected}')
    challenge = args.webroot / '.well-known' / 'acme-challenge'
    if not challenge.is_dir():
        raise SystemExit('ACME webroot is not installed')
    token = 'dao-preflight-' + secrets.token_hex(16)
    path = challenge / token
    created = False
    try:
        with path.open('x') as file:
            created = True
            file.write(token)
        path.chmod(0o644)
        for name in names:
            connection = http.client.HTTPConnection(name, 80, timeout=10)
            try:
                connection.request('GET', '/.well-known/acme-challenge/' + token)
                response = connection.getresponse()
                if response.status != 200 or response.read(200).decode() != token:
                    raise SystemExit(f'HTTP-01 check failed for {name}; do not request a certificate yet')
                print(f'HTTP-01 OK: {name}')
            finally:
                connection.close()
    finally:
        if created:
            path.unlink(missing_ok=True)
    print('Local resolver and HTTP-01 checks passed. Also confirm public resolver propagation and CAA before issuance.')
    if args.issue:
        command = ['/opt/dao-certbot/bin/certbot', 'certonly', '--non-interactive',
                   '--webroot', '--webroot-path', str(args.webroot), '--cert-name', 'dao-domain']
        for name in names:
            command.extend(['-d', name])
        subprocess.run(command, check=True)
        print('Certificate issued. APP_ORIGIN and Nginx have NOT been switched; follow DOMAIN.md.')


if __name__ == '__main__':
    main()
