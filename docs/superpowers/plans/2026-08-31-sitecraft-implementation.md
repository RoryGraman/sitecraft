# Sitecraft Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Sitecraft v1: a Chrome MV3 extension plus a local Node companion that turns plain-language requests into saved per-site CSS/JS customizations, driven by the Claude Agent SDK.

**Architecture:** Three npm workspaces. `shared/` holds the data model, the message protocol, match-pattern logic, bundle generation, and validators (pure TS, no deps). `extension/` is a Vite + CRXJS MV3 extension: a React side panel (Chat, Manager, Onboarding), a background service worker (storage, native port, `chrome.userScripts` registration, tab reloads), and a content script (CSS at `document_start`, error relay). `companion/` is a Node native-messaging host that runs the Claude Agent SDK with one custom tool, `inspect_page`, and returns structured output.

**Tech Stack:** TypeScript 5.9, npm workspaces, Vite + `@crxjs/vite-plugin`, React 19, Vitest 4 (+ jsdom), `@anthropic-ai/claude-agent-sdk` 0.3.252, zod, esbuild (companion bundle).

**Spec:** `docs/superpowers/specs/2026-08-18-sitecraft-design.md`

## Global Constraints

- Manifest V3. Chrome 120+ for `chrome.userScripts`; Chrome 138+ needs the per-extension "Allow User Scripts" toggle.
- Native messaging host name: `com.sitecraft.companion`. Host manifest `allowed_origins` must contain only this extension's origin.
- The companion opens no network port. It talks only over stdio frames. It must never write anything but frames to stdout. Logs go to `~/.sitecraft/companion.log`.
- All customization data lives in `chrome.storage.local`. No analytics, no remote storage, no accounts.
- One customization = one `SiteScript` record (shape in `shared/src/types.ts`). Storage schema version 1.
- Priority 1 runs first. JS levels await each other. CSS is ordered 1 → 5 inside one style block.
- Every JS script runs in its own try/catch. A crash must not block other scripts and must be surfaced in the Manager.
- New scripts save with `trial: true`. Keep clears the flag. Undo disables the script and reloads the tab. Undone scripts stay in the Manager as disabled.
- Sentences in UI copy: short, plain. No em dashes anywhere in code comments, docs, or UI copy.
- ESM everywhere (`"type": "module"`). Strict TypeScript (see `tsconfig.base.json`).
- Tests: Vitest. Every task adds tests before implementation (TDD). Run `npx vitest run <path>` for a single file.
- Extension ID must be stable: `manifest.key` is set. The ID is derived from it and used by the companion installer and the dev harness.

---

## File Structure

```
chrome-extension/
  package.json                 npm workspaces root; scripts: build, test, typecheck, serve
  tsconfig.base.json
  vitest.workspace.ts          points at the three package vitest configs
  shared/
    package.json               @sitecraft/shared, exports ./src/index.ts (TS source; consumers bundle it)
    src/types.ts               SiteScript, Settings, StoredState, ExportFile, statuses     [DONE]
    src/protocol.ts            Sidebar<->Background and Background<->Companion messages    [DONE]
    src/matchPattern.ts        parseMatchPattern, matchesPattern, patternForUrl
    src/bundle.ts              buildJsBundles, renderJsBundle, buildCssBundle, shortHash
    src/validate.ts            validateAgentOutput, validateSiteScript, parseExportFile
    src/index.ts               re-exports                                                  [DONE]
    test/*.test.ts
  extension/
    package.json
    vite.config.ts             CRXJS + React; extra HTML input: harness/index.html
    manifest.config.ts         defineManifest(...) with key, permissions, side_panel, content_scripts
    tsconfig.json
    vitest.config.ts           environment: jsdom
    src/background/index.ts    entry: wires modules below
    src/background/state.ts    storage load/save/migrate + change notifications
    src/background/native.ts   NativeClient: connectNative, request/response, inspect relay
    src/background/userScripts.ts  registerAll(scripts), isUserScriptsAvailable()
    src/background/runs.ts     run orchestration: snapshot -> companion -> validate -> save -> reload
    src/background/router.ts   handles SidebarRequest over ports (internal + external)
    src/background/css.ts      CSS lookup for a URL + insertCSS fallback
    src/content/index.ts       document_start CSS inject, error relay, cssBlocked report
    src/content/snapshot.ts    function run via scripting.executeScript to take a snapshot
    src/lib/domSnapshot.ts     snapshotDom(root, opts): string (pure DOM logic, jsdom-tested)
    src/lib/bridge.ts          Bridge interface + ExtensionBridge + ExternalBridge
    src/lib/ids.ts             newId() (crypto.randomUUID), nowIso()
    src/sidepanel/index.html
    src/sidepanel/main.tsx
    src/sidepanel/App.tsx      tabs: Chat | Manager, onboarding gate, status bar
    src/sidepanel/Chat.tsx
    src/sidepanel/Manager.tsx
    src/sidepanel/Onboarding.tsx
    src/sidepanel/components/ScriptCard.tsx
    src/sidepanel/components/TabPicker.tsx
    src/sidepanel/styles.css
    harness/index.html         same App, ExternalBridge; served at http://localhost:4173/harness/
    harness/main.tsx
    test/*.test.ts
  companion/
    package.json               name: sitecraft; bin: sitecraft -> bin/sitecraft.js
    tsconfig.json
    vitest.config.ts
    bin/sitecraft.js           #!/usr/bin/env node; imports ../dist/cli.js
    src/cli.ts                 subcommands: host | install | uninstall | doctor
    src/framing.ts             encodeFrame, FrameParser
    src/host.ts                stdio loop: HostInbound -> handlers -> HostOutbound
    src/agent.ts               runAgent(payload, hooks) using the Agent SDK
    src/systemPrompt.ts        buildSystemPrompt(), OUTPUT_SCHEMA
    src/install.ts             writeHostManifest(), removeHostManifest(), paths per browser
    src/log.ts                 file logger
    test/*.test.ts
  fixtures/
    index.html                 E2E fixture page with known elements + CSP meta
    app.js                     adds a delayed element after 500 ms
    style.css
  scripts/
    serve.mjs                  static server: extension/dist on :4173, fixtures on :4174
  docs/
    README.md                  install, onboarding, manual E2E script
```

## Interfaces already defined (read these first)

- `shared/src/types.ts` (SiteScript, AgentScriptOutput, StoredState, Settings, statuses)
- `shared/src/protocol.ts` (SidebarRequest / SidebarEvent / envelopes; HostInbound / HostOutbound; ContentMessage; caps)

Every task below uses those names exactly.

---

### Task 1: Match patterns (`shared/src/matchPattern.ts`)

