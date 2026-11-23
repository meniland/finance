import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const OTP_TIMEOUT_MS = 300_000;
const DEFAULT_LOGIN_URL = 'https://customers.meitav.co.il/v2/login/loginAmit';
const RUNS_ROOT = process.env.RUNS_ROOT || '/tmp/scraper-runs';
const MEITAV_PENSION_AUTH_STATE_PATH =
  process.env.MEITAV_PENSION_AUTH_STATE_PATH ||
  path.join(process.cwd(), 'data', 'meitav-pension-auth-state.json');
// Only the customers portal holds the gemel/pension session. Visiting www/openhub
 // during save/apply hits login redirects and wipes ASP.NET auth cookies.
const MEITAV_CUSTOMERS_ORIGIN = 'https://customers.meitav.co.il';
const MEITAV_SESSION_URL = `${MEITAV_CUSTOMERS_ORIGIN}/home/myaccount/allaccounts`;

const CODES = {
  missingCredentials: '20261123.401216',
  alreadyRunning: '20261123.401217',
  scrapeFailed: '20261123.401218',
  noPendingOtp: '20261123.401219',
  invalidLoginUrl: '20261123.401220',
};

export const SELECTORS = {
  // customers.meitav.co.il/v2/login/loginAmit
  idNumber: 'input#id-identity-input, input[name="identity"], input.id-identity-input',
  phonePrefix: 'select[name="prefixPhone"], select.prefixPhone',
  phoneNumber: 'input[name="phoneNumber"], input.login-phone',
  sendSms: 'button#submit.login-id-btn, form[name="loginAmit"] button#submit, button.login-id-btn',
  otp: 'input#otp, input[name="otp"], input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="קוד"], input[aria-label*="קוד"]',
  otpDigit: 'input[maxlength="1"]',
  otpSubmit: 'button#submit, button[type="submit"], button.btn-primary, button[class*="confirm" i]',
};

let running = false;
let pendingOtp = null;
let browserHandle = null;

const state = {
  status: 'IDLE',
  error: null,
  errorCode: null,
  message: null,
  phoneHint: null,
  portfolio: null,
  startedAt: null,
  finishedAt: null,
};

function httpError(status, error, errorCode, messageText) {
  const err = new Error(error);
  err.status = status;
  err.errorCode = errorCode;
  err.messageText = messageText || error;
  return err;
}

