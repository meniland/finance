import puppeteer from 'puppeteer-core';

const OTP_TIMEOUT_MS = 300_000;
const DEFAULT_LOGIN_URL = 'https://sparkmeitav.ordernet.co.il/';
const DEBUG_SCREENSHOT_PATH = '/tmp/meitav-debug.png';

/** Spark Ordernet short-key maps (from the public Ordernet client). */
const SPARK_KEY_MAPS = {
  AuthResult: {
    a: 'LoginStatus',
    l: 'Token',
    k: 'CaptchaID',
  },
  RMType: {
    i: 'SYMBOL_NAM',
    j: 'BNO_NAME',
    y: 'PRC',
    z: 'PRC_CHNG',
    bd: 'NV',
    be: 'COST',
    bf: 'VL',
    bk: 'ID_PCNT',
  },
  RMTotalType: {
    b: 'AccountValue',
    g: 'Cash',
  },
  SecuritiesData: {
    a: 'Totals',
    b: 'AssetMargins',
  },
  SecuritiesTotalType: {
    a: 'CashMorning',
    d: 'CashCurrent',
    e: 'NezilimCurrent',
    o: 'AccountValueMorning',
  },
};

const CODES = {
  missingCredentials: '20261117.401733',
  alreadyRunning: '20261117.401734',
  scrapeFailed: '20261117.401735',
  noPendingOtp: '20261117.401736',
  invalidLoginUrl: '20261117.401737',
};

/**
 * DOM selectors for the Meitav / Spark Ordernet login flow.
 * Adjust here if the portal markup changes.
 */
export const SELECTORS = {
  // Any non-hidden input rendered by the SPA / iframe widget
  anyVisibleInput: 'input:not([type="hidden"])',
  // Username / ID candidates (resolved dynamically; first visible text-like field wins)
  username:
    'input[name*="user" i], input[id*="user" i], input[formcontrolname*="user" i], input[autocomplete="username"], input[type="text"]:not([readonly]), input[type="email"]',
  // Password field
  password: 'input[type="password"], input[name*="pass" i], input[id*="pass" i], input[formcontrolname*="pass" i]',
  // Primary login submit (text match is handled in clickLoginSubmit)
  submit: 'button[type="submit"], button.btn-primary',
  // SMS / 2FA single OTP field
  otp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[formcontrolname*="code" i], input[name*="code" i], input[type="tel"]',
  // Digit boxes if the portal splits the OTP
  otpDigit: 'input[maxlength="1"]',
  // OTP approve / continue
  otpSubmit: 'button[type="submit"], button.btn-primary',
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

export function hasMeitavCredentials() {
  return Boolean(String(process.env.MEITAV_USERNAME || '').trim() && String(process.env.MEITAV_PASSWORD || ''));
}

export function getMeitavState() {
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    message: state.message,
    phoneHint: state.phoneHint,
    credentialsConfigured: hasMeitavCredentials(),
    portfolio: state.portfolio,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
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

export function submitMeitavOtp(otpCode) {
  if (!pendingOtp || state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'Meitav Trade is not waiting for an SMS code.', CODES.noPendingOtp);
  }
  pendingOtp.resolve(otpCode);
}

function loginUrl() {
  const raw = String(process.env.MEITAV_LOGIN_URL || DEFAULT_LOGIN_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw httpError(400, 'MEITAV_LOGIN_URL is not a valid URL.', CODES.invalidLoginUrl);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw httpError(400, 'MEITAV_LOGIN_URL must be an http(s) address.', CODES.invalidLoginUrl);
  }
  return parsed;
}

function sparkApiBase(login) {
  try {
    const host = new URL(login.href).hostname.toLowerCase();
    if (host.includes('ordernet.co.il')) return login.origin;
  } catch {
    /* fall through */
  }
  return 'https://sparkmeitav.ordernet.co.il';
}

function convertSpark(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(convertSpark);
  const map = SPARK_KEY_MAPS[node._t] || {};
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    const nextKey = map[key] || key;
    out[nextKey] = convertSpark(value);
  }
  return out;
}

function accountIdFromKey(accountKey) {
  const text = String(accountKey || '');
  const tail = text.includes('-') ? text.slice(text.lastIndexOf('-') + 1) : text;
  return /^\d+$/.test(tail) ? tail : text;
}

function preferredAccountFilter() {
  const raw = String(process.env.MEITAV_ACCOUNT_ID || '').trim();
  return raw || '';
}

