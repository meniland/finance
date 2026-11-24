import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { activityFromRecord, normalizeActivityStatus } from '../activityStatus.js';
import { getSessionPath } from '../sessionPaths.js';

const OTP_TIMEOUT_MS = 300_000;
const DEFAULT_LOGIN_URL = 'https://my.fnx.co.il/';
const RUNS_ROOT = process.env.RUNS_ROOT || '/tmp/scraper-runs';
const PHOENIX_AUTH_STATE_PATH = getSessionPath('phoenix');
const PROVIDER_LABEL = 'הפניקס';

const CODES = {
  missingCredentials: '20261124.400940',
  alreadyRunning: '20261124.400941',
  scrapeFailed: '20261124.400942',
  noPendingOtp: '20261124.400943',
  invalidLoginUrl: '20261124.400944',
};

export const SELECTORS = {
  idNumber:
    'input[placeholder*="ת.ז"], input[placeholder*="ת״ז"], input[placeholder*="זהות"], input.ac-seg-input',
  phoneOrEmail:
    'input[placeholder*="נייד"], input[placeholder*="מייל"], input[placeholder*="טלפון"], input.ac-outlined-input',
  sendSms: 'button',
  otp: 'input[autocomplete="one-time-code"], input[placeholder*="קוד"], input[aria-label*="קוד"], input[type="tel"], input[maxlength="6"], input[maxlength="8"]',
  otpDigit: 'input[maxlength="1"]',
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

export function hasPhoenixCredentials() {
  return Boolean(String(process.env.PHOENIX_ID_NUMBER || '').trim());
}

function asNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function classifyProductType(raw) {
  const text = String(raw || '');
  if (/השתלמות|hishtalmut|study/i.test(text)) return 'השתלמות';
  if (/פנסיה|pension/i.test(text)) return 'פנסיה';
  if (/גמל|provident|gemel/i.test(text)) return 'גמל';
  return null;
}

function isLongTermProduct(productType) {
  return productType === 'פנסיה' || productType === 'גמל' || productType === 'השתלמות';
}

function moneyValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return asNumber(raw.value ?? raw.amount ?? raw.sum);
  return asNumber(raw);
}

function portfolioFromPolicies(policies, { usedSavedSession = false } = {}) {
  const list = (policies || [])
    .filter(
      (policy) =>
        policy &&
        policy.balance !== null &&
        policy.balance !== undefined &&
        Number(policy.balance) > 0.01 &&
        isLongTermProduct(policy.productType),
    )
    .map((policy) => {
      const activity =
        policy.isActive != null || policy.activityLabel
          ? {
              isActive: policy.isActive ?? null,
              activityLabel: policy.activityLabel || null,
            }
          : normalizeActivityStatus(true);
      return {
        ...policy,
        provider: policy.provider || PROVIDER_LABEL,
        isActive: activity.isActive,
        activityLabel: activity.activityLabel,
      };
    });
  let total = 0;
  for (const policy of list) total += Number(policy.balance) || 0;
  return {
    provider: PROVIDER_LABEL,
    totalPensionBalance: list.length ? total : null,
    usedSavedSession: Boolean(usedSavedSession),
    policies: list,
  };
}