export function hasMeitavPensionCredentials() {
  return Boolean(
    String(process.env.MEITAV_PENSION_ID_NUMBER || '').trim() &&
      String(process.env.MEITAV_PENSION_PHONE_NUMBER || '').trim(),
  );
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Meitav KupaType: 1 גמל, 2 השתלמות, 5 פנסיה. Exclude 10 חיסכון לכל ילד, 11 גמל להשקעה, trade. */
const MEITAV_KUPA_PRODUCT = {
  1: 'גמל',
  2: 'השתלמות',
  5: 'פנסיה',
};

function classifyProductType(raw) {
  const text = String(raw || '');
  if (/השתלמות|hishtalmut|study/i.test(text)) return 'השתלמות';
  if (/פנסיה|pension/i.test(text)) return 'פנסיה';
  if (/גמל\s*להשקעה|gemel\s*invest/i.test(text)) return null;
  if (/חיסכון\s*לכל\s*ילד|trade|מסחר|broker/i.test(text)) return null;
  if (/גמל|provident|gemel/i.test(text)) return 'גמל';
  return null;
}

function isLongTermMeitavProduct(productType) {
  return productType === 'פנסיה' || productType === 'גמל' || productType === 'השתלמות';
}

function portfolioFromPolicies(policies) {
  const list = (policies || []).filter(
    (policy) =>
      policy &&
      policy.balance !== null &&
      policy.balance !== undefined &&
      isLongTermMeitavProduct(policy.productType),
  );
  let total = 0;
  for (const policy of list) total += Number(policy.balance) || 0;
  return {
    totalPensionBalance: list.length ? total : null,
    policies: list,
  };
}

function maslulRows(record) {
  const pensionTracks = []
    .concat(record?.pensionMaslulHashkaaKerenDTOs || [])
    .concat(record?.pensionMaslulHashkaaKerens || []);
  const rows = []
    .concat(pensionTracks)
    .concat(record?.CustomAccountMaslul || [])
    .concat(record?.CustomAccountAllMasluls || []);
  return rows.filter((row) => row && (row.PeriodType == null || Number(row.PeriodType) === 1));
}

function formatTrackLabel(row) {
  const name = String(
    row?.MaslulNameShort ||
      row?.MaslulName ||
      row?.MaslulHshkahaName ||
      row?.ShemMaslul ||
      '',
  ).trim();
  if (!name) return null;
  const pct = asNumber(row?.PercentFromKeren ?? row?.HafrashaPercent);
  if (pct != null && pct > 0 && pct < 100) {
    const rounded = Math.round(pct * 10) / 10;
    return `${name} (${rounded}%)`;
  }
  return name;
}

function investmentTrackFromRecord(record) {
  const rows = maslulRows(record);
  if (!rows.length) return null;
  // Prefer multi-track pension split when present.
  const labeled = rows.map(formatTrackLabel).filter(Boolean);
  if (!labeled.length) return null;
  const unique = [...new Set(labeled)];
  return unique.join(' · ');
}

function yieldFromRecord(record) {
  const direct = asNumber(record?.TsuaMitstaberet ?? record?.annualYieldPercent);
  if (direct != null) return direct;

  const rows = maslulRows(record);
  let weightSum = 0;
  let yieldSum = 0;
  for (const row of rows) {
    const y = asNumber(row?.TsuaMitstaberet);
    if (y == null) continue;
    const w = asNumber(row?.YitraBmaslul ?? row?.YitrotAccountSum ?? row?.PercentFromKeren) ?? 1;
    weightSum += w;
    yieldSum += y * w;
  }
  if (weightSum > 0) return Math.round((yieldSum / weightSum) * 100) / 100;

  const fromMaslul = rows.map((row) => asNumber(row?.TsuaMitstaberet)).find((v) => v != null);
  return fromMaslul ?? null;
}

function depositFeeFromRecord(record) {
  // Shotefet is the "actual deposit fee" Meitav shows in UI (often 0 for hishtalmut).
  return asNumber(
    record?.PercentDmeyNihulHafkada ??
      record?.PercentDmeyNihulHafkadaShotefet ??
      record?.AggreementDmeyNihulHf ??
      record?.PercentDmeyNihuHf ??
      record?.PercentDmeyNihulHfmax,
  );
}

function accumulationFeeFromRecord(record) {
  return asNumber(
    record?.PercentDmeyNihulZvira ??
      record?.AggreementDmeyNihul ??
      record?.PercentDmeyNihulAmit ??
      record?.PercentDmeyNihulChisachonTzavur ??
      record?.AggreementDmeyNihulOved,
  );
}

function firstMaslulName(record) {
  return investmentTrackFromRecord(record);
}

function policyFromMeitavAccount(record, { productType, policyName, policyNumber } = {}) {
  if (!record || typeof record !== 'object') return null;
  const period = Number(record.PeriodType);
  if (period && period !== 1) return null;

  const kupaType = Number(record.KupaType);
  const typed =
    productType ||
    MEITAV_KUPA_PRODUCT[kupaType] ||
    classifyProductType(
      record.KupaTypeNameHebrew || record.KupaName || record.AccountType || record.AccountMainForShow,
    );
  if (!isLongTermMeitavProduct(typed)) return null;

  const balance = asNumber(
    record.YitrotAccountSum ?? record.Yitra ?? record.balance ?? record.accumulation,
  );
  if (balance == null) return null;

  const number =
    policyNumber ||
    record.AccountNumForShow ||
    record.AccountMainForShow ||
    record.AccountNum ||
    record.AccountMainId ||
    record.AccountMainID ||
    record.KeyAccount ||
    null;

  return {
    policyName:
      String(
        policyName ||
          record.KupaName ||
          record.KupaTypeNameHebrew ||
          record.AccountMainForShow ||
          typed,
      ).trim() || typed,
    policyNumber: number != null && String(number).trim() ? String(number).trim() : null,
    productType: typed,
    employerName: String(record.EmployerName || record.MaasikName || '').trim() || null,
    balance,
    investmentTrack: investmentTrackFromRecord(record),
    depositFeePercent: depositFeeFromRecord(record),
    accumulationFeePercent: accumulationFeeFromRecord(record),
    annualYieldPercent: yieldFromRecord(record),
  };
}

function policiesFromMeitavAccountApis(payloads) {
  const found = [];
  const seen = new Set();
  const push = (policy) => {
    if (!policy || !isLongTermMeitavProduct(policy.productType)) return;
    const key = `${policy.productType}|${policy.policyNumber || ''}|${policy.balance}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(policy);
  };

  const ingest = (data) => {
    if (!data || typeof data !== 'object') return;
    const detail = data?.t && typeof data.t === 'object' ? data.t : data;
    for (const account of detail?.CustomAccountMain || []) {
      push(
        policyFromMeitavAccount(account, {
          productType: MEITAV_KUPA_PRODUCT[Number(account?.KupaType)],
          policyName: account?.KupaName || account?.KupaTypeNameHebrew,
        }),
      );
    }
    for (const account of detail?.CustomPensionAccountMain || []) {
      push(
        policyFromMeitavAccount(account, {
          productType: 'פנסיה',
          policyName: account?.KupaName || account?.AmitDispalyName || 'פנסיה',
          policyNumber: account?.AccountNumForShow || account?.AccountNum || account?.KeyAccount,
        }),
      );
    }
    for (const account of data?.lobbyData?.AmitAccounts || []) {
      push(
        policyFromMeitavAccount(account, {
          productType: MEITAV_KUPA_PRODUCT[Number(account?.KupaType)],
        }),
      );
    }
  };

  // Detail payloads first (employer / fees / tracks), lobby as fallback.
  for (const row of payloads || []) {
    if (/AllAccounts\/GetAllAmitAccounts/i.test(String(row?.url || ''))) ingest(row.data);
  }
  for (const row of payloads || []) {
    if (!/AllAccounts\/GetAllAmitAccounts/i.test(String(row?.url || ''))) ingest(row.data);
  }

  return found;
}

export function getMeitavPensionState() {
  const portfolio = state.portfolio
    ? portfolioFromPolicies(state.portfolio.policies || [])
    : null;
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    message: state.message,
    phoneHint: state.phoneHint,
    credentialsConfigured: hasMeitavPensionCredentials(),
    sessionSaved: existsSync(MEITAV_PENSION_AUTH_STATE_PATH),
    portfolio,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

async function readAuthState() {
  try {
    const text = await readFile(MEITAV_PENSION_AUTH_STATE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return null;
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    console.info(`meitav-pension auth-state read failed ${String(error.message || '').slice(0, 80)}`);
    return null;
  }
}

async function clearAuthState() {
  try {
    await unlink(MEITAV_PENSION_AUTH_STATE_PATH);
    console.info('meitav-pension auth-state cleared');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.info(`meitav-pension auth-state clear failed ${String(error.message || '').slice(0, 80)}`);
    }
  }
}

function toCdpCookies(cookies) {
  return (cookies || [])
    .filter((cookie) => cookie?.name && cookie?.value != null)
    .map((cookie) => {
      const out = {
        name: cookie.name,
        value: String(cookie.value),
        domain: cookie.domain || 'customers.meitav.co.il',
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (Number(cookie.expires) > 0) out.expires = Number(cookie.expires);
      const sameSite = String(cookie.sameSite || '');
      if (/^strict$/i.test(sameSite)) out.sameSite = 'Strict';
      else if (/^lax$/i.test(sameSite)) out.sameSite = 'Lax';
      else if (/none|no_restriction/i.test(sameSite)) {
        out.sameSite = 'None';
        out.secure = true;
      }
      return out;
    });
}

function customersCookiesOnly(cookies) {
  return (cookies || []).filter((cookie) =>
    /customers\.meitav\.co\.il/i.test(String(cookie.domain || '')),
  );
}

async function readPageStorage(page) {
  return page
    .evaluate(() => {
      const localStorageEntries = [];
      try {
        for (let i = 0; i < localStorage.length; i += 1) {
          const name = localStorage.key(i);
          if (!name) continue;
          localStorageEntries.push({ name, value: localStorage.getItem(name) });
        }
      } catch {
        /* ignore */
      }
      const sessionStorageEntries = [];
      try {
        for (let i = 0; i < sessionStorage.length; i += 1) {
          const name = sessionStorage.key(i);
          if (!name) continue;
          sessionStorageEntries.push({ name, value: sessionStorage.getItem(name) });
        }
      } catch {
        /* ignore */
      }
      return { localStorage: localStorageEntries, sessionStorage: sessionStorageEntries };
    })
    .catch(() => ({ localStorage: [], sessionStorage: [] }));
}

async function writeAuthState(page) {
  // Capture cookies while the customers session is still alive — do not navigate to
  // www/openhub/login roots first (that was wiping the ASP.NET auth cookie).
  if (!/customers\.meitav\.co\.il/i.test(page.url())) {
    await page.goto(MEITAV_SESSION_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  }

  const alive = await sessionApiAlive(page);
  if (!alive.ok) {
    console.info(
      `meitav-pension skip auth-state save — API not alive role=${alive.role || '—'} header=${alive.headerStatus || '—'}`,
    );
    return false;
  }

  const client = await page.createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  const meitavCookies = customersCookiesOnly(cookies);
  if (!meitavCookies.length) {
    console.info('meitav-pension skip auth-state save — no customers cookies');
    return false;
  }

  const storage = await readPageStorage(page);
  await mkdir(path.dirname(MEITAV_PENSION_AUTH_STATE_PATH), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    cookies: meitavCookies,
    origins: [{ origin: MEITAV_CUSTOMERS_ORIGIN, ...storage }],
  };
  await writeFile(MEITAV_PENSION_AUTH_STATE_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.info(
    `meitav-pension auth-state saved cookies=${meitavCookies.length} via=${alive.via} path=${MEITAV_PENSION_AUTH_STATE_PATH}`,
  );
  return true;
}

async function applyAuthState(page, authState) {
  const cookies = toCdpCookies(customersCookiesOnly(authState?.cookies));
  if (!cookies.length) return false;

  const client = await page.createCDPSession();
  await client.send('Network.setCookies', { cookies });

  // Go straight to the logged-in app. Never open customers.meitav.co.il/ (login redirect).
  await page.goto(MEITAV_SESSION_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});

  const customersOrigin = (authState.origins || []).find((row) =>
    /customers\.meitav\.co\.il/i.test(String(row?.origin || '')),
  );
  if (customersOrigin) {
    await page
      .evaluate((storage) => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          /* ignore */
        }
        for (const row of storage.localStorage || []) {
          if (row?.name != null) localStorage.setItem(row.name, row.value ?? '');
        }
        for (const row of storage.sessionStorage || []) {
          if (row?.name != null) sessionStorage.setItem(row.name, row.value ?? '');
        }
      }, customersOrigin)
      .catch(() => {});
  }
  return true;
}

function resetRun() {
  state.status = 'SCRAPING';
  state.error = null;
  state.errorCode = null;
  state.message = null;
  state.phoneHint = null;
  state.portfolio = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
}

function finish(status, extra = {}) {
  state.status = status;
  state.finishedAt = new Date().toISOString();
  Object.assign(state, extra);
}

function dropPendingOtp() {
  if (!pendingOtp) return;
  const { reject } = pendingOtp;
  pendingOtp = null;
  reject(new Error('OTP wait ended'));
}

function waitForOtp() {
  state.status = 'AWAITING_OTP';
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pendingOtp) return;
      pendingOtp = null;
      reject(new Error('Timed out waiting for the SMS code'));
    }, OTP_TIMEOUT_MS);

    pendingOtp = {
      resolve: (code) => {
        clearTimeout(timer);
        pendingOtp = null;
        state.status = 'SCRAPING';
        resolve(code);
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingOtp = null;
        reject(error);
      },
    };
  });
  promise.catch(() => {});
  return promise;
}

export function submitMeitavPensionOtp(otpCode) {
  if (!pendingOtp || state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'Meitav pension is not waiting for an SMS code.', CODES.noPendingOtp);
  }
  pendingOtp.resolve(otpCode);
}

function loginUrl() {
  const raw =
    String(process.env.MEITAV_PENSION_LOGIN_URL || DEFAULT_LOGIN_URL).trim() || DEFAULT_LOGIN_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(
      400,
      'Invalid MEITAV_PENSION_LOGIN_URL.',
      CODES.invalidLoginUrl,
      'כתובת הכניסה למיטב גמל ופנסיה אינה תקינה.',
    );
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw httpError(
      400,
      'Invalid MEITAV_PENSION_LOGIN_URL.',
      CODES.invalidLoginUrl,
      'כתובת הכניסה למיטב גמל ופנסיה אינה תקינה.',
    );
  }
  return parsed.toString();
}

function phoneHintFrom(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 3) return null;
  return digits.slice(-4);
}

function isInterestingJsonUrl(url) {
  return /meitav|openhub|customers|pension|gemel|provident|hishtal|fund|balance|account|policy|product|saving|portfolio|accumulation|fee|yield|track|maslul|otp|login|auth|token|customer/i.test(
    url,
  );
}

async function dumpDebug(page, label) {
  try {
    await mkdir(RUNS_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(RUNS_ROOT, `meitav-pension-${label}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(`${base}.html`, html.slice(0, 900_000), 'utf8').catch(() => {});
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    await writeFile(`${base}.txt`, String(text).slice(0, 200_000), 'utf8').catch(() => {});
    console.info(`meitav-pension debug ${base}`);
  } catch (error) {
    console.info(`meitav-pension debug failed ${String(error.message || '').slice(0, 80)}`);
  }
}

async function firstVisible(page, selectorList) {
  const selectors = String(selectorList || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const selector of selectors) {
    const handles = await page.$$(selector).catch(() => []);
    for (const handle of handles) {
      const visible = await handle
        .evaluate((node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0
          );
        })
        .catch(() => false);
      if (visible) return { handle, selector };
    }
  }
  return null;
}

