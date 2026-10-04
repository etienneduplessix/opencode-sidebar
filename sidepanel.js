const messagesEl = document.getElementById("messages");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status");
const selectionBar = document.getElementById("selection-bar");
const selectionText = document.getElementById("selection-text");

let currentSelection = "";
let isProcessing = false;

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

sendBtn.addEventListener("click", send);
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

document.querySelectorAll(".quick-actions button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    const prompts = {
      fix: "Fix the grammar and spelling of this text:",
      shorten: "Shorten this text while keeping the key points:",
      explain: "Explain this text in simple terms:",
      rewrite: "Rewrite this text more clearly:"
    };
    promptEl.value = `${prompts[action]}\n\n${currentSelection}`;
    send();
  });
});

async function send() {
  const prompt = promptEl.value.trim();
  if (!prompt || isProcessing) return;

  isProcessing = true;
  sendBtn.disabled = true;
  addMessage(prompt, "user");
  promptEl.value = "";

  const fullPrompt = currentSelection
    ? `${prompt}\n\nSelected text:\n""${currentSelection}""`
    : prompt;

  const response = await chrome.runtime.sendMessage({
    action: "chat_with_opencode",
    prompt: fullPrompt,
    context: currentSelection,
    directory: document.getElementById("directory-input").value.trim() || undefined
  });

  if (response?.success) {
    addMessage(formatResponse(response.response), "assistant", true);
  } else {
    addMessage(response?.error || "Unknown error", "error");
  }

  isProcessing = false;
  sendBtn.disabled = false;
}

function addMessage(text, role, showActions = false) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;

  if (showActions && currentSelection) {
    const actions = document.createElement("div");
    actions.className = "actions";

    const applyBtn = document.createElement("button");
    applyBtn.textContent = "Apply to page";
    applyBtn.addEventListener("click", () => applyToPage(text));

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });

    actions.append(applyBtn, copyBtn);
    div.append(actions);
  }

  messagesEl.append(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function applyToPage(replacement) {
  const response = await chrome.runtime.sendMessage({
    action: "execute_in_page",
    code: `
      (function() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while (node = walker.nextNode()) {
          if (node.textContent.includes(${JSON.stringify(currentSelection)})) {
            node.textContent = node.textContent.replace(
              ${JSON.stringify(currentSelection)},
              ${JSON.stringify(replacement)}
            );
            return { success: true };
          }
        }
        return { success: false, error: "Selection not found in page" };
      })()
    `
  });

  if (response?.result?.result?.value?.success) {
    addMessage("Applied to page", "assistant");
    currentSelection = "";
    selectionBar.classList.remove("visible");
  } else {
    addMessage("Could not apply: " + (response?.result?.result?.value?.error || "not found"), "error");
  }
}

function formatResponse(data) {
  if (typeof data === "string") return data;
  if (data?.text) return data.text;
  if (data?.content) return data.content;
  return JSON.stringify(data, null, 2);
}

chrome.runtime.sendMessage({ action: "get_selection" }).then((res) => {
  if (res?.text) {
    currentSelection = res.text;
    selectionText.textContent = res.text;
    selectionBar.classList.add("visible");
  }
});
