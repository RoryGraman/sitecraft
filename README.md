# Sitecraft

Customize any website with plain language.

Sitecraft is a Chrome extension (Manifest V3) plus a small local Node companion. You open the side panel on any page and type a request, such as "hide the promo banner". A Claude agent reads a trimmed copy of the page, writes a small CSS rule or JavaScript snippet, and the extension saves it. The script runs on every later visit to matching pages. You can keep it, undo it, edit it, or ask for changes in the same chat.

Everything stays on your machine. Scripts live in the browser's local storage. The AI runs in the companion, a Node program that reuses your Claude Code login. There are no accounts, no analytics, and no remote storage. The only outside traffic is the agent call to Anthropic.

- Full guide (harness, end to end checklist, full troubleshooting): [docs/README.md](docs/README.md)
- Design spec: [docs/superpowers/specs/2026-08-18-sitecraft-design.md](docs/superpowers/specs/2026-08-18-sitecraft-design.md)

## How it works

Two parts talk over Chrome native messaging.

```
+------------------------------ Chrome ------------------------------+
|  Side panel (React)  <-- Port -->  Background service worker        |
|  Chat | Manager | Onboarding       storage, native port, bundles   |
|  Content script (document_start)   chrome.userScripts (MAIN world)  |
|  saved CSS, error relay, snapshots  saved JS bundles per pattern    |
+---------------------------------|----------------------------------+
                                  | stdio, length framed JSON
                                  v
                    Companion (Node, com.sitecraft.companion)
                    Claude Agent SDK + one tool: inspect_page
                                  |
                                  v
                          Anthropic API (your Claude login)
```

- The side panel follows the active tab of its window. Chat sends your request. Manager lists the scripts that match the page.
- The background worker owns storage, the native messaging port, and `chrome.userScripts` registration. It validates every agent result before saving.
- The content script injects saved CSS at `document_start`. Saved JS runs through `chrome.userScripts` in the page's MAIN world.
- The companion speaks only over stdin and stdout. It opens no network port. It runs the Claude Agent SDK with one tool, `inspect_page`, which reads live page elements on request.

## Quick start

```sh
git clone https://github.com/RoryGraman/sitecraft
cd sitecraft
./setup
```

The wizard does everything a script can do: it checks your tools, builds the project, installs the companion, and checks your Claude login. Then it opens the right Chrome pages and watches your browser. It confirms each manual step live as you do it. Only the browser steps stay manual, because Chrome requires a human for them: turn on **Developer mode** once, click **Load unpacked**, turn on **Allow User Scripts**, and click **Update** to restart the extension.

Run `./setup` again at any time. It is safe to re-run: the build steps re-run quickly, and finished Chrome steps are skipped. `./setup --help` lists the options (`--browser brave`, `--skip-login`, `--uninstall`, and more).

## Requirements

- Google Chrome 120 or newer. Chrome 138 or newer is the tested path.
- Node 20 or newer.
- pnpm 9 (see `packageManager` in `package.json`). Install with `npm install -g pnpm@9` or `corepack enable`.
- A Claude Code login on this machine. Install Claude Code, run `claude` in a terminal, and sign in once. Agent runs bill to that subscription.
- macOS or Linux. Windows is not supported yet.

## Manual setup

`./setup` does all of the steps below for you. Use this path when you want each step by hand. Run every command from the repository root.

### 1. Build

```sh
pnpm install
pnpm build
```

This produces two outputs:

- `extension/dist`: the unpacked extension.
- `companion/dist/cli.js`: the companion bundle.

This is the production build. No web page can connect to the extension.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension/dist` folder.
4. Confirm the card shows the id `hoadedohbfjjmkajibiafgoajoicjdba`. The id is fixed by `manifest.key`, so it is the same on every machine. The companion depends on it.

### 3. Allow user scripts

1. Open `chrome://extensions/?id=hoadedohbfjjmkajibiafgoajoicjdba`.
2. Turn on the **Allow User Scripts** switch.
3. Click **Update** at the top of `chrome://extensions` (or the reload icon on the Sitecraft card). The switch alone does not restart the extension; the reload does, and Sitecraft registers your scripts on that restart.

This per-extension switch lets `chrome.userScripts` run saved code, even on sites with a strict content security policy. On Chrome 120 to 137 the switch does not exist; keep Developer mode on instead.

