#!/bin/bash
# PreToolUse (Edit|Write): blocks edits to files an agent must never change.
# Exit 2 blocks the tool call; stderr is shown to Claude as the reason.
command -v jq >/dev/null || { echo "protect-files: jq is required" >&2; exit 2; }
FILE=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REL="${FILE#"$ROOT"/}"
deny() { echo "Blocked: $REL - $1" >&2; exit 2; }
# Last migration applied to the real database when this repository was created (2026-11-13).
APPLIED_UP_TO=20261109150000
case "$REL" in
  vendor/*) deny "vendored files are immutable (checksums in vendor/README.md)" ;;
  docs/archive/*) deny "archived documents are frozen; write to docs/redesign/ or docs/MEMORY.md" ;;
  *.env.example) ;;
  .env | .env.* | */.env | */.env.*) deny "env files may hold secrets; edit .env.example only" ;;
  supabase/migrations/*)
    VERSION=$(basename "$REL" | grep -oE '^[0-9]{14}')
    RELEASED=no
    [ -n "$VERSION" ] && [ "$VERSION" -le "$APPLIED_UP_TO" ] && RELEASED=yes
    git -C "$ROOT" cat-file -e "origin/main:$REL" 2>/dev/null && RELEASED=yes
    [ "$RELEASED" = yes ] && deny "a released migration is never edited; add a new file (skill: db-migration)"
    ;;
esac
exit 0