export function getPhoenixState() {
  const portfolio = state.portfolio
    ? portfolioFromPolicies(state.portfolio.policies || [], {
        usedSavedSession: state.portfolio.usedSavedSession,
      })
    : null;
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    message: state.message,
    phoneHint: state.phoneHint,
    credentialsConfigured: hasPhoenixCredentials(),
    sessionSaved: existsSync(PHOENIX_AUTH_STATE_PATH),
    portfolio,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

async function readAuthState() {
  try {
    const text = await readFile(PHOENIX_AUTH_STATE_PATH, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return null;
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    console.info(`phoenix auth-state read failed ${String(error.message || '').slice(0, 80)}`);
    return null;
  }
}

async function clearAuthState() {
  try {
    await unlink(PHOENIX_AUTH_STATE_PATH);
    console.info('phoenix auth-state cleared');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.info(`phoenix auth-state clear failed ${String(error.message || '').slice(0, 80)}`);
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
        domain: cookie.domain || '.fnx.co.il',
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

function phoenixCookiesOnly(cookies) {
  return (cookies || []).filter((cookie) => /fnx\.co\.il/i.test(String(cookie.domain || '')));
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
  if (!/fnx\.co\.il/i.test(page.url())) {
    await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  }
  if (!(await looksLoggedIn(page))) {
    console.info('phoenix skip auth-state save — not logged in');
    return false;
  }

  const client = await page.createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  const phoenixCookies = phoenixCookiesOnly(cookies);
  if (!phoenixCookies.length) {
    console.info('phoenix skip auth-state save — no fnx cookies');
    return false;
  }

  const storage = await readPageStorage(page);
  const origin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return 'https://my.fnx.co.il';
    }
  })();

  await mkdir(path.dirname(PHOENIX_AUTH_STATE_PATH), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    cookies: phoenixCookies,
    origins: [{ origin, ...storage }],
  };
  await writeFile(PHOENIX_AUTH_STATE_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.info(
    `phoenix auth-state saved cookies=${phoenixCookies.length} origin=${origin} path=${PHOENIX_AUTH_STATE_PATH}`,
  );
  return true;
}

async function applyAuthState(page, authState) {
  const cookies = toCdpCookies(phoenixCookiesOnly(authState?.cookies));
  if (!cookies.length) return false;
  const client = await page.createCDPSession();
  await client.send('Network.setCookies', { cookies });

  await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});

  const originState = (authState.origins || []).find((row) => /fnx\.co\.il/i.test(String(row?.origin || '')));
  if (originState) {
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
      }, originState)
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
        resolve(code);
      },
      reject: (error) => {
        clearTimeout(timer);
        pendingOtp = null;
        reject(error);
      },
    };
  });
  return promise;
}

export function submitPhoenixOtp(otpCode) {
  if (!pendingOtp || state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'Phoenix is not waiting for an SMS code.', CODES.noPendingOtp);
  }
  pendingOtp.resolve(String(otpCode || '').trim());
}

function loginUrl() {
  const raw = String(process.env.PHOENIX_LOGIN_URL || DEFAULT_LOGIN_URL).trim() || DEFAULT_LOGIN_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(
      400,
      'Invalid PHOENIX_LOGIN_URL.',
      CODES.invalidLoginUrl,
      'כתובת הכניסה להפניקס אינה תקינה.',
    );
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw httpError(
      400,
      'Invalid PHOENIX_LOGIN_URL.',
      CODES.invalidLoginUrl,
      'כתובת הכניסה להפניקס אינה תקינה.',
    );
  }
  // Marketing homepage is useless for login — always prefer personal area entry.
  if (/^(www\.)?fnx\.co\.il$/i.test(parsed.hostname) && !/my\.|login\.|auth\./i.test(parsed.hostname)) {
    return DEFAULT_LOGIN_URL;
  }
  return parsed.toString();
}

