#!/usr/bin/env node
// Record docs/demo.gif and the README screenshots.
//
// Loads this extension in headed Chromium (Playwright). Chrome only opens the
// real side panel from a user gesture, and that gesture cannot be synthesized
// here, so the script opens sidepanel.html as an extension popup beside the
// demo page — the same UI, driven by the real service worker.
//
// Prerequisites:
//   npm install
//   npx playwright install chromium
//
// Then:
//   node scripts/record-demo.js
//
// The mock server is started automatically. Override with MOCK_OPENCODE_PORT
// and MOCK_OPENCODE_PASSWORD (defaults 49374 and "demo").

const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const TMP = path.join(__dirname, ".tmp");
const PORT = Number(process.env.MOCK_OPENCODE_PORT || 49374);
const PASSWORD = process.env.MOCK_OPENCODE_PASSWORD != null
  ? String(process.env.MOCK_OPENCODE_PASSWORD)
  : "demo";
const SCREEN_W = 1280;
const SCREEN_H = 800;

const children = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function track(child) {
  children.push(child);
  return child;
}

function killAll() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch (e) { /* already gone */ }
  }
}

async function ensureDisplay() {
  // Always a private screen so the GIF is 1280x800 even if the agent already has a display.
  for (let n = 95; n < 106; n++) {
    const display = `:${n}`;
    const xvfb = track(spawn("Xvfb", [display, "-screen", "0", `${SCREEN_W}x${SCREEN_H}x24`, "-ac"], { stdio: "ignore" }));
    await sleep(350);
    if (xvfb.exitCode == null) {
      process.env.DISPLAY = display;
      return;
    }
  }
  throw new Error("Could not start Xvfb");
}

function startMock() {
  const child = track(spawn(process.execPath, [path.join(__dirname, "mock-opencode-server.js")], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOCK_OPENCODE_PORT: String(PORT), MOCK_OPENCODE_PASSWORD: PASSWORD }
  }));
  child.stdout.on("data", (buf) => process.stdout.write(buf));
  child.stderr.on("data", (buf) => process.stderr.write(buf));
  return child;
}

async function waitForMock() {
  const auth = "Basic " + Buffer.from(`opencode:${PASSWORD}`).toString("base64");
  const deadline = Date.now() + 8000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/config`, { headers: { Authorization: auth } });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    await sleep(150);
  }
  throw new Error(`Mock server did not come up (${last})`);
}

function shot(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "x11grab",
    "-video_size", `${SCREEN_W}x${SCREEN_H}`,
    "-i", process.env.DISPLAY,
    "-frames:v", "1",
    "-update", "1",
    file
  ], { stdio: "inherit" });
}

function startRecording(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const child = track(spawn("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "x11grab",
    "-video_size", `${SCREEN_W}x${SCREEN_H}`,
    "-framerate", "15",
    "-i", process.env.DISPLAY,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "ultrafast",
    file
  ], { stdio: "ignore" }));
  return child;
}

function stopRecording(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null) return resolve();
    child.once("close", () => resolve());
    child.kill("SIGINT");
    setTimeout(() => resolve(), 4000);
  });
}

function encodeGif(video, gif) {
  const palette = path.join(TMP, "palette.png");
  const filters = "fps=12,scale=1280:-1:flags=lanczos";
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", video,
    "-vf", `${filters},palettegen=stats_mode=diff`,
    palette
  ], { stdio: "inherit" });
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-i", video,
    "-i", palette,
    "-lavfi", `${filters}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
    gif
  ], { stdio: "inherit" });
}

class Cdp {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
  }

  open() {
    this.ws = new WebSocket(this.url);
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (!msg.id || !this.pending.has(msg.id)) return;
        const { resolve: ok, reject: bad } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) bad(new Error(JSON.stringify(msg.error)));
        else ok(msg.result);
      });
    });
  }

  send(method, params, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(sessionId, expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error((details.exception && details.exception.description) || details.text || "eval failed");
    }
    return result.result && result.result.value;
  }

  close() {
    try { this.ws.close(); } catch (e) { /* already closed */ }
  }
}

let cursor = { x: 180, y: 220 };

async function glide(x, y) {
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const nx = Math.round(cursor.x + (x - cursor.x) * (i / steps));
    const ny = Math.round(cursor.y + (y - cursor.y) * (i / steps));
    execFileSync("xdotool", ["mousemove", String(nx), String(ny)], { stdio: "ignore" });
    await sleep(18);
  }
  cursor = { x, y };
}

