#!/usr/bin/env bash
# validate-skill.sh — Layer 1 mechanical checks for an agent skill.
#
# Usage:
#   validate-skill.sh <path-to-skill-dir>
#   validate-skill.sh --all [<skills-root>]   # default root: .claude/skills
#
# Exit codes:
#   0  clean
#   1  errors
#   2  warnings only
#   3  usage error

set -u
IFS=$'\n\t'

# ---------- formatting ----------
if [[ -t 1 ]]; then
  C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_RED=""; C_YEL=""; C_GRN=""; C_DIM=""; C_OFF=""
fi

TOTAL_FAIL=0
TOTAL_WARN=0

emit() {
  local level="$1" msg="$2"
  case "$level" in
    PASS) printf "  %s[PASS]%s %s\n" "$C_GRN" "$C_OFF" "$msg" ;;
    WARN) printf "  %s[WARN]%s %s\n" "$C_YEL" "$C_OFF" "$msg" ; TOTAL_WARN=$((TOTAL_WARN+1)) ;;
    FAIL) printf "  %s[FAIL]%s %s\n" "$C_RED" "$C_OFF" "$msg" ; TOTAL_FAIL=$((TOTAL_FAIL+1)) ;;
    INFO) printf "  %s%s%s\n" "$C_DIM" "$msg" "$C_OFF" ;;
  esac
}