function phoneHintFrom(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function isInterestingJsonUrl(url) {
  return /fnx|auth0|oauth|api|graphql|policy|product|fund|balance|account|pension|gemel|hishtal|saving|portfolio|accumulation|fee|yield|track|otp|login|token|customer|policyholder/i.test(
    url,
  );
}

async function dumpDebug(page, label) {
  try {
    await mkdir(RUNS_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(RUNS_ROOT, `phoenix-${label}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(`${base}.html`, html).catch(() => {});
    await writeFile(
      `${base}.txt`,
      `url=${page.url()}\nstatus=${state.status}\nmessage=${state.message || ''}\n`,
    ).catch(() => {});
    console.info(`phoenix debug ${base}`);
  } catch (error) {
    console.info(`phoenix dump failed ${String(error.message || '').slice(0, 80)}`);
  }
}

async function dismissBlockingModals(page) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"], a')];
      const target = buttons.find((button) => {
        const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`
          .replace(/\s+/g, ' ')
          .trim();
        return /הבנתי|ראיתי|סגור|אני מסכים|Accept|Agree|Close|סגירה/i.test(label);
      });
      if (!target) return null;
      target.click();
      return (target.innerText || '').trim().slice(0, 60);
    });
    if (!clicked) break;
    console.info(`phoenix dismissed ${clicked}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function typeInto(page, selectorList, value) {
  const selectors = String(selectorList)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const selector of selectors) {
    const handle = await page.$(selector).catch(() => null);
    if (!handle) continue;
    const visible = await handle
      .evaluate((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .catch(() => false);
    if (!visible) continue;
    await handle.click({ clickCount: 3 }).catch(() => {});
    await handle.type(String(value), { delay: 25 });
    return true;
  }
  return false;
}

async function clickByText(page, labels, { exact = false } = {}) {
  const clicked = await page.evaluate(
    (wanted, exactOnly) => {
      const nodes = [...document.querySelectorAll('a, button, [role="button"]')];
      for (const node of nodes) {
        const label = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!label || label.length > 100) continue;
        if (/אפליקצ|App Store|Google Play|הורד/i.test(label)) continue;
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
  if (clicked) console.info(`phoenix clicked ${clicked}`);
  return Boolean(clicked);
}

async function looksLoggedIn(page) {
  const url = page.url();
  if (/auth\.fnx\.co\.il\/u\/login|login\.fnx\.co\.il\/login/i.test(url)) return false;
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/שלחו לי קוד כניסה|מספר ת\.ז|ברוכים הבאים לאזור האישי/i.test(text) && !/התנתק|יציאה|יתרה|צבירה|מוצרים|פוליס/i.test(text)) {
    return false;
  }
  if (/התנתק|יציאה|יתרה|צבירה|המוצרים שלי|פוליסות|חשבונות|קרן השתלמות|קופת גמל/i.test(text)) {
    return true;
  }
  return /my\.fnx\.co\.il/i.test(url) && !/login|auth/i.test(url);
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
  const balance =
    moneyValue(record.sum) ??
    moneyValue(record.savingSum) ??
    moneyValue(record.accumulation) ??
    asNumber(
      pick(record, [
        'balance',
        'totalBalance',
        'accumulationBalance',
        'savingBalance',
        'amount',
        'totalAmount',
        'currentBalance',
        'availableSum',
        'יתרה',
        'צבירה',
        'סהכ',
      ]),
    );
  const policyName = String(
    pick(record, [
      'policyName',
      'productDescription',
      'originalPolicyName',
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
      'policyId',
      'policyNumber',
      'accountNumber',
      'fundNumber',
      'planNumber',
      'accountId',
      'מספר',
      'פוליסה',
      'חשבון',
    ]) || '',
  ).trim();
  const productRaw = String(
    pick(record, [
      'policyType',
      'productType',
      'productDescription',
      'product',
      'fundType',
      'planType',
      'category',
      'סוג',
      'productDesc',
    ]) || policyName,
  );
  const productType = classifyProductType(productRaw);
  if (!isLongTermProduct(productType)) return null;
  const activity = activityFromRecord(record);
  // Skip cancelled / empty rows (e.g. cancelled "פוליסת השקעה").
  if (activity.isActive === false) return null;
  if (/מבוטל|cancelled|inactive/i.test(String(record.status || record.policyStatus || ''))) return null;
  if (balance == null || Math.abs(balance) < 0.01) return null;

  return {
    provider: PROVIDER_LABEL,
    policyName: policyName || productType,
    policyNumber: policyNumber || null,
    productType,
    employerName: String(pick(record, ['employerName', 'employer', 'מעסיק']) || '').trim() || null,
    balance,
    investmentTrack:
      String(pick(record, ['investmentTrack', 'track', 'route', 'maslul', 'מסלול']) || '').trim() ||
      null,
    depositFeePercent: asNumber(
      pick(record, ['depositFeePercent', 'depositFee', 'managementFeeDeposit', 'דמיניהולמהפקדה']),
    ),
    accumulationFeePercent: asNumber(
      pick(record, [
        'accumulationFeePercent',
        'accumulationFee',
        'managementFeeAccumulation',
        'דמיניהולמצבירה',
      ]),
    ),
    annualYieldPercent: asNumber(
      pick(record, ['annualYieldPercent', 'yield', 'annualYield', 'returnYtd', 'תשואה']),
    ),
    isActive: activity.isActive ?? true,
    activityLabel: activity.activityLabel || 'פעיל',
  };
}

function policyFromSavingsPageItem(item) {
  if (!item || typeof item !== 'object') return null;
  const productType = classifyProductType(item.policyType || item.productDescription || item.policyName);
  if (!isLongTermProduct(productType)) return null;
  const data = item.productData || {};
  const routes = Array.isArray(item.investmentRoutes) ? item.investmentRoutes : [];
  const primaryRoute =
    routes.slice().sort((a, b) => (moneyValue(b?.accumulation) || 0) - (moneyValue(a?.accumulation) || 0))[0] ||
    null;
  const balance =
    moneyValue(data.savingSum) ||
    moneyValue(primaryRoute?.accumulation) ||
    moneyValue(item.savingSum) ||
    moneyValue(item.sum);
  if (balance == null || Math.abs(balance) < 0.01) return null;

  const trackParts = routes
    .map((route) => {
      const name = String(route?.name || '').trim();
      if (!name) return null;
      const pct = moneyValue(route?.percent);
      return pct != null && pct > 0 && pct < 100 ? `${name} (${pct}%)` : name;
    })
    .filter(Boolean);

  const activity = activityFromRecord(item);
  return {
    provider: PROVIDER_LABEL,
    policyName:
      String(item.policyName || item.originalPolicyName || item.productDescription || productType).trim() ||
      productType,
    policyNumber: String(item.policyId || '').trim() || null,
    productType,
    employerName: String(item.employerName || item.employer || '').trim() || null,
    balance,
    investmentTrack: trackParts.join(' · ') || String(primaryRoute?.name || '').trim() || null,
    depositFeePercent:
      moneyValue(data?.managementFee?.fromDeposit) ?? moneyValue(primaryRoute?.managementFeeFromDeposit),
    accumulationFeePercent:
      moneyValue(data?.managementFee?.fromSaving) ?? moneyValue(primaryRoute?.managementFeeFromSaving),
    annualYieldPercent:
      moneyValue(primaryRoute?.yieldBeginningYear) ??
      moneyValue(data?.yieldBeginningYear) ??
      moneyValue(data?.yieldFromYearBeginningTotal),
    isActive: activity.isActive ?? true,
    activityLabel: activity.activityLabel || 'פעיל',
  };
}

function policyDetailScore(policy) {
  if (!policy) return 0;
  let score = 0;
  if (policy.investmentTrack) score += 4;
  if (policy.depositFeePercent != null) score += 2;
  if (policy.accumulationFeePercent != null) score += 2;
  if (policy.annualYieldPercent != null) score += 2;
  if (policy.employerName) score += 1;
  return score;
}

function policiesFromPhoenixApis(payloads) {
  const byKey = new Map();
  const upsert = (policy) => {
    if (!policy || !isLongTermProduct(policy.productType) || !(Number(policy.balance) > 0.01)) return;
    const key = `${policy.productType}|${policy.policyNumber || policy.policyName || ''}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, policy);
      return;
    }
    // Prefer the richer savings/page row over bare savingList balances.
    if (policyDetailScore(policy) >= policyDetailScore(prev)) {
      byKey.set(key, {
        ...prev,
        ...policy,
        investmentTrack: policy.investmentTrack || prev.investmentTrack,
        depositFeePercent:
          policy.depositFeePercent != null ? policy.depositFeePercent : prev.depositFeePercent,
        accumulationFeePercent:
          policy.accumulationFeePercent != null
            ? policy.accumulationFeePercent
            : prev.accumulationFeePercent,
        annualYieldPercent:
          policy.annualYieldPercent != null ? policy.annualYieldPercent : prev.annualYieldPercent,
        employerName: policy.employerName || prev.employerName,
        policyName: policy.policyName || prev.policyName,
        balance: policy.balance || prev.balance,
      });
    }
  };

  // Pass 1: rich product details from /api/v1/info/savings/page
  for (const row of payloads || []) {
    const data = row?.data;
    if (!data || typeof data !== 'object') continue;
    const productGroups = data?.response?.productList?.list || data?.productList?.list || [];
    for (const group of productGroups) {
      for (const item of group?.policyList || []) {
        upsert(
          policyFromSavingsPageItem({
            ...item,
            policyType: item.policyType || group.policyType,
          }),
        );
      }
    }
  }

  // Pass 2: balances from /api/v1/info/policy/savings/active
  for (const row of payloads || []) {
    const data = row?.data;
    if (!data || typeof data !== 'object') continue;
    const savingList =
      data?.response?.savingList ||
      data?.savingList ||
      data?.response?.response?.savingList ||
      [];
    for (const item of savingList) {
      upsert(
        policyFromRecord({
          ...item,
          productDescription: item.productDescription || item.originalPolicyName,
          policyType: item.policyType,
          sum: item.sum,
          policyId: item.policyId,
          status: item.status,
        }),
      );
    }
  }

  return [...byKey.values()];
}

