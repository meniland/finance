import puppeteer from 'puppeteer-core';
import { writeFile, mkdir } from 'fs/promises';

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

const report = { pages: [] };
const urls = [
  'https://my.fnx.co.il/',
  'https://login.fnx.co.il/login',
  'https://www.fnx.co.il/',
  'https://fnx.co.il/',
];

for (const u of urls) {
  try {
    console.info('goto', u);
    const res = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200),
      inputs: [...document.querySelectorAll('input,textarea,select')].map((i) => ({
        tag: i.tagName,
        type: i.type,
        name: i.name,
        id: i.id,
        placeholder: i.placeholder,
        aria: i.getAttribute('aria-label'),
      })),
      buttons: [...document.querySelectorAll('button,a,[role=button]')]
        .map((b) => (b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 40),
    }));
    report.pages.push({ requested: u, status: res?.status(), ...info });
    console.info(u, '->', info.url, 'status', res?.status(), 'buttons', info.buttons.slice(0, 10));
  } catch (error) {
    report.pages.push({ requested: u, error: String(error.message || error) });
    console.error(u, error.message);
  }
}

await mkdir('/tmp/scraper-runs', { recursive: true });
await writeFile('/tmp/scraper-runs/phoenix-probe.json', JSON.stringify(report, null, 2));
console.info('wrote /tmp/scraper-runs/phoenix-probe.json');
await browser.close();
