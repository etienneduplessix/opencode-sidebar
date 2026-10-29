// OpenCode Sidebar — service worker
// Talks to the OpenCode v2 server API (http://127.0.0.1:53213/api).
//
// v2 contract (verified against opencode v2.0.27):
//   POST /api/session                        -> { data: { id } }
//   POST /api/session/{id}/model             -> { model: { id, providerID } }
//   POST /api/session/{id}/prompt            -> { text }   (async, replies later)
//   GET  /api/session/{id}/message           -> { data: [ Message ] }
// Assistant message: { type: "assistant", content: [{ type: "text", text }], finish }
// Auth is HTTP Basic (username/password), not Bearer.

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 49374,
  username: "opencode",
  password: "",
  modelId: "glm-5.3-flash",
  providerId: "ollama-cloud",
  directory: ""
};

const PAGE_TEXT_LIMIT = 12000;
const REPLY_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 1200;
const PAGE_LOAD_TIMEOUT_MS = 15000;
const ACTION_TIMEOUT_MS = 5000;

// opencode's own defaults: the "latest" channel listens here, and Basic auth
// always uses the username "opencode" with a password from the service config.
const OPENCODE_DEFAULT_PORTS = [49374, 49375, 4096];
const OPENCODE_MDNS_HOST = "opencode.local";

// Only real web documents can be scripted. Everything else (browser UI,
// extensions, view-source, data:, about:) is rejected up front so the
// side panel shows a clear reason instead of a raw injection error.
const INJECTABLE_PROTOCOLS = ["http:", "https:", "file:"];

// ---------------------------------------------------------------- config

function getConfig() {
  return chrome.storage.local.get("opencodeConfig").then((data) => ({
    ...DEFAULT_CONFIG,
    ...((data && data.opencodeConfig) || {})
  }));
}

function apiBase(cfg) {
  return `http://${cfg.host}:${cfg.port}/api`;
}

function basicAuth(cfg) {
  const raw = `${cfg.username}:${cfg.password}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function authHeaders(cfg) {
  return {
    "Content-Type": "application/json",
    Authorization: `Basic ${basicAuth(cfg)}`
  };
}

function isInjectable(url) {
  if (!url) return false;
  try {
    return INJECTABLE_PROTOCOLS.includes(new URL(url).protocol);
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------- settings

function saveSettings(patch) {
  const clean = {};
  if (patch && typeof patch === "object") {
    if (typeof patch.host === "string") clean.host = patch.host.trim();
    if (patch.port !== undefined && patch.port !== "") clean.port = Number(patch.port) || DEFAULT_CONFIG.port;
    if (typeof patch.username === "string") clean.username = patch.username.trim() || DEFAULT_CONFIG.username;
    if (typeof patch.password === "string") clean.password = patch.password;
    if (typeof patch.modelId === "string") clean.modelId = patch.modelId.trim();
    if (typeof patch.providerId === "string") clean.providerId = patch.providerId.trim();
    if (typeof patch.directory === "string") clean.directory = patch.directory.trim();
  }
  return chrome.storage.local.get("opencodeConfig").then((data) => {
    const next = { ...((data && data.opencodeConfig) || {}), ...clean };
    return chrome.storage.local.set({ opencodeConfig: next }).then(() => ({ ...DEFAULT_CONFIG, ...next }));
  });
}

// ---------------------------------------------------------------- models

function listModels(cfg) {
  return fetch(apiBase(cfg) + "/model", { headers: authHeaders(cfg) })
    .then((res) => {
      if (!res.ok) throw new Error(`Model list failed: ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const models = (data && data.data) || [];
      return models
        .filter((m) => m && m.id && m.providerID)
        .map((m) => ({ id: m.id, name: m.name || m.id, providerID: m.providerID }));
    });
}

// ---------------------------------------------------------------- connection

