import { readFile, writeFile, mkdir } from 'fs/promises';

const AUTH = process.env.MEITAV_PENSION_AUTH_STATE_PATH || '/app/data/meitav-pension-auth-state.json';
const OUT = '/tmp/scraper-runs/meitav-details-probe.json';
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
  for (let i = 0; i < 4; i += 1) {
    try {
      const res = await fetch(url, { headers, redirect: 'follow' });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text.slice(0, 800) };
      }
      return { status: res.status, contentType: res.headers.get('content-type'), data };
    } catch (error) {
      console.error('retry', url, i, error.message);
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  return { error: 'failed' };
}

const all = await get('https://customers.meitav.co.il/v2/api/AllAccounts/GetAllAmitAccounts');
const detail = all?.data?.t || {};
const hisht = (detail.CustomAccountMain || []).find(
  (a) => Number(a.KupaType) === 2 && Number(a.PeriodType) === 1,
);
const pens = (detail.CustomPensionAccountMain || []).find((a) => Number(a.PeriodType) === 1);

console.info('hisht main', hisht?.AccountMainId, hisht?.KeyAccount, hisht?.PercentDmeyNihulHafkada, hisht?.PercentDmeyNihulHafkadaShotefet, hisht?.PercentDmeyNihulZvira);
console.info('pens key', pens?.KeyAccount, pens?.AccountNum, pens?.KupaNum);

const urls = [];
if (hisht) {
  const id = hisht.AccountMainId || hisht.AccountMainID;
  const key = hisht.KeyAccount;
  urls.push(
    `https://customers.meitav.co.il/v2/api/AccountDetails/getAccountDetails?AccountMainID=${id}&PeriodType=1&KeyAccount=${key}`,
    `https://customers.meitav.co.il/v2/api/AccountDetails/getAccountDetails?accountMainId=${id}&periodType=1`,
    `https://customers.meitav.co.il/v2/api/AccountOperations/GetMaslulimForPopup?AccountMainID=${id}&PeriodType=1`,
  );
}
if (pens) {
  const key = pens.KeyAccount;
  const kupa = pens.KupaNum;
  urls.push(
    `https://customers.meitav.co.il/v2/api/AccountDetails/getAccountDetails?AccountMainID=${key}&PeriodType=1&KeyAccount=${key}&KupaNum=${kupa}`,
    `https://customers.meitav.co.il/v2/api/AllAccounts/PensionMainDetails?KeyAccount=${key}&PeriodType=1&KupaNum=${kupa}`,
    `https://customers.meitav.co.il/v2/api/AllAccounts/PensionProgramDetails?KeyAccount=${key}&PeriodType=1`,
    `https://customers.meitav.co.il/v2/Home/GetPage/Amitim/AllAccounts/PensionMainDetails/react?KeyAccount=${key}&PeriodType=1`,
  );
}

const results = { allStatus: all?.status, urls: {} };
for (const url of urls) {
  const hit = await get(url);
  results.urls[url] = hit;
  const preview = JSON.stringify(hit.data)?.slice(0, 500);
  console.info('\n==', url);
  console.info(hit.status || hit.error, preview);
  await new Promise((r) => setTimeout(r, 300));
}

// Also dump pension program fields that might hold tracks/yield
const progs = pens?.CustomPensionAccountProgram || [];
results.pensionPrograms = progs.map((g) => ({
  PeriodType: g.PeriodType,
  ProgramName: g.ProgramName,
  MaslulName: g.MaslulName,
  MaslulNameShort: g.MaslulNameShort,
  YitrotAccountSum: g.YitrotAccountSum,
  TsuaMitstaberet: g.TsuaMitstaberet,
  PercentDmeyNihulHafkada: g.PercentDmeyNihulHafkada,
  PercentDmeyNihulZvira: g.PercentDmeyNihulZvira,
  MaasikName: g.MaasikName,
  keys: Object.keys(g).filter((k) => /maslul|tsua|dmey|nihul|route|track/i.test(k)),
}));
results.hishtMaslul = hisht?.CustomAccountMaslul;
results.hishtFees = {
  PercentDmeyNihulHafkada: hisht?.PercentDmeyNihulHafkada,
  PercentDmeyNihulHafkadaShotefet: hisht?.PercentDmeyNihulHafkadaShotefet,
  PercentDmeyNihulZvira: hisht?.PercentDmeyNihulZvira,
  AggreementDmeyNihulHf: hisht?.AggreementDmeyNihulHf,
  TsuaMitstaberet: (hisht?.CustomAccountMaslul || [])[0]?.TsuaMitstaberet,
};
results.pensFees = {
  PercentDmeyNihulHafkada: pens?.PercentDmeyNihulHafkada,
  PercentDmeyNihulZvira: pens?.PercentDmeyNihulZvira,
  AggreementDmeyNihul: pens?.AggreementDmeyNihul,
  CustomAccountAllMasluls: pens?.CustomAccountAllMasluls,
  allMaslulKeys: Object.keys(pens || {}).filter((k) => /maslul|tsua|program/i.test(k)),
};

await mkdir('/tmp/scraper-runs', { recursive: true });
await writeFile(OUT, JSON.stringify(results, null, 2));
console.info('wrote', OUT);
