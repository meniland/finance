import { readFile, writeFile, mkdir } from 'fs/promises';

const AUTH = process.env.MEITAV_PENSION_AUTH_STATE_PATH || '/app/sessions/meitav-pension/auth-state.json';
const OUT = '/tmp/scraper-runs/meitav-cookie-probe.json';

const auth = JSON.parse(await readFile(AUTH, 'utf8'));
const cookies = auth.cookies || [];
const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
console.info(
  'savedAt',
  auth.savedAt,
  'cookies',
  cookies.length,
  'domains',
  [...new Set(cookies.map((c) => c.domain))],
);

const urls = [
  'https://customers.meitav.co.il/v2/api/AmitLobby/getHeaderData',
  'https://customers.meitav.co.il/v2/api/AmitLobby/GetUserName',
  'https://customers.meitav.co.il/v2/api/AmitLobby/GetAllAccounts',
  'https://customers.meitav.co.il/v2/api/AmitLobby/GetProducts',
  'https://customers.meitav.co.il/v2/api/Accounts/GetAllAccounts',
  'https://customers.meitav.co.il/v2/api/AmitLobby/GetAccountsSummary',
  'https://customers.meitav.co.il/v2/api/AmitLobby/GetCustomerProducts',
  'https://customers.meitav.co.il/home/myaccount/allaccounts',
  'https://customers.meitav.co.il/',
  'https://my-consent.openhub.meitav.co.il/',
];

const results = {};
for (const url of urls) {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json, text/html, */*',
        Cookie: cookie,
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: 'https://customers.meitav.co.il/',
      },
      redirect: 'manual',
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    results[url] = {
      status: res.status,
      location: res.headers.get('location'),
      contentType: res.headers.get('content-type'),
      data,
      textPreview: data ? null : text.slice(0, 1200),
    };
    console.info(url, res.status, res.headers.get('location') || '', (data ? JSON.stringify(data) : text).slice(0, 220));
  } catch (error) {
    results[url] = { error: String(error.message || error) };
    console.info(url, 'ERR', error.message);
  }
}

await mkdir('/tmp/scraper-runs', { recursive: true });
await writeFile(OUT, JSON.stringify({ savedAt: auth.savedAt, results }, null, 2));
console.info('wrote', OUT);
