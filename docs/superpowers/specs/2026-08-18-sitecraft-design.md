# Sitecraft: Design Specification

> Historical record from the initial build (August 2026). Details may be out of date. [README.md](../../../README.md) and [docs/README.md](../../README.md) are the current source of truth.

Date: 2026-08-18
Status: Approved design, pre-implementation
Working name: Sitecraft (subject to change)

## 1. Product statement

Sitecraft is a Chrome extension. It is a website customizer that you control with plain language. You open a sidebar on any page. You type a request, such as "hide Shorts on YouTube". A Claude agent reads the page and writes a small script or style rule. The extension saves the script on your machine. The script runs on every future visit to matching pages.

All customization data stays local to the browser. The only outside traffic is the Claude API call, made through your existing Claude Code subscription.

## 2. Architecture

The system has two parts.

1. **Chrome extension** (Manifest V3). Owns the UI, the storage, and script execution.
2. **Companion app** (Node, local). Owns the AI. Runs the Claude Agent SDK, which reuses the Claude Code login on this machine.

Chrome starts the companion on demand through native messaging. The user never runs a terminal command after install. The companion opens no network port. It accepts messages only from this extension's ID.

Rejected alternatives:

- Agent loop inside the extension with a credential proxy. Rejected: fragile credential handling, terms-of-service gray area.
- Companion shells out to the `claude` CLI. Rejected: slow, poor streaming, weak tool control.
- Direct API key mode. Deferred: possible later as a fallback setting.

## 3. Extension components

- **Sidebar panel** (`chrome.sidePanel`). Two tabs: Chat and Manager.
- **Background service worker.** Owns storage, the native messaging port, user-script registration, and tab reloads.
- **Content script.** Runs at `document_start`. Injects saved CSS for the current URL before first paint.
- **User-script engine.** The `chrome.userScripts` API executes saved JS bundles in the page's MAIN world. This API runs stored code even on sites with strict content security policies. Requirement: the user must enable the "Allow user scripts" toggle for the extension one time. Onboarding must detect and explain this.

## 4. Data model

One customization = one record in `chrome.storage.local`.

```ts
interface SiteScript {
  id: string;            // uuid
  name: string;          // short label, agent-written
  description: string;   // one sentence, agent-written
  urlPattern: string;    // Chrome match pattern, e.g. https://www.youtube.com/*
  kind: 'css' | 'js';
  priority: 1 | 2 | 3 | 4 | 5;   // 1 runs first
  code: string;
  enabled: boolean;
  trial: boolean;        // true until the user clicks Keep
  createdAt: string;     // ISO date
  updatedAt: string;     // ISO date
}
```

Storage also holds settings (onboarding state, companion status) and a schema version for migrations. Export and import of all scripts to a JSON file is a v1 feature.

## 5. Execution and the priority hierarchy

- CSS scripts: the content script collects all enabled CSS records that match the URL. It injects them in one `<style>` element at `document_start`. CSS is outside the await queue because it cannot await. The priority field still orders the rules inside the style element: priority 1 first, so later (higher-number) rules win on equal specificity.
- JS scripts: the background generates one bundle per distinct URL pattern set. The bundle groups scripts by priority and awaits each level:

```js
(async () => {
  await runLevel(1);  // all priority-1 scripts, in parallel
  await runLevel(2);
  // ... through level 5
})();
```

- Each script runs inside a try/catch wrapper. A crash in one script logs an error and does not block the rest.
- The background regenerates and re-registers bundles whenever a script is added, edited, toggled, or deleted.
- Errors from page-load execution are stored and shown in the Manager next to the failing script.

## 6. Companion app

- Node + TypeScript. Distributed with an installer command (for example `npx sitecraft install`). The installer writes the native messaging host manifest into the Chrome profile and registers the launch path.
- Speaks the Chrome native messaging protocol (4-byte length framing over stdio).
- Uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). The SDK resolves auth from the local Claude Code login, so usage bills to the user's subscription.
- Exposes one custom agent tool: `inspect_page(selector)`. The tool round-trips over the open native messaging port to the extension, which returns the live outer HTML for that selector from the active tab. This keeps large pages affordable and accurate.
- Streams progress events back to the sidebar (agent status text, then the final result).

## 7. Agent flow

1. User types a request in the Chat tab.
2. Extension captures: page URL, page title, a trimmed DOM snapshot (script bodies removed, style bodies removed, long repeated siblings collapsed, size-capped), and the site's existing scripts.
3. Extension sends this payload to the companion.
4. Companion runs the agent. System prompt requires structured output: `{ name, description, kind, urlPattern, priority, code }`. The agent may call `inspect_page` to see live details.
5. Extension validates the result shape, saves the record with `trial: true`, regenerates bundles, and reloads the tab.
6. Sidebar shows the result summary with **Keep** and **Undo** buttons. Keep clears the trial flag. Undo disables the script and reloads the tab. The undone script stays in the Manager as disabled, so the user can inspect or delete it.
7. Modification requests ("make the hiding also apply on the homepage") send the existing script in the payload. The agent returns an updated record with the same id.

## 8. Sidebar UI

- **Chat tab:** message thread, request box, per-result Keep/Undo controls, companion status indicator.
- **Manager tab:** scripts grouped by site. Per script: enable toggle, priority selector, edit code, delete, last error (if any). Global: export JSON, import JSON.
- **Onboarding:** first-run checklist. 1) Enable the user-scripts toggle. 2) Install the companion. 3) Confirm the Claude Code login works. Each step shows live pass/fail status.

## 9. Errors and safety

- Companion not installed or not reachable: sidebar shows install steps and a retry button.
- Agent error or malformed output: sidebar shows the error. Nothing is saved.
- Script runtime crash: caught per script, logged, surfaced in the Manager.
- The companion accepts connections only from the extension's ID (enforced by the native messaging host manifest).
- No analytics, no remote storage, no accounts. Page snapshots go only to the Anthropic API through the companion.

## 10. Project layout

```
chrome-extension/
  extension/   TypeScript, Vite (CRXJS), Manifest V3
  companion/   TypeScript, Node, Claude Agent SDK
  shared/      message protocol types, SiteScript type
  docs/
```

## 11. Testing

- Unit tests (Vitest): URL pattern matching, bundle generation and priority ordering, DOM trimming, native messaging framing, storage migrations.
- Companion tests run against a mocked Agent SDK.
- End-to-end: a local fixture page with known elements. Manual script: install unpacked extension, run a request, verify hide/undo/keep, reload, verify persistence.

## 12. Out of scope for v1 (deferred)

- Live page control by the agent (clicking, typing) during a chat turn.
- API-key fallback mode.
- Script sharing or sync between machines.
- Firefox or Safari ports.
- Automatic self-repair when a site redesign breaks a script.