async function clickByText(page, labels, { exact = false } = {}) {
  const clicked = await page.evaluate(
    (wanted, exactOnly) => {
      const nodes = [...document.querySelectorAll('a, button, [role="button"]')];
      for (const node of nodes) {
        const label = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length > 80) continue;
        // Never hit the app-download / magic-link widgets.
        if (/קישור|אפליקצ|App Store|Google Play|שלחו לי/i.test(label)) continue;
        const hit = wanted.some((item) =>
          exactOnly ? label === item : label === item || label.includes(item),
        );
        if (!hit) continue;
        if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
        node.click();
        return label.slice(0, 60);
      }
      return null;
    },
    labels,
    exact,
  );
  if (clicked) console.info(`meitav-pension clicked ${clicked}`);
  return Boolean(clicked);
}

async function setAngularInput(page, selector, value) {
  const ok = await page
    .$eval(
      selector,
      (el, next) => {
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.value = String(next ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
      },
      value,
    )
    .catch(() => false);
  if (ok) return true;
  return typeInto(page, selector, value);
}

async function typeInto(page, selectorList, value) {
  const field = await firstVisible(page, selectorList);
  if (!field) return false;
  await field.handle.click({ clickCount: 3 }).catch(() => {});
  await field.handle.type(String(value), { delay: 20 });
  return true;
}

function splitIsraeliMobile(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  let normalized = digits;
  if (normalized.startsWith('972') && normalized.length >= 12) {
    normalized = `0${normalized.slice(3)}`;
  }
  if (normalized.length === 10 && normalized.startsWith('0')) {
    return { prefix: normalized.slice(0, 3), number: normalized.slice(3) };
  }
  if (normalized.length === 9 && !normalized.startsWith('0')) {
    return { prefix: `0${normalized.slice(0, 2)}`, number: normalized.slice(2) };
  }
  return { prefix: null, number: normalized };
}

async function dismissBlockingModals(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"], a')];
      const target = buttons.find((button) => {
        const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`
          .replace(/\s+/g, ' ')
          .trim();
        // Do not click the login submit "אישור" while dismissing overlays.
        if (button.id === 'submit' || button.classList?.contains('login-id-btn')) return false;
        return /הבנתי|ראיתי|סגור|אני מסכים|Accept|Agree|Close/i.test(label);
      });
      if (!target) return null;
      target.click();
      return (target.innerText || '').trim().slice(0, 60);
    });
    if (!clicked) break;
    console.info(`meitav-pension dismissed ${clicked}`);
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

function walkRecords(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) {
    for (const item of node) walkRecords(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  out.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walkRecords(value, out);
  }
  return out;
}

function pick(record, keys) {
  if (!record || typeof record !== 'object') return null;
  const entries = Object.entries(record);
  const normalize = (key) =>
    String(key)
      .toLowerCase()
      .replace(/[^a-z0-9\u0590-\u05ff]/g, '');
  for (const wanted of keys) {
    const target = normalize(wanted);
    for (const [key, value] of entries) {
      if (normalize(key) === target && value != null && value !== '') return value;
    }
  }
  for (const wanted of keys) {
    const target = normalize(wanted);
    for (const [key, value] of entries) {
      if (normalize(key).includes(target) && value != null && value !== '') return value;
    }
  }
  return null;
}

function policyFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const balance = asNumber(
    pick(record, [
      'balance',
      'totalBalance',
      'accumulation',
      'accumulationBalance',
      'savingBalance',
      'amount',
      'totalAmount',
      'יתרה',
      'צבירה',
      'סהכ',
    ]),
  );
  const policyName = String(
    pick(record, [
      'policyName',
      'productName',
      'fundName',
      'planName',
      'name',
      'title',
      'שם',
      'מוצר',
      'תוכנית',
    ]) || '',
  ).trim();
  const policyNumber = String(
    pick(record, [
      'policyNumber',
      'accountNumber',
      'fundNumber',
      'planNumber',
      'policyId',
      'accountId',
      'מספר',
      'פוליסה',
      'חשבון',
    ]) || '',
  ).trim();
  const productRaw = String(
    pick(record, ['productType', 'product', 'fundType', 'planType', 'category', 'סוג', 'KupaTypeNameHebrew', 'KupaName']) ||
      policyName,
  );
  const productType =
    MEITAV_KUPA_PRODUCT[Number(record.KupaType)] || classifyProductType(productRaw);
  if (!isLongTermMeitavProduct(productType)) return null;
  if (balance == null && !policyNumber) return null;
  if (balance != null && Math.abs(balance) < 0.01 && !policyNumber) return null;
  // Prefer current valuation period when Meitav sends PeriodType (1=current, 2=prior).
  if (record.PeriodType != null && Number(record.PeriodType) !== 1) return null;

  return {
    policyName: policyName || productType,
    policyNumber: policyNumber || null,
    productType,
    employerName: String(pick(record, ['employerName', 'employer', 'מעסיק', 'EmployerName']) || '').trim() || null,
    balance: balance ?? 0,
    investmentTrack:
      String(
        pick(record, [
          'investmentTrack',
          'track',
          'route',
          'maslul',
          'מסלול',
          'MaslulNameShort',
          'MaslulHshkahaName',
        ]) ||
          investmentTrackFromRecord(record) ||
          '',
      ).trim() || null,
    depositFeePercent:
      asNumber(
        pick(record, [
          'depositFeePercent',
          'depositFee',
          'managementFeeDeposit',
          'PercentDmeyNihulHafkada',
          'PercentDmeyNihulHafkadaShotefet',
          'דמיניהולמהפקדה',
        ]),
      ) ?? depositFeeFromRecord(record),
    accumulationFeePercent:
      asNumber(
        pick(record, [
          'accumulationFeePercent',
          'accumulationFee',
          'managementFeeAccumulation',
          'PercentDmeyNihulZvira',
          'דמיניהולמצבירה',
        ]),
      ) ?? accumulationFeeFromRecord(record),
    annualYieldPercent:
      asNumber(
        pick(record, [
          'annualYieldPercent',
          'yield',
          'annualYield',
          'returnYtd',
          'TsuaMitstaberet',
          'תשואה',
        ]),
      ) ?? yieldFromRecord(record),
  };
}

function policiesFromPayloads(payloads) {
  const found = [];
  const seen = new Set();
  for (const row of payloads || []) {
    for (const record of walkRecords(row.data)) {
      const policy = policyFromRecord(record);
      if (!policy) continue;
      const key = `${policy.policyNumber || ''}|${policy.policyName}|${policy.balance}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(policy);
    }
  }
  return found;
}

async function extractPoliciesFromDom(page) {
  const rows = await page
    .evaluate(() => {
      const textOf = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const parseMoney = (raw) => {
        const cleaned = String(raw || '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
        const num = Number(cleaned);
        return Number.isFinite(num) ? num : null;
      };
      const out = [];
      const body = textOf(document.body);
      const pairRe =
        /(קרנות פנסיה|פנסיה|קופת גמל|גמל|השתלמות|ביטוח מנהלים|חיסכון)[^\d₪]{0,60}₪?\s*([\d,]{3,}(?:\.\d+)?)/g;
      let match;
      while ((match = pairRe.exec(body))) {
        out.push({
          policyName: match[1],
          productType: match[1],
          balance: parseMoney(match[2]),
          policyNumber: '',
        });
      }

      const cards = [
        ...document.querySelectorAll(
          'article, section, li, tr, [class*="card" i], [class*="policy" i], [class*="product" i], [class*="fund" i], [class*="account" i]',
        ),
      ];
      for (const card of cards.slice(0, 200)) {
        const text = textOf(card);
        if (text.length < 8 || text.length > 1800) continue;
        if (!/(פנסיה|גמל|השתלמות|יתרה|צבירה|חיסכון|קופה|קרן|₪)/i.test(text)) continue;
        const shekel = text.match(/₪\s*([\d,]{3,}(?:\.\d+)?)/) || text.match(/([\d,]{3,}(?:\.\d+)?)\s*₪/);
        if (!shekel) continue;
        const heading =
          textOf(card.querySelector('h1,h2,h3,h4,strong,a')) ||
          text.split('\n')[0]?.slice(0, 80) ||
          text.slice(0, 80);
        const numberMatch = text.match(
          /(?:פוליסה|תוכנית|חשבון|מס(?:פר)?)\s*[:#]?\s*([A-Z0-9-]{4,})/i,
        );
        const employerMatch = text.match(/מעסיק(?:\s*אחרון)?\s*:?\s*([^\n]{2,60})/);
        const trackMatch = text.match(/מסלול(?:\s+השקעה)?\s*:?\s*([^\n%]{2,60})/);
        out.push({
          policyName: heading,
          policyNumber: numberMatch?.[1] || '',
          productType: text,
          balance: parseMoney(shekel[1]),
          employerName: employerMatch?.[1]?.trim() || '',
          investmentTrack: trackMatch?.[1]?.trim() || '',
        });
      }
      return out;
    })
    .catch(() => []);

  return rows.map((row) => policyFromRecord(row)).filter(Boolean);
}

async function looksLoggedIn(page) {
  const url = page.url();
  if (/login|signin|auth/i.test(url) && !/home|dashboard|portal|my-account|personal/i.test(url)) {
    return false;
  }
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/התנתק|יציאה|שלום|המוצרים שלי|החסכונות שלי|יתרה|צבירה|תיק החיסכון/i.test(text)) {
    return true;
  }
  if (/כניסה לחשבון|התחברות|תעודת זהות|קוד אימות/i.test(text) && !/התנתק|יתרה|צבירה/i.test(text)) {
    return false;
  }
  return /customers\.meitav|openhub\.meitav|my-consent/i.test(url) && !/login/i.test(url);
}

const RECAPTCHA_SITE_KEY = '6LehTwIbAAAAAHh3aOseKHILdRAxd8gXRkcM36G1';
const API_BASE = 'https://customers.meitav.co.il/v2/';

async function openCustomerLogin(page) {
  const configured = loginUrl();
  const target = /loginAmit/i.test(configured) ? configured : DEFAULT_LOGIN_URL;
  await page.goto(target, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  await dismissBlockingModals(page);
  if (!/loginAmit/i.test(page.url())) {
    await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  }
  console.info(`meitav-pension login page url=${page.url()}`);
}

async function waitForRecaptcha(page, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page
      .evaluate(() => Boolean(window.grecaptcha?.enterprise?.execute))
      .catch(() => false);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/** Run LoginWithPhone / ConfirmPassword from the page so cookies + reCAPTCHA work. */
async function meitavApiCall(page, { path, method = 'GET', action, body = null, params = null }) {
  return page.evaluate(
    async ({ apiBase, pathName, httpMethod, actionName, siteKey, payload, query }) => {
      const site =
        (typeof globalParam !== 'undefined' && globalParam.reCaptchaClient) || siteKey;
      if (!window.grecaptcha?.enterprise?.execute) {
        return { ok: false, error: 'grecaptcha.enterprise missing' };
      }
      const token = await grecaptcha.enterprise.execute(site, { action: actionName });
      const cidFromGa = () => {
        try {
          const match = document.cookie.match(/(?:^|;\s*)_ga=([^;]+)/);
          if (!match) return null;
          const parts = decodeURIComponent(match[1]).split('.');
          return parts.length > 3 ? `${parts[2]}.${parts[3]}` : match[1];
        } catch {
          return null;
        }
      };
      const userData = {
        Cid: cidFromGa(),
        Gclid: null,
        Dclid: null,
        IsMobileDevice: false,
        BrowserBrand: 'Chrome',
        HostIPAddress: '',
      };
      let url = `${apiBase}${pathName}`;
      if (query && typeof query === 'object') {
        const qs = new URLSearchParams(query).toString();
        if (qs) url += `?${qs}`;
      }
      const headers = {
        Accept: 'application/json, text/plain, */*',
        gCaptcha: token,
        action: actionName.replace(/^makeLoginFunc$/i, 'LoginWithPhone'),
      };
      // Match site header naming for known actions.
      if (actionName === 'makeLoginFunc') headers.action = 'LoginWithPhone';
      if (actionName === 'confirmPassword') headers.action = 'ConfirmPassword';
      if (actionName === 'SendSmsAgain') headers.action = 'SendSmsAgain';

      const init = { method: httpMethod, headers, credentials: 'include' };
      if (payload != null) {
        headers['content-type'] = 'application/json;charset=UTF-8';
        const bodyObj =
          typeof payload === 'object' && !Array.isArray(payload)
            ? { ...payload, UserData: payload.UserData || userData }
            : payload;
        init.body = JSON.stringify(bodyObj);
      }
      const response = await fetch(url, init);
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text?.slice?.(0, 500) };
      }
      return { ok: response.ok, status: response.status, data };
    },
    {
      apiBase: API_BASE,
      pathName: path,
      httpMethod: method,
      actionName: action,
      siteKey: RECAPTCHA_SITE_KEY,
      payload: body,
      query: params,
    },
  );
}

async function loginWithSms(page, credentials) {
  state.phoneHint = phoneHintFrom(credentials.phoneNumber);
  await openCustomerLogin(page);

  const mobile = splitIsraeliMobile(credentials.phoneNumber);
  if (!mobile.prefix || String(mobile.number || '').length !== 7) {
    await dumpDebug(page, 'bad-phone');
    throw new Error(
      `Meitav phone must be a 10-digit Israeli mobile (got ${credentials.phoneNumber}).`,
    );
  }

  const amitId = String(credentials.idNumber || '').replace(/\D/g, '').padStart(9, '0');
  const phoneNumber = `${mobile.prefix}-${mobile.number}`;

  if (!(await waitForRecaptcha(page))) {
    await dumpDebug(page, 'no-recaptcha');
    throw new Error('Meitav reCAPTCHA did not load on the login page.');
  }

  console.info(`meitav-pension API LoginWithPhone id=${amitId} phone=${phoneNumber}`);
  const loginRes = await meitavApiCall(page, {
    path: 'api/Login/LoginWithPhone',
    method: 'POST',
    action: 'makeLoginFunc',
    body: { amitId, phoneNumber },
  });
  console.info(
    `meitav-pension LoginWithPhone status=${loginRes?.status} failed=${loginRes?.data?.isFailed} target=${loginRes?.data?.actionTarget || loginRes?.data?.stateName || '—'} body=${JSON.stringify(loginRes?.data || {}).slice(0, 300)}`,
  );

  if (!loginRes?.ok || loginRes?.data?.isFailed) {
    await dumpDebug(page, 'login-with-phone-failed');
    const target = loginRes?.data?.actionTarget || loginRes?.data?.stateName || '';
    if (/NoMatch|LoginNoMatch|CustomerMinor/i.test(target) || loginRes?.data?.userType === 'NoMatchUser') {
      throw new Error('Meitav did not match this ID/phone. Check MEITAV_PENSION_* in .env.');
    }
    throw new Error(
      `Meitav LoginWithPhone failed (${loginRes?.status || 'no-response'}: ${target || loginRes?.error || 'unknown'}).`,
    );
  }

  // Stay in the same SPA session — only soft-route to the OTP screen (no full reload).
  const routed = await page
    .evaluate(async () => {
      try {
        const root = document.querySelector('[ng-app], [data-ng-app], .login-window, body');
        const inj = window.angular?.element(root)?.injector?.() || window.angular?.element(document.body)?.injector?.();
        if (!inj) return { ok: false, error: 'no injector' };
        const $state = inj.get('$state');
        await $state.go('login.LoginCode');
        return { ok: true, href: location.href };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    })
    .catch((error) => ({ ok: false, error: String(error.message || error) }));
  console.info(
    `meitav-pension route LoginCode ok=${routed?.ok} href=${routed?.href || page.url()} err=${routed?.error || '—'}`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await waitForRecaptcha(page, 20000);

  state.message = 'ממתין לקוד SMS ממיטב…';
  const otpCode = await waitForOtp();
  const digits = String(otpCode || '').replace(/\D/g, '');
  if (!digits) throw new Error('Empty SMS code.');

  // Prefer the site's own Angular service (same $http + captcha + cookies as the UI).
  console.info('meitav-pension ConfirmPassword via Angular loginSrvc');
  let confirmRes = await page
    .evaluate(async (code) => {
      try {
        const root = document.querySelector('[ng-app], [data-ng-app], .login-window, body');
        const inj =
          window.angular?.element(root)?.injector?.() ||
          window.angular?.element(document.body)?.injector?.();
        if (!inj) return { ok: false, error: 'angular injector missing' };
        const loginSrvc = inj.get('loginSrvc');
        const response = await new Promise((resolve, reject) => {
          loginSrvc.confirmPassword(code).then(resolve, (err) => {
            // Angular $http rejects on 401 but still has err.data / err.status.
            resolve(err);
          });
        });
        const status = response?.status;
        const data = response?.data;
        return {
          ok: status >= 200 && status < 300,
          status,
          data,
          via: 'angular',
        };
      } catch (error) {
        return { ok: false, error: String(error?.message || error), via: 'angular' };
      }
    }, digits)
    .catch((error) => ({ ok: false, error: String(error.message || error), via: 'angular' }));

  // Fallback: direct API from the same document (no navigation).
  if (!confirmRes?.ok || confirmRes?.data?.isFailed || confirmRes?.status === 401) {
    console.info(
      `meitav-pension angular confirm weak status=${confirmRes?.status} err=${confirmRes?.error || '—'} — trying fetch API`,
    );
    confirmRes = await meitavApiCall(page, {
      path: 'api/Login/ConfirmPassword',
      method: 'GET',
      action: 'confirmPassword',
      params: { password: digits },
    });
    confirmRes.via = 'fetch';
  }

  console.info(
    `meitav-pension ConfirmPassword via=${confirmRes?.via || '—'} status=${confirmRes?.status} failed=${confirmRes?.data?.isFailed} state=${confirmRes?.data?.stateName || '—'} redirect=${confirmRes?.data?.redirectUrl || '—'} body=${JSON.stringify(confirmRes?.data || {}).slice(0, 400)}`,
  );

  const confirmOk =
    confirmRes?.ok &&
    !confirmRes?.data?.isFailed &&
    confirmRes?.status !== 401 &&
    !/LoginID|LoginError|GeneralError/i.test(String(confirmRes?.data?.stateName || ''));

  if (!confirmOk) {
    await dumpDebug(page, 'confirm-password-failed');
    throw new Error('Meitav rejected the SMS code. Try syncing again.');
  }

  const redirect =
    confirmRes?.data?.redirectUrl ||
    ( /SiteHomePage/i.test(String(confirmRes?.data?.stateName || ''))
      ? '/home/myaccount/allaccounts'
      : null);
  if (redirect) {
    const href = redirect.startsWith('http')
      ? redirect
      : `https://customers.meitav.co.il${redirect.startsWith('/') ? '' : '/'}${redirect}`;
    await page.goto(href, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  } else {
    await page
      .goto('https://customers.meitav.co.il/home/myaccount/allaccounts', {
        waitUntil: 'networkidle2',
        timeout: 90000,
      })
      .catch(() => {});
  }
  await dismissBlockingModals(page);

  if (!(await looksLoggedIn(page))) {
    await dumpDebug(page, 'login-failed');
    throw new Error('Meitav API login succeeded but personal area did not open.');
  }
}

async function sessionApiAlive(page) {
  const role = await fetchLobbyJson(page, 'api/General/GetRole');
  const roleValue =
    typeof role?.data === 'string'
      ? role.data
      : role?.data?.role || role?.data?.Role || role?.raw || '';
  if (/Amit|Manager/i.test(String(roleValue)) && !/^None$/i.test(String(roleValue).trim())) {
    return { ok: true, via: 'GetRole', role: roleValue };
  }
  const header = await fetchLobbyJson(page, 'api/AmitLobby/getHeaderData');
  if (header?.data?.AmitID || header?.data?.AmitName) {
    return { ok: true, via: 'getHeaderData', amit: header.data.AmitName };
  }
  return { ok: false, role: roleValue, headerStatus: header?.status };
}

async function tryResumeSession(page) {
  const authState = await readAuthState();
  if (!authState) {
    console.info('meitav-pension no saved auth-state');
    return false;
  }
  console.info(
    `meitav-pension trying saved auth-state from ${authState.savedAt || 'unknown'} cookies=${(authState.cookies || []).length}`,
  );
  state.message = 'משתמש בסשן שמור…';
  await applyAuthState(page, authState);
  await dismissBlockingModals(page);

  const api = await sessionApiAlive(page);
  if (api.ok) {
    console.info(
      `meitav-pension resumed session via=${api.via} role=${api.role || '—'} amit=${api.amit || '—'} url=${page.url()}`,
    );
    return true;
  }

  console.info(
    `meitav-pension saved session not authenticated role=${api.role || '—'} header=${api.headerStatus || '—'} url=${page.url()}`,
  );
  await clearAuthState();
  return false;
}

async function fetchLobbyJson(page, pathName) {
  return page
    .evaluate(async (urlPath) => {
      try {
        const response = await fetch(`/v2/${urlPath}`, {
          credentials: 'include',
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        const text = await response.text();
        if (!response.ok) {
          return { ok: false, status: response.status, data: null, raw: text?.slice?.(0, 200) };
        }
        // HTML shell means the route was wrong / session bounced to login page.
        if (/^\s*</.test(text || '') || /text\/html/i.test(response.headers.get('content-type') || '')) {
          return { ok: false, status: response.status, data: null, raw: 'html' };
        }
        try {
          return { ok: true, status: response.status, data: JSON.parse(text) };
        } catch {
          // GetRole / GetUserName sometimes return bare plain text.
          return { ok: true, status: response.status, data: String(text || '').trim() };
        }
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }, pathName)
    .catch(() => null);
}

async function harvestPortfolio(page, payloads) {
  await dismissBlockingModals(page);

  // Stay on the customers portal — do not follow marketing / trade ("אזור אישי גמל") links.
  if (!/customers\.meitav\.co\.il/i.test(page.url())) {
    await page
      .goto('https://customers.meitav.co.il/home/myaccount/allaccounts', {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      })
      .catch(() => {});
    await dismissBlockingModals(page);
  }

  for (const pathName of [
    'api/AmitLobby/getHeaderData',
    'api/AmitLobby/getAllAmitAccounts',
    'api/AllAccounts/GetAllAmitAccounts',
  ]) {
    const hit = await fetchLobbyJson(page, pathName);
    if (hit?.ok && hit?.data != null) {
      payloads.push({
        url: `https://customers.meitav.co.il/v2/${pathName}`,
        status: hit.status,
        data: hit.data,
      });
      console.info(`meitav-pension lobby ${pathName} status=${hit.status}`);
    } else {
      console.info(
        `meitav-pension lobby ${pathName} weak status=${hit?.status} err=${hit?.error || '—'}`,
      );
    }
  }

  // Prefer structured Meitav APIs (excludes TradeTotleData / חיסכון לכל ילד / גמל להשקעה).
  let policies = policiesFromMeitavAccountApis(payloads);
  if (!policies.length) {
    policies = policiesFromPayloads(payloads).filter((row) =>
      isLongTermMeitavProduct(row.productType),
    );
  }

  if (!policies.length) {
    await dumpDebug(page, 'no-portfolio');
    throw new Error(
      'Meitav personal area opened but pension/gemel/hishtalmut balances were not found. Try syncing again with a fresh SMS.',
    );
  }

  console.info(
    `meitav-pension harvested policies=${policies.length} types=${policies.map((p) => p.productType).join(',')}`,
  );
  return portfolioFromPolicies(policies);
}

async function runScrape() {
  resetRun();
  const credentials = {
    idNumber: String(process.env.MEITAV_PENSION_ID_NUMBER || '').trim(),
    phoneNumber: String(process.env.MEITAV_PENSION_PHONE_NUMBER || '').trim(),
  };
  const payloads = [];
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browserHandle = browser;
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(120000);
    await page.setViewport({ width: 1440, height: 1100 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );

    page.on('response', (response) => {
      const type = response.headers()['content-type'] || '';
      const url = response.url();
      const status = response.status();
      if (status >= 400) return;
      const looksJson = type.includes('json') || /api|graphql|json/i.test(url);
      if (!looksJson || !isInterestingJsonUrl(url)) return;
      response
        .text()
        .then((body) => {
          if (!body || body.length > 2_500_000) return;
          try {
            payloads.push({ url, status, data: JSON.parse(body) });
            if (payloads.length > 220) payloads.shift();
          } catch {
            /* ignore */
          }
        })
        .catch(() => {});
    });

    let usedSession = await tryResumeSession(page);
    let portfolio = null;

    if (usedSession) {
      try {
        portfolio = await harvestPortfolio(page, payloads);
      } catch (error) {
        console.info(
          `meitav-pension session harvest failed — falling back to SMS (${String(error.message || '').slice(0, 120)})`,
        );
        await clearAuthState();
        usedSession = false;
        portfolio = null;
      }
    }

    if (!usedSession) {
      state.message = null;
      await loginWithSms(page, credentials);
      portfolio = await harvestPortfolio(page, payloads);
    }

    try {
      await writeAuthState(page);
    } catch (error) {
      console.info(`meitav-pension auth-state save failed ${String(error.message || '').slice(0, 100)}`);
    }

    finish('SUCCESS', {
      portfolio,
      error: null,
      errorCode: null,
      message: usedSession ? 'עודכן עם סשן שמור (ללא SMS).' : null,
    });
    console.info(
      `meitav-pension success session=${usedSession} policies=${portfolio.policies.length} total=${portfolio.totalPensionBalance} payloads=${payloads.length} url=${page.url()}`,
    );
  } catch (error) {
    finish('ERROR', {
      error: error.message || 'The Meitav pension scrape failed.',
      message: error.message || 'The Meitav pension scrape failed.',
      errorCode: error.errorCode || CODES.scrapeFailed,
      portfolio: null,
    });
    console.error(`meitav-pension failed ${state.errorCode} ${error.message}`);
  } finally {
    dropPendingOtp();
    running = false;
    browserHandle = null;
    if (browser) await browser.close().catch(() => {});
  }
}

export function startMeitavPensionScrape() {
  if (running) {
    throw httpError(409, 'A Meitav pension scrape is already running.', CODES.alreadyRunning);
  }
  if (!hasMeitavPensionCredentials()) {
    state.status = 'MISSING_CREDENTIALS';
    state.error = 'MISSING_CREDENTIALS';
    state.message =
      'חסרים פרטי כניסה למיטב גמל ופנסיה בקובץ .env (MEITAV_PENSION_ID_NUMBER / MEITAV_PENSION_PHONE_NUMBER)';
    state.errorCode = CODES.missingCredentials;
    state.finishedAt = new Date().toISOString();
    console.info(`meitav-pension aborted ${CODES.missingCredentials}`);
    throw httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials, state.message);
  }

  loginUrl();
  running = true;
  void runScrape();
  return { status: 'STARTED' };
}
