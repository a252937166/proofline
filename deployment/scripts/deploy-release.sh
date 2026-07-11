#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 027

API_ARCHIVE=
WEB_ARCHIVE=
API_CHECKSUM=
WEB_CHECKSUM=
PUBLIC_HEALTH_URL=
LOCAL_HEALTH_URL=${LOCAL_HEALTH_URL:-http://127.0.0.1:4035/api/health}

usage() {
  cat <<'EOF'
Usage: deploy-release.sh --api FILE --web FILE [options]

Options:
  --api-sha256 FILE       Defaults to FILE.sha256
  --web-sha256 FILE       Defaults to FILE.sha256
  --public-health-url URL Optional post-reload public health check

The script verifies checksums, installs a release atomically, and restores both
API and web symlinks automatically if restart or health validation fails.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api)
      API_ARCHIVE=${2:?missing value for --api}
      shift 2
      ;;
    --web)
      WEB_ARCHIVE=${2:?missing value for --web}
      shift 2
      ;;
    --api-sha256)
      API_CHECKSUM=${2:?missing value for --api-sha256}
      shift 2
      ;;
    --web-sha256)
      WEB_CHECKSUM=${2:?missing value for --web-sha256}
      shift 2
      ;;
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
  printf 'deploy-release.sh must run as root\n' >&2
  exit 1
fi
if [[ ! -c /dev/null ]]; then
  printf '/dev/null is not a character device; refusing to restart services until the host device is repaired\n' >&2
  exit 1
fi
if [[ -z "${API_ARCHIVE}" || -z "${WEB_ARCHIVE}" ]]; then
  usage >&2
  exit 2
fi
API_CHECKSUM=${API_CHECKSUM:-"${API_ARCHIVE}.sha256"}
WEB_CHECKSUM=${WEB_CHECKSUM:-"${WEB_ARCHIVE}.sha256"}

for required_path in \
  "${API_ARCHIVE}" "${WEB_ARCHIVE}" "${API_CHECKSUM}" "${WEB_CHECKSUM}" \
  /etc/systemd/system/proofline-api.service \
  /etc/systemd/system/proofline-mcp.service \
  /opt/proofline/shared/api.env \
  /opt/proofline/shared/mcp.env; do
  if [[ ! -r "${required_path}" ]]; then
    printf 'Required file is missing or unreadable: %s\n' "${required_path}" >&2
    exit 1
  fi
done
if [[ "$(stat -c '%u:%a' /opt/proofline/shared/api.env)" != "0:600" ]]; then
  printf '/opt/proofline/shared/api.env must be owned by root with mode 0600\n' >&2
  exit 1
fi

for command_name in node npm tar sha256sum systemctl nginx curl runuser; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "${command_name}" >&2
    exit 1
  fi
done

verify_checksum() {
  local artifact=$1
  local checksum_file=$2
  local expected
  local actual
  expected=$(awk 'NR == 1 { print $1 }' "${checksum_file}")
  if [[ ! "${expected}" =~ ^[0-9a-fA-F]{64}$ ]]; then
    printf 'Invalid SHA-256 manifest: %s\n' "${checksum_file}" >&2
    return 1
  fi
  actual=$(sha256sum "${artifact}" | awk '{ print $1 }')
  if [[ "${actual,,}" != "${expected,,}" ]]; then
    printf 'SHA-256 mismatch for %s\n' "${artifact}" >&2
    return 1
  fi
}

validate_archive() {
  local archive=$1
  local bad_path
  bad_path=$(tar -tzf "${archive}" | awk '
    /^\// || /(^|\/)\.\.($|\/)/ || /(^|\/)\.env($|[.\/])/ || /(^|\/)data\/runtime($|\/)/ {
      print
      exit
    }
  ')
  if [[ -n "${bad_path}" ]]; then
    printf 'Unsafe path in %s: %s\n' "${archive}" "${bad_path}" >&2
    return 1
  fi
}

verify_checksum "${API_ARCHIVE}" "${API_CHECKSUM}"
verify_checksum "${WEB_ARCHIVE}" "${WEB_CHECKSUM}"
validate_archive "${API_ARCHIVE}"
validate_archive "${WEB_ARCHIVE}"

install -d -o root -g root -m 0755 /opt/proofline/releases /var/www/proofline/releases
API_STAGE=$(mktemp -d /opt/proofline/releases/.staging.XXXXXX)
WEB_STAGE=$(mktemp -d /var/www/proofline/releases/.staging.XXXXXX)
cleanup_staging() {
  [[ -n "${API_STAGE:-}" ]] && rm -rf "${API_STAGE}"
  [[ -n "${WEB_STAGE:-}" ]] && rm -rf "${WEB_STAGE}"
  return 0
}
trap cleanup_staging EXIT INT TERM

tar --no-same-owner --no-same-permissions -xzf "${API_ARCHIVE}" -C "${API_STAGE}"
tar --no-same-owner --no-same-permissions -xzf "${WEB_ARCHIVE}" -C "${WEB_STAGE}"

for expected_file in \
  "${API_STAGE}/RELEASE" \
  "${API_STAGE}/apps/api/dist/index.js" \
  "${API_STAGE}/packages/core/dist/index.js" \
  "${API_STAGE}/packages/mcp/dist/index.js" \
  "${API_STAGE}/data/replays/wales-iran-2022.json" \
  "${API_STAGE}/data/schedules/world-cup-2026.json" \
  "${API_STAGE}/data/snapshots/france-morocco-2026.json" \
  "${API_STAGE}/data/evidence/featured-proof.json" \
  "${API_STAGE}/package.json" \
  "${API_STAGE}/package-lock.json" \
  "${WEB_STAGE}/RELEASE" \
  "${WEB_STAGE}/index.html"; do
  if [[ ! -f "${expected_file}" ]]; then
    printf 'Release is missing required file: %s\n' "${expected_file}" >&2
    exit 1
  fi
