/**
 * @module config
 * @description Server configuration from environment variables.
 */

export const config = {
  port: parseInt(process.env.PORT || "3200", 10),
  authToken: process.env.AGENT_WS_TOKEN || "monkeyproof-dev",
  maxSessions: parseInt(process.env.MAX_SESSIONS || "10", 10),
  outputBufferSize: parseInt(process.env.OUTPUT_BUFFER_SIZE || "2000", 10),
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || "3600000", 10), // 1 hour
};

/**
 * Agent presets -- common command + args combos.
 */
export const presets: Record<string, { command: string; args: string[] }> = {
  claude: {
    command: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions"],
  },
  "claude-sonnet": {
    command: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--model", "claude-sonnet-4-20250514"],
  },
  "claude-opus": {
    command: "claude",
    args: ["--print", "--permission-mode", "bypassPermissions", "--model", "claude-opus-4-0520"],
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