function keyOf(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
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

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  for (const value of Object.values(node)) walk(value, visit);
}

function holdingFrom(record) {
  const name = pick(record, [
    'BNO_NAME',
    'name',
    'securityname',
    'hebname',
    'engname',
    'papername',
    'instrumentname',
  ]);
  const symbol = pick(record, ['SYMBOL_NAM', 'symbol', 'ticker', 'securityid', 'instrumentid']);
  const quantity = asNumber(pick(record, ['NV', 'quantity', 'qty', 'amount', 'nominal']));
  const lastPrice = asNumber(pick(record, ['PRC', 'lastprice', 'lastrate', 'price', 'rate', 'baserate']));
  const marketValue = asNumber(
    pick(record, ['VL', 'marketvalue', 'value', 'holdingvalue', 'totalvalue']),
  );
  const cost = asNumber(pick(record, ['COST', 'cost', 'averagecost']));
  const dailyChangePercent = asNumber(
    pick(record, ['dailychangepercent', 'changepercent', 'changeper', 'pctchange', 'daychange']),
  );
  let totalProfitLoss = asNumber(
    pick(record, ['totalprofitloss', 'profitloss', 'pnl', 'yield', 'profit', 'pl']),
  );
  if (totalProfitLoss === null && marketValue !== null && cost !== null) {
    totalProfitLoss = marketValue - cost;
  }
  if (!name && !symbol) return null;
  if (quantity === null && marketValue === null && totalProfitLoss === null && lastPrice === null) {
    return null;
  }
  return {
    symbol: symbol == null ? '' : String(symbol).trim(),
    name: name == null ? '' : String(name).trim(),
    quantity,
    lastPrice,
    marketValue,
    dailyChangePercent,
    totalProfitLoss,
  };
}

async function sparkFetch(apiBase, path, { token, method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json;charset=UTF-8',
    Referer: `${apiBase}/`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw new Error(`Meitav API HTTP ${response.status} on ${path}`);
  }
  return json;
}

async function authenticateSpark(apiBase, credentials) {
  const raw = await sparkFetch(apiBase, '/api/Auth/Authenticate', {
    method: 'POST',
    body: {
      username: credentials.username,
      password: credentials.password,
    },
  });
  const auth = convertSpark(raw || {});
  return {
    loginStatus: String(auth.LoginStatus || auth.a || ''),
    token: typeof auth.Token === 'string' && auth.Token ? auth.Token : '',
    captchaId: auth.CaptchaID || null,
    raw: auth,
  };
}

function accountKeysFromStaticData(staticData) {
  const keys = [];
  const rows = Array.isArray(staticData) ? staticData : [];
  for (const row of rows) {
    if (!row || row.b !== 'ACC' || !Array.isArray(row.a)) continue;
    for (const account of row.a) {
      const key = String(account?._k || '').trim();
      if (/^ACC_/i.test(key) && !keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

function filterAccountKeys(keys) {
  const wanted = preferredAccountFilter();
  if (!wanted) return keys;
  const matched = keys.filter(
    (key) => key.endsWith(`-${wanted}`) || key.includes(wanted) || accountIdFromKey(key) === wanted,
  );
  return matched.length > 0 ? matched : keys;
}

async function fetchPortfolioViaApi(apiBase, token, accountKeys) {
  const accounts = [];
  const sketches = [];
  for (const accountKey of accountKeys) {
    const params = new URLSearchParams({ accountKey });
    try {
      const [holdingsRaw, summaryRaw, securitiesRaw] = await Promise.all([
        sparkFetch(apiBase, `/api/Account/GetHoldings?${params}`, { token }),
        sparkFetch(apiBase, `/api/Account/GetHoldingsSummery?${params}`, { token }),
        sparkFetch(apiBase, `/api/Account/GetAccountSecurities?${params}`, { token }),
      ]);
      const holdingsRows = Array.isArray(holdingsRaw) ? holdingsRaw.map(convertSpark) : [];
      const summary = convertSpark(summaryRaw || {});
      const securities = convertSpark(securitiesRaw || {});
      const totals = securities?.Totals && typeof securities.Totals === 'object' ? securities.Totals : {};
      const holdings = holdingsRows.map(holdingFrom).filter(Boolean);
      const totalValue =
        asNumber(summary.AccountValue) ?? asNumber(totals.AccountValueMorning) ?? null;
      const cashBalance =
        asNumber(summary.Cash) ?? asNumber(totals.CashCurrent) ?? asNumber(totals.CashMorning) ?? null;
      let totalProfitLoss = null;
      if (holdings.some((row) => row.totalProfitLoss !== null)) {
        totalProfitLoss = holdings.reduce((sum, row) => sum + (row.totalProfitLoss || 0), 0);
      }
      accounts.push({
        id: accountIdFromKey(accountKey),
        totalValue,
        cashBalance,
        totalProfitLoss,
        holdings,
      });
      sketches.push(`${accountKey}:ok:${holdings.length}`);
    } catch (error) {
      sketches.push(`${accountKey}:failed:${String(error.message || 'error').slice(0, 40)}`);
    }
  }
  return { accounts, sketches };
}

function isInterestingJsonUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!/(ordernet\.co\.il|meitavtrade\.co\.il)$/.test(host) && !host.includes('meitav')) {
      return false;
    }
    return /\/api\//i.test(parsed.pathname) || /json|account|holding|securit|balance|static/i.test(url);
  } catch {
    return false;
  }
}

function accountKeysFromPayloads(payloads) {
  const keys = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (/^ACC_[A-Z0-9]+-\d+/i.test(text) && !keys.includes(text)) keys.push(text);
  };

  for (const payload of payloads) {
    walk(payload, (node) => {
      if (Array.isArray(node)) return;
      push(node._k);
      push(node.AccountKey);
      push(node.accountKey);
      push(node.Key);
      if (node.b === 'ACC' && Array.isArray(node.a)) {
        for (const row of node.a) push(row?._k || row?.AccountKey);
      }
    });
  }
  return keys;
}

