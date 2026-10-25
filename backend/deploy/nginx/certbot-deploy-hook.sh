#!/bin/sh
# Install as root-owned /etc/letsencrypt/renewal-hooks/deploy/dao-nginx-reload.
set -eu
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
