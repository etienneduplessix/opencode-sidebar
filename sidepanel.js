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
const settingsBtn = document.getElementById("settings");
const settingsPopover = document.getElementById("settings-popover");
const settingsStatus = document.getElementById("settings-status");
const modelBtn = document.getElementById("model-btn");
const modelName = document.getElementById("model-name");
const modelPopover = document.getElementById("model-popover");
const modelList = document.getElementById("model-list");
const modelSearch = document.getElementById("model-search");
const modelCount = document.getElementById("model-count");

const setHost = document.getElementById("set-host");
const setPort = document.getElementById("set-port");
const setUser = document.getElementById("set-user");
const setPass = document.getElementById("set-pass");
const togglePass = document.getElementById("toggle-pass");
const detectBtn = document.getElementById("detect");
const testBtn = document.getElementById("test");
const pickConfigBtn = document.getElementById("pick-config");
const saveSettingsBtn = document.getElementById("save-settings");

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
    const message = response?.error || "Unknown error";
    addMessage(message, "error");
    // An auth failure is fixable in the settings — open them right away.
    if (/401|password|credential/i.test(message)) openSettings();
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

// ------------------------------------------------------------------ folder picker

const dirBrowse = document.getElementById("dir-browse");
const folderPopover = document.getElementById("folder-popover");
const dirSearch = document.getElementById("dir-search");
const dirCrumbs = document.getElementById("dir-crumbs");
const dirList = document.getElementById("dir-list");
const dirUse = document.getElementById("dir-use");
const dirCancel = document.getElementById("dir-cancel");

let currentDir = "";
let currentRoot = "";
let recentDirs = [];

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><path d="M3.5 20 8 12h13l-4.5 8z"/></svg>';

const CHEVRON_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

function setPopover(popover, open) {
  popover.hidden = !open;
  const trigger =
    popover === modelPopover ? modelBtn
    : popover === settingsPopover ? settingsBtn
    : dirBrowse;
  trigger.setAttribute("aria-expanded", String(open));
  if (open) {
    if (popover === modelPopover) {
      modelSearch.value = "";
      renderModels();
      setTimeout(() => modelSearch.focus(), 30);
    }
    if (popover === folderPopover) {
      setTimeout(() => dirSearch.focus(), 30);
    }
  }
}

function closePopovers() {
  setPopover(modelPopover, false);
  setPopover(settingsPopover, false);
  setPopover(folderPopover, false);
}

function escapeHtml(text) {
  return String(text).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}

function parentPath(path) {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx) + "/";
}

function renderCrumbs(path) {
  dirCrumbs.innerHTML = "";
  const parts = path.split("/").filter(Boolean);
  const root = document.createElement("button");
  root.textContent = "/";
  root.addEventListener("click", () => openFolder("/"));
  dirCrumbs.appendChild(root);

  let acc = "";
  for (const part of parts) {
    acc += "/" + part;
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    dirCrumbs.appendChild(sep);

    const btn = document.createElement("button");
    btn.textContent = part;
    btn.title = acc;
    const target = acc;
    btn.addEventListener("click", () => openFolder(target));
    dirCrumbs.appendChild(btn);
  }
}

function dirItem(name, path, options = {}) {
  const item = document.createElement("div");
  item.className = "dir-item";
  item.title = path;

  const icon = document.createElement("span");
  icon.innerHTML = FOLDER_ICON;
  icon.style.display = "flex";

  const label = document.createElement("span");
  label.className = "d-name";
  label.textContent = name;

  item.appendChild(icon);
  item.appendChild(label);

  if (options.showPath) {
    const sub = document.createElement("span");
    sub.className = "d-path";
    sub.textContent = path;
    item.appendChild(sub);
  } else {
    const go = document.createElement("span");
    go.className = "go";
    go.innerHTML = CHEVRON_ICON;
    item.appendChild(go);
  }

  item.addEventListener("click", () => {
    if (options.pick) chooseFolder(path);
    else openFolder(path);
  });
  return item;
}

function renderDirs(dirs) {
  if (!dirs.length) {
    const empty = document.createElement("div");
    empty.className = "dir-empty";
    empty.textContent = "No subfolders here.";
    dirList.appendChild(empty);
    return;
  }

  const up = dirItem("..", parentPath(currentDir), {});
  up.querySelector(".d-name").textContent = "..";
  dirList.appendChild(up);

  for (const dir of dirs) {
    dirList.appendChild(dirItem(dir.name, dir.path, {}));
  }
}

