// api/nutrition.js
// Vercel serverless proxy to USDA FoodData Central — looks up real label/lab
// nutrition data for a food instead of trusting an AI guess.
//
// Env var to set in Vercel (Project -> Settings -> Environment Variables):
//   USDA_FDC_API_KEY -> free, instant key at api.data.gov/signup
//
// This is OPTIONAL. If unset, or if no confident match is found, the front
// end falls back to the AI's own estimate for that item.
//
// Query params:
//   q      food name to search, e.g. "chicken breast grilled"
//   qty    amount as the user said it, e.g. "6 oz", "1 cup", "4 tenders"
//   brand  optional brand name — only then are Branded foods searched
//   grams  optional AI-estimated weight, used when qty can't be converted

import { requireUser } from "./_auth.js";

const KEY = process.env.USDA_FDC_API_KEY;

// Energy shows up under 1008 for most foods, but Foundation foods often only
// carry the Atwater-factor variants (2047 general, 2048 specific).
const NUTRIENT_IDS = { calories: [1008, 2047, 2048], protein: [1003], carbs: [1005], fat: [1004], fiber: [1079] };
const NUTRIENT_NAMES = {
  calories: /^energy$/i,
  protein: /^protein$/i,
  carbs: /^carbohydrate, by difference$/i,
  fat: /^total lipid \(fat\)$/i,
  fiber: /^fiber, total dietary$/i,
};

// Units convertible without knowing anything about the food.
const MASS_G = {
  g: 1, gram: 1, grams: 1,
  kg: 1000,
  oz: 28.3495, ounce: 28.3495, ounces: 28.3495,
  lb: 453.592, lbs: 453.592, pound: 453.592, pounds: 453.592,
};
// Volume units need a matching portion on the food (a cup of rice and a cup
// of spinach weigh very different amounts), so these are just aliases.
const VOLUME_ALIASES = {
  cup: ["cup"], cups: ["cup"],
  tbsp: ["tbsp", "tablespoon"], tablespoon: ["tbsp", "tablespoon"], tablespoons: ["tbsp", "tablespoon"],
  tsp: ["tsp", "teaspoon"], teaspoon: ["tsp", "teaspoon"], teaspoons: ["tsp", "teaspoon"],
  "fl oz": ["fl oz"], ml: ["ml"],
};

const STOP = new Set(["the", "a", "an", "of", "with", "and", "in", "raw", "cooked", "fresh", "plain"]);
const tokens = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((t) => t.length > 1 && !STOP.has(t));

// "1 1/2 cups" -> 1.5, "½" -> 0.5, "2.5 oz" -> 2.5
function parseAmount(qty) {
  const s = qty.replace(/½/g, " 1/2").replace(/¼/g, " 1/4").replace(/¾/g, " 3/4").trim();
  const m = s.match(/^(\d+(?:\.\d+)?)?\s*(?:(\d+)\/(\d+))?/);
  let n = 0;
  if (m?.[1]) n += parseFloat(m[1]);
  if (m?.[2] && m?.[3]) n += parseInt(m[2]) / parseInt(m[3]);
  // "1/2 cup" parses as 1 then "/2" — handle a bare fraction explicitly.
  const frac = s.match(/^(\d+)\/(\d+)/);
  if (frac) n = parseInt(frac[1]) / parseInt(frac[2]);
  const unit = s.replace(/^[\d.\s/]+/, "").trim().toLowerCase();
  return { n: n || 1, unit };
}

