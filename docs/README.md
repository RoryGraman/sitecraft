# Sitecraft

> Fast path: run `./setup` at the repository root. It automates every step a script can do and watches the manual Chrome steps.

Sitecraft is a Chrome extension that customizes websites from plain language. You open the side panel on any page and type a request, such as "hide the promo banner". A Claude agent reads a trimmed copy of the page, writes a small CSS rule or JS snippet, and the extension saves it. The script runs on every later visit to matching pages. You can keep it, undo it, edit it, or ask for changes in the same chat.

Every customization lives in your browser's local storage. The AI part runs in a small Node program on your machine, the companion, which reuses your Claude Code login. There are no accounts, no analytics, and no remote storage. The only outside traffic is the agent call to Anthropic.

Related documents:

- Design spec: [superpowers/specs/2026-08-18-sitecraft-design.md](superpowers/specs/2026-08-18-sitecraft-design.md)
- Implementation plan: [superpowers/plans/2026-08-31-sitecraft-implementation.md](superpowers/plans/2026-08-31-sitecraft-implementation.md)
- Tab-aware panel note: [superpowers/plans/2026-09-01-tab-aware-panel.md](superpowers/plans/2026-09-01-tab-aware-panel.md)

## Architecture

Two parts talk over Chrome native messaging.

```
+------------------------------ Chrome ------------------------------+
|  Side panel (React)  <-- Port -->  Background service worker        |
|  Chat | Manager | Onboarding       storage, native port, bundles,   |
|                                    tab reloads, run orchestration   |
|  Content script (document_start)   chrome.userScripts (MAIN world)  |
|  saved CSS, error relay, snapshots  saved JS bundles per pattern    |
+---------------------------------|----------------------------------+
                                  | stdio, 4-byte length framed JSON
                                  v
                    Companion (Node, com.sitecraft.companion)
                    Claude Agent SDK + one tool: inspect_page
                                  |
                                  v
                          Anthropic API (your Claude login)
```

**Extension** (Manifest V3, stable id `hoadedohbfjjmkajibiafgoajoicjdba`):

- The side panel has two tabs, Chat and Manager, plus a first-run Onboarding checklist. A page strip under the header names the active tab of the panel's window. Chat and Manager follow that tab.
- The background service worker owns storage, the native messaging port, `chrome.userScripts` registration, and tab reloads. It also validates every agent result before saving.
- The content script runs at `document_start`. It injects the saved CSS for the current URL in one `<style>` element before first paint. If the page's CSP blocks that style, it reports back and the background injects the CSS with `chrome.scripting.insertCSS`. The content script also relays script errors from the page and answers snapshot and inspect requests.
- Saved JS runs through `chrome.userScripts` in the page's MAIN world at `document_end`. One bundle is registered per URL pattern. Inside a bundle, priority 1 scripts run first and each level awaits the one before it. Every script runs in its own try/catch. A crash is reported and shown in the Manager next to the script.

**Companion** (Node, TypeScript, bundled with esbuild):

- Chrome starts it on demand through a small shell wrapper, `~/.sitecraft/sitecraft-host.sh`. You never run it by hand.
- It speaks only over stdin and stdout, using the native messaging frame format. It opens no network port. Nothing but frames is ever written to stdout. Logs go to `~/.sitecraft/companion.log`.
- The host manifest lists exactly one `allowed_origins` entry, this extension's origin. Chrome refuses every other caller.
- It runs the Claude Agent SDK with one custom tool, `inspect_page(selector)`. That tool round-trips over the open port to the extension, which returns the live outer HTML of the first match. The run uses structured output, an isolated settings scope, a temp working directory, and no session persistence.

**Data**: `chrome.storage.local` holds `scripts`, `settings`, `errors`, and `schemaVersion` (1). One customization is one `SiteScript` record with `id`, `name`, `description`, `urlPattern`, `kind` (`css` or `js`), `priority` (1 to 5), `code`, `enabled`, `trial`, `createdAt`, and `updatedAt`.

## Requirements

