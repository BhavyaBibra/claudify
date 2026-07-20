#!/usr/bin/env bash
# Test shim standing in for the real `claude` CLI. Behavior is driven by env vars
# so tests can script different outcomes without a network or real auth.
#
#   FAKE_CLAUDE_MODE = success | authfail | limit | hang | crash
#   FAKE_CLAUDE_ARGS_FILE = path to append the received argv (one per line)
#   FAKE_CLAUDE_APPEND_TRANSCRIPT = path to a .jsonl to append a fake turn to

if [ -n "$FAKE_CLAUDE_ARGS_FILE" ]; then
  for a in "$@"; do echo "$a" >> "$FAKE_CLAUDE_ARGS_FILE"; done
fi

# --version short-circuit
for a in "$@"; do
  if [ "$a" = "--version" ]; then echo "9.9.9 (fake-claude)"; exit 0; fi
done

MODE="${FAKE_CLAUDE_MODE:-success}"
SID="test-session-0001"

if [ -n "$FAKE_CLAUDE_APPEND_TRANSCRIPT" ] && [ "$MODE" != "hang" ]; then
  echo '{"type":"assistant","timestamp":"2026-07-14T00:00:00.000Z","message":{"role":"assistant","content":"did work"}}' >> "$FAKE_CLAUDE_APPEND_TRANSCRIPT"
fi

case "$MODE" in
  authfail)
    echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"api_error_status\":401,\"num_turns\":1,\"result\":\"Failed to authenticate. API Error: 401 Invalid authentication credentials\",\"session_id\":\"$SID\",\"total_cost_usd\":0,\"terminal_reason\":\"completed\",\"permission_denials\":[]}"
    ;;
  limit)
    if [ -n "$FAKE_CLAUDE_APPEND_TRANSCRIPT" ]; then
      echo '{"type":"assistant","timestamp":"2026-07-14T00:01:00.000Z","isApiErrorMessage":true,"message":{"role":"assistant","content":"You'"'"'ve hit your session limit · resets 6pm (Asia/Calcutta)"}}' >> "$FAKE_CLAUDE_APPEND_TRANSCRIPT"
    fi
    echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":3,\"result\":\"worked then hit limit\",\"session_id\":\"$SID\",\"total_cost_usd\":0.02,\"terminal_reason\":\"completed\",\"permission_denials\":[]}"
    ;;
  hang)
    sleep 30
    ;;
  crash)
    echo "boom" >&2
    exit 3
    ;;
  *)
    echo "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":12,\"result\":\"PONG\",\"session_id\":\"$SID\",\"total_cost_usd\":0.01,\"terminal_reason\":\"completed\",\"permission_denials\":[]}"
    ;;
esac
exit 0
