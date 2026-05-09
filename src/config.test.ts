/**
 * @module config.test
 * @description Tests for monkeyproof configuration and presets.
 */

import { describe, test, expect } from "bun:test";
import { config, presets } from "./config";

describe("config", () => {
  test("default port is 3200", () => {
    expect(config.port).toBe(3200);
  });

  test("default auth token is monkeyproof-dev", () => {
    expect(config.authToken).toBe("monkeyproof-dev");
  });

  test("maxSessions is a positive number", () => {
    expect(config.maxSessions).toBeGreaterThan(0);
  });

  test("outputBufferSize is positive", () => {
    expect(config.outputBufferSize).toBeGreaterThan(0);
  });

  test("sessionTtlMs is at least 1 minute", () => {
    expect(config.sessionTtlMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe("presets", () => {
  test("has required presets", () => {
    expect(presets["claude"]).toBeDefined();
    expect(presets["claude-sonnet"]).toBeDefined();
    expect(presets["claude-opus"]).toBeDefined();
    expect(presets["codex"]).toBeDefined();
    expect(presets["codex-auto"]).toBeDefined();
  });

  test("interactive presets exist", () => {
    expect(presets["claude-interactive"]).toBeDefined();
    expect(presets["claude-interactive-sonnet"]).toBeDefined();
    expect(presets["claude-interactive-opus"]).toBeDefined();
  });

  test("claude presets use --print flag", () => {
    expect(presets["claude"].args).toContain("--print");
    expect(presets["claude-sonnet"].args).toContain("--print");
    expect(presets["claude-opus"].args).toContain("--print");
  });

  test("interactive presets do NOT have --print flag", () => {
    expect(presets["claude-interactive"].args).not.toContain("--print");
    expect(presets["claude-interactive-sonnet"].args).not.toContain("--print");
  });

  test("all presets bypass permissions", () => {
    const claudePresets = Object.entries(presets).filter(([k]) => k.startsWith("claude"));
    for (const [name, preset] of claudePresets) {
      expect(preset.args).toContain("bypassPermissions");
    }
  });

  test("sonnet presets use --model sonnet", () => {
    expect(presets["claude-sonnet"].args).toContain("sonnet");
    expect(presets["claude-interactive-sonnet"].args).toContain("sonnet");
  });

  test("opus presets use --model opus", () => {
    expect(presets["claude-opus"].args).toContain("opus");
    expect(presets["claude-interactive-opus"].args).toContain("opus");
  });

  test("codex presets use codex command", () => {
    expect(presets["codex"].command).toBe("codex");
    expect(presets["codex-auto"].command).toBe("codex");
  });

  test("codex-auto uses --full-auto", () => {
    expect(presets["codex-auto"].args).toContain("--full-auto");
  });

  test("every preset has command and args", () => {
    for (const [name, preset] of Object.entries(presets)) {
      expect(preset.command).toBeTruthy();
      expect(Array.isArray(preset.args)).toBe(true);
    }
  });
});
