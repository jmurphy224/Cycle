// api/claude.js
// Vercel serverless proxy to the Anthropic API, so your API key stays
// server-side and never ships to the browser.
//
// Env var to set in Vercel (Project -> Settings -> Environment Variables):
//   ANTHROPIC_API_KEY  -> your key from console.anthropic.com (starts "sk-ant-")
//
// This is OPTIONAL. Cycle works as a full tracker without it (manual entry).
// Set it up when you want the "describe your meal and it fills in the macros"
// and "what should I eat here" features.

const MODEL = "claude-haiku-4-5-20251001"; // cheap + fast; swap to a larger model for more nuance
const KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!KEY) return res.status(503).json({ error: "AI not configured" });

  const { system, messages, max_tokens = 1024 } = req.body || {};
  if (!messages) return res.status(400).json({ error: "Missing messages" });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
