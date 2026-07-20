import { describe, it, expect } from "vitest";
import {
  parseLimitMessage,
  parseClock,
  computeResetTime,
  looksLikeLimitMessage,
  isValidTimeZone,
} from "../src/driver/limit.js";

describe("parseLimitMessage", () => {
  it("parses the real session-limit sample", () => {
    const p = parseLimitMessage("You've hit your session limit · resets 6pm (Asia/Calcutta)");
    expect(p).toEqual({ kind: "session", timeStr: "6pm", tz: "Asia/Calcutta" });
  });

  it("parses a minute-precise time", () => {
    const p = parseLimitMessage("You've hit your session limit · resets 2:50am (Asia/Calcutta)");
    expect(p).toEqual({ kind: "session", timeStr: "2:50am", tz: "Asia/Calcutta" });
  });

  it("handles a generic 'weekly' kind and other zones", () => {
    const p = parseLimitMessage("You've hit your weekly limit · resets 11:30pm (America/New_York)");
    expect(p).toEqual({ kind: "weekly", timeStr: "11:30pm", tz: "America/New_York" });
  });

  it("returns null for unrelated text", () => {
    expect(parseLimitMessage("Here is your answer.")).toBeNull();
    expect(parseLimitMessage("")).toBeNull();
  });
});

describe("looksLikeLimitMessage", () => {
  it("matches limit phrasing even without a parseable time", () => {
    expect(looksLikeLimitMessage("You've hit your session limit somewhere")).toBe(true);
    expect(looksLikeLimitMessage("usage limit reached")).toBe(true);
    expect(looksLikeLimitMessage("all good")).toBe(false);
  });
});

describe("parseClock", () => {
  it.each([
    ["6pm", 18, 0],
    ["6am", 6, 0],
    ["12am", 0, 0],
    ["12pm", 12, 0],
    ["2:50am", 2, 50],
    ["11:30pm", 23, 30],
    ["14:30", 14, 30],
  ])("parses %s", (str, hour, minute) => {
    expect(parseClock(str)).toEqual({ hour, minute });
  });

  it.each(["", "25pm", "13am", "abc", "6:99pm"])("rejects %s", (str) => {
    expect(parseClock(str)).toBeNull();
  });
});

describe("computeResetTime", () => {
  it("returns a future instant matching the wall-clock in the target zone", () => {
    const now = new Date("2026-07-14T09:00:00Z"); // 2:30pm IST
    const reset = computeResetTime("6pm", "Asia/Calcutta", now, 0)!;
    expect(reset).not.toBeNull();
    // 6pm IST == 12:30 UTC same day
    expect(reset.toISOString()).toBe("2026-07-14T12:30:00.000Z");
    expect(reset.getTime()).toBeGreaterThan(now.getTime());
  });

  it("rolls to the next day when the time already passed today", () => {
    const now = new Date("2026-07-14T14:00:00Z"); // 7:30pm IST, past 6pm
    const reset = computeResetTime("6pm", "Asia/Calcutta", now, 0)!;
    // next 6pm IST is the following day -> 2026-07-15T12:30:00Z
    expect(reset.toISOString()).toBe("2026-07-15T12:30:00.000Z");
  });

  it("applies the grace buffer", () => {
    const now = new Date("2026-07-14T09:00:00Z");
    const reset = computeResetTime("6pm", "Asia/Calcutta", now, 120000)!;
    expect(reset.toISOString()).toBe("2026-07-14T12:32:00.000Z");
  });

  it("handles a US timezone with minutes", () => {
    const now = new Date("2026-07-14T12:00:00Z"); // 08:00 EDT
    const reset = computeResetTime("11:30pm", "America/New_York", now, 0)!;
    // 11:30pm EDT (UTC-4) == 03:30 UTC next day
    expect(reset.toISOString()).toBe("2026-07-15T03:30:00.000Z");
  });

  it("returns null for garbage input", () => {
    expect(computeResetTime("nonsense", "Asia/Calcutta")).toBeNull();
    expect(computeResetTime("6pm", "Not/AZone")).toBeNull();
  });
});

describe("isValidTimeZone", () => {
  it("validates zones", () => {
    expect(isValidTimeZone("Asia/Calcutta")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Phobos")).toBe(false);
  });
});
