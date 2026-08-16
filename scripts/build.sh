#!/bin/bash
# Build the distributable bundle from src/ into lib/.
# The build is self-contained so `prepare` also works for GitHub source installs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node ./scripts/build.mjs
