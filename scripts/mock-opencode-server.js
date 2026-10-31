#!/usr/bin/env node
// Tiny OpenCode v2 stand-in for the side panel UI.
//
// The extension does not read a token stream. It posts a prompt, then polls
// GET /api/session/:id/message until the assistant message has text and a
// finish reason other than "tool-calls" (see background.js). This server
// reveals that text over a short interval so the poll behaves like a live
// reply, then sets finish to "stop".
//
// No dependencies. Bind address is loopback only.
//
//   node scripts/mock-opencode-server.js
//
// Username is always "opencode" (the extension's default). Password and port:
//   MOCK_OPENCODE_PASSWORD  default "demo"
//   MOCK_OPENCODE_PORT      default 49374  (the extension's default port)

const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = Number(process.env.MOCK_OPENCODE_PORT || 49374);
const PASSWORD = process.env.MOCK_OPENCODE_PASSWORD != null
  ? String(process.env.MOCK_OPENCODE_PASSWORD)
  : "demo";
const USERNAME = "opencode";
const ROOT = "/home/dev/projects";
const REVEAL_MS = 1100;

const DEMO_PAGE = fs.readFileSync(path.join(__dirname, "demo-page.html"));

const TREE = {
  "/home/dev/projects": ["my-app", "notes", "docs"],
  "/home/dev/projects/my-app": ["src"],
  "/home/dev/projects/my-app/src": [],
  "/home/dev/projects/notes": [],
  "/home/dev/projects/docs": []
};

const MODELS = [
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", providerID: "ollama-cloud" },
  { id: "qwen3-8b", name: "Qwen3 8B", providerID: "ollama-cloud" },
  { id: "Qwen/Qwen3-Coder-30B-A3B", name: "Qwen3 Coder", providerID: "featherless" },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", providerID: "featherless" },
  { id: "deepseek-ai/DeepSeek-V3", name: "DeepSeek V3", providerID: "featherless" }
];

const sessions = new Map();
let sessionSeq = 0;

function send(res, status, body, type) {
  const payload = body == null ? "" : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": type || (Buffer.isBuffer(body) ? "text/html; charset=utf-8" : "application/json; charset=utf-8"),
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(payload);
}

function unauthorized(res) {
  send(res, 401, { error: "unauthorized" });
}

function authorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch (e) {
    return false;
  }
  const split = decoded.indexOf(":");
  if (split < 0) return false;
  return decoded.slice(0, split) === USERNAME && decoded.slice(split + 1) === PASSWORD;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function normalise(input) {
  const abs = path.posix.normalize(input && input.startsWith("/") ? input : `${ROOT}/${input || ""}`);
  if (abs.length > 1 && abs.endsWith("/")) return abs.slice(0, -1);
  return abs || ROOT;
}

function relativeToRoot(abs) {
  if (abs === ROOT) return ".";
  if (abs.startsWith(ROOT + "/")) return abs.slice(ROOT.length + 1);
  return abs;
}

function listDirs(target) {
  const raw = target || ".";
  const abs = raw === "." || raw === "/" || raw === "" ? ROOT : normalise(raw);
  const names = TREE[abs];
  if (!names) {
    const err = new Error("not found");
    err.status = 404;
    throw err;
  }
  return {
    location: { directory: ROOT },
    data: names.map((name) => ({
      type: "directory",
      path: relativeToRoot(`${abs}/${name}`)
    }))
  };
}

function findDirs(query) {
  const q = String(query || "").trim().toLowerCase();
  const hits = [];
  for (const dir of Object.keys(TREE)) {
    const name = dir.split("/").filter(Boolean).pop() || "";
    if (!q || name.toLowerCase().includes(q) || dir.toLowerCase().includes(q)) {
      if (dir === ROOT) continue;
      hits.push({ type: "directory", path: relativeToRoot(dir) });
    }
  }
  return { location: { directory: ROOT }, data: hits.slice(0, 50) };
}

