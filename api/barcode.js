// api/barcode.js
// Vercel serverless proxy for barcode/UPC lookups. A scanned code hits Open
// Food Facts first (free, no key, huge packaged-food coverage, label-sourced
// nutrition) and falls back to USDA FoodData Central branded foods (needs
// USDA_FDC_API_KEY, same env var api/nutrition.js already uses) when Open
// Food Facts has no match.
//
// Both are OPTIONAL — Open Food Facts needs no key at all, so barcode
// lookup works out of the box even without USDA_FDC_API_KEY set.

const USDA_KEY = process.env.USDA_FDC_API_KEY;

const NUTRIENT_IDS = { calories: 1008, protein: 1003, carbs: 1005, fat: 1004, fiber: 1079 };

const round = (n) => (n == null ? null : Math.round(n));
const normalize = (code) => String(code || "").replace(/^0+(?=\d)/, "");

// Exported (in addition to the default handler) so a standalone script can
// import this same lookup logic and test it against real barcodes without
// going through the HTTP layer — see scripts/test-barcode-accuracy.mjs.
export async function lookupOpenFoodFacts(code, fetchImpl = fetch) {
  const r = await fetchImpl(
    `https://world.openfoodfacts.org/api/v2/product/${code}.json?fields=product_name,brands,serving_size,serving_quantity,quantity,nutriments`
  );
  if (!r.ok) return null;
  const data = await r.json();
  if (data?.status !== 1 || !data.product) return null;
  const p = data.product;
  const n = p.nutriments || {};

  let calories, protein, carbs, fat, fiber, servingText;
  if (n["energy-kcal_serving"] != null) {
    calories = n["energy-kcal_serving"];
    protein = n["proteins_serving"];
    carbs = n["carbohydrates_serving"];
    fat = n["fat_serving"];
    fiber = n["fiber_serving"];
    servingText = p.serving_size || null;
  } else if (n["energy-kcal_100g"] != null) {
    const grams = p.serving_quantity || 100;
    const scale = grams / 100;
    calories = n["energy-kcal_100g"] * scale;
    protein = (n.proteins_100g || 0) * scale;
    carbs = (n.carbohydrates_100g || 0) * scale;
    fat = (n.fat_100g || 0) * scale;
    fiber = (n.fiber_100g || 0) * scale;
    servingText = p.serving_size || (grams === 100 ? "100 g" : null);
  } else {
    return null;
  }
  if (calories == null) return null;

  return {
    description: p.product_name || "Scanned item",
    brand: p.brands ? p.brands.split(",")[0].trim() : null,
    servingText,
    calories: round(calories),
    protein: round(protein),
    carbs: round(carbs),
    fat: round(fat),
    fiber: round(fiber),
    source: "Open Food Facts",
  };
}

export async function lookupUsdaBranded(code, fetchImpl = fetch) {
  if (!USDA_KEY) return null;
  const params = new URLSearchParams({ api_key: USDA_KEY, query: code, dataType: "Branded" });
  const r = await fetchImpl(`https://api.nal.usda.gov/fdc/v1/foods/search?${params}`);
  if (!r.ok) return null;
  const data = await r.json();
  const food = (data.foods || []).find((f) => normalize(f.gtinUpc) === normalize(code));
  if (!food) return null;

  const per100 = {};
  for (const nut of food.foodNutrients || []) {
    for (const [key, id] of Object.entries(NUTRIENT_IDS)) if (nut.nutrientId === id) per100[key] = nut.value;
  }
  if (per100.calories == null) return null;

  const grams = /^g/i.test(food.servingSizeUnit || "") ? food.servingSize : 100;
  const scale = grams / 100;
  return {
    description: food.description,
    brand: food.brandOwner || null,
    servingText: food.householdServingFullText || `${Math.round(grams)} g`,
    calories: round((per100.calories || 0) * scale),
    protein: round((per100.protein || 0) * scale),
    carbs: round((per100.carbs || 0) * scale),
    fat: round((per100.fat || 0) * scale),
    fiber: round((per100.fiber || 0) * scale),
    source: "USDA",
  };
}

export async function lookupBarcode(rawCode, fetchImpl = fetch) {
  const code = String(rawCode || "").replace(/\D/g, "");
  if (!code) return null;
  return (await lookupOpenFoodFacts(code, fetchImpl)) || (await lookupUsdaBranded(code, fetchImpl));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const code = (req.query?.code || "").toString().trim();
  if (!code) return res.status(400).json({ error: "Missing code" });

  try {
    const result = await lookupBarcode(code);
    if (!result) return res.status(404).json({ error: "No product found for that barcode" });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
