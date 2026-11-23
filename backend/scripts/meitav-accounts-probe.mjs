import { readFile, writeFile, mkdir } from 'fs/promises';

const AUTH = process.env.MEITAV_PENSION_AUTH_STATE_PATH || '/app/data/meitav-pension-auth-state.json';
const OUT = '/tmp/scraper-runs/meitav-accounts-probe.json';
const auth = JSON.parse(await readFile(AUTH, 'utf8'));
const cookie = (auth.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');

const headers = {
  Accept: 'application/json, text/plain, */*',
  Cookie: cookie,
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://customers.meitav.co.il/home/myaccount/allaccounts',
};

async function get(url) {
  for (let i = 0; i < 5; i += 1) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow' });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 1500) };
      }
      return { status: res.status, contentType: res.headers.get('content-type'), data };
    } catch (error) {
      console.error('retry', url, i, error.message);
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  return { error: 'failed' };
}

const paths = [
  'https://customers.meitav.co.il/v2/api/AmitLobby/getHeaderData',
  'https://customers.meitav.co.il/v2/api/AmitLobby/getAllAmitAccounts',
  'https://customers.meitav.co.il/v2/api/AmitLobby/GetAllAmitAccounts',
  'https://customers.meitav.co.il/v2/api/AllAccounts/GetAllAmitAccounts',
  'https://customers.meitav.co.il/v2/AllAccounts/GetAllAmitAccounts',
  'https://customers.meitav.co.il/v2/api/AllAccounts/getAllAmitAccounts',
  'https://customers.meitav.co.il/AllAccounts/GetAllAmitAccounts',
  'https://customers.meitav.co.il/v2/api/General/GetRole',
];

const results = {};
for (const url of paths) {
  const hit = await get(url);
  results[url] = hit;
  const preview = JSON.stringify(hit.data)?.slice(0, 400);
  console.info('\n==', url);
  console.info(hit.status || hit.error, hit.contentType, preview);
  await new Promise((r) => setTimeout(r, 400));
}

await mkdir('/tmp/scraper-runs', { recursive: true });
await writeFile(OUT, JSON.stringify({ savedAt: auth.savedAt, results }, null, 2));
console.info('wrote', OUT);
