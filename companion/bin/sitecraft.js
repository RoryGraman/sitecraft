#!/usr/bin/env node
// Entry point for the `sitecraft` CLI and for the native messaging host wrapper.
// The built bundle lives in ../dist/cli.js (see `pnpm build`).
import('../dist/cli.js').catch((err) => {
  process.stderr.write(`sitecraft: failed to load dist/cli.js. Run "pnpm build".\n${err?.stack ?? err}\n`);
  process.exit(1);
});
