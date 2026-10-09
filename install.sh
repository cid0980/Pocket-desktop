#!/usr/bin/env bash
#
# Pocket Desktop — Linux X11 installer (apt / dnf / pacman / zypper)
#
#   ./install.sh                 install for the current user, start at login
#   ./install.sh --with-sudo     also allow lock/suspend/restart/shutdown from the phone
#   ./install.sh --install-deps  install dependencies with the detected package manager
#   ./install.sh --port 8765     change the port
#   ./install.sh --vnc-password ab12   protect the VNC socket with a password too
#   ./install.sh --no-service    configure PIN/input, but do not install user services
#   ./install.sh --uninstall     remove the services
#
set -euo pipefail

APP_NAME="Pocket Desktop"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=8765
WITH_SUDO=0
INSTALL_DEPS=0
NO_SERVICE=0
UNINSTALL=0
VNC_PASSWORD=""
USER_UNIT_DIR="${HOME}/.config/systemd/user"
SERVICE_NAME="pocket-desktop"
VNC_SERVICE_NAME="pocket-desktop-vnc"
NODE_BIN="$(command -v node || true)"

# ── pretty output ────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$*"; }
step() { printf '\n%s%s%s\n' "$B$C" "$*" "$N"; }

# ── args ─────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-sudo) WITH_SUDO=1 ;;
    --install-deps) INSTALL_DEPS=1 ;;
    --no-service) NO_SERVICE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --vnc-password) VNC_PASSWORD="${2:?--vnc-password needs a value}"; shift ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) bad "unknown option: $1"; exit 1 ;;
  esac
  shift
done

say ""
say "${B}${APP_NAME} installer${N}   ${DIM}${PROJECT_DIR}${N}"
[[ $(uname -s) == Linux ]] || { bad "This installer requires Linux"; exit 1; }
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$PORT >= 1024 && 10#$PORT <= 65535)) || { bad "port must be 1024–65535"; exit 1; }
PORT=$((10#$PORT))
if [[ $INSTALL_DEPS -eq 1 && $UNINSTALL -eq 0 ]]; then
  bash "$PROJECT_DIR/tools/install-deps.sh"
  NODE_BIN="$(command -v node || true)"
fi

# ── 0. uninstall path ────────────────────────────────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  step "Removing services"
  systemctl --user disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
  systemctl --user disable --now "${VNC_SERVICE_NAME}.service" 2>/dev/null || true
  rm -f "${USER_UNIT_DIR}/${SERVICE_NAME}.service" "${USER_UNIT_DIR}/${VNC_SERVICE_NAME}.service"
  if [[ -f /etc/polkit-1/rules.d/49-pocket-desktop.rules ]]; then
    sudo rm -f /etc/polkit-1/rules.d/49-pocket-desktop.rules && ok "removed the polkit rule"
  fi
  systemctl --user daemon-reload 2>/dev/null || true
  ok "services removed — your settings in ~/.config/pocket-desktop were kept"
  say ""
  exit 0
fi

# ── 1. sanity checks ─────────────────────────────────────────────────────
step "1/7  Checking this machine"
[[ -f "${PROJECT_DIR}/server.js" ]] || { bad "server.js not found — run this from the project folder"; exit 1; }

if [[ -z "$NODE_BIN" ]]; then
  bad "Node.js is not installed. Install it with:  sudo apt install nodejs"
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  bad "Node.js $NODE_MAJOR is too old — version 18 or newer is required (see nodejs.org)"
  exit 1
fi
ok "Node.js $("$NODE_BIN" -p 'process.versions.node')"

DISTRO="$( (. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-Linux}") || echo Linux )"
ok "distribution: ${DISTRO}"

SESSION_TYPE="${XDG_SESSION_TYPE:-unknown}"
DISPLAY_ID="${DISPLAY:-}"
if [[ -z "$DISPLAY_ID" ]]; then
  for sock in /tmp/.X11-unix/X*; do
    [[ -e "$sock" ]] && DISPLAY_ID=":$(basename "$sock" | tr -d 'X')" && break
  done
fi
[[ -n "$DISPLAY_ID" ]] || DISPLAY_ID=":0"