function policiesFromPayloads(payloads) {
  const fromApi = policiesFromPhoenixApis(payloads);
  if (fromApi.length) return fromApi;

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

async function fetchPhoenixJson(page, pathName, bearerToken = null) {
  return page
    .evaluate(
      async ({ urlPath, token }) => {
        try {
          const headers = { Accept: 'application/json, text/plain, */*' };
          if (token) headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
          const response = await fetch(urlPath, { credentials: 'include', headers });
          const text = await response.text();
          if (!response.ok) {
            return { ok: false, status: response.status, raw: text?.slice?.(0, 200) };
          }
          try {
            return { ok: true, status: response.status, data: JSON.parse(text) };
          } catch {
            return { ok: false, status: response.status, raw: text?.slice?.(0, 200) };
          }
        } catch (error) {
          return { ok: false, error: String(error?.message || error) };
        }
      },
      { urlPath: pathName, token: bearerToken },
    )
    .catch(() => null);
}

async function captureBearerToken(page, timeoutMs = 20000) {
  const existing = await page
    .evaluate(() => {
      try {
        for (const store of [localStorage, sessionStorage]) {
          for (let i = 0; i < store.length; i += 1) {
            const key = store.key(i);
            const value = store.getItem(key) || '';
            if (/access_token|id_token|Bearer/i.test(`${key} ${value}`)) {
              const match = value.match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
              if (match) return match[0];
            }
            try {
              const parsed = JSON.parse(value);
              const token = parsed?.access_token || parsed?.accessToken || parsed?.id_token;
              if (token) return String(token);
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
      return null;
    })
    .catch(() => null);
  if (existing) return existing;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      page.off('request', onRequest);
      resolve(null);
    }, timeoutMs);
    function onRequest(req) {
      const auth = req.headers().authorization || req.headers().Authorization;
      if (auth && /Bearer\s+eyJ/i.test(auth)) {
        clearTimeout(timer);
        page.off('request', onRequest);
        resolve(auth.replace(/^Bearer\s+/i, '').trim());
      }
    }
    page.on('request', onRequest);
  });
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
        /(קרנות פנסיה|קרן פנסיה|פנסיה|קופת גמל|גמל|קרן השתלמות|השתלמות)[^\d₪]{0,80}₪?\s*([\d,]{3,}(?:\.\d+)?)/g;
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
      for (const card of cards.slice(0, 250)) {
        const text = textOf(card);
        if (text.length < 8 || text.length > 2000) continue;
        if (!/(פנסיה|גמל|השתלמות|יתרה|צבירה|קופה|קרן|₪)/i.test(text)) continue;
        const shekel =
          text.match(/₪\s*([\d,]{3,}(?:\.\d+)?)/) || text.match(/([\d,]{3,}(?:\.\d+)?)\s*₪/);
        if (!shekel) continue;
        const heading =
          textOf(card.querySelector('h1,h2,h3,h4,strong,a')) ||
          text.split('\n')[0]?.slice(0, 80) ||
          text.slice(0, 80);
        const numberMatch = text.match(
          /(?:פוליסה|תוכנית|חשבון|מס(?:פר)?)\s*[:#]?\s*([A-Z0-9-]{4,})/i,
        );
        const employerMatch = text.match(/מעסיק(?:\s*אחרון)?\s*:?\s*([^\n]{2,60})/);
        const trackMatch = text.match(/מסלול(?:\s+השקעה)?\s*:?\s*([^\n%]{2,80})/);
        const depositFee = text.match(/דמי\s*ניהול\s*מהפקדה\s*:?\s*([\d.]+)\s*%/);
        const accumFee = text.match(/דמי\s*ניהול\s*מצבירה\s*:?\s*([\d.]+)\s*%/);
        const yieldMatch = text.match(/תשואה(?:\s*שנתית)?\s*:?\s*([\d.]+)\s*%/);
        out.push({
          policyName: heading,
          policyNumber: numberMatch?.[1] || '',
          productType: text,
          balance: parseMoney(shekel[1]),
          employerName: employerMatch?.[1]?.trim() || '',
          investmentTrack: trackMatch?.[1]?.trim() || '',
          depositFeePercent: depositFee?.[1] || null,
          accumulationFeePercent: accumFee?.[1] || null,
          annualYieldPercent: yieldMatch?.[1] || null,
        });
      }
      return out;
    })
    .catch(() => []);

  return rows.map((row) => policyFromRecord(row)).filter(Boolean);
}

