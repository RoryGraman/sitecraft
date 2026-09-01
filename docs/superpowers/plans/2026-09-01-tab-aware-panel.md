# Tab-aware side panel: design note

Date: 2026-09-01. Status: done.

## Goal

The side panel follows the active tab of its window. Chat targets that tab.
Manager lists only the scripts that match that tab's URL, with a switch to
see every site. The panel updates when the user switches tabs or navigates.

## Contract (already in `shared/src/protocol.ts`)

Requests:

- `{ type: 'getActiveTab'; windowId?: number }` returns `TabInfo | null`.
  With `windowId`, the active tab of that window. Without it, the active tab
  of the last focused window. Null when that tab is not http, https or file.
- `{ type: 'devReload' }` returns `SidebarState` after calling
  `chrome.runtime.reload()`. Only harness builds wire it. Production builds
  throw "Not available in this build."

Event:

- `{ type: 'activeTabChanged'; windowId: number; tab: TabInfo | null; reason: ActiveTabReason }`
  with `ActiveTabReason = 'activated' | 'updated' | 'sync'`.
  Sent when the active tab of a window changes (`tabs.onActivated`, reason
  `activated`), or when the active tab's URL, title, or load status changes
  (`tabs.onUpdated`, reason `updated`). Broadcast to every port. Each panel
  keeps only events for its window.
  Also sent to a side panel port when it attaches: one event per window with
  reason `sync`. A panel that reconnects after a service worker restart missed
  any broadcast in between, so this snapshot brings it up to date. Harness
  ports get no snapshot; they pick their own target.

## Background (owner: background agent)

New module `extension/src/background/tabs.ts`:

```ts
export interface TabWatchApi {
  onActivated: { addListener(l: (info: chrome.tabs.OnActivatedInfo) => void): void; removeListener(l: ...): void };
  onUpdated: { addListener(l: (tabId: number, change: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void): void; removeListener(l: ...): void };
  get(tabId: number): Promise<chrome.tabs.Tab>;
}
export interface ActiveTabChange { windowId: number; tab: TabInfo | null; reason: 'activated' | 'updated' }
export function createTabWatcher(api: TabWatchApi, emit: (change: ActiveTabChange) => void): { dispose(): void };
export function toActiveTab(tab: chrome.tabs.Tab): TabInfo | null;   // null when not a web tab
```

Rules:

- `onActivated({ tabId, windowId })`: `get(tabId)`, then emit
  `{ windowId, tab: toActiveTab(tab), reason: 'activated' }`. Use
  `tab.url || tab.pendingUrl`. A failed `get` (tab closed) emits
  `{ windowId, tab: null, reason: 'activated' }`.
- `onUpdated(tabId, change, tab)`: only when `tab.active` is true and
  `change.url`, `change.title`, or `change.status === 'complete'` is set.
  Emit `{ windowId: tab.windowId, tab: toActiveTab(tab), reason: 'updated' }`.
- Router: `getActiveTab` queries `{ active: true, windowId }` or
  `{ active: true, lastFocusedWindow: true }` and maps with the same web-tab
  rule as `getDefaultTab`. `devReload` calls `deps.devReload` when present,
  else throws.
- Router `attachPort` with kind `internal`: after the port is added, run
  `tabs.query({ active: true })` and post one `activeTabChanged` with reason
  `sync` per tab in the result through that port only. A port that dropped
  before the query answered gets nothing. A failed query is logged and the
  port is served as usual. External ports get no snapshot.
- `index.ts` creates the watcher with `chrome.tabs` and broadcasts each
  change through the router. It passes
  `devReload: () => chrome.runtime.reload()` only when the build-time
  constant `__SITECRAFT_HARNESS__` is true. `vite.config.ts` defines it from
  `isHarnessBuild(mode, process.env)` in `extension/buildFlags.ts`, which is
  true for `--mode harness` or `SITECRAFT_HARNESS=1`. That is the same rule
  the manifest applies for `externally_connectable`, so every build that lets
  the harness connect also answers `devReload`.

## Side panel (owner: UI agent)

New hook `extension/src/sidepanel/usePage.ts`:

```ts
export interface PageState {
  tab: TabInfo | null;      // the target page
  ready: boolean;           // false until the first answer
  tabs: TabInfo[];          // external mode only, for the picker
  follow: boolean;          // external mode only
  loading: boolean;         // external mode only, picker refresh
  select(tabId: number): void;   // external mode only, turns follow off
  setFollow(on: boolean): void;  // external mode only
  refresh(): void;               // asks again: the active tab (extension) or the tab list (external)
}
export function usePage(bridge: Bridge): PageState;
```

- Extension mode (`bridge.mode === 'extension'`): read the window id with
  `chrome.windows.getCurrent()` when that API exists. Ask `getActiveTab`
  with it. Apply `activeTabChanged` events whose `windowId` matches, whatever
  their reason. When no window id is known, apply every event. An event that
  arrives while a `getActiveTab` request is in flight is fresher than the
  answer, so that answer is dropped. `refresh()` asks `getActiveTab` again
  under the same rule. The app's Retry button calls it, so a start where
  `getState` and `getActiveTab` both failed recovers in one click. No picker.
