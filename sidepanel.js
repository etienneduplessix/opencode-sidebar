const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const selectionBar = document.getElementById("selection-bar");
const selectionText = document.getElementById("selection-text");
const pageIndicator = document.getElementById("readpage-indicator");
const clearBtn = document.getElementById("clear");
const appearanceBtn = document.getElementById("appearance");
const directoryInput = document.getElementById("directory-input");

const MARK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M8 7 4 12l4 5"/><path d="M16 7l4 5-4 5"/><path d="M13.5 5 10.5 19"/></svg>';

let currentSelection = "";
let pageState = null;
let isProcessing = false;
let emptyEl = document.getElementById("empty");
const EMPTY_HTML = emptyEl ? emptyEl.outerHTML : "";

const PAGE_CONTEXT_LIMIT = 8000;

const ACTION_SCHEMA = [
  "",
  "Reply with one short paragraph, then a single JSON code block with the actions:",
  "",
  "```json",
  '{"actions":[{"type":"click","selector":"#submit","description":"Submit the form"}]}',
  "```",
  "",
  "Allowed action types:",
  "- navigate  {\"type\":\"navigate\",\"value\":\"https://example.com\"}",
  "- read      {\"type\":\"read\",\"selector\":\"#results\"}",
  "- click     {\"type\":\"click\",\"selector\":\"#submit\"}  (or \"label\":\"Sign in\")",
  "- fill      {\"type\":\"fill\",\"selector\":\"#email\",\"value\":\"a@b.c\"}",
  "- scroll    {\"type\":\"scroll\",\"selector\":\"#footer\"}  (or \"amount\":600)",
  "- wait      {\"type\":\"wait\",\"selector\":\".loaded\",\"timeout\":5000}"
].join("\n");

// ------------------------------------------------------------------ icons

function icon(path, width = 13) {
  return (
    '<svg width="' + width + '" height="' + width + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    path +
    "</svg>"
  );
}

const ICONS = {
  apply: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  copy: icon('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  run: icon('<path d="m5 3 14 9-14 9z"/>'),
  page: icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
  warn: icon(
    '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>' +
    '<path d="M12 9v4"/><path d="M12 17h.01"/>'
  )
};

// ------------------------------------------------------------------ helpers

function scrollToBottom(smooth) {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function dropEmptyState() {
  if (emptyEl && emptyEl.parentNode) emptyEl.remove();
  emptyEl = null;
}

function setStatus(state) {
  statusEl.classList.remove("ok", "err");
  if (state) statusEl.classList.add(state);
}

function updateSendState() {
  sendBtn.disabled = isProcessing || !promptEl.value.trim();
}

function updateClearState() {
  clearBtn.disabled = !messagesEl.querySelector(".row");
}

function autosize() {
  promptEl.style.height = "auto";
  promptEl.style.height = Math.min(promptEl.scrollHeight, 140) + "px";
}

function makeButton(label, iconSvg, primary) {
  const btn = document.createElement("button");
  btn.className = primary ? "btn primary" : "btn";
  if (iconSvg) btn.insertAdjacentHTML("afterbegin", iconSvg);
  const span = document.createElement("span");
  span.className = "btn-label";
  span.textContent = label;
  btn.appendChild(span);
  return btn;
}

// ------------------------------------------------------------------ wiring

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "selection.changed") {
    currentSelection = message.text;
    selectionText.textContent = message.text;
    selectionBar.classList.add("visible");
  }
  if (message?.action === "selection.cleared") {
    currentSelection = "";
    selectionBar.classList.remove("visible");
  }
  if (message?.action === "relay.connected") {
    statusEl.classList.add("connected");
  }
});

sendBtn.addEventListener("click", () => send());

promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

promptEl.addEventListener("input", () => {
  autosize();
  updateSendState();
});

clearBtn.addEventListener("click", () => {
  messagesEl.innerHTML = "";
  const tpl = document.createElement("template");
  tpl.innerHTML = EMPTY_HTML;
  messagesEl.appendChild(tpl.content.firstElementChild);
  emptyEl = messagesEl.firstElementChild;
  updateClearState();
});

document.querySelectorAll(".quick-actions .chip").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;

    if (action === "readpage") {
      await readPage();
      return;
    }

    const prompts = {
      fix: "Fix the grammar and spelling of this text:",
      shorten: "Shorten this text while keeping the key points:",
      explain: "Explain this text in simple terms:",
      rewrite: "Rewrite this text more clearly:",
      summarize: "Summarize this page.",
      act: "Look at this page. What can be done here? Suggest actions." + ACTION_SCHEMA
    };
    const prompt = prompts[action];
    if (!prompt) return;

    if (action === "summarize" || action === "act") {
      const ok = await ensurePage(true);
      if (!ok) return;
    }

    promptEl.value = prompt;
    autosize();
    await send();
  });
});