/** The projects opencode already knows about — the quickest way to switch. */
async function renderProjects() {
  const res = await chrome.runtime.sendMessage({ action: "list_projects" });
  const projects = (res && res.projects) || [];
  if (!projects.length) return false;

  const heading = document.createElement("div");
  heading.className = "dir-group";
  heading.textContent = "Your projects";
  dirList.appendChild(heading);

  for (const project of projects.slice(0, 10)) {
    dirList.appendChild(dirItem(project.name, project.path, { showPath: true, pick: true }));
  }
  return true;
}

function showMessage(text) {
  dirList.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "dir-empty";
  empty.innerHTML = text;
  dirList.appendChild(empty);
}

async function openFolder(path) {
  currentDir = path || "/";
  renderCrumbs(currentDir);
  showMessage("Reading…");

  const res = await chrome.runtime.sendMessage({ action: "list_dirs", path: currentDir });
  if (!res?.success) {
    showMessage("Can't read this folder.<br><code>" + escapeHtml(res?.error || "unknown error") + "</code>");
    return;
  }
  currentRoot = res.root || currentRoot;
  currentDir = res.path || currentDir;
  renderCrumbs(currentDir);

  dirList.innerHTML = "";
  await renderProjects();

  const heading = document.createElement("div");
  heading.className = "dir-group";
  heading.textContent = "Folders";
  dirList.appendChild(heading);
  renderDirs(res.dirs || []);
}

async function searchFolders(query) {
  const q = query.trim();
  if (!q) return openFolder(currentDir || "/");

  showMessage("Searching…");
  const res = await chrome.runtime.sendMessage({ action: "find_dirs", query: q });
  if (!res?.success) {
    showMessage("Search failed.<br><code>" + escapeHtml(res?.error || "unknown error") + "</code>");
    return;
  }
  dirCrumbs.innerHTML = "";
  const dirs = res.dirs || [];
  if (!dirs.length) {
    showMessage("No folders match “" + escapeHtml(q) + "”.");
    return;
  }
  dirList.innerHTML = "";
  const heading = document.createElement("div");
  heading.className = "dir-group";
  heading.textContent = `${dirs.length} match${dirs.length === 1 ? "" : "es"}`;
  dirList.appendChild(heading);
  for (const dir of dirs) {
    dirList.appendChild(dirItem(dir.name, dir.path, { showPath: true, pick: true }));
  }
}

async function showProjects() {
  const res = await chrome.runtime.sendMessage({ action: "list_projects" });
  const projects = (res && res.projects) || [];
  if (!projects.length) return;

  dirList.innerHTML = "";
  const heading = document.createElement("div");
  heading.className = "dir-group";
  heading.textContent = "Your projects";
  dirList.appendChild(heading);

  for (const project of projects.slice(0, 12)) {
    dirList.appendChild(dirItem(project.name, project.path, { showPath: true, pick: true }));
  }
}

function chooseFolder(path) {
  if (!path) return;
  directoryInput.value = path;
  rememberDir(path);
  closePopovers();
}

function rememberDir(path) {
  recentDirs = [path, ...recentDirs.filter((p) => p !== path)].slice(0, 6);
  try {
    chrome.storage.local.set({ recentDirs });
  } catch (e) {
    /* storage unavailable */
  }
}

async function openFolderPicker() {
  closePopovers();
  setPopover(folderPopover, true);
  dirSearch.value = "";
  showMessage("Reading…");

  const start = directoryInput.value.trim();
  await openFolder(start || "/");
}

dirBrowse.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = folderPopover.hidden;
  closePopovers();
  if (willOpen) openFolderPicker();
});

let searchTimer = null;
dirSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchFolders(dirSearch.value), 220);
});

dirCancel.addEventListener("click", closePopovers);

dirUse.addEventListener("click", () => chooseFolder(currentDir));

// ------------------------------------------------------------------ model picker

let allModels = [];
let currentModelId = "";
let currentProviderId = "";

