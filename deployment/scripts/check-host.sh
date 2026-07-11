#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

failures=0

pass() {
  printf 'PASS  %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

if [[ -c /dev/null ]]; then
  pass "/dev/null is a character device"
else
  fail "/dev/null is not a character device; systemd service namespaces will fail"
fi

if [[ -r /etc/centos-release ]]; then
  pass "OS: $(tr -d '\n' < /etc/centos-release)"
elif [[ -r /etc/os-release ]]; then
  pass "OS metadata is available (target is CentOS 7.9)"
else
  fail "OS release metadata is unavailable"
fi

for command_name in node npm nginx systemctl curl tar sha256sum runuser; do
  if command -v "${command_name}" >/dev/null 2>&1; then
    pass "${command_name}: $(command -v "${command_name}")"
  else
    fail "${command_name} is missing"
  fi
done

if command -v node >/dev/null 2>&1; then
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
  if [[ "${node_major}" =~ ^[0-9]+$ ]] && (( node_major >= 20 )); then
    pass "Node.js $(node --version) satisfies >=20"
  else
    fail "Node.js 20 or newer is required"
  fi
fi

if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
  pass "nginx configuration parses"
elif command -v nginx >/dev/null 2>&1; then
  fail "nginx -t failed"
fi

if command -v ss >/dev/null 2>&1; then
  if ss -ltnH 'sport = :4035' | grep -q .; then
    if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet proofline-api.service; then
      pass "TCP port 4035 is occupied by the existing Proofline service"
    else
      fail "TCP port 4035 is already occupied"
    fi
  else
    pass "TCP port 4035 is available"
  fi
fi

if (( failures > 0 )); then
  printf '%d host prerequisite check(s) failed\n' "${failures}" >&2
  exit 1
fi

printf 'Host prerequisites look ready. CentOS 7 is EOL; keep the host isolated and patched.\n'
