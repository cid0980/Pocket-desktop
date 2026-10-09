#!/usr/bin/env bash
# Distribution-aware dependencies. --plan never changes the machine.
set -euo pipefail
PLAN=0
MANAGER=""
while (($#)); do
  case "$1" in
    --plan) PLAN=1 ;;
    --manager) MANAGER="${2:?--manager needs apt, dnf, pacman or zypper}"; shift ;;
    -h|--help) echo 'Usage: bash tools/install-deps.sh [--plan] [--manager apt|dnf|pacman|zypper]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ $(uname -s) == Linux ]] || { echo 'This installer supports Linux, not Windows/macOS.' >&2; exit 1; }
if [[ -z "$MANAGER" ]]; then
  ID=''; ID_LIKE=''
  [[ ! -r /etc/os-release ]] || source /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *debian*|*ubuntu*) MANAGER=apt ;;
    *fedora*|*rhel*) MANAGER=dnf ;;
    *arch*) MANAGER=pacman ;;
    *suse*) MANAGER=zypper ;;
    *)
      for cmd in apt-get dnf pacman zypper; do
        if command -v "$cmd" >/dev/null; then MANAGER="${cmd/apt-get/apt}"; break; fi
      done ;;
  esac
fi
case "$MANAGER" in
  apt) UPDATE=(apt-get update); INSTALL=(apt-get install -y nodejs python3 x11vnc xdotool alsa-utils imagemagick openssl curl xclip psmisc procps iproute2 acl kmod) ;;
  dnf) UPDATE=(); INSTALL=(dnf install -y nodejs python3 x11vnc xdotool alsa-utils ImageMagick openssl curl xclip psmisc procps-ng iproute acl kmod) ;;
  pacman) UPDATE=(); INSTALL=(pacman -Syu --needed nodejs python x11vnc xdotool alsa-utils imagemagick openssl curl xclip psmisc procps-ng iproute2 acl kmod) ;;
  zypper) UPDATE=(zypper refresh); INSTALL=(zypper install -y nodejs python3 x11vnc xdotool alsa-utils ImageMagick openssl curl xclip psmisc procps iproute2 acl kmod) ;;
  *) echo 'Unsupported package manager. Install Node.js 18+, Python 3, x11vnc and the optional tools listed in README, then use bash setup.sh --skip-deps.' >&2; exit 2 ;;
esac
printf 'Dependency manager: %s\n' "$MANAGER"
if [[ "$MANAGER" == pacman ]]; then
  echo 'Arch requires a coherent full system upgrade; pacman -Syu will ask for confirmation.'
fi
if ((PLAN)); then
  for name in UPDATE INSTALL; do
    declare -n args="$name"
    if ((${#args[@]})); then printf '  '; printf '%q ' "${args[@]}"; printf '\n'; fi
  done
  exit 0
fi
ADMIN=()
if ((EUID != 0)); then
  command -v sudo >/dev/null || { echo 'sudo is required to install packages. Ask your administrator to run this dependency script.' >&2; exit 1; }
  sudo -v
  ADMIN=(sudo)
fi
if ((${#UPDATE[@]})); then "${ADMIN[@]}" "${UPDATE[@]}"; fi
"${ADMIN[@]}" "${INSTALL[@]}"
command -v node >/dev/null || { echo 'Node.js was not installed. Install a supported Node.js release before continuing.' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<18){console.error("Node.js 18+ required. Your distro ships an older release; install a current supported Node.js LTS.");process.exit(1)}'