async function fillOtp(page, digits) {
  const code = String(digits || '').replace(/\D/g, '');
  if (!code) return false;

  const digitInputs = await page.$$(SELECTORS.otpDigit).catch(() => []);
  const visibleDigits = [];
  for (const handle of digitInputs.slice(0, 10)) {
    const visible = await handle
      .evaluate((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0;
      })
      .catch(() => false);
    if (visible) visibleDigits.push(handle);
  }
  if (visibleDigits.length >= 4 && visibleDigits.length <= code.length) {
    for (let i = 0; i < visibleDigits.length; i += 1) {
      await visibleDigits[i].click({ clickCount: 3 }).catch(() => {});
      await visibleDigits[i].type(code[i] || '', { delay: 20 });
    }
    return true;
  }

  if (await typeInto(page, SELECTORS.otp, code)) return true;

  return page.evaluate((value) => {
    const inputs = [...document.querySelectorAll('input')].filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || rect.width < 2) return false;
      const meta = `${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''} ${el.id || ''}`;
      return /קוד|otp|code|sms/i.test(meta) || el.autocomplete === 'one-time-code';
    });
    const target = inputs[0];
    if (!target) return false;
    target.focus();
    target.value = value;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, code);
}

async function tryResumeSession(page) {
  const authState = await readAuthState();
  if (!authState) {
    console.info('phoenix no saved auth-state');
    return false;
  }
  console.info(
    `phoenix trying saved auth-state from ${authState.savedAt || 'unknown'} cookies=${(authState.cookies || []).length}`,
  );
  state.message = 'משתמש בסשן שמור…';
  await applyAuthState(page, authState);
  await dismissBlockingModals(page);
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});

  if (await looksLoggedIn(page)) {
    console.info(`phoenix resumed session url=${page.url()}`);
    return true;
  }

  console.info(`phoenix saved session not authenticated url=${page.url()}`);
  await clearAuthState();
  return false;
}

