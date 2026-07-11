# Proofline production deployment

This directory contains a credential-free deployment path for
`proofline.axiqo.xyz` on the existing CentOS 7.9 host. It does not connect to
the server or make any remote change by itself.

CentOS 7 is end-of-life. Keep the host patched through its maintained package
source, expose only ports 80/443, and plan an OS upgrade. The checked host has
Node.js 22, nginx 1.26, and Certbot, which satisfy this deployment.

## Layout and trust boundary

| Item | Location | Ownership / behavior |
| --- | --- | --- |
| API releases | `/opt/proofline/releases/<release-id>` | Immutable, `root:proofline` |
| Active API | `/opt/proofline/current` | Atomic symlink to one release |
| API environment | `/opt/proofline/shared/api.env` | Separate, `root:root`, mode `0600` |
| MCP environment | `/opt/proofline/shared/mcp.env` | Audit token and public API metadata only; no wallet private keys |
| Runtime state | `/opt/proofline/state` | `proofline:proofline`, mode `0700`; MCP audit and x402 replay ledger |
| Web releases | `/var/www/proofline/releases/<release-id>` | Immutable static files |
| Active web | `/var/www/proofline/current` | Atomic symlink to the matching release |
| API listener | `127.0.0.1:4035` | Loopback only; nginx owns the public edge |
| systemd unit | `/etc/systemd/system/proofline-api.service` | Runs as unprivileged `proofline` |
| MCP unit | `/etc/systemd/system/proofline-mcp.service` | Keeps the real stdio heartbeat online without inventing tool calls |
| nginx vhost | `/etc/nginx/conf.d/proofline.axiqo.xyz.conf` | Static web plus `/api/` proxy |

The release archives contain only compiled API/Core/MCP code, the attributed replay,
2026 schedule and delayed-snapshot datasets, production dependencies, and web assets. `.env`, wallet files, API
tokens, and private keys are explicitly excluded. Payment and anchor keys stay
only in the root-readable systemd environment file.

## 1. Build release archives

Run from a trusted build machine with Node.js 20 or newer:

```bash
cd /path/to/proofline
deployment/scripts/build-release.sh --mode bundled
```

`bundled` is recommended for this low-resource server: it packages production
`node_modules`, so the server does not compile or resolve dependencies. The
runtime currently has no native `.node` modules; the script refuses a
non-Linux bundled build if a future dependency adds one.

For a smaller upload, build a slim archive:

```bash
deployment/scripts/build-release.sh --mode slim
```

Slim deployment runs `npm ci --omit=dev --ignore-scripts` on the server. It
uses less bandwidth for upload but requires registry access and more temporary
disk/RAM. Both modes generate API/web archives and separate `.sha256` files
under `deployment/out/`.

The web build is forced to use same-origin `/api`; no server credential is
embedded in browser assets. The API archive copies every JSON dataset under
`data/replays`, `data/schedules`, and `data/snapshots`; it never packages
`data/runtime`.

## 2. Transfer without transferring secrets

First copy the credential-free deployment directory and the four generated
artifact files. Example commands are shown for the operator; these scripts do
not run them:

```bash
rsync -a --exclude out deployment/ root@SERVER:/root/proofline-deployment/
scp deployment/out/proofline-{api,web}-<release-id>.tar.gz* \
  root@SERVER:/root/proofline-release/
```

Never copy the repository `.env`, `data/runtime/`, a wallet JSON file, or a
shell history. Verify the release ID and checksums on the destination before
deployment; `proofline-deploy-release` also verifies them automatically.

## 3. Prepare the host

Point the DNS `A`/`AAAA` records for `proofline.axiqo.xyz` to the server, then:

```bash
cd /root/proofline-deployment
chmod 0755 scripts/*.sh
scripts/check-host.sh
sudo scripts/install-host.sh --nginx http
```

The installer is idempotent. It creates an unprivileged user, release
directories, the systemd unit, the HTTP bootstrap vhost, and these commands:

- `/usr/local/sbin/proofline-deploy-release`
- `/usr/local/sbin/proofline-rollback`
- `/usr/local/sbin/proofline-health-check`

It creates `/opt/proofline/shared/api.env` and `mcp.env` only when absent and
never overwrites an existing environment file. Review both with `sudoedit`;
keep mode `0600`:

```bash
sudoedit /opt/proofline/shared/api.env
sudoedit /opt/proofline/shared/mcp.env
sudo chown root:root /opt/proofline/shared/api.env
sudo chown root:root /opt/proofline/shared/mcp.env
sudo chmod 0600 /opt/proofline/shared/api.env
sudo chmod 0600 /opt/proofline/shared/mcp.env
```

The template intentionally starts in labelled replay/demo mode. For real
Injective testnet paths, add only dedicated testnet credentials, contract
address, payee, and facilitator settings, then change `CHAIN_MODE` and
`X402_MODE`. Remote RPC/facilitator endpoints must use HTTPS. Never reuse a
mainnet key.

