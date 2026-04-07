/**
 * @module sessions
 * @description Session manager -- spawns, tracks, and streams coding agent processes.
 * Supports two modes:
 *   - "print": one-shot subprocess with piped stdout (original behavior)
 *   - "interactive": tmux-based persistent session with live capture
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
  type: "print" | "interactive";
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
  transcriptPath: string | null;
}

interface Session {
  id: string;
  task: string;
  cwd: string;
  command: string;
  type: "print" | "interactive";
  // print-only
  proc?: Subprocess;
  // interactive-only
  tmuxName?: string;
  transcriptPath?: string;
  _pollTimer?: ReturnType<typeof setInterval>;
  _lastCapturedLength: number;
  // shared
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
      const ttl = session.type === "interactive"
        ? config.interactiveSessionTtlMs
        : config.sessionTtlMs;
      if (now - session.endedAt.getTime() > ttl) {
        sessions.delete(id);
      }
    }
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Create -- print mode (one-shot subprocess)
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

  if (command === "claude" && opts.maxTurns) {
    args.push("--max-turns", String(opts.maxTurns));
  }

  args.push(opts.task);

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
    type: interactive ? "interactive" : "print",
    proc,
    _lastCapturedLength: 0,
    status: "running",
    exitCode: null,
    createdAt: new Date(),
    endedAt: null,
    output: [],
    wsClients: new Set(),
  };

  sessions.set(id, session);

  streamReader(session, proc.stdout, "stdout");
  streamReader(session, proc.stderr, "stderr");

  proc.exited.then((code) => {
    session.status = "exited";
    session.exitCode = code;
    session.endedAt = new Date();
    broadcast(session, { type: "exit", code, duration: getDuration(session) });
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
// Create -- interactive mode (tmux session)
// ---------------------------------------------------------------------------

export async function createInteractiveSession(
  opts: SessionCreateOpts
): Promise<SessionInfo> {
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
  const tmuxName = `mp-${id}`;

  // Resolve command + args (strip --print if present)
  let claudeArgs: string[];
  if (opts.preset && presets[opts.preset]) {
    claudeArgs = [...presets[opts.preset]!.args];
  } else if (opts.args) {
    claudeArgs = [...opts.args];
  } else {
    claudeArgs = ["--permission-mode", "bypassPermissions"];
  }
  claudeArgs = claudeArgs.filter((a) => a !== "--print");

  if (opts.maxTurns) {
    claudeArgs.push("--max-turns", String(opts.maxTurns));
  }

  const claudeCmd = `claude ${claudeArgs.join(" ")}`;

  // Transcript path: <cwd>/.session/transcript-<date>-<id>.md
  const dateStr = new Date().toISOString().slice(0, 10);
  const sessionDir = `${cwd}/.session`;
  const transcriptPath = `${sessionDir}/transcript-${dateStr}-${id}.md`;

  await Bun.$`mkdir -p ${sessionDir}`.quiet();

  // Create tmux session
  await Bun.$`tmux new-session -d -s ${tmuxName} -x 200 -y 50`;

  // Pipe all pane output to transcript file
  const pipeCmd = `cat >> "${transcriptPath}"`;
  await Bun.$`tmux pipe-pane -t ${tmuxName} -o ${pipeCmd}`;

  // Launch claude in the tmux session
  await Bun.$`tmux send-keys -t ${tmuxName} ${claudeCmd} Enter`;

  // Wait for claude to initialize before sending the task
  await Bun.sleep(2000);

  // Send the task literally (no key interpretation), then Enter
  await Bun.$`tmux send-keys -t ${tmuxName} -l ${opts.task}`;
  await Bun.$`tmux send-keys -t ${tmuxName} Enter`;

  const session: Session = {
    id,
    task: opts.task.slice(0, 500),
    cwd,
    command: claudeCmd,
    type: "interactive",
    tmuxName,
    transcriptPath,
    _lastCapturedLength: 0,
    status: "running",
    exitCode: null,
    createdAt: new Date(),
    endedAt: null,
    output: [],
    wsClients: new Set(),
  };

  sessions.set(id, session);
  startTmuxPoller(session);

  return toInfo(session);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function listSessions(): SessionInfo[] {
  return Array.from(sessions.values()).map(toInfo);
}

export async function getSession(id: string): Promise<SessionDetail | null> {
  const session = sessions.get(id);
  if (!session) return null;

  let recentOutput = session.output.slice(-100).join("");

  if (session.type === "interactive" && session.tmuxName) {
    try {
      const capture =
        await Bun.$`tmux capture-pane -t ${session.tmuxName} -p -S -`.quiet();
      recentOutput = capture.text();
    } catch {
      // Tmux session gone or capture failed -- use cached output
    }
  }

  return {
    ...toInfo(session),
    recentOutput,
    transcriptPath: session.transcriptPath ?? null,
  };
}

// ---------------------------------------------------------------------------
// Transcript (interactive sessions only)
// ---------------------------------------------------------------------------

export async function readTranscript(
  id: string,
  since?: number
): Promise<string | null> {
  const session = sessions.get(id);
  if (!session || !session.transcriptPath) return null;

  try {
    const file = Bun.file(session.transcriptPath);
    if (!(await file.exists())) return "";
    const text = await file.text();
    if (since !== undefined && since > 0) return text.slice(since);
    return text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kill
// ---------------------------------------------------------------------------

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  if (session.status === "running") {
    if (session.type === "interactive" && session.tmuxName) {
      if (session._pollTimer) clearInterval(session._pollTimer);
      Bun.$`tmux kill-session -t ${session.tmuxName}`.quiet().catch(() => {});
    } else {
      session.proc?.kill();
    }
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

  if (session.type === "interactive" && session.tmuxName) {
    try {
      await Bun.$`tmux send-keys -t ${session.tmuxName} -l ${input}`;
      await Bun.$`tmux send-keys -t ${session.tmuxName} Enter`;
      return true;
    } catch {
      return false;
    }
  }

  if (!session.proc?.stdin) return false;
  const stdin = session.proc.stdin;
  if (typeof stdin === "number") return false;
  stdin.write(new TextEncoder().encode(input));
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket management
// ---------------------------------------------------------------------------

export function addWsClient(id: string, ws: WebSocketClient): boolean {
  const session = sessions.get(id);
  if (!session) return false;

  session.wsClients.add(ws);

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

function startTmuxPoller(session: Session): void {
  const timer = setInterval(async () => {
    if (session.status !== "running" || !session.tmuxName) {
      clearInterval(timer);
      return;
    }

    // Check if tmux session still exists
    try {
      await Bun.$`tmux has-session -t ${session.tmuxName}`.quiet();
    } catch {
      // Tmux session ended -- claude finished or was killed externally
      clearInterval(timer);
      session.status = "exited";
      session.exitCode = 0;
      session.endedAt = new Date();
      broadcast(session, {
        type: "exit",
        code: 0,
        duration: getDuration(session),
      });
      setTimeout(() => {
        for (const ws of session.wsClients) {
          try {
            ws.close();
          } catch {}
        }
      }, 1000);
      return;
    }

    // Capture incremental output for WS broadcast
    try {
      const capture =
        await Bun.$`tmux capture-pane -t ${session.tmuxName} -p -S -`.quiet();
      const fullText = capture.text();
      const newText = fullText.slice(session._lastCapturedLength);
      if (newText) {
        session._lastCapturedLength = fullText.length;
        session.output.push(newText);
        while (session.output.length > config.outputBufferSize) {
          session.output.shift();
        }
        broadcast(session, { type: "stdout", data: newText });
      }
    } catch {
      // Capture failed -- skip this tick
    }
  }, 2000);

  session._pollTimer = timer;
}

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
    type: session.type,
    status: session.status,
    exitCode: session.exitCode,
    pid: session.proc?.pid ?? null,
    createdAt: session.createdAt.toISOString(),
    endedAt: session.endedAt?.toISOString() || null,
    outputLines: session.output.length,
    wsClients: session.wsClients.size,
  };
}
