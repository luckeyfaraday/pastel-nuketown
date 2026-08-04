#!/usr/bin/env bash
# Provision the Pastel Nuketown relay on a fresh Ubuntu 24.04 droplet.
# Idempotent: safe to re-run. Run as root.
#
# Deliberately does NOT touch sshd — locking yourself out of a box you are
# not sitting next to is the one mistake that needs a console to undo.
# That step is at the bottom, to run by hand once key login is confirmed.
set -euo pipefail

# The root-only file is the durable copy of production credentials. Load it on
# later runs so the documented one-command redeploy does not require secrets in
# shell history or process arguments. Values supplied for this invocation win,
# which keeps intentional rotation possible; a fresh host has no file and still
# reaches the loud guards below.
ACCOUNT_ENV_NAMES=(
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI GAME_ORIGIN
  STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
  STRIPE_PRICE_SMG_COTTONCLOUD STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW
  STRIPE_PRICE_RIFLE_BERRYSWIRL STRIPE_PRICE_CHAR_MIDNIGHT
  STRIPE_PRICE_CHAR_SHERBETFOX STRIPE_PRICE_CHAR_CLOUDKNIGHT
  STRIPE_PRICE_FX_STARFALL STRIPE_PRICE_FX_CONFETTIPOP
  STRIPE_PRICE_FX_BUBBLETRAIL
)
if [ -r /etc/nuketown.env ]; then
  declare -A INVOCATION_ENV=()
  for name in "${ACCOUNT_ENV_NAMES[@]}"; do
    if [[ -v "$name" ]]; then INVOCATION_ENV["$name"]="${!name}"; fi
  done
  # EnvironmentFile values are data, not shell. Read the writer's KEY=value
  # format without evaluation so whitespace, dollars, backticks, and quotes
  # round-trip with the same literal meaning they have for systemd.
  while IFS='=' read -r env_name env_value || [[ -n "$env_name$env_value" ]]; do
    for name in "${ACCOUNT_ENV_NAMES[@]}"; do
      if [[ "$env_name" == "$name" ]]; then
        printf -v "$name" '%s' "$env_value"
        export "$name"
        break
      fi
    done
  done < /etc/nuketown.env
  for name in "${!INVOCATION_ENV[@]}"; do
    printf -v "$name" '%s' "${INVOCATION_ENV[$name]}"
    export "$name"
  done
  unset INVOCATION_ENV env_name env_value
fi
unset ACCOUNT_ENV_NAMES

DOMAIN="${DOMAIN:-relay.luckeysystems.com}"
SITE="${SITE:-nuketown.luckeysystems.com}"
ADMIN="${ADMIN:-deploy}"
APP_DIR="${APP_DIR:-/opt/pastel-nuketown}"
REPO="${REPO:-https://github.com/luckeyfaraday/pastel-nuketown.git}"
# Deploy something other than main — a fix branch, or a tag — with:
#   BRANCH=fix-guest-host-advantage bash provision.sh
BRANCH="${BRANCH:-main}"

# Aim limit, in radians per second, and how many windows over it cost a seat.
# Both are documented on the unit below. Set AIM_RATE_STRIKES=0 to put the
# relay back to watching and logging without ever closing a connection:
#   AIM_RATE_STRIKES=0 bash provision.sh
AIM_RATE_LIMIT="${AIM_RATE_LIMIT:-120}"
AIM_RATE_STRIKES="${AIM_RATE_STRIKES:-3}"

# Origins allowed to open a socket here. WebSockets ignore the same-origin
# policy, so without this any page on the internet can dial the relay and sit
# in the rooms. Two entries: the site the game is served from, and the relay
# itself (it serves index.html at / as well).
#
# Note the '-' rather than ':-' so an explicitly empty value still reaches the
# application unchanged. The socket retains its old "accept every origin"
# meaning in that case, but the account service will now fail the unit clearly:
# authenticated HTTP routes require an explicit list and never use '*'. A LAN
# install should list its actual page origin here rather than leave it empty.
ALLOWED_ORIGINS="${ALLOWED_ORIGINS-https://$SITE,https://$DOMAIN}"