function replyFor(prompt) {
  const text = String(prompt || "");
  if (/shorten this text/i.test(text)) {
    return "Cut the password-reset flow. It is long enough that people give up.";
  }
  if (/fix the grammar/i.test(text)) {
    return "The team should reduce the number of steps customers take to reset a password. The current flow is long, and people give up before they finish.";
  }
  if (/explain this text/i.test(text)) {
    return "The draft says the password-reset flow has too many steps, so people abandon it. The suggested change is to make that flow shorter.";
  }
  if (/rewrite this text/i.test(text)) {
    return "Password reset takes too many steps, and people drop out before the end. We should shorten it.";
  }
  if (/summarize this page/i.test(text)) {
    return "A draft release note argues for a shorter password-reset flow, and the page offers an email signup for when it ships.";
  }
  if (/suggest actions/i.test(text) || /allowed action types/i.test(text)) {
    return [
      "This page can take an email address and subscribe. I'll fill the field and click Subscribe.",
      "",
      "```json",
      JSON.stringify({
        actions: [
          { type: "fill", selector: "#email", value: "reader@example.com", description: "Fill the email field" },
          { type: "click", selector: "#subscribe", description: "Subscribe" }
        ]
      }),
      "```"
    ].join("\n");
  }
  return "The mock server received that prompt. It only has canned replies for the side panel's buttons. Connect a real OpenCode server for a model.";
}

function messageBody(session) {
  const full = session.reply || "";
  const elapsed = Date.now() - session.started;
  const ratio = Math.min(1, elapsed / REVEAL_MS);
  const shown = full.slice(0, Math.max(1, Math.ceil(full.length * ratio)));
  const done = ratio >= 1;
  return {
    data: [
      {
        type: "assistant",
        content: [{ type: "text", text: shown }],
        finish: done ? "stop" : "",
        time: { created: session.created }
      }
    ]
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === "OPTIONS") return send(res, 204, "");

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/demo")) {
      return send(res, 200, DEMO_PAGE, "text/html; charset=utf-8");
    }

    if (!url.pathname.startsWith("/api/")) {
      return send(res, 404, { error: "not found" });
    }
    if (!authorized(req)) return unauthorized(res);

    if (req.method === "GET" && url.pathname === "/api/config") {
      return send(res, 200, { username: USERNAME });
    }

    if (req.method === "GET" && url.pathname === "/api/model") {
      return send(res, 200, { data: MODELS });
    }

    if (req.method === "GET" && url.pathname === "/api/project") {
      const now = Date.now();
      return send(res, 200, [
        { canonical: "/home/dev/projects/my-app", vcs: "git", time: { active: now } },
        { canonical: "/home/dev/projects/notes", vcs: "git", time: { updated: now - 86400000 } }
      ]);
    }

    if (req.method === "GET" && url.pathname === "/api/fs/list") {
      return send(res, 200, listDirs(url.searchParams.get("path") || "."));
    }

    if (req.method === "GET" && url.pathname === "/api/fs/find") {
      return send(res, 200, findDirs(url.searchParams.get("query") || ""));
    }

    if (req.method === "POST" && url.pathname === "/api/session") {
      const body = await readBody(req);
      const directory = body && body.location && body.location.directory;
      if (directory && !normalise(directory).startsWith(ROOT)) {
        return send(res, 404, { name: "LocationNotFoundError", data: { directory } });
      }
      const id = `ses_demo${++sessionSeq}`;
      sessions.set(id, { id, reply: "", started: 0, created: 0, model: null });
      return send(res, 200, { data: { id } });
    }

    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(model|prompt|message))?$/);
    if (sessionMatch) {
      const session = sessions.get(decodeURIComponent(sessionMatch[1]));
      if (!session) return send(res, 404, { error: "session not found" });
      const sub = sessionMatch[2] || "";

      if (req.method === "GET" && !sub) return send(res, 200, { data: { id: session.id } });

      if (req.method === "POST" && sub === "model") {
        const body = await readBody(req);
        session.model = (body && body.model) || null;
        return send(res, 200, { model: session.model });
      }

      if (req.method === "POST" && sub === "prompt") {
        const body = await readBody(req);
        session.reply = replyFor(body && body.text);
        session.started = Date.now();
        session.created = Date.now();
        return send(res, 200, { text: "accepted" });
      }

      if (req.method === "GET" && sub === "message") {
        if (!session.reply) return send(res, 200, { data: [] });
        return send(res, 200, messageBody(session));
      }
    }

    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e.status || 500, { error: e.message || "error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mock opencode listening on http://${HOST}:${PORT}`);
  console.log(`demo page http://${HOST}:${PORT}/demo`);
  console.log(`basic auth username ${USERNAME}`);
});
