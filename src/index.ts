/**
 * @module monkeyproof
 * @description Remote coding agent orchestration server.
 * Spawn, stream, and interact with AI coding sessions via REST + WebSocket.
 */

import { Hono } from "hono";
import { config } from "./config";
import {
  createSession,
  createInteractiveSession,
  listSessions,
  getSession,
  killSession,
  sendInput,
  readTranscript,
  addWsClient,
  removeWsClient,
  sessionExists,
} from "./sessions";

const app = new Hono();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
app.use("*", async (c, next) => {
  // Skip auth for WS upgrade (handled in Bun.serve)
  if (c.req.header("upgrade") === "websocket") return next();

  const auth = c.req.header("authorization");
  if (auth !== `Bearer ${config.authToken}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/", (c) => {
  return c.json({
    name: "monkeyproof",
    version: "0.1.0",
    status: "operational",
    message: "Because letting the monkeys ssh into prod is how civilizations end.",
  });
});

app.get("/health", (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// POST /sessions -- spawn a new session
// Body: { task, mode?: "print" | "interactive", ...SessionCreateOpts }
// ---------------------------------------------------------------------------
app.post("/sessions", async (c) => {
  try {
    const body = await c.req.json<{ task: string; mode?: string } & Record<string, unknown>>();
    if (!body.task) {
      return c.json({ error: "task is required" }, 400);
    }

    const mode = body.mode ?? "print";
    if (mode !== "print" && mode !== "interactive") {
      return c.json({ error: 'mode must be "print" or "interactive"' }, 400);
    }

    const session =
      mode === "interactive"
        ? await createInteractiveSession(body as any)
        : createSession(body as any);

    return c.json(session, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// GET /sessions -- list all sessions
// ---------------------------------------------------------------------------
app.get("/sessions", (c) => {
  return c.json(listSessions());
});

// ---------------------------------------------------------------------------
// GET /sessions/:id -- session detail with recent output
// ---------------------------------------------------------------------------
app.get("/sessions/:id", async (c) => {
  const session = await getSession(c.req.param("id"));
  if (!session) return c.json({ error: "Not found" }, 404);
  return c.json(session);
});

// ---------------------------------------------------------------------------
// DELETE /sessions/:id -- kill a session
// ---------------------------------------------------------------------------
app.delete("/sessions/:id", (c) => {
  const killed = killSession(c.req.param("id"));
  if (!killed) return c.json({ error: "Not found" }, 404);
  return c.json({ killed: true });
});

// ---------------------------------------------------------------------------
// POST /sessions/:id/input -- send input (stdin or tmux send-keys)
// ---------------------------------------------------------------------------
app.post("/sessions/:id/input", async (c) => {
  const body = await c.req.json<{ input: string }>();
  if (!body.input) return c.json({ error: "input is required" }, 400);

  const sent = await sendInput(c.req.param("id"), body.input);
  if (!sent) return c.json({ error: "Session not found or not running" }, 400);
  return c.json({ sent: true });
});

// ---------------------------------------------------------------------------
// GET /sessions/:id/transcript -- read transcript file (interactive only)
// Query: ?since=<byte-offset>  (omit for full transcript)
// ---------------------------------------------------------------------------
app.get("/sessions/:id/transcript", async (c) => {
  const sinceParam = c.req.query("since");
  const since = sinceParam !== undefined ? parseInt(sinceParam, 10) : undefined;

  const text = await readTranscript(c.req.param("id"), since);
  if (text === null) {
    return c.json(
      { error: "Not found or session has no transcript (print-mode sessions do not produce transcripts)" },
      404
    );
  }

  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-transcript-length": String(text.length),
    },
  });
});

// ---------------------------------------------------------------------------
// Bun.serve with WebSocket support
// ---------------------------------------------------------------------------

const banner = `
  monkeyproof v0.1.0
  ──────────────────────────────────────────────
  Port:     ${config.port}
  Max:      ${config.maxSessions} sessions
  Buffer:   ${config.outputBufferSize} lines
  TTL:      ${config.sessionTtlMs / 1000}s
  Int TTL:  ${config.interactiveSessionTtlMs / 1000}s
  ──────────────────────────────────────────────
  POST   /sessions                → spawn
  GET    /sessions                → list
  GET    /sessions/:id            → detail
  DELETE /sessions/:id            → kill
  POST   /sessions/:id/input      → send input
  GET    /sessions/:id/transcript → transcript (interactive)
  WS     /sessions/:id/ws         → stream
  ──────────────────────────────────────────────
  Modes: print (default) | interactive (tmux)
`;

console.log(banner);

Bun.serve({
  port: config.port,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade for /sessions/:id/ws
    const wsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/ws$/);
    if (wsMatch && req.headers.get("upgrade") === "websocket") {
      const sessionId = wsMatch[1]!;

      if (!sessionExists(sessionId)) {
        return new Response("Session not found", { status: 404 });
      }

      const token = url.searchParams.get("token");
      if (token !== config.authToken) {
        return new Response("Unauthorized", { status: 401 });
      }

      const success = server.upgrade(req, { data: { sessionId } } as any);
      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Regular HTTP -- delegate to Hono
    return app.fetch(req);
  },
  websocket: {
    open(ws: any) {
      const sessionId = ws.data?.sessionId;
      if (sessionId) {
        addWsClient(sessionId, ws);
      }
    },
    message(ws: any, message: string) {
      const sessionId = ws.data?.sessionId;
      if (!sessionId) return;

      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "stdin" && parsed.data) {
          sendInput(sessionId, parsed.data);
        }
      } catch {
        // Invalid JSON -- ignore
      }
    },
    close(ws: any) {
      const sessionId = ws.data?.sessionId;
      if (sessionId) {
        removeWsClient(sessionId, ws);
      }
    },
  },
});
