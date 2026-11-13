#!/bin/bash
# PostToolUse (Edit|Write): format the edited file with the repo's Prettier. Never blocks.
command -v jq >/dev/null || exit 0
FILE=$(jq -r '.tool_input.file_path // empty')
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
case "$FILE" in
  *.ts | *.tsx | *.js | *.mjs | *.json | *.css | *.yml | *.yaml | *.html)
    [ -x "$ROOT/node_modules/.bin/prettier" ] &&
      (cd "$ROOT" && node_modules/.bin/prettier --write --log-level=error "$FILE" >/dev/null 2>&1)
    ;;
esac
exit 0