**Files:**
- Modify: `shared/src/matchPattern.ts` (replace stubs)
- Test: `shared/test/matchPattern.test.ts`

**Interfaces:**
- Produces: `parseMatchPattern(pattern): ParsedMatchPattern | null`, `isValidMatchPattern(pattern): boolean`, `matchesPattern(pattern, url): boolean`, `patternForUrl(url): string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { isValidMatchPattern, matchesPattern, parseMatchPattern, patternForUrl } from '../src/matchPattern';

describe('parseMatchPattern', () => {
  it('parses a host pattern', () => {
    expect(parseMatchPattern('https://www.youtube.com/*')).toEqual({
      scheme: 'https', host: 'www.youtube.com', subdomains: false, port: null, path: '/*', allUrls: false,
    });
  });
  it('parses subdomain wildcard and port', () => {
    expect(parseMatchPattern('*://*.example.com:8080/foo*')).toMatchObject({
      scheme: '*', host: 'example.com', subdomains: true, port: '8080', path: '/foo*',
    });
  });
  it('parses <all_urls>', () => {
    expect(parseMatchPattern('<all_urls>')).toMatchObject({ allUrls: true });
  });
  it('parses file patterns', () => {
    expect(parseMatchPattern('file:///Users/*')).toMatchObject({ scheme: 'file', host: '', path: '/Users/*' });
  });
  it.each(['', 'youtube.com/*', 'https://*foo.com/*', 'https://www.youtube.com', 'ws://a.com/*', 'https://*.com/*', 'https://a.com/*?x=*'])
    ('rejects %s', (p) => { expect(parseMatchPattern(p)).toBeNull(); expect(isValidMatchPattern(p)).toBe(false); });
});

describe('matchesPattern', () => {
  it.each([
    ['https://www.youtube.com/*', 'https://www.youtube.com/watch?v=1', true],
    ['https://www.youtube.com/*', 'https://m.youtube.com/', false],
    ['*://*.youtube.com/*', 'https://m.youtube.com/', true],
    ['*://*.youtube.com/*', 'https://youtube.com/', true],
    ['*://*.youtube.com/*', 'https://notyoutube.com/', false],
    ['*://*/*', 'http://anything.test/x', true],
    ['*://*/*', 'ftp://anything.test/x', false],
    ['<all_urls>', 'file:///tmp/a.html', true],
    ['http://localhost:4174/*', 'http://localhost:4174/index.html', true],
    ['http://localhost/*', 'http://localhost:4174/index.html', true],
    ['http://localhost:4174/*', 'http://localhost:4175/index.html', false],
    ['https://a.com/foo*', 'https://a.com/foobar', true],
    ['https://a.com/foo*', 'https://a.com/fo', false],
    ['https://a.com/*/bar', 'https://a.com/x/y/bar', true],
    ['https://a.com/*', 'https://a.com/', true],
    ['https://a.com/*', 'https://a.com', true],
    ['https://a.com/*', 'https://A.COM/x', true],
    ['https://a.com/*', 'not a url', false],
    ['garbage', 'https://a.com/', false],
  ])('%s vs %s -> %s', (p, u, expected) => { expect(matchesPattern(p, u)).toBe(expected); });
  it('matches query strings as part of the path', () => {
    expect(matchesPattern('https://a.com/watch*', 'https://a.com/watch?v=1')).toBe(true);
    expect(matchesPattern('https://a.com/watch', 'https://a.com/watch?v=1')).toBe(false);
  });
  it('ignores the fragment', () => {
    expect(matchesPattern('https://a.com/page', 'https://a.com/page#top')).toBe(true);
  });
});

describe('patternForUrl', () => {
  it.each([
    ['https://www.youtube.com/watch?v=1', 'https://www.youtube.com/*'],
    ['http://localhost:4174/index.html', 'http://localhost:4174/*'],
    ['file:///Users/x/a.html', 'file:///*'],
    ['chrome://extensions/', null],
    ['about:blank', null],
    ['data:text/html,hi', null],
    ['nonsense', null],
  ])('%s -> %s', (u, expected) => { expect(patternForUrl(u)).toBe(expected); });
});
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run shared/test/matchPattern.test.ts` → FAIL ("not implemented").
- [ ] **Step 3: Implement.** Rules: scheme regex `^(\*|https?|file|ftp)://`; `<all_urls>` special case; host: `*`, `*.host`, or host with labels `[a-z0-9-]+` (case-insensitive), optional `:port` (`\d+` or `*`); path must start with `/`, `*` → `.*` after escaping regex chars, match against `pathname + search` of the URL (fragment dropped). Scheme `*` matches only http and https. Host compare lowercase. `*.example.com` matches `example.com` and any subdomain. When the pattern has no port, any port matches; when it has a port, compare `url.port || default`. `file` patterns: host must be empty. `patternForUrl`: use `new URL()`; allow only http, https, file; return `${protocol}//${host}/*` (host includes port), or `file:///*`.
- [ ] **Step 4: Run tests:** PASS.
- [ ] **Step 5: Commit** `feat(shared): match pattern parsing and matching`

---

### Task 2: Bundles (`shared/src/bundle.ts`)

**Files:**
- Modify: `shared/src/bundle.ts` (replace stubs)
- Test: `shared/test/bundle.test.ts`

**Interfaces:**
- Consumes: `SiteScript` from types.
- Produces: `buildJsBundles(scripts): JsBundle[]`, `renderJsBundle(scripts): string`, `buildCssBundle(scripts): string`, `shortHash(s): string`.

- [ ] **Step 1: Write the failing tests.** Helper `mk(overrides)` builds a `SiteScript` with defaults (`kind: 'js'`, `enabled: true`, `priority: 3`, `urlPattern: 'https://a.com/*'`). Tests:
  1. `shortHash('a')` is 8 lowercase hex chars and deterministic; `shortHash('a') !== shortHash('b')`.
  2. `buildJsBundles` groups by exact urlPattern, skips disabled and css, id = `'sitecraft-' + shortHash(urlPattern)`, `scriptIds` in priority order, output sorted by urlPattern.
  3. `renderJsBundle` output, executed with `new Function('window','document', code)` against a fake `window` (`{ postMessage: vi.fn(), __log: [] }`), where scripts push to `window.__log`:
     - Priority order: scripts at priority 1 (`log('a')`), 3 (`log('c')`), 2 (`log('b')`) produce `['a','b','c']` after awaiting a macrotask (`await new Promise(r => setTimeout(r, 0))`).
     - A level waits for async work: priority-1 script `await new Promise(r=>setTimeout(()=>{window.__log.push('slow'); r()}, 5))` then priority-2 pushes `'after'` → order `['slow','after']`.
     - A throwing script does not block: priority-1 script `throw new Error('boom')` and priority-2 pushes `'ok'` → log contains `'ok'`, and `window.postMessage` called with `{ source: 'sitecraft', type: 'script-error', scriptId: <id>, message: 'boom' }` and `'*'`.
     - A script that returns a rejected promise is caught the same way.
     - Two scripts in the same level both run.
     - The bundle does not leak script code into global scope: a script `var leaked = 1` does not define `window.leaked` (wrap each in its own async function).
  4. `buildCssBundle`: disabled and js ignored; priority 1 first, ties by createdAt asc; each block preceded by `/* sitecraft:<id> <name> */`; returns `''` when empty.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** `renderJsBundle` template (scripts serialized with `JSON.stringify` for id and name; code embedded as the body of `async function () { ... }`, prefixed with `"use strict";` inside each function):