/** Pings the server with the given credentials. Resolves to { ok, error }. */
function pingServer(cfg) {
  return fetch(apiBase(cfg) + "/config", { headers: authHeaders(cfg) })
    .then((res) => {
      if (res.ok) return { ok: true };
      if (res.status === 401) return { ok: false, error: "Wrong username or password" };
      return { ok: false, error: `Server responded ${res.status}` };
    })
    .catch((e) => ({ ok: false, error: e.message }));
}

function testConnection(cfg) {
  return pingServer(cfg).then((res) =>
    res.ok
      ? { success: true, url: apiBase(cfg) }
      : { success: false, error: res.error, url: apiBase(cfg) }
  );
}

/**
 * Finds a working opencode server without the user filling anything in.
 *
 * opencode publishes its connection details in two places:
 *   ~/.local/state/opencode/service.json  -> { url, pid, password }  (live server)
 *   ~/.config/opencode/service.json      -> { hostname, port, password } (config)
 *
 * Reading those needs the extension to be granted file access, so we also try
 * the well-known ports and the mDNS hostname with the password we already have.
 */
function detectService() {
  return getConfig().then((cfg) => {
    const candidates = [];

    const addCandidate = (host, port, password, source) => {
      const key = `${host}:${port}`;
      if (candidates.some((c) => c.key === key && c.password === password)) return;
      candidates.push({ key, host, port, password, source });
    };

    addCandidate(cfg.host, cfg.port, cfg.password, "current settings");

    return readServiceFiles()
      .then((found) => {
        for (const f of found) {
          if (f.url) {
            try {
              const u = new URL(f.url);
              addCandidate(u.hostname, Number(u.port) || 80, f.password || "", f.source);
            } catch (e) {
              /* ignore malformed url */
            }
          }
          if (f.hostname) {
            addCandidate(f.hostname, f.port || cfg.port, f.password || "", f.source);
          }
        }
        return candidates;
      })
      .then((list) => {
        const extra = [];
        for (const port of OPENCODE_DEFAULT_PORTS) {
          extra.push({ host: "127.0.0.1", port, password: cfg.password, source: "opencode default port" });
        }
        extra.push({ host: OPENCODE_MDNS_HOST, port: 80, password: cfg.password, source: "mDNS" });
        return list.concat(extra);
      })
      .then((list) => {
        // Try the stored password first, then an empty one (auth may be disabled).
        const ordered = list
          .map((c) => ({ ...c, password: c.password || "" }))
          .sort((a, b) => (b.password ? 1 : 0) - (a.password ? 1 : 0));

        return ordered.reduce(
          (chain, candidate) =>
            chain.then((found) => {
              if (found) return found;
              const candidateCfg = {
                host: candidate.host,
                port: candidate.port,
                username: cfg.username,
                password: candidate.password
              };
              return pingServer(candidateCfg).then((res) =>
                res.ok
                  ? { success: true, ...candidate, password: candidate.password }
                  : null
              );
            }),
          Promise.resolve(null)
        ).then((found) => {
          if (!found) {
            return {
              success: false,
              error:
                "No opencode server found. Start one with `opencode serve`, or set a fixed port " +
                "with `opencode service set port 53213`."
            };
          }
          return saveSettings({
            host: found.host,
            port: found.port,
            password: found.password,
            username: cfg.username
          }).then((saved) => ({ success: true, ...saved, source: found.source }));
        });
      })
      .catch((e) => ({ success: false, error: e.message }));
  });
}

/**
 * Reads opencode's service files through file:// URLs.
 * Requires "Allow access to file URLs" for the extension; returns [] otherwise.
 */
