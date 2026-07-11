#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
umask 022

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOYMENT_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
REPOSITORY_ROOT=$(cd "${DEPLOYMENT_DIR}/.." && pwd)
OUTPUT_DIR=${OUTPUT_DIR:-"${DEPLOYMENT_DIR}/out"}
RUNTIME_MODE=${BUILD_RUNTIME_MODE:-bundled}

usage() {
  cat <<'EOF'
Usage: build-release.sh [--mode bundled|slim] [--output DIR] [--release-id ID]

bundled  Include production node_modules. Recommended for a low-resource host.
slim     Include package-lock.json only; the server runs npm ci during deploy.
EOF
}

RELEASE_ID=${RELEASE_ID:-}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      RUNTIME_MODE=${2:?missing value for --mode}
      shift 2
      ;;
    --output)
      OUTPUT_DIR=${2:?missing value for --output}
      shift 2
      ;;
    --release-id)
      RELEASE_ID=${2:?missing value for --release-id}
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${RUNTIME_MODE}" in
  bundled|slim) ;;
  *)
    printf 'BUILD_RUNTIME_MODE must be bundled or slim\n' >&2
    exit 2
    ;;
esac

for command_name in node npm tar; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is missing: %s\n' "${command_name}" >&2
    exit 1
  fi
done

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [[ ! "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  printf 'Proofline release builds require Node.js 20 or newer\n' >&2
  exit 1
fi

if [[ -z "${RELEASE_ID}" ]]; then
  SOURCE_REVISION=nogit
  if command -v git >/dev/null 2>&1 && git -C "${REPOSITORY_ROOT}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    SOURCE_REVISION=$(git -C "${REPOSITORY_ROOT}" rev-parse --short=12 HEAD)
  fi
  RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SOURCE_REVISION}"
fi
if [[ ! "${RELEASE_ID}" =~ ^[A-Za-z0-9._-]{1,80}$ ]]; then
  printf 'Release ID may contain only letters, numbers, dot, underscore, and dash\n' >&2
  exit 2
fi

mkdir -p "${OUTPUT_DIR}"
OUTPUT_DIR=$(cd "${OUTPUT_DIR}" && pwd)
API_ARCHIVE="${OUTPUT_DIR}/proofline-api-${RELEASE_ID}.tar.gz"
WEB_ARCHIVE="${OUTPUT_DIR}/proofline-web-${RELEASE_ID}.tar.gz"
for artifact in "${API_ARCHIVE}" "${WEB_ARCHIVE}" "${API_ARCHIVE}.sha256" "${WEB_ARCHIVE}.sha256"; do
  if [[ -e "${artifact}" ]]; then
    printf 'Refusing to overwrite existing artifact: %s\n' "${artifact}" >&2
    exit 1
  fi
done

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/proofline-release.XXXXXX")
cleanup() {
  rm -rf "${TEMP_ROOT}"
}
trap cleanup EXIT INT TERM

API_STAGE="${TEMP_ROOT}/api"
WEB_STAGE="${TEMP_ROOT}/web"
mkdir -p \
  "${API_STAGE}/apps/api" \
  "${API_STAGE}/packages/core" \
  "${API_STAGE}/packages/mcp" \
  "${API_STAGE}/data" \
  "${WEB_STAGE}"

cd "${REPOSITORY_ROOT}"
npm run build -w @proofline/core
npm run build -w @proofline/api
npm run build -w @proofline/mcp
VITE_API_BASE=/api npm run build -w @proofline/web

cp -a apps/api/dist "${API_STAGE}/apps/api/dist"
cp -a packages/core/dist "${API_STAGE}/packages/core/dist"
cp packages/core/package.json "${API_STAGE}/packages/core/package.json"
cp -a packages/mcp/dist "${API_STAGE}/packages/mcp/dist"
for dataset_directory in replays schedules snapshots; do
  source_directory="data/${dataset_directory}"
  target_directory="${API_STAGE}/data/${dataset_directory}"
  if [[ ! -d "${source_directory}" ]] || ! find "${source_directory}" -type f -name '*.json' -print -quit | grep -q .; then
    printf 'Required dataset directory has no JSON files: %s\n' "${source_directory}" >&2
    exit 1
  fi
  if find "${source_directory}" -type l -print -quit | grep -q .; then
    printf 'Dataset directories may not contain symlinks: %s\n' "${source_directory}" >&2
    exit 1
  fi
  if find "${source_directory}" -type f ! -name '*.json' -print -quit | grep -q .; then
    printf 'Dataset directories may contain JSON files only: %s\n' "${source_directory}" >&2
    exit 1
  fi
  mkdir -p "${target_directory}"
  cp -a "${source_directory}/." "${target_directory}/"
done
cp "${DEPLOYMENT_DIR}/runtime/package.json" "${API_STAGE}/package.json"
cp -a apps/web/dist/. "${WEB_STAGE}/"
printf '%s\n' "${RELEASE_ID}" > "${API_STAGE}/RELEASE"
printf '%s\n' "${RELEASE_ID}" > "${WEB_STAGE}/RELEASE"
printf 'runtime_mode=%s\nnode=%s\nbuilt_at=%s\n' \
  "${RUNTIME_MODE}" "$(node --version)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "${API_STAGE}/BUILD_INFO"

if [[ "${RUNTIME_MODE}" == bundled ]]; then
  (
    cd "${API_STAGE}"
    npm install --omit=dev --ignore-scripts --no-audit --no-fund
  )
  if find "${API_STAGE}/node_modules" -type f -name '*.node' -print -quit | grep -q .; then
    if [[ "$(uname -s)" != Linux ]]; then
      printf 'Native runtime modules were found; build bundled releases on Linux for CentOS compatibility\n' >&2
      exit 1
    fi
  fi
else
  (
    cd "${API_STAGE}"
    npm install --package-lock-only --omit=dev --ignore-scripts --no-audit --no-fund
  )
  rm -rf "${API_STAGE}/node_modules"
fi

for forbidden in .env .env.local testnet-wallets.json; do
  if find "${API_STAGE}" "${WEB_STAGE}" -name "${forbidden}" -print -quit | grep -q .; then
    printf 'Forbidden secret-bearing file entered the release: %s\n' "${forbidden}" >&2
    exit 1
  fi
done

COPYFILE_DISABLE=1 tar --no-xattrs -C "${API_STAGE}" -czf "${API_ARCHIVE}" .
COPYFILE_DISABLE=1 tar --no-xattrs -C "${WEB_STAGE}" -czf "${WEB_ARCHIVE}" .

write_checksum() {
  local artifact=$1
  local directory
  local filename
  directory=$(dirname "${artifact}")
  filename=$(basename "${artifact}")
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "${directory}" && sha256sum "${filename}") > "${artifact}.sha256"
  elif command -v shasum >/dev/null 2>&1; then
    (cd "${directory}" && shasum -a 256 "${filename}") > "${artifact}.sha256"
  else
    printf 'sha256sum or shasum is required to sign the release manifest\n' >&2
    exit 1
  fi
}

write_checksum "${API_ARCHIVE}"
write_checksum "${WEB_ARCHIVE}"

printf 'Release %s created (%s runtime):\n' "${RELEASE_ID}" "${RUNTIME_MODE}"
printf '  %s\n  %s\n' "${API_ARCHIVE}" "${WEB_ARCHIVE}"
printf 'Upload each archive together with its .sha256 file. No .env or wallet file is included.\n'
