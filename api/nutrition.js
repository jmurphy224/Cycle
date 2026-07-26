// api/nutrition.js
// Vercel serverless proxy to USDA FoodData Central — looks up real label/lab
// nutrition data for a food instead of trusting an AI guess.
//
// Env var to set in Vercel (Project -> Settings -> Environment Variables):
//   USDA_FDC_API_KEY -> free, instant key at api.data.gov/signup
//
// This is OPTIONAL. If unset, or if no confident match is found, the front
// end falls back to the AI's own estimate for that item.

const KEY = process.env.USDA_FDC_API_KEY;

const NUTRIENT_IDS = { calories: 1008, protein: 1003, carbs: 1005, fat: 1004, fiber: 1079 };
const NUTRIENT_NAMES = {
  calories: /^energy$/i,
  protein: /^protein$/i,
  carbs: /^carbohydrate, by difference$/i,
  fat: /^total lipid \(fat\)$/i,
  fiber: /^fiber, total dietary$/i,
};

// "3 tenders (84 g)" -> {count:3, grams:84}. Loose on purpose — label text varies.
function parseHousehold(text) {
  const m = (text || "").match(/([\d.]+)[^(]*\(([\d.]+)\s*g\)/i);
  if (!m) return null;
  return { count: parseFloat(m[1]) || 1, grams: parseFloat(m[2]) };
}

function gramsForQuantity(food, leadingNum, unitWord, isServing) {
  if (isServing && food.servingSize && /^g/i.test(food.servingSizeUnit || "")) {
    return leadingNum * food.servingSize;
  }
  const hh = parseHousehold(food.householdServingFullText);
  if (hh && unitWord && (food.householdServingFullText || "").toLowerCase().includes(unitWord)) {
    return leadingNum * (hh.grams / hh.count);
  }
  if (Array.isArray(food.foodPortions) && food.foodPortions.length) {
    const p =
      food.foodPortions.find((p) =>
        `${p.modifier || ""} ${p.portionDescription || ""}`.toLowerCase().includes(unitWord)
      ) || food.foodPortions[0];
    if (p?.gramWeight) return leadingNum * (p.gramWeight / (p.amount || 1));
  }
  if (food.servingSize && /^g/i.test(food.servingSizeUnit || "")) return leadingNum * food.servingSize;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// USDA's gateway occasionally blips with a non-JSON block page (shared Vercel
// outbound IPs hitting a WAF) — a couple of quick retries usually clears it.
async function searchFdc(url, headers, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(url, { headers });
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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!KEY) return res.status(503).json({ error: "USDA nutrition lookup not configured" });

  const q = (req.query?.q || "").toString().trim();
  const qty = (req.query?.qty || "1 serving").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing q" });

  try {
    const params = new URLSearchParams({
      api_key: KEY,
      query: q,
      pageSize: "5",
      dataType: "Branded,Foundation,SR Legacy",
    });
    const result = await searchFdc(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`, {
      "User-Agent": "Cycle-MurphTracker/1.0 (+personal nutrition tracker)",
      Accept: "application/json",
      "X-Api-Key": KEY,
    });
    if (result?.transient) {
      return res.status(502).json({ error: "USDA returned a non-JSON response after retries", status: result.status, body: result.body });
    }
    const { ok, status, data } = result;
    if (!ok) return res.status(status).json({ error: data?.message || data?.error?.message || "USDA search failed", detail: data });
    const food = (data.foods || [])[0];
    if (!food) return res.status(404).json({ error: "No match found" });

    const leadingNum = parseFloat((qty.match(/[\d.]+/) || ["1"])[0]) || 1;
    const isServing = /serving/i.test(qty);
    const unitWord = qty.replace(/^[\d.]+\s*/, "").trim().toLowerCase().replace(/s$/, "");

    // Prefer the label's own per-serving numbers — exactly what's printed on the box.
    if (isServing && food.labelNutrients) {
      const ln = food.labelNutrients;
      return res.status(200).json({
        description: food.description,
        brand: food.brandOwner || null,
        grams: food.servingSize ? Math.round(food.servingSize * leadingNum) : null,
        calories: Math.round((ln.calories?.value || 0) * leadingNum),
        protein: Math.round((ln.protein?.value || 0) * leadingNum),
        carbs: Math.round((ln.carbohydrates?.value || 0) * leadingNum),
        fat: Math.round((ln.fat?.value || 0) * leadingNum),
        fiber: Math.round((ln.fiber?.value || 0) * leadingNum),
      });
    }

    const per100 = {};
    for (const n of food.foodNutrients || []) {
      for (const [key, id] of Object.entries(NUTRIENT_IDS)) if (n.nutrientId === id) per100[key] = n.value;
      for (const [key, pat] of Object.entries(NUTRIENT_NAMES)) if (per100[key] == null && pat.test(n.nutrientName || "")) per100[key] = n.value;
    }
    if (per100.calories == null) return res.status(404).json({ error: "No nutrient data" });

    const grams = gramsForQuantity(food, leadingNum, unitWord, isServing);
    if (!grams) return res.status(404).json({ error: "Couldn't resolve a portion size" });

    const scale = grams / 100;
    return res.status(200).json({
      description: food.description,
      brand: food.brandOwner || null,
      grams: Math.round(grams),
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
