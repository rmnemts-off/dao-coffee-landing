#!/usr/bin/env python3
"""Render a domain migration bundle. Never changes DNS, services or CRM."""
import argparse
import ipaddress
import json
from pathlib import Path
import re


def domain_name(value):
    value = value.lower()
    labels = value.split('.')
    if (len(value) > 253 or len(labels) < 2 or
            any(not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label)
                for label in labels) or labels[-1].isdigit()):
        raise ValueError('Use an ASCII public DNS name without scheme, path, port or wildcard')
    return value


def render(domain, aliases, address):
    domain = domain_name(domain)
    aliases = [domain_name(alias) for alias in aliases]
    if len(set([domain] + aliases)) != len(aliases) + 1:
        raise ValueError('Domain and aliases must be distinct')
    ip = ipaddress.IPv4Address(address)
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast:
        raise ValueError('Expected the approved VPS IPv4 address')
    address = str(ip)
    names = ' '.join([domain] + aliases)
    source = Path(__file__).parent / 'nginx' / 'dao-ip-https.conf.template'
    ip_config = source.read_text().replace('__DAO_IPV4__', address)
    domain_http = f'''
server {{
    listen 80;
    listen [::]:80;
    server_name {names};
    include /etc/nginx/snippets/dao-server-defaults.conf;
    include /etc/nginx/snippets/dao-acme.conf;
    include /etc/nginx/snippets/dao-private-locations.conf;
    location / {{
        default_type text/plain;
        add_header Cache-Control no-store always;
        return 503 "Domain HTTPS setup is in progress.\\n";
    }}
}}
'''
    bootstrap = ip_config + domain_http
    # Keep the IP's HTTP-01 route and default TLS certificate for no-SNI clients.
    marker = '    location = /robots.txt {'
    if ip_config.count(marker) != 1:
        raise ValueError('IP template changed; review the migration renderer')
    final = ip_config.split(marker)[0].replace(
        f'return 308 https://{address}$request_uri;',
        f'add_header Cache-Control no-store always; return 307 https://{domain}$request_uri;')
    final += f'''    include /etc/nginx/snippets/dao-private-locations.conf;
    location / {{
        add_header Cache-Control no-store always;
        return 307 https://{domain}$request_uri;
    }}
}}
'''
    final += domain_http.replace(
        'return 503 "Domain HTTPS setup is in progress.\\n";',
        f'return 308 https://{domain}$request_uri;')
    tls = f'''    ssl_certificate /etc/letsencrypt/live/dao-domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dao-domain/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:DAO_TLS:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
'''
    final += f'''
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {domain};
    include /etc/nginx/snippets/dao-server-defaults.conf;
{tls}    include /etc/nginx/snippets/dao-site.conf;
}}
'''
    if aliases:
        final += f'''
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {' '.join(aliases)};
    include /etc/nginx/snippets/dao-server-defaults.conf;
{tls}    include /etc/nginx/snippets/dao-private-locations.conf;
    location / {{ return 308 https://{domain}$request_uri; }}
}}
'''
    rollback = ip_config + domain_http.replace(
        'return 503 "Domain HTTPS setup is in progress.\\n";',
        f'return 307 https://{address}$request_uri;')
    rollback += f'''
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {names};
    include /etc/nginx/snippets/dao-server-defaults.conf;
{tls}    include /etc/nginx/snippets/dao-private-locations.conf;
    location / {{
        add_header Cache-Control no-store always;
        return 307 https://{address}$request_uri;
    }}
}}
'''
    return {'domain': domain, 'aliases': aliases, 'ipv4': address,
            'bootstrap': bootstrap, 'https': final, 'rollback': rollback}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--domain', required=True)
    parser.add_argument('--alias', action='append', default=[])
    parser.add_argument('--ipv4', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        bundle = render(args.domain, args.alias, args.ipv4)
    except ValueError as error:
        parser.error(str(error))
    # Refuse to overwrite a previously reviewed bundle, even partially.
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name in ('bootstrap', 'https', 'rollback'):
        (args.output / f'dao-domain-{name}.conf').write_text(bundle[name])
    metadata = {key: bundle[key] for key in ('domain', 'aliases', 'ipv4')}
    (args.output / 'domain.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(f'Prepared {args.output}; no configuration has been activated.')


if __name__ == '__main__':
    main()