`PROOFLINE_MCP_AUDIT_TOKEN` must have the same high-entropy value in both
files. Keep anchor and facilitator private keys in `api.env` only. Set
`PROOFLINE_MCP_AUDIT_FILE=/opt/proofline/state/mcp-runtime.json` and
`PROOFLINE_X402_LEDGER_FILE=/opt/proofline/state/x402-ledger.json` in
`api.env` so judge traces and payment replay protection survive restarts.

If SELinux is enforcing, nginx needs permission to proxy to the loopback API:

```bash
sudo setsebool -P httpd_can_network_connect 1
sudo restorecon -Rv /var/www/proofline /var/www/letsencrypt
```

With `firewalld`, expose HTTP/HTTPS only. Do not open 4035:

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

## 4. Deploy atomically

Use the exact files created by one build:

```bash
sudo proofline-deploy-release \
  --api /root/proofline-release/proofline-api-<release-id>.tar.gz \
  --web /root/proofline-release/proofline-web-<release-id>.tar.gz \
  --public-health-url http://proofline.axiqo.xyz/api/health
```

The deploy command:

1. verifies both SHA-256 manifests and rejects unsafe archive paths;
2. verifies the API can import as the `proofline` user;
3. moves both releases into immutable directories;
4. atomically switches both `current` symlinks;
5. restarts the API and MCP services, then checks API health and a fresh real
   stdio MCP heartbeat;
6. validates/reloads nginx and optionally checks the public URL;
7. restores both previous symlinks automatically on any failure.

Inspect the result:

```bash
sudo proofline-health-check
sudo systemctl status proofline-api.service proofline-mcp.service --no-pager
sudo journalctl -u proofline-api.service -u proofline-mcp.service -n 100 --no-pager
curl -fsS http://127.0.0.1:4035/api/health
```

## 5. Enable TLS

After HTTP and DNS work, obtain the certificate using the dedicated ACME
webroot:

```bash
sudo certbot certonly --webroot \
  -w /var/www/letsencrypt \
  -d proofline.axiqo.xyz
sudo /root/proofline-deployment/scripts/install-host.sh --nginx https
sudo systemctl restart nginx
PUBLIC_HEALTH_URL=https://proofline.axiqo.xyz/api/health \
  sudo -E proofline-health-check
```

Before selecting the HTTPS template, run `nginx -V` and require an actively
supported OpenSSL build with TLS 1.3. The original CentOS 7 package on this
host linked OpenSSL 1.0.2 and could answer `curl` while rejecting current
Chrome ClientHello messages with `ERR_SSL_PROTOCOL_ERROR`. The deployed host
therefore uses nginx 1.30.3 linked statically to OpenSSL 3.5 LTS; the packaged
binary remains available for rollback. Verify the public edge, not only local
nginx syntax:

```bash
openssl s_client -connect proofline.axiqo.xyz:443 \
  -servername proofline.axiqo.xyz -tls1_3 </dev/null
```

The HTTPS template redirects HTTP, enables HSTS, serves immutable hashed
assets, disables caching for `index.html`, applies a restrictive CSP, and keeps
SSE/API proxy buffering disabled. Confirm Certbot renewal separately with
`certbot renew --dry-run`.

## Rollback and operations

List retained release IDs and choose an explicit known-good pair:

```bash
ls -1 /opt/proofline/releases
ls -1 /var/www/proofline/releases
sudo proofline-rollback <release-id> \
  --public-health-url https://proofline.axiqo.xyz/api/health
```

Rollback uses the same atomic switch and health validation. If the selected
release fails, it restores the release that was active before the rollback.

Keep at least two known-good release IDs. Before deleting an old directory,
compare it with both `readlink -f /opt/proofline/current` and
`readlink -f /var/www/proofline/current`; never delete either active target.

After changing only `api.env`, validate permissions and restart:

```bash
sudo test "$(stat -c '%u:%a' /opt/proofline/shared/api.env)" = "0:600"
sudo systemctl restart proofline-api.service
sudo proofline-health-check
```

## Failure diagnosis

- `502 Bad Gateway`: check `systemctl status proofline-api` and local health.
- API starts locally but nginx cannot connect: check SELinux and that both
  templates use `127.0.0.1:4035`.
- systemd reports `status=203/EXEC`: inspect `command -v node`; the unit uses
  `/usr/bin/env` with `/usr/local/bin:/usr/bin:/bin`.
- A slim install fails: verify npm registry access or deploy a bundled archive.
- TLS vhost fails `nginx -t`: ensure both files under
  `/etc/letsencrypt/live/proofline.axiqo.xyz/` exist before selecting HTTPS.
- Keep the failed immutable release for diagnosis, then remove it only after a
  successful rollback and active-symlink check.
