# OpenCode Sidebar

A Chrome side panel that puts [OpenCode](https://opencode.ai) next to whatever page you're reading. Select text, ask OpenCode about it, and apply the answer back into the page.

## What it does

- **Selection capture** — highlight text on any page and the sidebar picks it up automatically
- **Chat** — ask about the selection, the page, or anything else
- **Read page** — pulls the page's text, links and form fields into the conversation
- **Suggest actions** — OpenCode proposes clicks, fills and navigation, and you run them
- **Apply to page** — write the reply straight back into the original text
- **Project folder** — work in the context of a real project folder
- **Model picker** — every model your OpenCode server exposes, searchable and grouped by provider

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and select this folder (the one with `manifest.json`)

## Connect it to OpenCode

The sidebar talks to OpenCode's HTTP API with HTTP Basic auth.

**1. Load the credentials.** In the sidebar, click the ⚙ gear icon, then **Pick config folder…** and select:

```
~/.config/opencode
```

The extension reads `service.json` from that folder and fills in the password for you. (To do it by hand instead: `cat ~/.config/opencode/service.json` and paste the `password` value.)

**2. Check it.** Click **Test** — you should see `Connected to http://127.0.0.1:49374/api`. Click **Auto-detect** if the host and port are wrong too.

### Making it permanent

OpenCode generates a fresh password when its background service restarts, which breaks the connection. Pin both:

```bash
opencode service set port 53213
opencode service set password your-own-password
opencode service restart
```

Then put the same values in the connection settings and they will keep working.

> The default port depends on your OpenCode release channel (`49374` for `latest`, `49375` for `local`), so **Auto-detect** is the reliable way to find it.

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