async function loginWithSms(page, credentials) {
  state.phoneHint = phoneHintFrom(credentials.phoneNumber);
  const target = loginUrl();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 25000 }).catch(() => {});
  await dismissBlockingModals(page);

  // Ensure we land on Auth0 / universal login.
  if (!(await page.$(SELECTORS.idNumber).catch(() => null))) {
    await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 25000 }).catch(() => {});
    await dismissBlockingModals(page);
  }

  console.info(`phoenix login page url=${page.url()}`);
  const idOk = await typeInto(page, SELECTORS.idNumber, credentials.idNumber);
  if (!idOk) {
    await dumpDebug(page, 'no-id-field');
    throw new Error('Phoenix login ID field was not found.');
  }

  if (credentials.phoneNumber) {
    const phoneDigits = String(credentials.phoneNumber).replace(/\D/g, '');
    const phoneValue = phoneDigits.startsWith('0') ? phoneDigits : `0${phoneDigits}`;
    await typeInto(page, SELECTORS.phoneOrEmail, phoneValue);
  }

  const sent = await clickByText(page, ['שלחו לי קוד כניסה'], { exact: false });
  if (!sent) {
    await dumpDebug(page, 'no-send-sms');
    throw new Error('Phoenix SMS send button was not found.');
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  state.message = 'ממתין לקוד SMS מהפניקס…';
  const otpCode = await waitForOtp();
  const digits = String(otpCode || '').replace(/\D/g, '');
  if (!digits) throw new Error('Empty SMS code.');

  const filled = await fillOtp(page, digits);
  if (!filled) {
    await dumpDebug(page, 'no-otp-field');
    throw new Error('Phoenix OTP field was not found.');
  }

  await clickByText(page, ['אישור', 'המשך', 'כניסה', 'שלח', 'אימות', 'Confirm', 'Continue'], {
    exact: false,
  }).catch(() => {});
  await page.keyboard.press('Enter').catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 45000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await dismissBlockingModals(page);

  // Auth0 sometimes returns to my.fnx.co.il after code exchange.
  if (!/my\.fnx\.co\.il/i.test(page.url())) {
    await page.goto(DEFAULT_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 25000 }).catch(() => {});
  }

  if (!(await looksLoggedIn(page))) {
    await dumpDebug(page, 'login-failed');
    throw new Error('Phoenix login succeeded but personal area did not open.');
  }
}