function emptyPortfolio() {
  return {
    totalValue: null,
    cashBalance: null,
    totalProfitLoss: null,
    holdings: [],
    accounts: [],
  };
}

function normalizeCaptured(payloads) {
  let holdings = [];
  let totalValue = null;
  let cashBalance = null;
  let totalProfitLoss = null;

  for (const payload of payloads) {
    walk(payload, (node) => {
      if (!Array.isArray(node) || node.length === 0 || node.length > 800) return;
      const rows = node.map(holdingFrom).filter(Boolean);
      if (rows.length >= 1 && rows.length >= node.length * 0.4 && rows.length > holdings.length) {
        holdings = rows;
      }
    });
    walk(payload, (node) => {
      if (Array.isArray(node)) return;
      const value = asNumber(
        pick(node, ['totalvalue', 'portfoliovalue', 'nav', 'equity', 'sumvalue', 'total']),
      );
      const cash = asNumber(pick(node, ['cash', 'cashbalance', 'cashvalue', 'availablecash']));
      const pnl = asNumber(pick(node, ['totalprofitloss', 'profitloss', 'pnl', 'unrealizedpnl']));
      if (value !== null) totalValue = value;
      if (cash !== null) cashBalance = cash;
      if (pnl !== null) totalProfitLoss = pnl;
    });
  }

  if (totalValue === null && holdings.some((row) => row.marketValue !== null)) {
    totalValue = holdings.reduce((sum, row) => sum + (row.marketValue || 0), 0);
  }
  if (totalProfitLoss === null && holdings.some((row) => row.totalProfitLoss !== null)) {
    totalProfitLoss = holdings.reduce((sum, row) => sum + (row.totalProfitLoss || 0), 0);
  }

  return { totalValue, cashBalance, totalProfitLoss, holdings, accounts: [] };
}

function portfolioFromAccounts(accounts) {
  const holdings = [];
  let totalValue = 0;
  let cashBalance = 0;
  let totalProfitLoss = 0;
  let sawValue = false;
  let sawCash = false;
  let sawPnl = false;

  for (const account of accounts) {
    if (account.totalValue !== null) {
      totalValue += account.totalValue;
      sawValue = true;
    }
    if (account.cashBalance !== null) {
      cashBalance += account.cashBalance;
      sawCash = true;
    }
    if (account.totalProfitLoss !== null) {
      totalProfitLoss += account.totalProfitLoss;
      sawPnl = true;
    }
    holdings.push(...(account.holdings || []));
  }

  return {
    totalValue: sawValue ? totalValue : null,
    cashBalance: sawCash ? cashBalance : null,
    totalProfitLoss: sawPnl ? totalProfitLoss : null,
    holdings,
    accounts,
  };
}