function readServiceFiles() {
  const RELATIVE_PATHS = [
    ".local/state/opencode/service.json",
    ".config/opencode/service.json"
  ];

  const homeDirs = () =>
    fetch("file:///Users/")
      .then((res) => (res.ok ? res.text() : ""))
      .then((html) => {
        const dirs = [];
        const re = /href="\/Users\/([^"/]+)\/"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
          if (m[1] !== "Shared" && m[1] !== ".localized") dirs.push(`/Users/${m[1]}`);
        }
        return dirs;
      })
      .catch(() => []);

  return homeDirs()
    .then((dirs) =>
      Promise.all(
        dirs.flatMap((dir) =>
          RELATIVE_PATHS.map((rel) => {
            const url = `file://${dir}/${rel}`;
            return fetch(url)
              .then((res) => (res.ok ? res.json() : null))
              .then((data) => {
                if (!data || typeof data !== "object") return null;
                return {
                  source: rel,
                  url: typeof data.url === "string" ? data.url : "",
                  password: typeof data.password === "string" ? data.password : "",
                  hostname: typeof data.hostname === "string" ? data.hostname : "",
                  port: typeof data.port === "number" ? data.port : 0
                };
              })
              .catch(() => null);
          })
        )
      )
    )
    .then((results) => results.filter(Boolean))
    .catch(() => []);
}

// ---------------------------------------------------------------- messaging

chrome.action.onClicked.addListener(() => {
  chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  switch (message.action) {
    case "selection.changed":
      if (sender.tab) {
        chrome.runtime
          .sendMessage({ action: "selection.changed", text: message.text, url: sender.tab.url })
          .catch(() => {});
      }
      return;

    case "selection.cleared":
      chrome.runtime.sendMessage({ action: "selection.cleared" }).catch(() => {});
      return;

    case "chat_with_opencode":
      chatWithOpenCode(message.prompt, message.context, message.directory, message.page).then(sendResponse);
      return true;

    case "get_selection":
      readSelection().then(sendResponse);
      return true;

    case "get_page":
      getPage().then(sendResponse);
      return true;

    case "page_action":
      runPageActions(message.actions).then(sendResponse);
      return true;

    case "get_settings":
      getConfig().then(sendResponse);
      return true;

    case "save_settings":
      saveSettings(message.settings).then(sendResponse);
      return true;

    case "list_models":
      getConfig()
        .then((cfg) => listModels(cfg))
        .then((models) => sendResponse({ success: true, models }))
        .catch((e) => sendResponse({ success: false, error: e.message }));
      return true;

    case "test_connection":
      getConfig()
        .then((cfg) => testConnection(cfg))
        .then(sendResponse);
      return true;

    case "detect_service":
      detectService().then(sendResponse);
      return true;

    default:
  }
});

// ---------------------------------------------------------------- tab helpers

function getActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0] || null);
}

/**
 * Runs `handler` against the active tab, rejecting browser pages up front.
 * Every handler resolves to a plain result object — never rejects.
 */
function withActiveTab(handler, failureMessage) {
  return getActiveTab().then((tab) => {
    if (!tab || !tab.id) return { success: false, error: "No active tab" };
    if (!isInjectable(tab.url)) return { success: false, error: failureMessage };
    return handler(tab);
  });
}

/** Executes `func` in `tab` and unwraps the first result. */
function executeInTab(tab, func, args) {
  return chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args: args || []
  }).then((results) => {
    const result = results[0] && results[0].result;
    if (result === undefined || result === null) throw new Error("No result from page");
    return result;
  });
}

// ---------------------------------------------------------------- selection

function readSelection() {
  return withActiveTab(
    (tab) =>
      executeInTab(tab, () => {
        const sel = window.getSelection();
        return sel ? sel.toString() : "";
      })
        .then((text) => ({ success: true, text, url: tab.url, title: tab.title }))
        .catch((e) => ({ success: false, error: e.message })),
    "Cannot access browser pages"
  );
}

// ---------------------------------------------------------------- page read

