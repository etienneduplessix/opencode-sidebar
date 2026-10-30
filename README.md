# OpenCode Sidebar

A Chrome side panel that puts [OpenCode](https://opencode.ai) next to the page you are reading: select text, ask about it, and apply the answer back into the page.

## Screenshot

_Placeholder. Add a screenshot or a short GIF of the side panel here, for example `docs/screenshot.png`._

## What it does

- **Selection capture** — highlight text on any page and the sidebar picks it up automatically
- **Chat** — ask about the selection, the page, or anything else
- **Read page** — pulls the page's text, links and form fields into the conversation
- **Suggest actions** — OpenCode proposes clicks, fills and navigation, and you run them
- **Apply to page** — write the reply straight back into the original text
- **Project folder** — work in the context of a real project folder
- **Model picker** — every model your OpenCode server exposes, searchable and grouped by provider

## Requirements

- Chrome, or another Chromium browser with the side panel
- [OpenCode](https://opencode.ai) **v2.0.27** — the HTTP API used here was checked against that release (see the contract notes at the top of `background.js`)
- The OpenCode server running on the same machine as the browser

### Start the OpenCode server

The sidebar talks to OpenCode's HTTP API on localhost. The usual target is the shared background service. On macOS, Linux, and WSL the `latest` channel listens on `127.0.0.1:49374` (`49375` for the `local` channel). See where it is, or start it:

```bash
opencode service status
opencode service start
```

Basic auth always uses the username `opencode`. The password is generated, and it changes when the service restarts, which drops the sidebar's connection. Pin a port and a password, then start the service again (`service set` stops it):

```bash
opencode service set port 49374
opencode service set password "a-long-secret"
opencode service start
```

Use the same port and password in the sidebar's connection settings. Any fixed port is fine, as long as both sides match.

To run a foreground server instead of the background service:

```bash
OPENCODE_PASSWORD="a-long-secret" opencode serve --port 4096
```

**Auto-detect** tries ports `49374`, `49375`, and `4096`.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and select this folder (the one with `manifest.json`)

The extension needs access to all sites because it reads the selection and the page, and writes an answer back, on whatever tab you have open.

## Connect it to OpenCode

**1. Load the credentials.** In the sidebar, click the ⚙ gear icon, then **Pick config folder…** and select:

```
~/.config/opencode
```

The extension reads `service.json` from that folder and fills in the password for you. To do it by hand: `cat ~/.config/opencode/service.json` and paste the `password` value. The live server also records itself at `~/.local/state/opencode/service.json`.

**2. Check it.** Click **Test**. You should see `Connected to http://127.0.0.1:49374/api`. Click **Auto-detect** if the host or port is wrong.

## Use with Featherless

[Featherless](https://featherless.ai/docs/api-overview-and-common-options) is an OpenAI-compatible API. OpenCode does not need a code change in this extension: add Featherless as a custom provider, then pick the model in the sidebar.

Put this in `~/.config/opencode/opencode.json` (global) or in a project's `opencode.json`. The base URL is `https://api.featherless.ai/v1`. The `apiKey` line is a placeholder — export `FEATHERLESS_API_KEY` in the environment OpenCode runs in, and do not commit a real key.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "featherless": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Featherless",
      "options": {
        "baseURL": "https://api.featherless.ai/v1",
        "apiKey": "{env:FEATHERLESS_API_KEY}"
      },
      "models": {
        "your-org/your-model": {
          "name": "Your Featherless model"
        }
      }
    }
  }
}
```

Replace `your-org/your-model` with a model id from your Featherless account. Restart OpenCode and choose the model from the sidebar picker.

This follows [OpenCode's custom provider docs](https://opencode.ai/docs/providers/): `@ai-sdk/openai-compatible` is the package for a `/v1/chat/completions` endpoint, which is what Featherless serves. `{env:FEATHERLESS_API_KEY}` is OpenCode's env-var syntax for `options.apiKey`.

## How it is built

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `background.js` | Service worker — OpenCode API, page reading, page actions |
| `sidepanel.html` / `sidepanel.js` | The sidebar UI and its behaviour |
| `selection-capture.js` | Content script that watches your selection |
| `icons/` | App icon set |

The folder picker and model list are built on OpenCode's own API (`/api/fs/list`, `/api/fs/find`, `/api/project`, `/api/model`), so the extension needs no special filesystem permissions and always sees the same view of your disk that OpenCode does.

## Notes

- Credentials are stored in `chrome.storage.local` and only ever sent to `127.0.0.1`.
- The service worker installs the selection watcher into tabs that were already open, since Chrome only injects content scripts into newly loaded pages.
