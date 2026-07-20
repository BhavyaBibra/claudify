# Changelog

All notable changes to Claudify are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project uses SemVer.

## [0.1.0] — unreleased

Initial release.

### Added
- Headless auto-resume of Claude Code sessions after a usage-limit reset, using
  the official `claude -p --resume` CLI (no undocumented APIs).
- Local web dashboard (`claudify dashboard`) as an OS-agnostic control panel:
  session cards, on/off toggles, permission dropdowns, an away-instructions box,
  and live status. The daemon now hosts the dashboard itself, so no terminal
  needs to stay open — the panel is a permanent `http://127.0.0.1:4177` bookmark.
- "Connect Claude Code" in the dashboard: signs in via `claude auth login` from
  the UI (no terminal), with an auth chip, an expired-login banner, and an
  on-demand "Test" that runs a real one-turn ping.
- Dashboard session list now reads from the Claude desktop app's own session
  store, so it mirrors the app sidebar exactly (real titles, no CLI noise).
- Resumed sessions are surfaced back in the desktop app: after a resume,
  Claudify bumps the app-store metadata so the conversation rises to the top of
  Recents with an updated turn count (content already lands in the transcript).
- "Resume now" button — trigger a session's resume immediately (for testing or
  a manual nudge) without waiting to hit a limit.
- Scheduled trigger: per-session toggle between "when it hits the limit" and
  "at a set time" (for users near their limit who already know the reset time).
  The same caps (work per resume, times to continue, turn-off timer) apply.
- "All tools (full control)" option to grant full autonomy from the tools field.
- Robust `claude` binary resolution (fixes the launchd daemon not finding it on
  the minimal PATH) plus an augmented PATH baked into the launchd plist.
- Modernized dashboard UI: refined palette, segmented controls, status pills,
  light/dark, subtle motion.
- Spend limit per grant: Claudify tracks cumulative cost and pauses the session
  once it reaches the cap (bounds runaway spend on large sessions, where each
  turn reprocesses a lot of context). Cost is shown per-run and cumulative.
- Resumes that immediately re-hit the limit no longer consume a "times to
  continue" credit (they did no real work); a separate streak counter bounds
  pathological retry loops.
- Continuation prompts are idempotent and self-terminating: your text is treated
  as an objective, and the prompt tells Claude to review what's already done, not
  repeat finished work, avoid retrying permission-blocked commands, and stop when
  the objective is met.
- Free limit detection by tailing session transcripts for the
  `You've hit your session limit · resets …` message; timezone-correct reset
  computation with a grace buffer.
- Per-session opt-in with an explicit, user-confirmed permission **grant**
  (mode, tool allowlist, model, max turns per resume, max resumes per cycle,
  and an expiry). Grants are enforced daemon-side.
- `/away` skill: Claude interviews the user, writes `.claudify/AWAY_PLAN.md`,
  and registers the session; resumed runs execute the plan and append progress.
- Background daemon with a per-session state machine (watching → waiting →
  resuming → watching/done/error/auth_needed/expired), macOS launchd management,
  and desktop notifications.
- CLI: `watch`, `list`, `on`, `off`, `remove`, `status`, `logs`, `doctor`,
  `init-skill`, `daemon (run|install|start|stop|status|uninstall)`.
- Environment scrubbing so resumes spawned from any context don't inherit
  nested-session variables that cause 401s.
