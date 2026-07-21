import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { appStoreRoot } from "../src/driver/appstore.js";

/** Swap process.platform for one assertion, then restore. */
function withPlatform(p: NodeJS.Platform, fn: () => void) {
  const orig = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: p, configurable: true });
  try {
    fn();
  } finally {
    if (orig) Object.defineProperty(process, "platform", orig);
  }
}

describe("appStoreRoot cross-platform", () => {
  afterEach(() => {
    delete process.env.CLAUDIFY_APPSTORE_DIR;
    vi.unstubAllEnvs();
  });

  it("uses the macOS Application Support path", () => {
    withPlatform("darwin", () => {
      expect(appStoreRoot()).toBe(
        path.join(os.homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
      );
    });
  });

  it("uses %APPDATA% on Windows", () => {
    vi.stubEnv("APPDATA", "C:\\Users\\me\\AppData\\Roaming");
    withPlatform("win32", () => {
      expect(appStoreRoot()).toBe(
        path.join("C:\\Users\\me\\AppData\\Roaming", "Claude", "claude-code-sessions"),
      );
    });
  });

  it("uses ~/.config on Linux", () => {
    vi.stubEnv("XDG_CONFIG_HOME", "");
    withPlatform("linux", () => {
      expect(appStoreRoot()).toBe(path.join(os.homedir(), ".config", "Claude", "claude-code-sessions"));
    });
  });

  it("honors the CLAUDIFY_APPSTORE_DIR override on any platform", () => {
    process.env.CLAUDIFY_APPSTORE_DIR = "/tmp/custom";
    withPlatform("win32", () => {
      expect(appStoreRoot()).toBe("/tmp/custom");
    });
  });
});
