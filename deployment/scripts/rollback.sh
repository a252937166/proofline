#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

LOCAL_HEALTH_URL=${LOCAL_HEALTH_URL:-http://127.0.0.1:4035/api/health}
PUBLIC_HEALTH_URL=
RELEASE_ID=

usage() {
  cat <<'EOF'
Usage: rollback.sh RELEASE_ID [--public-health-url URL]

Switches API and web to one previously installed immutable release. If the
service or health check fails, the current symlinks are restored.
EOF
}

if [[ $# -gt 0 && "$1" != --* ]]; then
  RELEASE_ID=$1
  shift
fi
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-health-url)
      PUBLIC_HEALTH_URL=${2:?missing value for --public-health-url}
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

if (( EUID != 0 )); then
  printf 'rollback.sh must run as root\n' >&2
  exit 1
fi
if [[ ! "${RELEASE_ID}" =~ ^[A-Za-z0-9._-]{1,80}$ ]]; then
  usage >&2
  exit 2
fi

TARGET_API="/opt/proofline/releases/${RELEASE_ID}"
TARGET_WEB="/var/www/proofline/releases/${RELEASE_ID}"
for target in "${TARGET_API}" "${TARGET_WEB}"; do
  if [[ ! -d "${target}" ]]; then
    printf 'Release target does not exist: %s\n' "${target}" >&2
    exit 1
  fi
done

OLD_API=$(readlink -f /opt/proofline/current 2>/dev/null || true)
OLD_WEB=$(readlink -f /var/www/proofline/current 2>/dev/null || true)

atomic_link() {
  local target=$1
  local link_path=$2
  local next_link="${link_path}.next.$$"
  ln -s "${target}" "${next_link}"
  mv -Tf "${next_link}" "${link_path}"
}

restore_link() {
  local previous=$1
  local link_path=$2
  if [[ -n "${previous}" && -d "${previous}" ]]; then
    atomic_link "${previous}" "${link_path}"
  else
    rm -f "${link_path}"
  fi
}

restore_on_error() {
  local status=$?
  trap - ERR
  set +e
  restore_link "${OLD_API}" /opt/proofline/current
  restore_link "${OLD_WEB}" /var/www/proofline/current
  systemctl restart proofline-api.service
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  fi
  printf 'Rollback target failed health validation; original release restored\n' >&2
  exit "${status}"
}
trap restore_on_error ERR

atomic_link "${TARGET_API}" /opt/proofline/current
atomic_link "${TARGET_WEB}" /var/www/proofline/current
systemctl restart proofline-api.service

response=
for attempt in {1..30}; do
  if response=$(curl --fail --silent --show-error --max-time 3 "${LOCAL_HEALTH_URL}" 2>/dev/null); then
    if [[ "${response}" == *'"status":"ok"'* && "${response}" == *'"service":"proofline-api"'* ]]; then
      break
    fi
  fi
  response=
  sleep 1
done
if [[ -z "${response}" ]]; then
  false
fi

nginx -t
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi
if [[ -n "${PUBLIC_HEALTH_URL}" ]]; then
  PUBLIC_HEALTH_URL="${PUBLIC_HEALTH_URL}" /usr/local/sbin/proofline-health-check
fi

trap - ERR
printf 'Proofline rolled back to %s.\n' "${RELEASE_ID}"