```js
(() => {
  const __report = (id, err) => {
    try { window.postMessage({ source: 'sitecraft', type: 'script-error', scriptId: id, message: String(err && err.message || err) }, '*'); } catch {}
  };
  const __levels = [
    [ { id: "…", run: async function () { "use strict";
        /* user code */
      } }, … ],
    …
  ];
  (async () => {
    for (const level of __levels) {
      await Promise.all(level.map(async (s) => { try { await s.run(); } catch (e) { __report(s.id, e); } }));
    }
  })();
})();
```
  Only include non-empty levels, in order 1..5. `shortHash`: FNV-1a 32-bit over UTF-16 code units, `>>> 0`, `toString(16).padStart(8,'0')`.
- [ ] **Step 4: Run tests:** PASS.
- [ ] **Step 5: Commit** `feat(shared): js/css bundle generation with priority levels`

---

### Task 3: Validators (`shared/src/validate.ts`)

**Files:**
- Modify: `shared/src/validate.ts`
- Test: `shared/test/validate.test.ts`

**Interfaces:**
- Consumes: `isValidMatchPattern` (Task 1).
- Produces: `validateAgentOutput`, `validateSiteScript`, `parseExportFile`.

- [ ] **Step 1: Tests.** `validateAgentOutput` accepts a good object (and trims name/description; coerces `priority: "2"` to 2). Rejects: missing code, `kind: 'html'`, `urlPattern: '<all_urls>'`, `urlPattern: '*://*/*'`, `urlPattern: 'youtube.com'`, priority 0 or 6, name > 60 chars, non-object input, code > 200000 chars. Error strings name the field. `validateSiteScript` accepts a full record, rejects bad `id` (non-string), bad `createdAt` (not parseable date), non-boolean `enabled`. `parseExportFile`: bad JSON → error; wrong `format` → error; mixed valid/invalid scripts → valid ones in `file.scripts`, invalid ids (or index) in `invalid`.
- [ ] **Step 2–4:** Fail, implement (hand-rolled checks, no zod), pass.
- [ ] **Step 5: Commit** `feat(shared): validators for agent output, scripts, export files`

---

### Task 4: Companion framing (`companion/src/framing.ts`)

**Files:**
- Create: `companion/package.json`, `companion/tsconfig.json`, `companion/vitest.config.ts`, `companion/src/framing.ts`
- Test: `companion/test/framing.test.ts`

**Interfaces:**
- Produces: `encodeFrame(message: unknown): Buffer` (4-byte little-endian uint32 length + UTF-8 JSON) and `class FrameParser { push(chunk: Buffer): unknown[] }` (returns zero or more complete decoded messages; buffers partials; throws `FrameTooLargeError` if a declared length exceeds `maxBytes` (default 64 MB)).

- [ ] **Step 1: Tests:** round trip; two frames in one chunk; one frame split across three chunks (including a split inside the 4-byte header); empty object; non-ASCII payload (length counts bytes not chars); oversize length throws.
- [ ] **Step 2–4:** Fail, implement, pass. Native endianness on macOS/x86/arm64 is little-endian; use `readUInt32LE`/`writeUInt32LE`.
- [ ] **Step 5: Commit** `feat(companion): native messaging framing`

`companion/package.json`:
```json
{
  "name": "sitecraft",
  "version": "0.1.0",
  "type": "module",
  "bin": { "sitecraft": "bin/sitecraft.js" },
  "scripts": {
    "build": "esbuild src/cli.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/cli.js --external:@anthropic-ai/claude-agent-sdk --external:zod --banner:js=\"import { createRequire } from 'module'; const require = createRequire(import.meta.url);\"",
    "typecheck": "tsc -p tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": { "@anthropic-ai/claude-agent-sdk": "0.3.252", "zod": "<see Appendix A>" },
  "devDependencies": { "esbuild": "^0.25.0", "@types/node": "^22.0.0" }
}
```

---

### Task 5: Companion agent runner (`companion/src/agent.ts`, `systemPrompt.ts`)

**Files:**
- Create: `companion/src/agent.ts`, `companion/src/systemPrompt.ts`, `companion/src/log.ts`
- Test: `companion/test/agent.test.ts` (mocks `@anthropic-ai/claude-agent-sdk` with `vi.mock`)

**Interfaces:**
- Consumes: `AgentRequest`, `AgentScriptOutput`, `validateAgentOutput`, `INSPECT_MAX_CHARS` from shared.
- Produces:
```ts
export interface AgentHooks {
  onProgress(status: string): void;
  inspectPage(selector: string): Promise<string>; // resolves outerHTML (already capped) or rejects
  signal?: AbortSignal;
}
export interface AgentRunOptions { model?: string; maxTurns?: number; cwd?: string }
export async function runAgent(payload: AgentRequest, hooks: AgentHooks, opts?: AgentRunOptions): Promise<AgentScriptOutput>;
export const OUTPUT_SCHEMA: object; // JSON schema for AgentScriptOutput, additionalProperties: false
export function buildSystemPrompt(): string;
export function buildUserPrompt(payload: AgentRequest): string;
```
- SDK usage: see Appendix A (verbatim types). Requirements: `permissionMode: 'bypassPermissions'`, no built-in tools (only `mcp__sitecraft__inspect_page` allowed), custom `systemPrompt` string, `settingSources: []`, `maxTurns` default 16, `outputFormat` JSON schema, `cwd` = an empty temp dir (`os.tmpdir()/sitecraft-agent`), `abortController` wired to `hooks.signal`.
- Progress mapping: on `system/init` → "Agent started"; on assistant text → first 80 chars; on assistant `tool_use` of inspect_page → `Inspecting <selector>`; before return → "Validating result".
- Result: prefer `structured_output`; fall back to parsing the last fenced JSON block in `result` text; then `validateAgentOutput`. Throw `Error` with a clear message on `is_error`, on missing output, or on validation failure.
- System prompt content (write it in full in `systemPrompt.ts`): role; prefer CSS for hide/restyle; JS only for behavior; robust selectors (ids, data-*, aria, stable classes; never hashed classes); JS must be idempotent, wrapped for SPAs with `MutationObserver` when elements render late, no network, no eval, no external scripts; `urlPattern` must be a valid Chrome match pattern as narrow as the request implies (default `patternForUrl` of the page); priority default 3, 1 for "must run first" setup, 5 for cosmetic last-touch; name ≤ 60 chars; description one sentence; when `targetScript` is set, return the full updated script (same kind unless the request needs a change); use `inspect_page` when the snapshot is missing detail (max ~6 calls); reply only with the structured object.
- User prompt: request text, page URL + title, existing scripts (id, name, kind, pattern, priority, first 400 chars of code), target script (full), then the snapshot in a fenced block.

