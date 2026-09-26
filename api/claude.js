// api/claude.js
// Vercel serverless proxy to the Anthropic API, so your API key stays
// server-side and never ships to the browser.
//
// Env vars to set in Vercel (Project -> Settings -> Environment Variables):
//   ANTHROPIC_API_KEY  -> your key from console.anthropic.com (starts "sk-ant-")
//   APP_PASSCODE       -> see api/_auth.js
//
// This is OPTIONAL. Cycle works as a full tracker without it (manual entry).
// Set it up when you want the "describe your meal and it fills in the macros"
// and "what should I eat here" features.
//
// The browser picks a tier, not a model: "smart" for food parsing and photo
// estimates (where accuracy matters most), "fast" for short advice. Passing a
// JSON schema turns on structured outputs, so the reply is always valid JSON
// matching that shape — no more parsing prose or markdown fences.

import Anthropic from "@anthropic-ai/sdk";
import { requireAuth } from "./_auth.js";

const MODELS = {
  smart: "claude-sonnet-5",
  fast: "claude-haiku-4-5",
};
const MAX_TOKENS_CAP = 4096;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;
  if (!client) return res.status(503).json({ error: "AI not configured" });

  const { tier = "fast", system, messages, schema, max_tokens = 1500 } = req.body || {};
  const model = MODELS[tier];
  if (!model) return res.status(400).json({ error: `Unknown tier: ${tier}` });
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "Missing messages" });

  const output_config = {};
  if (schema) output_config.format = { type: "json_schema", schema };
  // Effort isn't supported on Haiku 4.5; on Sonnet 5 "medium" keeps food
  // estimates careful without making the phone wait too long.
  if (tier === "smart") output_config.effort = "medium";

  try {
    const response = await client.messages.create({
      model,
      max_tokens: Math.min(+max_tokens || 1500, MAX_TOKENS_CAP),
      system,
      messages,
      ...(Object.keys(output_config).length ? { output_config } : {}),
    });

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The AI declined that request — try rephrasing or log manually." });
    }
    if (response.stop_reason === "max_tokens") {
      return res.status(422).json({ error: "That was too much for one go — try splitting it into a couple of entries." });
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    let data = null;
    if (schema) {
      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({ error: "AI returned malformed JSON" });
      }
    }
    return res.status(200).json({ text, data });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: "AI is busy — try again in a moment." });
    }
    if (e instanceof Anthropic.BadRequestError) {
      return res.status(400).json({ error: e.message });
    }
    if (e instanceof Anthropic.APIError) {
      return res.status(e.status || 502).json({ error: e.message });
    }
    return res.status(500).json({ error: String(e) });
  }
}