// ------------------------------------------------------------------ page

async function ensurePage(silent) {
  if (pageState) return true;
  const res = await chrome.runtime.sendMessage({ action: "get_page" });
  if (!res?.success) {
    if (!silent) addMessage("Could not read page: " + (res?.error || "unknown"), "error");
    return false;
  }
  pageState = res.result;
  pageIndicator.classList.add("visible");
  return true;
}

async function readPage() {
  addMessage("Reading page...", "assistant");
  const res = await chrome.runtime.sendMessage({ action: "get_page" });
  if (res?.success && res.result) {
    pageState = res.result;
    pageIndicator.classList.add("visible");
    addMessage(
      "Page loaded: " + pageState.title + " (" + pageState.url + ")\n" +
      (pageState.text
        ? pageState.textLength + " chars, " + pageState.links.length + " links, " + pageState.fields.length + " fields"
        : "no text"),
      "assistant"
    );
  } else {
    addMessage("Could not read page: " + (res?.error || "unknown"), "error");
  }
}

function pageContextText() {
  if (!pageState) return "";
  const text = (pageState.text || "").slice(0, PAGE_CONTEXT_LIMIT);
  return "[Page] " + pageState.title + "\n[URL] " + pageState.url + "\n\n" + text;
}

// ------------------------------------------------------------------ chat

async function send() {
  const prompt = promptEl.value.trim();
  if (!prompt || isProcessing) return;

  isProcessing = true;
  updateSendState();
  addMessage(prompt, "user");
  promptEl.value = "";
  autosize();

  const thinking = showThinking();

  const wantsPage = /page|article|content|summar|this tab|site/i.test(prompt);
  if (wantsPage) await ensurePage(true);

  const response = await chrome.runtime.sendMessage({
    action: "chat_with_opencode",
    prompt: prompt,
    context: currentSelection,
    page: wantsPage ? pageContextText() : "",
    directory: directoryInput?.value.trim() || undefined
  });

  thinking.remove();

  if (response?.success) {
    setStatus("ok");
    const raw = response.response || "";
    const actions = parseActions(raw);
    addMessage(stripJson(raw), "assistant", !!currentSelection, actions);
  } else {
    setStatus("err");
    addMessage(response?.error || "Unknown error", "error");
  }

  isProcessing = false;
  updateSendState();
  scrollToBottom(true);
}

function showThinking() {
  dropEmptyState();
  const row = document.createElement("div");
  row.className = "row";

  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.innerHTML = MARK_SVG;

  const bubble = document.createElement("div");
  bubble.className = "msg thinking";
  bubble.setAttribute("role", "status");
  bubble.setAttribute("aria-label", "OpenCode is thinking");
  bubble.innerHTML = "<i></i><i></i><i></i>";

  row.appendChild(avatar);
  row.appendChild(bubble);
  messagesEl.appendChild(row);
  scrollToBottom(true);
  return row;
}

function parseActions(text) {
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (Array.isArray(parsed.actions)) return parsed.actions;
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    return null;
  }
  return null;
}

function stripJson(text) {
  return text.replace(/```json[\s\S]*?```/g, "").trim();
}

function addMessage(text, role, showActions = false, actions = null) {
  dropEmptyState();

  const row = document.createElement("div");
  row.className = role === "user" ? "row me" : "row";

  if (role !== "user") {
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.innerHTML = MARK_SVG;
    row.appendChild(avatar);
  }

  const div = document.createElement("div");
  div.className = `msg ${role}`;

  if (role === "error") {
    div.setAttribute("role", "alert");
    const warn = document.createElement("span");
    warn.className = "msg-icon";
    warn.innerHTML = ICONS.warn;
    div.appendChild(warn);
  }

  const body = document.createElement("span");
  body.className = "msg-body";
  body.textContent = text;
  div.appendChild(body);

  const actionsBar = document.createElement("div");
  actionsBar.className = "actions";

  if (showActions && currentSelection) {
    const applyBtn = makeButton("Apply to page", ICONS.apply, false);
    applyBtn.addEventListener("click", () => applyToPage(text));
    actionsBar.appendChild(applyBtn);

    const copyBtn = makeButton("Copy", ICONS.copy, false);
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text);
      copyBtn.querySelector(".btn-label").textContent = "Copied";
      setTimeout(() => (copyBtn.querySelector(".btn-label").textContent = "Copy"), 1400);
    });
    actionsBar.appendChild(copyBtn);
  }

  if (actions && actions.length > 0) {
    const runBtn = makeButton(`Run ${actions.length} action${actions.length > 1 ? "s" : ""}`, ICONS.run, true);
    runBtn.addEventListener("click", () => runActions(actions));
    actionsBar.appendChild(runBtn);
  }

  if (actionsBar.children.length > 0) div.appendChild(actionsBar);

  row.appendChild(div);
  messagesEl.appendChild(row);
  scrollToBottom(false);
  updateClearState();
}

