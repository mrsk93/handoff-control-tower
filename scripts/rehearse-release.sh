#!/usr/bin/env bash
set -euo pipefail

source_dir="$(pwd)"
rehearsal_dir="$(mktemp -d "${TMPDIR:-/tmp}/handoff-control-tower-release.XXXXXX")"
cleanup() {
  rm -rf "$rehearsal_dir"
}
trap cleanup EXIT

git clone --no-local --depth=1 "$source_dir" "$rehearsal_dir/repo" >/dev/null
cd "$rehearsal_dir/repo"
pnpm install --frozen-lockfile
pnpm check
pnpm test:properties
pnpm test:scenarios:twice
echo "fresh-clone rehearsal passed in $rehearsal_dir/repo"