// Every portion description a search hit carries, normalized to
// {text, perUnit} where perUnit is grams for ONE of that unit
// ("1/2 cup = 70 g" -> 140 g per cup).
function portionsOf(food) {
  const out = [];
  for (const m of food.foodMeasures || []) {
    const text = `${m.disseminationText || ""} ${m.modifier || ""}`.toLowerCase();
    if (m.gramWeight) out.push({ text, perUnit: m.gramWeight / parseAmount(text).n });
  }
  for (const p of food.foodPortions || []) {
    const text = `${p.modifier || ""} ${p.portionDescription || ""}`.toLowerCase();
    if (p.gramWeight) out.push({ text, perUnit: p.gramWeight / (p.amount || 1) });
  }
  const hh = (food.householdServingFullText || "").match(/([\d.\/]+)[^(]*\(([\d.]+)\s*g\)/i);
  if (hh) out.push({ text: food.householdServingFullText.toLowerCase(), perUnit: parseFloat(hh[2]) / parseAmount(hh[1]).n });
  return out;
}

// Resolve the stated quantity to grams, or null if we can't do it honestly.
function gramsFor(food, qty, aiGrams) {
  const { n, unit } = parseAmount(qty);
  const word = unit.split(/\s+/)[0] || "";

  if (MASS_G[word]) return { grams: n * MASS_G[word], how: "weight" };

  const vol = VOLUME_ALIASES[unit.startsWith("fl oz") ? "fl oz" : word];
  if (vol) {
    const p = portionsOf(food).find((p) => vol.some((v) => p.text.includes(v)));
    if (p) return { grams: n * p.perUnit, how: "portion" };
  }

  if (/serving/.test(unit) && food.servingSize && /^g/i.test(food.servingSizeUnit || "")) {
    return { grams: n * food.servingSize, how: "label serving" };
  }

  // Count words: "4 tenders", "2 large eggs", "1 banana".
  const singular = word.replace(/(es|s)$/, "");
  if (singular) {
    const p = portionsOf(food).find((p) => p.text.includes(singular));
    if (p) return { grams: n * p.perUnit, how: "portion" };
  }

  // Couldn't convert the unit from the database — use the AI's weight
  // estimate rather than guessing a random portion.
  if (aiGrams > 0) return { grams: aiGrams, how: "estimated weight" };
  return null;
}

function nutrientsOf(food) {
  const per100 = {};
  for (const n of food.foodNutrients || []) {
    for (const [key, ids] of Object.entries(NUTRIENT_IDS)) {
      if (per100[key] == null && ids.includes(n.nutrientId)) per100[key] = n.value;
    }
    for (const [key, pat] of Object.entries(NUTRIENT_NAMES)) {
      if (per100[key] == null && pat.test(n.nutrientName || "")) per100[key] = n.value;
    }
  }
  return per100;
}

// Fraction of the query's words that appear in the candidate's name/brand.
function matchScore(food, q, brand) {
  const want = tokens(q);
  if (!want.length) return 0;
  // berries->berry, tomatoes->tomato, grapes->grape, eggs->egg
  const stem = (t) => t.replace(/ies$/, "y").replace(/(ch|sh|x|o|ss)es$/, "$1").replace(/([^s])s$/, "$1");
  const wantSet = new Set(want.map(stem));
  const have = new Set(tokens(`${food.description} ${food.brandOwner || ""} ${food.brandName || ""}`).map(stem));
  let hit = 0;
  for (const t of wantSet) if (have.has(t)) hit++;
  let score = hit / wantSet.size;
  // Words in the name that weren't asked for usually mean a different food
  // ("banana chips" when you said "banana").
  const extra = tokens(food.description).map(stem).filter((t) => !wantSet.has(t)).length;
  score -= Math.min(0.3, extra * 0.06);
  if (brand) {
    const b = tokens(brand).map(stem);
    const brandHit = b.some((t) => have.has(t));
    score = brandHit ? score + 0.25 : score - 0.6;
  }
  return score;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry a couple of times before giving up on a transient upstream blip.
async function searchFdc(url, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url);
    const raw = await r.text();
    let data;
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      last = { transient: true, status: r.status, body: raw.slice(0, 300) };
      if (i < attempts - 1) { await sleep(250 * (i + 1)); continue; }
      return last;
    }
    if (!r.ok && r.status >= 500 && i < attempts - 1) {
      last = { transient: true, status: r.status, body: JSON.stringify(data).slice(0, 300) };
      await sleep(250 * (i + 1));
      continue;
    }
    return { ok: r.ok, status: r.status, data };
  }
  return last;
}

async function search(q, dataType) {
  const params = new URLSearchParams({ api_key: KEY, query: q, pageSize: "25" });
  if (dataType) params.set("dataType", dataType);
  return searchFdc(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`);
}

export default async function handler(req, res) {
  if (!requireUser(req, res)) return;
  if (!KEY) return res.status(503).json({ error: "USDA nutrition lookup not configured" });

  const q = (req.query?.q || "").toString().trim();
  const qty = (req.query?.qty || "1 serving").toString().trim();
  const brand = (req.query?.brand || "").toString().trim();
  const aiGrams = parseFloat(req.query?.grams) || 0;
  if (!q) return res.status(400).json({ error: "Missing q" });

  try {
    // Generic foods come from the lab datasets; only look at Branded when a
    // brand was actually named, so "banana" doesn't match a banana snack bar.
    const query = brand && !q.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${q}` : q;
    let result = await search(query, brand ? "Branded" : "Foundation,SR Legacy,Survey (FNDDS)");
    // Fall back to the plain, known-good request if the filtered one fails
    // or comes back empty.
    if (!result?.ok || !(result.data?.foods || []).length) result = await search(query);
    if (result?.transient) {
      return res.status(502).json({ error: "USDA returned a non-JSON response after retries", status: result.status, body: result.body });
    }
    const { ok, status, data } = result;
    if (!ok) return res.status(status).json({ error: data?.message || data?.error?.message || "USDA search failed", detail: data });

    const ranked = (data.foods || [])
      .map((f) => ({ f, score: matchScore(f, q, brand) }))
      .filter((x) => nutrientsOf(x.f).calories != null)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    // Below this the "match" is usually a different food entirely.
    if (!best || best.score < 0.5) return res.status(404).json({ error: "No confident match found" });

    const food = best.f;
    const per100 = nutrientsOf(food);
    const portion = gramsFor(food, qty, aiGrams);
    if (!portion) return res.status(404).json({ error: "Couldn't resolve a portion size" });

    const scale = portion.grams / 100;
    return res.status(200).json({
      description: food.description,
      brand: food.brandOwner || null,
      dataType: food.dataType,
      grams: Math.round(portion.grams),
      portionFrom: portion.how,
      matchScore: Math.round(best.score * 100) / 100,
      calories: Math.round((per100.calories || 0) * scale),
      protein: Math.round((per100.protein || 0) * scale),
      carbs: Math.round((per100.carbs || 0) * scale),
      fat: Math.round((per100.fat || 0) * scale),
      fiber: Math.round((per100.fiber || 0) * scale),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