- [ ] **Step 1: Tests (mocked SDK):**
  1. `runAgent` yields the structured output when the mocked `query` async-iterates `[{type:'system',subtype:'init'},{type:'assistant',message:{content:[{type:'text',text:'Working'}]}},{type:'result',subtype:'success',is_error:false,result:'', structured_output:{...good}}]`; `onProgress` was called with 'Agent started' and 'Working'.
  2. Falls back to parsing a fenced JSON block in `result` when `structured_output` is absent.
  3. Throws when validation fails (`urlPattern: 'nope'`), message includes 'urlPattern'.
  4. Throws when result `is_error`.
  5. The mocked `tool()` handler registered for `inspect_page` calls `hooks.inspectPage(selector)` and returns `{ content: [{ type: 'text', text: html }] }`; on rejection returns an error text result (`is_error: true`).
  6. `query` receives options with `permissionMode: 'bypassPermissions'`, `allowedTools: ['mcp__sitecraft__inspect_page']`, `settingSources: []`, and an `outputFormat` with `OUTPUT_SCHEMA`.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5: Commit** `feat(companion): agent runner with inspect_page tool and structured output`

---

### Task 6: Companion host loop + CLI + installer

**Files:**
- Create: `companion/src/host.ts`, `companion/src/cli.ts`, `companion/src/install.ts`, `companion/bin/sitecraft.js`
- Test: `companion/test/host.test.ts`, `companion/test/install.test.ts`

**Interfaces:**
- `host.ts`: `export function startHost(io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream }, deps: { runAgent: typeof runAgent; version: string }): { stop(): void }`. Behavior:
  - Parse frames with `FrameParser`. Dispatch `HostInbound`:
    - `ping` → `pong` with `companionVersion`, `node: process.version`.
    - `checkAuth` → run a 1-turn query with prompt `Reply with the single word OK.` (no tools, `maxTurns: 1`) → `authResult` ok when result text contains `OK`; `detail` = error message otherwise. Use a 60 s timeout.
    - `run` → call `runAgent` with hooks: `onProgress` → `progress`; `inspectPage(selector)` → send `inspect` (new `requestId` = `crypto.randomUUID()`, `runId` = request id) and await matching `inspectResult` (timeout 20 s → reject). Result → `result` ok/false.
    - `cancel` → abort that run's `AbortController`.
    - `inspectResult` → resolve pending inspect.
  - Every outbound message is checked: if `JSON.stringify` length > `NATIVE_MAX_MESSAGE_BYTES - 1024`, replace with an error `result`/`log` (never send oversize frames).
  - Unknown message types → `log` warn. Malformed JSON → log error, continue.
  - Never write to stdout except through `encodeFrame`.
- `install.ts`:
```ts
export type BrowserId = 'chrome' | 'chrome-beta' | 'chrome-canary' | 'chromium' | 'brave' | 'edge' | 'arc';
export function hostManifestDir(browser: BrowserId, home: string, platform: NodeJS.Platform): string; // macOS + Linux paths; throws on win32 (deferred)
export function buildHostManifest(opts: { extensionId: string; wrapperPath: string }): object;
export function buildWrapperScript(opts: { nodePath: string; cliPath: string }): string; // '#!/bin/sh\nexec "<node>" "<cli>" host "$@"\n'
export async function install(opts: { extensionId: string; browsers: BrowserId[]; home: string; nodePath: string; cliPath: string; platform: NodeJS.Platform }): Promise<{ wrapperPath: string; manifestPaths: string[] }>;
export async function uninstall(opts: { browsers: BrowserId[]; home: string; platform: NodeJS.Platform }): Promise<string[]>;
```
  Wrapper lives at `<home>/.sitecraft/sitecraft-host.sh` (mode 0o755). Manifest name `com.sitecraft.companion.json`. macOS dirs: Chrome `Library/Application Support/Google/Chrome/NativeMessagingHosts`, Chrome Beta `.../Google/Chrome Beta/...`, Canary `.../Google/Chrome Canary/...`, Chromium `.../Chromium/...`, Brave `.../BraveSoftware/Brave-Browser/...`, Edge `.../Microsoft Edge/...`, Arc `.../Arc/User Data/NativeMessagingHosts`. Linux: `~/.config/google-chrome/NativeMessagingHosts`, `~/.config/chromium/...`, `~/.config/BraveSoftware/Brave-Browser/...`, `~/.config/microsoft-edge/...`.
- `cli.ts`: `host` (default when argv[2] is missing or starts with `chrome-extension://`), `install [--extension-id <id>] [--browser <id>,...]` (default id = `DEFAULT_EXTENSION_ID` constant written in `companion/src/extensionId.ts`, default browsers = `chrome`), `uninstall`, `doctor` (prints node version, manifest paths + presence, whether `claude` login works by running the same checkAuth query; exit code 1 on failure).
- `bin/sitecraft.js`: `#!/usr/bin/env node` + `import('../dist/cli.js')`.

- [ ] **Step 1: Tests.** `host.test.ts` with `PassThrough` streams: ping→pong; run→progress+result using a fake `runAgent` that calls `hooks.inspectPage('#x')` and expects the host to emit `inspect` and to resolve when the test writes back `inspectResult`; run error → result ok:false; oversize result replaced by error; garbage bytes do not kill the loop. `install.test.ts` with a temp `home`: files written with correct contents/mode; `uninstall` removes them; `hostManifestDir` paths for each browser.
- [ ] **Step 2–4:** Fail, implement, pass.
- [ ] **Step 5: Commit** `feat(companion): native host loop, CLI, installer`

---

### Task 7: Extension scaffold + manifest + stable ID

