// api/_db.js
// Minimal Supabase (PostgREST) client for server routes, using the
// service_role key so it NEVER reaches the browser.
//
// Env vars to set in Vercel (Project -> Settings -> Environment Variables):
//   SUPABASE_URL          -> https://YOURPROJECT.supabase.co
//   SUPABASE_SERVICE_KEY  -> the service_role key (Settings -> API in Supabase)

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

export const dbConfigured = Boolean(URL && KEY);

// db("food_log?select=*", {method, body, prefer}) -> {ok, status, data}
export async function db(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: r.ok, status: r.status, data };
}