### 4. Install the companion

```sh
node companion/bin/sitecraft.js install
```

This writes two files:

- `~/.sitecraft/sitecraft-host.sh`: a wrapper that runs the companion. It holds the absolute paths of your Node binary and this checkout.
- The native messaging host manifest `com.sitecraft.companion.json` in Chrome's messaging directory. On macOS that is `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. On Linux it is `~/.config/google-chrome/NativeMessagingHosts/`.

The installer does not copy code. It points at this checkout. If you move the repo or change your Node version, run `install` again.

Options:

- `--browser chrome,brave,edge`: install for several Chromium browsers (default `chrome`).
- `--extension-id <id>`: use a different id (only if you changed `manifest.key`).

Check the setup any time:

```sh
node companion/bin/sitecraft.js doctor
```

### 5. Sign in to Claude

Run `claude` in a terminal and complete the login, if you have not already.

### 6. Open the panel

Click the Sitecraft toolbar icon on any normal web page. The Onboarding checklist opens the first time. It shows a live pass or fail state for the three steps above. Click **Continue** when all three pass.

## Running the companion

You never run the companion by hand. Chrome starts it on demand through the wrapper when the panel connects. It exits when the panel disconnects.

- It reads and writes only framed messages over stdin and stdout. It opens no port.
- Logs go to `~/.sitecraft/companion.log`.
- Chrome starts a fresh process for each connection, so a new `pnpm build` is used on the next request. No extension reload is needed for a companion change.

Companion commands:

```sh
node companion/bin/sitecraft.js install   [--browser a,b] [--extension-id <id>]
node companion/bin/sitecraft.js uninstall [--browser a,b]
node companion/bin/sitecraft.js doctor    [--browser a,b] [--extension-id <id>]
node companion/bin/sitecraft.js --version
node companion/bin/sitecraft.js --help
```

## Daily use

1. Open a site. The panel follows the active tab. The page strip under the header shows its host and title.
2. In **Chat**, type a request and click **Send**. Examples: "hide the promo banner", "make the comments wider", "add a button that scrolls to the top".
3. On success the extension saves the script as a trial, registers it, and reloads the tab. The result card shows **Keep**, **Undo**, and **Modify**.
   - **Keep** clears the trial flag.
   - **Undo** disables the script and reloads the tab.
   - **Modify** sends your next request together with the existing script, so the agent updates it in place.
4. The **Manager** tab lists scripts for the active page by default. Switch to **All sites** for every script. Each card has an enable toggle, a priority select, an inline code editor, delete, and any last error. Export and import use plain JSON.

## Configuration

`~/.sitecraft/config.json` is optional. It is read each time the companion starts.

```json
{
  "model": "claude-opus-5",
  "maxTurns": 16
}
```

- `model`: the Claude model for runs. Default `claude-opus-5`.
- `maxTurns`: 1 to 200. Default 16.

Invalid values are logged and ignored.

## Development

```sh
pnpm build        # build the extension and the companion
pnpm test         # run the unit tests (Vitest)
pnpm typecheck    # TypeScript, strict
pnpm serve        # static servers for the dev harness and the fixture
pnpm build:harness  # a build that the dev harness page can drive
```

The project is a pnpm workspace with three packages: `shared` (types, protocol, validators), `extension` (the MV3 extension), and `companion` (the Node host). The dev harness renders the same side panel as a normal web page, so it can be driven without opening the real side panel. See [docs/README.md](docs/README.md) for the harness, the manual end to end checklist, and the full troubleshooting table.

## Privacy

- Scripts, settings, and errors live in `chrome.storage.local` on your machine. Export produces a plain JSON file that you control.
- No analytics, no telemetry, no accounts, no remote storage.
- The companion opens no network port. Chrome allows only this extension's id to start it.
- For each request the companion sends to Anthropic: your request text, the page URL and title, a trimmed DOM snapshot, the scripts already saved for that site, and the results of any `inspect_page` calls. Snapshots include visible page text, so think before using Sitecraft on pages with private data.
- Saved JS runs in the page's MAIN world with the same power as the site's own code. Read the code before you keep it, and review anything you import.

## License

MIT. See [LICENSE](LICENSE).

## Status

Sitecraft v1. Built and tested on macOS with Chrome. Windows support, an API key mode, and script sync are out of scope for v1.
