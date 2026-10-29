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

var DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 53213,
  username: "opencode",
  password: "REDACTED",
  modelId: "glm-5.3-flash",
  providerId: "ollama-cloud",
  directory: "/home/user/project"
};

var PAGE_TEXT_LIMIT = 12000;
var REPLY_TIMEOUT_MS = 180000;
var POLL_INTERVAL_MS = 1200;

function getConfig() {
  return chrome.storage.local.get("opencodeConfig").then(function (data) {
    return Object.assign({}, DEFAULT_CONFIG, (data && data.opencodeConfig) || {});
  });
}

function apiBase(cfg) {
  return "http://" + cfg.host + ":" + cfg.port + "/api";
}

function basicAuth(cfg) {
  var raw = cfg.username + ":" + cfg.password;
  try {
    return btoa(raw);
  } catch (e) {
    return btoa(unescape(encodeURIComponent(raw)));
  }
}

function authHeaders(cfg) {
  return {
    "Content-Type": "application/json",
    "Authorization": "Basic " + basicAuth(cfg)
  };
}

function isInjectable(url) {
  if (!url) return false;
  return (
    url.indexOf("chrome://") !== 0 &&
    url.indexOf("chrome-extension://") !== 0 &&
    url.indexOf("chrome-untrusted://") !== 0 &&
    url.indexOf("devtools://") !== 0 &&
    url.indexOf("about:") !== 0 &&
    url.indexOf("edge://") !== 0 &&
    url.indexOf("view-source:") !== 0
  );
}

// ---------------------------------------------------------------- messaging

chrome.action.onClicked.addListener(function () {
  chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== "object") return;

  if (message.action === "selection.changed" && sender.tab) {
    chrome.runtime.sendMessage({ action: "selection.changed", text: message.text, url: sender.tab.url }).catch(function () {});
    return;
  }
  if (message.action === "selection.cleared") {
    chrome.runtime.sendMessage({ action: "selection.cleared" }).catch(function () {});
    return;
  }
  if (message.action === "chat_with_opencode") {
    chatWithOpenCode(message.prompt, message.context, message.directory, message.page).then(sendResponse);
    return true;
  }
  if (message.action === "get_selection") {
    getSelection().then(sendResponse);
    return true;
  }
  if (message.action === "get_page") {
    getPage().then(sendResponse);
    return true;
  }
  if (message.action === "page_action") {
    runPageActions(message.actions).then(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------- selection

function getActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    return tabs[0] || null;
  });
}

function getSelection() {
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) return { success: false, error: "No active tab" };
    if (!isInjectable(tab.url)) return { success: false, error: "Cannot access browser pages" };
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        var sel = window.getSelection();
        return sel ? sel.toString() : "";
      }
    }).then(function (results) {
      return { success: true, text: results[0] ? results[0].result : "", url: tab.url, title: tab.title };
    }).catch(function (e) {
      return { success: false, error: e.message };
    });
  });
}

// ---------------------------------------------------------------- page read

function getPage() {
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) return { success: false, error: "No active tab" };
    if (!isInjectable(tab.url)) return { success: false, error: "Cannot read browser pages" };
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function (limit) {
        var body = document.body;
        var text = (body && (body.innerText || body.textContent)) || "";

        var links = [];
        var anchors = document.querySelectorAll("a[href]");
        for (var i = 0; i < anchors.length && links.length < 120; i++) {
          var a = anchors[i];
          var label = (a.innerText || a.textContent || a.getAttribute("aria-label") || "").trim();
          var href = a.href || "";
          if (!href || href.indexOf("javascript:") === 0) continue;
          links.push({ text: label.slice(0, 120), href: href.slice(0, 400) });
        }

        var fields = [];
        var inputs = document.querySelectorAll("input, textarea, select");
        for (var j = 0; j < inputs.length && fields.length < 120; j++) {
          var el = inputs[j];
          var id = el.id || "";
          var name = el.getAttribute("name") || "";
          var labelText = "";
          if (id) {
            var lab = document.querySelector('label[for="' + CSS.escape(id) + '"]');
            if (lab) labelText = (lab.innerText || "").trim();
          }
          if (!labelText) labelText = (el.getAttribute("placeholder") || el.getAttribute("aria-label") || "").trim();
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
          links: links,
          fields: fields
        };
      },
      args: [PAGE_TEXT_LIMIT]
    }).then(function (results) {
      var result = results[0] && results[0].result;
      if (!result) return { success: false, error: "Could not read page" };
      return { success: true, result: result };
    }).catch(function (e) {
      return { success: false, error: e.message };
    });
  });
}

// ---------------------------------------------------------------- page actions

