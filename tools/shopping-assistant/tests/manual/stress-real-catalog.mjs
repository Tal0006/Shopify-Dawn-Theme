// Manual developer utility, not part of the build (tsconfig compiles src/ only) or of `npm test`
// (tests/*.test.ts only). Sends the 17 real-store stress queries, one at a time, to the LOCAL
// Shopping Assistant, which searches the real Shopify catalog configured in .env.
// It only calls POST /quote: never /resolve or /checkout, so no carts are created and nothing in
// Shopify changes.
//
// Usage (server running locally with `npm run dev`):
//   npm run stress:real-catalog
//   node tests/manual/stress-real-catalog.mjs 3 11     # only queries 3 and 11
const TARGET = 'http://127.0.0.1:4320/api/v1/shopping-list/quote';
const QUERIES = [
  'ג׳ל כביסה מקסימה בייבי',
  'מרכך כביסה עם ריח חזק',
  'אקונומיקה',
  'ספריי לניקוי חלונות',
  'חומר לניקוי רצפה בריח נעים',
  'נייר טואלט',
  'מגבות נייר למטבח',
  'שקיות אשפה גדולות',
  'סבון ידיים',
  'שמפו כיף',
  'מרכך שיער כיף',
  'תחליב רחצה כיף',
  'ספוגים לכלים',
  'מטליות לניקוי',
  'חד פעמי – כוסות וצלחות',
  'חומר לניקוי אסלות',
  'מסיר שומנים למטבח',
];
// The local server allows 30 /api requests per minute per IP: 2.5 s apart keeps a full run at
// about 24 per minute, leaving room for a rerun or a manual request.
const DELAY_MS = 2500;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const availability = p => (p.availableForSale ? 'זמין' : 'לא זמין');
const product = p => `${p.title}${p.variantTitle && p.variantTitle !== 'Default Title' ? ' / ' + p.variantTitle : ''} [${availability(p)}] ${p.unitPrice?.amount ?? '?'} ${p.unitPrice?.currencyCode ?? ''}`;
const OUTCOME = {
  matched: 'MATCHED (no selection needed)',
  ambiguous: 'AMBIGUOUS (customer selection required)',
  unavailable: 'UNAVAILABLE',
  not_found: 'NOT FOUND',
};

async function quote(message) {
  const body = Buffer.from(JSON.stringify({message}), 'utf8');
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(TARGET, {method: 'POST', headers: {'Content-Type': 'application/json; charset=utf-8'}, body});
    if (response.status === 429 && attempt === 0) {
      const wait = Math.min(60, Number(response.headers.get('retry-after')) || 30);
      console.log(`  rate limited; waiting ${wait}s and retrying once`);
      await sleep(wait * 1000);
      continue;
    }
    return {status: response.status, data: await response.json().catch(() => null)};
  }
}

function summarize(data) {
  console.log(`  canCheckout: ${data.canCheckout}   subtotal (resolved items only): ${data.subtotal ? data.subtotal.amount + ' ' + data.subtotal.currencyCode : '—'}`);
  data.items.forEach((item, index) => {
    console.log(`  item ${index + 1}: "${item.requested.originalText}" (quantity ${item.requested.quantity})`);
    console.log(`    outcome: ${OUTCOME[item.status] ?? item.status}   reason: ${item.reason}   confidence: ${Number(item.confidence).toFixed(2)}`);
    if (item.bestMatch) console.log(`    best match: ${product(item.bestMatch)}`);
    if (item.candidates?.length && !(item.status === 'matched' && item.candidates.length === 1)) {
      console.log(`    candidates (${item.candidates.length}, in ranked order):`);
      item.candidates.forEach((c, n) => console.log(`      ${n + 1}. ${product(c)}`));
    }
  });
}

const selected = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= QUERIES.length);
const run = selected.length ? selected : QUERIES.map((_, i) => i + 1);
try {
  const health = await fetch(new URL('/health', TARGET));
  if (!health.ok) throw Error('health ' + health.status);
} catch {
  console.error('The local Shopping Assistant is not reachable at http://127.0.0.1:4320. Start it with `npm run dev` first.');
  process.exit(1);
}
const totals = {};
for (const [position, number] of run.entries()) {
  if (position) await sleep(DELAY_MS);
  const query = QUERIES[number - 1];
  console.log('\n' + '='.repeat(72));
  console.log(`#${number}/${QUERIES.length}  ${query}`);
  console.log('='.repeat(72));
  try {
    const {status, data} = await quote(query);
    if (status !== 200 || !data?.items) {
      console.log(`  HTTP ${status}  error: ${data?.code ?? 'unknown'}  ${data?.message ?? ''}`);
      totals.error = (totals.error || 0) + 1;
      continue;
    }
    summarize(data);
    for (const item of data.items) totals[item.status] = (totals[item.status] || 0) + 1;
  } catch {
    console.log('  request failed (network error; is the local server still running?)');
    totals.error = (totals.error || 0) + 1;
  }
}
console.log('\n' + '='.repeat(72));
console.log('Summary by item:', Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(', '));
