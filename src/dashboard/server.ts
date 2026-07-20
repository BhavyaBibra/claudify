/**
 * Tiny dependency-free HTTP server for the local dashboard. Binds to loopback
 * only. Works identically on macOS/Windows/Linux (plain Node http).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getState,
  armSession,
  setEnabled,
  removeWatched,
  setSettings,
  resumeNow,
  type ArmBody,
} from "./api.js";
import { authHint, startLogin, testAuth } from "../driver/auth.js";
import { logger } from "../util/log.js";

let cachedPage: string | null = null;
function pageHtml(): string {
  if (cachedPage !== null) return cachedPage;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "page.html"), // dist/dashboard/page.html (copied at build)
    path.resolve(here, "../../src/dashboard/page.html"), // running from dist without copy
    path.resolve(here, "page.html"),
  ];
  for (const c of candidates) {
    try {
      cachedPage = fs.readFileSync(c, "utf8");
      return cachedPage;
    } catch {
      // try next
    }
  }
  cachedPage = "<!doctype html><meta charset=utf-8><title>Claudify</title><p>page.html not found.";
  return cachedPage;
}

function send(res: http.ServerResponse, code: number, body: string, type = "application/json"): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) req.destroy(); // basic guard
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

export interface ServerHandle {
  port: number;
  url: string;
  close: () => void;
}

export function startServer(port: number, host = "127.0.0.1"): Promise<ServerHandle> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, pageHtml(), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return send(res, 200, JSON.stringify(getState()));
      }
      if (req.method === "POST" && url.pathname === "/api/watch") {
        const body = (await readJson(req)) as unknown as ArmBody;
        const result = armSession(body);
        logger.info("dashboard_watch", { sessionId: String(body.sessionId).slice(0, 8), mode: body.mode, ok: result.ok, error: result.error });
        return send(res, 200, JSON.stringify(result));
      }
      if (req.method === "POST" && url.pathname === "/api/toggle") {
        const body = await readJson(req);
        const result = setEnabled(String(body.sessionId), Boolean(body.enabled));
        logger.info("dashboard_toggle", { sessionId: String(body.sessionId).slice(0, 8), enabled: Boolean(body.enabled), ok: result.ok });
        return send(res, 200, JSON.stringify(result));
      }
      if (req.method === "POST" && url.pathname === "/api/remove") {
        const body = await readJson(req);
        const result = removeWatched(String(body.sessionId));
        logger.info("dashboard_remove", { sessionId: String(body.sessionId).slice(0, 8), ok: result.ok });
        return send(res, 200, JSON.stringify(result));
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        const body = await readJson(req);
        return send(res, 200, JSON.stringify(setSettings(body as Record<string, never>)));
      }
      if (req.method === "POST" && url.pathname === "/api/resume-now") {
        const body = await readJson(req);
        const sid = String(body.sessionId);
        logger.info("dashboard_resume_now_start", { sessionId: sid.slice(0, 8) });
        const result = await resumeNow(sid);
        logger.info("dashboard_resume_now", { sessionId: sid.slice(0, 8), ok: result.ok, summary: result.summary, error: result.error });
        return send(res, 200, JSON.stringify(result));
      }
      if (req.method === "GET" && url.pathname === "/api/auth") {
        return send(res, 200, JSON.stringify(await authHint()));
      }
      if (req.method === "POST" && url.pathname === "/api/connect") {
        return send(res, 200, JSON.stringify(startLogin()));
      }
      if (req.method === "POST" && url.pathname === "/api/auth-test") {
        return send(res, 200, JSON.stringify(await testAuth()));
      }
      send(res, 404, JSON.stringify({ error: "not found" }));
    } catch (err) {
      send(res, 500, JSON.stringify({ error: (err as Error).message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => {
      resolve({
        port,
        url: `http://${host}:${port}`,
        close: () => server.close(),
      });
    });
  });
}