- Google Chrome 120 or newer. Chrome 138 or newer is the tested path. Other Chromium browsers (Chromium, Brave, Edge, Arc, Chrome Beta, Chrome Canary) work if they ship the `userScripts` API; pass `--browser` to the installer.
- Node 20 or newer. Building from source uses pnpm 9 (see `packageManager` in `package.json`).
- A Claude Code login on this machine. Install Claude Code, run `claude` in a terminal, and sign in once. Agent runs bill to that subscription.
- macOS or Linux. The Windows installer is not written yet (native hosts on Windows need a registry entry).

## Install from source

1. Install dependencies and build.

   ```sh
   pnpm install
   pnpm build
   ```

   This produces `extension/dist` (the unpacked extension) and `companion/dist/cli.js` (the companion bundle). This is the production build: no web page can connect to the extension. For browser-driven testing with the dev harness, build with `pnpm build:harness` instead (see "Dev harness and fixture").

2. Load the extension.

   Open `chrome://extensions`. Turn on Developer mode so the Load unpacked button appears. Click Load unpacked and choose the `extension/dist` folder. The card must show the id `hoadedohbfjjmkajibiafgoajoicjdba`. The id is fixed by `manifest.key`, so it is the same on every machine. The companion installer and the dev harness depend on it.

3. Allow user scripts.

   Open `chrome://extensions/?id=hoadedohbfjjmkajibiafgoajoicjdba` and turn on the **Allow User Scripts** switch. This per-extension switch is required. It is what lets `chrome.userScripts` run saved code, even on sites with strict content security policies. Developer mode is not what gates this API on Chrome 138 and newer; only the switch does. On Chrome 120 to 137 the switch does not exist and Developer mode must stay on instead.

4. Install the companion.

   ```sh
   node companion/bin/sitecraft.js install
   ```

   This writes two files:

   - `~/.sitecraft/sitecraft-host.sh`, an executable wrapper that runs `node companion/bin/sitecraft.js host` with the absolute paths of the Node binary and the checkout you ran it from.
   - The host manifest `com.sitecraft.companion.json` in the browser's native messaging directory. For Chrome on macOS that is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. On Linux it is `~/.config/google-chrome/NativeMessagingHosts/`.

   Options: `--browser chrome,brave,edge` installs for several browsers (default `chrome`). `--extension-id <id>` allows a different id, only needed if you changed the manifest key. Run `node companion/bin/sitecraft.js doctor` to check the wrapper, the manifests, and the Claude login. Run `node companion/bin/sitecraft.js uninstall` to remove the files again.

   The installer does not copy code. It points at this checkout. If you move the repo or switch Node versions, run `install` again.

5. Log in to Claude if you have not yet. Run `claude` in a terminal and complete the login.

6. Open the side panel. Click the Sitecraft toolbar icon on any normal web page. The Onboarding checklist opens the first time and tells you which of the steps above still fails.

**Updating a source checkout**: run `pnpm build`, then click the reload icon on the extension card at `chrome://extensions`. The companion needs only the build. Chrome starts a fresh companion process for each connection, so the next request picks up the new `dist/cli.js`.

## How the onboarding checks work

The side panel sends `checkOnboarding` to the background every 2 seconds while the checklist is visible. Each row shows a live pass or fail state.

| Step | What is checked | Pass when | If it fails |
| --- | --- | --- | --- |
| 1. Allow user scripts | The background calls `chrome.userScripts.getScripts()`. Chrome throws when the switch is off. | The call does not throw. | Click **Open extension details** and turn on Allow User Scripts. If the row still says Off after a few seconds, reload the extension. |
| 2. Install the companion | The background connects to `com.sitecraft.companion` with `chrome.runtime.connectNative` and sends `ping`. It waits up to 5 seconds for `pong`. | A `pong` arrives. The row then shows the companion version. | Run the install command, then click **Retry**. The row shows Chrome's disconnect reason; see Troubleshooting below. |
| 3. Log in to Claude | The companion runs a one-turn Agent SDK query with the prompt "Reply with the single word OK." with no tools and a 60 second timeout. This step is skipped while step 2 fails. | The reply contains `OK`. | Run `claude` in a terminal, sign in, and click **Retry**. The row shows the SDK's error text. |

