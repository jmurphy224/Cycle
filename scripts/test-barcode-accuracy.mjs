// scripts/test-barcode-accuracy.mjs
// Hits the REAL Open Food Facts / USDA APIs with real barcodes and checks
// results against known label values. Run this somewhere with open internet
// (your laptop, or against a deployed Vercel URL) — it will NOT run inside a
// sandboxed session with restricted egress.
//
// Usage:
//   node scripts/test-barcode-accuracy.mjs                  # calls the real APIs directly
//   BARCODE_API=https://your-app.vercel.app node scripts/test-barcode-accuracy.mjs  # via your deployed /api/barcode
//
// Set USDA_FDC_API_KEY in your shell env if you want the USDA-fallback path
// exercised too (get one free at api.data.gov/signup); Open Food Facts needs
// no key.

const BARCODE_API = process.env.BARCODE_API; // e.g. https://your-app.vercel.app

// Real UPCs with well-known label values. calories tolerance is generous
// (+/-15%) because Open Food Facts entries are community-submitted and
// serving-size text varies by package revision.
const CASES = [
  { code: "049000028911", name: "Coca-Cola (12 fl oz can)", expectDescriptionMatch: /coca.?cola|coke/i, expectCalories: [130, 150] },
  { code: "016000275270", name: "Cheerios (1 cup)", expectDescriptionMatch: /cheerios/i, expectCalories: [90, 110] },
  { code: "884912000018", name: "Kind Bar (Dark Choc Nuts & Sea Salt)", expectDescriptionMatch: /kind/i, expectCalories: [170, 210] },
  { code: "038000138416", name: "Kellogg's Frosted Flakes (3/4 cup)", expectDescriptionMatch: /frosted flakes/i, expectCalories: [100, 130] },
  { code: "070470004160", name: "Chobani Plain Greek Yogurt (5.3oz cup)", expectDescriptionMatch: /chobani/i, expectCalories: [100, 150] },
];

async function lookupViaApi(code) {
  const base = BARCODE_API ? `${BARCODE_API.replace(/\/$/, "")}/api/barcode` : null;
  if (base) {
    const r = await fetch(`${base}?code=${encodeURIComponent(code)}`);
    if (!r.ok) return null;
    return r.json();
  }
  // No deployed URL given -> import the lookup module directly.
  const { lookupBarcode } = await import("../api/barcode.js");
  return lookupBarcode(code);
}

async function run() {
  console.log(BARCODE_API ? `Testing against ${BARCODE_API}/api/barcode\n` : "Testing lookupBarcode() directly (Open Food Facts, + USDA if USDA_FDC_API_KEY is set)\n");
  let hits = 0, misses = 0, outOfRange = 0;

  for (const c of CASES) {
    process.stdout.write(`${c.code}  ${c.name} ... `);
    try {
      const r = await lookupViaApi(c.code);
      if (!r || r.calories == null) {
        console.log("MISS (no product found)");
        misses++;
        continue;
      }
      const nameOk = c.expectDescriptionMatch.test(r.description || "");
      const calOk = r.calories >= c.expectCalories[0] && r.calories <= c.expectCalories[1];
      if (nameOk && calOk) {
        console.log(`ok — "${r.description}", ${r.calories} kcal (${r.source})`);
        hits++;
      } else {
        console.log(`OUT OF RANGE — "${r.description}", ${r.calories} kcal, expected ${c.expectCalories[0]}-${c.expectCalories[1]} (${r.source})`);
        outOfRange++;
      }
    } catch (e) {
      console.log("ERROR — " + e.message);
      misses++;
    }
  }

  console.log(`\n${hits}/${CASES.length} matched, ${outOfRange} out of expected range, ${misses} not found`);
}

run();