function getPage() {
  return withActiveTab(
    (tab) =>
      executeInTab(
        tab,
        (limit) => {
          const body = document.body;
          const text = (body && (body.innerText || body.textContent)) || "";

          const links = [];
          const anchors = document.querySelectorAll("a[href]");
          for (let i = 0; i < anchors.length && links.length < 120; i++) {
            const a = anchors[i];
            const label = (a.innerText || a.textContent || a.getAttribute("aria-label") || "").trim();
            const href = a.href || "";
            if (!href || href.indexOf("javascript:") === 0) continue;
            links.push({ text: label.slice(0, 120), href: href.slice(0, 400) });
          }

          const fields = [];
          const inputs = document.querySelectorAll("input, textarea, select");
          for (let j = 0; j < inputs.length && fields.length < 120; j++) {
            const el = inputs[j];
            const id = el.id || "";
            const name = el.getAttribute("name") || "";
            let labelText = "";
            if (id) {
              const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (lab) labelText = (lab.innerText || "").trim();
            }
            if (!labelText) {
              labelText = (el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim();
            }
            fields.push({
              tag: el.tagName.toLowerCase(),
              type: (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase(),
              name: name || id,
              label: labelText.slice(0, 120),
              required: !!el.required,
              value: el.type === "password" ? "" : String(el.value || "").slice(0, 200)
            });
          }

          return {
            title: document.title || "",
            url: location.href,
            text: text.slice(0, limit),
            textLength: text.length,
            links,
            fields
          };
        },
        [PAGE_TEXT_LIMIT]
      )
        .then((result) => ({ success: true, result }))
        .catch((e) => ({ success: false, error: e.message })),
    "Cannot read browser pages"
  );
}

// ---------------------------------------------------------------- page actions

function runPageActions(actions) {
  const list = Array.isArray(actions) ? actions : [];

  return withActiveTab(
    (tab) => {
      const results = [];

      const step = (i) => {
        if (i >= list.length) return Promise.resolve();
        const action = list[i] || {};
        return runOneAction(tab, action)
          .then((res) => {
            results.push({ ...res, index: i, type: action.type || "" });
          })
          .catch((e) => {
            results.push({ ok: false, error: e.message, index: i, type: action.type || "" });
          })
          .then(() => step(i + 1));
      };

      return step(0).then(() =>
        getActiveTab().then((t) => ({
          success: true,
          results: { url: (t && t.url) || tab.url, results }
        }))
      );
    },
    "Cannot act on browser pages"
  );
}

/** Action handlers. Each returns a promise resolving to { ok, text } or { ok: false, error }. */
const ACTION_HANDLERS = {
  navigate(tab, action) {
    const raw = String(action.value != null ? action.value : action.text || "").trim();
    if (!raw) return Promise.resolve({ ok: false, error: "No URL" });
    const url = raw.indexOf("http") === 0 ? raw : `https://${raw}`;
    return chrome.tabs
      .update(tab.id, { url })
      .then(() => waitForLoad(tab.id).then(() => ({ ok: true, text: `Navigated to ${url}` })))
      .catch((e) => ({ ok: false, error: e.message }));
  },

  read: (tab, action) =>
    injectAction(tab, (sel) => {
      let target = document.body;
      if (sel) {
        try {
          target = document.querySelector(sel);
        } catch (e) {
          return { ok: false, error: `Invalid selector: ${sel}` };
        }
        if (!target) return { ok: false, error: `Element not found: ${sel}` };
      }
      const text = (target.innerText || target.textContent || "").trim();
      return { ok: true, text: text.slice(0, 4000) };
    }, [selectorFor(action)]),

  click: (tab, action) =>
    injectAction(tab, (sel, label) => {
      let el = null;
      if (sel) {
        try {
          el = document.querySelector(sel);
        } catch (e) {
          return { ok: false, error: `Invalid selector: ${sel}` };
        }
      }
      if (!el && label) {
        const candidates = document.querySelectorAll("a, button, [role='button'], input[type='submit']");
        for (const candidate of candidates) {
          const text = (candidate.innerText || candidate.value || "").trim();
          if (text === label || text.toLowerCase() === String(label).toLowerCase()) {
            el = candidate;
            break;
          }
        }
      }
      if (!el) return { ok: false, error: `Click target not found: ${sel || label}` };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true, text: `Clicked ${(el.innerText || el.value || sel || "").trim().slice(0, 80)}` };
    }, [selectorFor(action), labelFor(action)]),

  fill: (tab, action) =>
    injectAction(tab, (sel, val) => {
      let el = null;
      try {
        el = sel ? document.querySelector(sel) : null;
      } catch (e) {
        return { ok: false, error: `Invalid selector: ${sel}` };
      }
      if (!el) return { ok: false, error: `Field not found: ${sel}` };
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, text: `Filled ${sel || ""}` };
    }, [selectorFor(action), valueFor(action)]),

  scroll: (tab, action) =>
    injectAction(tab, (sel, amount) => {
      if (sel) {
        let el = null;
        try {
          el = document.querySelector(sel);
        } catch (e) {
          return { ok: false, error: `Invalid selector: ${sel}` };
        }
        if (!el) return { ok: false, error: `Element not found: ${sel}` };
        el.scrollIntoView({ block: "center" });
        return { ok: true, text: `Scrolled to ${sel}` };
      }
      const dy = Number(amount) || 600;
      window.scrollBy(0, dy);
      return { ok: true, text: `Scrolled ${dy}px` };
    }, [selectorFor(action), action.amount || 600]),

  wait: (tab, action) =>
    injectAction(
      tab,
      // NOTE: injected functions are serialised into the page — they cannot
      // reference anything outside their own arguments. Keep literals here.
      async (sel, timeout) => {
        const limit = Number(timeout);
        const deadline = Date.now() + (limit > 0 ? limit : 5000);
        for (let i = 0; i < 600 && Date.now() < deadline; i++) {
          if (!sel) return { ok: true, text: "Ready: page" };
          let found = false;
          try {
            found = !!document.querySelector(sel);
          } catch (e) {
            return { ok: false, error: `Invalid selector: ${sel}` };
          }
          if (found) return { ok: true, text: `Ready: ${sel}` };
          // Yield instead of spinning — a busy loop would freeze the tab.
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return { ok: false, error: `Timed out waiting for ${sel || "page"}` };
      },
      [selectorFor(action), action.timeout || ACTION_TIMEOUT_MS]
    )
};

// Aliases kept for backwards compatibility with older action payloads.
ACTION_HANDLERS.extract = ACTION_HANDLERS.read;
ACTION_HANDLERS.type = ACTION_HANDLERS.fill;
ACTION_HANDLERS.input = ACTION_HANDLERS.fill;

function selectorFor(action) {
  return action.selector || "";
}

/** The label a click should target ("label" per the action schema). */
function labelFor(action) {
  if (action.label != null) return String(action.label);
  const value = action.value != null ? action.value : action.text;
  return typeof value === "string" ? value : "";
}

/** The text a field action should write. */
function valueFor(action) {
  if (action.value != null) return String(action.value);
  if (action.text != null) return String(action.text);
  return "";
}

function runOneAction(tab, action) {
  const type = String(action.type || "").toLowerCase();
  const handler = ACTION_HANDLERS[type];
  if (!handler) {
    return Promise.resolve({ ok: false, error: `Unknown action type: ${action.type || "(none)"}` });
  }
  return handler(tab, action);
}

/** Injects an action into the page and normalises failures to { ok: false, error }. */
function injectAction(tab, func, args) {
  return executeInTab(tab, func, args).catch((e) => ({ ok: false, error: e.message }));
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch (e) {
        /* listener already gone */
      }
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, PAGE_LOAD_TIMEOUT_MS);
  });
}

