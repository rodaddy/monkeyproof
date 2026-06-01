/**
 * @module config
 * @description Server configuration with file → env → defaults priority.
 *
 * Loading order:
 * 1. monkeyproof.config.json (cwd or repo root)
 * 2. Environment variables (override file values)
 * 3. Hardcoded defaults (fallback)
 */

import { join } from "path";

interface ConfigFile {
  port?: number;
  authToken?: string;
  maxSessions?: number;
  outputBufferSize?: number;
  sessionTtlMs?: number;
  interactiveSessionTtlMs?: number;
  presets?: Record<string, { command: string; args: string[] }>;
}

const DEFAULT_AUTH_TOKEN = "CHANGE_ME_AGENT_WS_TOKEN";

async function loadConfigFile(): Promise<ConfigFile> {
  const paths = [
    join(process.cwd(), "monkeyproof.config.json"),
    join(import.meta.dir, "..", "monkeyproof.config.json"),
  ];

  for (const p of paths) {
    const file = Bun.file(p);
    if (await file.exists()) {
      try {
        return JSON.parse(await file.text()) as ConfigFile;
      } catch (e) {
        console.warn(`Warning: failed to parse ${p}:`, e);
      }
    }
  }

  return {};
}

const file = await loadConfigFile();
const authToken = process.env.AGENT_WS_TOKEN || file.authToken || DEFAULT_AUTH_TOKEN;

if (authToken === DEFAULT_AUTH_TOKEN) {
  console.warn(
    "Warning: AGENT_WS_TOKEN is not configured; using CHANGE_ME_AGENT_WS_TOKEN placeholder. Set a strong token before exposing monkeyproof.",
  );
}

export const config = {
  port: parseInt(process.env.PORT || String(file.port ?? 3200), 10),
  authToken,
  maxSessions: parseInt(process.env.MAX_SESSIONS || String(file.maxSessions ?? 50), 10),
  outputBufferSize: parseInt(process.env.OUTPUT_BUFFER_SIZE || String(file.outputBufferSize ?? 2000), 10),
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || String(file.sessionTtlMs ?? 3600000), 10),
  interactiveSessionTtlMs: parseInt(
    process.env.INTERACTIVE_SESSION_TTL_MS || String(file.interactiveSessionTtlMs ?? 7200000),
    10,
  ),
};

/** Default presets -- overridden by config file if present */
const DEFAULT_PRESETS: Record<string, { command: string; args: string[] }> = {
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
  codex: {
    command: "codex",
    args: ["exec"],
  },
  "codex-auto": {
    command: "codex",
    args: ["exec", "--full-auto"],
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
};

export const presets: Record<string, { command: string; args: string[] }> =
  file.presets && Object.keys(file.presets).length > 0 ? file.presets : DEFAULT_PRESETS;

/**
 * Check if a preset is interactive (no --print flag).
 * Interactive sessions get a longer TTL.
 */
export function isInteractivePreset(presetName: string): boolean {
  const preset = presets[presetName];
  if (!preset) return false;
  return !preset.args.includes("--print");
}

/**
 * Get the appropriate TTL for a session based on its preset.
 */
export function getSessionTtl(presetName?: string): number {
  if (presetName && isInteractivePreset(presetName)) {
    return config.interactiveSessionTtlMs;
  }
  return config.sessionTtlMs;
}
