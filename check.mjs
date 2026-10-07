// QuickFinds user-view check (2026-10-07, after a night of glitches nobody saw: Home photos went white,
// new searches lost Google results when Serper ran out of credits, and the nightly deals crawl never
// started). Every 10 minutes this does what a shopper's phone does and fails loudly when any of it
// breaks. Public endpoints only: no keys live here.
//
//   node check.mjs            the scheduled check
//   node check.mjs --fresh    also runs one search nobody has made before (after a Maya deploy)
//
// Output: one line per check, and results.json ({ ok, failures: [{ name, detail }] }) for the
// workflow that opens / closes the alert issue.
import { writeFileSync } from 'node:fs';

const MAYA = 'https://maya-api-production-6a31.up.railway.app';
const SUPA = 'https://cdcnxkmtdjbfexoeqywi.supabase.co';
const STORAGE = `${SUPA}/storage/v1/object/public/app-cache`;
const SITE = 'https://quickfinds.com';
const FRESH = process.argv.includes('--fresh');
const H = 3600e3;

const get = async (url, ms = 20000) => {
  const t = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'quickfinds-status/1' } });
  return { r, ms: Date.now() - t };
};
const json = async (url, ms) => { const { r, ms: t } = await get(url, ms); if (!r.ok) throw new Error(`HTTP ${r.status}`); return { j: await r.json(), ms: t }; };
const ago = (t) => `${((Date.now() - t) / H).toFixed(1)}h ago`;

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('Search server is up', async () => {
  const { j, ms } = await json(`${MAYA}/v1/health`, 15000);
  if (!j.ok) throw new Error('health says not ok');
  return `${ms}ms`;
});

check('Search has Google results (Serper working)', async () => {
  const { j } = await json(`${MAYA}/search-lab/stats`, 15000);
  // an error in the last 20 minutes means new searches are on the slow fallback or have no Google rows
  // or errors since restart with no successful call at all
  if ((j.serper_errors ?? 0) > 0 && !j.serper_requests) throw new Error(`Serper failing on every call: ${j.serper_last_error ?? 'error'} (${j.serper_errors} errors, 0 successes since restart)`);
  if (j.serper_last_error_at && Date.now() - j.serper_last_error_at < 20 * 60e3) throw new Error(`Serper failing: ${j.serper_last_error ?? 'error'} (${j.serper_errors} errors since restart)`);
  return `${j.serper_requests} Serper calls since restart, ${j.serper_errors ?? 0} errors`;
});

check('A search returns products', async () => {
  const qs = ['airpods pro', 'nike dunks', 'stanley cup', 'air fryer', 'ps5', 'iphone 16', 'hoodie', 'jbl speaker'];
  const q = FRESH ? `${qs[Math.floor(Math.random() * qs.length)]} ${['black', 'blue', 'white', 'gray', 'red'][Math.floor(Math.random() * 5)]} ${Date.now() % 97}` : qs[Math.floor(Date.now() / 600e3) % qs.length];
  const { j, ms } = await json(`${MAYA}/search-lab/products?q=${encodeURIComponent(q)}&limit=40`, 45000);
  const n = (j.products ?? []).length, g = j.lanes?.serper?.n ?? 0, tab = j.lanes?.tab?.n ?? 0;
  if (n < 8) throw new Error(`"${q}" returned ${n} products`);
  if (FRESH && g + tab === 0) throw new Error(`"${q}" has no Google products (serper ${j.lanes?.serper?.status}, tab ${j.lanes?.tab?.status})`);
  if (ms > 15000) throw new Error(`"${q}" took ${(ms / 1000).toFixed(1)}s`);
  return `"${q}": ${n} products, ${g + tab} from Google, ${(ms / 1000).toFixed(1)}s`;
});

check('Home featured photos load', async () => {
  const { j } = await json(`${MAYA}/home/featured`, 30000);
  const items = j.items ?? [];
  if (items.length < 6) throw new Error(`only ${items.length} featured products`);
  const imgs = items.slice(0, 6).map((it) => it.candidate?.image).filter(Boolean);
  let bad = 0;
  for (const u of imgs) { try { const { r } = await get(u, 15000); const ct = r.headers.get('content-type') ?? ''; await r.arrayBuffer(); if (!r.ok || !ct.startsWith('image/')) bad++; } catch { bad++; } }
  if (bad) throw new Error(`${bad} of ${imgs.length} featured photos fail to load (white squares)`);
  return `${items.length} products, photos load`;
});

check('Deals tab feed is fresh', async () => {
  const { j } = await json(`${STORAGE}/deals-v1/manifest.json`, 20000);
  const t = Date.parse(j.builtAt);
  if (Date.now() - t > 9 * H) throw new Error(`Deals tab feed last built ${ago(t)} (GitHub runs it every ~2-7h)`);
  if ((j.counts?.lite ?? 0) < 5000) throw new Error(`Deals tab feed has only ${j.counts?.lite} rows`);
  return `built ${ago(t)}, ${j.counts.lite} rows`;
});

check('Nightly deals crawl published', async () => {
  const { j } = await json(`${STORAGE}/store-deals-active.json`, 20000);
  const t = Date.parse(j.builtAt);
  // nightly publishes ~10-12am ET, midday ~2pm ET: older than 30h means a run was missed
  if (Date.now() - t > 30 * H) throw new Error(`deals last published ${ago(t)}: the nightly crawl (Mac mini) missed a run`);
  return `published ${ago(t)}, ${j.qf} deals`;
});

check('Cash back rates are current', async () => {
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!anon) return 'skipped (no anon key)';
  const req = await fetch(`${SUPA}/rest/v1/cashback_rates?select=updated_at&order=updated_at.desc&limit=1`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` }, signal: AbortSignal.timeout(15000) });
  if (!req.ok) throw new Error(`HTTP ${req.status}`);
  const t = Date.parse((await req.json())[0]?.updated_at);
  if (!(Date.now() - t < 36 * H)) throw new Error(`cash back rates last updated ${ago(t)} (daily job missed)`);
  return `updated ${ago(t)}`;
});

check('Website loads', async () => {
  const { r, ms } = await get(SITE, 20000);
  const body = await r.text();
  if (!r.ok || !/id="root"/.test(body)) throw new Error(`HTTP ${r.status}${r.ok ? ', page has no app root (white screen)' : ''}`);
  return `${ms}ms`;
});

const failures = [];
for (const c of checks) {
  try { const d = await c.fn(); console.log(`ok    ${c.name}: ${d}`); }
  catch (e) {
    // one retry: a single slow answer is not an outage
    try { await new Promise((r) => setTimeout(r, 5000)); const d = await c.fn(); console.log(`ok    ${c.name}: ${d} (on retry)`); }
    catch (e2) { const detail = String(e2?.message ?? e2).slice(0, 200); failures.push({ name: c.name, detail }); console.log(`FAIL  ${c.name}: ${detail}`); }
  }
}
writeFileSync('results.json', JSON.stringify({ ok: failures.length === 0, at: new Date().toISOString(), failures }, null, 1));
process.exit(0);
