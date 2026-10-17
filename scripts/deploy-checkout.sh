#!/usr/bin/env bash
set -euo pipefail
# First install only. Existing source/data/service/workspace must never be overwritten.
if [[ $# != 0 ]]; then echo 'Usage: bash scripts/deploy-checkout.sh' >&2; exit 1; fi
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ssh_options=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
host=sof-sandbox.exe.xyz
ssh "${ssh_options[@]}" "$host" 'bash -se' <<'REMOTE'
set -euo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
for path in "$HOME/pi-durable-remote" "$HOME/.local/share/pi-durable-remote" "$HOME/work/pi-durable-remote-smoke" "$HOME/.config/systemd/user/pi-durable-remote.service"; do
  if [[ -e $path || -L $path ]]; then echo 'Deployment collision; stop and inspect before changing anything' >&2; exit 1; fi
done
[[ $(systemctl --user show pi-durable-remote.service -p LoadState --value) == not-found ]] || { echo 'Service collision' >&2; exit 1; }
systemctl --user show -p Version >/dev/null
[[ $(loginctl show-user "$(id -un)" -p Linger --value) == yes ]] || { echo 'Linger is not enabled; ask operator' >&2; exit 1; }
port_listeners=$(ss -H -ltn 'sport = :7777') || { echo 'Port 7777 probe failed; stop and inspect before deployment' >&2; exit 1; }
[[ -z $port_listeners ]] || { echo 'Port 7777 collision' >&2; exit 1; }
[[ -x $HOME/.local/share/mise/installs/node/24.4.1/bin/node ]] || { echo 'Expected installed Node runtime unavailable; ask operator' >&2; exit 1; }
REMOTE
# Explicit source allowlist: never ship .git, dependencies, local pi, auth or VM data.
archive=$(mktemp "${TMPDIR:-/tmp}/pi-durable-remote-source.XXXXXX")
trap 'rm -f "$archive"' EXIT
COPYFILE_DISABLE=1 tar --no-xattrs --exclude=node_modules --exclude='._*' -czf "$archive" .gitignore README.md ARCHITECTURE.md package.json package-lock.json tsconfig.json packages scripts
ssh "${ssh_options[@]}" "$host" 'umask 077; mkdir "$HOME/pi-durable-remote" && tar -xzf - -C "$HOME/pi-durable-remote"' < "$archive"
ssh "${ssh_options[@]}" "$host" 'bash "$HOME/pi-durable-remote/scripts/install-dependencies.sh" "$HOME/.local/share/mise/installs/node/24.4.1/bin"'
echo 'Source/dependencies installed. Next: list models, choose an authenticated model, install the dedicated user service.'
