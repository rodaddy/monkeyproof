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

## Security

MonkeyProof executes commands on the host where it runs. Bind it only on trusted networks, always set a strong `AGENT_WS_TOKEN`, and treat built-in agent presets as privileged because Claude presets include `--permission-mode bypassPermissions` for unattended work. Use direct `exec` with explicit commands when that permission mode is not appropriate.

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
AGENT_WS_TOKEN=YOUR_STRONG_SECRET bun run src/index.ts
```

All HTTP endpoints require bearer authentication:

```bash
-H "Authorization: Bearer YOUR_STRONG_SECRET"
```

## Spawn a direct exec session (default)

`POST /sessions` defaults to direct shell execution (`type: "exec"`). MonkeyProof runs the full `task` with `/bin/sh -lc` unless you pass an explicit `command`/`args`. This is the preferred path for normal automation and maintenance work because MonkeyProof executes the command directly instead of routing through Claude middleware.

```bash
curl -X POST http://localhost:3200/sessions \
  -H "Authorization: Bearer YOUR_STRONG_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "task": "bun test",
    "cwd": "/home/skippy/Development/king/king-dashboard"
  }'
```

You can also be explicit:

```json
{ "type": "exec", "task": "scripts/maintenance --dry-run", "cwd": "/path/to/repo" }
```

`mode` is accepted as a backwards-compatible alias for `type`. Presets are not valid for `exec` sessions; set `type: "print"` or `type: "interactive"` when using `preset`.

## Spawn an agent print session

Claude/Codex print sessions are still supported, but they must be requested explicitly with `type: "print"` (or `mode: "print"`).

```bash
curl -X POST http://localhost:3200/sessions \
  -H "Authorization: Bearer YOUR_STRONG_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "print",
    "task": "Fix the bug in auth.ts",
    "cwd": "/home/skippy/Development/king/king-dashboard",
    "command": "claude",
    "args": ["--print", "--permission-mode", "bypassPermissions"],
    "maxTurns": 50
  }'
```

## Stream output via WebSocket

```javascript
const ws = new WebSocket("ws://localhost:3200/sessions/abc123/ws?token=YOUR_STRONG_SECRET");
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "stdout") process.stdout.write(msg.data);
  if (msg.type === "stderr") process.stderr.write(msg.data);
  if (msg.type === "exit") console.log(`Done: exit ${msg.code}`);
};
// Send stdin
ws.send(JSON.stringify({ type: "stdin", data: "yes\n" }));
```

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PORT` | `3200` | Server port |
| `AGENT_WS_TOKEN` | `CHANGE_ME_AGENT_WS_TOKEN` | Bearer auth token. Replace before exposing the service; the placeholder is intentionally unsafe. |
| `MAX_SESSIONS` | `50` | Max concurrent sessions |
| `OUTPUT_BUFFER_SIZE` | `2000` | Lines of output to buffer per session |
| `SESSION_TTL_MS` | `3600000` | Auto-cleanup exited sessions after (ms) |
| `INTERACTIVE_SESSION_TTL_MS` | `7200000` | Auto-cleanup exited interactive tmux sessions after (ms) |

## Agent Presets

Instead of specifying `command` + `args` every time for print/interactive agent sessions, use presets and set `type`/`mode` explicitly:

```bash
curl -X POST http://localhost:3200/sessions \
  -H "Authorization: Bearer YOUR_STRONG_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"type": "print", "task": "Fix the bug", "cwd": "/path/to/repo", "preset": "claude"}'
```

Built-in presets: `claude`, `claude-sonnet`, `claude-opus`, `claude-interactive`, `claude-interactive-sonnet`, `claude-interactive-opus`, `codex`, `codex-auto`

## License

MIT -- go nuts, monkeys.
