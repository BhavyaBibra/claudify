---
description: Set up an away plan and register this Claude Code session with Claudify so it auto-resumes after usage-limit resets.
---

# /away — hand this session to Claudify

The user is about to step away and wants this Claude Code session to keep making
progress on its own after the usage limit resets. Your job is to (1) capture a
clear away plan, (2) write it to `.claudify/AWAY_PLAN.md`, and (3) register this
session with Claudify — with the user explicitly confirming the permission grant.

## Step 1 — Interview the user (briefly)

Ask, in one message, for:
- **Objective**: what should get done while they're away (the definition of done)?
- **Task queue**: the ordered list of tasks to work through.
- **Constraints**: anything you must NOT touch (files, git push, adding deps, etc.).
- **Stop conditions**: when should you stop early (e.g. tests fail 3× in a row)?
- **Permission level** they're comfortable granting unattended:
  - `plan` — you only plan/read, no writes (safest)
  - `acceptEdits` — you edit files; risky shell commands still block (recommended)
  - `dontAsk` + an allowlist — you run without prompts, limited to listed tools
  - `bypassPermissions` — full autonomy, no guardrails (discourage this)
- **Caps**: max turns per resume (default 50), max resumes per limit cycle
  (default 3), and how long the grant should last (default 12h).

Do not invent permission answers. If the user is vague, recommend `acceptEdits`
with a small allowlist (e.g. their test command) and confirm.

## Step 2 — Write `.claudify/AWAY_PLAN.md`

Create the directory if needed and write this structure, filled in from the interview:

```markdown
# Away Plan — <project> — <date>

## Objective
<one paragraph: the definition of done for this away session>

## Task queue
- [ ] <task 1>
- [ ] <task 2>

## Constraints
- <what not to touch / rules>

## Stop conditions
- <stop early if ...>

## Progress log
<!-- Each resumed run appends: timestamp, what got done, what's next, blockers -->
```

## Step 3 — Register with Claudify

Run the CLI (adjust flags to the user's answers). Use the current session id from
your environment if available, otherwise omit `--session` so Claudify defaults to
the most recent session in this directory:

```bash
claudify watch --from-skill \
  --mode <plan|acceptEdits|dontAsk|bypassPermissions> \
  --allow "<comma-separated tool patterns>" \
  --max-turns 50 \
  --max-resumes 3 \
  --expires-in 12h
```

Notes:
- `--from-skill` runs non-interactively but the grant still reflects what the
  user just told you — you are passing their answers through, never inventing them.
- For `bypassPermissions` you must add `--yes-i-accept-full-autonomy`; only do
  this if the user clearly insisted.
- After it registers, tell the user to confirm the daemon is running with
  `claudify daemon status` (or `claudify daemon install` the first time), and that
  they'll get a notification when their session resumes.

## Step 4 — Confirm

Summarize back to the user: which session is now watched, the permission level,
the caps, when the grant expires, and where the away plan lives. Remind them the
laptop must stay on (and ideally on AC power) for overnight resumes.
