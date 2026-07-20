# Claudify

**Auto-resume your Claude Code sessions the moment your usage limit resets — opt-in, consent-gated, and driven by a Claude-authored away plan.**

You hit your session limit at 11pm. Instead of the session sitting dead until you
wake up and type "continue," Claudify resumes it for you the second your quota
resets — but only for sessions you explicitly opted in, only within the
permissions you granted, and following a plan Claude wrote before you left.

No cc-tap, no browser automation, no undocumented APIs. Claudify drives the
official `claude -p --resume` CLI and reads the transcript files Claude Code
already writes to `~/.claude/projects/`.

---

## How it works

1. **You opt a session in.** In a Claude Code session, run `/away` (or
   `claudify watch`). Claude asks what to work on, writes an away plan, and
   registers the session — with you confirming exactly what it may do unattended.
2. **The daemon watches.** It tails the session's transcript. When it sees
   `You've hit your session limit · resets 6pm (Asia/Calcutta)`, it computes the
   reset time — spending zero quota to do so.
3. **It resumes at reset.** At the reset time it runs
   `claude -p --resume <id> "<continuation prompt>"` with your granted permission
   mode and turn caps. The resumed session reads `.claudify/AWAY_PLAN.md`, works
   the task queue, appends progress, and stops.
4. **You get a notification** and a morning-readable log of what happened.

## Install

```bash
npm install -g claudify
claudify doctor            # preflight checks
claudify doctor --auth     # also verify login (spends a little quota)
claudify init-skill        # install the /away command into Claude Code
claudify daemon install    # start the background daemon (macOS launchd)
```

> **Auth note:** the standalone `claude` CLI needs its own login. If
> `claudify doctor --auth` fails with a 401, run `claude` in a terminal, complete
> `/login`, and retry. (Logging into Claude Desktop is not enough.)

## Use

In any Claude Code project you want to keep progressing while away:

```
/away
```

Answer a few questions (objective, tasks, constraints, permission level, caps).
That's it — close the laptop (leave it on, ideally on AC power).

Or register a session directly:

```bash
claudify watch                       # interactive: pick a session, set the grant
claudify list                        # see what's watched and each state
claudify status                      # daemon + upcoming resumes
claudify logs -f                     # follow activity
claudify off <id>                    # pause a session   (claudify on <id> to resume)
claudify remove <id>                 # stop watching entirely
```

## The permission grant

Because an unattended session acts with real permissions, enabling auto-resume
requires an explicit grant. Modes, from safest:

- **plan** — read/plan only, no writes
- **acceptEdits** *(recommended)* — edit files; risky shell still blocks
- **dontAsk** — no prompts, limited to your allowlist
- **bypassPermissions** — full autonomy (requires `--yes-i-accept-full-autonomy`)

Plus caps: max turns per resume, max resumes per limit cycle, and a grant expiry.
All enforced by the daemon. See [SECURITY.md](SECURITY.md) for the full model.

## The away plan

`/away` writes `.claudify/AWAY_PLAN.md` in your project:

```markdown
# Away Plan — myproject — 2026-07-14
## Objective        (definition of done for tonight)
## Task queue       (ordered checklist, worked top to bottom)
## Constraints      (what not to touch)
## Stop conditions  (when to stop early)
## Progress log     (each resumed run appends what it did / what's next)
```

Each resume continues from the top unchecked item and appends to the progress
log, so the next run — or you, in the morning — picks up cleanly.

## Requirements

- **macOS** — see the platform note below
- Node.js ≥ 20
- Claude Code CLI (`claude`) installed and logged in
- A Claude plan with session limits (Pro/Max)

### Platform support (honest status)

**Claudify is macOS-only today.** The core — scheduler, watchlist, limit
detection, and the dashboard UI (it's a local web page) — is cross-platform, but
four pieces of OS glue are macOS-specific:

| Piece | Windows/Linux status |
|---|---|
| Desktop-app session list | Reads the macOS `~/Library/Application Support/Claude/…` store |
| Always-on daemon | Uses launchd; Windows needs Task Scheduler |
| Locating the `claude` binary | Looks in Unix install paths |
| Notifications | Uses `osascript` (degrades to a log line elsewhere) |

Windows support is planned and well-scoped (those four files are isolated behind
small interfaces), but it does not work there yet. Contributions welcome.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev -- list        # run the CLI from source
```

Architecture: everything that touches Claude Code (CLI spawning, transcript
parsing, limit-message wording) is isolated in `src/driver/`. The scheduler,
store, and daemon know nothing Claude-specific — if Anthropic ships an official
session API, only the driver changes.

## Status

v0.1 — the core loop is built and unit-tested end to end against a fake `claude`
shim. See [docs/VERIFIED.md](docs/VERIFIED.md) for what was empirically confirmed
on real hardware and what still needs a live end-to-end run.

## License

MIT — see [LICENSE](LICENSE).