if [[ "$SESSION_TYPE" == "wayland" ]]; then
  warn "you are on a Wayland session — x11vnc needs X11."
  say  "    ${DIM}Fix: log out, click the gear on the login screen, pick “Ubuntu on Xorg”, then run this again.${N}${N}"
elif [[ "$SESSION_TYPE" == "x11" ]]; then
  ok "X11 session on display ${DISPLAY_ID}"
else
  warn "could not detect the session type (XDG_SESSION_TYPE=${SESSION_TYPE})"
fi

XAUTH=""
for candidate in "${XAUTHORITY:-}" "${HOME}/.Xauthority" "/run/user/$(id -u)/gdm/Xauthority" "/run/user/$(id -u)/.mutter-Xwaylandauth"; do
  [[ -n "$candidate" && -s "$candidate" ]] && XAUTH="$candidate" && break
done
[[ -n "$XAUTH" ]] && ok "Xauthority: ${XAUTH}" || warn "no Xauthority file found (x11vnc will try to guess)"

# ── 2. dependencies ──────────────────────────────────────────────────────
step "2/7  Checking optional tools"
MISSING=()
for tool in x11vnc xdotool arecord import; do
  if command -v "$tool" >/dev/null 2>&1; then
    ok "$tool"
  else
    MISSING+=("$tool")
    warn "$tool ${DIM}(missing)${N}"
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  if [[ $INSTALL_DEPS -eq 1 ]]; then
    warn "Some helpers remain unavailable after package installation. Check your distribution's packages."
  else
    say "    ${DIM}Add them with:  ./install.sh --install-deps   (needs sudo)${N}"
    say "    ${DIM}x11vnc is required for the remote screen; the rest enable voice, screenshots and the key row.${N}"
  fi
fi

# ── 3. PIN + VNC password ────────────────────────────────────────────────
step "3/7  Access PIN"
CONFIG_FILE="${HOME}/.config/pocket-desktop/config.json"
if [[ -f "$CONFIG_FILE" ]] && grep -q pinHash "$CONFIG_FILE" 2>/dev/null; then
  ok "a PIN is already set (change it later with: node server.js --set-pin 4321)"
else
  if [[ -t 0 ]]; then
    while true; do
      read -r -s -p "    Choose a PIN for phone access (4–10 digits): " PIN1; echo
      read -r -s -p "    Repeat the PIN: " PIN2; echo
      if [[ "$PIN1" != "$PIN2" ]]; then bad "the PINs do not match, try again"; continue; fi
      if [[ ! "$PIN1" =~ ^[0-9]{4,10}$ ]]; then bad "digits only, 4–10 of them"; continue; fi
      "$NODE_BIN" "${PROJECT_DIR}/server.js" --set-pin "$PIN1" >/dev/null && ok "PIN saved"
      break
    done
  else
    warn "not running interactively — set a PIN later with: node server.js --set-pin 1234"
  fi
fi

if [[ -n "$VNC_PASSWORD" ]]; then
  if command -v x11vnc >/dev/null 2>&1; then
    mkdir -p "${HOME}/.vnc"
    x11vnc -storepasswd "$VNC_PASSWORD" "${HOME}/.vnc/passwd" >/dev/null 2>&1 && chmod 600 "${HOME}/.vnc/passwd"
    ok "VNC password stored in ~/.vnc/passwd"
  else
    warn "x11vnc missing — cannot store the VNC password yet"
  fi
fi

# ── 4. systemd user services ─────────────────────────────────────────────
if [[ $NO_SERVICE -eq 0 ]] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  step "4/7  Installing auto-start services"
  mkdir -p "$USER_UNIT_DIR"

  # x11vnc: localhost only; the node app is the only thing exposed to the LAN
  X11VNC_AUTH_ARGS=""
  [[ -n "$XAUTH" ]] && X11VNC_AUTH_ARGS="-auth ${XAUTH}"
  VNC_AUTH_ARGS="-nopw"
  [[ -s "${HOME}/.vnc/passwd" ]] && VNC_AUTH_ARGS="-rfbauth ${HOME}/.vnc/passwd"

  cat > "${USER_UNIT_DIR}/${VNC_SERVICE_NAME}.service" <<EOF
[Unit]
Description=Pocket Desktop VNC server (localhost only)
After=graphical-session.target