**Files:**
- Create: `extension/package.json`, `extension/tsconfig.json`, `extension/vite.config.ts`, `extension/manifest.config.ts`, `extension/vitest.config.ts`, `extension/src/lib/ids.ts`, `extension/src/extensionId.ts`, `companion/src/extensionId.ts`, placeholder entries so `vite build` succeeds.

Manifest (via `defineManifest`):
```ts
{
  manifest_version: 3,
  name: 'Sitecraft',
  version: '0.1.0',
  description: 'Customize any website with plain language.',
  key: '<base64 public key from Appendix A>',
  minimum_chrome_version: '120',
  permissions: ['storage', 'sidePanel', 'userScripts', 'nativeMessaging', 'scripting', 'tabs', 'webNavigation', 'activeTab'],
  host_permissions: ['<all_urls>'],
  background: { service_worker: 'src/background/index.ts', type: 'module' },
  content_scripts: [{ matches: ['<all_urls>'], js: ['src/content/index.ts'], run_at: 'document_start', all_frames: false }],
  side_panel: { default_path: 'src/sidepanel/index.html' },
  action: { default_title: 'Open Sitecraft' },
  externally_connectable: { matches: ['http://localhost:4173/*'] },   // see Appendix A for the allowed form
  icons: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' },
}
```
Generate PNG icons with a tiny Node script (solid color squares are fine).
- [ ] Verify: `npm run build -w extension` produces `extension/dist/manifest.json` with `key` and the content script at document_start. Commit `chore(extension): scaffold, manifest, stable id`.

---

### Task 8: DOM snapshot (`extension/src/lib/domSnapshot.ts`)

**Interfaces:**
- `export interface SnapshotOptions { maxChars?: number /* default SNAPSHOT_MAX_CHARS */; maxRepeatedSiblings?: number /* default 5 */; }`
- `export function snapshotDom(root: Document | Element, opts?: SnapshotOptions): string`
- `export function elementOuterHtml(root: Document, selector: string, maxChars?: number): { ok: true; html: string; count: number } | { ok: false; error: string }`

Rules: clone the tree (never mutate the page); remove `<script>` and `<style>` bodies (keep the tags with attributes but empty), remove comments, drop `<svg>` children (keep the svg tag), strip inline `style` attributes longer than 200 chars, strip `data:` URLs longer than 100 chars, collapse runs of > `maxRepeatedSiblings` consecutive siblings with the same tag AND same class attribute: keep the first `maxRepeatedSiblings` then insert `<!-- sitecraft: N more <tag> siblings collapsed -->`; collapse whitespace text nodes to one space; if the result is still longer than `maxChars`, cut it and append `<!-- sitecraft: truncated -->`.

- [ ] Tests (jsdom): each rule above with a small HTML fixture; `elementOuterHtml` returns count of matches and the first match's outerHTML capped; invalid selector → ok:false.
- [ ] Commit `feat(extension): dom snapshot trimming`

---

### Task 9: Storage state (`extension/src/background/state.ts`)

**Interfaces:**
```ts
export interface StateStore {
  load(): Promise<StoredState>;               // applies migrations, fills defaults
  getScripts(): Promise<SiteScript[]>;
  upsertScript(s: SiteScript): Promise<void>;
  patchScript(id: string, patch: Partial<SiteScript>): Promise<SiteScript>; // sets updatedAt; throws if missing
  deleteScript(id: string): Promise<void>;
  replaceScripts(scripts: SiteScript[]): Promise<void>;
  setError(err: ScriptError): Promise<void>;
  clearError(scriptId: string): Promise<void>;
  getSettings(): Promise<Settings>;
  patchSettings(p: Partial<Settings>): Promise<Settings>;
  onChange(cb: (state: StoredState) => void): () => void;
}
export function createStateStore(area: chrome.storage.StorageArea = chrome.storage.local): StateStore;
export function migrate(raw: Record<string, unknown>): StoredState; // pure
```
Writes are serialized through an internal promise chain. `migrate` handles: empty storage → defaults with `schemaVersion: 1`; missing fields on scripts → filled (`trial:false`, `priority:3`, `enabled:true`); invalid scripts dropped; unknown future version → keep data, do not downgrade.
- [ ] Tests with an in-memory fake `StorageArea` (get/set/remove + onChanged). Commit `feat(extension): storage state with migrations`.

---

### Task 10: userScripts registration (`extension/src/background/userScripts.ts`)

**Interfaces:**
```ts
export function isUserScriptsAvailable(): boolean; // try { return !!chrome.userScripts } catch { return false }
export async function registerAll(scripts: SiteScript[]): Promise<{ registered: number; skipped: boolean }>;
```
`registerAll`: if unavailable → `{registered:0, skipped:true}`. Else `await chrome.userScripts.unregister()` (all), then, if any bundle, `await chrome.userScripts.register(bundles.map(b => ({ id: b.id, matches: [b.urlPattern], js: [{ code: b.code }], world: 'MAIN', runAt: 'document_end', allFrames: false })))`. Call `chrome.userScripts.configureWorld({ messaging: false })` is NOT needed. Handle the error when a pattern is rejected by Chrome: register bundles one by one, record failures as `ScriptError` via the callback `onBundleError(scriptIds, message)` (optional second param).
- [ ] Tests with a fake `chrome.userScripts` on `globalThis.chrome`. Commit.

---

### Task 11: Native client (`extension/src/background/native.ts`)

**Interfaces:**
```ts
export interface NativeClient {
  ping(timeoutMs?: number): Promise<CompanionStatus>;
  checkAuth(timeoutMs?: number): Promise<{ ok: boolean; detail: string }>;
  run(payload: AgentRequest, hooks: { onProgress(status: string): void; inspect(selector: string): Promise<string> }, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<AgentScriptOutput>;
  status(): CompanionStatus;
  onStatus(cb: (s: CompanionStatus) => void): () => void;
  disconnect(): void;
}
export function createNativeClient(hostName: string = NATIVE_HOST_NAME, connect: (name: string) => chrome.runtime.Port = (n) => chrome.runtime.connectNative(n)): NativeClient;
```
Lazy connect on first use. On `onDisconnect`, map `chrome.runtime.lastError?.message` → status: contains "not found" → `not-installed`; "forbidden" → `forbidden`; "exited"/other → `error`; reject all pending requests. Inbound `inspect` → call `hooks.inspect(selector)` for the run with `runId`, reply `inspectResult` (cap html to `INSPECT_MAX_CHARS`). Default run timeout 6 minutes. Do not keep the port open when idle for > 60 s (disconnect; Chrome kills idle SWs anyway).
- [ ] Tests with a fake Port (event emitters). Commit.

---

