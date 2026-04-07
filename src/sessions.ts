/**
 * @module sessions
 * @description Session manager -- spawns, tracks, and streams coding agent processes.
 */

import { spawn, type Subprocess } from "bun";
import { randomUUID } from "crypto";
import { config, presets, isInteractivePreset } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionCreateOpts {
  task: string;
  cwd?: string;
  command?: string;
  args?: string[];
  preset?: string;
  maxTurns?: number;
  env?: Record<string, string>;
}

export interface SessionInfo {
  id: string;
  task: string;
  cwd: string;
  command: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  pid: number | null;
  createdAt: string;
  endedAt: string | null;
  outputLines: number;
  wsClients: number;
}

export interface SessionDetail extends SessionInfo {
  recentOutput: string;
}

interface Session {
  id: string;
  task: string;
  cwd: string;
  command: string;
  interactive: boolean;
  proc: Subprocess;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  createdAt: Date;
  endedAt: Date | null;
  output: string[];
  wsClients: Set<WebSocketClient>;
}

export interface WebSocketClient {
  send: (data: string) => void;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const sessions = new Map<string, Session>();

// Cleanup timer -- remove exited sessions after TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (
      session.status !== "running" &&
      session.endedAt
    ) {
      const ttl = session.interactive
        ? config.interactiveSessionTtlMs
        : config.sessionTtlMs;
      if (now - session.endedAt.getTime() > ttl) {
        sessions.delete(id);
      }
    }
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function createSession(opts: SessionCreateOpts): SessionInfo {
  if (sessions.size >= config.maxSessions) {
    const running = Array.from(sessions.values()).filter(
      (s) => s.status === "running"
    ).length;
    throw new Error(
      `Max sessions reached (${config.maxSessions}). ${running} running.`
    );
  }

  const id = randomUUID().slice(0, 8);
  const cwd = opts.cwd || process.env.HOME || "/tmp";

  // Resolve command + args from preset or explicit
  let command: string;
  let args: string[];
  let interactive = false;

  const resolvedPreset = opts.preset ? presets[opts.preset] : undefined;
  if (opts.preset && resolvedPreset) {
    command = resolvedPreset.command;
    args = [...resolvedPreset.args];
    interactive = isInteractivePreset(opts.preset);
  } else {
    command = opts.command || "claude";
    args = opts.args || ["--print", "--permission-mode", "bypassPermissions"];
    interactive = !args.includes("--print");
  }

  // Add max-turns for claude
  if (command === "claude" && opts.maxTurns) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  // Append the task as the final argument
  args.push(opts.task);

  // Build env
  const procEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };

  const proc = spawn([command, ...args], {
    cwd,
    env: procEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const session: Session = {
    id,
    task: opts.task.slice(0, 500),
    cwd,
    command: `${command} ${args.slice(0, -1).join(" ")}`,
    interactive,
    proc,
    status: "running",
    exitCode: null,
    createdAt: new Date(),
    endedAt: null,
    output: [],
    wsClients: new Set(),
  };

  sessions.set(id, session);

  // Stream stdout
  streamReader(session, proc.stdout, "stdout");
  streamReader(session, proc.stderr, "stderr");

  // Handle exit
  proc.exited.then((code) => {
    session.status = "exited";
    session.exitCode = code;
    session.endedAt = new Date();
    broadcast(session, { type: "exit", code, duration: getDuration(session) });
    // Close WS clients after a short delay (let them receive the exit message)
    setTimeout(() => {
      for (const ws of session.wsClients) {
        try {
          ws.close();
        } catch {}
      }
    }, 1000);
  });

  return toInfo(session);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listSessions(): SessionInfo[] {
  return Array.from(sessions.values()).map(toInfo);
}

export function getSession(id: string): SessionDetail | null {
  const session = sessions.get(id);
  if (!session) return null;
  return {
    ...toInfo(session),
    recentOutput: session.output.slice(-100).join(""),
  };
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  if (session.status === "running") {
    session.proc.kill();
    session.status = "killed";
    session.endedAt = new Date();
    broadcast(session, { type: "killed" });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export async function sendInput(id: string, input: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.status !== "running") return false;
  if (!session.proc.stdin) return false;

  const writer = session.proc.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  writer.releaseLock();
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------

export function addWsClient(id: string, ws: WebSocketClient): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  session.wsClients.add(ws);

  // Send catchup
  ws.send(
    JSON.stringify({
      type: "catchup",
      id: session.id,
      task: session.task,
      status: session.status,
      exitCode: session.exitCode,
      data: session.output.slice(-100).join(""),
    })
  );

  return true;
}

export function removeWsClient(id: string, ws: WebSocketClient): void {
  const session = sessions.get(id);
  if (session) {
    session.wsClients.delete(ws);
  }
}

export function sessionExists(id: string): boolean {
  return sessions.has(id);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function streamReader(
  session: Session,
  stream: ReadableStream<Uint8Array> | null,
  channel: "stdout" | "stderr"
): void {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        session.output.push(text);

        // Trim buffer
        while (session.output.length > config.outputBufferSize) {
          session.output.shift();
        }

        broadcast(session, { type: channel, data: text });
      }
    } catch {
      // Stream closed
    }
  })();
}

function broadcast(session: Session, msg: Record<string, unknown>): void {
  const payload = JSON.stringify(msg);
  for (const ws of session.wsClients) {
    try {
      ws.send(payload);
    } catch {
      session.wsClients.delete(ws);
    }
  }
}

function getDuration(session: Session): number {
  const end = session.endedAt || new Date();
  return Math.round((end.getTime() - session.createdAt.getTime()) / 1000);
}

function toInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    task: session.task,
    cwd: session.cwd,
    command: session.command,
    status: session.status,
    exitCode: session.exitCode,
    pid: session.proc.pid,
    createdAt: session.createdAt.toISOString(),
    endedAt: session.endedAt?.toISOString() || null,
    outputLines: session.output.length,
    wsClients: session.wsClients.size,
  };
}
