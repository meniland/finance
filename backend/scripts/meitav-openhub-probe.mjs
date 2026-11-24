import puppeteer from 'puppeteer-core';
import { readFile, writeFile, mkdir } from 'fs/promises';

const AUTH = process.env.MEITAV_PENSION_AUTH_STATE_PATH || '/app/sessions/meitav-pension/auth-state.json';
const OUT = '/tmp/scraper-runs/meitav-openhub-probe.json';

const auth = JSON.parse(await readFile(AUTH, 'utf8'));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1100 });
await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });
await page.setUserAgent(
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
);
if (auth.cookies?.length) await page.setCookie(...auth.cookies);

const captured = [];
page.on('response', (response) => {
  const type = response.headers()['content-type'] || '';
  const url = response.url();
  if (response.status() >= 400) return;
  if (!(type.includes('json') || /api|graphql|json/i.test(url))) return;
  response
    .text()
    .then((body) => {
      if (!body || body.length > 2_000_000) return;
      try {
        captured.push({ url, status: response.status(), data: JSON.parse(body) });
      } catch {
        captured.push({ url, status: response.status(), text: body.slice(0, 500) });
      }
    })
    .catch(() => {});
});

async function gotoSafe(url) {
  for (let i = 0; i < 4; i += 1) {
    try {
      console.info(`goto ${url} attempt=${i + 1}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForNetworkIdle({ idleTime: 1200, timeout: 25000 }).catch(() => {});
      return page.url();
    } catch (error) {
      console.error(`fail ${error.message}`);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return page.url();
}

const trail = [];
trail.push(await gotoSafe('https://customers.meitav.co.il/v2/login/loginAmit'));
await new Promise((r) => setTimeout(r, 1500));
// Soft bounce into personal area
trail.push(await gotoSafe('https://customers.meitav.co.il/home/myaccount/allaccounts'));
await new Promise((r) => setTimeout(r, 4000));
trail.push(await gotoSafe('https://my-consent.openhub.meitav.co.il/'));
await new Promise((r) => setTimeout(r, 5000));

// Try common gemel product routes on openhub
for (const path of ['/', '/products', '/accounts', '/home', '/dashboard', '/gemel', '/pension']) {
  trail.push(await gotoSafe(`https://my-consent.openhub.meitav.co.il${path}`));
  await new Promise((r) => setTimeout(r, 2500));
}

const snapshots = [];
for (const url of [
  page.url(),
  'https://customers.meitav.co.il/home/myaccount/allaccounts',
  'https://my-consent.openhub.meitav.co.il/',
]) {
  if (page.url() !== url) await gotoSafe(url);
  await new Promise((r) => setTimeout(r, 2500));
  const snap = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      url: location.href,
      title: document.title,
      text: text.slice(0, 6000),
      money: [
        ...text.matchAll(
          /([א-תA-Za-z ]{2,40})[^\d₪]{0,20}₪\s*([\d,]{2,}(?:\.\d+)?)/g,
        ),
      ]
        .map((m) => `${m[1].trim()} = ${m[2]}`)
        .slice(0, 50),
    };
  });
  snapshots.push(snap);
  console.info('SNAP', snap.url, snap.money?.slice(0, 10));
}

await mkdir('/tmp/scraper-runs', { recursive: true });
const report = {
  savedAt: auth.savedAt,
  trail,
  snapshots,
  captured: captured.map((c) => ({
    url: c.url,
    status: c.status,
    preview: JSON.stringify(c.data || c.text)?.slice(0, 500),
    keys: c.data && typeof c.data === 'object' ? Object.keys(c.data).slice(0, 40) : null,
  })),
  capturedFull: captured.slice(0, 80),
};
await writeFile(OUT, JSON.stringify(report, null, 2));
console.info('wrote', OUT, 'captured', captured.length);
await browser.close();
