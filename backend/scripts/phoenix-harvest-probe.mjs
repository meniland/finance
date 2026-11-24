import puppeteer from 'puppeteer-core';
import { readFile, writeFile, mkdir } from 'fs/promises';

const AUTH = process.env.PHOENIX_AUTH_STATE_PATH || '/app/sessions/phoenix/auth-state.json';
const OUT = '/tmp/scraper-runs/phoenix-harvest-probe.json';
const auth = JSON.parse(await readFile(AUTH, 'utf8'));

const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });
await page.setUserAgent(
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
);
await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });

const client = await page.createCDPSession();
const cookies = (auth.cookies || []).map((c) => {
  const out = {
    name: c.name,
    value: String(c.value),
    domain: c.domain || '.fnx.co.il',
    path: c.path || '/',
    secure: c.secure !== false,
    httpOnly: Boolean(c.httpOnly),
  };
  if (Number(c.expires) > 0) out.expires = Number(c.expires);
  return out;
});
await client.send('Network.setCookies', { cookies });

const captured = [];
page.on('response', (response) => {
  const type = response.headers()['content-type'] || '';
  const url = response.url();
  if (response.status() >= 400) return;
  if (!(type.includes('json') || /api|graphql|json/i.test(url))) return;
  if (!/fnx|auth0|oauth|api|graphql|policy|product|fund|balance|account|pension|gemel|hishtal|saving|portfolio|fee|yield|track/i.test(url)) {
    return;
  }
  response
    .text()
    .then((body) => {
      if (!body || body.length > 2_000_000) return;
      try {
        captured.push({ url, status: response.status(), data: JSON.parse(body) });
      } catch {
        captured.push({ url, status: response.status(), text: body.slice(0, 400) });
      }
    })
    .catch(() => {});
});

async function goto(url) {
  console.info('goto', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => console.error(e.message));
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 25000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
}

await goto('https://my.fnx.co.il/');
await goto('https://my.fnx.co.il/savings');

// click product-ish links
await page.evaluate(() => {
  const labels = ['השתלמות', 'גמל', 'פנסיה', 'פירוט', 'חשבון', 'יתרה'];
  for (const node of document.querySelectorAll('a,button,[role=button]')) {
    const t = (node.innerText || '').replace(/\s+/g, ' ').trim();
    if (labels.some((l) => t.includes(l)) && t.length < 40) {
      node.click();
      break;
    }
  }
});
await new Promise((r) => setTimeout(r, 4000));

const snap = await page.evaluate(() => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 6000),
    money: [...text.matchAll(/₪\s*([\d,]{2,}(?:\.\d+)?)/g)].map((m) => m[0]).slice(0, 40),
    moneyNear: [
      ...text.matchAll(
        /([א-תA-Za-z ]{2,40})[^\d₪]{0,30}₪\s*([\d,]{2,}(?:\.\d+)?)/g,
      ),
    ]
      .map((m) => `${m[1].trim()} = ${m[2]}`)
      .slice(0, 40),
  };
});

// Try common API paths from the logged-in page
const apiTries = [
  '/api/savings',
  '/api/products',
  '/api/policies',
  '/api/accounts',
  '/api/portfolio',
  '/api/customer/products',
  '/api/v1/savings',
  '/api/v1/products',
  '/bff/savings',
  '/bff/products',
];
const apiHits = {};
for (const path of apiTries) {
  apiHits[path] = await page.evaluate(async (p) => {
    try {
      const res = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 300) };
      }
      return { status: res.status, data };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  }, path);
  console.info('api', path, apiHits[path]?.status || apiHits[path]?.error);
}

await mkdir('/tmp/scraper-runs', { recursive: true });
const report = {
  snap,
  captured: captured.map((c) => ({
    url: c.url,
    status: c.status,
    keys: c.data && typeof c.data === 'object' ? Object.keys(c.data).slice(0, 40) : null,
    preview: JSON.stringify(c.data || c.text)?.slice(0, 500),
  })),
  capturedFull: captured.slice(0, 60),
  apiHits,
};
await writeFile(OUT, JSON.stringify(report, null, 2));
console.info('wrote', OUT, 'captured', captured.length, 'url', page.url());
await browser.close();