# Authentication is not optional in a production unit: anonymous play still
# works exactly as before, but a half-configured account service would accept
# traffic and fail only after somebody tried to recover a purchase. The price
# IDs are different — an empty one intentionally takes just that item off sale.
GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:?Set GOOGLE_CLIENT_ID before provisioning}"
GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:?Set GOOGLE_CLIENT_SECRET before provisioning}"
GOOGLE_REDIRECT_URI="${GOOGLE_REDIRECT_URI:-https://$DOMAIN/auth/google/callback}"
GAME_ORIGIN="${GAME_ORIGIN:-https://$SITE}"
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:?Set STRIPE_SECRET_KEY before provisioning}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:?Set STRIPE_WEBHOOK_SECRET before provisioning}"
STRIPE_PRICE_SMG_COTTONCLOUD="${STRIPE_PRICE_SMG_COTTONCLOUD:-}"
STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW="${STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW:-}"
STRIPE_PRICE_RIFLE_BERRYSWIRL="${STRIPE_PRICE_RIFLE_BERRYSWIRL:-}"
STRIPE_PRICE_CHAR_MIDNIGHT="${STRIPE_PRICE_CHAR_MIDNIGHT:-}"
STRIPE_PRICE_CHAR_SHERBETFOX="${STRIPE_PRICE_CHAR_SHERBETFOX:-}"
STRIPE_PRICE_CHAR_CLOUDKNIGHT="${STRIPE_PRICE_CHAR_CLOUDKNIGHT:-}"
STRIPE_PRICE_FX_STARFALL="${STRIPE_PRICE_FX_STARFALL:-}"
STRIPE_PRICE_FX_CONFETTIPOP="${STRIPE_PRICE_FX_CONFETTIPOP:-}"
STRIPE_PRICE_FX_BUBBLETRAIL="${STRIPE_PRICE_FX_BUBBLETRAIL:-}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

# A stale copy of this script is the worst way for a deploy to go wrong, because
# it does not look like one. It rewrites the systemd unit with whatever that
# version believed production was and restarts into it, reporting success the
# whole way. On 2026-08-02 an old copy left in /tmp reverted the origin allowlist
# to "commented out" and dropped StateDirectory, which silently opened the relay
# to any origin and stopped the match counter persisting; the run printed no
# error at any point. `curl -o` is how it happens: it fails silently on an HTTP
# error and leaves whatever was already at that path.
#
# So keep a copy of what is genuinely executing, taken before the checkout below
# can rewrite it, and compare that against the repo once the checkout is current.
SELF="${BASH_SOURCE[0]:-}"
SELF_SNAPSHOT=""
if [ -f "$SELF" ]; then
  SELF_SNAPSHOT="$(mktemp)"
  cp "$SELF" "$SELF_SNAPSHOT"
  trap 'rm -f "$SELF_SNAPSHOT"' EXIT
fi

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

say "node 22.5+"
if ! command -v node >/dev/null 2>&1 || ! node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);
'; then
  apt-get install -y -qq ca-certificates curl gnupg git >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "service account + application"
if ! id -u nuketown >/dev/null 2>&1; then
  adduser --system --group --no-create-home nuketown
fi
# The chown at the end of this block hands the tree to the service account, so
# from the second run onward root is driving a repository it does not own and
# git refuses with "dubious ownership" — which is why re-running used to fail
# here despite the idempotency claim at the top. Scope the exception to these
# commands instead of writing it into root's global config, where it would
# outlive the script and silently cover every other repo on the box.
APP_GIT=(git -c "safe.directory=$APP_DIR" -C "$APP_DIR")
if [ -d "$APP_DIR/.git" ]; then
  "${APP_GIT[@]}" fetch --all --prune
  "${APP_GIT[@]}" checkout "$BRANCH"
  "${APP_GIT[@]}" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
# Deliberately here: after the checkout, so there is something current to
# compare against, and before the first thing that touches the box outside the
# repo. An abort at this point has updated the checkout and changed nothing
# else, so the running relay is exactly as it was found.
if [ -n "$SELF_SNAPSHOT" ] && [ "${SKIP_SELF_CHECK:-0}" != "1" ]; then
  if ! cmp -s "$SELF_SNAPSHOT" "$APP_DIR/deploy/provision.sh"; then
    cat >&2 <<MSG

This script is not the one on $BRANCH.

  running: $SELF
  repo:    $APP_DIR/deploy/provision.sh

Refusing to rewrite the systemd unit from it. An out-of-date copy will replace a
working unit with an older one and restart into it without complaining.