[Service]
Type=simple
# wait for the X server socket, otherwise x11vnc exits and we silently
# fall back to letting the app spawn its own copy
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 60); do [ -e /tmp/.X11-unix/X${DISPLAY_ID#:} ] && exit 0; sleep 1; done; exit 0'
ExecStart=/usr/bin/env x11vnc -display ${DISPLAY_ID} ${X11VNC_AUTH_ARGS} -rfbport 5900 -localhost -forever -shared -noxdamage -repeat -nowf -ncache 0 ${VNC_AUTH_ARGS} -quiet
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF

  cat > "${USER_UNIT_DIR}/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=${APP_NAME} — control this PC from your phone
After=graphical-session.target
Wants=${VNC_SERVICE_NAME}.service

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=DISPLAY=${DISPLAY_ID}
Environment=XDG_SESSION_TYPE=${SESSION_TYPE}
${XAUTH:+Environment=XAUTHORITY=${XAUTH}}
# give x11vnc a moment, then start; the app also self-heals if VNC is late
ExecStartPre=/bin/bash -c 'for i in \$(seq 1 20); do (exec 3<>/dev/tcp/127.0.0.1/5900) 2>/dev/null && exit 0; sleep 1; done; exit 0'
ExecStart="${NODE_BIN}" "${PROJECT_DIR}/server.js" --port ${PORT}
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "${VNC_SERVICE_NAME}.service" >/dev/null 2>&1 && ok "x11vnc service enabled" || warn "could not enable the x11vnc service"
  systemctl --user restart "${VNC_SERVICE_NAME}.service" >/dev/null 2>&1 || warn "could not start the x11vnc service"
  systemctl --user enable "${SERVICE_NAME}.service" >/dev/null 2>&1 && ok "app service enabled" || warn "could not enable the app service"
  systemctl --user restart "${SERVICE_NAME}.service" >/dev/null 2>&1 || warn "could not start the app service"

  # wait for the two to actually come up, and report the truth
  sleep 1
  VNC_STATE="$(systemctl --user is-active "${VNC_SERVICE_NAME}.service" 2>/dev/null || echo unknown)"
  APP_STATE="$(systemctl --user is-active "${SERVICE_NAME}.service" 2>/dev/null || echo unknown)"
  for _ in $(seq 1 15); do
    [[ "$VNC_STATE" == "active" && "$APP_STATE" == "active" ]] && break
    sleep 1
    VNC_STATE="$(systemctl --user is-active "${VNC_SERVICE_NAME}.service" 2>/dev/null || echo unknown)"
    APP_STATE="$(systemctl --user is-active "${SERVICE_NAME}.service" 2>/dev/null || echo unknown)"
  done
  [[ "$VNC_STATE" == "active" ]] && ok "x11vnc service is running" || warn "the x11vnc service is ${VNC_STATE} — the app will start its own copy as a fallback"
  [[ "$APP_STATE" == "active" ]] && ok "app service is running" || warn "the app service is ${APP_STATE} — check: journalctl --user -u ${SERVICE_NAME} -n 40"

  # Desktop sharing requires a logged-in graphical user; do not enable lingering.

else
  step "4/7  Skipping services"
  warn "start the app manually with:  ./run.sh"
fi

# ── 5. virtual gamepad (uinput) ─────────────────────────────────────────
step "5/7  Virtual gamepad (uinput)"
UINPUT_OK=0
if [[ -e /dev/uinput && ! -f /etc/udev/rules.d/99-pocket-desktop-uinput.rules ]] && [[ $(stat -c %a /dev/uinput) != *6 ]]; then
  if python3 "$PROJECT_DIR/tools/pad-uinput.py" --check 2>/dev/null | grep -q READY; then
    ok "you can already create virtual controllers"
    UINPUT_OK=1
  fi
fi
if [[ $UINPUT_OK -eq 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    # load the kernel module now and at every boot
    sudo -n modprobe uinput >/dev/null 2>&1 || sudo modprobe uinput >/dev/null 2>&1 || true
    echo uinput | sudo tee /etc/modules-load.d/pocket-desktop-uinput.conf >/dev/null 2>&1 || true
    # Active desktop users get uaccess ACLs, rather than world-writable input.
    sudo mkdir -p /etc/udev/rules.d >/dev/null 2>&1 || true
    echo 'KERNEL=="uinput", MODE="0660", TAG+="uaccess", OPTIONS+="static_node=uinput"' \
      | sudo tee /etc/udev/rules.d/70-pocket-desktop-uinput.rules >/dev/null 2>&1 || true
    sudo rm -f /etc/udev/rules.d/99-pocket-desktop-uinput.rules
    sudo chmod 0660 /dev/uinput >/dev/null 2>&1 || true
    sudo udevadm control --reload-rules >/dev/null 2>&1 || true
    sudo udevadm trigger --name-match=uinput >/dev/null 2>&1 || true
    # Immediate permission for this user; uaccess reapplies at graphical login.
    sudo setfacl -m "u:$(id -un):rw" /dev/uinput >/dev/null 2>&1 || true
    sleep 1
    if python3 "$PROJECT_DIR/tools/pad-uinput.py" --check 2>/dev/null | grep -q READY; then
      ok "virtual gamepad ready (Xbox pad + mouse)"
      UINPUT_OK=1
    fi
  fi
fi
if [[ $UINPUT_OK -eq 0 ]]; then
  warn "could not enable /dev/uinput — the Gamepad screen will try sudo, or stay unavailable"
  warn "  (if sudo asks for a password on this PC, run:  sudo modprobe uinput)"
fi

# ── 6. power actions (optional) ──────────────────────────────────────────
if [[ $WITH_SUDO -eq 1 ]]; then
  step "6/7  Allowing power actions from the phone"
  RULE=/etc/polkit-1/rules.d/49-pocket-desktop.rules
  sudo tee "$RULE" >/dev/null <<EOF
// Pocket Desktop: let $(id -un) lock, suspend, restart and shut down from their phone.
polkit.addRule(function(action, subject) {
    if (subject.user !== "$(id -un)") { return polkit.Result.NOT_HANDLED; }
    var allowed = [
        "org.freedesktop.login1.suspend",
        "org.freedesktop.login1.suspend-multiple-sessions",
        "org.freedesktop.login1.reboot",
        "org.freedesktop.login1.reboot-multiple-sessions",
        "org.freedesktop.login1.power-off",
        "org.freedesktop.login1.power-off-multiple-sessions",
        "org.freedesktop.login1.lock-sessions",
        "org.freedesktop.login1.set-self-linger"
    ];
    if (allowed.indexOf(action.id) !== -1) { return polkit.Result.YES; }
    return polkit.Result.NOT_HANDLED;
});
EOF
  ok "polkit rule written to ${RULE}"
else
  step "6/7  Power actions"
  warn "lock/suspend/restart/shutdown from the phone are disabled (re-run with --with-sudo to allow them)"
fi

# ── 6. firewall + finish ─────────────────────────────────────────────────
step "7/7  Network"
if command -v ufw >/dev/null 2>&1 && sudo -n ufw status 2>/dev/null | grep -q "Status: active"; then
  sudo -n ufw allow "${PORT}/tcp" >/dev/null 2>&1 && ok "ufw: port ${PORT} allowed" || warn "ufw is active — allow port ${PORT} manually"
else
  warn "Firewall reachability is not verified. Allow TCP ${PORT} from your trusted LAN if your phone cannot connect."
  if command -v firewall-cmd >/dev/null 2>&1; then
    say "    firewalld detected: use your firewall settings to allow TCP ${PORT} on your trusted network zone."
  fi
fi

PORT="${PORT}"
running=0
if [[ $NO_SERVICE -eq 0 ]] && command -v curl >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/ping" >/dev/null 2>&1; then running=1; break; fi
    sleep 0.5
  done
fi

say ""
say "${B}${G}Done.${N}"
say ""
if [[ $NO_SERVICE -eq 1 ]]; then
  ok "configuration complete; foreground startup is handled by setup.sh or run.sh"
elif [[ $running -eq 1 ]]; then
  ok "the app is running on port ${PORT}"
else
  warn "the app is not answering on port ${PORT} yet — start it with ./run.sh and check for errors"
fi
say ""
"$NODE_BIN" "${PROJECT_DIR}/server.js" --pair --port "${PORT}" 2>/dev/null || true
say "  ${B}Next:${N} scan the QR above with your phone (same Wi-Fi), then"
say "  add it to your home screen for a full-screen app."
say ""
