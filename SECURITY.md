# Security & the consent model

Claudify resumes your Claude Code sessions **while you are away**. An unattended
agent acting with real permissions is the central risk this design manages. This
document explains the guardrails and their limits so you can make an informed
choice before enabling anything.

## The grant

Auto-resume is **opt-in per session**. Enabling it (`claudify watch` or `/away`)
requires you to set an explicit **grant**, stored with a timestamp in
`~/.claudify/watchlist.json` and echoed back in every notification:

| Field | Meaning |
|---|---|
| `permissionMode` | How much the resumed session may do (see below). |
| `allowedTools` | Exact tool patterns permitted without prompting. |
| `maxTurnsPerResume` | Hard cap on agentic turns per resume (`--max-turns`). |
| `maxResumesPerLimitCycle` | How many times a session may resume per reset. |
| `expiresAt` | After this, the session will not resume until you re-grant. |

All caps are enforced by the daemon, **not** by trusting the prompt.

## Permission modes

- **plan** — the session may read and plan only. No file writes. Safest.
- **acceptEdits** *(recommended default)* — file edits allowed; shell commands
  outside your allowlist still block.
- **dontAsk** — runs without prompts, limited to the tools you allowlisted.
- **bypassPermissions** — full autonomy, no guardrails. Requires the explicit
  `--yes-i-accept-full-autonomy` flag; never a default; never suggested by the
  skill. Use only in a sandbox you trust.

## Additional safeguards

- **Grant expiry** — away-mode is time-boxed; a forgotten grant stops resuming.
- **Wall-clock timeout** — each resume is killed after 2 hours.
- **Single-flight by default** — one resume at a time; sessions share one quota.
- **Permission denials surfaced** — if the resumed session was blocked from an
  action, the count appears in the notification and log; that's your signal the
  grant was too narrow (or the away plan too ambitious).
- **Auth failures stop, loudly** — a 401 moves the session to `auth_needed` and
  notifies you rather than silently burning retries.
- **Away-plan Constraints** — the `.claudify/AWAY_PLAN.md` file the `/away` skill
  writes has a Constraints section the resumed session is told to honor.

## What Claudify does *not* protect against

- A generous grant (e.g. a broad allowlist or `bypassPermissions`) can let the
  session take actions you didn't foresee. Grant the minimum you're comfortable
  with, and prefer `plan`/`acceptEdits`.
- Claudify does not sandbox the session; it runs with your normal credentials
  and filesystem access.
- Reset-time parsing depends on Claude Code's message wording; if that changes,
  Claudify falls back to periodic retries rather than acting on a bad guess.

## Reporting

This is a personal open-source project. Please open an issue for security
concerns (avoid including secrets or tokens in the report).
