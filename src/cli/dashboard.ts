import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import { startServer } from "../dashboard/server.js";
import { loadWatchlist } from "../store/watchlist.js";

export interface DashboardFlags {
  port?: number;
  open?: boolean; // default true
}

/** Open a URL in the default browser, cross-platform. Best effort. */
function openBrowser(url: string): void {
  const platform = os.platform();
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(cmd, args, () => {
    /* ignore: user can open the URL manually */
  });
}

/** Is a Claudify dashboard already answering on this port (e.g. the daemon)? */
function alreadyServing(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/state", timeout: 800 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

export async function runDashboard(flags: DashboardFlags): Promise<void> {
  const port = flags.port ?? loadWatchlist().settings.dashboardPort ?? 4177;
  const url = `http://127.0.0.1:${port}`;

  // If the daemon (or another instance) already hosts it, just open the browser.
  if (await alreadyServing(port)) {
    console.log(`Dashboard already running at ${url} (served by the daemon).`);
    if (flags.open !== false) openBrowser(url);
    return;
  }

  // Otherwise run a standalone server in the foreground (fallback for users who
  // haven't installed the daemon).
  let handle;
  try {
    handle = await startServer(port);
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${port} is already in use. Try: claudify dashboard --port <other>`
        : (err as Error).message;
    console.error(`Could not start dashboard: ${msg}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Claudify dashboard running at ${handle.url}`);
  console.log("Tip: run `claudify daemon install` so the dashboard is always up and you never keep this open.");
  console.log("Ctrl-C to stop.");
  if (flags.open !== false) openBrowser(handle.url);

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