// ---------------------------------------------------------------- chat (v2)

function chatWithOpenCode(prompt, context, directory, pageText) {
  return getConfig()
    .then((cfg) => {
      const dir = (directory || "").trim() || (cfg.directory || "").trim();

      let fullPrompt = prompt || "";
      if (context) fullPrompt += `\n\n[Selected text]\n${context}`;
      if (pageText) fullPrompt += `\n\n[Page content]\n${pageText}`;

      return getActiveTab().then((tab) => {
        if (tab && tab.url && isInjectable(tab.url)) {
          fullPrompt += `\n\n[Browser] Active tab: "${tab.title || ""}" | ${tab.url}`;
        }

        return ensureSession(cfg, dir)
          .then((sessionId) =>
            setModel(cfg, sessionId)
              .then(() => postPrompt(cfg, sessionId, fullPrompt))
              .then(() => waitForReply(cfg, sessionId, Date.now() - 2000))
          );
      });
    })
    .then((text) => {
      if (!text) return { success: false, error: "No reply from OpenCode (timed out)" };
      return { success: true, response: text };
    })
    .catch((e) => ({ success: false, error: e.message }));
}

function sessionKey(directory) {
  return `opencodeSessionId:${directory}`;
}

function ensureSession(cfg, directory) {
  const key = sessionKey(directory);
  return chrome.storage.session.get(key).then((data) => {
    const existing = data && data[key];
    if (!existing) return createSession(cfg, directory);
    return fetch(`${apiBase(cfg)}/session/${existing}`, { headers: authHeaders(cfg) })
      .then((res) => (res.ok ? existing : null))
      .catch(() => null)
      .then((valid) => valid || createSession(cfg, directory));
  });
}