async function harvestPortfolio(page, payloads) {
  await dismissBlockingModals(page);
  const bearerPromise = captureBearerToken(page, 25000);
  if (!/my\.fnx\.co\.il\/savings/i.test(page.url())) {
    await page
      .goto('https://my.fnx.co.il/savings', { waitUntil: 'domcontentloaded', timeout: 90000 })
      .catch(() => {});
  }
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await dismissBlockingModals(page);

  const bearer = await bearerPromise;
  if (bearer) console.info('phoenix captured bearer token');

  for (const pathName of [
    '/api/v1/info/savings/page',
    '/api/v1/info/policy/savings/active',
  ]) {
    const hit = await fetchPhoenixJson(page, pathName, bearer);
    if (hit?.ok && hit?.data) {
      payloads.push({
        url: `https://my.fnx.co.il${pathName}`,
        status: hit.status,
        data: hit.data,
      });
      console.info(`phoenix api ${pathName} status=${hit.status}`);
    } else {
      console.info(
        `phoenix api ${pathName} weak status=${hit?.status || '—'} err=${hit?.error || hit?.raw || '—'}`,
      );
    }
  }

  // Give late intercepted /savings/page responses a moment to land in payloads.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  let policies = policiesFromPhoenixApis(payloads);
  if (!policies.length) policies = policiesFromPayloads(payloads);
  if (!policies.length) policies = await extractPoliciesFromDom(page);

  if (!policies.length) {
    await dumpDebug(page, 'no-portfolio');
    throw new Error(
      'Phoenix personal area opened but gemel/hishtalmut balances were not found. Try syncing again with a fresh SMS.',
    );
  }

  console.info(
    `phoenix harvested policies=${policies.length} types=${policies.map((p) => p.productType).join(',')} total=${policies.reduce((s, p) => s + (Number(p.balance) || 0), 0)} tracks=${policies.filter((p) => p.investmentTrack).length}`,
  );
  return policies;
}

async function runScrape() {
  resetRun();
  const credentials = {
    idNumber: String(process.env.PHOENIX_ID_NUMBER || '').replace(/\D/g, '').padStart(9, '0'),
    phoneNumber: String(process.env.PHOENIX_PHONE_NUMBER || '').trim(),
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
    let policies = null;

    if (usedSession) {
      try {
        policies = await harvestPortfolio(page, payloads);
      } catch (error) {
        console.info(
          `phoenix session harvest failed — falling back to SMS (${String(error.message || '').slice(0, 120)})`,
        );
        await clearAuthState();
        usedSession = false;
        policies = null;
      }
    }

    if (!usedSession) {
      state.message = null;
      await loginWithSms(page, credentials);
      policies = await harvestPortfolio(page, payloads);
    }

    const portfolio = portfolioFromPolicies(policies, { usedSavedSession: usedSession });

    try {
      await writeAuthState(page);
    } catch (error) {
      console.info(`phoenix auth-state save failed ${String(error.message || '').slice(0, 100)}`);
    }

    finish('SUCCESS', {
      portfolio,
      error: null,
      errorCode: null,
      message: usedSession ? 'עודכן עם סשן שמור (ללא SMS).' : null,
    });
    console.info(
      `phoenix success session=${usedSession} policies=${portfolio.policies.length} total=${portfolio.totalPensionBalance} payloads=${payloads.length} url=${page.url()}`,
    );
  } catch (error) {
    finish('ERROR', {
      error: error.message || 'The Phoenix scrape failed.',
      message: error.message || 'The Phoenix scrape failed.',
      errorCode: error.errorCode || CODES.scrapeFailed,
      portfolio: null,
    });
    console.error(`phoenix failed ${state.errorCode} ${error.message}`);
  } finally {
    dropPendingOtp();
    running = false;
    browserHandle = null;
    if (browser) await browser.close().catch(() => {});
  }
}

export function startPhoenixScrape() {
  if (running) {
    throw httpError(409, 'A Phoenix scrape is already running.', CODES.alreadyRunning);
  }
  if (!hasPhoenixCredentials()) {
    state.status = 'MISSING_CREDENTIALS';
    state.error = 'MISSING_CREDENTIALS';
    state.message =
      'חסרים פרטי כניסה להפניקס בקובץ .env (PHOENIX_ID_NUMBER / PHOENIX_PHONE_NUMBER)';
    state.errorCode = CODES.missingCredentials;
    state.finishedAt = new Date().toISOString();
    console.info(`phoenix aborted ${CODES.missingCredentials}`);
    throw httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials, state.message);
  }

  loginUrl();
  running = true;
  void runScrape();
  return { status: 'STARTED' };
}
