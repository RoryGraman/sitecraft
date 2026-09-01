# Sitecraft v1: Adversarial Review Summary

Date: 2026-09-01
Method: six review lenses (Chrome API, companion, security, spec compliance, UI, shared logic) produced 36 findings. Each finding got three independent refuters. 25 findings survived a majority vote. 11 were refuted.

## Fixed

| Id | Severity | Finding | Fix |
|---|---|---|---|
| SEC-1, spec:F1, chrome-api:F2 | high | Any localhost page could drive the extension through `externally_connectable`. | The key is emitted only by `pnpm build:harness` (Vite mode `harness` or `SITECRAFT_HARNESS=1`). Production builds have no `externally_connectable`. The harness build is named "Sitecraft (harness build)". |
| SEC-2 | high | The agent's `urlPattern` was never checked against the page. A prompt-injected page could install a script on another site. | `runs.ts` refuses a pattern that does not match the run's page URL. Nothing is saved. Test added. |
| spec:F2, UI-1 | high | The onboarding gate unmounted Chat, losing the thread and the in-flight run after a service worker restart. | Chat and Manager stay mounted and are hidden while setup shows. Test updated. |
| spec:F4, UI-3 | medium | Every panel open ran the paid Claude login check and blocked the UI on it. | `checkOnboarding` has a `quick` flag that skips the login check unless a fresh success is cached. Returning users see the app at once. The full check runs only in the setup view. |
| chrome-api:F1 | medium | Overlapping `registerAll` calls interleaved unregister-all with registers. | Calls are serialized through a promise queue. Test added. |
| SEC-3 | medium | The prompt never said page content is untrusted. | Rule 0 (trust boundary) added. Snapshot and `inspect_page` results are labeled as untrusted data. |
| SEC-5 | medium | Any page could forge `script-error` posts. | The content script forwards errors only for enabled JS scripts that run on the page, with a cap of 25 per page load. Tests added. |
| spec:F3, shared:F1 | medium | A syntax error in one JS script broke every JS script sharing its pattern. | The companion compile-checks agent JS (`vm.Script`) and rejects the run with a clear error. Manual edits are not checked (see Deferred). |
| shared:F2, chrome-api:F3 | low/medium | `*://host:8080/*` was accepted but Chrome rejects it. | The parser rejects a numeric port on the `*` scheme. Test updated. |
| C2 | medium | The wrapper pinned node's real path (a Homebrew Cellar dir). | `install` pins the PATH entry that resolves to the same binary (for example `/opt/homebrew/bin/node`). `doctor` checks the node and CLI paths inside the wrapper. |
| C4 | low | `doctor` printed FAIL for browsers that are not installed. | Without `--browser`, only browsers with a profile directory are checked. |
| C5 | low | `doctor` ignored `~/.sitecraft/config.json`. | `doctor` reads the config and uses its model for the login check. |
| SEC-4 | low | `toggleScript`, `setPriority`, `keepScript` persisted unvalidated values. | `toggleScript` requires a boolean, `setPriority` goes through `validateSiteScript`, both check the script exists. |
| SEC-8 | low | The wrapper interpolated paths into `sh` without escaping. | Paths are quoted for `/bin/sh`. Test added. |
| UI-4 | low | `runDone` cleared whichever Modify chip was current. | The chip is cleared only when it belongs to the finished run. |
| UI-5 | low | Undo showed an error when the run's tab was closed. | The reload failure is logged, not shown. The script is disabled either way. |
| spec:F5 | low | The prompt implied page-wide level ordering. | The prompt now says levels wait for each other only among scripts that share a pattern. |

## Deferred

| Id | Severity | Finding | Reason |
|---|---|---|---|
| shared:F5 | low | The `insertCSS` fallback never removes CSS. | Three refuters showed the fallback cannot trigger in MV3: a content-script `<style>` is checked against the extension's isolated-world CSP, not the page's. The `<style>` path removes and updates live. |
| shared:F6 | low | A newer `schemaVersion` is kept in name only; a later write persists field-stripped records. | Needs a design decision (read-only mode for newer schemas). Low risk in v1: there is no newer schema. |
| shared:F1 (rest) | medium | A manually edited JS script with a syntax error still disables the other JS scripts on the same pattern. | The extension cannot compile-check under its CSP. Fix needs one registered user script per SiteScript plus a page-side level coordinator. Planned for v1.1. |

## Refuted (examples)

- `insertCSS` fallback accumulates CSS on CSP-blocked pages: unreachable in MV3 (see shared:F5).
- Several style and naming opinions with no wrong behavior.

## Verification after fixes

- `pnpm typecheck`: clean.
- `pnpm test`: 21 files, 652 tests, all pass.
- `pnpm build` and `pnpm build:harness`: both produce a valid manifest. Only the harness build contains `externally_connectable`.