**Continue** becomes enabled when all three pass. It stores `settings.onboardingDone = true`. On later launches the main UI opens as soon as the companion answers a ping; steps 1 and 3 are not re-checked on every launch. The **Setup** link in the footer reopens the checklist at any time.

The one-turn login check costs a fraction of a cent per run. It runs once per checklist poll only while step 2 passes, and again when you click Retry.

## Daily use

### Chat

1. The panel follows the active tab of its window. The page strip under the header shows that tab's host in bold and its title. Switch tabs or navigate and the strip, the Chat target, and the Manager list follow. When the active tab is not a web page (for example `chrome://extensions` or the Web Store) the strip says "No web page is active" and the composer is disabled until you open a site. The side panel has no tab picker. The picker exists only in the dev harness (see "Dev harness and fixture").
2. Type a request and click **Send**. Examples: "hide the promo banner", "hide the Shorts shelf", "make the comments section wider", "add a button that scrolls to the top".
3. A progress line shows what the agent is doing: Agent started, the first words of its reasoning, `Inspecting <selector>` when it looks at a live element, and Validating result. Click **Cancel** to abort the run.
4. On success the extension saves the script with `trial: true`, registers the bundles, and reloads the target tab. The result card shows the name, description, kind (`css` or `js`), match pattern, and three buttons: **Keep**, **Undo**, and **Modify**.
5. On failure the card shows the error and nothing is saved.

A run has a six minute limit. Each `inspect_page` call must answer within 20 seconds.

### Keep and Undo

- **Keep** clears the trial flag. The script keeps running. A script left in trial also keeps running; the Trial badge in the Manager just reminds you that you never confirmed it.
- **Undo** disables the script and reloads the tab. The script stays in the Manager as disabled, so you can read it, turn it back on, or delete it.

### Modify

Click **Modify** on a result card, or **Modify with AI** on a Manager card. A chip reading "Modifying: <name>" appears above the input. Your next request goes to the agent together with the full existing script. The agent returns an updated script with the same id, and the extension patches it in place, sets `trial` again, and reloads the tab. Click the x on the chip to go back to creating new scripts. The chip also clears on its own when you move to a page that the script's match pattern does not cover.

### Manager

The Manager opens in the **This page** scope. It lists only the scripts whose match pattern matches the active tab's URL, sorted by priority and then by name. The Manager tab label shows that count. Switch to **All sites** to see every script grouped by host, taken from each script's match pattern. When no web page is active the page scope says so; switch to All sites to see every script. Export and Import stay global in both scopes. Each card offers:

- an enabled toggle,
- a priority select from 1 to 5 (1 runs first; for CSS, 1 is written first so higher numbers win ties),
- **Edit code** with a textarea, **Save**, and **Cancel** (Save re-validates and re-registers the bundles),
- **Modify with AI**,
- **Delete** with an inline confirmation,
- a Trial badge until you click Keep,
- a Last error block with a **Clear** button when the script threw on a page load.

Every change re-registers the user script bundles at once. Open pages pick up CSS changes live and JS changes on the next load.

### Export and import

**Export** opens a panel with the JSON of every script (`{ "format": "sitecraft-scripts", "version": 1, "exportedAt": ..., "scripts": [...] }`). Use **Copy** or **Download** (`sitecraft-scripts-YYYY-MM-DD.json`). **Import** accepts pasted JSON or a chosen file. A script whose id already exists replaces the saved one. Other scripts are added. Invalid entries are skipped and listed in the result line.

## Dev harness and fixture

The harness renders the same side panel App as a normal web page, so browser automation tools and manual testing can drive it without opening the real side panel.

```sh
pnpm serve
```

This starts two zero-dependency static servers in one process (`scripts/serve.mjs`), both with `Cache-Control: no-store`:

- `http://localhost:4173/harness/index.html`: the harness page, served from `extension/dist`.
- `http://localhost:4174/`: the fixture page, served from `fixtures/`.

`node scripts/serve.mjs --root <dir> --port <n>` serves one directory instead.

The harness needs a harness build:

```sh
pnpm build:harness
```

