# Contributing to monkeyproof

PRs welcome. Here's how to not embarrass yourself (or your species).

## Setup

```bash
git clone https://github.com/rodaddy/monkeyproof.git
cd monkeyproof
bun install
bun run dev  # starts with --watch
```

## Guidelines

- **Bun only.** No npm, no yarn, no pnpm. Bun.
- **TypeScript.** No `any` unless you have a really good excuse.
- **Keep it simple.** This is a process manager, not a framework.
- **Test your changes.** At minimum, spawn a session and verify it streams.
- **One PR, one thing.** Don't bundle unrelated changes.

## Architecture

```
src/
  index.ts      -- Hono HTTP server + Bun WebSocket handler
  sessions.ts   -- Session lifecycle (spawn, stream, kill, cleanup)
  config.ts     -- Env config + agent presets
```

The whole thing is ~400 lines. Read it before contributing.

## Adding Presets

Add new agent presets in `src/config.ts`. A preset is just a command + default args:

```typescript
"my-agent": {
  command: "my-agent-cli",
  args: ["--some-flag"],
},
```

## Issues

Found a bug? Open an issue. Include:
1. What you expected
2. What happened
3. Steps to reproduce
4. Your Bun version (`bun --version`)

## License

MIT. Go nuts.
