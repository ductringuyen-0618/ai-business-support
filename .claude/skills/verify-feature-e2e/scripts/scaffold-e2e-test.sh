#!/usr/bin/env bash
# scaffold-e2e-test.sh — create a scripts/e2e/<name>.sh template ready to fill in.
#
# Usage:  scaffold-e2e-test.sh <feature-name> [<description>]
# Writes: scripts/e2e/<feature-name>.sh (relative to repo root)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $(basename "$0") <feature-name> [<description>]" >&2
  exit 2
fi

name="$1"
desc="${2:-end-to-end check for $name}"

if ! [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: feature-name must be lowercase alphanumeric + hyphens (got '$name')" >&2
  exit 2
fi

# resolve repo root
repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: not inside a git repo (cwd: $PWD)" >&2
  exit 2
}

out_dir="$repo_root/scripts/e2e"
out_file="$out_dir/$name.sh"

if [[ -e "$out_file" ]]; then
  echo "error: $out_file already exists — refusing to overwrite" >&2
  exit 1
fi

mkdir -p "$out_dir"

cat > "$out_file" <<EOF
#!/usr/bin/env bash
# e2e: $desc
#
# Acceptance criterion (fill in from Phase 1 of verify-feature-e2e):
#   <one sentence describing observable behaviour that means "done">
#
# Usage: ./scripts/e2e/$name.sh
# Exit:  0 PASS, non-zero FAIL

set -euo pipefail

# ---- config ----
: "\${BASE_URL:=http://localhost:3000}"
TMPDIR="\$(mktemp -d)"

# ---- lifecycle ----
cleanup() {
  # tear down anything setup() started
  rm -rf "\$TMPDIR"
}
trap cleanup EXIT

setup() {
  # bring deps up, seed fixtures, etc. Fail fast.
  command -v curl >/dev/null || { echo "missing: curl"; exit 1; }
}

exercise() {
  # do the user-observable thing the feature is about.
  # capture outputs into \$TMPDIR for assertions.
  : "TODO: implement exercise step"
}

assert() {
  # verify observable state. Use exit codes + clear messages.
  # On failure, print enough context that the agent can diagnose.
  : "TODO: implement assertions"
}

# ---- run ----
setup
exercise
assert
echo "PASS: $name"
EOF

chmod +x "$out_file"
echo "wrote $out_file"
echo "next: fill in the TODO blocks, then run it until green"
