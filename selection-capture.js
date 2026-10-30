// OpenCode Sidebar — content script
// Watches the page selection and reports it to the side panel.
//
// The background service worker reads selections authoritatively via
// chrome.scripting, so this script only pushes *changes*. It deliberately
// registers no runtime message listener: answering "get_selection" from
// every open tab would race the background's response and could return a
// selection from the wrong tab.
//
// Chrome only injects manifest content scripts into pages loaded after the
// extension was installed, so the background may inject this file into an
// already-open tab. The guard below keeps that from registering the
// listeners twice.

(function () {
  if (window.__opencodeSidebarCapture) return;
  window.__opencodeSidebarCapture = true;

  let lastSelection = "";
  let debounceTimer = null;

  function safeSendMessage(payload) {
    try {
      if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
      chrome.runtime.sendMessage(payload).catch(() => {});
    } catch (e) {
      /* extension context torn down */
    }
  }

  function currentSelection() {
    try {
      const sel = window.getSelection();
      return (sel && sel.toString().trim()) || "";
    } catch (e) {
      return "";
    }
  }

  function publish() {
    const text = currentSelection();
    if (!text) {
      if (lastSelection) {
        lastSelection = "";
        safeSendMessage({ action: "selection.cleared" });
      }
      return;
    }
    if (text !== lastSelection) {
      lastSelection = text;
      safeSendMessage({ action: "selection.changed", text, url: location.href });
    }
  }

  function schedulePublish() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(publish, 250);
  }

  // selectionchange covers mouse drags *and* keyboard selection
  // (shift+arrow), which a mouseup-only listener would miss.
  document.addEventListener("selectionchange", schedulePublish);

  // Clicking away collapses the selection — report it as cleared.
  document.addEventListener("mouseup", schedulePublish);

  document.addEventListener("keyup", (e) => {
    if (e.key === "Escape") {
      lastSelection = "";
      safeSendMessage({ action: "selection.cleared" });
    }
  });
})();
