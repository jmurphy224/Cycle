// api/store.js
// Vercel serverless proxy to Supabase (PostgREST). Keeps your Supabase
// service_role key server-side so it NEVER reaches the browser.
//
// The front-end talks only to /api/store. This function forwards a small set
// of allow-listed, structured operations to Supabase's REST API, and scopes
// every one of them to the signed-in person: reads only return their rows,
// writes are stamped with their user_id, and updates/deletes can only touch
// rows they own.
//
// Env vars: see api/_db.js.

import { requireUser } from "./_auth.js";
import { db, dbConfigured } from "./_db.js";

// logical name -> real Postgres table. Only these may be touched.
const TABLES = { food: "food_log", shots: "shots", daily: "daily", workouts: "workouts" };

const enc = encodeURIComponent;
// The browser never gets to choose whose rows it touches.
const withoutOwner = (o) => {
  const { user_id, ...rest } = o || {};
  return rest;
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const me = requireUser(req, res);
  if (!me) return;
  if (!dbConfigured) return res.status(500).json({ error: "Server not configured (missing env vars)" });

  const { action, table, eq, order, rows, id, values, onConflict } = req.body || {};
  const t = TABLES[table];
  if (!t) return res.status(400).json({ error: `Unknown table: ${table}` });

  const mine = `user_id=eq.${enc(me.id)}`;
  const stamp = (list) => (Array.isArray(list) ? list : [list]).map((r) => ({ ...withoutOwner(r), user_id: me.id }));
  // Upstream auth failures are a server config problem, not a sign-in one —
  // don't pass a 401 through, or the app would bounce to the sign-in screen.
  const send = (r) => res.status(r.status === 401 || r.status === 403 ? 502 : r.status).json(r.data);

  try {
    if (action === "list") {
      const qs = ["select=*", mine, ...Object.entries(withoutOwner(eq)).map(([c, v]) => `${enc(c)}=eq.${enc(v)}`)];
      if (order?.col) qs.push(`order=${enc(order.col)}.${order.asc ? "asc" : "desc"}`);
      return send(await db(`${t}?${qs.join("&")}`));
    }

    if (action === "insert") {
      return send(await db(t, { method: "POST", body: stamp(rows), prefer: "return=representation" }));
    }

    if (action === "update") {
      return send(await db(`${t}?id=eq.${enc(id)}&${mine}`, { method: "PATCH", body: withoutOwner(values), prefer: "return=representation" }));
    }

    // Upsert on a unique key. Daily rows are unique per person per date.
    if (action === "upsert") {
      const conflict = onConflict === "date" ? "user_id,date" : onConflict;
      const qs = conflict ? `?on_conflict=${enc(conflict)}` : "";
      return send(await db(`${t}${qs}`, { method: "POST", body: stamp(rows), prefer: "resolution=merge-duplicates,return=representation" }));
    }

    if (action === "delete") {
      return send(await db(`${t}?id=eq.${enc(id)}&${mine}`, { method: "DELETE", prefer: "return=representation" }));
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
