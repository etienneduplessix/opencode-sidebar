let lastSelection = "";
let debounceTimer = null;

document.addEventListener("mouseup", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() || "";
    if (text && text !== lastSelection) {
      lastSelection = text;
      chrome.runtime.sendMessage({
        action: "selection.changed",
        text,
        url: location.href
      }).catch(() => {});
    }
  }, 300);
});

document.addEventListener("keyup", (e) => {
  if (e.key === "Escape") {
    lastSelection = "";
    chrome.runtime.sendMessage({ action: "selection.cleared" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sendResponse) => {
  if (message?.action === "get_selection") {
    const sel = window.getSelection();
    sendResponse({ text: sel?.toString() || "" });
    return true;
  }
  if (message?.action === "replace_selection") {
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
  if (message?.action === "highlight_selection") {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      const span = document.createElement("span");
      span.style.backgroundColor = "rgba(139, 92, 246, 0.3)";
      span.style.borderRadius = "3px";
      try {
        range.surroundContents(span);
        sendResponse({ success: true });
      } catch {
        sendResponse({ success: false, error: "Cannot highlight partial selection" });
      }
    } else {
      sendResponse({ success: false, error: "No selection" });
    }
    return true;
  }
});
