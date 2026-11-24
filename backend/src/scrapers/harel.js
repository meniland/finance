import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { contributionFromDeposits, normalizeActivityStatus } from '../activityStatus.js';
import { getSessionPath } from '../sessionPaths.js';

const OTP_TIMEOUT_MS = 300_000;
const DEFAULT_LOGIN_URL = 'https://www.harel-group.co.il/Pages/login-Page/Login.aspx';
const RUNS_ROOT = process.env.RUNS_ROOT || '/tmp/scraper-runs';
const PROVIDER_LABEL = 'הראל';
const HAREL_ORIGINS = [
  'https://www.harel-group.co.il',
  'https://digital.harel-group.co.il',
];

const CODES = {
  missingCredentials: '20261122.401201',
  alreadyRunning: '20261122.401202',
  scrapeFailed: '20261122.401203',
  noPendingOtp: '20261122.401204',
  invalidLoginUrl: '20261122.401205',
};

/** Isolated Meni / Efrat Harel profiles (credentials + session path). */
export const HAREL_PROFILES = {
  meni: {
    profileKey: 'meni',
    sessionKey: 'harel-meni',
    idEnv: 'HAREL_ID_NUMBER',
    phoneEnv: 'HAREL_PHONE_NUMBER',
  },
  efrat: {
    profileKey: 'efrat',
    sessionKey: 'harel-efrat',
    idEnv: 'EFRAT_HAREL_ID_NUMBER',
    phoneEnv: 'EFRAT_HAREL_PHONE_NUMBER',
  },
};

/**
 * Adjust here if the Harel personal-area markup changes.
 * Login is a passwordless ID + phone + SMS OTP flow.
 */
export const SELECTORS = {
  // Yellow header CTA that opens the Scanovate login panel
  openPersonalArea: 'button',
  // Israeli ID / תעודת זהות (header personal-menu uses #idUser)
  idNumber:
    'input#idUser, input[name="idUser"], input#uid, input[name="uid"], input[placeholder*="זהות"], input[aria-label*="זהות"]',
  // Mobile phone
  phoneNumber: 'input#phone, input[name="phone"], input[placeholder*="נייד"], input[placeholder*="טלפון"], input[aria-label*="נייד"], input[aria-label*="טלפון"]',
  // Request SMS / continue after ID (+ phone)
  sendSms:
    'button[data-hrl-bo="atm-personalMenuLogin"]:not(.Mui-disabled), button[data-hrl-bo="atm-personalMenuLogin"], button[type="submit"]:not(.Mui-disabled)',
  // Single OTP field
  otp: 'input#otp, input[name="otp"], input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="קוד"], input[aria-label*="קוד"]',
  // Digit boxes if OTP is split
  otpDigit: 'input[maxlength="1"]',
  // Confirm OTP
  otpSubmit:
    'button[data-hrl-bo*="otp" i], button[type="submit"]:not(.Mui-disabled), button.btn-primary, button[class*="confirm" i]',
};

function createEmptyState() {
  return {
    status: 'IDLE',
    error: null,
    errorCode: null,
    message: null,
    phoneHint: null,
    portfolio: null,
    startedAt: null,
    finishedAt: null,
  };
}

function createRuntime(profileDef) {
  return {
    profileKey: profileDef.profileKey,
    idEnv: profileDef.idEnv,
    phoneEnv: profileDef.phoneEnv,
    authStatePath: getSessionPath(profileDef.sessionKey),
    logTag: `harel[${profileDef.profileKey}]`,
    running: false,
    pendingOtp: null,
    browserHandle: null,
    state: createEmptyState(),
  };
}

const runtimes = {
  meni: createRuntime(HAREL_PROFILES.meni),
  efrat: createRuntime(HAREL_PROFILES.efrat),
};

function httpError(status, error, errorCode, messageText) {
  const err = new Error(error);
  err.status = status;
  err.errorCode = errorCode;
  err.messageText = messageText || error;
  return err;
}

function hasProfileCredentials(rt) {
  return Boolean(String(process.env[rt.idEnv] || '').trim());
}

function readProfileCredentials(rt) {
  return {
    profileKey: rt.profileKey,
    idNumber: String(process.env[rt.idEnv] || '').trim(),
    phoneNumber: String(process.env[rt.phoneEnv] || '').trim(),
  };
}

function getProfileState(rt) {
  const portfolio = rt.state.portfolio
    ? portfolioFromPolicies(rt.state.portfolio.policies || [])
    : null;
  return {
    status: rt.state.status,
    error: rt.state.error,
    errorCode: rt.state.errorCode,
    message: rt.state.message,
    phoneHint: rt.state.phoneHint,
    credentialsConfigured: hasProfileCredentials(rt),
    sessionSaved: existsSync(rt.authStatePath),
    portfolio,
    profileKey: rt.profileKey,
    startedAt: rt.state.startedAt,
    finishedAt: rt.state.finishedAt,
  };
}

export function hasHarelCredentials() {
  return hasProfileCredentials(runtimes.meni);
}

export function getHarelState() {
  return getProfileState(runtimes.meni);
}

export function hasEfratHarelCredentials() {
  return hasProfileCredentials(runtimes.efrat);
}

export function getEfratHarelState() {
  return getProfileState(runtimes.efrat);
}

async function readHarelAuthState(rt) {
  try {
    const text = await readFile(rt.authStatePath, 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return null;
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    console.info(`${rt.logTag} auth-state read failed ${String(error.message || '').slice(0, 80)}`);
    return null;
  }
}

async function clearHarelAuthState(rt) {
  try {
    await unlink(rt.authStatePath);
    console.info(`${rt.logTag} auth-state cleared`);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.info(`${rt.logTag} auth-state clear failed ${String(error.message || '').slice(0, 80)}`);
    }
  }
}

async function collectOriginStorage(page, origin) {
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return page.evaluate(() => {
      const localStorageEntries = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const name = localStorage.key(i);
        if (!name) continue;
        localStorageEntries.push({ name, value: localStorage.getItem(name) });
      }
      const sessionStorageEntries = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const name = sessionStorage.key(i);
        if (!name) continue;
        sessionStorageEntries.push({ name, value: sessionStorage.getItem(name) });
      }
      return { localStorage: localStorageEntries, sessionStorage: sessionStorageEntries };
    });
  } catch (error) {
    console.info(`harel storage collect failed ${origin} ${String(error.message || '').slice(0, 80)}`);
    return { localStorage: [], sessionStorage: [] };
  }
}

