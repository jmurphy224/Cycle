// api/youtube.js
// Vercel serverless proxy to the YouTube Data API, so the browser doesn't
// need its own key and search results can be embedded as a real video.
//
// Env var to set in Vercel (Project -> Settings -> Environment Variables):
//   YOUTUBE_API_KEY  -> from console.cloud.google.com, with "YouTube Data API v3" enabled
//
// This is OPTIONAL. Without it, the exercise video button falls back to a
// plain "search on YouTube" link instead of an inline player.

const KEY = process.env.YOUTUBE_API_KEY;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!KEY) return res.status(503).json({ error: "YouTube search not configured" });

  const q = (req.query?.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing q" });

  try {
    const params = new URLSearchParams({
      key: KEY,
      part: "snippet",
      type: "video",
      videoEmbeddable: "true",
      maxResults: "1",
      q,
    });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "YouTube search failed" });
    const id = data.items?.[0]?.id?.videoId;
    if (!id) return res.status(404).json({ error: "No video found" });
    return res.status(200).json({ id });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
