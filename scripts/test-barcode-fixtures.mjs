// scripts/test-barcode-fixtures.mjs
// Offline correctness test for api/barcode.js's parsing/scaling math. Uses
// canned responses shaped like real Open Food Facts / USDA FDC payloads —
// no network access required, so this runs anywhere (including sandboxes
// with restricted egress).
//
// This checks the CODE is right, not that the real APIs return good data
// for real products. For that, run scripts/test-barcode-accuracy.mjs
// somewhere with open internet.
//
// Run:  node scripts/test-barcode-fixtures.mjs

// Set before importing barcode.js so its module-level USDA_KEY constant
// picks it up — this only fakes the presence of a key so the USDA-fallback
// branch is exercised; no real request reaches USDA in this test.
process.env.USDA_FDC_API_KEY = "test-key";
const { lookupOpenFoodFacts, lookupUsdaBranded, lookupBarcode } = await import("../api/barcode.js");

let pass = 0, fail = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ok  - ${name}`);
  } else {
    fail++;
    console.log(`FAIL  - ${name}`);
    console.log(`        expected: ${e}`);
    console.log(`        actual:   ${a}`);
  }
}

function mockFetch(map) {
  return async (url) => {
    for (const [pattern, respond] of map) {
      if (pattern.test(url)) return { ok: true, json: async () => respond };
    }
    return { ok: false, json: async () => ({}) };
  };
}

async function run() {
  console.log("Open Food Facts — per-serving nutriments present");
  {
    // Real-shaped example: a can of soda with explicit *_serving fields.
    const fetchImpl = mockFetch([
      [/openfoodfacts/, {
        status: 1,
        product: {
          product_name: "Cola",
          brands: "Acme, Bottling Co",
          serving_size: "355 ml",
          serving_quantity: 355,
          nutriments: {
            "energy-kcal_100g": 42, "energy-kcal_serving": 149,
            proteins_100g: 0, proteins_serving: 0,
            carbohydrates_100g: 10.6, carbohydrates_serving: 39,
            fat_100g: 0, fat_serving: 0,
            fiber_100g: 0, fiber_serving: 0,
          },
        },
      }],
    ]);
    const r = await lookupOpenFoodFacts("049000028911", fetchImpl);
    check("uses *_serving values directly, brand takes first name", r, {
      description: "Cola", brand: "Acme", servingText: "355 ml",
      calories: 149, protein: 0, carbs: 39, fat: 0, fiber: 0,
      source: "Open Food Facts",
    });
  }

  console.log("Open Food Facts — only per-100g nutriments, has serving_quantity");
  {
    const fetchImpl = mockFetch([
      [/openfoodfacts/, {
        status: 1,
        product: {
          product_name: "Greek Yogurt",
          serving_size: "150 g",
          serving_quantity: 150,
          nutriments: {
            "energy-kcal_100g": 59, proteins_100g: 10, carbohydrates_100g: 3.6, fat_100g: 0.4, fiber_100g: 0,
          },
        },
      }],
    ]);
    const r = await lookupOpenFoodFacts("00000012345", fetchImpl);
    // 150g is 1.5x the per-100g numbers.
    check("scales per-100g by serving_quantity/100", r, {
      description: "Greek Yogurt", brand: null, servingText: "150 g",
      calories: 89, protein: 15, carbs: 5, fat: 1, fiber: 0,
      source: "Open Food Facts",
    });
  }

  console.log("Open Food Facts — only per-100g, no serving_quantity at all");
  {
    const fetchImpl = mockFetch([
      [/openfoodfacts/, {
        status: 1,
        product: { product_name: "Trail Mix", nutriments: { "energy-kcal_100g": 480, proteins_100g: 14, carbohydrates_100g: 40, fat_100g: 30, fiber_100g: 6 } },
      }],
    ]);
    const r = await lookupOpenFoodFacts("00000099999", fetchImpl);
    check("falls back to 100g basis and labels it as such", r, {
      description: "Trail Mix", brand: null, servingText: "100 g",
      calories: 480, protein: 14, carbs: 40, fat: 30, fiber: 6,
      source: "Open Food Facts",
    });
  }

  console.log("Open Food Facts — not found (status 0)");
  {
    const fetchImpl = mockFetch([[/openfoodfacts/, { status: 0 }]]);
    const r = await lookupOpenFoodFacts("00000000000", fetchImpl);
    check("returns null on a miss instead of guessing", r, null);
  }

  console.log("USDA branded fallback — matches by exact GTIN, ignores leading zeros");
  {
    const fetchImpl = mockFetch([
      [/nal\.usda\.gov/, {
        foods: [
          { description: "Wrong Item", gtinUpc: "111111111111", foodNutrients: [] },
          {
            description: "Just Bare Chicken Tenderloins", brandOwner: "Just Bare",
            gtinUpc: "0049000028911", servingSize: 112, servingSizeUnit: "g",
            householdServingFullText: "3 tenders (112 g)",
            foodNutrients: [
              { nutrientId: 1008, value: 100 }, { nutrientId: 1003, value: 20 },
              { nutrientId: 1005, value: 0 }, { nutrientId: 1004, value: 1.5 }, { nutrientId: 1079, value: 0 },
            ],
          },
        ],
      }],
    ]);
    const r = await lookupUsdaBranded("49000028911", fetchImpl);
    check("scales USDA per-100g by servingSize and reports household text", r, {
      description: "Just Bare Chicken Tenderloins", brand: "Just Bare", servingText: "3 tenders (112 g)",
      calories: 112, protein: 22, carbs: 0, fat: 2, fiber: 0,
      source: "USDA",
    });
  }

  console.log("USDA branded fallback — servingSizeUnit isn't grams, falls back to 100g basis");
  {
    const fetchImpl = mockFetch([
      [/nal\.usda\.gov/, {
        foods: [{
          description: "Some Beverage", gtinUpc: "12345678901", servingSize: 12, servingSizeUnit: "fl oz",
          foodNutrients: [{ nutrientId: 1008, value: 45 }],
        }],
      }],
    ]);
    const r = await lookupUsdaBranded("12345678901", fetchImpl);
    check("non-gram serving unit -> 100g basis, not multiplied by fl-oz count", r, {
      description: "Some Beverage", brand: null, servingText: "100 g",
      calories: 45, protein: 0, carbs: 0, fat: 0, fiber: 0,
      source: "USDA",
    });
  }

  console.log("USDA branded fallback — no GTIN match in results");
  {
    const fetchImpl = mockFetch([[/nal\.usda\.gov/, { foods: [{ description: "Unrelated", gtinUpc: "999", foodNutrients: [] }] }]]);
    const r = await lookupUsdaBranded("12345678901", fetchImpl);
    check("returns null when nothing matches the scanned code exactly", r, null);
  }

  console.log("lookupBarcode — OFF miss falls through to USDA, non-digits stripped from input");
  {
    const fetchImpl = mockFetch([
      [/openfoodfacts/, { status: 0 }],
      [/nal\.usda\.gov/, {
        foods: [{ description: "Fallback Item", gtinUpc: "49000028911", servingSize: 100, servingSizeUnit: "g", foodNutrients: [{ nutrientId: 1008, value: 200 }] }],
      }],
    ]);
    const r = await lookupBarcode("049-000-028911", fetchImpl);
    check("dashes stripped, OFF miss -> USDA hit", r?.description, "Fallback Item");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

run();
