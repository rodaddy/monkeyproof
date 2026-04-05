# 🐒 monkeyproof

> Because letting the monkeys ssh into prod is how civilizations end.

Remote coding agent orchestration server. Spawn, stream, and interact with AI coding sessions via REST + WebSocket.

## What

A lightweight process manager that lets an AI orchestrator (or you, monkey) spawn coding agent sessions on a remote box and interact with them in real-time via WebSocket.

**Not** a chatbot UI. **Not** a Claude Code wrapper. This is infrastructure -- a clean API for spawning, monitoring, and controlling CLI-based coding agents from anywhere on your network.

## Why

- Your orchestrator AI lives on a laptop with 8GB RAM
- Your coding agents need 16GB+ and hours of runtime
- You need real-time output streaming, not polling SSH sessions
- You want to track sessions, replay output, and kill runaway agents
- You're tired of `nohup claude --print ... &` and `tail -f /tmp/agent.log`

## Stack

- **Runtime:** Bun
- **HTTP:** Hono
- **Transport:** WebSocket (native Bun)
- **Auth:** Bearer token
- **Storage:** In-memory (sessions are ephemeral)

## API

```
POST   /sessions              Spawn a new coding session
GET    /sessions              List all sessions
GET    /sessions/:id          Session detail + recent output
DELETE /sessions/:id          Kill a session
POST   /sessions/:id/input    Send stdin to a running session

WS     /sessions/:id/ws       Real-time output stream + input
```

## Quick Start

```bash
bun install
AGENT_WS_TOKEN=your-secret-token bun run src/index.ts
```

## Spawn a session

```bash
curl -X POST http://localhost:3200/sessions \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "Fix the bug in auth.ts",
    "cwd": "/home/skippy/Development/king/king-dashboard",
    "command": "claude",
    "args": ["--print", "--permission-mode", "bypassPermissions"],
    "maxTurns": 50
  }'
```

## Stream output via WebSocket

```javascript
const ws = new WebSocket("ws://localhost:3200/sessions/abc123/ws?token=your-secret-token");
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "stdout") process.stdout.write(msg.data);
  if (msg.type === "exit") console.log(`Done: exit ${msg.code}`);
};
// Send stdin
ws.send(JSON.stringify({ type: "stdin", data: "yes\n" }));
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3200` | Server port |
| `AGENT_WS_TOKEN` | `monkeyproof-dev` | Bearer auth token |
| `MAX_SESSIONS` | `10` | Max concurrent sessions |
| `OUTPUT_BUFFER_SIZE` | `2000` | Lines of output to buffer per session |
| `SESSION_TTL_MS` | `3600000` | Auto-cleanup exited sessions after (ms) |

## Agent Presets

Instead of specifying `command` + `args` every time, use presets:

```bash
curl -X POST http://localhost:3200/sessions \
  -H "Authorization: Bearer your-secret-token" \
  -d '{"task": "Fix the bug", "cwd": "/path/to/repo", "preset": "claude"}'
```

Built-in presets: `claude`, `claude-sonnet`, `codex`, `codex-auto`

## License

MIT -- go nuts, monkeys.