function renderModels() {
  const query = modelSearch.value.trim().toLowerCase();
  const matches = allModels.filter((m) => {
    if (!query) return true;
    return (
      m.name.toLowerCase().includes(query) ||
      m.id.toLowerCase().includes(query) ||
      m.providerID.toLowerCase().includes(query)
    );
  });

  modelList.innerHTML = "";

  if (!allModels.length) {
    const empty = document.createElement("div");
    empty.className = "model-item";
    empty.style.color = "var(--text-3)";
    empty.textContent = "No models loaded — check the connection settings.";
    modelList.appendChild(empty);
    modelCount.textContent = "";
    return;
  }

  // Group by provider, keep the order the server returned.
  const groups = [];
  const index = new Map();
  for (const m of matches) {
    if (!index.has(m.providerID)) {
      index.set(m.providerID, groups.length);
      groups.push({ provider: m.providerID, models: [] });
    }
    groups[index.get(m.providerID)].models.push(m);
  }

  const LIMIT = 80;
  let shown = 0;
  for (const group of groups) {
    if (shown >= LIMIT) break;
    const heading = document.createElement("div");
    heading.className = "model-group";
    heading.textContent = group.provider;
    modelList.appendChild(heading);

    for (const m of group.models) {
      if (shown >= LIMIT) break;
      shown++;
      const item = document.createElement("div");
      item.className = "model-item" + (m.id === currentModelId && m.providerID === currentProviderId ? " selected" : "");
      const name = document.createElement("span");
      name.className = "m-name";
      name.textContent = m.name;
      const id = document.createElement("span");
      id.className = "m-id";
      id.textContent = m.id;
      item.appendChild(name);
      item.appendChild(id);
      item.addEventListener("click", () => selectModel(m));
      modelList.appendChild(item);
    }
  }

  modelCount.textContent =
    shown < matches.length ? `${shown} of ${matches.length} shown` : `${matches.length} model${matches.length === 1 ? "" : "s"}`;
}

function syncModelLabel() {
  const found = allModels.find(
    (m) => m.id === currentModelId && m.providerID === currentProviderId
  );
  const label = found ? found.name : currentModelId;
  modelName.textContent = label || "Model";
  modelName.title = found ? `${found.name} — ${found.providerID}` : currentModelId || "No model selected";
}

async function loadModels() {
  const res = await chrome.runtime.sendMessage({ action: "list_models" });
  if (!res?.success) {
    allModels = [];
    modelCount.textContent = res?.error || "Could not load models";
    renderModels();
    return;
  }
  allModels = res.models || [];
  syncModelLabel();
  renderModels();
}

function selectModel(model) {
  currentModelId = model.id;
  currentProviderId = model.providerID;
  syncModelLabel();
  chrome.runtime.sendMessage({
    action: "save_settings",
    settings: { modelId: model.id, providerId: model.providerID }
  });
  closePopovers();
}

// ------------------------------------------------------------------ service config

/**
 * Reads opencode's service.json through the File System Access API.
 *
 * The password only exists in that file, and this is the only way to reach it
 * without asking the user for "Allow access to file URLs". The user picks the
 * folder that contains service.json — either ~/.config/opencode or
 * ~/.local/state/opencode — and the handle is remembered for next time.
 */
async function pickServiceConfig() {
  if (typeof window.showDirectoryPicker !== "function") {
    showSettingsStatus("This browser cannot open a folder picker. Use Auto-detect instead.", "err");
    return;
  }

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "read", startIn: await lastHandle() || undefined });
  } catch (e) {
    if (e && e.name === "AbortError") return; // user cancelled
    showSettingsStatus("Could not open the folder picker: " + (e.message || e), "err");
    return;
  }

  showSettingsStatus("Reading service.json…");

  try {
    const fileHandle = await dirHandle.getFileHandle("service.json");
    const file = await fileHandle.getFile();
    const data = JSON.parse(await file.text());

    const settings = {};
    if (typeof data.password === "string") settings.password = data.password;
    if (typeof data.hostname === "string" && data.hostname) settings.host = data.hostname;
    if (typeof data.port === "number" && data.port) settings.port = data.port;
    if (typeof data.url === "string" && data.url) {
      try {
        const url = new URL(data.url);
        settings.host = url.hostname;
        settings.port = Number(url.port) || 80;
      } catch (e) {
        /* ignore malformed url */
      }
    }

    if (!settings.password) {
      showSettingsStatus("That folder's service.json has no password.", "err");
      return;
    }

    await rememberHandle(dirHandle);
    await chrome.runtime.sendMessage({ action: "save_settings", settings });
    fillSettings({ ...(await chrome.runtime.sendMessage({ action: "get_settings" })) });
    showSettingsStatus(`Loaded the password from ${dirHandle.name}/service.json`, "ok");
  } catch (e) {
    showSettingsStatus(
      e && e.name === "NotFoundError"
        ? "No service.json in that folder — pick ~/.config/opencode"
        : "Could not read service.json: " + (e.message || e),
      "err"
    );
  }
}