Only this build (Vite mode `harness`, or `SITECRAFT_HARNESS=1`) adds `externally_connectable.matches` for `http://localhost/*` and `http://127.0.0.1/*` (any port) and names the extension "Sitecraft (harness build)". A normal `pnpm build` has no `externally_connectable` key, so no web page can talk to the extension. Any page served from localhost can drive a harness build, including creating scripts, so do not use a harness build for daily browsing.

How the harness connects: the harness page calls `chrome.runtime.connect('hoadedohbfjjmkajibiafgoajoicjdba', { name: 'sitecraft-sidebar' })` and the background accepts the port in `onConnectExternal` after checking the sender origin. The footer shows "Harness" in this mode. Requirements: the extension must be loaded with the stable id, and the page must be opened from `localhost` or `127.0.0.1`.

Target tab in the harness: the harness is itself a tab, so it cannot follow its own window the way the side panel does. Its Chat shows a tab picker plus a **Follow active tab** checkbox, on by default. While the checkbox is on, switching to any web tab in any window makes that tab the target. A navigation or title change on the active tab of another window does not move it; only a tab switch does. The harness page itself is never the target. Picking a tab by hand turns the checkbox off; tick it again to follow once more. **Refresh** reloads the tab list and keeps the current pick when it still exists. The first target is the most recently active `http` or `https` tab that is not the harness, so open the fixture in another tab first.

Reloading the extension from the harness: the footer has a **Reload extension** link. It sends the `devReload` request and the background calls `chrome.runtime.reload()`. Only harness builds wire this request, by either path above (`extension/buildFlags.ts` holds the rule). A production build answers "Not available in this build.", which the footer shows. The port drops while the extension restarts and the harness page reconnects on its own.

The fixture page (`fixtures/index.html`) has a strict CSP (`default-src 'self'; script-src 'self'; style-src 'self'`). Inline styles and inline scripts from the page are blocked, which exercises both the `insertCSS` fallback and the `chrome.userScripts` path. Known elements:

| Element | Purpose |
| --- | --- |
| `header#site-header` with a nav and `button#theme-toggle` | The toggle adds or removes `body.dark`. |
| `aside#promo-banner.promo` | The standard "hide the promo banner" target. |
| `section#feed` with three `li.video` items | A normal list. |
| `section.shorts-shelf` with twelve `article.short` items | Repeated siblings; tests snapshot collapsing and "hide Shorts" style requests. |
| `section#comments` with three `li.comment` items | A second block to restyle. |
| `div#late-widget.promo` | Added by `app.js` 500 ms after load. Tests scripts that must handle late content. |
| `footer#site-footer` with `span#status` | Reads "Loading", then "Ready" once the late widget exists. `window.__sitecraftFixtureReady` becomes `true` at the same time. |

## Manual end-to-end checklist

Run this after `pnpm build` with the extension loaded, Allow User Scripts on, the companion installed, and `pnpm serve` running.

1. Open `http://localhost:4174/`. Confirm the promo banner, the Shorts shelf, and after half a second the late widget are visible.
2. Open `http://localhost:4173/harness/index.html` in a second tab, or open the real side panel on the fixture tab. Confirm all three onboarding rows are green and the main UI appears. First run: click Continue.
3. In Chat, check that the page strip shows `localhost:4174`. In the real side panel, click the fixture tab. In the harness, leave Follow active tab on, click the fixture tab once, and come back; the target stays on the fixture. Or pick the fixture in the tab picker. Send "Hide the promo banner".
4. Watch the progress line, then the result card. Confirm the fixture tab reloaded and the banner is gone. Confirm the card shows kind `css` (expected for a hide request) and a pattern such as `http://localhost:4174/*`.
5. Reload the fixture tab by hand. The banner must stay hidden (persistence).
6. Click **Undo**. The tab reloads and the banner is visible again. Open Manager: the script is listed under `localhost:4174`, disabled, still with the Trial badge.
7. Turn the script back on with the toggle. Reload the fixture. The banner is hidden again.
8. Back in Chat, click **Keep** on the result card. In Manager the Trial badge is gone.
9. Send "Hide the late widget that appears after the page loads". Confirm a script that handles the delayed element (usually `css` on `#late-widget`, or `js` with a MutationObserver). After reload the widget must not appear.
10. Click **Modify** on that result and send "Also hide the Shorts shelf". Confirm the same script is updated (same card in Manager, updated code) and the shelf is hidden after reload.
11. Manager checks: change a priority and confirm the value sticks after reopening the panel; toggle a script off and on; Edit code, change a color or selector, Save, reload the fixture, and confirm the change applied.
12. Export: click Export, Copy, and confirm the JSON contains every script. Delete one script (confirm inline). Import the copied JSON. The deleted script is back and the others are unchanged (same ids, no duplicates).
13. Error surfacing: Edit a `js` script and replace its code with `throw new Error('x')`, Save, reload the fixture. In Manager the card shows Last error: x. Click Clear and confirm it disappears. Restore the code.
14. Companion cancel: send a request and click Cancel while it runs. The thread shows Cancelled and nothing new appears in Manager.
15. Companion failure: run `node companion/bin/sitecraft.js uninstall`, click the footer Setup link, and confirm row 2 turns red with "Specified native messaging host not found.". Run `install` again and click Retry. The row turns green.