function runPageActions(actions) {
  var list = Array.isArray(actions) ? actions : [];
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) return { success: false, error: "No active tab" };
    if (!isInjectable(tab.url)) return { success: false, error: "Cannot act on browser pages" };

    var results = [];

    function step(i) {
      if (i >= list.length) return Promise.resolve();
      var action = list[i] || {};
      return runOneAction(tab, action).then(function (res) {
        res.index = i;
        res.type = action.type || "";
        results.push(res);
        return step(i + 1);
      }).catch(function (e) {
        results.push({ index: i, type: action.type || "", ok: false, error: e.message });
        return step(i + 1);
      });
    }

    return step(0).then(function () {
      return getActiveTab().then(function (t) {
        return { success: true, results: { url: (t && t.url) || tab.url, results: results } };
      });
    });
  });
}

function runOneAction(tab, action) {
  var type = (action.type || "").toLowerCase();
  var value = action.value != null ? action.value : action.text;
  var selector = action.selector || (typeof value === "string" ? value : "");

  if (type === "navigate") {
    var url = String(value || "").trim();
    if (!url) return Promise.resolve({ ok: false, error: "No URL" });
    if (url.indexOf("http") !== 0) url = "https://" + url;
    return chrome.tabs.update(tab.id, { url: url }).then(function () {
      return waitForLoad(tab.id).then(function () {
        return { ok: true, text: "Navigated to " + url };
      });
    }).catch(function (e) {
      return { ok: false, error: e.message };
    });
  }

  if (type === "read" || type === "extract") {
    return inject(tab, function (sel) {
      var target = sel ? document.querySelector(sel) : document.body;
      if (!target) return { ok: false, error: "Element not found: " + sel };
      var text = (target.innerText || target.textContent || "").trim();
      return { ok: true, text: text.slice(0, 4000) };
    }, [selector]);
  }

  if (type === "click") {
    return inject(tab, function (sel, label) {
      var el = sel ? document.querySelector(sel) : null;
      if (!el && label) {
        var candidates = document.querySelectorAll("a, button, [role='button'], input[type='submit']");
        for (var i = 0; i < candidates.length; i++) {
          var t = (candidates[i].innerText || candidates[i].value || "").trim();
          if (t === label || t.toLowerCase() === String(label).toLowerCase()) { el = candidates[i]; break; }
        }
      }
      if (!el) return { ok: false, error: "Click target not found: " + (sel || label) };
      el.scrollIntoView({ block: "center" });
      el.click();
      return { ok: true, text: "Clicked " + ((el.innerText || el.value || sel || "").trim().slice(0, 80)) };
    }, [selector, typeof value === "string" ? value : ""]);
  }

  if (type === "fill" || type === "type" || type === "input") {
    return inject(tab, function (sel, val) {
      var el = sel ? document.querySelector(sel) : null;
      if (!el) return { ok: false, error: "Field not found: " + sel };
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, text: "Filled " + (sel || "") };
    }, [selector, action.text != null && action.value != null ? action.text : String(value || "")]);
  }

  if (type === "scroll") {
    return inject(tab, function (sel, amount) {
      if (sel) {
        var el = document.querySelector(sel);
        if (!el) return { ok: false, error: "Element not found: " + sel };
        el.scrollIntoView({ block: "center" });
        return { ok: true, text: "Scrolled to " + sel };
      }
      window.scrollBy(0, Number(amount) || 600);
      return { ok: true, text: "Scrolled " + (Number(amount) || 600) + "px" };
    }, [selector, action.amount || 600]);
  }

  if (type === "wait") {
    return inject(tab, function (sel, timeout) {
      var deadline = Date.now() + (Number(timeout) || 5000);
      while (Date.now() < deadline) {
        if (!sel || document.querySelector(sel)) return { ok: true, text: "Ready: " + (sel || "page") };
        var start = Date.now();
        while (Date.now() - start < 100) { /* spin briefly, bounded by the deadline */ }
      }
      return { ok: false, error: "Timed out waiting for " + (sel || "page") };
    }, [selector, action.timeout || 5000]);
  }

  return Promise.resolve({ ok: false, error: "Unknown action type: " + (action.type || "(none)") });
}

function inject(tab, func, args) {
  return chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: func,
    args: args || []
  }).then(function (results) {
    var r = results[0] && results[0].result;
    if (!r) return { ok: false, error: "No result" };
    return r;
  }).catch(function (e) {
    return { ok: false, error: e.message };
  });
}

function waitForLoad(tabId) {
  return new Promise(function (resolve) {
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { /* already gone */ }
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, 15000);
  });
}

// ---------------------------------------------------------------- chat (v2)