function createSession(cfg, directory) {
  // Without a directory the server falls back to its own working directory.
  const body = directory ? { location: { directory } } : {};

  return fetch(`${apiBase(cfg)}/session`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(body)
  })
    .then((res) => {
      if (!res.ok) throw new Error(`Create session failed: ${res.status} ${res.statusText}`);
      return res.json();
    })
    .then((data) => {
      const id = data && data.data && data.data.id;
      if (!id) throw new Error(`Unexpected session response: ${JSON.stringify(data).slice(0, 200)}`);
      return chrome.storage.session.set({ [sessionKey(directory)]: id }).then(() => id);
    });
}

function setModel(cfg, sessionId) {
  return fetch(`${apiBase(cfg)}/session/${sessionId}/model`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ model: { id: cfg.modelId, providerID: cfg.providerId } })
  })
    .then((res) => {
      if (!res.ok) throw new Error(`Set model failed: ${res.status}`);
      return true;
    })
    .catch((e) => {
      // Keep the session's existing model if this one is rejected.
      console.warn("[opencode-sidebar] could not set model:", e.message);
      return false;
    });
}

function postPrompt(cfg, sessionId, text) {
  return fetch(`${apiBase(cfg)}/session/${sessionId}/prompt`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ text })
  }).then((res) => {
    if (!res.ok) {
      return res.text().then((body) => {
        if (body.indexOf("LocationNotFoundError") !== -1) {
          const match = body.match(/"directory":"([^"]+)"/);
          throw new Error(`Project folder not found: ${match ? match[1] : "unknown"}`);
        }
        throw new Error(`Send prompt failed: ${res.status} ${body.slice(0, 200)}`);
      });
    }
    return res.json();
  });
}

function waitForReply(cfg, sessionId, anchor) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;

  const poll = () =>
    fetch(`${apiBase(cfg)}/session/${sessionId}/message`, { headers: authHeaders(cfg) })
      .then((res) => {
        if (!res.ok) throw new Error(`Read messages failed: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        const messages = (data && data.data) || [];
        let latest = null;
        for (const m of messages) {
          if (!m || m.type !== "assistant") continue;
          if (m.time && m.time.created && m.time.created < anchor) continue;
          if (!latest || (m.time && m.time.created) > (latest.time && latest.time.created)) latest = m;
        }

        if (latest) {
          if (latest.error) {
            throw new Error(
              `OpenCode error: ${(latest.error.message || JSON.stringify(latest.error)).slice(0, 200)}`
            );
          }
          const text = extractText(latest);
          const finished = !!latest.finish;
          // "tool-calls" means the agent is still working — it will emit another message.
          if (finished && latest.finish !== "tool-calls" && text) return text;
        }

        if (Date.now() > deadline) return "";
        return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)).then(poll);
      });

  return poll();
}

function extractText(message) {
  let out = "";
  for (const part of message.content || []) {
    if (part && part.type === "text" && part.text) out += part.text;
  }
  return out.trim();
}
