# Sitecraft

**Tell a website what to change. It stays changed.**

Open the side panel on any page and type "hide the promo banner". A Claude agent reads the page, writes a small CSS rule or JS snippet, and saves it. The snippet runs on every later visit. Keep it, undo it, edit it, or ask for something else.

Nothing leaves your machine except the agent call. No accounts, no analytics, no server, no API key.

## Install

```sh
git clone https://github.com/RoryGraman/sitecraft
cd sitecraft
./setup
```

The wizard builds the project, installs the companion, and walks you through the three clicks Chrome will not let a script do for you: **Developer mode**, **Load unpacked**, **Allow User Scripts**. It watches the browser and confirms each one. Safe to run again at any time; `./setup --help` lists the options.

You need Chrome 120 or newer (138+ is the tested path), Node 20+, pnpm 9, and macOS or Linux. You also need a Claude Code login: run `claude` in a terminal and sign in once. Runs bill to that subscription.

Doing it by hand instead: [docs/README.md](docs/README.md).

## Ask for things

- "hide the promo banner"
- "make the comments section wider"
- "add a button that scrolls to the top"
- "hide the widget that appears after the page loads"
- "make this page dark"

Vague is fine. The agent inspects live elements before it writes anything.

## What comes back

One script: a name, a description, a match pattern, and the code (`css` or `js`). The tab reloads so you can see it work.

- **Keep** — you are done.
- **Undo** — turns it off and reloads. It waits in the Manager if you change your mind.
- **Modify** — your next message edits that same script.

The **Manager** tab lists the scripts for the current page, or for every site. Toggle them, set priority 1 to 5, edit the code by hand, delete, or read the last error a script threw. Export and import are plain JSON.

## How it works

```
+-------------------------- Chrome ---------------------------+
|  Side panel  <--->  Background worker                       |
|                     storage, native port, script bundles    |
|  Content script     chrome.userScripts (MAIN world)         |
+------------------------------|------------------------------+
                               | stdio, framed JSON
                               v
                 Companion (Node, on your machine)
                 Claude Agent SDK + one tool: inspect_page
                               |
                               v
                     Anthropic API (your Claude login)
```

Saved CSS goes in before first paint. Saved JS runs through `chrome.userScripts` in the page's MAIN world, one bundle per URL pattern, each script in its own try/catch. The background worker validates every agent result before it saves it. The companion has no network port; Chrome starts it on demand and only this extension may do so.

## Settings

`~/.sitecraft/config.json` is optional:

```json
{ "model": "claude-opus-5", "maxTurns": 16 }
```

The log is `~/.sitecraft/companion.log`. Delete it whenever you like.

## When it breaks

```sh
node companion/bin/sitecraft.js doctor
```

That catches most of it. The rest:

- Chrome says the native host is missing or forbidden → `node companion/bin/sitecraft.js install`, then Retry in the panel.
- The onboarding row for user scripts stays off → reload the extension at `chrome://extensions`.
- The result looks right but the page did not change → check the Manager for a last error, then reload the tab.
- A run gives up on turns → raise `maxTurns`, or ask for less at once.

Every Chrome error message, with its cause, is in [docs/README.md](docs/README.md).

## Development

```sh
pnpm build          # extension + companion
pnpm test           # Vitest
pnpm typecheck      # strict
pnpm serve          # dev harness + test fixture
pnpm build:harness  # a build the harness page can drive
```

A pnpm workspace: `shared` (types, protocol, validators), `extension` (MV3), `companion` (the Node host). The harness renders the side panel as a normal web page so a browser can drive it — that build alone accepts a connection from localhost, so do not browse with it. Details, the fixture page, and the end to end checklist: [docs/README.md](docs/README.md).

## Privacy and risk

- Scripts and settings live in `chrome.storage.local`. Export gives you a JSON file you own.
- Each request sends Anthropic your text, the page URL and title, a trimmed DOM snapshot, and the scripts already saved for that site. Snapshots include visible page text, so think before you use it on private pages.
- Saved JS runs with the same power as the site's own code. Read it before you keep it, and only import files you trust.
- No telemetry, no accounts, no remote storage. Runs use an isolated SDK session: no hooks, no MCP servers, no `CLAUDE.md`.

## License

MIT. See [LICENSE](LICENSE).

Version 0.1.0, first release. Built and tested on macOS with Chrome. Not yet: Windows, Firefox, Safari, an API key mode, or sync between machines.
