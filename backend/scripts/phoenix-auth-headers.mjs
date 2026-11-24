import puppeteer from 'puppeteer-core';
import { readFile, writeFile } from 'fs/promises';

const AUTH = process.env.PHOENIX_AUTH_STATE_PATH || '/app/sessions/phoenix/auth-state.json';
const auth = JSON.parse(await readFile(AUTH, 'utf8'));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setUserAgent(
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
);
const client = await page.createCDPSession();
await client.send('Network.setCookies', {
  cookies: (auth.cookies || []).map((c) => ({
    name: c.name,
    value: String(c.value),
    domain: c.domain || '.fnx.co.il',
    path: c.path || '/',
    secure: c.secure !== false,
    httpOnly: Boolean(c.httpOnly),
    ...(Number(c.expires) > 0 ? { expires: Number(c.expires) } : {}),
  })),
});

const reqMeta = [];
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = req.url();
  if (/api\/v1\/info\/savings/i.test(url)) {
    reqMeta.push({ url, headers: req.headers() });
  }
  req.continue().catch(() => {});
});

await page.goto('https://my.fnx.co.il/savings', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 4000));

const storage = await page.evaluate(() => {
  const dump = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        out[k] = store.getItem(k);
      }
    } catch {
      /* ignore */
    }
    return out;
  };
  return {
    url: location.href,
    local: dump(localStorage),
    session: dump(sessionStorage),
  };
});

const pageHit = await page.evaluate(async () => {
  const paths = ['/api/v1/info/savings/page', '/api/v1/info/policy/savings/active'];
  const out = {};
  for (const p of paths) {
    const res = await fetch(p, { credentials: 'include', headers: { Accept: 'application/json' } });
    const text = await res.text();
    out[p] = { status: res.status, preview: text.slice(0, 300) };
  }
  return out;
});

await writeFile(
  '/tmp/scraper-runs/phoenix-auth-headers.json',
  JSON.stringify({ storage, reqMeta, pageHit, url: page.url() }, null, 2),
);
console.info('url', page.url());
console.info('reqMeta', reqMeta.length, reqMeta[0]?.url);
console.info('auth header keys', reqMeta[0] ? Object.keys(reqMeta[0].headers).filter((k)=>/auth|token|bear|cookie/i.test(k)) : []);
if (reqMeta[0]) {
  for (const [k,v] of Object.entries(reqMeta[0].headers)) {
    if (/auth|token|bear|x-/i.test(k)) console.info(k, String(v).slice(0,120));
  }
}
console.info('pageHit', pageHit);
console.info('local keys', Object.keys(storage.local || {}));
await browser.close();
