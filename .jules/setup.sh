#!/usr/bin/env bash
#
# Environment setup for the Cate repository on Google Jules (or any sandboxed
# Linux agent VM). Paste this into the Jules environment configuration's setup
# script field, or run it manually after cloning.
#
# It mirrors .github/workflows/ci.yml so the agent's sandbox matches CI.
set -euo pipefail

echo "==> Setting up Cate (Electron + React + TypeScript)"

# node-pty is a native module; node-gyp needs python + setuptools to build it.
if command -v python3 >/dev/null 2>&1; then
  python3 -m pip install --quiet --upgrade setuptools || true
fi

# The committed package-lock.json may pin macOS-specific native binaries.
# Try a normal install first; if it fails, drop the lockfile and retry so
# Linux dependencies resolve cleanly (this is what CI does).
if ! npm install; then
  echo "==> npm install failed; removing lockfile and retrying"
  rm -f package-lock.json
  npm install
fi

echo "==> Setup complete. Validate a change with:"
echo "      npm run build && npm run typecheck && npm run test:unit"
