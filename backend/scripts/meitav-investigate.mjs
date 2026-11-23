import puppeteer from 'puppeteer-core';
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

const AUTH = process.env.MEITAV_PENSION_AUTH_STATE_PATH || '/app/data/meitav-pension-auth-state.json';
const OUT = '/tmp/scraper-runs/meitav-investigate.json';

const auth = JSON.parse(await readFile(AUTH, 'utf8'));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });
await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });
if (auth.cookies?.length) await page.setCookie(...auth.cookies);

const captured = [];
page.on('response', (response) => {
  const type = response.headers()['content-type'] || '';
  const url = response.url();
  if (response.status() >= 400) return;
  if (!(type.includes('json') || /api|graphql|json/i.test(url))) return;
  if (!/meitav|customers|openhub|amit|account|product|lobby|fund|pension|gemel/i.test(url)) return;
  response
    .text()
    .then((body) => {
      if (!body || body.length > 1_500_000) return;
      try {
        captured.push({ url, status: response.status(), data: JSON.parse(body) });
      } catch {
        /* ignore */
      }
    })
    .catch(() => {});
});

async function gotoSafe(url) {
  for (let i = 0; i < 3; i += 1) {
    try {
      console.info(`goto ${url} attempt=${i + 1}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});
      return page.url();
    } catch (error) {
      console.error(`goto fail ${url}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return page.url();
}

await gotoSafe('https://customers.meitav.co.il/');
await new Promise((r) => setTimeout(r, 2000));
await gotoSafe('https://customers.meitav.co.il/home/myaccount/allaccounts');
await new Promise((r) => setTimeout(r, 3000));
console.info('url', page.url());

const paths = [
  'api/AmitLobby/getHeaderData',
  'api/AmitLobby/GetUserName',
  'api/AmitLobby/GetAllAccounts',
  'api/AmitLobby/GetProducts',
  'api/Accounts/GetAllAccounts',
  'api/AmitLobby/GetAccountsSummary',
  'api/AmitLobby/GetCustomerProducts',
  'api/MyAccount/GetAllAccounts',
  'api/MyAccount/GetProducts',
  'api/Home/GetAllAccounts',
  'api/Products/GetAllProducts',
  'api/Product/GetProducts',
];

const lobby = {};
for (const p of paths) {
  lobby[p] = await page.evaluate(async (urlPath) => {
    try {
      const response = await fetch(`/v2/${urlPath}`, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text?.slice?.(0, 800) };
      }
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      return { error: String(error.message || error) };
    }
  }, p);
  const preview = JSON.stringify(lobby[p]?.data)?.slice(0, 180);
  console.info(p, lobby[p]?.status, lobby[p]?.ok, preview || lobby[p]?.error || '');
}

const dom = await page.evaluate(() => {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const links = [...document.querySelectorAll('a,button,[role="tab"],[ui-sref]')]
    .map((el) => ({
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      href: el.getAttribute('href') || el.getAttribute('ui-sref') || '',
    }))
    .filter((x) => x.text && /(פנס|גמל|השתל|חיסכון|השקע|תיק|מוצר|חשבון|יתר)/i.test(x.text))
    .slice(0, 80);
  return {
    url: location.href,
    title: document.title,
    textSample: text.slice(0, 5000),
    moneyHits: [
      ...text.matchAll(
        /(פנסיה|גמל|השתלמות|חיסכון|השקעה|תיק)[^\d₪]{0,40}₪?\s*([\d,]{2,}(?:\.\d+)?)/gi,
      ),
    ]
      .map((m) => m[0])
      .slice(0, 40),
    links,
  };
});

await mkdir(path.dirname(OUT), { recursive: true });
const report = {
  savedAt: auth.savedAt,
  pageUrl: page.url(),
  dom,
  lobby,
  capturedUrls: captured.map((c) => ({
    url: c.url,
    status: c.status,
    keys:
      c.data && typeof c.data === 'object'
        ? Object.keys(c.data).slice(0, 40)
        : typeof c.data,
  })),
  captured: captured.slice(0, 60),
};
await writeFile(OUT, JSON.stringify(report, null, 2));
console.info('wrote', OUT, 'captured', captured.length);
await browser.close();