### Task 12: Runs + CSS + router + background entry

**Files:** `extension/src/background/runs.ts`, `css.ts`, `router.ts`, `index.ts`, `extension/src/content/snapshot.ts`

- `runs.ts`: `createRunManager(deps: { store: StateStore; native: NativeClient; takeSnapshot(tabId): Promise<PageContext>; reloadTab(tabId): Promise<void>; registerAll: typeof registerAll; emit(ev: SidebarEvent): void })` with `start(req: { tabId; text; targetScriptId? }): Promise<RunStarted>` and `cancel(runId)`. Flow per spec §7: snapshot → existing scripts = enabled+disabled scripts whose pattern matches the page URL → `native.run` → `validateAgentOutput` (already done in companion, do it again here) → if targetScriptId: patch that script (keep id, set `trial: true`, `updatedAt`), else create `SiteScript` with `newId()`, `enabled: true`, `trial: true` → `registerAll(all scripts)` → `reloadTab(tabId)` → emit `runDone`. Errors → `runDone` with `ok:false`, nothing saved. `inspect(selector)` hook → `chrome.scripting.executeScript({ target: { tabId }, func: elementOuterHtmlInPage, args: [selector, INSPECT_MAX_CHARS] })`.
- `takeSnapshot(tabId)`: `chrome.scripting.executeScript` with a function that imports nothing (the function is serialized) so `content/snapshot.ts` must export a self-contained `snapshotInPage(maxChars, maxSiblings)` that re-implements the trimming inline OR the content script exposes it via a `chrome.runtime.onMessage` handler `{type:'takeSnapshot'}` → uses `snapshotDom(document)`. Use the content-script message route (keeps one implementation). Fallback to `executeScript` with a minimal inline function when the content script is not present (e.g. tab opened before install).
- `css.ts`: `cssForUrl(scripts, url): string` (filter enabled css whose pattern matches, then `buildCssBundle`) and `installCssFallback(store)` that listens to `chrome.runtime.onMessage` `cssBlocked` and calls `chrome.scripting.insertCSS({ target: { tabId: sender.tab.id }, css })`.
- `router.ts`: `attachPort(port, deps)` implementing every `SidebarRequest`. `getDefaultTab`: for internal ports use `chrome.tabs.query({ active: true, lastFocusedWindow: true })`; for external ports (harness) pick the most recently active tab whose URL is http/https and not the harness origin. `listTabs`: all tabs with http/https/file URLs. `undoScript`: set `enabled:false`, re-register, reload `tabId` if given. `keepScript`: `trial:false`. `exportScripts` → JSON of `ExportFile`. `importScripts` → `parseExportFile`, merge by id (replace), re-register. `checkOnboarding` → `{ userScriptsEnabled: isUserScriptsAvailable(), companion: await native.ping(), claudeLogin: await native.checkAuth() }` (skip checkAuth when companion not connected). Broadcast `stateChanged` to all ports on `store.onChange`.
- `index.ts`: wire everything; `chrome.runtime.onConnect` + `onConnectExternal` → `attachPort`; `onInstalled`/`onStartup` → `registerAll(await store.getScripts())`; `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`; `chrome.runtime.onMessage` for `ContentMessage` (`scriptError` → `store.setError`).
- [ ] Tests: `runs.test.ts` (fake deps: success path creates a trial script, registers, reloads; failure path saves nothing; update path keeps id), `router.test.ts` (keep/undo/toggle/import/export via a fake port). Commit `feat(extension): background run flow, router, css fallback`.

---

### Task 13: Content script (`extension/src/content/index.ts`)

At `document_start`: read `chrome.storage.local` (`scripts`), compute `cssForUrl(scripts, location.href)`; if non-empty, insert `<style id="sitecraft-css">` into `document.documentElement` (head may not exist yet). After insertion check `style.sheet` and `style.sheet.cssRules.length` in a try/catch; if the sheet is null or rules are 0 while css is non-empty → `chrome.runtime.sendMessage({ type: 'cssBlocked', url })`. Listen to `window.addEventListener('message')` for `ScriptErrorPost` from the MAIN world (check `event.source === window` and `data.source === 'sitecraft'`) → `chrome.runtime.sendMessage({ type: 'scriptError', ... })`. Listen to `chrome.runtime.onMessage` `{type:'takeSnapshot', maxChars}` → reply `snapshotDom(document, {maxChars})`, and `{type:'inspect', selector, maxChars}` → `elementOuterHtml(document, selector, maxChars)`. Listen to `chrome.storage.onChanged` to swap the style text live.
- [ ] Tests (jsdom + fake chrome): style inserted with bundle text; error relay forwards; snapshot message answered. Commit.

---

### Task 14: Bridge + Side panel UI + harness

**Files:** `extension/src/lib/bridge.ts`, `extension/src/sidepanel/*`, `extension/harness/*`, `extension/src/sidepanel/styles.css`

- `bridge.ts`:
```ts
export interface Bridge {
  request<R extends SidebarRequest>(req: R): Promise<SidebarResponseFor<R>>;
  onEvent(cb: (ev: SidebarEvent) => void): () => void;
  readonly mode: 'extension' | 'external';
}
export function createBridge(): Bridge; // extension mode when chrome.runtime?.id exists; else external using EXTENSION_ID from src/extensionId.ts and chrome.runtime.connect(EXTENSION_ID, { name: SIDEBAR_PORT_NAME })
```
  Reconnect on port disconnect (service worker restarts) with pending requests rejected.
- `App.tsx`: loads `getState`, runs `checkOnboarding` on mount; shows `Onboarding` until all three checks pass (or `settings.onboardingDone` and companion connected); tab bar Chat | Manager; footer with companion status dot.
- `Chat.tsx`: `TabPicker` (target tab; default from `getDefaultTab`; refresh button), message thread (user/agent/status/error items), textarea + Send (disabled during a run), progress line from `runProgress`, result card with name, description, kind, pattern, **Keep** and **Undo** buttons; a "Modify" action on a result or on a Manager card prefills `targetScriptId` and shows a chip "Modifying: <name>" with a clear button.
- `Manager.tsx`: scripts grouped by host derived from `urlPattern` (sorted); per `ScriptCard`: enabled toggle, priority `<select>` 1..5, edit code (textarea + Save/Cancel), Modify with AI, delete (confirm inline, not `window.confirm`), trial badge, last error block with Clear. Global: Export (opens a new tab with a `data:` URL? No: copy JSON into a textarea modal with "Copy" button and a download link created with `URL.createObjectURL`), Import (textarea paste + file input).
- `Onboarding.tsx`: three rows with live pass/fail: 1) "Allow user scripts" with instructions (open `chrome://extensions`, Details, toggle "Allow User Scripts"; button "Open extension details" that calls `chrome.tabs.create({ url: 'chrome://extensions/?id=' + id })` via the background `reloadTab`-style request; add a `{ type: 'openUrl'; url: string }` request to protocol.ts). 2) Companion install: shows `npx sitecraft install --extension-id <id>` (or the local path command in dev: `node companion/bin/sitecraft.js install`), Retry button. 3) Claude login: status + "Run `claude` in a terminal and log in" hint, Retry. Poll every 2 s while visible. "Continue" enabled when all pass; sets `onboardingDone`.
- `harness/index.html` + `main.tsx`: renders `<App />` with `createBridge()` (external mode); page title "Sitecraft Harness".
- No em dashes in copy. Keep CSS small (system font, 13px, compact).
- [ ] Tests: `bridge.test.ts` (fake chrome.runtime.connect; request/response matching; event dispatch; reconnect). Component smoke tests are optional; the E2E covers the UI. Commit `feat(extension): side panel UI, onboarding, dev harness`.

