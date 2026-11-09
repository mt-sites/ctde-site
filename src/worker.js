// Cloudflare Worker: API for the Faculty Leave & Travel Calendar.
// Secret:  ADMIN_PASSWORD   (Settings -> Variables and Secrets -> type "Secret")
// Binding: REQUESTS         (a KV namespace)
const TYPES = ["Sick Leave","Wellness Leave","Travel Order","L&D (Learning & Development)","Vacation Leave","Official Business","Others"];
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

export default {
  async fetch(req, env) {
    const p = new URL(req.url).pathname.replace(/\/+$/, ""), m = req.method;
    const list = async () => JSON.parse((await env.REQUESTS.get("list")) || "[]");
    const save = (l) => env.REQUESTS.put("list", JSON.stringify(l));

    if (p === "/api/requests" && m === "GET") return json(await list());

    if (!env.ADMIN_PASSWORD) return json({ error: "ADMIN_PASSWORD secret is not set" }, 500);
    const ok = await same(req.headers.get("X-Admin-Password") || "", env.ADMIN_PASSWORD);
    if (!ok) { await new Promise((r) => setTimeout(r, 800)); return json({ error: "unauthorized" }, 401); }

    if (p === "/api/login" && m === "POST") return json({ ok: true });

    if (p === "/api/requests" && m === "POST") {
      let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
      const r = {
        id: crypto.randomUUID(), name: clip(b.name, 100), type: TYPES.includes(b.type) ? b.type : "Others",
        other: clip(b.other, 100), start: b.start, end: b.end || b.start,
        requested: DATE.test(b.requested) ? b.requested : today(), approved: DATE.test(b.approved) ? b.approved : "", status: DATE.test(b.approved) ? "Approved" : "Pending", rem: clip(b.rem, 300),
        venue: clip(b.venue, 150), purpose: clip(b.purpose, 200), reason: clip(b.reason, 200),
      };
      if (!r.name || !DATE.test(r.start) || !DATE.test(r.end) || r.end < r.start) return json({ error: "invalid input" }, 400);
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
          const e = { name: clip(b.name, 100), type: TYPES.includes(b.type) ? b.type : "Others", other: clip(b.other, 100),
            start: b.start, end: b.end || b.start, requested: DATE.test(b.requested) ? b.requested : r.requested, rem: "rem" in b ? clip(b.rem, 300) : r.rem,
            venue: clip(b.venue, 150), purpose: clip(b.purpose, 200), reason: clip(b.reason, 200) };
          if (!e.name || !DATE.test(e.start) || !DATE.test(e.end) || e.end < e.start) return json({ error: "invalid input" }, 400);
          Object.assign(r, e);
          if (DATE.test(b.approved)) { r.approved = b.approved; r.status = "Approved"; }
          else if (r.status === "Approved") { r.status = "Pending"; r.approved = ""; }
        }
      } else return json({ error: "method not allowed" }, 405);
      await save(l); return json(l);
    }
    return json({ error: "not found" }, 404);
  },
};
