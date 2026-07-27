#!/usr/bin/env bash
# Provision the Pastel Nuketown relay on a fresh Ubuntu 24.04 droplet.
# Idempotent: safe to re-run. Run as root.
#
# Deliberately does NOT touch sshd — locking yourself out of a box you are
# not sitting next to is the one mistake that needs a console to undo.
# That step is at the bottom, to run by hand once key login is confirmed.
set -euo pipefail

DOMAIN="${DOMAIN:-relay.luckeysystems.com}"
SITE="${SITE:-nuketown.luckeysystems.com}"
ADMIN="${ADMIN:-alan}"
APP_DIR="${APP_DIR:-/opt/pastel-nuketown}"
REPO="${REPO:-https://github.com/luckeyfaraday/pastel-nuketown.git}"
# Until the multiplayer work lands on main, provision from the branch:
#   BRANCH=multiplayer bash provision.sh
BRANCH="${BRANCH:-main}"

# Origins allowed to open a socket here. WebSockets ignore the same-origin
# policy, so without this any page on the internet can dial the relay and sit
# in the rooms. Two entries: the site the game is served from, and the relay
# itself (it serves index.html at / as well).
#
# Note the '-' rather than ':-' — an explicitly empty ALLOWED_ORIGINS= means
# "accept every origin", which is what a LAN box or a private relay wants:
#   ALLOWED_ORIGINS= bash provision.sh
ALLOWED_ORIGINS="${ALLOWED_ORIGINS-https://$SITE,https://$DOMAIN}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

say "admin user: $ADMIN"
if ! id -u "$ADMIN" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$ADMIN"
fi
usermod -aG sudo "$ADMIN"
install -d -m 700 -o "$ADMIN" -g "$ADMIN" "/home/$ADMIN/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o "$ADMIN" -g "$ADMIN" /root/.ssh/authorized_keys "/home/$ADMIN/.ssh/authorized_keys"
fi

say "firewall (SSH allowed before enabling)"
apt-get update -qq
apt-get install -y -qq ufw >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status verbose | head -6

say "patching + brute-force protection"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades fail2ban >/dev/null
systemctl enable --now fail2ban >/dev/null
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF

say "node 22"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  apt-get install -y -qq ca-certificates curl gnupg git >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "service account + application"
if ! id -u nuketown >/dev/null 2>&1; then
  adduser --system --group --no-create-home nuketown
fi
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all --prune
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --silent
npm run build
npm test
chown -R nuketown:nuketown "$APP_DIR"

say "systemd unit (allowed origins: ${ALLOWED_ORIGINS:-<any>})"
# Unquoted heredoc: $ALLOWED_ORIGINS is expanded below. Keep literal '$' and
# systemd specifiers out of this block, or escape them as '\$' / '%%'.
cat > /etc/systemd/system/nuketown.service <<UNIT
[Unit]
Description=Pastel Nuketown relay
After=network.target

[Service]
User=nuketown
Group=nuketown
WorkingDirectory=/opt/pastel-nuketown
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=ALLOWED_ORIGINS=$ALLOWED_ORIGINS
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=3

NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now nuketown
systemctl restart nuketown
sleep 2
systemctl is-active nuketown

say "caddy (automatic TLS, forwards websocket upgrades natively)"
if ! command -v caddy >/dev/null 2>&1; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
    reverse_proxy 127.0.0.1:8080
}
CADDY
systemctl reload caddy || systemctl restart caddy

say "verifying"
sleep 5
echo -n "local relay:  "; curl -fsS http://127.0.0.1:8080/rooms || echo FAILED
echo -n "public https: "; curl -fsS "https://$DOMAIN/rooms" || echo "not ready yet (cert may still be issuing)"
echo

# A mistyped origin locks every real player out and looks exactly like a
# broken relay, so prove the gate lets the site in before walking away.
if [ -n "$ALLOWED_ORIGINS" ]; then
  FIRST_ORIGIN="${ALLOWED_ORIGINS%%,*}"

  acao() {
    curl -fsS -o /dev/null -D - -H "origin: $1" http://127.0.0.1:8080/rooms 2>/dev/null \
      | tr -d '\r' \
      | awk 'tolower($1) == "access-control-allow-origin:" { print $2 }' || true
  }
  echo -n "rooms cors:   "
  MINE="$(acao "$FIRST_ORIGIN")"
  THEIRS="$(acao https://evil.example)"
  if [ "$MINE" = "$FIRST_ORIGIN" ] && [ -z "$THEIRS" ]; then
    echo "ok ($FIRST_ORIGIN shared, foreign origins not)"
  else
    echo "FAILED (allowed='$MINE' foreign='$THEIRS')"
  fi

  echo -n "socket gate:  "
  # Run from APP_DIR so the bare "ws" import resolves against its node_modules.
  cd "$APP_DIR"
  ORIGIN="$FIRST_ORIGIN" node --input-type=module -e '
    import { WebSocket } from "ws";
    const dial = (origin) => new Promise((resolve) => {
      const ws = new WebSocket("ws://127.0.0.1:8080/ws", { origin });
      const timer = setTimeout(() => { ws.terminate(); resolve("timeout"); }, 5000);
      const done = (result) => { clearTimeout(timer); resolve(result); };
      ws.on("open", () => { ws.terminate(); done("open"); });
      ws.on("error", () => done("refused"));
    });
    const mine = await dial(process.env.ORIGIN);
    const theirs = await dial("https://evil.example");
    console.log(mine === "open" && theirs === "refused"
      ? "ok (site connects, foreign pages refused)"
      : `FAILED (allowed=${mine} foreign=${theirs})`);
  '
  echo
fi

say "done — remaining manual step"
cat <<'NEXT'
Confirm key login as the admin user from another terminal FIRST:

    ssh alan@relay.luckeysystems.com 'sudo -n true && echo sudo-ok'

Only once that prints sudo-ok, harden sshd:

    cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    EOF
    sshd -t && systemctl restart ssh
NEXT
