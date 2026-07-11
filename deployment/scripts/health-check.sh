#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

LOCAL_HEALTH_URL=${LOCAL_HEALTH_URL:-http://127.0.0.1:4035/api/health}
PUBLIC_HEALTH_URL=${PUBLIC_HEALTH_URL:-}

check_url() {
  local label=$1
  local url=$2
  local response
  response=$(curl --fail --silent --show-error --max-time 5 "${url}")
  if [[ "${response}" != *'"status":"ok"'* ]] || [[ "${response}" != *'"service":"proofline-api"'* ]]; then
    printf '%s health response did not identify proofline-api\n' "${label}" >&2
    return 1
  fi
  printf 'PASS  %s %s\n' "${label}" "${url}"
}

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active --quiet proofline-api.service
  printf 'PASS  systemd proofline-api.service is active\n'
fi

check_url local "${LOCAL_HEALTH_URL}"
if [[ -n "${PUBLIC_HEALTH_URL}" ]]; then
  check_url public "${PUBLIC_HEALTH_URL}"
fi