async function pointOf(page, selector) {
  const point = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(window.screenX + rect.left + rect.width / 2),
      y: Math.round(window.screenY + rect.top + rect.height / 2)
    };
  }, selector);
  if (!point) throw new Error(`Missing ${selector}`);
  return point;
}

const PANEL_SCREEN = `(sel) => {
  const el = typeof sel === "string" && sel.startsWith("label:")
    ? [...document.querySelectorAll("button")].find((btn) => (btn.textContent || "").includes(sel.slice(6)))
    : document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: "nearest", inline: "center" });
  const rect = el.getBoundingClientRect();
  return {
    x: Math.round(window.screenX + rect.left + rect.width / 2),
    y: Math.round(window.screenY + rect.top + rect.height / 2)
  };
}`;

async function panelClick(cdp, sessionId, selector) {
  const local = await cdp.eval(sessionId, `(() => {
    const sel = ${JSON.stringify(selector)};
    const el = sel.startsWith("label:")
      ? [...document.querySelectorAll("button")].find((btn) => (btn.textContent || "").includes(sel.slice(6)))
      : document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest", inline: "center" });
    const rect = el.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      screenX: window.screenX,
      screenY: window.screenY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    };
  })()`);
  if (!local) throw new Error(`Missing ${selector}`);
  // The side panel reports the browser window's screenX, not its own. It is docked to the right edge.
  const x = Math.round((SCREEN_W - local.innerWidth) + local.left + local.width / 2);
  const y = Math.round(local.screenY + local.top + local.height / 2);
  await glide(x, y);
  await sleep(140);
  await cdp.eval(sessionId, `(() => {
    const sel = ${JSON.stringify(selector)};
    const el = sel.startsWith("label:")
      ? [...document.querySelectorAll("button")].find((btn) => (btn.textContent || "").includes(sel.slice(6)))
      : document.querySelector(sel);
    el.click();
  })()`);
}

