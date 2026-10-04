var OPENCODE_PORT = 53213;
var OPENCODE_TOKEN = "";

chrome.action.onClicked.addListener(function () {
  chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message !== "object") return;

  if (message.action === "execute_in_page") {
    executeInPage(message.code).then(sendResponse);
    return true;
  }
  if (message.action === "chat_with_opencode") {
    chatWithOpenCode(message.prompt, message.context).then(sendResponse);
    return true;
  }
  if (message.action === "get_selection") {
    getSelection().then(sendResponse);
    return true;
  }
  if (message.action === "apply_fix") {
    applyFix(message.original, message.replacement);
    sendResponse({ success: true });
    return true;
  }
});

function getActiveTabId() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    return tabs[0] && tabs[0].id;
  });
}

function executeInPage(code) {
  return getActiveTabId().then(function (tabId) {
    if (!tabId) return { success: false, error: "No active tab" };
    return chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (code) {
        return eval(code);
      },
      args: [code]
    }).then(function (results) {
      return { success: true, result: results[0] ? results[0].result : null };
    });
  });
}

function getSelection() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    var tab = tabs[0];
    if (!tab || !tab.id) return { success: false, error: "No active tab" };
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () {
        var sel = window.getSelection();
        return sel ? sel.toString() : "";
      }
    }).then(function (results) {
      return { success: true, text: results[0] ? results[0].result : "" };
    });
  });
}

function chatWithOpenCode(prompt, context, directory) {
  var headers = { "Content-Type": "application/json" };
  if (OPENCODE_TOKEN) headers["Authorization"] = "Bearer " + OPENCODE_TOKEN;

  var fullPrompt = prompt;
  if (context) {
    fullPrompt = prompt + "\n\nSelected text:\n" + context;
  }

  var body = {};
  if (directory) body.location = { directory: directory };

  return fetch("http://localhost:" + OPENCODE_PORT + "/api/session", {
    method: "POST",
    headers: headers,
    body: JSON.stringify(body)
  }).then(function (res) {
    if (!res.ok) throw new Error("Create session failed: " + res.status);
    return res.json();
  }).then(function (session) {
    return fetch("http://localhost:" + OPENCODE_PORT + "/api/session/" + session.id + "/message", {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        parts: [{ type: "text", text: fullPrompt }]
      })
    });
  }).then(function (res) {
    if (!res.ok) throw new Error("Send message failed: " + res.status);
    return res.json();
  }).then(function (data) {
    var text = "";
    if (data.parts) {
      for (var i = 0; i < data.parts.length; i++) {
        if (data.parts[i].text) text += data.parts[i].text;
      }
    }
    return { success: true, response: text || JSON.stringify(data) };
  }).catch(function (e) {
    return { success: false, error: e.message };
  });
}

function applyFix(original, replacement) {
  var escaped = JSON.stringify(original);
  var repl = JSON.stringify(replacement);
  executeInPage(
    "(function() {" +
    "var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);" +
    "var node;" +
    "while (node = walker.nextNode()) {" +
    "if (node.textContent.indexOf(" + escaped + ") !== -1) {" +
    "node.textContent = node.textContent.replace(" + escaped + ", " + repl + ");" +
    "return true;" +
    "}" +
    "}" +
    "return false;" +
    "})()"
  );
}