# ---------- per-skill validation ----------
validate_skill() {
  local skill_dir="$1"
  local name; name="$(basename "$skill_dir")"
  printf "\n%s\n" "Skill: $name  ($skill_dir)"

  local skill_md="$skill_dir/SKILL.md"
  if [[ ! -f "$skill_md" ]]; then
    emit FAIL "SKILL.md is missing"
    return
  fi

  # ----- frontmatter parsing -----
  local first; first="$(head -n1 "$skill_md")"
  if [[ "$first" != "---" ]]; then
    emit FAIL "SKILL.md does not start with YAML frontmatter (---)"
    return
  fi

  local fm_end
  fm_end=$(awk 'NR>1 && /^---[[:space:]]*$/{print NR; exit}' "$skill_md")
  if [[ -z "$fm_end" ]]; then
    emit FAIL "YAML frontmatter is not closed with ---"
    return
  fi

  local fm body
  fm="$(sed -n "2,$((fm_end-1))p" "$skill_md")"
  body="$(sed -n "$((fm_end+1)),\$p" "$skill_md")"

  # name
  local fm_name
  fm_name="$(printf '%s\n' "$fm" | awk -F': *' '/^name:/{print $2; exit}' | tr -d '"')"
  if [[ -z "$fm_name" ]]; then
    emit FAIL "frontmatter missing 'name' field"
  elif ! [[ "$fm_name" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
    emit FAIL "name '$fm_name' is not lowercase alphanumeric+hyphens, 1-64 chars"
  elif [[ "$fm_name" != "$name" ]]; then
    emit WARN "frontmatter name '$fm_name' does not match directory name '$name'"
  else
    emit PASS "name '$fm_name' valid and matches directory"
  fi

  # description
  local fm_desc
  fm_desc="$(printf '%s\n' "$fm" | awk '/^description:/{sub(/^description: */,""); print; exit}')"
  if [[ -z "$fm_desc" ]]; then
    emit FAIL "frontmatter missing 'description' field"
  else
    local dlen=${#fm_desc}
    if (( dlen > 1024 )); then
      emit FAIL "description is $dlen chars (max 1024)"
    elif (( dlen < 40 )); then
      emit WARN "description is only $dlen chars — likely too thin to guide trigger selection"
    else
      emit PASS "description length $dlen chars"
    fi
    if printf '%s' "$fm_desc" | grep -qiE 'use when|trigger when|use this|use whenever'; then
      emit PASS "description includes a 'Use when' trigger phrase"
    else
      emit WARN "description has no 'Use when' / 'Trigger when' phrase — agent may not know when to fire"
    fi
  fi

  # ----- body checks -----
  local body_lines
  body_lines=$(printf '%s\n' "$body" | wc -l | tr -d ' ')
  if (( body_lines > 250 )); then
    emit FAIL "SKILL.md body is $body_lines lines (>250); split into reference files"
  elif (( body_lines > 100 )); then
    emit WARN "SKILL.md body is $body_lines lines (>100); consider splitting into reference files"
  else
    emit PASS "SKILL.md body is $body_lines lines"
  fi

  # imperative ratio (bullet lines starting with imperative verb)
  local bullets imperatives
  bullets=$(printf '%s\n' "$body" | grep -cE '^[[:space:]]*[-*][[:space:]]+' || true)
  if (( bullets >= 5 )); then
    imperatives=$(printf '%s\n' "$body" | grep -cE '^[[:space:]]*[-*][[:space:]]+(\*\*)?[A-Z][a-z]+\b' || true)
    # Heuristic: capitalised first word that isn't an obvious noun marker
    local ratio=0
    if (( bullets > 0 )); then
      ratio=$(( imperatives * 100 / bullets ))
    fi
    if (( ratio < 30 )); then
      emit WARN "imperative ratio in bullets is ~${ratio}% (heuristic; <30% suggests passive prose)"
    else
      emit PASS "imperative ratio ~${ratio}% across $bullets bullets"
    fi
  fi

  # ----- referenced sibling files -----
  # extract relative .md and script paths from links like [text](./foo.md) or (foo.md) or (scripts/x.sh)
  # but skip lines inside fenced code blocks (``` ... ```) so template examples don't count as real refs
  local refs
  refs="$(awk '
    /^[[:space:]]*```/ { in_code = !in_code; next }
    !in_code { print }
  ' "$skill_md" | grep -oE '\(([./A-Za-z0-9_-]+\.(md|sh|js|ts|py))\)' | tr -d '()' | sort -u || true)"
  local missing=0
  while IFS= read -r ref; do
    [[ -z "$ref" ]] && continue
    # strip leading ./
    ref="${ref#./}"
    if [[ ! -e "$skill_dir/$ref" ]]; then
      emit FAIL "SKILL.md references '$ref' which does not exist"
      missing=$((missing+1))
    fi
  done <<< "$refs"
  if (( missing == 0 )) && [[ -n "$refs" ]]; then
    emit PASS "all referenced sibling files exist"
  fi

  # ----- orphan files in standard subdirs -----
  for sub in scripts references assets; do
    [[ -d "$skill_dir/$sub" ]] || continue
    while IFS= read -r f; do
      local rel="${f#$skill_dir/}"
      if ! grep -qF "$rel" "$skill_md"; then
        # also tolerate references from sibling .md files
        if ! grep -rqF "$rel" "$skill_dir" --include='*.md' --exclude='SKILL.md' 2>/dev/null; then
          emit WARN "orphan file '$rel' (not referenced from any .md)"
        fi
      fi
    done < <(find "$skill_dir/$sub" -type f)
  done
}

# ---------- entrypoint ----------
if [[ $# -lt 1 ]]; then
  printf "usage: %s <skill-dir> | --all [<skills-root>]\n" "$(basename "$0")" >&2
  exit 3
fi

if [[ "$1" == "--all" ]]; then
  root="${2:-.claude/skills}"
  if [[ ! -d "$root" ]]; then
    printf "skills root '%s' does not exist\n" "$root" >&2
    exit 3
  fi
  while IFS= read -r d; do
    validate_skill "$d"
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d | sort)
else
  if [[ ! -d "$1" ]]; then
    printf "not a directory: %s\n" "$1" >&2
    exit 3
  fi
  validate_skill "$1"
fi

printf "\n%s\n" "─────────────"
printf "Totals: %s%d FAIL%s, %s%d WARN%s\n" "$C_RED" "$TOTAL_FAIL" "$C_OFF" "$C_YEL" "$TOTAL_WARN" "$C_OFF"

if (( TOTAL_FAIL > 0 )); then
  exit 1
elif (( TOTAL_WARN > 0 )); then
  exit 2
fi
exit 0
