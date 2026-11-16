// DASH relay（默认 127.0.0.1:8941，放在你自己的反向代理 + 登录之后）
// hub 把整机队快照推上来（/ingest/*，Bearer HUB_TOKEN）；网页读状态、发切换请求（/api/*，本身不鉴权，必须由反向代理挡住）。
// 切换请求只认快照里 hub 自己公布的 switch option id；真正的命令只在 hub 端白名单里，这里拿不到也执行不了。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const PORT = +(process.env.PORT || 8941);
const HOST = process.env.BIND || "127.0.0.1";
const TOKEN = process.env.HUB_TOKEN || "";
const DATA = process.env.DATA_DIR || "/var/lib/fleetdash";
const MAX_BODY = 4 << 20;
if (TOKEN.length < 32) { console.error("HUB_TOKEN 未设置或太短（≥32）"); process.exit(1); }
fs.mkdirSync(DATA, { recursive: true });

let snap = null, snapAt = 0;
try { const j = JSON.parse(fs.readFileSync(path.join(DATA, "snapshot.json"), "utf8")); snap = j.snap; snapAt = j.at; } catch {}
const actions = [];            // 最近 200 条，新的在前
const waiters = new Set();     // hub 长轮询
const streams = new Set();     // 网页 SSE

const log = (ev, o = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), ev, ...o }));
const send = (res, code, obj, extra = {}) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(b);
};
const body = (req) => new Promise((ok, no) => {
  let n = 0; const parts = [];
  req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { no(new Error("too large")); req.destroy(); } else parts.push(c); });
  req.on("end", () => { try { ok(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch (e) { no(e); } });
  req.on("error", no);
});
const authed = (req) => {
  const h = req.headers.authorization || "";
  const got = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const clientIp = (req) => {
  const xff = (req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
};
const statePayload = () => ({ snap, received_at: snapAt, stale_s: snapAt ? Math.round((Date.now() - snapAt) / 1000) : null,
  actions: actions.slice(0, 30).map(pub) });
const pub = (a) => ({ aid: a.aid, option: a.option, label: a.label, machine: a.machine, status: a.status,
  created: a.created, updated: a.updated, message: a.message || "" });
const broadcast = (event, data) => {
  const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of streams) r.write(s);
};
const findOption = (id) => (snap?.switch_options || []).find((o) => o.id === id);
// 送达以 hub 回报 running 为准：queued / dispatched 都算待领，长轮询回包丢在中转链路上也会重发（hub 按 aid 去重）
const pending = () => actions.filter((a) => a.status === "queued" || (a.status === "dispatched" && Date.now() - a.created < 10 * 60e3));
const wakeHub = () => {
  const p = pending(); if (!p.length) return;
  for (const w of waiters) { clearTimeout(w.timer); p.forEach((a) => { a.status = "dispatched"; a.updated = Date.now(); });
    send(w.res, 200, { actions: p.map((a) => ({ aid: a.aid, option: a.option })) }); waiters.delete(w); broadcast("action", p.map(pub)); return; }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    // ---------- hub（Bearer） ----------
    if (p.startsWith("/ingest/")) {
      if (!authed(req)) { log("ingest_denied", { ip: clientIp(req), p }); return send(res, 401, { error: "unauthorized" }); }
      if (p === "/ingest/snapshot" && req.method === "POST") {
        const j = await body(req);
        if (!j || !Array.isArray(j.machines)) return send(res, 400, { error: "machines missing" });
        snap = j; snapAt = Date.now();
        fs.writeFile(path.join(DATA, "snapshot.json"), JSON.stringify({ at: snapAt, snap }), () => {});
        broadcast("state", statePayload());
        return send(res, 200, { ok: true, queued: pending().length });
      }
      if (p === "/ingest/actions" && req.method === "GET") {
        const p0 = pending();
        if (p0.length) { p0.forEach((a) => { a.status = "dispatched"; a.updated = Date.now(); }); broadcast("action", p0.map(pub));
          return send(res, 200, { actions: p0.map((a) => ({ aid: a.aid, option: a.option })) }); }
        const wait = Math.min(+(url.searchParams.get("wait") || 25), 50) * 1000;
        const w = { res, timer: setTimeout(() => { waiters.delete(w); send(res, 200, { actions: [] }); }, wait) };
        waiters.add(w); req.on("close", () => { clearTimeout(w.timer); waiters.delete(w); });
        return;
      }
      const m = p.match(/^\/ingest\/actions\/([a-f0-9]{16})$/);
      if (m && req.method === "POST") {
        const a = actions.find((x) => x.aid === m[1]);
        if (!a) return send(res, 404, { error: "no such action" });
        const j = await body(req);
        if (!["running", "done", "failed"].includes(j.status)) return send(res, 400, { error: "bad status" });
        a.status = j.status; a.message = String(j.message || "").slice(0, 2000); a.updated = Date.now();
        log("action_update", { aid: a.aid, status: a.status });
        broadcast("action", [pub(a)]);
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "not found" });
    }
    // ---------- 网页（反向代理的登录之后） ----------
    if (p === "/api/state" && req.method === "GET") return send(res, 200, statePayload());
    if (p === "/api/stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", connection: "keep-alive" });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify(statePayload())}\n\n`);
      streams.add(res);
      const hb = setInterval(() => res.write(`: hb ${Date.now()}\n\n`), 20000);
      req.on("close", () => { clearInterval(hb); streams.delete(res); });
      return;
    }
    if (p === "/api/action" && req.method === "POST") {
      const j = await body(req);
      const o = findOption(String(j.option || ""));
      if (!o) return send(res, 400, { error: "这个切换项不存在或已过期，刷新后再试" });
      if (o.confirm && j.confirm !== true) return send(res, 409, { error: "需要二次确认", confirm: o.confirm });
      if (actions.some((a) => a.machine === o.machine && ["queued", "dispatched", "running"].includes(a.status)))
        return send(res, 429, { error: `${o.machine} 上一个切换还没完成` });
      if (actions.filter((a) => a.status === "queued").length >= 20) return send(res, 429, { error: "排队太多" });
      const a = { aid: crypto.randomBytes(8).toString("hex"), option: o.id, label: o.label, machine: o.machine,
        status: "queued", created: Date.now(), updated: Date.now(), ip: clientIp(req) };
      actions.unshift(a); actions.length = Math.min(actions.length, 200);
      log("action_new", { aid: a.aid, option: a.option, ip: a.ip });
      broadcast("action", [pub(a)]);
      wakeHub();
      return send(res, 202, pub(a));
    }
    if (p === "/api/health") return send(res, 200, { ok: true, stale_s: statePayload().stale_s });
    return send(res, 404, { error: "not found" });
  } catch (e) {
    log("error", { p, msg: String(e.message || e) });
    if (!res.headersSent) send(res, 400, { error: "bad request" });
  }
});
server.listen(PORT, HOST, () => log("listen", { HOST, PORT }));