async function runActions(actions) {
  addMessage("Running " + actions.length + " action" + (actions.length > 1 ? "s" : "") + "...", "assistant");
  const res = await chrome.runtime.sendMessage({ action: "page_action", actions });
  if (!res?.success) {
    addMessage("Actions failed: " + (res?.error || "unknown"), "error");
    return;
  }
  const results = (res.results && res.results.results) || [];
  for (const r of results) {
    const action = actions[r.index] || {};
    if (r.ok) {
      addMessage("✓ " + (action.type || "action") + (r.text ? ": " + r.text : ""), "assistant");
    } else {
      addMessage("✗ " + (action.type || "action") + " failed: " + (r.error || "unknown"), "error");
    }
  }
  addMessage("Done. URL: " + (res.results && res.results.url), "assistant");
}

async function applyToPage(replacement) {
  const cleaned = stripJson(replacement);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: function (original, repl) {
      // Serialised into the page: no closure variables allowed in here.
      let walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.next())) {
        const text = node.textContent;
        const idx = text.indexOf(original);
        if (idx !== -1) {
          node.textContent = text.substring(0, idx) + repl + text.substring(idx + original.length);
          return { success: true };
        }
      }
      const normalized = original.replace(/\s+/g, " ").trim().toLowerCase();
      walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while ((node = walker.next())) {
        const text = node.textContent;
        const norm = text.replace(/\s+/g, " ").trim().toLowerCase();
        const idx = norm.indexOf(normalized);
        if (idx !== -1) {
          const actualStart = text.toLowerCase().indexOf(normalized.charAt(0), Math.max(0, idx - 5));
          const actualText = text.substring(actualStart, actualStart + original.length);
          node.textContent = text.substring(0, actualStart) + repl + text.substring(actualStart + actualText.length);
          return { success: true, fuzzy: true };
        }
      }
      return { success: false, error: "Selection not found in page" };
    },
    args: [currentSelection, cleaned]
  });

  const result = results[0]?.result;
  if (result?.success) {
    addMessage("Applied to page" + (result.fuzzy ? " (fuzzy match)" : ""), "assistant");
    currentSelection = "";
    selectionBar.classList.remove("visible");
  } else {
    addMessage("Could not apply: " + (result?.error || "not found"), "error");
  }
}

// ------------------------------------------------------------------ selection

// The content script pushes selection changes as they happen, so we only
// need one fetch when the panel opens (it may have missed earlier changes).
// Polling here would re-inject a script into the active tab every second.
function refreshSelection() {
  chrome.runtime.sendMessage({ action: "get_selection" }).then((res) => {
    if (res?.text && res.text !== currentSelection) {
      currentSelection = res.text;
      selectionText.textContent = res.text;
      selectionBar.classList.add("visible");
    } else if (!res?.text && currentSelection) {
      currentSelection = "";
      selectionBar.classList.remove("visible");
    }
  }).catch(() => {});
}

// ------------------------------------------------------------------ appearance

function applyAppearance(solid) {
  document.body.classList.toggle("solid", solid);
  appearanceBtn.setAttribute("aria-pressed", String(!solid));
  appearanceBtn.title = solid ? "Use frosted glass" : "Use solid surfaces";
}

appearanceBtn.addEventListener("click", () => {
  const solid = !document.body.classList.contains("solid");
  applyAppearance(solid);
  try {
    chrome.storage.local.set({ solid });
  } catch (e) {
    /* storage unavailable */
  }
});

try {
  chrome.storage.local.get("solid", (res) => applyAppearance(!!res?.solid));
} catch (e) {
  /* storage unavailable */
}

// ------------------------------------------------------------------ boot

updateSendState();
updateClearState();
refreshSelection();
