// api/store.js
// Vercel serverless proxy to Supabase (PostgREST). Keeps your Supabase
// service_role key server-side so it NEVER reaches the browser.
//
// The front-end talks only to /api/store. This function forwards a small set
// of allow-listed, structured operations to Supabase's REST API.
//
// Env vars to set in Vercel (Project -> Settings -> Environment Variables):
//   SUPABASE_URL          -> https://YOURPROJECT.supabase.co
//   SUPABASE_SERVICE_KEY  -> the service_role key (Settings -> API in Supabase)
//
// Zero dependencies — uses fetch against PostgREST directly.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

// logical name -> real Postgres table. Only these may be touched.
const TABLES = { food: "food_log", shots: "shots", daily: "daily", workouts: "workouts" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!URL || !KEY) return res.status(500).json({ error: "Server not configured (missing env vars)" });

  const { action, table, eq, order, rows, id, values, onConflict } = req.body || {};
  const t = TABLES[table];
  if (!t) return res.status(400).json({ error: `Unknown table: ${table}` });

  const rest = `${URL}/rest/v1/${t}`;
  const H = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };

  // Build a PostgREST filter string from a structured {col: val} map.
  const eqFilters = (obj) =>
    Object.entries(obj || {}).map(([c, v]) => `${encodeURIComponent(c)}=eq.${encodeURIComponent(v)}`);

  try {
    if (action === "list") {
      const qs = ["select=*", ...eqFilters(eq)];
      if (order?.col) qs.push(`order=${encodeURIComponent(order.col)}.${order.asc ? "asc" : "desc"}`);
      const r = await fetch(`${rest}?${qs.join("&")}`, { headers: H });
      return res.status(r.status).json(await r.json());
    }

    if (action === "insert") {
      const r = await fetch(rest, {
        method: "POST",
        headers: { ...H, Prefer: "return=representation" },
        body: JSON.stringify(rows),
      });
      return res.status(r.status).json(await r.json());
    }

    if (action === "update") {
      const r = await fetch(`${rest}?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { ...H, Prefer: "return=representation" },
        body: JSON.stringify(values),
      });
      return res.status(r.status).json(await r.json());
    }

    // Upsert on a unique column (Daily uses date). onConflict = "date".
    if (action === "upsert") {
      const conflict = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
      const r = await fetch(`${rest}${conflict}`, {
        method: "POST",
        headers: { ...H, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(rows),
      });
      return res.status(r.status).json(await r.json());
    }

    if (action === "delete") {
      const r = await fetch(`${rest}?id=eq.${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { ...H, Prefer: "return=representation" },
      });
      return res.status(r.status).json(await r.json());
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
