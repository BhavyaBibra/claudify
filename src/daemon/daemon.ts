/**
 * The long-running daemon: wires real driver/notify/persistence dependencies
 * into the Scheduler and polls on an interval. Kept alive by launchd in prod;
 * runnable in the foreground via `claudify daemon run` for debugging.
 */
import { Scheduler, type SchedulerDeps } from "./scheduler.js";
import { loadWatchlist, saveWatchlist } from "../store/watchlist.js";
import { findLimitEvent } from "../driver/transcript.js";
import { computeResetTime } from "../driver/limit.js";
import { runResume } from "../driver/spawn.js";
import { touchAppStoreSession, appStoreAvailable } from "../driver/appstore.js";
import { saveRun } from "./runstore.js";
import { notify } from "../platform/notify.js";
import { logger } from "../util/log.js";
import { startServer, type ServerHandle } from "../dashboard/server.js";
import type { Watchlist, WatchedSession } from "../store/schema.js";

export function buildDeps(): SchedulerDeps {
  return {
    findLimitEvent: (p) => findLimitEvent(p),
    computeResetTime: (t, tz, now) => computeResetTime(t, tz, now),
    runResume: async (s: WatchedSession, prompt: string) => {
      const result = await runResume({
        sessionId: s.sessionId,
        cwd: s.project,
        prompt,
        grant: s.grant,
      });
      // After a resume, bump the desktop app's metadata so the conversation
      // rises to the top of Recents and shows the new turn. Best-effort.
      if (!result.isAuthError && appStoreAvailable()) {
        const touched = touchAppStoreSession(s.sessionId);
        logger.info("appstore_touch", { sessionId: s.sessionId.slice(0, 8), updated: touched });
      }
      return result;
    },
    saveRun: (s, prompt, result) => saveRun(s.sessionId, prompt, result),
    notify: (title, message) => {
      // notifications toggle is read from the current watchlist at call time
      const wl = loadWatchlist();
      notify(title, message, wl.settings.notifications);
    },
    persist: (wl: Watchlist) => saveWatchlist(wl),
    log: (event, fields) => logger.info(event, fields),
  };
}

export interface DaemonHandle {
  stop: () => void;
}

/** Start the poll loop. Returns a handle to stop it (used in tests). */
export function startDaemon(): DaemonHandle {
  const scheduler = new Scheduler(buildDeps());
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let serverHandle: ServerHandle | null = null;

  logger.info("daemon_start", { pid: process.pid });

  // Host the dashboard from inside the daemon so the user never has to keep a
  // terminal open. Failure here must not take down the scheduler.
  const startup = loadWatchlist();
  if (startup.settings.dashboardEnabled) {
    startServer(startup.settings.dashboardPort)
      .then((h) => {
        serverHandle = h;
        logger.info("dashboard_started", { url: h.url });
      })
      .catch((err: NodeJS.ErrnoException) => {
        const why = err.code === "EADDRINUSE" ? `port ${startup.settings.dashboardPort} in use` : err.message;
        logger.warn("dashboard_start_failed", { error: why });
      });
  }

  const runOnce = async () => {
    if (stopped) return;
    try {
      const wl = loadWatchlist();
      const enabled = wl.sessions.filter((s) => s.enabled).length;
      const did = await scheduler.tick(wl, new Date());
      if (did > 0) logger.info("tick_resumed", { count: did });
      scheduleNext(wl.settings.pollIntervalSec);
      void enabled;
    } catch (err) {
      logger.error("tick_failed", { error: (err as Error).message });
      scheduleNext(30);
    }
  };

  const scheduleNext = (sec: number) => {
    if (stopped) return;
    timer = setTimeout(runOnce, Math.max(5, sec) * 1000);
  };

  // Kick off immediately.
  void runOnce();

  const onSignal = () => handle.stop();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  const handle: DaemonHandle = {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (serverHandle) serverHandle.close();
      logger.info("daemon_stop", { pid: process.pid });
    },
  };
  return handle;
}
