# Sitecraft

Customize any website with plain language. A Chrome extension (Manifest V3) plus a local Node companion that runs the Claude Agent SDK with your Claude Code login. Scripts stay in your browser; the companion opens no network port.

- User and developer guide: [docs/README.md](docs/README.md) (install, onboarding, daily use, dev harness, manual E2E checklist, troubleshooting, privacy)
- Design spec: [docs/superpowers/specs/2026-08-18-sitecraft-design.md](docs/superpowers/specs/2026-08-18-sitecraft-design.md)
- Implementation plan: [docs/superpowers/plans/2026-08-31-sitecraft-implementation.md](docs/superpowers/plans/2026-08-31-sitecraft-implementation.md)

Quick start: `pnpm install && pnpm build`, load `extension/dist` unpacked at `chrome://extensions`, turn on Allow User Scripts for the extension, then run `node companion/bin/sitecraft.js install`.