## Troubleshooting

Chrome reports native messaging failures as a short disconnect message. The extension maps it to a companion state and shows the raw text in the Onboarding row and the footer tooltip. `node companion/bin/sitecraft.js doctor` checks most of these from the terminal.

| Message shown | State | Cause | Fix |
| --- | --- | --- | --- |
| `Specified native messaging host not found.` | not-installed | No host manifest named `com.sitecraft.companion.json` in this browser's NativeMessagingHosts directory. | Run `node companion/bin/sitecraft.js install`. For a browser other than Chrome add `--browser <id>`. Click Retry. |
| `Access to the specified native messaging host is forbidden.` | forbidden | The manifest's `allowed_origins` does not contain this extension's id. Usually the extension was loaded with a different id, for example after changing `manifest.key`. | Compare the id on the extension card with `doctor` output. Run `install --extension-id <id shown in Chrome>`. |
| `Failed to start native messaging host.` | error | Chrome could not execute the wrapper. The wrapper is missing or not executable, the Node path baked into it no longer exists (for example after a version manager upgrade), or the checkout moved. | Run `doctor`. Run `install` again from the current checkout. Check `cat ~/.sitecraft/sitecraft-host.sh` and that both quoted paths exist. |
| `Native host has exited.` | error | The companion process died during a request. Common causes: `companion/dist/cli.js` missing (build not run), dependencies not installed, Node older than 20, or an uncaught error. | Run `pnpm install` and `pnpm build`. Read the tail of `~/.sitecraft/companion.log`. Run `node companion/bin/sitecraft.js --version` to confirm the bundle loads. |
| `Error when communicating with the native messaging host.` | error | Bytes that are not frames reached stdout, or a frame was malformed or too large. In practice a stray `console.log` in a dependency, or a corrupt build. | Rebuild the companion. Check the log for the last request. Nothing in `companion/src` may write to stdout except the host loop. |
| `Companion disconnected.` | error | The host closed the port with no Chrome error while a request was pending. | Same as "Native host has exited". Check the log. |
| `Companion ping timed out after 5000 ms.` | error | The host started but did not answer within 5 seconds. Often the first start after an install while Node loads the SDK, or a very slow disk. | Click Retry. If it repeats, run `doctor` and read the log. |

Other symptoms:

| Symptom | Fix |
| --- | --- |
| Row 1 stays Off after turning on the switch. | Reload the extension at `chrome://extensions`. On Chrome 120 to 137 turn on Developer mode instead; the switch does not exist there. Chrome older than 120 has no `userScripts` API. |
| Row 3 says `Claude login failed. Run "claude" in a terminal and sign in, then try again.` | Run `claude` in a terminal and log in (`/login`). Click Retry. |
| Row 3 says `Timed out after 60 s waiting for Claude.` | Network problem or a very slow first start. Click Retry. Check that `claude` works in a terminal. |
| Row 3 mentions a rate limit, billing, or an account on hold. | The message is the SDK's account state. Fix it in your Claude account, then Retry. |
| `The requested Claude model was not found.` | The `model` in `~/.sitecraft/config.json` is wrong. Remove the field to use the default. |
| A run ends with `The agent used too many turns without finishing.` | Raise `maxTurns` in the config file or make the request smaller. |
| A run ends with a validation error naming `urlPattern`, `code`, or another field. | The agent returned a malformed script. Nothing was saved. Send the request again, with more detail if needed. |
| The result card looks right but the page did not change. | Check row 1 (user scripts). Check the Manager for a Last error. For CSS on a strict-CSP site the content script asks the background to fall back to `insertCSS`; reload the tab once more. |
| The harness page shows "Extension not reachable". | The extension is not loaded, has a different id, or the page was not opened from `localhost` or `127.0.0.1`. Reload the extension and the page. |
| The page strip says "No web page is active" while a site is open. | The panel follows the active tab of its own window. Click the site's tab once. Tabs such as `chrome://` pages and the Web Store are never targets. |
| Scripts disappeared after an extension update. | Storage survives updates, but `chrome.userScripts` registrations are cleared. The background re-registers on `onInstalled`. Reload the extension once if a page still misses its scripts. |

## Configuration and logs

**`~/.sitecraft/config.json`** (optional). Read each time the host starts, so a change applies on the next companion connection.

```json
{
  "model": "claude-opus-5",
  "maxTurns": 16
}
```

- `model`: a non-empty string. Default `claude-opus-5`. The `SITECRAFT_MODEL` environment variable is a fallback, but Chrome starts the companion with Chrome's own environment, so the config file is the reliable place.
- `maxTurns`: an integer from 1 to 200. Default 16. Structured output spends one extra turn, so keep a margin.
- Invalid values are logged and ignored.

**`~/.sitecraft/companion.log`**. Append-only text, one line per event with a timestamp and level. It records host start and stop, each run (request id, page URL, and the first 200 characters of your request), run results, and errors. Set `SITECRAFT_LOG_LEVEL=debug` (in the wrapper's environment) to include the SDK's stderr. The file is never rotated; delete it whenever you like.

**Other files**: `~/.sitecraft/sitecraft-host.sh` (the wrapper) and the host manifest in the browser directory listed above. `uninstall` removes the manifests and, once no supported browser still has one, the wrapper. The config file and the log are left in place.

**Companion commands**:

```
node companion/bin/sitecraft.js install   [--browser a,b] [--extension-id <id>]
node companion/bin/sitecraft.js uninstall [--browser a,b]
node companion/bin/sitecraft.js doctor    [--browser a,b] [--extension-id <id>]
node companion/bin/sitecraft.js --help
node companion/bin/sitecraft.js --version
```

`host` is the default subcommand and is what the wrapper runs. Do not run it by hand; it waits for framed input on stdin.

**Repo commands**: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm serve`. Run one test file with `npx vitest run <path>`.

## Privacy

- Scripts, settings, and errors live in `chrome.storage.local` on this machine. Export produces a plain JSON file that you control.
- No analytics, no telemetry, no accounts, no remote storage.
- The companion opens no network port and listens only on stdin. Chrome allows only this extension's id to start it.
- For each request the companion sends to Anthropic: your request text, the page URL and title, a trimmed DOM snapshot (script and style bodies removed, comments removed, svg internals removed, long inline styles and data URLs stripped, repeated siblings collapsed, capped at 60,000 characters), the scripts already saved for that site, and the results of any `inspect_page` calls (capped at 20,000 characters each). Snapshots include the page text you can see, so think before using Sitecraft on pages with private data.
- Runs use your Claude Code login. Cost is billed to that subscription. Each run uses an isolated SDK session: no user hooks, no user MCP servers, no `CLAUDE.md`, an empty temp working directory, and no session files written under `~/.claude`.
- Saved JS runs in the page's MAIN world with the same power as the site's own code. Read the code in the Manager before you click Keep, and review anything you import.
- The log file contains host lifecycle lines, the page URL and the first 200 characters of each request, result names, and error text. It does not contain page snapshots. At debug level it also contains the SDK's stderr.

## Out of scope for v1

- Live page control by the agent (clicking, typing) during a chat turn.
- API key fallback mode. Runs always use the Claude Code login.
- Script sharing or sync between machines. Use export and import.
- Firefox or Safari ports. Windows installer.
- Automatic self-repair when a site redesign breaks a script.
