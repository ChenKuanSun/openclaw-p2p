# Contributing to openclaw-p2p

Thank you for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/openclaw/openclaw-p2p.git
cd openclaw-p2p/plugin
npm install
npm run build
npm test
```

### Prerequisites

- Node.js 20+
- npm 10+

### Useful Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript |
| `npm run dev` | Watch mode (rebuild on change) |
| `npm test` | Run unit tests |
| `npm run test:watch` | Watch mode tests |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

## Code Standards

- **TypeScript strict mode** — no `any` types, no type assertions without justification
- **ES modules** — use `.js` extensions in imports (TypeScript resolves them)
- **Formatting** — Prettier handles all formatting; run `npm run format` before committing
- **Linting** — ESLint enforces code quality; `npm run lint` must pass
- **Tests** — new features require tests; bug fixes should include a regression test

## Making Changes

### 1. Create a branch

```bash
git checkout -b feat/your-feature   # or fix/your-bugfix
```

### 2. Make your changes

- Keep commits focused and atomic
- Follow existing code patterns (check nearby files)
- Add tests for new functionality

### 3. Verify locally

```bash
npm run build   # Must compile cleanly
npm test        # All tests must pass
npm run lint    # No lint errors
```

### 4. Submit a pull request

- Write a clear PR title (e.g., "Add relay health monitoring")
- Describe **what** changed and **why**
- Link related issues if applicable
- Ensure CI passes before requesting review

## Pull Request Guidelines

- PRs should be focused on a single concern
- Keep diffs small — large PRs are harder to review
- Avoid unrelated formatting changes in the same PR
- Rebase on `main` before merging (no merge commits)

## Reporting Issues

- Use the [issue templates](.github/ISSUE_TEMPLATE/) when possible
- Include steps to reproduce for bug reports
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## Project Architecture

```
plugin/src/
  index.ts          — IPC server + CLI dispatcher
  nostr-client.ts   — Nostr transport (SimplePool + NIP-04)
  discovery.ts      — Agent announcement + query (kind 30078)
  call-state.ts     — Call state machine
  identity.ts       — Keypair generation + persistence
  types.ts          — Shared TypeScript interfaces
```

Key design decisions:

- **Single dependency** — only `nostr-tools` in production
- **NIP-04 encrypted DMs** for all agent-to-agent communication
- **Kind 30078** replaceable events for agent discovery
- **IPC over HTTP** on localhost for plugin-to-bot communication

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