async function isVisible(handle) {
  if (!handle) return false;
  return handle.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
  });
}

function browsingContexts(page) {
  const frames = page.frames();
  const main = page.mainFrame();
  return [main, ...frames.filter((frame) => frame !== main)];
}

async function firstVisibleInContext(context, selector) {
  const handles = await context.$$(selector).catch(() => []);
  for (const handle of handles) {
    if (await isVisible(handle)) return handle;
  }
  return null;
}

async function firstVisible(page, selector) {
  for (const context of browsingContexts(page)) {
    const handle = await firstVisibleInContext(context, selector);
    if (handle) return handle;
  }
  return null;
}

async function waitForRenderedInputs(page) {
  await page
    .waitForSelector(SELECTORS.anyVisibleInput, { visible: true, timeout: 15000 })
    .catch(() => null);

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const found = await frame
      .waitForSelector(SELECTORS.anyVisibleInput, { visible: true, timeout: 3000 })
      .catch(() => null);
    if (found) return;
  }
}

async function findLoginFields(page) {
  for (const context of browsingContexts(page)) {
    const password =
      (await firstVisibleInContext(context, SELECTORS.password)) ||
      (await firstVisibleInContext(context, 'input[type="password"]'));
    if (!password) continue;

    let username =
      (await firstVisibleInContext(context, SELECTORS.username)) ||
      (await firstVisibleInContext(context, 'input[type="text"]')) ||
      (await firstVisibleInContext(context, 'input[name*="user" i]')) ||
      (await firstVisibleInContext(context, 'input[id*="user" i]'));

    if (!username) {
      const candidates = await context.$$(SELECTORS.anyVisibleInput).catch(() => []);
      for (const handle of candidates) {
        if (!(await isVisible(handle))) continue;
        const meta = await handle.evaluate((element) => ({
          type: (element.getAttribute('type') || 'text').toLowerCase(),
          name: element.getAttribute('name') || '',
          id: element.id || '',
        }));
        if (meta.type === 'password' || meta.type === 'hidden' || meta.type === 'submit') continue;
        username = handle;
        break;
      }
    }

    if (username) return { username, password, context };
  }
  return null;
}

async function listInputInventory(page) {
  const inventory = [];
  for (const context of browsingContexts(page)) {
    const rows = await context
      .evaluate(() =>
        Array.from(document.querySelectorAll('input')).map((element) => ({
          type: element.getAttribute('type') || 'text',
          name: element.getAttribute('name') || '',
          id: element.id || '',
          autocomplete: element.getAttribute('autocomplete') || '',
          visible:
            !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
        })),
      )
      .catch(() => []);
    const frameUrl = context.url?.() || '';
    for (const row of rows) inventory.push({ frame: frameUrl, ...row });
  }
  return inventory;
}

async function dumpLoginDebug(page) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const inputs = await listInputInventory(page);
  await page.screenshot({ path: DEBUG_SCREENSHOT_PATH, fullPage: true }).catch(() => {});
  console.error(
    `meitav login-form miss title=${JSON.stringify(title)} url=${url} screenshot=${DEBUG_SCREENSHOT_PATH} inputs=${JSON.stringify(inputs)}`,
  );
}

async function detectOtp(page) {
  const single = await firstVisible(page, SELECTORS.otp);
  if (single) return { mode: 'single' };
  const boxes = [];
  for (const context of browsingContexts(page)) {
    const found = await context.$$(SELECTORS.otpDigit).catch(() => []);
    for (const box of found) {
      if (await isVisible(box)) boxes.push(box);
    }
  }
  if (boxes.length >= 4) return { mode: 'digits', count: boxes.length };

  for (const context of browsingContexts(page)) {
    const hint = await context
      .evaluate(() => {
        const text = document.body?.innerText || '';
        return /verification code|two step|קוד אימות|קוד חד.?פעמי|נשלח.*טלפון/i.test(text);
      })
      .catch(() => false);
    if (!hint) continue;
    const anyInput = await firstVisibleInContext(
      context,
      'input:not([type="hidden"]):not([type="password"])',
    );
    if (anyInput) return { mode: 'single' };
  }
  return null;
}