The checkout is now current, so run the version that came with it:

    cp $APP_DIR/deploy/provision.sh /tmp/prov-current.sh
    sudo bash /tmp/prov-current.sh

Copied out to /tmp rather than run in place, because updating the checkout
rewrites this file, and bash reads a script by byte offset as it executes.

If the difference is deliberate — a local edit you are testing — re-run with
SKIP_SELF_CHECK=1.
MSG
    exit 1
  fi
fi

cd "$APP_DIR"
npm ci --silent
npm run build
npm test
chown -R nuketown:nuketown "$APP_DIR"

say "systemd unit (allowed origins: ${ALLOWED_ORIGINS:-<any>})"
# Keep credentials out of the world-readable unit itself. systemd reads this
# root-only file and passes the values to the service process as environment;
# the application checkout stays read-only and contains no production secret.
install -m 600 -o root -g root /dev/null /etc/nuketown.env
{
  printf 'GOOGLE_CLIENT_ID=%s\n' "$GOOGLE_CLIENT_ID"
  printf 'GOOGLE_CLIENT_SECRET=%s\n' "$GOOGLE_CLIENT_SECRET"
  printf 'GOOGLE_REDIRECT_URI=%s\n' "$GOOGLE_REDIRECT_URI"
  printf 'GAME_ORIGIN=%s\n' "$GAME_ORIGIN"
  printf 'STRIPE_SECRET_KEY=%s\n' "$STRIPE_SECRET_KEY"
  printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$STRIPE_WEBHOOK_SECRET"
  printf 'STRIPE_PRICE_SMG_COTTONCLOUD=%s\n' "$STRIPE_PRICE_SMG_COTTONCLOUD"
  printf 'STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW=%s\n' "$STRIPE_PRICE_SHOTGUN_TOASTEDMALLOW"
  printf 'STRIPE_PRICE_RIFLE_BERRYSWIRL=%s\n' "$STRIPE_PRICE_RIFLE_BERRYSWIRL"
  printf 'STRIPE_PRICE_CHAR_MIDNIGHT=%s\n' "$STRIPE_PRICE_CHAR_MIDNIGHT"
  printf 'STRIPE_PRICE_CHAR_SHERBETFOX=%s\n' "$STRIPE_PRICE_CHAR_SHERBETFOX"
  printf 'STRIPE_PRICE_CHAR_CLOUDKNIGHT=%s\n' "$STRIPE_PRICE_CHAR_CLOUDKNIGHT"
  printf 'STRIPE_PRICE_FX_STARFALL=%s\n' "$STRIPE_PRICE_FX_STARFALL"
  printf 'STRIPE_PRICE_FX_CONFETTIPOP=%s\n' "$STRIPE_PRICE_FX_CONFETTIPOP"
  printf 'STRIPE_PRICE_FX_BUBBLETRAIL=%s\n' "$STRIPE_PRICE_FX_BUBBLETRAIL"
} > /etc/nuketown.env
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
# ProtectSystem=strict below makes the install directory read-only, so the
# lifetime match count needs somewhere else to live. systemd creates
# /var/lib/nuketown, chowns it to the service user, and passes the path as
# \$STATE_DIRECTORY, which is where server.mjs looks for it.
StateDirectory=nuketown
Environment=PORT=8080
Environment=HOST=127.0.0.1
Environment=ALLOWED_ORIGINS=$ALLOWED_ORIGINS
EnvironmentFile=/etc/nuketown.env
# How fast a guest may claim to be turning before the relay stops believing a
# hand is doing it, and how many windows over that line cost the seat. Measured
# rather than guessed: honest players in a firefight peak at 30-42 rad/s, so
# 120 is clear air, and the strike count is what tells a client that spins to
# stay alive (over on every window, gone inside a second) from one that hitched
# for a quarter second (one strike, paid back by the next clean window).
#
# This catches a spinbot. It cannot catch a bot that tracks smoothly, and no
# number the relay can measure will -- that needs the world the host simulates.
Environment=AIM_RATE_LIMIT=$AIM_RATE_LIMIT
Environment=AIM_RATE_STRIKES=$AIM_RATE_STRIKES
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

    ssh <admin-user>@relay.luckeysystems.com 'sudo -n true && echo sudo-ok'

Only once that prints sudo-ok, harden sshd:

    cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
    PermitRootLogin no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    EOF
    sshd -t && systemctl restart ssh
NEXT