---

### Task 15: Fixture page, static server, docs

- `fixtures/index.html`: `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'">`, header, `<aside id="promo-banner" class="promo">Promo banner</aside>`, `<section class="shorts-shelf">` with 12 `<article class="short">` items, `<section id="comments">`, `<button id="theme-toggle">`, footer. `fixtures/app.js`: after 500 ms appends `<div id="late-widget" class="promo">Late widget</div>`; logs `window.__sitecraftFixtureReady = true`. `fixtures/style.css`: visible colors.
- `scripts/serve.mjs`: zero-dependency `http` static server; args `--root <dir> --port <n>`; root `npm run serve` starts two servers (extension/dist on 4173 and fixtures on 4174) in one process; correct MIME for html/js/css/json/png; `Cache-Control: no-store`.
- `docs/README.md`: install steps (build, load unpacked, allow user scripts, `sitecraft install`), how the harness works, manual E2E script (spec §11), troubleshooting (native host errors), privacy note.
- [ ] Commit `chore: fixture page, static server, docs`.

---

### Task 16: Integration verification (done by the orchestrator)

1. `npm install`, `npm run typecheck`, `npm test`, `npm run build`.
2. Companion smoke over stdio with the real SDK: `ping`, `checkAuth`, then a `run` against a fixture snapshot with a fake `inspectResult` responder. Confirm a valid `AgentScriptOutput`.
3. `node companion/bin/sitecraft.js install` (writes the Chrome host manifest for the stable extension id).
4. `npm run serve`; user loads `extension/dist` unpacked and enables "Allow User Scripts".
5. Claude in Chrome E2E on `http://localhost:4173/harness/index.html` + `http://localhost:4174/`: onboarding all green; request "Hide the promo banner"; verify hidden after reload; Undo → visible; Keep → trial cleared; Manager toggle/priority/edit/delete; export/import round trip; error surfacing (edit a script to `throw new Error('x')` and reload).

---

## Self-Review

- Spec §2 rejected alternatives: not built (correct). §3 four components: Tasks 7, 10, 12, 13, 14. §4 data model: types.ts + Task 9. §5 execution/priority: Tasks 2, 10, 13, plus errors stored (Task 12/13) and shown (Task 14). §6 companion: Tasks 4–6 (installer, framing, SDK, inspect_page, streaming progress). §7 agent flow steps 1–7: Task 12 + 14 (Keep/Undo, modify requests). §8 UI: Task 14. §9 errors/safety: Tasks 6, 11, 12, 14; allowed_origins in Task 6. §10 layout: matches. §11 testing: unit tests per task; e2e Task 15/16. §12 out of scope: nothing built for those.
- Type names cross-checked: `SiteScript`, `AgentScriptOutput`, `AgentRequest`, `PageContext`, `SidebarRequest`, `SidebarEvent`, `RunOutcome`, `HostInbound`, `HostOutbound`, `ContentMessage`, `StateStore`, `NativeClient`, `Bridge`.
- Added request `{ type: 'openUrl'; url: string }` to protocol.ts (Task 14 needs it).

## Appendix A: Verified API notes

Implementers must follow these verbatim. Verified against installed packages on 2026-08-31.

### A.1 Claude Agent SDK 0.3.252 (`@anthropic-ai/claude-agent-sdk`)

Peer deps: `zod ^4.0.0` (zod 4 is required), `@modelcontextprotocol/sdk ^1.29.0`, `@anthropic-ai/sdk >=0.93.0`. The package ships a native binary per platform in optional deps (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`). No `cli.js`. Do not set `executable`.

```ts
import { query, createSdkMcpServer, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options; }): Query;
// Query extends AsyncGenerator<SDKMessage, void> and has interrupt(): Promise<...>, close(): void

// Options fields we use (all optional):
//   systemPrompt?: string            (a plain string REPLACES the whole system prompt)
//   tools?: string[]                 ([] disables ALL built-in tools; MCP tools are unaffected)
//   allowedTools?: string[]          (auto-allow list; does NOT restrict the tool set)
//   permissionMode?: 'bypassPermissions'
//   allowDangerouslySkipPermissions?: boolean   (doc says required with bypassPermissions; set true)
//   settingSources?: []              ([] = isolation: no user hooks, no user MCP servers, no CLAUDE.md)
//   strictMcpConfig?: boolean        (true = only mcpServers from options)
//   persistSession?: boolean         (false = no writes under ~/.claude/projects)
//   mcpServers?: Record<string, McpServerConfig>
//   outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }
//   maxTurns?: number                (structured output spends ONE EXTRA turn on a StructuredOutput tool call)
//   model?: string                   (set explicitly; default follows user settings and may be 'claude-opus-5[1m]')
//   cwd?: string
//   env?: Record<string,string|undefined>   (REPLACES the child env; when omitted the child inherits process.env)
//   abortController?: AbortController
//   stderr?: (data: string) => void
//   maxBudgetUsd?: number

