#!/usr/bin/env node
// Entry point for the `sitecraft` CLI and for the native messaging host wrapper.
// The built bundle lives in ../dist/cli.js (see `npm run build -w companion`).
import('../dist/cli.js').catch((err) => {
  process.stderr.write(`sitecraft: failed to load dist/cli.js. Run "npm run build -w companion".\n${err?.stack ?? err}\n`);
  process.exit(1);
});
