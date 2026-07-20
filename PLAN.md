# COrchestrator — Build Plan

**One-liner:** A daemon + CLI that auto-resumes your Claude Code sessions the moment your usage limit resets — but only for sessions you explicitly opt in, with a consent-gated permission model and a Claude-authored "away plan" that tells the resumed session exactly what to do.

**Audience for this document:** Claude Opus running in Claude Code, building this project end to end. Everything in the "Verified facts" section was empirically tested on this machine (macOS, Claude Code 2.1.177) on 2026-07-14. Trust it over assumptions, and re-verify anything marked ⚠️.

---

## 1. Product vision

Claude Code users on Pro/Max plans hit session usage limits ("You've hit your session limit · resets 6pm"). The session then sits dead until the human returns and types "continue". Overnight and workday resets are wasted capacity.

COrchestrator removes the human from that loop, safely:

1. User is working in a Claude Code session and wants it to keep going while they're away.
2. They run `/away` (a skill COrchestrator installs). Claude asks a few questions, writes an **away plan** file into the project, and registers the session with the daemon — including an explicit, user-confirmed **permission grant** for unattended operation.
3. When the session hits the usage limit, the daemon sees it, parses the reset time, and at reset time resumes the session headlessly with a continuation prompt pointing at the away plan.
4. User gets a notification and a morning-readable log: what ran, what was accomplished, what's next.

**Non-goals for v1:** multi-machine sync, Windows/Linux (macOS first; keep the platform layer isolated), web dashboard (v2), controlling non-Claude-Code sessions.

**License/positioning:** built as a releasable open-source product from day one (MIT, clean README, no hardcoded personal paths). Name: **COrchestrator**, CLI binary: **`corc`**.

---

## 2. Verified facts (tested 2026-07-14 on this machine)

### 2.1 The driver is the official CLI — no cc-tap, no undocumented HTTP APIs

`claude -p --resume <session-id> "<prompt>"` headlessly appends a user message to an existing session and runs the full agentic loop until Claude stops. Relevant verified flags from `claude --help` (v2.1.177):

- `-p, --print` — non-interactive mode, prints result and exits
- `-r, --resume [sessionId]` — resume by session ID (without `--fork-session`, it continues the SAME session ID)
- `--fork-session` — would create a new session ID instead; **do not use** (we want the user to reopen their own session later)
- `--model <model>` — override model for the resumed run
- `--max-turns <n>` — hard cap on agentic turns (our runaway protection)
- `--output-format json` — structured result (schema below)
- `--permission-mode <mode>` — choices: `acceptEdits`, `auto`, `bypassPermissions`, `default`, `dontAsk`, `plan`
- `--allowedTools / --disallowedTools <tools...>` — e.g. `"Bash(npm test) Edit"`
- `--fallback-model <model>` — auto-fallback if primary overloaded
- `--settings <file-or-json>` — inject settings for the run

Sample `--output-format json` result (real output from this machine):

```json
{"type":"result","subtype":"success","is_error":true,"api_error_status":401,
 "duration_ms":2800,"num_turns":1,
 "result":"Failed to authenticate. API Error: 401 Invalid authentication credentials",
 "session_id":"f486a98a-...","total_cost_usd":0,
 "usage":{...},"modelUsage":{},"permission_denials":[],
 "terminal_reason":"completed"}
```

Fields to consume: `is_error`, `api_error_status`, `result` (text), `session_id`, `num_turns`, `total_cost_usd`, `permission_denials` (surface these to the user!), `terminal_reason`.

### 2.2 Session storage layout

- Sessions live at `~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl` (path encoding: `/` → `-`, e.g. `-Users-bhavyabibra-COrchestrator`).
- JSONL records carry `type` (`user`, `assistant`, `queue-operation`, ...), `timestamp` (ISO 8601 UTC), `sessionId`, `cwd` (the real project path — read it from records instead of decoding the directory name), and `message`.

### 2.3 The limit event is recorded in the transcript — detection is free

When a session hits the usage limit, the transcript gets an **assistant** record with `"isApiErrorMessage": true` and content text like:

```
You've hit your session limit · resets 6pm (Asia/Calcutta)
You've hit your session limit · resets 2:50am (Asia/Calcutta)
```

(Both real samples from this machine.) So the daemon needs **zero quota** to detect a limit-hit and its reset time: tail the watched session's JSONL, look for that record as the latest meaningful event.

⚠️ Parse defensively: `/You've hit your (\S+) limit · resets (.+?) \((.+?)\)/`. The first group may also be `weekly` (unconfirmed — handle any word). Times are ambiguous 12h strings ("6pm", "2:50am") in an IANA timezone — compute the next future occurrence of that wall-clock time in that zone; add a +2 minute grace buffer. If parsing fails, fall back to polling every 15 min with a cheap probe-free check (see §5.3).