// --- remembering the picked folder (IndexedDB, since handles are not JSON)

function idb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("opencode-sidebar", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rememberHandle(handle) {
  try {
    const db = await idb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readwrite");
      tx.objectStore("handles").put(handle, "serviceDir");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    /* not critical */
  }
}

async function lastHandle() {
  try {
    const db = await idb();
    const handle = await new Promise((resolve, reject) => {
      const tx = db.transaction("handles", "readonly");
      const req = tx.objectStore("handles").get("serviceDir");
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------ settings

function showSettingsStatus(text, kind) {
  settingsStatus.textContent = text;
  settingsStatus.className = "popover-status show" + (kind ? " " + kind : "");
}

function openSettings() {
  closePopovers();
  setPopover(settingsPopover, true);
  loadSettings();
}

function fillSettings(settings) {
  setHost.value = settings.host || "";
  setPort.value = settings.port || "";
  setUser.value = settings.username || "";
  setPass.value = settings.password || "";
}

async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ action: "get_settings" });
  if (settings) {
    fillSettings(settings);
    currentModelId = settings.modelId || "";
    currentProviderId = settings.providerId || "";
  }
  return settings;
}

async function saveSettings() {
  const settings = {
    host: setHost.value,
    port: setPort.value,
    username: setUser.value,
    password: setPass.value
  };
  const res = await chrome.runtime.sendMessage({ action: "save_settings", settings });
  if (res) {
    fillSettings(res);
    showSettingsStatus("Saved. These credentials are stored locally in the extension.", "ok");
  }
  return res;
}

async function testConnection() {
  showSettingsStatus("Testing…");
  const res = await chrome.runtime.sendMessage({ action: "test_connection" });
  if (res?.success) {
    showSettingsStatus(`Connected to ${res.url}`, "ok");
  } else {
    showSettingsStatus(res?.error || "Could not reach the server", "err");
  }
}

async function detectService() {
  showSettingsStatus("Looking for a running opencode server…");
  const res = await chrome.runtime.sendMessage({ action: "detect_service" });
  if (res?.success) {
    fillSettings(res);
    showSettingsStatus(`Found opencode at ${res.host}:${res.port} (${res.source || "detected"})`, "ok");
    loadModels();
  } else {
    showSettingsStatus(res?.error || "Nothing found", "err");
  }
}

// ------------------------------------------------------------------ popovers

modelBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = modelPopover.hidden;
  closePopovers();
  if (willOpen) {
    setPopover(modelPopover, true);
    loadModels();
  }
});

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = settingsPopover.hidden;
  closePopovers();
  if (willOpen) {
    setPopover(settingsPopover, true);
    loadSettings();
  }
});
modelSearch.addEventListener("input", renderModels);

document.addEventListener("click", (e) => {
  if (e.target.closest(".popover") || e.target.closest(".model-btn") || e.target.closest(".dir-browse")) return;
  closePopovers();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closePopovers();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    closePopovers();
    setPopover(modelPopover, true);
    loadModels();
  }
});

togglePass.addEventListener("click", () => {
  const showing = setPass.type === "text";
  setPass.type = showing ? "password" : "text";
  togglePass.title = showing ? "Show password" : "Hide password";
  togglePass.setAttribute("aria-label", togglePass.title);
});

detectBtn.addEventListener("click", detectService);
testBtn.addEventListener("click", testConnection);
pickConfigBtn.addEventListener("click", pickServiceConfig);
saveSettingsBtn.addEventListener("click", saveSettings);

setHost.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });
setPort.addEventListener("keydown", (e) => { if (e.key === "Enter") saveSettings(); });

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

loadSettings().then((settings) => {
  if (!settings) return;
  currentModelId = settings.modelId || "";
  currentProviderId = settings.providerId || "";
  syncModelLabel();
  // Refresh the friendly model name in the background, without blocking the UI.
  loadModels().catch(() => {});
});

try {
  chrome.storage.local.get("recentDirs", (data) => {
    recentDirs = (data && data.recentDirs) || [];
  });
} catch (e) {
  /* storage unavailable */
}

// Typing a path by hand still counts as using that folder.
directoryInput.addEventListener("change", () => {
  const path = directoryInput.value.trim();
  if (path) rememberDir(path);
});
