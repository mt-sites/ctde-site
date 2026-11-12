// Cloudflare Worker: API for the Faculty Leave & Travel Calendar.
// Secret:  ADMIN_PASSWORD   (Settings -> Variables and Secrets -> type "Secret")
// Binding: REQUESTS         (a KV namespace)
const DOC = { "Communication": ["Internal", "External"], "MEMO": ["Administrative", "Institutional", "VPAA", "Others"],
  "T.O.": ["Office of the President", "VPAA"], "Endorsement": null, "Others": null };
const HEX = /^#[0-9a-fA-F]{6}$/;
const BASE_TYPES = [
  { name: "Sick Leave", color: "#d64545" }, { name: "Wellness Leave", color: "#2e9e6b" }, { name: "Travel Order", color: "#1f5fbf" },
  { name: "L&D (Learning & Development)", color: "#8a52c9" }, { name: "Vacation Leave", color: "#d98a1c" }, { name: "Official Business", color: "#0e9aa7" } ];
const NEW_TYPES = [{ name: "Mandatory/Forced Leave", color: "#c2185b" }, { name: "Solo Parent Leave", color: "#00796b" }];
const STATUS = ["Pending","Approved","Disapproved"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // Philippine time
const clip = (s, n) => String(s ?? "").trim().slice(0, n);

async function same(a, b) { // constant-time comparison of SHA-256 digests
  const e = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(a)), crypto.subtle.digest("SHA-256", e.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y); let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

// ---------------------------------------------------------------------------------------------
// Backup to Google Drive + automatic archive-and-clear
// ---------------------------------------------------------------------------------------------
// Automatic backup + clear happens ONLY when the stored data reaches this size (default 20 MB; override with the MAX_BYTES variable).
// If it is not reached, nothing is backed up automatically. (Cloudflare KV cannot hold more than 25 MB in one key.)
const DEFAULT_MAX_BYTES = 20 * 1024 ** 2;
// Optional time-based clean-up, OFF by default. Set the variable CLEAR_EVERY_MONTHS (e.g. 6) to also clean up on a schedule.
const phToday = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const readJSON = async (env, k, dflt) => JSON.parse((await env.REQUESTS.get(k)) || "null") ?? dflt;
const getMeta = (env) => readJSON(env, "meta", null);
const putMeta = (env, m) => env.REQUESTS.put("meta", JSON.stringify(m));

async function sizes(env) {
  const enc = new TextEncoder(), n = async (k) => enc.encode((await env.REQUESTS.get(k)) || "").length;
  const [list, comms, config] = await Promise.all([n("list"), n("comms"), n("config")]);
  return { list, comms, config, total: list + comms + config };
}

// Sends a full copy of the data to the Google Apps Script web app, which saves a dated .xlsx in Google Drive.
async function backup(env, snap) {
  if (!env.BACKUP_URL || !env.BACKUP_TOKEN) return { ok: false, error: "BACKUP_URL / BACKUP_TOKEN secrets are not set" };
  const payload = { token: env.BACKUP_TOKEN, at: new Date().toISOString(),
    requests: snap ? snap.requests : await readJSON(env, "list", []),
    comms: snap ? snap.comms : await readJSON(env, "comms", []),
    config: (await readJSON(env, "config", null)) || { types: [...BASE_TYPES, ...NEW_TYPES], names: [] } };
  let res;
  try {
    const r = await fetch(env.BACKUP_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), redirect: "follow" });
    const t = await r.text();
    try { res = JSON.parse(t); } catch { res = { ok: false, error: "Unexpected reply from Google Apps Script (check the Web app is deployed for Anyone)", status: r.status }; }
  } catch (e) { res = { ok: false, error: String(e) }; }
  const meta = (await getMeta(env)) || { since: new Date().toISOString() };
  if (res.ok) { meta.lastBackupAt = new Date().toISOString(); meta.lastFile = res.file; delete meta.lastError; }
  else meta.lastError = { at: new Date().toISOString(), error: res.error };
  await putMeta(env, meta);
  return res;
}

// Back up to Drive FIRST. Only if that succeeded, remove the archived records from KV (Drive files are never deleted).
// Kept in the system: types/names lists, and leave/travel requests that have not ended yet.
async function archiveAndClear(env, reason, nowMs) {
  const snap = { requests: await readJSON(env, "list", []), comms: await readJSON(env, "comms", []) };
  const res = await backup(env, snap);
  if (!res.ok || !res.file) return { action: "failed", reason, error: res.error || "backup did not return a file" }; // nothing is cleared
  const today = phToday(nowMs), rid = new Set(snap.requests.map((r) => r.id)), cid = new Set(snap.comms.map((c) => c.id));
  const curR = await readJSON(env, "list", []), curC = await readJSON(env, "comms", []);
  const newR = curR.filter((r) => !rid.has(r.id) || r.end >= today); // records added during the backup, or still upcoming, stay
  const newC = curC.filter((c) => !cid.has(c.id));
  await env.REQUESTS.put("list", JSON.stringify(newR));
  await env.REQUESTS.put("comms", JSON.stringify(newC));
  const meta = (await getMeta(env)) || {};
  meta.lastClearAt = new Date(nowMs).toISOString();
  meta.lastClear = { reason, file: res.file, requests: curR.length - newR.length, comms: curC.length - newC.length, kept: newR.length };
  await putMeta(env, meta);
  return { action: "cleared", ...meta.lastClear };
}

