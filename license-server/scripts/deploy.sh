#!/bin/bash
# Deploy the IMALI Commander license service to your own Linux server.
#
#   bash license-server/scripts/deploy.sh
#
# Server details come from license-server/scripts/deploy.local.env (git-ignored):
#   DEPLOY_SERVER=user@host            DEPLOY_SSH_KEY=~/.ssh/your_key
#   APP_DIR=/home/user/imali-license   PUBLIC_URL=https://your-domain/commander
#   STRIPE_ENV_SOURCE=/etc/some.env    # file on the server holding STRIPE_SECRET_KEY=
#   NGINX_SERVER_NAME=your-domain      # existing HTTPS server block to add /commander/ to
#
# - Uploads the service to APP_DIR (data/ is never overwritten)
# - Creates/reuses the Stripe product, prices and webhook ON THE SERVER,
#   reading the Stripe key there; secrets never leave the server
# - Runs it as the imali-license systemd service on 127.0.0.1:4300
# - Adds PUBLIC_URL's path to nginx (backup + nginx -t, restored automatically on failure)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$HERE/scripts/deploy.local.env"
[ -f "$CONF" ] && . "$CONF"
: "${DEPLOY_SERVER:?Set DEPLOY_SERVER in $CONF}"
: "${DEPLOY_SSH_KEY:?Set DEPLOY_SSH_KEY in $CONF}"
: "${APP_DIR:?Set APP_DIR in $CONF}"
: "${PUBLIC_URL:?Set PUBLIC_URL in $CONF}"
: "${STRIPE_ENV_SOURCE:?Set STRIPE_ENV_SOURCE in $CONF}"
: "${NGINX_SERVER_NAME:?Set NGINX_SERVER_NAME in $CONF}"
KEY="${DEPLOY_SSH_KEY/#\~/$HOME}"
SSH=(ssh -o BatchMode=yes -i "$KEY" "$DEPLOY_SERVER")

echo "== Tests"
(cd "$HERE/.." && npm test >/tmp/ic-license-test.log 2>&1) || { echo "Tests failed, not deploying (see /tmp/ic-license-test.log)"; exit 1; }

echo "== Upload"
"${SSH[@]}" "mkdir -p '$APP_DIR/data'"
rsync -a --delete --exclude node_modules --exclude data --exclude test --exclude '.env*' --exclude 'deploy.local.env' \
  -e "ssh -o BatchMode=yes -i $KEY" "$HERE/" "$DEPLOY_SERVER:$APP_DIR/"

echo "== Install, configure Stripe, start, route"
"${SSH[@]}" "bash -s" "$PUBLIC_URL" "$APP_DIR" "$STRIPE_ENV_SOURCE" "$NGINX_SERVER_NAME" <<'REMOTE'
set -euo pipefail
PUBLIC_URL="$1"; APP="$2"; STRIPE_SOURCE="$3"; SERVER_NAME="$4"
ROUTE="/$(echo "$PUBLIC_URL" | sed -E 's#^https?://[^/]+/?##; s#/$##')/"
ENVF=/etc/imali-license.env
NGINX=/etc/nginx/nginx.conf
SNIPPET=/etc/nginx/snippets/imali-commander.conf
RUN_USER=$(id -un)
TS=$(date +%Y%m%d-%H%M%S)

cd "$APP"
npm install --omit=dev --no-audit --no-fund --silent

# Stripe setup with the account key already on this server (never printed).
STRIPE_KEY=$(sudo sed -n 's/^STRIPE_SECRET_KEY=//p' "$STRIPE_SOURCE" | tr -d '"'"'" | head -1)
[ -n "$STRIPE_KEY" ] || { echo "No STRIPE_SECRET_KEY in $STRIPE_SOURCE"; exit 1; }
sudo touch "$ENVF"
sudo env STRIPE_SECRET_KEY="$STRIPE_KEY" DB_PATH_DEFAULT="$APP/data/licenses.db" node scripts/setup-stripe.js "$ENVF.new" "$PUBLIC_URL" "$ENVF"
unset STRIPE_KEY
sudo mv "$ENVF.new" "$ENVF"
sudo chown root:root "$ENVF"
sudo chmod 600 "$ENVF"

sudo tee /etc/systemd/system/imali-license.service >/dev/null <<UNIT
[Unit]
Description=IMALI Commander license service
After=network.target

[Service]
User=$RUN_USER
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable imali-license >/dev/null 2>&1
sudo systemctl restart imali-license
for i in $(seq 1 15); do curl -sf -m 2 http://127.0.0.1:4300/health >/dev/null && break; sleep 1; done
if ! curl -sf -m 3 http://127.0.0.1:4300/health >/dev/null; then
  echo "!!! Service did not start"; sudo journalctl -u imali-license -n 20 --no-pager; exit 1
fi
echo "service: $(systemctl is-active imali-license)"

sudo mkdir -p /etc/nginx/snippets
sudo tee "$SNIPPET" >/dev/null <<NG
# IMALI Commander license service (managed by license-server/scripts/deploy.sh)
location ^~ $ROUTE {
    proxy_pass http://127.0.0.1:4300/;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 1m;
}
NG
if ! sudo grep -q "include $SNIPPET;" "$NGINX"; then
  sudo cp "$NGINX" "$NGINX.bak-$TS"
  sudo python3 - "$NGINX" "$SNIPPET" "$SERVER_NAME" <<'PY'
import re, sys
path, snippet, name = sys.argv[1:4]
lines = open(path).read().split('\n')
hits = [i for i, l in enumerate(lines)
        if re.match(r'\s*server_name\s+' + re.escape(name) + r'\s*;', l)
        and any('listen 443' in x for x in lines[max(0, i - 4):i + 5])]
if len(hits) != 1:
    sys.exit(f'expected exactly one HTTPS server block for {name}, found {len(hits)}')
indent = re.match(r'(\s*)', lines[hits[0]]).group(1)
lines.insert(hits[0] + 1, f'{indent}include {snippet};')
open(path, 'w').write('\n'.join(lines))
PY
  if ! sudo nginx -t >/dev/null 2>&1; then
    echo "!!! nginx config test failed, restoring"; sudo cp "$NGINX.bak-$TS" "$NGINX"; sudo nginx -t; exit 1
  fi
  sudo systemctl reload nginx
  echo "nginx: route added (backup $NGINX.bak-$TS)"
else
  sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx
  echo "nginx: route already present"
fi

sleep 1
HEALTH="https://$SERVER_NAME${ROUTE}health"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 --resolve "$SERVER_NAME:443:127.0.0.1" "$HEALTH")
if [ "$code" = "502" ] && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
  echo "SELinux blocked nginx -> 4300; allowing that port for web proxies"
  sudo semanage port -a -t http_port_t -p tcp 4300 2>/dev/null || sudo semanage port -m -t http_port_t -p tcp 4300
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 --resolve "$SERVER_NAME:443:127.0.0.1" "$HEALTH")
fi
echo "through nginx: ${ROUTE}health -> $code"
if [ "$code" != "200" ]; then
  echo "!!! Route not working; removing it"
  [ -f "$NGINX.bak-$TS" ] && sudo cp "$NGINX.bak-$TS" "$NGINX" && sudo nginx -t && sudo systemctl reload nginx
  exit 1
fi
echo "DEPLOY OK"
REMOTE
