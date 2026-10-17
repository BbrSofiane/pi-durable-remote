#!/usr/bin/env bash
set -euo pipefail
# Reuse an installed runtime; do not activate mise or change global configuration.
if [[ $# != 1 || $1 != /* || ! -x $1/node || ! -x $1/npm ]]; then
  echo 'Usage: bash scripts/install-dependencies.sh /absolute/node/bin' >&2
  exit 1
fi
export PATH="$1:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "${BASH_SOURCE[0]}")/.."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) process.exit(1)'
node --version
npm --version
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm run server -- --help
npm run client -- --help