async function maintain(env, nowMs = Date.now()) {
  const sz = await sizes(env), max = Number(env.MAX_BYTES) || DEFAULT_MAX_BYTES, months = Number(env.CLEAR_EVERY_MONTHS) || 0;
  let meta = (await getMeta(env)) || {};
  if (months > 0 && !meta.lastClearAt && !meta.since) { meta.since = new Date(nowMs).toISOString(); await putMeta(env, meta); }
  const big = sz.total >= max;
  const due = months > 0 && addMonths(meta.lastClearAt || meta.since, months).getTime() <= nowMs;
  if (!big && !due) return { action: "none" };
  return archiveAndClear(env, big ? "size limit reached" : months + " months passed", nowMs);
}

async function status(env, nowMs = Date.now()) {
  const meta = (await getMeta(env)) || {}, sz = await sizes(env), months = Number(env.CLEAR_EVERY_MONTHS) || 0;
  return { configured: !!(env.BACKUP_URL && env.BACKUP_TOKEN), lastBackupAt: meta.lastBackupAt || null, lastFile: meta.lastFile || null,
    lastClearAt: meta.lastClearAt || null, lastClear: meta.lastClear || null, lastError: meta.lastError || null, sizes: sz,
    maxBytes: Number(env.MAX_BYTES) || DEFAULT_MAX_BYTES,
    nextClear: months > 0 ? addMonths(meta.lastClearAt || meta.since || new Date(nowMs).toISOString(), months).toISOString() : null };
}

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname.replace(/\/+$/, ""), m = req.method;
    const list = async () => JSON.parse((await env.REQUESTS.get("list")) || "[]");
    const getCfg = async () => {
      const c = JSON.parse((await env.REQUESTS.get("config")) || "null") || { types: BASE_TYPES.map((t) => ({ ...t })), names: [] };
      if (!c.v) { // one-time upgrade: add the two new types and seed the names list from existing requests
        for (const t of NEW_TYPES) if (!c.types.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) c.types.push({ ...t });
        const have = new Set(c.names.map((n) => n.toLowerCase()));
        for (const r of await list()) if (r.name && !have.has(r.name.toLowerCase())) { have.add(r.name.toLowerCase()); c.names.push(r.name); }
        c.names.sort((x, y) => x.localeCompare(y)); c.v = 2;
      }
      return c;
    };
    const listC = async () => JSON.parse((await env.REQUESTS.get("comms")) || "[]");
    const saveC = (l) => env.REQUESTS.put("comms", JSON.stringify(l));
    const save = (l) => env.REQUESTS.put("list", JSON.stringify(l));

    if (p === "/api/requests" && m === "GET") return json(await list());
    if (p === "/api/config" && m === "GET") return json(await getCfg());
    if (p === "/api/version") return json({ version: "edit-v4" }); // open /api/version to confirm this Worker is deployed

    if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD secret is not set" }, 500);
    const ok = await same(req.headers.get("X-Admin-Password") || "", env.ADMIN_PASSWORD);
    if (!ok) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "unauthorized" }, 401); }

    if (p === "/api/login" && m === "POST") return json({ ok: true });
    if (p === "/api/backup" && m === "POST") return json(await backup(env));
    if (p === "/api/backup" && m === "GET") return json(await status(env));

    // ---- Incoming communications (admin only) ----
    const cleanComm = (b) => {
      const t = b.type in DOC ? b.type : null; if (!t) return null;
      const subs = DOC[t], sub = subs ? clip(b.sub, 40) : "";
      if (subs && !subs.includes(sub)) return null;
      const c = { received: b.received, type: t, sub, other: t === "Others" ? clip(b.other, 100) : "",
        subject: clip(b.subject, 300), from: clip(b.from, 150), action: clip(b.action, 500) };
      if (!DATE.test(c.received) || !c.subject || !c.from || (t === "Others" && !c.other)) return null;
      return c;
    };
    if (p === "/api/comms" && m === "GET") return json(await listC());
    if (p === "/api/comms" && m === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const c = cleanComm(b); if (!c) return json({ error: "invalid input" }, 400);
      const l = await listC(); l.push({ id: crypto.randomUUID(), ...c }); await saveC(l); return json(l);
    }
    const cm = p.match(/^\/api\/comms\/([\w-]+)$/);
    if (cm) {
      const l = await listC(), i = l.findIndex((x) => x.id === cm[1]);
      if (i < 0) return json({ error: "not found" }, 404);
      if (m === "DELETE") l.splice(i, 1);
      else if (m === "PATCH") {
        let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        const c = cleanComm(b); if (!c) return json({ error: "invalid input" }, 400);
        l[i] = { id: l[i].id, ...c };
      } else return json({ error: "method not allowed" }, 405);
      await saveC(l); return json(l);
    }

    if (p === "/api/config" && m === "PUT") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const seen = new Set(), types = [];
      for (const t of Array.isArray(b.types) ? b.types : []) {
        const n = clip(t && t.name, 60), k = n.toLowerCase();
        if (!n || k === "others" || seen.has(k)) continue;
        seen.add(k); types.push({ name: n, color: HEX.test(t.color) ? t.color : "#777777" });
        if (types.length >= 40) break;
      }
      const ns = new Set(), names = [];
      for (const x of Array.isArray(b.names) ? b.names : []) {
        const n = clip(x, 100), k = n.toLowerCase();
        if (!n || ns.has(k)) continue;
        ns.add(k); names.push(n);
        if (names.length >= 500) break;
      }
      names.sort((a, c) => a.localeCompare(c));
      const rn = (Array.isArray(b.renames) ? b.renames : []).map((x) => [clip(x && x.from, 100), clip(x && x.to, 100)]).filter(([f, t]) => f && t && f !== t);
      if (rn.length) { // renaming a name also updates the requests that use it
        const l = await list(); let ch = false;
        for (const r of l) { const m = rn.find(([f]) => f === r.name); if (m) { r.name = m[1]; ch = true; } }
        if (ch) await save(l);
      }
      const c = { v: 2, types, names }; await env.REQUESTS.put("config", JSON.stringify(c)); return json(c);
    }

    if (p === "/api/requests" && m === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const r = {
        id: crypto.randomUUID(), name: clip(b.name, 100), type: clip(b.type, 60) || "Others",
        other: clip(b.other, 100), start: b.start, end: b.end || b.start,
        requested: DATE.test(b.requested) ? b.requested : today(), approved: DATE.test(b.approved) ? b.approved : "", status: DATE.test(b.approved) ? "Approved" : "Pending", rem: clip(b.rem, 300),
        venue: clip(b.venue, 150), purpose: clip(b.purpose, 200), reason: clip(b.reason, 200),
      };
      if (!r.name || !DATE.test(r.start) || !DATE.test(b.end) || r.end < r.start || !DATE.test(b.requested) || !DATE.test(b.approved) || !r.rem || (r.type === "Others" && !r.other)) return json({ error: "all fields are required" }, 400);
      const l = await list(); l.push(r); await save(l); return json(l);
    }

    const mm = p.match(/^\/api\/requests\/([\w-]+)$/);
    if (mm) {
      const l = await list(), i = l.findIndex((x) => x.id === mm[1]);
      if (i < 0) return json({ error: "not found" }, 404);
      if (m === "DELETE") l.splice(i, 1);
      else if (m === "PATCH") {
        let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
        const r = l[i];
        if ("status" in b) {
          if (!STATUS.includes(b.status)) return json({ error: "invalid status" }, 400);
          if (b.status !== r.status) { r.status = b.status; r.approved = b.status === "Approved" ? today() : ""; }
        }
        if ("name" in b) {
          const e = { name: clip(b.name, 100), type: clip(b.type, 60) || "Others", other: clip(b.other, 100),
            start: b.start, end: b.end || b.start, requested: DATE.test(b.requested) ? b.requested : r.requested, rem: "rem" in b ? clip(b.rem, 300) : r.rem,
            venue: clip(b.venue, 150), purpose: clip(b.purpose, 200), reason: clip(b.reason, 200) };
          if (!e.name || !DATE.test(e.start) || !DATE.test(b.end) || e.end < e.start || !DATE.test(b.requested) || !DATE.test(b.approved) || !e.rem || (e.type === "Others" && !e.other)) return json({ error: "all fields are required" }, 400);
          Object.assign(r, e);
          if (DATE.test(b.approved)) { r.approved = b.approved; r.status = "Approved"; }
          else if (r.status === "Approved") { r.status = "Pending"; r.approved = ""; }
        }
      } else return json({ error: "method not allowed" }, 405);
      await save(l); return json(l);
    }
    return json({ error: "not found" }, 404);
  },
  // Runs daily (see wrangler.toml). It only CHECKS the data size: backup + clear happen when the limit is reached, otherwise nothing is done.
  async scheduled(event, env, ctx) { ctx.waitUntil(maintain(env)); },
};
