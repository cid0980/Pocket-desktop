#!/usr/bin/env bash
# Clone → setup → control this Linux desktop from a phone on the same network.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKIP_DEPS=0; INSTALL_ONLY=0; AUTOSTART=0; PLAN=0; PORT=8765
usage() {
  cat <<'HELP'
Usage: bash setup.sh [options]
  --plan          Show the dependency/install plan; make no changes
  --skip-deps     Use tools already installed (no package-manager operation)
  --install-only  Configure without starting the foreground server
  --autostart     Install systemd user services instead of foreground execution
  --port NUMBER   Use another port (default 8765)

Default: install dependencies, configure input/PIN, then start in the foreground.
Run as your normal desktop user, not root. sudo is requested for system setup only.
Requires an existing X11 desktop for screen sharing. No VPN or cloud service.
HELP
}
while (($#)); do
  case "$1" in
    --plan) PLAN=1 ;;
    --skip-deps) SKIP_DEPS=1 ;;
    --install-only) INSTALL_ONLY=1 ;;
    --autostart) AUTOSTART=1 ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] && ((10#$PORT>=1024 && 10#$PORT<=65535)) || { echo 'Port must be 1024–65535.' >&2; exit 2; }
PORT=$((10#$PORT))
[[ $(uname -s) == Linux ]] || { echo 'Linux is supported. Windows needs different capture/input backends and is not supported by this installer.' >&2; exit 1; }
if ((PLAN)); then
  if ((SKIP_DEPS)); then echo 'Dependencies: use existing tools'; else bash "$ROOT/tools/install-deps.sh" --plan; fi
  echo "Configure PIN and virtual input for the current user; port $PORT."
  if ((AUTOSTART)); then echo 'Install/start systemd user services.'
  elif ((INSTALL_ONLY)); then echo 'Configure only; do not start.'
  else echo 'Run in foreground; Ctrl+C stops the server.'; fi
  echo 'Screen sharing requires X11; phone must reach this PC on the local network.'
  exit 0
fi
((EUID != 0)) || { echo 'Run bash setup.sh as your normal logged-in desktop user, not with sudo.' >&2; exit 1; }
if [[ ${XDG_SESSION_TYPE:-} == wayland ]]; then
  echo 'Wayland detected. Full desktop sharing/control is not supported by this X11 backend.' >&2
  echo 'Log out, choose an X11/Xorg session if your desktop offers one, log in and rerun setup.' >&2
  echo 'For gamepad-only use on Wayland, see PORTABLE.md; this installer does not claim full screen support.' >&2
  exit 1
fi
if [[ -z ${DISPLAY:-} ]]; then
  echo 'No desktop DISPLAY found. Run setup in a terminal inside the desktop you want to control.' >&2
  echo 'A headless shell or SSH session alone does not provide a desktop to share.' >&2
  exit 1
fi
if ((AUTOSTART)); then
  command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 || {
    echo 'A working systemd user session is required for --autostart. Omit that option to run in the foreground.' >&2; exit 1;
  }
fi
if ((!SKIP_DEPS)); then bash "$ROOT/tools/install-deps.sh"; fi
command -v node >/dev/null || { echo 'Node.js 18+ is required. Rerun without --skip-deps.' >&2; exit 1; }
command -v x11vnc >/dev/null || { echo 'x11vnc is required for the remote screen. Rerun without --skip-deps.' >&2; exit 1; }
# Do not start a second copy over an existing service or another application.
node - "$PORT" <<'JS'
const net=require('net');const port=Number(process.argv[2]);
const server=net.createServer();server.once('error',()=>{console.error(`Port ${port} is already in use. Stop the existing app/service or select --port.`);process.exit(1)});server.listen(port,'0.0.0.0',()=>server.close());
JS
ARGS=(--port "$PORT")
if ((!AUTOSTART)); then ARGS+=(--no-service); fi
bash "$ROOT/install.sh" "${ARGS[@]}"
if ((AUTOSTART)); then
  echo 'Autostart configured. See journalctl --user -u pocket-desktop for logs.'
elif ((INSTALL_ONLY)); then
  printf 'Setup complete. Start with: bash %q --port %q\n' "$ROOT/run.sh" "$PORT"
else
  exec bash "$ROOT/run.sh" --port "$PORT"
fi