### 2.4 Auth pitfalls (both empirically hit during validation)

1. **Nested-environment poisoning:** spawning `claude` from inside another Claude session inherits `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `CLAUDE_CODE_*` vars and 401s. The daemon won't normally be nested, but the executor MUST spawn with a scrubbed env anyway: unset `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` (unless user configured API-key auth), and all `CLAUDECODE*`/`CLAUDE_CODE_*`/`CLAUDE_AGENT_SDK*`/`AI_AGENT` vars.
2. **Stale CLI OAuth:** the keychain item `Claude Code-credentials` on this machine holds an access token that **expired 2026-06-16 with no refresh token** (the user works through Claude Desktop, which refreshes its own auth separately). Standalone `claude -p` therefore 401s until the user runs `claude` interactively and logs in again. → Product requirement: `corc doctor` must run a minimal auth check and the daemon must notify "re-login needed" on 401 rather than silently retrying.

**Prerequisite before E2E testing:** the user (Bhavya) must run `claude /login` once in a terminal. The PONG test (`claude -p --resume <id> "Reply with exactly: PONG"`) could not complete on 2026-07-14 for exactly this reason — run it first thing after login works, before building anything big.

### 2.5 Known-unknowns to verify during Phase 0

- ⚠️ Does `-p --resume` write its turns back into the same JSONL (so the user's next interactive `--resume` shows the overnight work)? Expected yes without `--fork-session`; confirm with the PONG test by checking the file grows and the `session_id` in the JSON result matches.
- ⚠️ Does keychain access work when spawned from a launchd agent? Expected yes (user-session launchd agents can read the login keychain), but confirm; if blocked, document the one-time "Always Allow" dialog.
- ⚠️ Exact wording of weekly-limit and opus-specific-limit messages.

---

## 3. Architecture

```
┌────────────────────────────── corc CLI ──────────────────────────────┐
│  corc watch · corc list · corc off · corc status · corc logs        │
│  corc doctor · corc daemon install|start|stop · corc init-skill     │
└──────────────┬───────────────────────────────────────────────────────┘
               │ reads/writes
       ~/.corc/watchlist.json   ~/.corc/corc.log   ~/.corc/runs/*.json
               │ reads
┌──────────────┴──────────────── daemon ───────────────────────────────┐
│  Watcher    — tails JSONL of watched sessions, detects limit events  │
│  Scheduler  — computes reset time, maintains a priority-ordered      │
│               resume queue, enforces caps                            │
│  Executor   — spawns `claude -p --resume ...` (clean env, cwd from   │
│               transcript), parses JSON result, updates run history   │
│  Notifier   — macOS notification + log line per outcome              │
└───────────────────────────────────────────────────────────────────────┘
               │ spawns (official CLI — the only Claude touchpoint)
        claude -p --resume <id> --permission-mode ... --max-turns ...
```

**Driver isolation rule:** everything that touches Claude Code (paths, JSONL parsing, CLI spawning, limit-message regex) lives in one module (`src/driver/`). The scheduler/queue/notifier must not import anything Claude-specific. If Anthropic ships an official sessions API later, only `driver/` changes.

### 3.1 Tech stack

- **TypeScript on Node ≥ 20**, distributed via npm (`npm i -g corchestrator` → `corc`). Rationale: the target audience already lives in the Node/npm ecosystem via Claude Code tooling; single-language OSS repo; easy `npx` trial.
- Minimal deps: `commander` (CLI), `zod` (config validation). **No SQLite** in v1 — a JSON watchlist + one JSON file per run under `~/.corc/runs/` is enough, human-inspectable, and diff-friendly. Revisit if/when the dashboard lands.
- Daemon lifecycle: **launchd user agent** (`~/Library/LaunchAgents/com.corchestrator.daemon.plist`, `KeepAlive: true`). Platform-specific code isolated in `src/platform/`.
- Tests: `vitest`. A fake `claude` shell shim (records argv, replays canned JSON) makes the executor fully testable offline.

### 3.2 Data model (`~/.corc/watchlist.json`)

```jsonc
{
  "version": 1,
  "settings": { "notifications": true, "maxConcurrentResumes": 1 },
  "sessions": [
    {
      "sessionId": "1af46bc9-...",
      "project": "/Users/bhavyabibra/COrchestrator",
      "transcriptPath": "~/.claude/projects/-Users-.../1af46bc9-....jsonl",
      "enabled": true,
      "priority": 1,                       // lower = first when several are waiting
      "continuationPrompt": "Read .corc/AWAY_PLAN.md and continue executing it. Update its Progress section before you stop.",
      "grant": {                            // the consent record — see §4
        "permissionMode": "acceptEdits",
        "allowedTools": ["Bash(npm test:*)", "Bash(git commit:*)"],
        "model": "inherit",
        "maxTurnsPerResume": 50,
        "maxResumesPerLimitCycle": 3,
        "expiresAt": "2026-07-15T09:00:00Z", // grants expire; away-mode is not forever
        "consentedAt": "2026-07-14T22:10:00Z"
      },
      "state": {                            // daemon-owned
        "status": "waiting_for_reset",      // watching | waiting_for_reset | resuming | done | error | auth_needed
        "limitHitAt": "...", "resetAt": "...", "resumesThisCycle": 1,
        "lastRun": { "at": "...", "numTurns": 34, "costUsd": 0, "terminalReason": "completed", "permissionDenials": [] }
      }
    }
  ]
}
```

---

## 4. The consent model (product decision — do not water down)

Auto-resume is opt-in **per session**, and enabling it requires an explicit consent step because an unattended session acts with real permissions.

`corc watch` (and the `/away` skill, which shells out to it) walks the user through:

1. **Which session** — default: most recently active session in cwd; otherwise a picker sorted by recency showing project + first-user-message summary.
2. **Permission grant** — an explicit choice, displayed with consequences:
   - `plan` — Claude only plans/reads; zero writes. (Safest, offered first.)
   - `acceptEdits` — Claude edits files; Bash beyond the allowlist still blocks. **(Recommended default.)**
   - `dontAsk` + explicit allowlist — user types the allowed tool patterns.
   - `bypassPermissions` — only behind `--yes-i-accept-full-autonomy`, with a red warning. Never a default. Never suggested by the skill.
3. **Caps** — max turns per resume (default 50), max resumes per limit cycle (default 3), grant expiry (default: 12 hours from now).
4. **Continuation prompt** — default points at the away plan; user can override.

The grant is stored verbatim in the watchlist with `consentedAt`, echoed back in every notification ("resumed with acceptEdits, 34 turns"), and the executor refuses to run any session whose grant is missing, malformed, or expired. `permission_denials` from the JSON result are logged and shown — they're the signal the grant was too narrow (or the plan too ambitious).

---

## 5. The away plan (the second product pillar)

### 5.1 `/away` skill

`corc init-skill` installs a skill/command into `~/.claude/` so any project can run `/away`. The skill instructs the in-session Claude to:

1. Interview the user briefly: What should I keep working on? What's out of scope? When should I stop early? Anything I must not touch?
2. Write **`.corc/AWAY_PLAN.md`** in the project:

```markdown
# Away Plan — <project> — <date>
## Objective        (one paragraph, the "definition of done" for tonight)
## Task queue       (ordered checklist; work top to bottom)
## Constraints      (files/dirs not to touch, no pushes, no deps, etc.)
## Stop conditions  (stop early if: tests can't pass after 3 attempts, ...)
## Progress log     (append-only;每 resumed run appends: timestamp, done, next, blockers)
```

3. Run `corc watch --from-skill ...` to register the session (the consent questions still go to the human — the skill passes answers through, it never invents a grant).

### 5.2 Continuation prompt (default template)

```
You were resumed automatically by COrchestrator after a usage-limit reset.
Read .corc/AWAY_PLAN.md. Continue from the top unchecked item in the task queue.
Honor the Constraints and Stop conditions sections strictly.
Before you stop: check off completed items and append to the Progress log
(what you did, what's next, any blockers). If everything is done, or a stop
condition triggered, say so explicitly in the Progress log and stop.
```

This gives auto-pipelining for free: each run leaves the plan file in a state the next run (or the returning human) picks up cleanly.

### 5.3 Scheduler behavior

- Watcher polls watched transcripts' mtimes every 30s (cheap `stat`); on change, reads only the tail (last ~50 lines) looking for the limit record.
- On limit event: parse reset time → `state = waiting_for_reset`, notify ("COrchestrator: <project> hit its limit, resuming at 6:00pm").
- At reset (+2 min grace): resume sessions in `priority` order, `maxConcurrentResumes` at a time (default 1 — they share one quota; parallel resumes just burn it faster and hit the limit mid-thought).
- After each run: parse JSON result →
  - ran fine → append run record, notify summary, `resumesThisCycle++`; if plan not done and caps allow, keep watching for the next limit event.
  - output contains a fresh limit message → back to `waiting_for_reset` with the new time.
  - `api_error_status: 401` → `status = auth_needed`, loud notification, stop retrying this cycle.
  - crash/timeout (hard wall-clock timeout: 2h per resume) → retry once, then `error` + notify.
- All caps enforced daemon-side, not trusted to the prompt.

---

## 6. Build phases (each ends green: typecheck + tests + a runnable demo)

### Phase 0 — Truth check (½ session) — DO THIS FIRST
Prereq: user has re-run `/login` in a terminal.
1. Scripted PONG test: pick the smallest real session JSONL, run `claude -p --resume <id> --max-turns 1 --output-format json "Reply with exactly: PONG"` from the project cwd with scrubbed env. Assert: PONG in `result`, same `session_id`, transcript file grew.
2. Capture one fresh real limit message if available; extend the regex fixtures.
3. Write findings into `docs/VERIFIED.md` (append to the facts in §2).
**Gate: do not proceed to Phase 2+ until PONG passes.** (Phase 1 can proceed in parallel — it's pure parsing.)

### Phase 1 — Core library (`src/driver/`, `src/store/`)
- Transcript reader: enumerate projects/sessions, read cwd + timestamps + tail records from JSONL (streaming, never whole-file for big transcripts).
- Limit-event parser with timezone-correct next-occurrence computation (unit-test heavily: pm/am, midnight wraparound, DST-less IANA zones, "12am"/"12pm", already-past times, garbage input).
- Watchlist store with zod-validated schema + atomic writes (write-temp-then-rename).
- Fixtures: real record samples from §2.

### Phase 2 — Executor
- Clean-env spawner (`src/driver/spawn.ts`): builds argv from a grant, scrubs env per §2.4, sets cwd from transcript, enforces wall-clock timeout, parses JSON result.
- Fake-`claude` shim for tests (bash script on PATH that echoes canned JSON and appends to a fake transcript).
- `corc doctor`: checks CLI on PATH + version, auth (1-turn haiku ping — the only quota-spending diagnostic, run only on demand), projects dir readable, watchlist valid.

### Phase 3 — Daemon + scheduler
- Single-process loop: watcher → scheduler → executor → notifier; state machine per watched session exactly as §5.3.
- Structured log (`~/.corc/corc.log`, JSONL) + per-run artifacts (`~/.corc/runs/<ts>-<session>.json` with full CLI output).
- launchd install/uninstall/start/stop (`corc daemon install` writes the plist pointing at the installed binary, `RunAtLoad` + `KeepAlive`).
- macOS notifications via `osascript` (isolated in `src/platform/notify.ts`).

### Phase 4 — CLI UX + consent flow
- `corc watch` interactive flow implementing §4 exactly (session picker, grant wizard, caps, prompt).
- `corc list` (table: project, status, resets-at, resumes used, grant summary), `corc off <session|--all>`, `corc status`, `corc logs [-f]`.
- Non-interactive flags for everything (`--session --mode --allow --max-turns --expires-in --prompt`) so the skill can drive it.

### Phase 5 — `/away` skill + E2E
- `corc init-skill` installs the skill; skill implements §5.1.
- Full E2E on this machine: real session, real `/away`, wait for (or simulate) a limit event — simulation: append a synthetic limit record to a scratch session's copy and point the daemon at it; then one real overnight run.
- README with a 60-second quickstart GIF-script, SECURITY.md explaining the grant model, MIT license, npm packaging (`bin: corc`), CHANGELOG.

### Phase 6 (v2 backlog — do not build now)
Multi-project priority UI, localhost dashboard, ntfy/Telegram notifiers, Linux systemd, "Claude picks the next project" mode, auto-register via SessionStart/Stop hooks, weekly-limit awareness, usage analytics.

---

## 7. Risks & mitigations

| Risk | Level | Mitigation |
|---|---|---|
| JSONL transcript format changes in a CC update | Medium | It's local + versioned; defensive parsing; `corc doctor` runs a format self-check; all format knowledge in `driver/` |
| Limit-message wording changes | Medium | Generic regex + fallback: if a watched session goes silent with an `isApiErrorMessage` we can't parse, poll-retry every 15 min and notify once |
| CLI OAuth goes stale (observed on this very machine) | High, known | `auth_needed` state + loud notification; doctor check; docs |
| Runaway overnight usage | High impact | Daemon-enforced `maxTurnsPerResume`, `maxResumesPerLimitCycle`, grant expiry, wall-clock timeout, single-flight default |
| Unattended session does something destructive | High impact | Consent model (§4): `acceptEdits` default, no bypass without scary flag, allowlists, away-plan Constraints section, `permission_denials` surfaced |
| Resume writes to a forked session and the user never sees the work | Low | Verified-by-test in Phase 0 (no `--fork-session`); assert same `session_id` every run |
| Keychain inaccessible under launchd | Low | Phase 0 check; documented one-time "Always Allow" |

---

## 8. Definition of done (v1)

A stranger with a Mac, Claude Code, and a Pro plan can: `npm i -g corchestrator` → `corc daemon install` → open any project, run `/away`, answer four questions, close the laptop lid overnight (on AC power) → wake up to a notification, `corc logs` showing what happened, `.corc/AWAY_PLAN.md` with checked-off items and a progress log, and their own session resumable with the overnight history in it. Nothing ran that the grant didn't allow; nothing resumed that wasn't opted in.
