# Contributing to monkeyproof

PRs welcome. Here's how to not embarrass yourself (or your species).

## Setup

```bash
git clone https://github.com/rodaddy/monkeyproof.git
cd monkeyproof
bun install
bun run dev  # starts with --watch
```

### Requirements

- [Bun](https://bun.sh) v1.0+
- `tmux` (for testing interactive sessions)

## Development workflow

```bash
# Start the dev server (auto-reloads on change)
bun run dev

# Run tests
bun test

# Spawn a test session
curl -X POST http://localhost:3200/sessions \
  -H "Authorization: Bearer monkeyproof-dev" \
  -H "Content-Type: application/json" \
  -d '{"task": "echo hello world", "command": "echo", "args": ["hello"]}'

# Check health
curl http://localhost:3200/health
```

## Guidelines

- **Bun only.** No npm, no yarn, no pnpm. Bun.
- **TypeScript.** No `any` unless you have a really good excuse.
- **Keep it simple.** This is a process manager, not a framework.
- **Test your changes.** At minimum, spawn a session and verify it streams.
- **One PR, one thing.** Don't bundle unrelated changes.
- **No new dependencies** unless absolutely necessary. The entire server is ~500 lines on Bun + Hono. Keep it that way.

## Architecture

```
src/
  index.ts      -- Hono HTTP server + Bun WebSocket handler
  sessions.ts   -- Session lifecycle (spawn, stream, kill, cleanup)
  config.ts     -- Env config + agent presets
```

### Key concepts

| Concept | Location | Notes |
|---------|----------|-------|
| Auth middleware | `index.ts:27` | Bearer token, skips WS upgrade |
| Print sessions | `sessions.ts:98` | `Bun.spawn` with piped stdio |
| Interactive sessions | `sessions.ts:183` | tmux + `pipe-pane` transcript capture |
| WS broadcast | `sessions.ts:486` | Fans output to all connected clients |
| Session cleanup | `sessions.ts:81` | Periodic timer, removes exited sessions past TTL |
| Presets | `config.ts:18` | Named command + args combos |

### Data flow

```
HTTP/WS request
  -> Auth middleware (Bearer token check)
    -> Hono route handler
      -> Session manager
        -> Subprocess (print) or tmux (interactive)
          -> Output buffer + WS broadcast
```

## Adding presets

Add new agent presets in `src/config.ts`. A preset is a command + default args:

```typescript
"my-agent": {
  command: "my-agent-cli",
  args: ["--some-flag"],
},
```

Both print and interactive modes resolve presets, with interactive mode automatically stripping `--print` flags.

## Adding endpoints

1. Add the route in `src/index.ts`
2. Add any session logic in `src/sessions.ts`
3. Export new functions from `sessions.ts` and import in `index.ts`
4. Update the server banner in `index.ts` if the endpoint is user-facing

## Code style

- Prefer `Bun.$` shell for subprocess commands over `spawn` where appropriate
- Use `Bun.file()` over `node:fs`
- Keep functions small and focused -- the codebase should stay readable in one sitting
- Error handling: return HTTP errors from route handlers, let internal functions throw

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add aider agent preset
fix: handle tmux session cleanup on SIGTERM
docs: update API reference for transcript endpoint
```

## Issues

Found a bug? Open an issue. Include:

1. What you expected
2. What happened
3. Steps to reproduce
4. Your Bun version (`bun --version`)
5. OS and tmux version (if using interactive mode)

## License

MIT. By contributing, you agree your contributions are licensed under MIT.
