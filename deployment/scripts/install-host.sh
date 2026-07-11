#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOYMENT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
NGINX_MODE=http

usage() {
  cat <<'EOF'
Usage: install-host.sh [--nginx http|https]

Creates the proofline user/directories, installs systemd and nginx templates,
and creates a root-only environment file if one does not already exist.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nginx)
      NGINX_MODE=${2:?missing value for --nginx}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ "${NGINX_MODE}" != http && "${NGINX_MODE}" != https ]]; then
  printf '--nginx must be http or https\n' >&2
  exit 2
fi
if (( EUID != 0 )); then
  printf 'install-host.sh must run as root\n' >&2
  exit 1
fi

"${SCRIPT_DIR}/check-host.sh"

if ! getent group proofline >/dev/null 2>&1; then
  groupadd --system proofline
fi
if ! id -u proofline >/dev/null 2>&1; then
  useradd --system --gid proofline --home-dir /opt/proofline --shell /sbin/nologin proofline
fi

install -d -o root -g root -m 0755 /opt/proofline /opt/proofline/releases
install -d -o root -g root -m 0700 /opt/proofline/shared
install -d -o proofline -g proofline -m 0700 /opt/proofline/state
install -d -o root -g root -m 0755 /var/www/proofline /var/www/proofline/releases
install -d -o root -g root -m 0755 /var/www/letsencrypt

if [[ ! -e /opt/proofline/shared/api.env ]]; then
  install -o root -g root -m 0600 \
    "${DEPLOYMENT_DIR}/env/api.env.example" \
    /opt/proofline/shared/api.env
  printf 'Created /opt/proofline/shared/api.env; review it before first deploy.\n'
else
  chown root:root /opt/proofline/shared/api.env
  chmod 0600 /opt/proofline/shared/api.env
  printf 'Preserved existing /opt/proofline/shared/api.env and enforced mode 0600.\n'
fi

if [[ ! -e /opt/proofline/shared/mcp.env ]]; then
  install -o root -g root -m 0600 \
    "${DEPLOYMENT_DIR}/env/mcp.env.example" \
    /opt/proofline/shared/mcp.env
  printf 'Created /opt/proofline/shared/mcp.env; set the shared audit token before deploy.\n'
else
  chown root:root /opt/proofline/shared/mcp.env
  chmod 0600 /opt/proofline/shared/mcp.env
  printf 'Preserved existing /opt/proofline/shared/mcp.env and enforced mode 0600.\n'
fi

install -o root -g root -m 0644 \
  "${DEPLOYMENT_DIR}/systemd/proofline-api.service" \
  /etc/systemd/system/proofline-api.service
install -o root -g root -m 0644 \
  "${DEPLOYMENT_DIR}/systemd/proofline-mcp.service" \
  /etc/systemd/system/proofline-mcp.service

for script_name in deploy-release rollback health-check; do
  install -o root -g root -m 0755 \
    "${SCRIPT_DIR}/${script_name}.sh" \
    "/usr/local/sbin/proofline-${script_name}"
done

NGINX_SOURCE="${DEPLOYMENT_DIR}/nginx/proofline.${NGINX_MODE}.conf"
NGINX_TARGET=/etc/nginx/conf.d/proofline.axiqo.xyz.conf
NGINX_BACKUP=
if [[ "${NGINX_MODE}" == https ]]; then
  for certificate_file in \
    /etc/letsencrypt/live/proofline.axiqo.xyz/fullchain.pem \
    /etc/letsencrypt/live/proofline.axiqo.xyz/privkey.pem; do
    if [[ ! -r "${certificate_file}" ]]; then
      printf 'TLS certificate file is missing: %s\n' "${certificate_file}" >&2
      exit 1
    fi
  done
fi
if [[ -e "${NGINX_TARGET}" ]]; then
  NGINX_BACKUP="${NGINX_TARGET}.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a "${NGINX_TARGET}" "${NGINX_BACKUP}"
fi
install -o root -g root -m 0644 "${NGINX_SOURCE}" "${NGINX_TARGET}"
if ! nginx -t; then
  if [[ -n "${NGINX_BACKUP}" ]]; then
    cp -a "${NGINX_BACKUP}" "${NGINX_TARGET}"
  else
    rm -f "${NGINX_TARGET}"
  fi
  printf 'nginx template failed validation; previous configuration restored\n' >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable proofline-api.service >/dev/null
systemctl enable proofline-mcp.service >/dev/null
systemctl enable nginx >/dev/null
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
fi

printf 'Host layout installed with %s nginx mode. No application release was started.\n' "${NGINX_MODE}"