async function writeHarelAuthState(rt, page) {
  const client = await page.createCDPSession();
  const { cookies } = await client.send('Network.getAllCookies');
  const harelCookies = (cookies || []).filter((cookie) =>
    /harel/i.test(`${cookie.domain || ''} ${cookie.name || ''}`),
  );
  const origins = [];
  for (const origin of HAREL_ORIGINS) {
    const storage = await collectOriginStorage(page, origin);
    origins.push({ origin, ...storage });
  }
  await mkdir(path.dirname(rt.authStatePath), { recursive: true });
  const payload = {
    savedAt: new Date().toISOString(),
    profileKey: rt.profileKey,
    cookies: harelCookies,
    origins,
  };
  await writeFile(rt.authStatePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.info(
    `${rt.logTag} auth-state saved cookies=${harelCookies.length} origins=${origins.length} path=${rt.authStatePath}`,
  );
}

async function applyHarelAuthState(page, authState) {
  if (!authState?.cookies?.length) return false;
  const client = await page.createCDPSession();
  await client.send('Network.setCookies', { cookies: authState.cookies });

  for (const originState of authState.origins || []) {
    if (!originState?.origin) continue;
    try {
      await page.goto(`${originState.origin}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.evaluate((storage) => {
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
      }, originState);
    } catch (error) {
      console.info(
        `harel auth-state apply storage failed ${originState.origin} ${String(error.message || '').slice(0, 80)}`,
      );
    }
  }
  return true;
}

function resetRun(rt) {
  rt.state.status = 'SCRAPING';
  rt.state.error = null;
  rt.state.errorCode = null;
  rt.state.message = null;
  rt.state.phoneHint = null;
  rt.state.portfolio = null;
  rt.state.startedAt = new Date().toISOString();
  rt.state.finishedAt = null;
}

function finish(rt, status, extra = {}) {
  rt.state.status = status;
  rt.state.finishedAt = new Date().toISOString();
  Object.assign(rt.state, extra);
}

function dropPendingOtp(rt) {
  if (!rt.pendingOtp) return;
  const { reject } = rt.pendingOtp;
  rt.pendingOtp = null;
  reject(new Error('OTP wait ended'));
}

function waitForOtp(rt) {
  rt.state.status = 'AWAITING_OTP';
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!rt.pendingOtp) return;
      rt.pendingOtp = null;
      reject(new Error('Timed out waiting for the SMS code'));
    }, OTP_TIMEOUT_MS);

    rt.pendingOtp = {
      resolve: (code) => {
        clearTimeout(timer);
        rt.pendingOtp = null;
        rt.state.status = 'SCRAPING';
        resolve(code);
      },
      reject: (error) => {
        clearTimeout(timer);
        rt.pendingOtp = null;
        reject(error);
      },
    };
  });
  promise.catch(() => {});
  return promise;
}

function submitProfileOtp(rt, otpCode) {
  if (!rt.pendingOtp || rt.state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'Harel is not waiting for an SMS code.', CODES.noPendingOtp);
  }
  rt.pendingOtp.resolve(otpCode);
}

export function submitHarelOtp(otpCode) {
  return submitProfileOtp(runtimes.meni, otpCode);
}

export function submitEfratHarelOtp(otpCode) {
  return submitProfileOtp(runtimes.efrat, otpCode);
}

function loginUrl() {
  const raw = String(process.env.HAREL_LOGIN_URL || DEFAULT_LOGIN_URL).trim() || DEFAULT_LOGIN_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(400, 'Invalid HAREL_LOGIN_URL.', CODES.invalidLoginUrl, 'כתובת הכניסה להראל אינה תקינה.');
  }
  if (!/^https?:$/i.test(parsed.protocol)) {
    throw httpError(400, 'Invalid HAREL_LOGIN_URL.', CODES.invalidLoginUrl, 'כתובת הכניסה להראל אינה תקינה.');
  }
  return parsed;
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.-]/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function keyOf(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9\u0590-\u05ff]/g, '');
}

function pick(record, keys) {
  if (!record || typeof record !== 'object') return null;
  const entries = Object.entries(record);
  for (const wanted of keys) {
    const target = keyOf(wanted);
    for (const [key, value] of entries) {
      if (keyOf(key) === target && value !== null && value !== undefined && value !== '') return value;
    }
  }
  for (const wanted of keys) {
    const target = keyOf(wanted);
    for (const [key, value] of entries) {
      if (keyOf(key).includes(target) && value !== null && value !== undefined && value !== '') return value;
    }
  }
  return null;
}

function walk(value, visit, depth = 0) {
  if (depth > 10 || value == null) return;
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) walk(item, visit, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const child of Object.values(value).slice(0, 80)) walk(child, visit, depth + 1);
  }
}

function classifyProductType(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  if (/השתלמות|hishtalmut|study/.test(raw) || /study|education/.test(lower)) return 'השתלמות';
  if (/גמל|gemel|provident/.test(raw) || /provident|gemel/.test(lower)) return 'גמל';
  if (/פנסיה|pension/.test(raw) || /pension/.test(lower)) return 'פנסיה';
  if (/ביטוח מנהלים|managers/.test(raw)) return 'ביטוח מנהלים';
  return raw.trim() || 'אחר';
}

function phoneHintFrom(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

const JUNK_NAME_RE =
  /@harel\/|customer-main-|scanovate|service-center|importmap|root-config|single-spa|פעולות נפוצות|כניסה ל|אודות הראל|שימוש בקבצי|cookie/i;

const SAVINGS_HINT_RE = /פנסיה|גמל|השתלמות|חיסכון|צבירה|יתרה|קופה|קרן|pension|gemel|provident|hishtal|saving|fund|accumulation|balance/i;

function isInterestingJsonUrl(url) {
  const text = String(url || '');
  if (/google-analytics|doubleclick|dynatrace|glassbox|zoomengage|facebook|gtm|fonts-harel|\.woff|analytics\.google/i.test(text)) {
    return false;
  }
  // Keep cloudfront app bundles out, but allow Harel API hosts.
  if (/cloudfront\.net/i.test(text) && !/webapi|\.json(\?|$)/i.test(text)) return false;
  return /harel-group\.co\.il|harel-net\.co\.il|digital\.harel|apps\.client-view|webapi|Authenticate|Scanovate|pension|gemel|policy|portfolio|saving|fund|product|balance|accumulation|personal-info|my-harel|study-fund|Finance|Gemel|Pension|Hishtal|yield|return|fee|management|track|maslul|SCValidateOTP|CreateOTP|StartProcess|GetCurrentDetails/i.test(
    text,
  );
}

function looksLikeJunkName(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (JUNK_NAME_RE.test(text)) return true;
  if (/^@/.test(text)) return true;
  if (text.length > 120) return true;
  return false;
}

function policyFromRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;

  const policyName = String(
    pick(record, [
      'policyName',
      'productName',
      'fundName',
      'planName',
      'displayName',
      'productDescription',
      'description',
      'שםמוצר',
      'שםתוכנית',
      'שםפוליסה',
      'שם',
      'title',
      'name',
    ]) || '',
  ).trim();
  if (looksLikeJunkName(policyName) && policyName) {
    // Keep going only if this record still has a clear savings balance + number.
  }

  const policyNumber = String(
    pick(record, [
      'policyNumber',
      'policyNo',
      'policyId',
      'productNumber',
      'accountNumber',
      'fundNumber',
      'contractNumber',
      'planNumber',
      'מספרפוליסה',
      'מספרתוכנית',
      'מספרקופה',
    ]) || '',
  ).trim();

  const productRaw = pick(record, [
    'productType',
    'productCategory',
    'category',
    'fundType',
    'planType',
    'productFamily',
    'סוגמוצר',
    'סוג',
  ]);

  const balance = asNumber(
    pick(record, [
      'accumulatedBalance',
      'accumulationBalance',
      'savingBalance',
      'savingsBalance',
      'totalBalance',
      'currentBalance',
      'balanceAmount',
      'policyBalance',
      'displayBalance',
      'balance',
      'accumulation',
      'accumulatedAmount',
      'totalSaving',
      'totalSavings',
      'savingSum',
      'savingsSum',
      'sumSaving',
      'sum',
      'total',
      'value',
      'currentValue',
      'marketValue',
      'totalAmount',
      'amountNIS',
      'amountIls',
      'ilsAmount',
      'יתרהצבורה',
      'סכוםצבור',
      'יתרה',
      'צבירה',
      'amount',
    ]),
  );

  const investmentTrack = String(
    pick(record, [
      'investmentTrack',
      'trackName',
      'routeName',
      'investmentPath',
      'fundTrack',
      'channelName',
      'מסלולהשקעה',
      'מסלול',
    ]) || '',
  ).trim();

  const depositFeePercent = asNumber(
    pick(record, [
      'depositFeePercent',
      'depositFee',
      'managementFeeDeposit',
      'feeFromDeposit',
      'depositManagementFee',
      'דמיניהולמהפקדה',
      'מהפקדה',
    ]),
  );
  const accumulationFeePercent = asNumber(
    pick(record, [
      'accumulationFeePercent',
      'accumulationFee',
      'managementFeeAccumulation',
      'feeFromAccumulation',
      'accumulationManagementFee',
      'דמיניהולמצבירה',
      'מצבירה',
    ]),
  );
  const annualYieldPercent = asNumber(
    pick(record, [
      'annualYieldPercent',
      'annualYield',
      'yieldPercent',
      'yearlyReturn',
      'yearYield',
      'תשואהשנתית',
      'תשואה',
    ]),
  );

  // Require a real monetary balance — microfrontend registry objects only have "name".
  if (balance === null) return null;
  if (Math.abs(balance) < 0.01 && !policyNumber) return null;

  const blob = `${policyName} ${productRaw || ''} ${policyNumber} ${investmentTrack}`;
  if (looksLikeJunkName(policyName) && !SAVINGS_HINT_RE.test(blob) && !policyNumber) return null;
  if (!SAVINGS_HINT_RE.test(blob) && !policyNumber && depositFeePercent === null && accumulationFeePercent === null) {
    // Likely unrelated money node (premium, claim, etc.)
    if (!/saving|fund|policy|product|plan|קופה|קרן|פוליסה/i.test(Object.keys(record).join(' '))) {
      return null;
    }
  }

  const cleanName = looksLikeJunkName(policyName) ? '' : policyName;
  const productType = classifyProductType(productRaw || cleanName || policyNumber);
  return {
    policyName: cleanName || productType || (policyNumber ? `תוכנית ${policyNumber}` : 'תוכנית'),
    policyNumber: policyNumber || null,
    productType,
    balance,
    investmentTrack: investmentTrack || null,
    depositFeePercent,
    accumulationFeePercent,
    annualYieldPercent,
  };
}

function pushPolicy(found, seen, policy) {
  if (!policy) return;
  const key = `${policy.policyNumber || ''}|${policy.policyName}|${policy.balance}`;
  if (seen.has(key)) return;
  seen.add(key);
  found.push(policy);
}

function flattenTopicRows(topicsList) {
  const rows = [];
  if (!topicsList) return rows;
  if (Array.isArray(topicsList)) {
    for (const item of topicsList) {
      if (item && typeof item === 'object') rows.push(item);
    }
    return rows;
  }
  if (typeof topicsList === 'object') {
    for (const value of Object.values(topicsList)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object') rows.push(item);
        }
      } else if (value && typeof value === 'object') {
        rows.push(value);
      }
    }
  }
  return rows;
}

function onlineBalancesByTopic(onlineData) {
  const map = new Map();
  if (!onlineData || typeof onlineData !== 'object') return map;
  for (const [key, value] of Object.entries(onlineData)) {
    const amount = asNumber(value);
    if (amount === null) continue;
    map.set(String(key), amount);
  }
  return map;
}

/**
 * client-view splits metadata and money:
 * - customer-products.topicsList → names / xtopicId
 * - online-data → { "[xtopicId]": "151,434" }
 */
export function policiesFromHarelClientView(productsData, onlineData) {
  const balances = onlineBalancesByTopic(onlineData);
  const topics = flattenTopicRows(productsData?.topicsList);
  const found = [];
  const seen = new Set();

  for (const topic of topics) {
    const xtopicId = topic.xtopicId ?? topic.xTopicId ?? topic.topicId;
    const balance = balances.has(String(xtopicId)) ? balances.get(String(xtopicId)) : null;
    if (balance === null) continue;

    const sectionName = String(topic.sectionName || '').trim();
    const productType = classifyProductType(
      topic.xTopicName || topic.topicName || topic.sectionName || '',
    );
    // Keep savings products; skip pure insurance tiles even if a number exists.
    if (sectionName && !/חסכון|פנסיה|גמל|השתלמות|saving|pension|fund/i.test(sectionName)) {
      if (!/פנסיה|גמל|השתלמות|חיסכון/i.test(`${topic.xTopicName || ''} ${topic.topicName || ''}`)) {
        continue;
      }
    }

    const base = policyFromRecord({
      policyName: topic.xTopicName || topic.topicName || productType,
      productType: productType || sectionName || 'חיסכון',
      policyNumber: topic.policySubjectId || topic.topicId || xtopicId,
      balance,
      investmentTrack: null,
    });
    if (!base) continue;
    const detailPath = String(topic.url || '').trim();
    const detailUrl = detailPath
      ? detailPath.startsWith('http')
        ? detailPath
        : `https://www.harel-group.co.il${detailPath.startsWith('/') ? '' : '/'}${detailPath}`
      : null;
    pushPolicy(found, seen, {
      ...base,
      xtopicId: xtopicId != null ? String(xtopicId) : null,
      policySubjectId:
        topic.policySubjectId != null ? String(topic.policySubjectId) : null,
      lobby: Boolean(topic.lobby),
      detailUrl,
    });
  }

  // Fallback: if topics missing but online-data has amounts, expose raw totals.
  if (found.length === 0 && balances.size > 0) {
    for (const [id, balance] of balances.entries()) {
      pushPolicy(
        found,
        seen,
        policyFromRecord({
          policyName: `תוכנית ${id}`,
          productType: 'חיסכון',
          policyNumber: id,
          balance,
        }),
      );
    }
  }
  return found;
}

function policiesFromPayloads(payloads) {
  const found = [];
  const seen = new Set();
  const list = payloads || [];

  const productsPayload = list.find((row) => /customer-products/i.test(row?.url || ''));
  const onlinePayload = list.find((row) => /online-data/i.test(row?.url || ''));
  if (productsPayload || onlinePayload) {
    for (const policy of policiesFromHarelClientView(productsPayload?.data, onlinePayload?.data)) {
      pushPolicy(found, seen, policy);
    }
  }

  for (const payload of list) {
    const url = String(payload?.url || '');
    const data = payload?.data ?? payload;
    if (/customer-products|online-data/i.test(url)) continue;
    walk(data, (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      pushPolicy(found, seen, policyFromRecord(node));
    });
  }
  return found;
}

function portfolioFromPolicies(policies) {
  const list = (policies || [])
    .filter((policy) => policy && policy.balance !== null && policy.balance !== undefined)
    .map((policy) => ({
      ...policy,
      provider: policy.provider || PROVIDER_LABEL,
      isActive: policy.isActive ?? null,
      activityLabel: policy.activityLabel || null,
    }));
  let total = 0;
  for (const policy of list) total += Number(policy.balance) || 0;
  return {
    provider: PROVIDER_LABEL,
    totalPensionBalance: list.length ? total : null,
    policies: list,
  };
}

async function dumpPayloadSummary(payloads, label) {
  try {
    await mkdir(RUNS_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const summary = (payloads || []).map((row) => ({
      url: row.url,
      keys:
        row.data && typeof row.data === 'object' && !Array.isArray(row.data)
          ? Object.keys(row.data).slice(0, 40)
          : Array.isArray(row.data)
            ? [`array:${row.data.length}`]
            : [typeof row.data],
    }));
    const file = path.join(RUNS_ROOT, `harel-payloads-${label}-${stamp}.json`);
    await writeFile(file, JSON.stringify(summary, null, 2), 'utf8');

    // Persist full customer-products / online-data bodies for parser tuning.
    const rich = (payloads || []).filter((row) => {
      const url = row.url || '';
      if (/customer-products|online-data|policiesList|pension|study-fund|gemel|hishtal/i.test(url)) {
        return true;
      }
      const blob = JSON.stringify(row.data || {}).slice(0, 4000);
      return /דמי ניהול|מסלול|תשואה|managementFee|depositFee|accumulationFee|investmentTrack|yield/i.test(
        blob,
      );
    });
    if (rich.length) {
      const richFile = path.join(RUNS_ROOT, `harel-rich-${label}-${stamp}.json`);
      await writeFile(richFile, JSON.stringify(rich, null, 2), 'utf8');
      console.info(`harel rich dump ${richFile} count=${rich.length}`);
    }
    console.info(`harel payloads dump ${file} count=${summary.length}`);
  } catch (error) {
    console.info(`harel payload dump failed ${String(error.message || '').slice(0, 80)}`);
  }
}

async function dismissBlockingModals(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"], a')];
      const target = buttons.find((button) => {
        const label = `${button.innerText || ''} ${button.getAttribute('aria-label') || ''}`
          .replace(/\s+/g, ' ')
          .trim();
        return /הבנתי,?\s*תודה|ראיתי,?\s*תודה|עדכון מדיניות הפרטיות|אני מסכים|הסכמ|אישור קוקי|קבלת? cookies|Accept all/i.test(
          label,
        );
      });
      if (!target) return null;
      target.click();
      return (target.innerText || '').trim().slice(0, 60);
    });
    if (!clicked) break;
    console.info(`harel dismissed modal ${clicked}`);
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  await page
    .evaluate(() => {
      const buttons = [...document.querySelectorAll('button, [role="button"], a')];
      for (const button of buttons) {
        const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`.trim();
        if (/שימוש בקבצי Cookies/i.test(document.body?.innerText || '') && (/^×$|^x$/i.test(label) || /סגור/.test(label))) {
          try {
            button.click();
          } catch {
            /* ignore */
          }
        }
      }
    })
    .catch(() => {});
}

const CLIENT_VIEW_URL = 'https://www.harel-group.co.il/personal-info/my-harel/Pages/client-view.aspx';

function authSucceeded(payloads) {
  for (const row of payloads || []) {
    const url = String(row.url || '');
    const data = row.data;
    if (!data || typeof data !== 'object') continue;
    if (/SCValidateOTP/i.test(url) && Number(data.Status) === 0) return true;
    if (/GetCurrentDetails/i.test(url) && data?.Details?.current) return true;
    if (/GetCurrentDetails/i.test(url) && data?.Details?.CurrentUserDetails) return true;
  }
  return false;
}

async function dumpAuthPayloads(payloads, label) {
  try {
    await mkdir(RUNS_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const auth = (payloads || []).filter((row) =>
      /PostAuthenticate|SCValidateOTP|CreateOTP|GetCurrentDetails|StartProcess/i.test(row.url || ''),
    );
    const file = path.join(RUNS_ROOT, `harel-auth-${label}-${stamp}.json`);
    await writeFile(file, JSON.stringify(auth, null, 2), 'utf8');
    console.info(`harel auth dump ${file} count=${auth.length}`);
  } catch (error) {
    console.info(`harel auth dump failed ${String(error.message || '').slice(0, 80)}`);
  }
}

async function waitForAuthenticatedSession(page, payloads) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/personal-info|client-view|my-harel/i.test(url) && !/login-Page|Login\.aspx/i.test(url)) {
      console.info(`harel authenticated via url ${url}`);
      return true;
    }
    if (authSucceeded(payloads)) {
      console.info('harel authenticated via API payload');
      return true;
    }
    const loggedInCta = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      return /להראל שלי|התנתק|המוצרים שלי|אזור אישי שלי/.test(text);
    }).catch(() => false);
    if (loggedInCta) {
      console.info('harel authenticated via dashboard CTA text');
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function openClientView(page) {
  // Prefer in-page CTA once the header shows the logged-in menu.
  const clicked =
    (await clickByText(page, ['להראל שלי', 'לכל המוצרים שלי', 'המוצרים שלי'])) || null;
  if (clicked) {
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30000 }).catch(() => {});
    return page.url();
  }
  console.info(`harel goto client-view ${CLIENT_VIEW_URL}`);
  await page.goto(CLIENT_VIEW_URL, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30000 }).catch(() => {});
  return page.url();
}

function hasSavingsPayloads(payloads) {
  return (payloads || []).some((row) => /customer-products|online-data/i.test(row?.url || ''));
}

async function clientViewBroken(page) {
  const text = await collectPageText(page);
  if (/לא ניתן להציג דף זה/.test(text)) return true;
  if (/שגיאה/.test(text) && /מוקד שר(?:ו|וּ)?ת לקוחות|צור קשר/.test(text)) return true;
  return false;
}

async function waitForSavingsPayloads(payloads, pending, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  const before = payloads.length;
  while (Date.now() < deadline) {
    if (hasSavingsPayloads(payloads)) return true;
    await waitForPayloadSettled(payloads, pending, before, 1200);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return hasSavingsPayloads(payloads);
}

const STUDY_FUND_LOBBY_URL =
  'https://www.harel-group.co.il/personal-info/study-funds/Pages/lobby-study-funds.aspx';
const GEMEL_LOBBY_URL =
  'https://www.harel-group.co.il/personal-info/gemel-funding/Pages/lobby-gemel-funding.aspx';
const PENSION_FALLBACK_URL =
  'https://www.harel-group.co.il/personal-info/pension/Pages/reports/pension-fund.aspx?FilterParams=policySubjectId|2';
const FALLBACK_SAVINGS_URLS = [STUDY_FUND_LOBBY_URL, PENSION_FALLBACK_URL, GEMEL_LOBBY_URL];

function gemelDetailUrls(account) {
  return [
    `https://www.harel-group.co.il/personal-info/gemel-funding/Pages/reports/gemel-funding-policy-details.aspx?FilterParams=policySubjectId|${account}`,
    `https://www.harel-group.co.il/personal-info/gemel-funding/Pages/reports/gemel-funding-policy-details.aspx?FilterParams=policySubjectId|${account}~HCUN|-999`,
  ];
}

function isGemelPolicy(policy, href = '') {
  const blob = `${policy?.productType || ''} ${policy?.policyName || ''} ${href || policy?.detailUrl || ''}`;
  return /גמל|gemel-funding|gemel funding/i.test(blob);
}

function isStudyFundPolicy(policy, href = '') {
  if (isGemelPolicy(policy, href)) return false;
  const blob = `${policy?.productType || ''} ${policy?.policyName || ''} ${href || policy?.detailUrl || ''}`;
  return /השתלמות|study-fund/i.test(blob) || Boolean(policy?.lobby);
}

async function ensureClientViewData(page, payloads, pending) {
  await dismissBlockingModals(page);
  await clickByText(page, ['ראיתי, תודה', 'אני מסכים', 'הבנתי', 'סגור']).catch(() => {});

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (hasSavingsPayloads(payloads)) {
      console.info(`harel savings payloads ready attempt=${attempt}`);
      return true;
    }

    const broken = await clientViewBroken(page);
    console.info(
      `harel client-view attempt=${attempt} broken=${broken} url=${page.url()} payloads=${payloads.length}`,
    );

    if (broken || attempt > 1) {
      console.info('harel reloading client-view after empty/error state');
      await page.goto(CLIENT_VIEW_URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
      await dismissBlockingModals(page);
      await clickByText(page, ['ראיתי, תודה', 'אני מסכים', 'הבנתי', 'סגור']).catch(() => {});
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
    }

    if (await waitForSavingsPayloads(payloads, pending, 18000)) return true;

    await clickByText(page, ['הראל שלי', 'להראל שלי', 'המוצרים שלי']).catch(() => {});
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 20000 }).catch(() => {});
  }

  return hasSavingsPayloads(payloads);
}

function policiesFromSavingsText(text) {
  const found = [];
  const seen = new Set();
  const blob = String(text || '').replace(/\s+/g, ' ');
  const patterns = [
    { re: /קרן הפנסיה שלי[^₪]{0,80}₪\s*([\d,]+(?:\.\d+)?)/, name: 'קרנות פנסיה', type: 'פנסיה' },
    { re: /סה["”]?כ צבירה[^₪]{0,40}₪\s*([\d,]+(?:\.\d+)?)/, name: 'השתלמות', type: 'השתלמות' },
    { re: /השתלמות[^₪]{0,80}₪\s*([\d,]+(?:\.\d+)?)/, name: 'השתלמות', type: 'השתלמות' },
  ];
  for (const pattern of patterns) {
    const match = blob.match(pattern.re);
    if (!match) continue;
    pushPolicy(
      found,
      seen,
      policyFromRecord({
        policyName: pattern.name,
        productType: pattern.type,
        balance: match[1],
      }),
    );
  }
  return found;
}

async function harvestFromFallbackPages(page, payloads, pending) {
  const found = [];
  const seen = new Set();
  for (const href of FALLBACK_SAVINGS_URLS) {
    try {
      console.info(`harel fallback navigate ${href}`);
      const before = payloads.length;
      await page.goto(href, { waitUntil: 'networkidle2', timeout: 90000 });
      await dismissBlockingModals(page);
      await clickByText(page, ['ראיתי, תודה', 'אני מסכים', 'הבנתי', 'סגור']).catch(() => {});
      await waitForPayloadSettled(payloads, pending, before, 10000);
      await new Promise((resolve) => setTimeout(resolve, 2000));

      for (const policy of policiesFromPayloads(payloads)) pushPolicy(found, seen, policy);
      for (const policy of await extractPoliciesFromDom(page)) pushPolicy(found, seen, policy);
      for (const policy of policiesFromSavingsText(await collectPageText(page))) {
        pushPolicy(found, seen, policy);
      }
    } catch (error) {
      console.info(`harel fallback failed ${href} ${String(error.message || '').slice(0, 100)}`);
    }
  }
  return found;
}

function detailsFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const investmentTrack = String(
    pick(record, [
      'investmentTrack',
      'trackName',
      'routeName',
      'investmentPath',
      'fundTrack',
      'channelName',
      'maslul',
      'מסלולהשקעה',
      'מסלול',
    ]) || '',
  ).trim();
  const depositFeePercent = asNumber(
    pick(record, [
      'depositFeePercent',
      'depositFee',
      'managementFeeDeposit',
      'feeFromDeposit',
      'depositManagementFee',
      'mgmtFeeDeposit',
      'dmeiNihulHafkada',
      'דמיניהולמהפקדה',
      'מהפקדה',
    ]),
  );
  const accumulationFeePercent = asNumber(
    pick(record, [
      'accumulationFeePercent',
      'accumulationFee',
      'managementFeeAccumulation',
      'feeFromAccumulation',
      'accumulationManagementFee',
      'mgmtFeeAccumulation',
      'dmeiNihulTzvira',
      'דמיניהולמצבירה',
      'מצבירה',
    ]),
  );
  const annualYieldPercent = asNumber(
    pick(record, [
      'annualYieldPercent',
      'annualYield',
      'yieldPercent',
      'yearlyReturn',
      'yearYield',
      'yieldYtd',
      'yield12m',
      'תשואהשנתית',
      'תשואה',
    ]),
  );
  if (
    !investmentTrack &&
    depositFeePercent === null &&
    accumulationFeePercent === null &&
    annualYieldPercent === null
  ) {
    return null;
  }
  return {
    investmentTrack: investmentTrack || null,
    depositFeePercent,
    accumulationFeePercent,
    annualYieldPercent,
  };
}

function detailsFromPayloads(payloads) {
  const found = [];
  for (const payload of payloads || []) {
    walk(payload?.data ?? payload, (node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const details = detailsFromRecord(node);
      if (details) found.push({ ...details, raw: node });
    });
  }
  return found;
}

function parseDetailsFromText(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return {
      investmentTrack: null,
      depositFeePercent: null,
      accumulationFeePercent: null,
      annualYieldPercent: null,
      hasSavingsWords: false,
      snippet: '',
    };
  }

  const acceptPercent = (raw, max) => {
    if (raw == null) return null;
    const normalized = String(raw).replace(',', '.');
    const num = Number(normalized);
    // Management fees / yields on these pages are small percentages, not 100% weights.
    if (!Number.isFinite(num) || num < 0 || num > max) return null;
    return normalized;
  };

  const pickPercent = (labels, { max = 10 } = {}) => {
    for (const label of labels) {
      const afterTight = text.match(
        new RegExp(`${label}\\s*[:\\-]?\\s*(\\d+(?:[\\.,]\\d+)?)\\s*%`),
      );
      const afterHit = acceptPercent(afterTight?.[1], max);
      if (afterHit != null) return afterHit;
      const beforeTight = text.match(
        new RegExp(`(\\d+(?:[\\.,]\\d+)?)\\s*%\\s*(?:שיעור\\s+)?${label}`),
      );
      const beforeHit = acceptPercent(beforeTight?.[1], max);
      if (beforeHit != null) return beforeHit;
    }
    return null;
  };

  // Parse fee chips with both LTR and RTL layouts, then keep the richer parse.
  const buildFeeMap = (pairs) => {
    const map = { deposit: null, accumulation: null };
    for (const [kind, raw] of pairs) {
      const isDeposit = /הפקדה/.test(kind || '');
      const hit = acceptPercent(raw, isDeposit ? 6 : 3);
      if (hit == null) continue;
      if (isDeposit && map.deposit == null) map.deposit = hit;
      if (!isDeposit && map.accumulation == null) map.accumulation = hit;
    }
    return map;
  };
  const ltrPairs = [...text.matchAll(
    /(?:שיעור\s+)?דמי\s*ניהול\s*(מהפקדה|מהפקדות|מצבירה|מהצבירה|מן הצבירה|מן ההפקדה)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)\s*%/g,
  )].map((match) => [match[1], match[2]]);
  const rtlPairs = [...text.matchAll(
    /(\d+(?:[.,]\d+)?)\s*%\s*(?:שיעור\s+)?דמי\s*ניהול\s*(מהפקדה|מהפקדות|מצבירה|מהצבירה|מן הצבירה|מן ההפקדה)/g,
  )].map((match) => [match[2], match[1]]);
  const ltrFees = buildFeeMap(ltrPairs);
  const rtlFees = buildFeeMap(rtlPairs);
  const feeScore = (map) => Number(map.deposit != null) + Number(map.accumulation != null);
  let feeMap = feeScore(rtlFees) > feeScore(ltrFees) ? rtlFees : ltrFees;
  // Study-fund dashboard: header row then value row
  // "דמי ניהול מצבירה  דמי ניהול מהפקדות  0.21%  0.00%"
  if (feeMap.deposit == null || feeMap.accumulation == null) {
    const table = text.match(
      /דמי\s*ניהול\s*מצבירה\s+דמי\s*ניהול\s*מהפקדות\s+(\d+(?:[.,]\d+)?)\s*%\s+(\d+(?:[.,]\d+)?)\s*%/,
    );
    if (table) {
      feeMap = {
        accumulation: feeMap.accumulation ?? acceptPercent(table[1], 3),
        deposit: feeMap.deposit ?? acceptPercent(table[2], 6),
      };
    }
  }
  if (feeMap.deposit == null || feeMap.accumulation == null) {
    const tableRtl = text.match(
      /דמי\s*ניהול\s*מהפקדות\s+דמי\s*ניהול\s*מצבירה\s+(\d+(?:[.,]\d+)?)\s*%\s+(\d+(?:[.,]\d+)?)\s*%/,
    );
    if (tableRtl) {
      feeMap = {
        deposit: feeMap.deposit ?? acceptPercent(tableRtl[1], 6),
        accumulation: feeMap.accumulation ?? acceptPercent(tableRtl[2], 3),
      };
    }
  }
  // Study-fund pages sometimes only show a generic management-fee percent.
  if (feeMap.deposit == null && feeMap.accumulation == null) {
    const generic = text.match(
      /(?:שיעור\s+)?דמי\s*ניהול(?:\s*שנתי(?:ים)?)?\s*[:\-]?\s*(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*(?:שיעור\s+)?דמי\s*ניהול/,
    );
    const hit = acceptPercent(generic?.[1] || generic?.[2], 3);
    if (hit != null) feeMap = { deposit: null, accumulation: hit };
  }

  const cleanTrack = (value) => {
    let track = String(value || '')
      .replace(/^[:\-–\s]+/, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*מסלול ההפקדה\s*$/g, '')
      .trim();
    // Drop trailing balances / weights accidentally glued on (e.g. "הלכה 17,964.18 0.33").
    track = track
      .replace(/(?:\s+[\d,]+(?:\.\d+)?)+$/g, '')
      .replace(/\s+[\d,]+(?:\.\d+)?\s*%?$/g, '')
      .trim();
    if (!track) return null;
    if (/^\d+([.,]\d+)?$/.test(track)) return null;
    if (/^(דמי|תשואה|יתרה|מסלול|שיעור|סה|פעיל)/.test(track)) return null;
    if (/%|₪/.test(track)) return null;
    if (/\d/.test(track) && !/S\s*&\s*P|500|מדד/i.test(track)) return null;
    return track.slice(0, 80);
  };

  const pickTrack = () => {
    const TRACK_NAME =
      'השתלמות\\s+כללי|S\\s*&\\s*P\\s*500(?:\\s*עוקב מדד)?|(?:אג["״”\']?ח|מניות)\\s*S\\s*&\\s*P(?:\\s*500)?(?:\\s*(?:עוקב|מחקה)\\s*מדד)?|הלכה|כללי|מניות|כספי(?:\\s*\\(?שקלי\\)?)?|אשראי(?:\\s*ואג["״”\']?ח)?|קיימות|משולב\\s*סחיר';

    // Prefer tracks glued to a balance in the allocation table
    // e.g. "הלכה 17,964.18 0.33" / "השתלמות כללי 40,899.44".
    const allocated = [];
    const allocRe = new RegExp(`(${TRACK_NAME})\\s*₪?\\s*([\\d,]+(?:\\.\\d+)?)`, 'gi');
    for (const match of text.matchAll(allocRe)) {
      const name = cleanTrack(match[1]);
      const amount = Number(String(match[2] || '').replace(/,/g, ''));
      if (name && Number.isFinite(amount)) allocated.push({ name, amount });
    }
    if (allocated.length) {
      allocated.sort((a, b) => b.amount - a.amount);
      return allocated[0].name;
    }

    // Dashboard table header context
    const tableTrack = text.match(
      new RegExp(
        `(?:מסלול השקעה\\s+צבירה|התפלגות מסלולים|מסלולי השקעה)[^\\d]{0,80}((?:${TRACK_NAME})[^₪%]{0,40})`,
        'i',
      ),
    );
    const fromTable = cleanTrack(tableTrack?.[1]);
    if (fromTable) return fromTable;

    const sp = text.match(/(S\s*&\s*P\s*500(?:\s*עוקב מדד)?|(?:אג["״”']?ח|מניות)\s*S\s*&\s*P(?:\s*500)?(?:\s*(?:עוקב|מחקה)\s*מדד)?)/i);
    const fromSp = cleanTrack(sp?.[1]);
    if (fromSp) return fromSp;

    const chip = text.match(
      /((?:אג["״”']?ח|מניות|כללי|כספי|הלכה|אשראי|השתלמות)[^%]{0,50}?(?:S\s*&\s*P(?:\s*500)?|מחקה מדד|עוקב מדד|מדדי? מניות|מדד|כללי)[^0-9%]{0,25})/i,
    );
    const fromChip = cleanTrack(chip?.[1]);
    if (fromChip) return fromChip;

    for (const label of ['מסלול ההפקדה', 'מסלול ההשקעה', 'מסלול השקעה', 'Investment track']) {
      const after = text.match(
        new RegExp(`${label}\\s*[:\\-]?\\s*((?:${TRACK_NAME})|[^%₪\\d]{2,60}?)(?:\\s+[\\d,]+|\\s+\\d+(?:[\\.,]\\d+)?\\s*%|$)`, 'i'),
      );
      const cleaned = cleanTrack(after?.[1]);
      if (cleaned) return cleaned;
    }

    // Last resort: labeled bare named track.
    const named = text.match(
      new RegExp(`מסלול(?:\\s+השקעה|\\s+ההשקעה|\\s+ההפקדה)?\\s*[:\\-]?\\s*(${TRACK_NAME})`, 'i'),
    );
    return cleanTrack(named?.[1]);
  };

  const pickYield = () => {
    // "תשואת מסלול/י השקעה מתחילת שנה ... S&P 500 עוקב מדד 9.26%"
    const section = text.match(
      /תשואת?\s*מסלול\/?י?\s*השקעה\s*מתחילת\s*שנה[\s\S]{0,200}?(\d+(?:[.,]\d+)?)\s*%/,
    );
    const fromSection = acceptPercent(section?.[1], 80);
    if (fromSection != null && Number(fromSection) >= 0.5) return fromSection;

    const labeled = pickPercent(
      [
        'תשואה שנתית',
        'תשואה מתחילת השנה',
        'תשואה מתחילת שנה',
        'תשואה מצטברת ל-12',
        'תשואה ל-12 חודשים',
        'תשואה ב-12 חודשים',
        'תשואה מצטברת',
        'תשואה מסלול השקעה מתחילת שנה',
        'תשואת מסלולי השקעה מתחילת שנה',
        'תשואת מסלול\\/י השקעה מתחילת שנה',
      ],
      { max: 80 },
    );
    if (labeled != null && Number(labeled) >= 0.5) return labeled;
    return labeled;
  };

  const statusMatch =
    text.match(/סטטוס\s*:?\s*([^\n\t|]+?)(?=\s*(?:מספר|מין|תאריך|ותק|מעמד|בעל|סוכן|$))/i) ||
    text.match(/סטטוס\s*:?\s*(פעיל(?:\s+רגיל)?|לא\s*פעיל|מבוטל[ת]?|סגור)/i);
  const activity = normalizeActivityStatus(statusMatch?.[1] || null);

  // Recent deposits live in the "תנועות אחרונות" table (not birth/start dates).
  const txChunk =
    text.match(/סכום ההפקדה\s+(.+?)\s+(?:לדוח המלא|מוטבים|ריכוז תנועות)/i)?.[1] || '';
  const depositDates = [...txChunk.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)].map((match) => {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    return {
      sort: year * 10_000 + month * 100 + day,
      iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    };
  });
  depositDates.sort((a, b) => a.sort - b.sort);
  const lastDepositAt = depositDates.length ? depositDates[depositDates.length - 1].iso : null;
  const ytdRaw = text.match(/כספים שהופקדו לחשבון השנה\s*₪?\s*([\d,]+(?:\.\d+)?)/i)?.[1];
  const ytdDepositAmount = ytdRaw ? Number(String(ytdRaw).replace(/,/g, '')) : null;
  const contribution = contributionFromDeposits({ lastDepositAt, ytdDepositAmount });

  return {
    investmentTrack: pickTrack(),
    depositFeePercent: feeMap.deposit,
    accumulationFeePercent: feeMap.accumulation,
    annualYieldPercent: pickYield(),
    isActive: activity.isActive,
    activityLabel: activity.activityLabel,
    lastDepositAt: contribution.lastDepositAt,
    ytdDepositAmount: contribution.ytdDepositAmount,
    receivingDeposits: contribution.receivingDeposits,
    contributionLabel: contribution.contributionLabel,
    hasSavingsWords: /(מסלול|דמי ניהול|שיעור דמי|תשואה|פנסיה|השתלמות|גמל)/.test(text),
    snippet: text.slice(0, 700),
  };
}

async function collectDeepFrameText(frame) {
  return frame
    .evaluate(() => {
      const chunks = [];
      const visit = (root) => {
        if (!root) return;
        try {
          if (root.innerText) chunks.push(root.innerText);
        } catch {
          /* ignore */
        }
        const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const node of nodes) {
          if (node.shadowRoot) visit(node.shadowRoot);
        }
      };
      visit(document.body || document.documentElement);
      return chunks.join('\n');
    })
    .catch(() => '');
}

async function collectPageText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await collectDeepFrameText(frame);
    if (text && text.trim()) {
      parts.push(`--frame:${frame.url()}--\n${text}`);
    }
  }
  return parts.join('\n');
}

async function waitForDetailsText(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = await collectPageText(page);
    if (
      /שיעור דמי ניהול|דמי ניהול מהפקדה|דמי ניהול מצבירה|דמי ניהול|מסלול השקעה|מסלול ההפקדה|תשואת?\s*מסלול|התפלגות מסלולים|מסלול השקעה\s+צבירה/.test(
        last,
      )
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return last;
}

async function extractDetailsFromDom(page) {
  const text = await waitForDetailsText(page, 18000);
  const parsed = parseDetailsFromText(text);
  console.info(
    `harel dom-details track=${parsed.investmentTrack || '—'} deposit=${parsed.depositFeePercent || '—'} accum=${parsed.accumulationFeePercent || '—'} yield=${parsed.annualYieldPercent || '—'} textLen=${text.length} snippet=${parsed.snippet.slice(0, 160)}`,
  );
  return parsed;
}

function preferTrackName(current, next) {
  const score = (value) => {
    const text = String(value || '').trim();
    if (!text) return -1;
    let points = text.length > 1 ? 5 : 0;
    if (/השתלמות\s+כללי|הלכה|כללי|מניות|S\s*&\s*P|עוקב מדד|כספי|אשראי/i.test(text)) points += 8;
    if (/\d/.test(text) && !/S\s*&\s*P|500/i.test(text)) points -= 10;
    if (/₪|,/.test(text)) points -= 8;
    return points;
  };
  return score(next) > score(current) ? next : current || next || null;
}

function mergeDetails(policy, details) {
  if (!policy || !details) return policy;
  return {
    ...policy,
    investmentTrack: preferTrackName(policy.investmentTrack, details.investmentTrack),
    depositFeePercent:
      policy.depositFeePercent ?? details.depositFeePercent ?? null,
    accumulationFeePercent:
      policy.accumulationFeePercent ?? details.accumulationFeePercent ?? null,
    annualYieldPercent: policy.annualYieldPercent ?? details.annualYieldPercent ?? null,
    isActive: details.isActive != null ? details.isActive : policy.isActive ?? null,
    activityLabel: details.activityLabel || policy.activityLabel || null,
    lastDepositAt: details.lastDepositAt || policy.lastDepositAt || null,
    ytdDepositAmount:
      details.ytdDepositAmount != null ? details.ytdDepositAmount : policy.ytdDepositAmount ?? null,
    receivingDeposits:
      details.receivingDeposits != null
        ? details.receivingDeposits
        : policy.receivingDeposits ?? null,
    contributionLabel: details.contributionLabel || policy.contributionLabel || null,
  };
}

function publicPolicy(policy) {
  if (!policy) return policy;
  const {
    detailUrl: _detailUrl,
    xtopicId: _xtopicId,
    policySubjectId: _policySubjectId,
    lobby: _lobby,
    ...rest
  } = policy;
  return rest;
}

function detailsMissing(policy) {
  return (
    !policy?.investmentTrack ||
    policy.depositFeePercent == null ||
    policy.accumulationFeePercent == null ||
    policy.annualYieldPercent == null
  );
}

async function waitForPayloadSettled(payloads, pending, beforeCount, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let stableSince = Date.now();
  let lastCount = payloads.length;
  while (Date.now() < deadline) {
    if (pending.size === 0 && payloads.length > beforeCount) {
      if (payloads.length === lastCount) {
        if (Date.now() - stableSince > 700) return;
      } else {
        lastCount = payloads.length;
        stableSince = Date.now();
      }
    } else if (pending.size === 0 && payloads.length === beforeCount) {
      // No new JSON yet — keep waiting a bit for late XHRs.
      if (Date.now() - stableSince > 2500) return;
    } else {
      lastCount = payloads.length;
      stableSince = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function dashboardFrames(page) {
  return page.frames().filter((frame) => /Dashboard|_sp_dashboard|OAOAnalysis/i.test(frame.url()));
}

async function waitForDashboardFrame(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = dashboardFrames(page);
    if (frames.length) return frames[0];
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return dashboardFrames(page)[0] || null;
}

async function clickStudyFundLobbyAction(page, preferredAction = 'עדכון מסלול') {
  const frame = await waitForDashboardFrame(page, 20000);
  if (!frame) {
    console.info('harel study-fund dashboard iframe missing');
    return null;
  }

  const clicked = await frame
    .evaluate((action) => {
      const cards = [];
      for (const node of document.querySelectorAll('div, section, article, li, tr, td, table')) {
        const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (text.length < 20 || text.length > 700) continue;
        const accountMatch = text.match(/מספר חשבון\s*:?\s*(\d{5,})/);
        if (!accountMatch) continue;
        if (!/הראל קרן השתלמות|השתלמות|צבירה/.test(text)) continue;
        const balanceMatch =
          text.match(/₪\s*([\d,]+(?:\.\d+)?)/) || text.match(/([\d,]+(?:\.\d+)?)\s*₪/);
        const balance = balanceMatch ? Number(String(balanceMatch[1]).replace(/,/g, '')) : 0;
        cards.push({
          account: accountMatch[1],
          balance: Number.isFinite(balance) ? balance : 0,
          textLen: text.length,
          node,
        });
      }
      // Prefer the smallest node per account (the actual card, not a page wrapper).
      cards.sort((a, b) => a.textLen - b.textLen);
      const byAccount = new Map();
      for (const card of cards) {
        const prev = byAccount.get(card.account);
        // Keep the richest card (has balance), not the tiny label-only node.
        if (!prev || card.balance > prev.balance || (card.balance === prev.balance && card.textLen > prev.textLen)) {
          byAccount.set(card.account, card);
        }
      }
      const unique = [...byAccount.values()].sort((a, b) => b.balance - a.balance);
      if (!unique.length) return null;

      const card = unique[0];
      const actionNode = [...card.node.querySelectorAll('a, button, [role="button"], span, div')]
        .find((el) => {
          const label = (el.innerText || '').replace(/\s+/g, ' ').trim();
          return label === action || label.includes(action);
        });
      if (actionNode) {
        actionNode.click();
        return {
          account: card.account,
          balance: card.balance,
          action,
        };
      }

      const anyLink = card.node.querySelector('a, button, [role="button"]');
      if (anyLink) {
        anyLink.click();
        return {
          account: card.account,
          balance: card.balance,
          action: (anyLink.innerText || '').trim().slice(0, 40) || 'link',
        };
      }
      card.node.click();
      return { account: card.account, balance: card.balance, action: 'card' };
    }, preferredAction)
    .catch((error) => {
      console.info(`harel study-fund click failed ${String(error.message || '').slice(0, 80)}`);
      return null;
    });

  if (!clicked) return null;
  console.info(
    `harel study-fund click account=${clicked.account} balance=${clicked.balance} action=${clicked.action}`,
  );
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 25000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await dismissBlockingModals(page);
  return clicked;
}

function cleanEmployerName(value) {
  const name = String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\-–\s]+/, '')
    .trim();
  if (!name || name.length < 2) return null;
  if (/^(תאריך|מעמד|שם|מספר|צבירה|סה)/.test(name)) return null;
  return name.slice(0, 80);
}

function employerFromText(text) {
  const blob = String(text || '');
  const labeled =
    blob.match(/מעסיק\s*אחרון\s*:?\s*([^\n\t]+)/) ||
    blob.match(/מעסיק\s*:?\s*([^\n\t]+?)(?=\s*(?:תאריך|מעמד|שם|מספר|צבירה|סה|$))/);
  return cleanEmployerName(labeled?.[1]);
}

function studyFundAccountsFromText(text) {
  const accounts = [];
  const blob = String(text || '');
  const re = /מספר חשבון\s*:?\s*(\d{5,})/g;
  for (const match of blob.matchAll(re)) {
    const account = match[1];
    // Window after the account id; stop at the next account card if present.
    let chunk = blob.slice(match.index + match[0].length, match.index + match[0].length + 400);
    const nextAccount = chunk.search(/מספר חשבון\s*:?\s*\d{5,}/);
    if (nextAccount >= 0) chunk = chunk.slice(0, nextAccount);
    const balanceMatch =
      chunk.match(/צבירה\s*₪?\s*([\d,]+(?:\.\d+)?)/) ||
      chunk.match(/₪\s*([\d,]+(?:\.\d+)?)/) ||
      chunk.match(/([\d,]+(?:\.\d+)?)\s*₪/);
    const balance = balanceMatch ? Number(String(balanceMatch[1]).replace(/,/g, '')) : 0;
    const employerMatch =
      chunk.match(/מעסיק\s*אחרון\s*:?\s*([^\n]+)/) ||
      chunk.match(/מעסיק\s*:?\s*([^\n]+?)(?=\s*(?:סה|תאריך|עדכון|בקשה|מספר)|$)/) ||
      chunk.match(/מעסיק([^\n]{2,60}?)(?=\s*(?:סה["”]?כ|תאריך|עדכון)|$)/);
    accounts.push({
      account,
      balance: Number.isFinite(balance) ? balance : 0,
      employerName: cleanEmployerName(employerMatch?.[1]),
    });
  }
  // Dedupe; keep richest balance per account.
  const byAccount = new Map();
  for (const row of accounts) {
    const prev = byAccount.get(row.account);
    if (!prev || row.balance > prev.balance) byAccount.set(row.account, row);
  }
  return [...byAccount.values()].sort((a, b) => b.balance - a.balance);
}

async function fetchAccountDetailsFromUrls(page, account, hrefs, payloads, pending, logLabel) {
  for (const href of hrefs) {
    try {
      const before = payloads.length;
      console.info(`harel ${logLabel} try url ${href}`);
      const response = await page.goto(href, { waitUntil: 'networkidle2', timeout: 60000 });
      const status = response?.status?.() || 0;
      const landed = page.url();
      if (status >= 400 || /PageNotFound|404|login-Page/i.test(landed)) continue;
      await dismissBlockingModals(page);
      await waitForPayloadSettled(payloads, pending, before, 8000);
      await waitForDashboardFrame(page, 12000);
      const text = await waitForDetailsText(page, 18000);
      if (/לא ניתן להציג דף זה/.test(text)) continue;
      if (!/דמי ניהול|מסלול השקעה|מסלולי השקעה|שיעור דמי|תשואה|הלכה|כללי|מניות|כספי|עלות שנתית|S\s*&\s*P/i.test(text)) {
        continue;
      }
      const parsed = parseDetailsFromText(text);
      // Gemel להשקעה pages expose "שיעור עלות שנתית צפויה" next to the track when
      // explicit management-fee chips are missing — use it as accumulation fee.
      if (parsed.accumulationFeePercent == null) {
        const annualCost = text.match(
          /שיעור\s+עלות\s+שנתית\s+צפויה[\s\S]{0,80}?(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*(?=תנועות|דמי|מוטבים|$)/i,
        );
        const costHit = annualCost?.[1] || annualCost?.[2];
        if (costHit != null) {
          const num = Number(String(costHit).replace(',', '.'));
          if (Number.isFinite(num) && num >= 0 && num <= 3) {
            parsed.accumulationFeePercent = String(costHit).replace(',', '.');
          }
        }
      }
      parsed.employerName = employerFromText(text);
      console.info(
        `harel ${logLabel} policy-details account=${account} employer=${parsed.employerName || '—'} track=${parsed.investmentTrack || '—'} deposit=${parsed.depositFeePercent ?? '—'} accum=${parsed.accumulationFeePercent ?? '—'} yield=${parsed.annualYieldPercent ?? '—'}`,
      );
      return parsed;
    } catch {
      /* try next href */
    }
  }
  return null;
}

async function fetchStudyFundAccountDetails(page, account, payloads, pending) {
  return fetchAccountDetailsFromUrls(
    page,
    account,
    [
      `https://www.harel-group.co.il/personal-info/study-funds/Pages/reports/study-funds-policy-details.aspx?FilterParams=policySubjectId|${account}~HCUN|-999`,
      `https://www.harel-group.co.il/personal-info/study-funds/Pages/reports/study-funds-policy-details.aspx?FilterParams=policySubjectId|${account}`,
    ],
    payloads,
    pending,
    'study-fund',
  );
}

async function fetchGemelAccountDetails(page, account, payloads, pending) {
  return fetchAccountDetailsFromUrls(page, account, gemelDetailUrls(account), payloads, pending, 'gemel');
}

function gemelAccountsFromText(text) {
  const fromNumberLabel = studyFundAccountsFromText(text);
  if (fromNumberLabel.length) return fromNumberLabel;

  // Lobby cards sometimes only show "בחשבון: 159168707" before the balance block.
  const accounts = [];
  const blob = String(text || '');
  const re = /בחשבון\s*:?\s*(\d{5,})/g;
  for (const match of blob.matchAll(re)) {
    const account = match[1];
    let chunk = blob.slice(match.index + match[0].length, match.index + match[0].length + 500);
    const nextAccount = chunk.search(/בחשבון\s*:?\s*\d{5,}|מספר חשבון\s*:?\s*\d{5,}/);
    if (nextAccount >= 0) chunk = chunk.slice(0, nextAccount);
    const balanceMatch =
      chunk.match(/צבירה\s*₪?\s*([\d,]+(?:\.\d+)?)/) ||
      chunk.match(/₪\s*([\d,]+(?:\.\d+)?)/) ||
      chunk.match(/([\d,]+(?:\.\d+)?)\s*₪/);
    const balance = balanceMatch ? Number(String(balanceMatch[1]).replace(/,/g, '')) : 0;
    accounts.push({
      account,
      balance: Number.isFinite(balance) ? balance : 0,
      employerName: null,
    });
  }
  const byAccount = new Map();
  for (const row of accounts) {
    const prev = byAccount.get(row.account);
    if (!prev || row.balance > prev.balance) byAccount.set(row.account, row);
  }
  return [...byAccount.values()].sort((a, b) => b.balance - a.balance);
}

/** Expand one lobby product into one enriched policy per account. */
async function enrichLobbyAccountDetails(page, policy, payloads, pending, { kind, fetchDetails, accountsFromText }) {
  const lobbyText = await collectPageText(page);
  let accounts = accountsFromText(lobbyText);
  if (!accounts.length) {
    const clicked = await clickStudyFundLobbyAction(page, 'עדכון מסלול');
    if (clicked?.account) accounts = [{ account: clicked.account, balance: clicked.balance || 0 }];
  }
  console.info(
    `harel ${kind} accounts=${accounts.map((row) => `${row.account}:${row.balance}`).join(',') || 'none'}`,
  );

  if (!accounts.length) {
    // Already a concrete account row — still try its detail page.
    if (policy.policyNumber && /^\d{5,}$/.test(String(policy.policyNumber))) {
      accounts = [{ account: String(policy.policyNumber), balance: policy.balance || 0 }];
    } else {
      return [policy];
    }
  }

  const expanded = [];
  for (const row of accounts) {
    let next = {
      ...policy,
      productType: policy.productType || (kind === 'gemel' ? 'גמל' : policy.productType),
      provider: policy.provider || PROVIDER_LABEL,
      policyNumber: row.account,
      balance: row.balance || policy.balance,
      employerName: row.employerName || null,
      investmentTrack: null,
      depositFeePercent: null,
      accumulationFeePercent: null,
      annualYieldPercent: null,
    };
    const details = await fetchDetails(page, row.account, payloads, pending);
    if (details) {
      next = mergeDetails(next, details);
      next.employerName = details.employerName || next.employerName || null;
      if (details.investmentTrack) {
        next.investmentTrack = preferTrackName(
          null,
          String(details.investmentTrack)
            .replace(/(?:\s+[\d,]+(?:\.\d+)?)+$/g, '')
            .trim(),
        );
      }
      // Lobby/detail accounts with a live balance and no explicit closed status are open.
      // This is account-open status — contributionLabel (מופקד / ללא הפקדות) is separate.
      if (next.isActive == null && Number(next.balance) > 0.01) {
        next.isActive = true;
        next.activityLabel = 'פעיל';
      }
    } else if (Number(next.balance) > 0.01) {
      next.isActive = true;
      next.activityLabel = 'פעיל';
    }
    expanded.push(next);
  }
  return expanded;
}

async function enrichStudyFundDetails(page, policy, payloads, pending) {
  return enrichLobbyAccountDetails(page, policy, payloads, pending, {
    kind: 'study-fund',
    fetchDetails: fetchStudyFundAccountDetails,
    accountsFromText: studyFundAccountsFromText,
  });
}

async function enrichGemelFundingDetails(page, policy, payloads, pending) {
  return enrichLobbyAccountDetails(page, policy, payloads, pending, {
    kind: 'gemel',
    fetchDetails: fetchGemelAccountDetails,
    accountsFromText: gemelAccountsFromText,
  });
}

async function drillIntoLobbyProduct(page, policy) {
  const url = page.url();
  const looksLobby = /lobby/i.test(url) || policy.lobby;
  if (!looksLobby) return false;
  if (/השתלמות|study-fund/i.test(`${policy.productType || ''} ${policy.policyName || ''} ${url}`)) {
    return Boolean(await clickStudyFundLobbyAction(page, 'עדכון מסלול'));
  }
  return Boolean(await clickStudyFundLobbyAction(page, 'עדכון מסלול'));
}

function applyBestDetails(policy, candidates) {
  if (!candidates?.length) return policy;
  const ranked = [...candidates].sort((a, b) => {
    const score = (row) =>
      Number(Boolean(row.investmentTrack)) +
      Number(row.depositFeePercent != null) +
      Number(row.accumulationFeePercent != null) +
      Number(row.annualYieldPercent != null);
    return score(b) - score(a);
  });
  return mergeDetails(policy, ranked[0]);
}

async function enrichPoliciesFromDetailPages(page, policies, payloads, pending) {
  const enriched = [];
  for (const policy of policies || []) {
    let next = { ...policy };
    const href = policy.detailUrl;
    if (!href) {
      enriched.push(publicPolicy(next));
      continue;
    }

    const beforeCount = payloads.length;
    try {
      console.info(`harel detail ${policy.policyName} ${href}`);
      await page.goto(href, { waitUntil: 'networkidle2', timeout: 90000 });
      await dismissBlockingModals(page);
      await clickByText(page, ['ראיתי, תודה', 'אני מסכים', 'אישור', 'הבנתי', 'סגור']).catch(() => {});
      await dismissBlockingModals(page);
      await page.waitForNetworkIdle({ idleTime: 1200, timeout: 25000 }).catch(() => {});
      await waitForPayloadSettled(payloads, pending, beforeCount, 6000);

      const isGemel = isGemelPolicy(policy, href);
      const isStudyFund = isStudyFundPolicy(policy, href);

      if (isGemel || isStudyFund) {
        const expanded = isGemel
          ? await enrichGemelFundingDetails(page, next, payloads, pending)
          : await enrichStudyFundDetails(page, next, payloads, pending);
        const fresh = payloads.slice(beforeCount);
        await dumpPayloadSummary(fresh, `detail-${policy.productType || 'policy'}`);
        for (const row of expanded) {
          console.info(
            `harel detail result ${row.policyName} #${row.policyNumber || '—'} track=${row.investmentTrack || '—'} deposit=${row.depositFeePercent ?? '—'} accum=${row.accumulationFeePercent ?? '—'} yield=${row.annualYieldPercent ?? '—'} balance=${row.balance ?? '—'}`,
          );
          if (detailsMissing(row)) {
            await dumpDebug(page, `detail-partial-${policy.productType || 'policy'}-${row.policyNumber || 'x'}`).catch(
              () => {},
            );
          }
          enriched.push(publicPolicy(row));
        }
        continue;
      }

      await drillIntoLobbyProduct(page, next);
      await dismissBlockingModals(page);
      await waitForPayloadSettled(payloads, pending, beforeCount, 10000);

      const freshInner = payloads.slice(beforeCount);
      next = applyBestDetails(next, detailsFromPayloads(freshInner));

      if (detailsMissing(next)) {
        const fromDom = await extractDetailsFromDom(page);
        if (fromDom?.hasSavingsWords) {
          next = mergeDetails(next, {
            investmentTrack: fromDom.investmentTrack,
            depositFeePercent: asNumber(fromDom.depositFeePercent),
            accumulationFeePercent: asNumber(fromDom.accumulationFeePercent),
            annualYieldPercent: asNumber(fromDom.annualYieldPercent),
          });
        } else {
          console.info(
            `harel detail page weak content url=${page.url()} snippet=${String(fromDom?.snippet || '').slice(0, 160)}`,
          );
        }
      }

      const fresh = payloads.slice(beforeCount);
      next = applyBestDetails(next, detailsFromPayloads(fresh));

      console.info(
        `harel detail result ${policy.policyName} track=${next.investmentTrack || '—'} deposit=${next.depositFeePercent ?? '—'} accum=${next.accumulationFeePercent ?? '—'} yield=${next.annualYieldPercent ?? '—'} fresh=${fresh.length}`,
      );
      await dumpPayloadSummary(fresh, `detail-${policy.productType || 'policy'}`);
      if (detailsMissing(next)) {
        await dumpDebug(page, `detail-partial-${policy.productType || 'policy'}`).catch(() => {});
      }
    } catch (error) {
      console.info(`harel detail failed ${policy.policyName} ${String(error.message || '').slice(0, 120)}`);
      await dumpDebug(page, `detail-failed-${policy.productType || 'policy'}`).catch(() => {});
    }

    enriched.push(publicPolicy(next));
  }
  return enriched;
}

async function harvestPolicies(page, payloads, pending = new Set()) {
  await dismissBlockingModals(page);
  let policies = policiesFromPayloads(payloads);
  if (policies.length === 0) policies = await extractPoliciesFromDom(page);
  if (policies.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await dismissBlockingModals(page);
    policies = policiesFromPayloads(payloads);
    if (policies.length === 0) policies = await extractPoliciesFromDom(page);
  }

  if (policies.length === 0) {
    console.info('harel harvest empty — trying savings fallback pages');
    for (const policy of await harvestFromFallbackPages(page, payloads, pending)) {
      policies.push(policy);
    }
    if (policies.length === 0) {
      policies = policiesFromPayloads(payloads);
    }
  }

  // Attach detail URLs when we only have DOM balances (no topic metadata).
  policies = policies.map((policy) => {
    if (policy.detailUrl) return policy;
    if (policy.productType === 'השתלמות') {
      return { ...policy, detailUrl: STUDY_FUND_LOBBY_URL, lobby: true };
    }
    if (policy.productType === 'גמל') {
      return { ...policy, detailUrl: GEMEL_LOBBY_URL, lobby: true };
    }
    if (policy.productType === 'פנסיה') {
      return { ...policy, detailUrl: PENSION_FALLBACK_URL, lobby: false };
    }
    return policy;
  });

  if (policies.length > 0) {
    policies = await enrichPoliciesFromDetailPages(page, policies, payloads, pending);
  }
  return portfolioFromPolicies(policies.map(publicPolicy));
}

async function dumpDebug(page, label) {
  try {
    await mkdir(RUNS_ROOT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(RUNS_ROOT, `harel-${label}-${stamp}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    await writeFile(`${base}.html`, html.slice(0, 900_000), 'utf8').catch(() => {});
    const frameText = await collectPageText(page);
    await writeFile(`${base}.txt`, frameText.slice(0, 500_000), 'utf8').catch(() => {});
    console.info(`harel debug ${base} textLen=${frameText.length}`);
  } catch (error) {
    console.info(`harel debug failed ${String(error.message || '').slice(0, 80)}`);
  }
}

/**
 * Harel's header/login panel often reports 0x0 layout boxes in headless Chromium,
 * so we accept any non-hidden input instead of requiring a positive bounding box.
 */
async function firstPresentInContext(context, selector) {
  const handles = await context.$$(selector).catch(() => []);
  for (const handle of handles) {
    const usable = await handle
      .evaluate((el) => {
        if (!el || el.disabled) return false;
        if (el.type === 'hidden') return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
      })
      .catch(() => false);
    if (usable) return handle;
  }
  return null;
}

async function queryDeep(page, selector) {
  // Prefer open shadow roots via pierce, then plain DOM / frames.
  const pierce = await page.$(`pierce/${selector}`).catch(() => null);
  if (pierce) return { handle: pierce, context: page };

  const contexts = [page, ...(page.frames?.() || [])];
  for (const context of contexts) {
    const found = await firstPresentInContext(context, selector);
    if (found) return { handle: found, context };
  }

  // Last resort: walk open shadow roots manually.
  const handle = await page
    .evaluateHandle((sel) => {
      function walk(root, depth = 0) {
        if (!root || depth > 12) return null;
        try {
          const direct = root.querySelector?.(sel);
          if (direct && direct.type !== 'hidden') return direct;
        } catch {
          /* invalid selector in this root */
        }
        const nodes = root.querySelectorAll ? [...root.querySelectorAll('*')] : [];
        for (const el of nodes) {
          if (el.shadowRoot) {
            const hit = walk(el.shadowRoot, depth + 1);
            if (hit) return hit;
          }
        }
        return null;
      }
      return walk(document);
    }, selector)
    .catch(() => null);
  if (handle) {
    const el = handle.asElement?.() || null;
    if (el) return { handle: el, context: page };
  }
  return null;
}

async function firstVisible(page, selector) {
  return queryDeep(page, selector);
}

async function openPersonalAreaPanel(page) {
  const clicked = await clickByText(page, ['כניסה לאזור האישי']);
  if (clicked) return clicked;
  await page
    .evaluate(() => {
      const button = [...document.querySelectorAll('button')].find((node) =>
        (node.innerText || '').includes('כניסה לאזור האישי'),
      );
      button?.click();
    })
    .catch(() => {});
  return 'fallback-click';
}

async function clickByText(page, texts) {
  const needles = texts.map((text) => String(text).toLowerCase());
  const contexts = [page, ...(page.frames?.() || [])];
  for (const context of contexts) {
    const clicked = await context
      .evaluate((wanted) => {
        const nodes = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
        for (const node of nodes) {
          const label = `${node.innerText || ''} ${node.value || ''} ${node.getAttribute('aria-label') || ''}`
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          if (!label) continue;
          if (!wanted.some((needle) => label.includes(needle))) continue;
          const style = window.getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          node.click();
          return label.slice(0, 80);
        }
        return null;
      }, needles)
      .catch(() => null);
    if (clicked) return clicked;
  }
  return null;
}

async function fillInput(page, found, value) {
  if (!found?.handle) return false;
  const text = String(value ?? '');
  // Prefer real keystrokes so React/final-form controlled inputs update and enable המשך.
  await found.handle.focus().catch(() => {});
  await found.handle.click({ clickCount: 3 }).catch(() => {});
  await page.keyboard.down('Control').catch(() => {});
  await page.keyboard.press('KeyA').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await found.handle.type(text, { delay: 35 });
  await found.handle.evaluate((el) => {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }).catch(() => {});
  return true;
}

async function waitForEnabledLoginButton(page) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const enabled = await page
      .$('button[data-hrl-bo="atm-personalMenuLogin"]:not([disabled]):not(.Mui-disabled)')
      .catch(() => null);
    if (enabled) return enabled;
    const any = await firstVisible(page, SELECTORS.sendSms);
    if (any) {
      const ok = await any.handle
        .evaluate((el) => !el.disabled && !el.classList.contains('Mui-disabled'))
        .catch(() => false);
      if (ok) return any.handle;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

async function detectOtp(page) {
  const single = await firstVisible(page, SELECTORS.otp);
  if (single) return { mode: 'single', ...single };
  const contexts = [page, ...(page.frames?.() || [])];
  for (const context of contexts) {
    const digits = await context.$$(SELECTORS.otpDigit).catch(() => []);
    const visible = [];
    for (const handle of digits) {
      const ok = await handle
        .evaluate((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .catch(() => false);
      if (ok) visible.push(handle);
    }
    if (visible.length >= 4) return { mode: 'digits', handles: visible, context };
  }
  return null;
}

function latestStartProcess(payloads) {
  const row = [...(payloads || [])]
    .reverse()
    .find((item) => /PostAuthenticate\/StartProcess/i.test(item?.url || ''));
  if (!row) return null;
  const details = row.data?.Details && typeof row.data.Details === 'object' ? row.data.Details : {};
  return {
    status: Number(row.data?.Status),
    details,
    message:
      details.UserInputError ||
      details.ErrorMessage ||
      details.ProcessSuccess ||
      details.Message ||
      row.data?.Message ||
      null,
  };
}

async function dismissSupportModal(page) {
  const closed = await page
    .evaluate(() => {
      const dialogs = [
        ...document.querySelectorAll('[role="dialog"], .MuiDialog-root, .MuiModal-root, .modal'),
      ];
      const support = dialogs.find((node) =>
        /תמיכה טכנית|פנייה לנציג|נציג תמיכה/.test(node.innerText || ''),
      );
      if (!support) return null;
      const closeBtn = [...support.querySelectorAll('button, [aria-label], [class*="close"]')].find(
        (button) => {
          const label = `${button.getAttribute('aria-label') || ''} ${button.innerText || ''}`
            .replace(/\s+/g, ' ')
            .trim();
          return /close|סגור|^×$|^x$/i.test(label);
        },
      );
      if (closeBtn) {
        closeBtn.click();
        return 'close-btn';
      }
      support.remove();
      return 'removed';
    })
    .catch(() => null);
  if (closed) console.info(`harel dismissed support modal (${closed})`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function waitForOtpScreen(page, payloads, pending, timeoutMs = 35000) {
  const deadline = Date.now() + timeoutMs;
  const before = payloads.length;
  while (Date.now() < deadline) {
    const otpUi = await detectOtp(page);
    if (otpUi) return otpUi;
    const start = latestStartProcess(payloads);
    if (start && start.status === 0 && /OTPWasSent/i.test(String(start.message || ''))) {
      // SMS accepted — keep waiting briefly for the input to mount.
    } else if (start && Number.isFinite(start.status) && start.status !== 0) {
      // Hard failure from Harel — no point waiting the full timeout.
      return null;
    }
    await waitForPayloadSettled(payloads, pending, before, 800);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return detectOtp(page);
}

async function fillOtp(page, code) {
  const otp = await detectOtp(page);
  if (!otp) throw new Error('Harel OTP input was not found.');
  const digits = String(code || '').replace(/\D/g, '');
  if (otp.mode === 'single') {
    await fillInput(page, otp, digits);
  } else {
    for (let i = 0; i < otp.handles.length; i += 1) {
      const ch = digits[i] || '';
      if (!ch) break;
      await otp.handles[i].click({ clickCount: 3 }).catch(() => {});
      await otp.handles[i].type(ch, { delay: 25 });
    }
  }

  // Prefer the OTP form's own enabled המשך button.
  const submitted = await page.evaluate(() => {
    const otpInput = document.querySelector('input#otp, input[name="otp"]');
    const form = otpInput?.closest('form');
    const scoped = form
      ? [...form.querySelectorAll('button')]
      : [...document.querySelectorAll('button')];
    const target = scoped.find((button) => {
      const label = (button.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/^המשך$/.test(label) && !/אישור|שלח|verify|confirm/i.test(label)) return false;
      return !button.disabled && !button.classList.contains('Mui-disabled');
    });
    if (!target) return null;
    target.click();
    return (target.innerText || '').trim();
  });
  if (!submitted) {
    const submit = await firstVisible(page, SELECTORS.otpSubmit);
    if (submit) await submit.handle.click().catch(() => {});
    else await clickByText(page, ['אישור', 'המשך', 'כניסה', 'שלח', 'verify', 'confirm', 'continue']);
  }
  await page.keyboard.press('Enter').catch(() => {});
}

async function waitForLoginFields(page) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const idField = await firstVisible(page, SELECTORS.idNumber);
    if (idField) return idField;
    // Panel may have closed / not opened yet — retry the CTA occasionally.
    if (Date.now() + 500 < deadline && Math.floor(Date.now() / 1000) % 5 === 0) {
      await openPersonalAreaPanel(page);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
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

      // Pattern from client-view cards: "קרנות פנסיה ₪ 151,434"
      const body = textOf(document.body);
      const pairRe =
        /(קרנות פנסיה|פנסיה|קופת גמל|גמל|השתלמות|ביטוח מנהלים|חיסכון)[^\d₪]{0,40}₪?\s*([\d,]{3,})/g;
      let match;
      while ((match = pairRe.exec(body))) {
        out.push({
          policyName: match[1],
          productType: match[1],
          balance: parseMoney(match[2]),
          policyNumber: '',
          investmentTrack: '',
        });
      }

      const cards = [
        ...document.querySelectorAll(
          'article, section, li, tr, [class*="card" i], [class*="policy" i], [class*="product" i], [class*="saving" i], [class*="fund" i], [class*="topic" i]',
        ),
      ];
      for (const card of cards.slice(0, 160)) {
        const text = textOf(card);
        if (text.length < 8 || text.length > 1500) continue;
        if (!/(פנסיה|גמל|השתלמות|יתרה|צבירה|חיסכון|קופה|קרן|₪)/i.test(text)) continue;
        if (/@harel\/|customer-main-|scanovate|cookie|פעולות נפוצות|מדיניות הפרטיות/i.test(text)) continue;
        const heading = textOf(card.querySelector('h1,h2,h3,h4,strong,a,span')) || text.slice(0, 80);
        if (/@harel\//i.test(heading)) continue;
        const shekel = text.match(/₪\s*([\d,]{3,}(?:\.\d+)?)/);
        if (!shekel) continue;
        const numberMatch = text.match(/(?:פוליסה|תוכנית|מס(?:פר)?)\s*[:#]?\s*([A-Z0-9-]{4,})/i);
        out.push({
          policyName: heading,
          policyNumber: numberMatch?.[1] || '',
          productType: text,
          balance: parseMoney(shekel[1]),
          investmentTrack: '',
        });
      }
      return out;
    })
    .catch(() => []);

  return rows.map((row) => policyFromRecord(row)).filter(Boolean);
}

async function tryResumeSession(rt, page, payloads, pending) {
  const authState = await readHarelAuthState(rt);
  if (!authState) {
    console.info(`${rt.logTag} no saved auth-state`);
    return false;
  }

  console.info(`${rt.logTag} trying saved auth-state from ${authState.savedAt || 'unknown'}`);
  rt.state.message = 'משתמש בסשן שמור…';
  await applyHarelAuthState(page, authState);
  await page.goto(CLIENT_VIEW_URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  await dismissBlockingModals(page);
  await clickByText(page, ['ראיתי, תודה', 'אני מסכים', 'הבנתי', 'סגור']).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 1200, timeout: 25000 }).catch(() => {});

  const url = page.url();
  if (/login-Page|Login\.aspx/i.test(url)) {
    console.info(`${rt.logTag} saved session redirected to login`);
    await clearHarelAuthState(rt);
    return false;
  }
  if (await clientViewBroken(page)) {
    console.info(`${rt.logTag} saved session hit client-view error page`);
    // Still might recover via ensureClientViewData / fallback pages later.
  }

  const ready = await waitForSavingsPayloads(payloads, pending, 18000);
  const authed =
    authSucceeded(payloads) ||
    /personal-info|client-view|my-harel/i.test(page.url()) ||
    (await waitForAuthenticatedSession(page, payloads));

  if (!ready && !authed) {
    console.info(`${rt.logTag} saved session not authenticated`);
    await clearHarelAuthState(rt);
    return false;
  }

  console.info(`${rt.logTag} resumed session productsReady=${ready} url=${page.url()}`);
  return true;
}

async function loginWithSms(rt, page, payloads, pending, credentials) {
  const target = loginUrl();
  console.info(`${rt.logTag} navigate ${target.href}`);
  await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 90000 });

  await clickByText(page, ['אני מסכים', 'אישור', 'accept', 'הבנתי', 'סגור']).catch(() => {});
  await openPersonalAreaPanel(page);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const idField = await waitForLoginFields(page);
  if (!idField) {
    await dumpDebug(page, 'no-id-field');
    throw new Error('Harel login form (ID number) was not found.');
  }

  await fillInput(page, idField, credentials.idNumber);

  if (credentials.phoneNumber) {
    const phoneField = await firstVisible(page, SELECTORS.phoneNumber);
    if (phoneField && phoneField.handle !== idField.handle) {
      await fillInput(page, phoneField, credentials.phoneNumber);
      rt.state.phoneHint = phoneHintFrom(credentials.phoneNumber);
    }
  }

  const loginButton = await waitForEnabledLoginButton(page);
  if (!loginButton) {
    await dumpDebug(page, 'login-disabled');
    throw new Error('Harel continue button stayed disabled — ID/phone were not accepted.');
  }
  await loginButton.click().catch(async () => {
    await clickByText(page, ['המשך']);
  });
  console.info('harel requested SMS / StartProcess');

  let otpUi = await waitForOtpScreen(page, payloads, pending, 35000);

  if (!otpUi) {
    const start = latestStartProcess(payloads);
    console.info(
      `harel StartProcess status=${start?.status} detail=${JSON.stringify(start?.details || {}).slice(0, 240)}`,
    );
    await dumpAuthPayloads(payloads, 'startprocess-failed');
    await dismissSupportModal(page);
    await dismissBlockingModals(page);
    await clickByText(page, ['סגור', 'ראיתי, תודה']).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 4000));

    await openPersonalAreaPanel(page);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const idAgain = await waitForLoginFields(page);
    if (idAgain) {
      await fillInput(page, idAgain, credentials.idNumber);
      if (credentials.phoneNumber) {
        const phoneAgain = await firstVisible(page, SELECTORS.phoneNumber);
        if (phoneAgain && phoneAgain.handle !== idAgain.handle) {
          await fillInput(page, phoneAgain, credentials.phoneNumber);
        }
      }
      const retryButton = await waitForEnabledLoginButton(page);
      if (retryButton) {
        const beforeRetry = payloads.length;
        await retryButton.click().catch(async () => {
          await clickByText(page, ['המשך']);
        });
        console.info('harel retry SMS / StartProcess');
        otpUi = await waitForOtpScreen(page, payloads, pending, 35000);
        const retryStart = latestStartProcess(payloads.slice(beforeRetry));
        console.info(
          `harel StartProcess retry status=${retryStart?.status} detail=${JSON.stringify(retryStart?.details || {}).slice(0, 240)}`,
        );
      }
    }
  }

  if (!otpUi) {
    await dumpDebug(page, 'no-otp');
    await dumpAuthPayloads(payloads, 'no-otp');
    const start = latestStartProcess(payloads);
    const detail =
      start?.message ||
      start?.details?.ProcessSuccess ||
      start?.details?.ErrorMessage ||
      start?.details?.UserInputError ||
      null;
    if (start && start.status !== 0) {
      throw new Error(
        `Harel refused to send SMS (Status=${start.status}${detail ? `, ${detail}` : ''}). Wait a few minutes and sync again — rapid retries often trigger their technical-support challenge.`,
      );
    }
    throw new Error(
      'Harel OTP screen did not appear after requesting SMS. Wait a few minutes and try again.',
    );
  }

  if (!rt.state.phoneHint && credentials.phoneNumber) {
    rt.state.phoneHint = phoneHintFrom(credentials.phoneNumber);
  }

  const code = await waitForOtp(rt);
  await fillOtp(page, code);
  console.info(`${rt.logTag} otp submitted url=${page.url()}`);
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const authed = await waitForAuthenticatedSession(page, payloads);
  await dumpAuthPayloads(payloads, authed ? 'ok' : 'pending');

  const otpFailure = [...payloads]
    .reverse()
    .find((row) => /SCValidateOTP/i.test(row.url || '') && Number(row.data?.Status) !== 0);
  if (otpFailure && !authed) {
    const detail =
      otpFailure.data?.Details?.UserInputError ||
      otpFailure.data?.Details?.ErrorMessage ||
      otpFailure.data?.Message ||
      'OTP validation failed';
    await dumpDebug(page, 'otp-rejected');
    throw new Error(`Harel rejected the SMS code (${detail}).`);
  }

  if (!authed) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  const stillAuthed = authed || authSucceeded(payloads) || (await waitForAuthenticatedSession(page, payloads));
  let landedUrl = page.url();
  if (!stillAuthed && !/personal-info|client-view|my-harel/i.test(landedUrl)) {
    await dumpDebug(page, 'not-authenticated');
    await dumpAuthPayloads(payloads, 'not-authenticated');
    throw new Error(
      'Harel login did not complete after SMS — personal area was not opened. Try syncing again with a fresh code.',
    );
  }

  if (!/personal-info|client-view|my-harel/i.test(landedUrl)) {
    landedUrl = await openClientView(page);
    console.info(`harel after client-view url=${landedUrl}`);
  }
  if (/PageNotFoundError|404|login-Page/i.test(landedUrl) || /PageNotFoundError/i.test(await page.content().catch(() => ''))) {
    await dumpDebug(page, 'client-view-missing');
    throw new Error('Harel personal area page was not reachable after login (404/login).');
  }
}

async function harvestAfterAuth(page, payloads, pending) {
  await dismissBlockingModals(page);
  await clickByText(page, ['ראיתי, תודה', 'אני מסכים', 'הבנתי', 'סגור']).catch(() => {});
  await page.waitForNetworkIdle({ idleTime: 1500, timeout: 30000 }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const productsReady = await ensureClientViewData(page, payloads, pending);
  console.info(`harel productsReady=${productsReady} payloads=${payloads.length}`);

  if (!productsReady) {
    await clickByText(page, ['פנסיה', 'גמל', 'השתלמות', 'חיסכון', 'המוצרים שלי', 'החסכונות שלי']).catch(
      () => {},
    );
    await page.waitForNetworkIdle({ idleTime: 1200, timeout: 20000 }).catch(() => {});
  }

  await dumpPayloadSummary(payloads, 'post-login');
  await dumpAuthPayloads(payloads, 'post-login');

  const portfolio = await harvestPolicies(page, payloads, pending);
  if (!portfolio.policies.length) {
    await dumpDebug(page, 'no-portfolio');
    await dumpPayloadSummary(payloads, 'no-portfolio');
    await dumpAuthPayloads(payloads, 'no-portfolio');
    console.info(
      `harel payloads=${payloads.length} url=${page.url()} urls=${payloads
        .map((row) => row.url)
        .slice(-12)
        .join(' | ')}`,
    );
    throw new Error(
      'Harel personal area opened but product balances failed to load (client-view error). Try syncing again with a fresh SMS.',
    );
  }
  return portfolio;
}

async function runScrape(rt) {
  resetRun(rt);
  const credentials = readProfileCredentials(rt);
  const payloads = [];
  const pendingResponses = new Set();
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    rt.browserHandle = browser;
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
      const looksJson =
        type.includes('json') ||
        /PostAuthenticate|webapi|apps\.client-view|digital\.harel/i.test(url);
      if (!looksJson) return;
      if (!isInterestingJsonUrl(url)) return;
      const task = response
        .text()
        .then((body) => {
          if (!body || body.length > 2_500_000) return;
          try {
            payloads.push({ url, status, data: JSON.parse(body) });
            if (payloads.length > 220) payloads.shift();
            if (/SCValidateOTP|StartProcess|GetCurrentDetails|pension|study-fund|fee|yield/i.test(url)) {
              console.info(
                `${rt.logTag} api ${status} ${url.split('/').slice(-2).join('/')} statusField=${payloads.at(-1)?.data?.Status}`,
              );
            }
          } catch {
            /* ignore non-json */
          }
        })
        .catch(() => {})
        .finally(() => {
          pendingResponses.delete(task);
        });
      pendingResponses.add(task);
    });

    let usedSession = await tryResumeSession(rt, page, payloads, pendingResponses);
    let portfolio = null;

    if (usedSession) {
      try {
        portfolio = await harvestAfterAuth(page, payloads, pendingResponses);
      } catch (error) {
        console.info(
          `${rt.logTag} session harvest failed — falling back to SMS (${String(error.message || '').slice(0, 120)})`,
        );
        await clearHarelAuthState(rt);
        usedSession = false;
        portfolio = null;
      }
    }

    if (!usedSession) {
      rt.state.message = null;
      await loginWithSms(rt, page, payloads, pendingResponses, credentials);
      portfolio = await harvestAfterAuth(page, payloads, pendingResponses);
    }

    try {
      await writeHarelAuthState(rt, page);
    } catch (error) {
      console.info(`${rt.logTag} auth-state save failed ${String(error.message || '').slice(0, 100)}`);
    }

    finish(rt, 'SUCCESS', {
      portfolio,
      error: null,
      errorCode: null,
      message: usedSession ? 'עודכן עם סשן שמור (ללא SMS).' : null,
    });
    console.info(
      `${rt.logTag} success session=${usedSession} policies=${portfolio.policies.length} total=${portfolio.totalPensionBalance} payloads=${payloads.length} url=${page.url()}`,
    );
  } catch (error) {
    finish(rt, 'ERROR', {
      error: error.message || 'The Harel scrape failed.',
      message: error.message || 'The Harel scrape failed.',
      errorCode: error.errorCode || CODES.scrapeFailed,
      portfolio: null,
    });
    console.error(`${rt.logTag} failed ${rt.state.errorCode} ${error.message}`);
  } finally {
    dropPendingOtp(rt);
    rt.running = false;
    rt.browserHandle = null;
    if (browser) await browser.close().catch(() => {});
  }
}

function startProfileScrape(rt) {
  if (rt.running) {
    throw httpError(409, 'A Harel scrape is already running.', CODES.alreadyRunning);
  }
  if (!hasProfileCredentials(rt)) {
    rt.state.status = 'MISSING_CREDENTIALS';
    rt.state.error = 'MISSING_CREDENTIALS';
    rt.state.message = `חסר מספר תעודת זהות להראל בקובץ .env (${rt.idEnv})`;
    rt.state.errorCode = CODES.missingCredentials;
    rt.state.finishedAt = new Date().toISOString();
    console.info(`${rt.logTag} aborted ${CODES.missingCredentials}`);
    throw httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials, rt.state.message);
  }

  loginUrl();
  rt.running = true;
  void runScrape(rt);
  return { status: 'STARTED', profileKey: rt.profileKey };
}

export function startHarelScrape() {
  return startProfileScrape(runtimes.meni);
}

export function startEfratHarelScrape() {
  return startProfileScrape(runtimes.efrat);
}
