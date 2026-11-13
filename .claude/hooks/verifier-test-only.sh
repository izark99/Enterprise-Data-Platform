#!/bin/bash
# PreToolUse (Edit|Write) for the verifier subagent: it may write tests, fixtures and E2E only.
command -v jq >/dev/null || { echo "verifier-test-only: jq is required" >&2; exit 2; }
FILE=$(jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0
ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REL="${FILE#"$ROOT"/}"
case "$REL" in
  e2e/* | fixtures/* | supabase/tests/* | */__tests__/* | *.test.ts | *.test.tsx | *.spec.ts) exit 0 ;;
esac
echo "Blocked: the verifier writes only test, fixture and E2E files ($REL). Report the finding instead." >&2
exit 2
