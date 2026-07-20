#!/usr/bin/env node
import { Command } from "commander";
import { runWatch, type WatchFlags } from "./cli/watch.js";
import { runList, runOff, runOn, runRemove } from "./cli/list.js";
import { runStatus } from "./cli/status.js";
import { runLogs } from "./cli/logs.js";
import { runDoctor } from "./cli/doctor.js";
import { runInitSkill } from "./cli/init-skill.js";
import { runDashboard } from "./cli/dashboard.js";
import {
  runDaemonForeground,
  runDaemonInstall,
  runDaemonStart,
  runDaemonStop,
  runDaemonStatus,
  runDaemonUninstall,
} from "./cli/daemon-cmd.js";

const program = new Command();

program
  .name("claudify")
  .description("Auto-resume your Claude Code sessions when the usage limit resets — opt-in and consent-gated.")
  .version("0.1.0");

program
  .command("watch")
  .description("Register a session for auto-resume (interactive consent flow).")
  .option("-s, --session <idOrPrefix>", "session id or prefix (default: newest in cwd)")
  .option("-m, --mode <mode>", "permission mode: plan|acceptEdits|dontAsk|bypassPermissions")
  .option("--allow <patterns...>", "allowed tool patterns, e.g. 'Bash(npm test:*)'")
  .option("--model <model>", "model for resumes (default: inherit session default)")
  .option("--max-turns <n>", "max turns per resume", (v) => parseInt(v, 10))
  .option("--max-resumes <n>", "max resumes per limit cycle", (v) => parseInt(v, 10))
  .option("--expires-in <dur>", "grant lifetime, e.g. 12h, 2d, 90m")
  .option("--prompt <text>", "continuation prompt")
  .option("--priority <n>", "priority (lower resumes first)", (v) => parseInt(v, 10))
  .option("--yes-i-accept-full-autonomy", "required to use bypassPermissions")
  .option("--from-skill", "non-interactive registration (used by the /away skill)")
  .action(async (opts: WatchFlags) => {
    await runWatch(opts);
  });

program
  .command("list")
  .alias("ls")
  .description("List watched sessions and their state.")
  .action(() => runList());

program
  .command("on <idOrPrefix>")
  .description("Re-enable auto-resume for a watched session.")
  .action((id: string) => runOn(id));

program
  .command("off [idOrPrefix]")
  .description("Disable auto-resume for a session (or --all).")
  .option("--all", "disable all watched sessions")
  .action((id: string | undefined, opts: { all?: boolean }) => runOff(id, Boolean(opts.all)));

program
  .command("remove <idOrPrefix>")
  .alias("rm")
  .description("Remove a session from the watchlist entirely.")
  .action((id: string) => runRemove(id));

program
  .command("status")
  .description("Show daemon and watchlist status.")
  .action(() => runStatus());

program
  .command("logs")
  .description("Show recent Claudify activity.")
  .option("-f, --follow", "follow new log entries")
  .option("-n, --lines <n>", "number of lines", (v) => parseInt(v, 10))
  .action((opts: { follow?: boolean; lines?: number }) => runLogs(opts));

program
  .command("doctor")
  .description("Run preflight checks.")
  .option("--auth", "also test authentication (spends a little quota)")
  .action(async (opts: { auth?: boolean }) => runDoctor(opts));

program
  .command("dashboard")
  .description("Open the local control-panel UI in your browser (works on any OS).")
  .option("-p, --port <n>", "port to serve on (default 4177)", (v) => parseInt(v, 10))
  .option("--no-open", "don't auto-open the browser")
  .action((opts: { port?: number; open?: boolean }) => runDashboard(opts));

program
  .command("init-skill")
  .description("Install the /away command into Claude Code.")
  .action(() => runInitSkill());

const daemon = program.command("daemon").description("Manage the background daemon.");
daemon.command("run").description("Run the daemon in the foreground.").action(() => runDaemonForeground());
daemon.command("install").description("Install and start the launchd agent (macOS).").action(() => runDaemonInstall());
daemon.command("start").description("Start the installed daemon.").action(() => runDaemonStart());
daemon.command("stop").description("Stop the daemon.").action(() => runDaemonStop());
daemon.command("status").description("Show daemon status.").action(() => runDaemonStatus());
daemon.command("uninstall").description("Stop and remove the launchd agent.").action(() => runDaemonUninstall());

async function main() {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

void main();
