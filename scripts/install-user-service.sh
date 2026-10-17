#!/usr/bin/env bash
set -euo pipefail
umask 077
if [[ $# != 3 ]]; then
  echo 'Usage: bash scripts/install-user-service.sh /absolute/node/bin <provider> <model-id>' >&2
  exit 1
fi
node_bin=$1
provider=$2
model=$3
app="$HOME/pi-durable-remote"
data="$HOME/.local/share/pi-durable-remote"
workspace="$HOME/work/pi-durable-remote-smoke"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/pi-durable-remote.service"
# Keep generated systemd arguments literal: reject whitespace, percent specifiers and quoting characters.
for value in "$node_bin" "$HOME" "$provider" "$model"; do
  [[ $value =~ ^[A-Za-z0-9_./:-]+$ ]] || { echo 'Unsupported path or model identifier characters' >&2; exit 1; }
done
[[ $node_bin == /* && $HOME == /* && -x $node_bin/node ]] || { echo 'Expected absolute HOME and installed Node runtime' >&2; exit 1; }
[[ $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P) == "$app" ]] || { echo 'Install only from ~/pi-durable-remote (no symlink)' >&2; exit 1; }
export PATH="$node_bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
for path in "$data" "$workspace" "$unit"; do
  [[ ! -e $path && ! -L $path ]] || { echo 'Deployment collision; refusing to overwrite data/workspace/service' >&2; exit 1; }
done
[[ $(systemctl --user show pi-durable-remote.service -p LoadState --value) == not-found ]] || { echo 'Service collision' >&2; exit 1; }
systemctl --user show -p Version >/dev/null
[[ $(loginctl show-user "$(id -un)" -p Linger --value) == yes ]] || { echo 'Linger is not enabled; ask operator' >&2; exit 1; }
port_listeners=$(ss -H -ltn 'sport = :7777') || { echo 'Port 7777 probe failed; stop and inspect before deployment' >&2; exit 1; }
[[ -z $port_listeners ]] || { echo 'Port 7777 collision' >&2; exit 1; }
cd "$app"
# Public bridge only. Check auth availability without invoking generation or printing raw configuration/errors.
node --experimental-strip-types --input-type=module - "$provider" "$model" <<'NODE'
import { createConfiguredModels } from './packages/server/src/index.ts';
try {
  const models = await createConfiguredModels();
  const [provider, id] = process.argv.slice(2);
  if (!(await models.getAvailable(provider)).some(model => model.id === id)) throw new Error();
  console.log('Selected model is available with VM authentication (no model call performed)');
} catch {
  console.error('Selected model/auth/config unavailable; service was not installed');
  process.exitCode = 1;
}
NODE
mkdir -p "$HOME/.local/share" "$HOME/work" "$unit_dir"
mkdir "$data" "$workspace"
# noclobber also guards a unit-file race after preflight.
(set -o noclobber; cat > "$unit" <<UNIT
[Unit]
Description=Private durable coding agent (one explicit session)
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$app
Environment=PATH=$node_bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$node_bin/node --experimental-strip-types $app/packages/server/src/main.ts --cwd $workspace --storage $data/session.sqlite --provider $provider --model $model --host 127.0.0.1 --port 7777
Restart=always
RestartSec=6
UMask=0077
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=30
SendSIGKILL=yes

[Install]
WantedBy=default.target
UNIT
)
systemctl --user daemon-reload
systemctl --user enable --now pi-durable-remote.service
systemctl --user is-active --quiet pi-durable-remote.service
echo 'Dedicated service enabled and active; verify a fresh client snapshot before declaring health.'