export declare function createSdkMcpServer(_options: { name: string; version?: string; instructions?: string; tools?: Array<SdkMcpToolDefinition<any>>; timeout?: number }): McpSdkServerConfigWithInstance;
export declare function tool<Schema extends AnyZodRawShape>(_name: string, _description: string, _inputSchema: Schema, _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>, _extras?: {...}): SdkMcpToolDefinition<Schema>;
// inputSchema is a RAW SHAPE: { selector: z.string() }   (NOT z.object(...))
// CallToolResult: { content: [{ type: 'text', text: string }], isError?: boolean }
// The model-facing tool name is `mcp__<key in mcpServers>__<toolName>`. With mcpServers: { sitecraft: server } the name is mcp__sitecraft__inspect_page.
```

Messages (guard `subtype` with `'subtype' in m`; some messages like `rate_limit_event` have none):
```ts
type SDKSystemMessage = { type: 'system'; subtype: 'init'; model: string; tools: string[]; mcp_servers: {name: string; status: string}[]; apiKeySource: string; ... };
type SDKAssistantMessage = { type: 'assistant'; message: BetaMessage /* content: text | thinking | tool_use blocks */; error?: 'authentication_failed' | 'billing_error' | 'rate_limit' | ...; ... };
type SDKResultSuccess = { type: 'result'; subtype: 'success'; is_error: boolean; result: string; structured_output?: unknown; num_turns: number; total_cost_usd: number; errors?: undefined; ... };
type SDKResultError = { type: 'result'; subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'; is_error: boolean; errors: string[]; ... };
```
Facts: `structured_output` is on the success variant only; `result` holds the same JSON as a string. `is_error: true` can occur with subtype `success` (API error text in `result`). Check `is_error` always.

Reference call shape for Task 5:
```ts
const server = createSdkMcpServer({
  name: 'sitecraft',
  tools: [
    tool('inspect_page', 'Return the live outer HTML of the first element matching a CSS selector on the current page. Also returns the match count.',
      { selector: z.string().describe('A CSS selector') },
      async ({ selector }) => {
        try { return { content: [{ type: 'text', text: await hooks.inspectPage(selector) }] }; }
        catch (e) { return { content: [{ type: 'text', text: `inspect_page failed: ${String((e as Error).message ?? e)}` }], isError: true }; }
      }),
  ],
});
const q = query({
  prompt: buildUserPrompt(payload),
  options: {
    systemPrompt: buildSystemPrompt(),
    model: opts.model ?? process.env.SITECRAFT_MODEL ?? 'claude-opus-5',
    tools: [],
    mcpServers: { sitecraft: server },
    allowedTools: ['mcp__sitecraft__inspect_page'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    strictMcpConfig: true,
    persistSession: false,
    outputFormat: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    maxTurns: opts.maxTurns ?? 16,
    cwd: opts.cwd,
    abortController,
    stderr: (d) => log.debug(d),
  },
});
for await (const m of q) { /* progress + collect result */ }
```
Auth: the CLI binary resolves credentials itself. On this machine the claude.ai login (max subscription) is used with no env var; the init message reports `apiKeySource: 'none'`. Do not set `env` (the child must inherit `HOME` and `PATH`).
Measured: an isolated 1-turn "PONG" run costs about $0.002 and 1.3 s. Without `settingSources: []` the user's hooks and MCP servers load and a run costs $0.39.

Smoke scripts that work: `sdk-probe/smoke{,2,3,4}.mjs` (kept in a scratch directory during development).

### A.2 Chrome platform facts (Chrome 152, CRXJS 2.7.1, Vite 8.2)

- CRXJS 2.7.1 peer range includes `vite ^8.0.0`. Verified build with vite 8.2.2 + `@vitejs/plugin-react` 6.1. Do not use `plugin-react-swc`.
- `manifest.config.ts` uses `defineManifest({...})`. Paths are relative to the Vite root and must start with a letter (no `./`). `side_panel.default_path` HTML is picked up automatically. Extra pages go in `build.rollupOptions.input`. `background.type: 'module'` is required. Output: `dist/manifest.json` (service worker rewritten to `service-worker-loader.js`; content script bundled under `assets/`).
- `chrome.userScripts`: Chrome 120+; permission `userScripts` + host permissions for matched sites. Chrome 138+ requires the per-extension "Allow User Scripts" toggle at `chrome://extensions/?id=<id>`. Detection (verbatim from docs):
  ```js
  function isUserScriptsAvailable() { try { chrome.userScripts.getScripts(); return true; } catch { return false; } }
  ```
  `register([{ id, matches, js: [{ code }], world: 'MAIN' | 'USER_SCRIPT', runAt, allFrames }])`; also `update`, `unregister({ids?})`, `getScripts({ids?})`. All return promises. Default world is `USER_SCRIPT`; we use `'MAIN'`. Registered scripts persist across browser restarts but are cleared on extension update: re-register in `runtime.onInstalled`. Safe pattern: `getScripts()` then `update()` existing ids and `register()` new ids, or `unregister()` all then `register()` all.
- `chrome.sidePanel`: `setPanelBehavior({ openPanelOnActionClick: true })`. `open({ tabId | windowId })` needs a user gesture and must be called synchronously (no `await` before it).
- Native messaging (macOS): host manifest fields `name, description, path, type: 'stdio', allowed_origins`. User-level dir for Google Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json`. Path must be absolute and executable; a `#!/bin/sh` wrapper that `exec`s node is standard. Chrome passes the caller origin as `argv[1]` (`chrome-extension://<id>/`). The host starts with cwd = the wrapper's directory. Framing: 4-byte native-endian (little-endian here) uint32 length + UTF-8 JSON. Limits: 1 MB per message host→extension; 64 MiB extension→host. Disconnect error strings (read `chrome.runtime.lastError.message` in `port.onDisconnect`): "Specified native messaging host not found.", "Access to the specified native messaging host is forbidden.", "Native host has exited.", "Failed to start native messaging host.", "Error when communicating with the native messaging host." Write debug output to stderr or a file, never stdout.
- Stable ID: `manifest.key` = base64 DER public key; ID = first 32 hex chars of SHA-256(DER) mapped `0-f` → `a-p`. Values in `shared/src/extension.ts`: ID `hoadedohbfjjmkajibiafgoajoicjdba`.
- `externally_connectable.matches`: `['http://localhost/*', 'http://127.0.0.1/*']` (no port = all ports). Web page side: `chrome.runtime.connect(EXTENSION_ID, { name })`; `chrome.runtime` exists on the page only when its URL matches. Extension side: `chrome.runtime.onConnectExternal` (check `port.sender?.origin`). The extension cannot initiate a channel to a page.
- `chrome.scripting.executeScript({ target: { tabId }, func, args, world? })` → `[{ result }]`. `func` is serialized (no closures). Default world ISOLATED shares the DOM; `outerHTML` works there. `chrome.tabs.reload(tabId)` returns a promise.
- `@types/chrome` 0.2.7 types `chrome.userScripts` (incl. `execute`), `sidePanel.open`, `setPanelBehavior`.
- Vitest 4.1 + `jsdom` 30 for extension tests (`test.environment: 'jsdom'`). Known npm 10.9.2 bug installing vitest@4 in some trees ("Cannot read properties of null (reading 'edgesOut')"); pnpm works if npm fails.