function chatWithOpenCode(prompt, context, directory, pageText) {
  return getConfig().then(function (cfg) {
    var dir = (directory || "").trim() || cfg.directory;

    var fullPrompt = prompt || "";
    if (context) fullPrompt += "\n\n[Selected text]\n" + context;
    if (pageText) fullPrompt += "\n\n[Page content]\n" + pageText;

    return getActiveTab().then(function (tab) {
      if (tab && tab.url && isInjectable(tab.url)) {
        fullPrompt += "\n\n[Browser] Active tab: \"" + (tab.title || "") + "\" | " + tab.url;
      }

      return ensureSession(cfg, dir).then(function (sessionId) {
        return setModel(cfg, sessionId).then(function () {
          var anchor = Date.now() - 2000;
          return postPrompt(cfg, sessionId, fullPrompt).then(function () {
            return waitForReply(cfg, sessionId, anchor);
          });
        });
      });
    });
  }).then(function (text) {
    if (!text) return { success: false, error: "No reply from OpenCode (timed out)" };
    return { success: true, response: text };
  }).catch(function (e) {
    return { success: false, error: e.message };
  });
}

function sessionKey(directory) {
  return "opencodeSessionId:" + directory;
}

function ensureSession(cfg, directory) {
  var key = sessionKey(directory);
  return chrome.storage.session.get(key).then(function (data) {
    var existing = data && data[key];
    if (!existing) return createSession(cfg, directory);
    return fetch(apiBase(cfg) + "/session/" + existing, { headers: authHeaders(cfg) })
      .then(function (res) { return res.ok ? existing : null; })
      .catch(function () { return null; })
      .then(function (valid) {
        return valid || createSession(cfg, directory);
      });
  });
}

function createSession(cfg, directory) {
  return fetch(apiBase(cfg) + "/session", {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ location: { directory: directory } })
  }).then(function (res) {
    if (!res.ok) throw new Error("Create session failed: " + res.status + " " + res.statusText);
    return res.json();
  }).then(function (data) {
    var id = data && data.data && data.data.id;
    if (!id) throw new Error("Unexpected session response: " + JSON.stringify(data).slice(0, 200));
    var payload = {};
    payload[sessionKey(directory)] = id;
    return chrome.storage.session.set(payload).then(function () { return id; });
  });
}

function setModel(cfg, sessionId) {
  return fetch(apiBase(cfg) + "/session/" + sessionId + "/model", {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ model: { id: cfg.modelId, providerID: cfg.providerId } })
  }).then(function (res) {
    if (!res.ok) throw new Error("Set model failed: " + res.status);
    return true;
  }).catch(function () {
    return false; // keep the session's existing model if this one is rejected
  });
}

function postPrompt(cfg, sessionId, text) {
  return fetch(apiBase(cfg) + "/session/" + sessionId + "/prompt", {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify({ text: text })
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (body) {
        if (body.indexOf("LocationNotFoundError") !== -1) {
          var match = body.match(/"directory":"([^"]+)"/);
          throw new Error("Project folder not found: " + (match ? match[1] : "unknown"));
        }
        throw new Error("Send prompt failed: " + res.status + " " + body.slice(0, 200));
      });
    }
    return res.json();
  });
}

function waitForReply(cfg, sessionId, anchor) {
  var deadline = Date.now() + REPLY_TIMEOUT_MS;

  function poll() {
    return fetch(apiBase(cfg) + "/session/" + sessionId + "/message", { headers: authHeaders(cfg) })
      .then(function (res) {
        if (!res.ok) throw new Error("Read messages failed: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var messages = (data && data.data) || [];
        var latest = null;
        for (var i = 0; i < messages.length; i++) {
          var m = messages[i];
          if (!m || m.type !== "assistant") continue;
          if (m.time && m.time.created && m.time.created < anchor) continue;
          if (!latest || (m.time && m.time.created) > (latest.time && latest.time.created)) latest = m;
        }

        if (latest) {
          if (latest.error) {
            throw new Error("OpenCode error: " + (latest.error.message || JSON.stringify(latest.error)).slice(0, 200));
          }
          var text = extractText(latest);
          var finished = !!latest.finish;
          // "tool-calls" means the agent is still working — it will emit another message.
          if (finished && latest.finish !== "tool-calls" && text) return text;
        }

        if (Date.now() > deadline) return "";
        return new Promise(function (resolve) {
          setTimeout(resolve, POLL_INTERVAL_MS);
        }).then(poll);
      });
  }

  return poll();
}

function extractText(message) {
  var out = "";
  var content = message.content || [];
  for (var i = 0; i < content.length; i++) {
    var part = content[i];
    if (part && part.type === "text" && part.text) out += part.text;
  }
  return out.trim();
}