done

API_RELEASE_ID=$(tr -d '\r\n' < "${API_STAGE}/RELEASE")
WEB_RELEASE_ID=$(tr -d '\r\n' < "${WEB_STAGE}/RELEASE")
if [[ ! "${API_RELEASE_ID}" =~ ^[A-Za-z0-9._-]{1,80}$ ]] || [[ "${API_RELEASE_ID}" != "${WEB_RELEASE_ID}" ]]; then
  printf 'API and web archives do not carry the same valid release ID\n' >&2
  exit 1
fi
RELEASE_ID=${API_RELEASE_ID}
API_RELEASE="/opt/proofline/releases/${RELEASE_ID}"
WEB_RELEASE="/var/www/proofline/releases/${RELEASE_ID}"
if [[ -e "${API_RELEASE}" || -e "${WEB_RELEASE}" ]]; then
  printf 'Release already exists; use a new immutable release ID: %s\n' "${RELEASE_ID}" >&2
  exit 1
fi

chmod 0755 "${API_STAGE}"
chown -R proofline:proofline "${API_STAGE}"
if [[ ! -d "${API_STAGE}/node_modules" ]]; then
  runuser -u proofline -- /usr/bin/env \
    HOME=/tmp \
    npm_config_cache=/tmp/proofline-npm-cache \
    npm ci --prefix "${API_STAGE}" --omit=dev --ignore-scripts --no-audit --no-fund
fi

runuser -u proofline -- /usr/bin/env NODE_ENV=production \
  node --input-type=module --eval \
  "await import('file://${API_STAGE}/apps/api/dist/app.js')"

chown -R root:proofline "${API_STAGE}"
find "${API_STAGE}" -type d -exec chmod 0750 {} +
find "${API_STAGE}" -type f -perm /111 -exec chmod 0750 {} +
find "${API_STAGE}" -type f ! -perm /111 -exec chmod 0640 {} +
chown -R root:root "${WEB_STAGE}"
find "${WEB_STAGE}" -type d -exec chmod 0755 {} +
find "${WEB_STAGE}" -type f -exec chmod 0644 {} +
rm -f "${WEB_STAGE}/RELEASE"

mv "${API_STAGE}" "${API_RELEASE}"
API_STAGE=
mv "${WEB_STAGE}" "${WEB_RELEASE}"
WEB_STAGE=

if [[ -e /opt/proofline/current && ! -L /opt/proofline/current ]]; then
  printf '/opt/proofline/current exists and is not a symlink\n' >&2
  exit 1
fi
if [[ -e /var/www/proofline/current && ! -L /var/www/proofline/current ]]; then
  printf '/var/www/proofline/current exists and is not a symlink\n' >&2
  exit 1
fi

OLD_API=$(readlink -f /opt/proofline/current 2>/dev/null || true)
OLD_WEB=$(readlink -f /var/www/proofline/current 2>/dev/null || true)
SWITCHED=0

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

rollback_on_error() {
  local status=$?
  trap - ERR
  if (( SWITCHED == 1 )); then
    set +e
    restore_link "${OLD_API}" /opt/proofline/current
    restore_link "${OLD_WEB}" /var/www/proofline/current
    if [[ -n "${OLD_API}" ]]; then
      systemctl restart proofline-api.service
      systemctl restart proofline-mcp.service
    else
      systemctl stop proofline-mcp.service
      systemctl stop proofline-api.service
    fi
    if systemctl is-active --quiet nginx; then
      systemctl reload nginx
    fi
    printf 'Deployment failed; previous API and web symlinks were restored\n' >&2
  fi
  exit "${status}"
}
trap rollback_on_error ERR

atomic_link "${API_RELEASE}" /opt/proofline/current
atomic_link "${WEB_RELEASE}" /var/www/proofline/current
SWITCHED=1

systemctl restart proofline-api.service

wait_for_health() {
  local url=$1
  local attempts=${2:-30}
  local response
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if response=$(curl --fail --silent --show-error --max-time 3 "${url}" 2>/dev/null); then
      if [[ "${response}" == *'"status":"ok"'* && "${response}" == *'"service":"proofline-api"'* ]]; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

wait_for_health "${LOCAL_HEALTH_URL}" 30
systemctl restart proofline-mcp.service

wait_for_mcp() {
  local attempts=${1:-75}
  local response
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if response=$(curl --fail --silent --show-error --max-time 3 \
      http://127.0.0.1:4035/api/mcp/runtime 2>/dev/null); then
      if printf '%s' "${response}" | node -e '
        let input = "";
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          const value = JSON.parse(input);
          const heartbeatAt = Date.parse(value.heartbeat?.at ?? "");
          const age = Date.now() - heartbeatAt;
          if (
            value.agentReady !== true ||
            value.heartbeat?.transport !== "stdio" ||
            !Number.isFinite(age) ||
            age < 0 ||
            age > 20_000
          ) process.exit(1);
        });
      '; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

wait_for_mcp 75
nginx -t
if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl start nginx
fi
if [[ -n "${PUBLIC_HEALTH_URL}" ]]; then
  wait_for_health "${PUBLIC_HEALTH_URL}" 15
fi

trap - ERR
printf 'Proofline release %s is active.\n' "${RELEASE_ID}"
printf 'API: %s\nWeb: %s\n' "${API_RELEASE}" "${WEB_RELEASE}"