async function phoneHintFromPage(page) {
  for (const context of browsingContexts(page)) {
    const hint = await context
      .evaluate(() => {
        const text = document.body?.innerText || '';
        const match =
          text.match(/ending with[:\s]*([*\d]{2,6})/i) ||
          text.match(/מסתיים ב[־\-:\s]*([*\d]{2,6})/) ||
          text.match(/(\*{2,}\d{2,4})/);
        return match ? match[1] : '';
      })
      .catch(() => '');
    if (hint) return hint;
  }
  return '';
}

async function fillOtp(page, code) {
  const boxes = [];
  for (const context of browsingContexts(page)) {
    const found = await context.$$(SELECTORS.otpDigit).catch(() => []);
    for (const box of found) {
      if (await isVisible(box)) boxes.push(box);
    }
  }
  if (boxes.length >= 4) {
    const digits = code.split('');
    for (let index = 0; index < Math.min(boxes.length, digits.length); index += 1) {
      await boxes[index].click({ clickCount: 3 });
      await boxes[index].type(digits[index], { delay: 20 });
    }
  } else {
    const field =
      (await firstVisible(page, SELECTORS.otp)) ||
      (await firstVisible(page, 'input:not([type="hidden"]):not([type="password"])'));
    if (!field) throw new Error('The SMS field disappeared before the code was entered.');
    await field.click({ clickCount: 3 });
    await field.type(code, { delay: 20 });
  }

  const submit =
    (await firstVisible(page, SELECTORS.otpSubmit)) ||
    (await firstVisible(page, 'button[type="submit"]'));
  if (submit) await submit.click();
  else await page.keyboard.press('Enter');
}

async function clickLoginSubmit(page, context) {
  const scopes = context ? [context, ...browsingContexts(page)] : browsingContexts(page);
  const seen = new Set();
  for (const scope of scopes) {
    if (seen.has(scope)) continue;
    seen.add(scope);
    const buttons = await scope.$$('button, input[type="submit"], a[role="button"]').catch(() => []);
    for (const button of buttons) {
      if (!(await isVisible(button))) continue;
      const label = (
        await scope.evaluate((element) => (element.innerText || element.value || '').trim(), button)
      ).toLowerCase();
      if (/log\s*in|sign\s*in|כניסה|התחבר|login/.test(label)) {
        await button.click();
        return;
      }
    }
    const fallback = await firstVisibleInContext(scope, 'button[type="submit"]');
    if (fallback) {
      await fallback.click();
      return;
    }
  }
  await page.keyboard.press('Enter');
}

async function fetchSparkPortfolio(page, accountKeys) {
  return page.evaluate(async (keys) => {
    const accounts = [];
    const sketches = [];
    for (const key of keys) {
      try {
        const params = new URLSearchParams({ accountKey: key });
        const [holdingsRes, summaryRes, securitiesRes] = await Promise.all([
          fetch(`/api/Account/GetHoldings?${params}`, { credentials: 'include' }),
          fetch(`/api/Account/GetHoldingsSummery?${params}`, { credentials: 'include' }),
          fetch(`/api/Account/GetAccountSecurities?${params}`, { credentials: 'include' }),
        ]);
        const holdingsJson = holdingsRes.ok ? await holdingsRes.json().catch(() => null) : null;
        const summaryJson = summaryRes.ok ? await summaryRes.json().catch(() => null) : null;
        const securitiesJson = securitiesRes.ok ? await securitiesRes.json().catch(() => null) : null;
        accounts.push({
          id: key.includes('-') ? key.slice(key.lastIndexOf('-') + 1) : key,
          key,
          holdings: holdingsJson,
          summary: summaryJson,
          securities: securitiesJson,
        });
        sketches.push(
          `${key}:${holdingsRes.status}/${summaryRes.status}/${securitiesRes.status}`,
        );
      } catch (error) {
        sketches.push(`${key}:failed`);
      }
    }
    return { accounts, sketches };
  }, accountKeys);
}

function holdingsFromSparkRows(rows) {
  return (Array.isArray(rows) ? rows : []).map(holdingFrom).filter(Boolean);
}

