let lastSelection = "";
let debounceTimer = null;

function safeSendMessage(payload) {
  try {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      return;
    }
    chrome.runtime.sendMessage(payload).catch(function () {});
  } catch (e) {
  }
}

document.addEventListener("mouseup", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      const sel = window.getSelection();
      const text = (sel && sel.toString().trim()) || "";
      if (text && text !== lastSelection) {
        lastSelection = text;
        safeSendMessage({
          action: "selection.changed",
          text: text,
          url: location.href
        });
      }
    } catch (e) {
    }
  }, 300);
});

document.addEventListener("keyup", (e) => {
  if (e.key === "Escape") {
    lastSelection = "";
    safeSendMessage({ action: "selection.cleared" });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "get_selection") {
    const sel = window.getSelection();
    sendResponse({ text: (sel && sel.toString()) || "" });
    return true;
  }
  if (message && message.action === "replace_selection") {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(message.text));
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "No selection" });
    }
    return true;
  }
  if (message && message.action === "highlight_selection") {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const span = document.createElement("span");
      span.style.backgroundColor = "rgba(139, 92, 246, 0.3)";
      span.style.borderRadius = "3px";
      try {
        range.surroundContents(span);
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: "Cannot highlight partial selection" });
      }
    } else {
      sendResponse({ success: false, error: "No selection" });
    }
    return true;
  }
});