async function waitPanel(cdp, sessionId, expression, timeout) {
  const deadline = Date.now() + (timeout || 8000);
  let last = "";
  while (Date.now() < deadline) {
    try {
      if (await cdp.eval(sessionId, expression)) return;
    } catch (e) {
      last = e.message;
    }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for panel (${last || expression.slice(0, 90)})`);
}

async function main() {
  fs.mkdirSync(DOCS, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(path.join(TMP, "profile"), { recursive: true, force: true });

  await ensureDisplay();
  startMock();
  await waitForMock();

  const context = await chromium.launchPersistentContext(path.join(TMP, "profile"), {
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation", "--no-sandbox"],
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "--hide-scrollbars",
      `--window-position=0,0`,
      `--window-size=${SCREEN_W},${SCREEN_H}`,
      "--force-device-scale-factor=1",
      "--force-prefers-color-scheme=light",
      "--remote-debugging-port=9333",
      "--remote-allow-origins=*"
    ]
  });

  let cdp = null;
  try {
    let sw = context.serviceWorkers()[0];
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extId = new URL(sw.url()).host;
    const demo = context.pages()[0];
    await demo.goto(`http://127.0.0.1:${PORT}/demo`, { waitUntil: "domcontentloaded" });
    await demo.waitForSelector("#draft");

    const browserWin = await sw.evaluate(async () => {
      const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
      return wins[0].id;
    });

    // A popup is only a way to deliver the user gesture Chrome requires
    // before sidePanel.open(). The recording uses the real side panel.
    await sw.evaluate(async (url) => {
      await chrome.windows.create({ url, type: "popup", width: 420, height: 640, focused: true });
    }, `chrome-extension://${extId}/sidepanel.html`);

    let popup = null;
    const popupDeadline = Date.now() + 8000;
    while (Date.now() < popupDeadline) {
      popup = context.pages().find((p) => p.url().includes("sidepanel.html"));
      if (popup) break;
      await sleep(100);
    }
    if (!popup) throw new Error("Could not open a page to gesture the side panel open");

    await popup.evaluate((cfg) => chrome.storage.local.set({ opencodeConfig: cfg }), {
      host: "127.0.0.1",
      port: PORT,
      username: "opencode",
      password: PASSWORD,
      modelId: "glm-5.3-flash",
      providerId: "ollama-cloud",
      directory: ""
    });
    await popup.evaluate((windowId) => {
      document.body.addEventListener("pointerdown", () => {
        chrome.sidePanel.open({ windowId }).then(
          () => { document.documentElement.dataset.panel = "open"; },
          (err) => { document.documentElement.dataset.panel = String(err && err.message || err); }
        );
      }, { once: true });
    }, browserWin);
    await popup.locator("body").click({ position: { x: 24, y: 80 } });
    await popup.waitForFunction(() => document.documentElement.dataset.panel === "open", null, { timeout: 5000 });

    await sw.evaluate(async () => {
      const wins = await chrome.windows.getAll();
      for (const win of wins) {
        if (win.type === "popup") await chrome.windows.remove(win.id);
      }
    });
    await sw.evaluate(async (id) => {
      await chrome.windows.update(id, {
        left: 0, top: 0, width: 1280, height: 800, state: "normal", focused: true
      });
    }, browserWin);
    await sleep(400);

    cdp = new Cdp(await panelSocketUrl());
    await cdp.open();
    const sessionId = undefined;
    await waitPanel(
      cdp,
      sessionId,
      `document.getElementById("model-name") && /GLM/.test(document.getElementById("model-name").textContent)`,
      8000
    );

    await panelClick(cdp, sessionId, "#model-btn");
    await waitPanel(cdp, sessionId, `!document.getElementById("model-popover").hidden`);
    await sleep(350);
    shot(path.join(DOCS, "model-picker.png"));
    await cdp.eval(sessionId, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(250);

    const video = path.join(TMP, "recording.mp4");
    const recorder = startRecording(video);
    await sleep(350);

    const draft = await pointOf(demo, "#draft");
    await glide(draft.x - 180, draft.y);
    await glide(draft.x + 160, draft.y);
    await demo.evaluate(() => {
      const el = document.querySelector("#draft");
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
    await waitPanel(
      cdp,
      sessionId,
      `document.getElementById("selection-bar").classList.contains("visible")`,
      5000
    );
    await sleep(700);

    await panelClick(cdp, sessionId, '[data-action="shorten"]');
    await waitPanel(
      cdp,
      sessionId,
      `[...document.querySelectorAll("button")].some((btn) => (btn.textContent || "").includes("Apply to page"))`,
      15000
    );
    await sleep(1400);
    shot(path.join(DOCS, "shorten-response.png"));

    await panelClick(cdp, sessionId, "label:Apply to page");
    await waitPanel(
      cdp,
      sessionId,
      `[...document.querySelectorAll(".msg-body")].some((el) => (el.textContent || "").includes("Applied to page"))`,
      8000
    );
    await demo.waitForFunction(() => document.getElementById("draft").classList.contains("applied"));
    await sleep(1500);

    await panelClick(cdp, sessionId, '[data-action="act"]');
    await waitPanel(
      cdp,
      sessionId,
      `[...document.querySelectorAll("button")].some((btn) => /Run \\d+ actions/.test(btn.textContent || ""))`,
      15000
    );
    await sleep(800);
    shot(path.join(DOCS, "page-actions.png"));

    await panelClick(cdp, sessionId, "label:Run 2 actions");
    await demo.waitForFunction(() => document.getElementById("thanks").textContent.includes("You're on the list"));
    await waitPanel(
      cdp,
      sessionId,
      `[...document.querySelectorAll(".msg-body")].some((el) => (el.textContent || "").startsWith("Done."))`,
      8000
    );
    await sleep(2600);

    await stopRecording(recorder);
    encodeGif(video, path.join(DOCS, "demo.gif"));
    const bytes = fs.statSync(path.join(DOCS, "demo.gif")).size;
    console.log(`wrote docs/demo.gif (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  } catch (err) {
    try { shot(path.join(TMP, "failure.png")); } catch (e) { /* display already gone */ }
    throw err;
  } finally {
    if (cdp) cdp.close();
    await context.close().catch(() => {});
  }
}

async function panelSocketUrl() {
  const deadline = Date.now() + 8000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const list = await fetch("http://127.0.0.1:9333/json/list").then((res) => res.json());
      const panels = list.filter((target) => target.type === "page" && String(target.url || "").includes("sidepanel.html"));
      last = panels.map((target) => target.url).join(", ") || `targets ${list.length}`;
      if (panels.length === 1 && panels[0].webSocketDebuggerUrl) return panels[0].webSocketDebuggerUrl;
    } catch (e) {
      last = e.message;
    }
    await sleep(150);
  }
  throw new Error(`Real side panel target did not stay open (${last})`);
}

process.on("SIGINT", () => { killAll(); process.exit(1); });

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    killAll();
  });