- External mode (the harness page): keep the current `listTabs` and
  `getDefaultTab` logic for the first target. `follow` starts true. Consider
  `activeTabChanged` events whose tab is not null and whose URL origin is
  not `location.origin` (the harness itself is never the target). Every such
  event updates the picker list. Only reason `activated` moves the target,
  and only while `follow` is on: a URL or title change on the active tab of
  some other window must not steal the target. An event for the target's own
  tab id refreshes its title and URL, follow on or off. A manual pick sets
  the tab and turns `follow` off. The picker stays.
- App: a page strip under the header shows the host in bold and the title
  in muted text, or "No web page is active. Open a site in this window."
  Test id `page-strip`. The Manager tab label counts scripts that match the
  page. Clear the Modify chip when the page changes and the target script's
  pattern no longer matches the page URL.
- Chat: takes `page: PageState`. The target tab id is `page.tab?.tabId`.
  Extension mode shows no picker. External mode shows the picker plus a
  "Follow active tab" checkbox (test id `follow-active`). With no page the
  composer is disabled and the hint reads "Open a website in this window to
  make changes."
- Manager: takes `page: TabInfo | null`. A scope switch, test ids
  `scope-page` and `scope-all`, default page. Page scope lists scripts where
  `matchesPattern(s.urlPattern, page.url)`. All scope keeps the host groups.
  Empty text for page scope: "No scripts for <host> yet. Ask for a change in
  Chat." With no page: "No web page is active. Switch to All sites to see
  every script." Card edit state (`editing`, `draft`, `confirmDelete`) lives
  in Manager keyed by script id and is passed to `ScriptCard` as `ui` with an
  `onUi(patch)` callback. A page change that drops the card from page scope,
  or a scope switch that rebuilds the list, remounts the card without losing
  an open editor or its draft.
- Footer in external mode: a "Reload extension" link that sends `devReload`.
  Test id `dev-reload`. A rejection whose message starts with "Disconnected"
  is ignored: the worker restarted before it could answer. Any other error,
  such as "Not available in this build.", shows in the footer with test id
  `footer-error` until the next click.
- Copy rules: no em dash character anywhere. Short sentences.

## Out of scope

- Per-tab chat threads. The thread stays global.
- Favicons in the page strip.

## Status

| Date | Status | Files changed |
| --- | --- | --- |
| 2026-09-01 | Done. `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm build:harness` pass. The harness manifest has `externally_connectable`; the production manifest does not. | New: `extension/src/background/tabs.ts`, `extension/src/sidepanel/usePage.ts`, `extension/src/vite-env.d.ts`, `extension/test/tabs.test.ts`, `extension/test/ui.fakes.tsx`, `extension/test/ui.page.test.tsx`. Changed: `shared/src/protocol.ts`, `extension/src/background/router.ts`, `extension/src/background/index.ts`, `extension/src/sidepanel/App.tsx`, `extension/src/sidepanel/Chat.tsx`, `extension/src/sidepanel/Manager.tsx`, `extension/src/sidepanel/styles.css`, `extension/test/router.fakes.ts`, `extension/test/router.test.ts`, `extension/test/ui.app.test.tsx`, `docs/README.md`, this note. |

| 2026-09-01 | Review fixes. `pnpm typecheck` and `pnpm test` pass. | `activeTabChanged` carries `reason`; the router sends a `sync` snapshot to each side panel port on attach (CHROME-1, UI-2); `refresh()` works in extension mode and Retry calls it (UI-2); only `activated` events move the harness target (UI-3); card edit state moved into Manager (UI-1); `__SITECRAFT_HARNESS__` from `extension/buildFlags.ts` gates `devReload` and the footer shows non-disconnect errors (CHROME-2, F1). New: `extension/buildFlags.ts`, `extension/test/buildFlags.test.ts`. Changed: `shared/src/protocol.ts`, `extension/src/background/tabs.ts`, `extension/src/background/router.ts`, `extension/src/background/index.ts`, `extension/src/sidepanel/usePage.ts`, `extension/src/sidepanel/App.tsx`, `extension/src/sidepanel/Manager.tsx`, `extension/src/sidepanel/components/ScriptCard.tsx`, `extension/src/vite-env.d.ts`, `extension/vite.config.ts`, `extension/tsconfig.json`, `extension/test/ui.fakes.tsx`, `extension/test/ui.page.test.tsx`, `extension/test/router.test.ts`, `extension/test/tabs.test.ts`, `docs/README.md`, this note. |

Notes from integration:

- In extension mode the `getActiveTab` answer is dropped when an `activeTabChanged` event for the same window arrived while the request was in flight. The background answers after a `tabs.query`, so an event can be fresher than the answer. The same rule covers the `sync` snapshot the router sends on attach, which can land before the answer.
- The MV3 worker stops after about 30 s without events or API calls, and an open port does not keep it alive. Every port is dropped with it. A tab switch that wakes the worker while the panel is still reconnecting is broadcast to no one. The `sync` snapshot on attach is what makes the reconnect self-correcting.
- `devReload` answers with the sidebar state, but in a real harness build the worker restarts at once, so the reply may never arrive. The panel ignores that disconnect and the bridge reconnects. Any other rejection shows in the footer.
- In external mode `setFollow(true)` does not fetch the active tab. The target moves on the next event.
- The Modify chip is kept when the page becomes null. It clears only when a new page URL fails to match the script's pattern.
