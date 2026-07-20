# Verified facts & open items

Empirical findings on real hardware, plus what still needs a live run. Trust this
over assumptions; append as you confirm more.

## Confirmed on 2026-07-14 (macOS, Claude Code 2.1.177)

- `claude -p --resume <id> --output-format json` is the resume driver. The JSON
  result carries `is_error`, `api_error_status`, `result`, `session_id`,
  `num_turns`, `total_cost_usd`, `permission_denials`, `terminal_reason`.
- Usage-limit events are recorded in the session `.jsonl` as an `assistant`
  record with `"isApiErrorMessage": true` and text
  `You've hit your session limit · resets 6pm (Asia/Calcutta)` (real samples:
  `6pm` and `2:50am`, both `Asia/Calcutta`). Detection therefore costs no quota.
- Transcripts live at `~/.claude/projects/<encoded-path>/<uuid>.jsonl`; the real
  project path is in each record's `cwd` field.
- Nested-session env vars poison a standalone `claude` invocation (401):
  `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK*`,
  `AI_AGENT`. Claudify scrubs these before spawning (`src/driver/spawn.ts`).
- The machine's standalone CLI OAuth token in the `Claude Code-credentials`
  keychain item was **expired with no refresh token** (the user works via Claude
  Desktop, which refreshes separately). Standalone `claude -p` 401s until a fresh
  `claude` terminal `/login`. This is why `doctor` has an explicit auth check and
  the daemon routes 401s to an `auth_needed` state.

## Open items — need a live run once `claude /login` is fresh

- [ ] **PONG test:** from a real project cwd, run
      `claude -p --resume <id> --max-turns 1 --output-format json "Reply with exactly: PONG"`
      and confirm: `PONG` in `result`, `session_id` unchanged, transcript grew.
      (Blocked on 2026-07-14 purely by the expired token above.)
- [ ] Confirm `--resume` without `--fork-session` writes turns back into the
      **same** `.jsonl`, so the user's next interactive resume shows the work.
- [ ] Confirm keychain access works when the daemon is spawned by launchd (expect
      yes for a user LaunchAgent; a one-time "Always Allow" dialog may appear).
- [ ] Capture exact wording of the **weekly** limit message and any Opus-specific
      variant; extend the regex fixtures in `test/limit.test.ts` if they differ.