function accountFromSparkBundle(bundle) {
  const holdings = [
    ...holdingsFromSparkRows(bundle.holdings),
    ...holdingsFromSparkRows(bundle.securities?.Securities || bundle.securities?.Items),
  ];
  const unique = [];
  const seen = new Set();
  for (const row of holdings) {
    const key = `${row.symbol}|${row.name}|${row.quantity}|${row.marketValue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }

  const summary = bundle.summary && typeof bundle.summary === 'object' ? bundle.summary : {};
  const totals =
    bundle.securities?.Totals && typeof bundle.securities.Totals === 'object'
      ? bundle.securities.Totals
      : {};

  return {
    id: bundle.id,
    totalValue: asNumber(pick(summary, ['totalvalue', 'value', 'sum', 'nav', 'equity'])) ??
      asNumber(pick(totals, ['totalvalue', 'value', 'sum', 'nav'])),
    cashBalance: asNumber(pick(summary, ['cash', 'cashbalance', 'cashvalue'])) ??
      asNumber(pick(totals, ['cash', 'cashbalance'])),
    totalProfitLoss: asNumber(pick(summary, ['profitloss', 'totalprofitloss', 'pnl'])) ??
      asNumber(pick(totals, ['profitloss', 'totalprofitloss', 'pnl'])),
    holdings: unique,
  };
}

async function scrapeHoldingsFromDom(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).map(
        (cell) => (cell.textContent || '').trim(),
      );
      if (headers.length < 3) continue;
      const rows = Array.from(table.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent || '').trim()),
      );
      const populated = rows.filter((cells) => cells.some(Boolean));
      if (populated.length === 0) continue;
      return { headers, rows: populated };
    }
    return null;
  });
}

function holdingsFromTable(table) {
  if (!table) return [];
  const indexes = {};
  table.headers.forEach((header, index) => {
    const text = header.replace(/\s+/g, '');
    if (/שם|נייר|סימול|symbol|name/i.test(text) && indexes.name == null) indexes.name = index;
    if (/כמות|quantity/i.test(text)) indexes.quantity = index;
    if (/שער|מחיר|price|rate/i.test(text)) indexes.lastPrice = index;
    if (/שווי|market/i.test(text)) indexes.marketValue = index;
    if (/שינוי|change/i.test(text)) indexes.dailyChangePercent = index;
    if (/רווח|הפסד|pnl|profit/i.test(text)) indexes.totalProfitLoss = index;
  });
  return table.rows
    .map((cells) => ({
      symbol: '',
      name: cells[indexes.name] || cells[0] || '',
      quantity: asNumber(cells[indexes.quantity]),
      lastPrice: asNumber(cells[indexes.lastPrice]),
      marketValue: asNumber(cells[indexes.marketValue]),
      dailyChangePercent: asNumber(cells[indexes.dailyChangePercent]),
      totalProfitLoss: asNumber(cells[indexes.totalProfitLoss]),
    }))
    .filter((row) => row.name);
}

async function obtainTokenWithBrowser(target, credentials) {
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
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(120000);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    );

    page.on('response', (response) => {
      const type = response.headers()['content-type'] || '';
      if (!type.includes('json') || response.status() >= 400) return;
      const url = response.url();
      if (!isInterestingJsonUrl(url)) return;
      response
        .text()
        .then((body) => {
          if (!body || body.length > 2_000_000) return;
          try {
            payloads.push(JSON.parse(body));
            if (payloads.length > 60) payloads.shift();
          } catch {
            /* not json */
          }
        })
        .catch(() => {});
    });

    await page.goto(target.href, { waitUntil: 'networkidle2', timeout: 60000 });
    await waitForRenderedInputs(page);

    const fields = await findLoginFields(page);
    if (!fields) {
      await dumpLoginDebug(page);
      throw new Error('Meitav Trade login form was not found.');
    }

    await fields.username.click({ clickCount: 3 });
    await fields.username.type(credentials.username, { delay: 15 });
    await fields.password.click({ clickCount: 3 });
    await fields.password.type(credentials.password, { delay: 15 });
    await clickLoginSubmit(page, fields.context);

    const deadline = Date.now() + 25000;
    let otp = null;
    while (Date.now() < deadline) {
      try {
        otp = await detectOtp(page);
        if (otp) break;
        const stillPassword = await firstVisible(page, SELECTORS.password);
        const url = page.url();
        if (!stillPassword && !/login|auth|signin/i.test(url)) break;
      } catch (error) {
        if (!/context|destroyed|detached|navigation/i.test(error.message || '')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (otp) {
      const hint = await phoneHintFromPage(page);
      if (hint) state.phoneHint = hint;
      const code = await waitForOtp();
      await fillOtp(page, code);
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(() => {});
    }

    const tokenUntil = Date.now() + 15000;
    let token = '';
    while (Date.now() < tokenUntil && !token) {
      for (const payload of payloads) {
        const auth = convertSpark(payload || {});
        if (auth._t === 'AuthResult' || auth.LoginStatus || auth.Token) {
          if (typeof auth.Token === 'string' && auth.Token) {
            token = auth.Token;
            break;
          }
        }
        if (typeof payload?.l === 'string' && payload.l.length > 40 && payload?.a === 'Success') {
          token = payload.l;
          break;
        }
      }
      if (!token) await new Promise((resolve) => setTimeout(resolve, 400));
    }

    if (!token) {
      const retry = await authenticateSpark(sparkApiBase(target), credentials);
      if (retry.loginStatus === 'Success' && retry.token) token = retry.token;
    }
    if (!token) throw new Error('Meitav Trade login did not return an API token.');
    return token;
  } finally {
    browserHandle = null;
    if (browser) await browser.close().catch(() => {});
  }
}

async function runScrape() {
  resetRun();
  const credentials = {
    username: String(process.env.MEITAV_USERNAME || '').trim(),
    password: String(process.env.MEITAV_PASSWORD || ''),
  };

  try {
    const target = loginUrl();
    const apiBase = sparkApiBase(target);
    let token = '';

    // Prefer the Spark API auth path — browser login is only for OTP / captcha cases.
    try {
      const auth = await authenticateSpark(apiBase, credentials);
      console.info(`meitav auth status=${auth.loginStatus || 'unknown'} token=${Boolean(auth.token)}`);
      if (auth.loginStatus === 'Success' && auth.token) {
        token = auth.token;
      } else if (/otp|sms|verify|two.?step/i.test(auth.loginStatus)) {
        token = await obtainTokenWithBrowser(target, credentials);
      } else if (auth.captchaId || auth.loginStatus !== 'Success') {
        token = await obtainTokenWithBrowser(target, credentials);
      }
    } catch (error) {
      console.info(`meitav api-auth failed ${String(error.message || '').slice(0, 120)}`);
      token = await obtainTokenWithBrowser(target, credentials);
    }

    if (!token) throw new Error('Meitav Trade authentication failed.');

    const staticData = await sparkFetch(apiBase, '/api/DataProvider/GetStaticData', { token });
    let accountKeys = filterAccountKeys(accountKeysFromStaticData(staticData));
    if (accountKeys.length === 0) {
      throw new Error('Meitav Trade did not return any trading accounts for this user.');
    }

    const fetched = await fetchPortfolioViaApi(apiBase, token, accountKeys);
    console.info(`meitav accounts=${accountKeys.join(',')} sketches=${(fetched.sketches || []).join(',')}`);
    const portfolio = portfolioFromAccounts(fetched.accounts || []);

    if (portfolio.holdings.length === 0 && portfolio.totalValue === null && portfolio.cashBalance === null) {
      throw new Error('Meitav Trade did not return portfolio data after login.');
    }

    finish('SUCCESS', {
      portfolio,
      error: null,
      errorCode: null,
      message: null,
      phoneHint: null,
    });
    console.info(
      `meitav success holdings=${portfolio.holdings.length} accounts=${portfolio.accounts?.length || 0} value=${portfolio.totalValue}`,
    );
  } catch (error) {
    finish('ERROR', {
      error: error.message || 'The Meitav Trade scrape failed.',
      message: error.message || 'The Meitav Trade scrape failed.',
      errorCode: error.errorCode || CODES.scrapeFailed,
      portfolio: null,
    });
    console.error(`meitav failed ${state.errorCode} ${error.message}`);
  } finally {
    dropPendingOtp();
    running = false;
    browserHandle = null;
  }
}

export function startMeitavScrape() {
  if (running) {
    throw httpError(409, 'A Meitav Trade scrape is already running.', CODES.alreadyRunning);
  }
  if (!hasMeitavCredentials()) {
    state.status = 'MISSING_CREDENTIALS';
    state.error = 'MISSING_CREDENTIALS';
    state.message = 'חסרים פרטי התחברות למיטב טרייד בקובץ .env';
    state.errorCode = CODES.missingCredentials;
    state.finishedAt = new Date().toISOString();
    console.info(`meitav aborted ${CODES.missingCredentials}`);
    throw httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials, state.message);
  }

  loginUrl();
  running = true;
  void runScrape();
  return { status: 'STARTED' };
}
