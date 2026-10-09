# Clone and run on another Linux desktop

This is **local installation portability**, not an internet tunnel. Clone the code
on the computer you want to control, run it there, and connect your phone to the
same reachable network. You do not need a cloud account or VPN to operate the app.
GitHub only hosts the source code. GitHub Pages cannot run this Node.js/Linux
remote-control backend.

## Quick start

Clone the project:

```bash
git clone https://github.com/cid0980/Pocket-desktop.git pocket-desktop
cd pocket-desktop
bash setup.sh
```

Install Git first if needed (`sudo apt install git`, `sudo dnf install git`,
`sudo pacman -S git`, or `sudo zypper install git`). Run setup **as your normal
logged-in desktop user**, not as root. It requests sudo only for system changes.

Setup installs dependencies using your package manager, prompts for an access PIN,
configures virtual input permissions, and starts the app in the foreground.
Open the printed phone URL or pairing QR on your phone. Ctrl+C stops the app.
Your desktop must remain on, logged in, and connected. Configuration is outside the
repository at `~/.config/pocket-desktop`; each PC keeps its own credentials.

### Options

```bash
bash setup.sh --plan                 # inspect commands without changing anything
bash setup.sh --install-only         # configure, start later
bash setup.sh --skip-deps            # dependencies are already installed
bash setup.sh --port 9000            # avoid a conflicting port
bash setup.sh --autostart            # systemd user service, not a second foreground copy
bash run.sh                         # subsequent runs do not need setup again
```

Arch's dependency installation uses `pacman -Syu --needed` to avoid unsupported
partial upgrades; review its system-upgrade confirmation before proceeding.

For updates, stop the running foreground app (or `systemctl --user stop
pocket-desktop` for the service), then:

```bash
git pull --ff-only
bash setup.sh --skip-deps
```

For a service installation, restart with `systemctl --user restart pocket-desktop`
instead of launching another foreground copy. Rerun dependency setup if release
notes introduce new tools. Never use `git reset --hard` to discard local work just
to update; resolve or commit your changes first.

## Compatibility — not a claim of “every Linux”

| Environment | Status |
|---|---|
| Debian/Ubuntu family + X11 | apt dependency path; Debian sandbox installation tested |
| Fedora + X11 | dnf package list and command construction tested; no Fedora desktop available here |
| Arch + X11 | pacman package list and command construction tested; no Arch desktop available here |
| openSUSE + X11 | zypper package list and command construction tested; no openSUSE desktop available here |
| Other package managers / immutable distros | install dependencies manually; sandbox/immutable package systems are not automatically supported |
| Wayland | full desktop control is not supported by the current x11vnc backend; setup stops with an explanation |
| Headless SSH session | no real desktop to share; run from an existing graphical session |
| Without systemd | foreground setup works; --autostart is unavailable |
| Windows / macOS | not supported by these installers/backends |

Wayland gamepad-only operation may work with uinput, but this has not been verified.
An advanced user can install dependencies, configure input with
`bash install.sh --no-service`, then run the app and use only Gamepad/Mouse pad.
This does **not** make x11vnc capture a Wayland desktop. Do not use XWayland as a
claim of full Wayland support. Modern desktops may not offer an X11 session at all.

Windows would need Windows-specific capture, system actions, input injection and a
supported virtual-controller driver. Running the Linux version in WSL does not turn
it into a Windows desktop controller. Windows work is deferred, not represented by
a nonfunctional installer.

## Security and network

- No router port forwarding is needed; do not expose this server publicly.
- Allow the app's TCP port only on your trusted LAN. Guest Wi-Fi/client isolation,
  firewalld, ufw and other firewalls can block access. Setup does not prove phone
  reachability. Review firewall changes on each machine.
- Raw VNC stays on localhost. Pairing URLs and PINs are credentials: do not commit
  them or paste them into a public issue.
- The uinput rule now uses `0660` with `uaccess`, not world-writable `0666`. Setup
  grants the installing user an immediate ACL; a systemd/udev graphical session
  reapplies access on login. Non-seat/headless sessions may need administrator-
  configured permissions. Reboot persistence could not be tested in this container.
- Trusted HTTPS is still needed for motion sensors and full PWA installation;
  cloning a Git repository does not solve the browser secure-context restriction.
  See README → Motion / HTTPS.

## Put the project on GitHub

The source includes `.gitignore`, an MIT license, portable setup scripts, and a
GitHub Actions template for syntax/installer-plan and isolated server tests.
To enable CI later, copy `tools/github-checks.yml.example` to
`.github/workflows/checks.yml` and commit it using credentials with workflow-write
permission. The publication credential could push source but not create workflows.
Project repository: https://github.com/cid0980/Pocket-desktop.
The following instructions are for publishing your own copy; use your own empty
repository URL instead of the project URL in that case.

1. Create an **empty** GitHub repository under your account (choose public/private).
2. Extract the release and open a terminal in `pocket-desktop`.
3. Run:

```bash
git init -b main
git add .
git commit -m "Initial Pocket Desktop release"
git remote add origin https://github.com/cid0980/Pocket-desktop.git
git push -u origin main
```

If Git asks for author details, configure your own `user.name` and `user.email`.
Authenticate locally using GitHub's supported SSH or credential-manager flow. Never
send passwords, private keys, or access tokens in this chat. If the GitHub repository
already contains files/history, use its existing clone and commit these files there;
do not force-push over existing history.

The normal release zip excludes `.git`, runtime settings, keys and test screenshots.
The app's vendored dependencies and their licenses are included, so no npm install
is needed after cloning.
