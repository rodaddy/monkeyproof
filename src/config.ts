/**
 * @module config
 * @description Server configuration: config file → env var overrides → defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Preset {
  command: string;
  args: string[];
}

interface ConfigFile {
  port?: number;
  authToken?: string;
  maxSessions?: number;
  outputBufferSize?: number;
  sessionTtlMs?: number;
  interactiveSessionTtlMs?: number;
  presets?: Record<string, Preset>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const defaults = {
  port: 3200,
  authToken: "monkeyproof-dev",
  maxSessions: 50,
  outputBufferSize: 2000,
  sessionTtlMs: 3_600_000, // 1 hour
  interactiveSessionTtlMs: 7_200_000, // 2 hours
} as const;

const defaultPresets: Record<string, Preset> = {
  claude: {
    command: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions"],
  },
  "claude-sonnet": {
    command: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--model", "sonnet"],
  },
  "claude-opus": {
    command: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--model", "opus"],
  },
  "claude-interactive": {
    command: "claude",
    args: ["--permission-mode", "bypassPermissions"],
  },
  "claude-interactive-sonnet": {
    command: "claude",
    args: ["--permission-mode", "bypassPermissions", "--model", "sonnet"],
  },
  "claude-interactive-opus": {
    command: "claude",
    args: ["--permission-mode", "bypassPermissions", "--model", "opus"],
  },
  codex: {
    command: "codex",
    args: ["exec"],
  },
  "codex-auto": {
    command: "codex",
    args: ["exec", "--full-auto"],
  },
};

// ---------------------------------------------------------------------------
// Load config file
// ---------------------------------------------------------------------------

function loadConfigFile(): ConfigFile {
  const configPath = resolve("monkeyproof.config.json");
  if (!existsSync(configPath)) return {};

  try {
    const text = readFileSync(configPath, "utf-8");
    return JSON.parse(text) as ConfigFile;
  } catch (err) {
    console.warn(`Warning: failed to parse ${configPath}, using defaults`);
    return {};
  }
}

const file = loadConfigFile();

// ---------------------------------------------------------------------------
// Merge: config file → env vars → defaults
// ---------------------------------------------------------------------------

function envInt(key: string): number | undefined {
  const val = process.env[key];
  if (val === undefined) return undefined;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export const config = {
  port: envInt("PORT") ?? file.port ?? defaults.port,
  authToken: process.env.AGENT_WS_TOKEN ?? file.authToken ?? defaults.authToken,
  maxSessions: envInt("MAX_SESSIONS") ?? file.maxSessions ?? defaults.maxSessions,
  outputBufferSize: envInt("OUTPUT_BUFFER_SIZE") ?? file.outputBufferSize ?? defaults.outputBufferSize,
  sessionTtlMs: envInt("SESSION_TTL_MS") ?? file.sessionTtlMs ?? defaults.sessionTtlMs,
  interactiveSessionTtlMs:
    envInt("INTERACTIVE_SESSION_TTL_MS") ?? file.interactiveSessionTtlMs ?? defaults.interactiveSessionTtlMs,
};

// Presets: config file completely replaces defaults if present
export const presets: Record<string, Preset> = file.presets ?? defaultPresets;

/**
 * Returns true if the preset args do NOT include --print (interactive session).
 */
export function isInteractivePreset(presetName: string): boolean {
  const preset = presets[presetName];
  if (!preset) return false;
  return !preset.args.includes("--print");
}
