#!/bin/bash
# Build dsh-claude-importer: bundle src/ → lib/ with bun (TS, no typecheck).
# Dependencies resolve at runtime from the DSH checkout's node_modules
# (the profile lives inside the checkout, so bare imports fall back up the
# tree into it) — EXCEPT @deepseek-ai/dsh-hook-protocol, which ships bundled
# in this package's own node_modules.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# DSH_CHECKOUT 探测：环境变量 → 本 Pod 的 ssot 检出 → 常见路径
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/node_modules" ]; then
  for candidate in \
    /mnt/volumes/infra-cloud-alg-su01/wangjiazhe/.deepseenHar_conver_softlink \
    "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/node_modules" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/node_modules" ]; then
  echo "build: cannot locate the DSH checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi
echo "build: using DSH checkout at $CHECKOUT"

# 确认运行时依赖就位：hook-protocol（bundle 自带；yaml 已打包进 lib，无回落层依赖）
if [ ! -d "$ROOT/node_modules/@deepseek-ai/dsh-hook-protocol" ]; then
  echo "build: installing bundled dependency @deepseek-ai/dsh-hook-protocol" >&2
  npm install --legacy-peer-deps --omit=dev || exit 1
fi
BUN="${BUN:-$(command -v bun || true)}"
if [ -n "$BUN" ]; then
  echo "=== Bundling src → lib (bun) ==="
  rm -rf lib
  "$BUN" build src/index.ts \
    --outdir lib \
    --format=esm \
    --target=node \
    --external '@deepseek-ai/*'
else
  echo "build: bun not found on PATH (install bun or set BUN=/path/to/bun)" >&2
  exit 1
fi

echo "=== Build complete ==="
ls -la lib/
