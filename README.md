<p align="center">
  <img src="assets/logo.svg" width="84" height="84" alt="Claudify logo" />
</p>

<h1 align="center">Claudify</h1>

<p align="center">
  <b>Auto-resume your Claude Code sessions the moment your usage limit resets</b><br/>
  opt-in, consent-gated, and driven by a Claude-authored away plan.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bhavyabibra/claudify"><img src="https://img.shields.io/npm/v/@bhavyabibra/claudify?color=6355ff&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-6355ff" alt="node >= 20" />
  <img src="https://img.shields.io/badge/license-MIT-6355ff" alt="MIT" />
</p>

You hit your session limit at 11pm. Instead of the session sitting dead until you
wake up and type "continue," Claudify resumes it for you the second your quota
resets — but only for sessions you explicitly opted in, only within the
permissions you granted, and following a plan Claude wrote before you left.

No cc-tap, no browser automation, no undocumented APIs. Claudify drives the
official `claude -p --resume` CLI and reads the transcript files Claude Code
already writes to `~/.claude/projects/`.

---

## How it works

1. **You opt a session in.** In the dashboard, pick a session and set what it may
   do unattended (or, for a checklist-driven away plan, run `/away` inside a
   Claude Code session). Nothing runs without your explicit grant.
2. **The daemon watches.** It tails the session's transcript. When it sees
   `You've hit your session limit · resets 6pm (Asia/Calcutta)`, it computes the
   reset time — spending zero quota to do so.
3. **It resumes at reset.** At the reset time it runs
   `claude -p --resume <id> "<continuation prompt>"` with your granted permission
   mode and turn caps. The resumed session reads `.claudify/AWAY_PLAN.md`, works
   the task queue, appends progress, and stops.
4. **You get a notification** and a morning-readable log of what happened.

## Quick start

Everything below is done from the **dashboard** (a local web page) — no need to
live in the terminal after install.

### 1. Install

```bash
npm install -g @bhavyabibra/claudify
```

Requires **Node.js ≥ 20** and the **Claude Code CLI** (`claude`) installed.

### 2. Start the daemon (the background watcher)

```bash
claudify daemon install
```

On **macOS** this registers a launchd agent that runs at login, restarts on
crash, and hosts the dashboard for you. On **Windows/Linux**, run
`claudify daemon run` instead and keep it running (see [Platform support](#platform-support-honest-status)).

### 3. Open the dashboard

```bash
claudify dashboard
```

This opens **http://127.0.0.1:4177** in your browser. Bookmark it — it's your
control panel. (If the daemon is already hosting it, this just opens the tab.)

### 4. Connect Claude Code

Click **Connect Claude Code** in the dashboard. A browser window opens; approve
it. This signs Claudify in with your Claude subscription — a **one-time** step.

> Claudify needs the standalone `claude` CLI's own login, which is separate from
> the Claude desktop app. The **Connect** button handles it; you don't need a
> terminal. (Under the hood it runs `claude auth login`.)

### 5. Arm a session

In **Add a session**, you'll see your recent Claude conversations — the same list
as your Claude app sidebar. Click one and set:

- **When to resume** — *when it hits the limit* (the default) or *at a set time*
  (useful if you're near your limit but haven't hit it yet and know your reset time)
- **How much it can do** — *plan* / *edit files* (recommended) / *run freely* /
  *all tools*
- **Spend limit**, **work per resume**, **times to continue**, **turn off after**
- Optionally, **a goal** (what to work on) — treated as an objective, not a
  script, so repeated resumes won't redo finished work

Click **Turn on auto-resume**. That's it — walk away.

When your limit resets, Claudify resumes the session, and the continued
conversation shows up right back in your Claude app. You'll get a notification
with what ran.

> **Leave your machine on** (and ideally on AC power) for overnight resumes — a
> sleeping laptop can't run the resume.

## Everyday controls

Mostly you'll use the dashboard, but everything is scriptable too:

```bash
claudify list                 # what's armed and each state
claudify status               # daemon health + upcoming resumes
claudify logs -f              # follow activity live
claudify on <id>              # re-enable a session
claudify off <id>             # pause a session
claudify remove <id>          # stop watching entirely
claudify doctor               # preflight checks (--auth also tests login)
```

The dashboard also has a **Resume now** button on each armed session, to trigger
a resume immediately (handy for testing or a manual nudge).

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

- macOS, Windows, or Linux — see [platform support](#platform-support-honest-status)
- Node.js ≥ 20
- Claude Code CLI (`claude`) installed (the dashboard's **Connect** button logs it in)
- A Claude plan with session limits (Pro/Max)

### Platform support (honest status)

Claudify **runs on macOS, Windows, and Linux** — session detection, resumes, the
desktop-app session list, the dashboard, and notifications are all
platform-aware. The one thing that isn't fully automated everywhere is the
**always-on daemon**:

| Piece | macOS | Windows / Linux |
|---|---|---|
| Session list, resumes, binary lookup, dashboard | ✅ | ✅ |
| Notifications | osascript | PowerShell toast / `notify-send` |
| Auto-start the daemon at login | ✅ `claudify daemon install` (launchd) | Run `claudify daemon run`, wired into Task Scheduler (Windows) or a systemd user service (Linux) |

So on Windows/Linux everything works; you just start the daemon yourself (one
command, or wire it into your OS's startup). Native auto-start installers for
those platforms are a welcome contribution.

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

**v0.1 — published and proven live.** The full loop has been verified end to end
on real hardware: limit detection, scheduled and on-limit triggers, real headless
resumes that reappear in the Claude desktop app, spend caps, and idempotent
continuation. Available on npm as
[`@bhavyabibra/claudify`](https://www.npmjs.com/package/@bhavyabibra/claudify).

Known limitation: auto-start installers for Windows/Linux aren't built yet (the
daemon runs there via `claudify daemon run`). Contributions welcome.

## License

MIT — see [LICENSE](LICENSE).
