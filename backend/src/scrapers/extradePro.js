import puppeteer from 'puppeteer-core';

const OTP_TIMEOUT_MS = 300_000;
const DEFAULT_LOGIN_URL = 'https://extradepro.xnes.co.il/login';

const CODES = {
  missingCredentials: '20261116.401056',
  alreadyRunning: '20261116.401057',
  scrapeFailed: '20261116.401100',
  invalidLoginUrl: '20261116.401101',
};

export const SELECTORS = {
  username: '#login-input',
  password: '#password-input',
  submit: 'app-login-password button.confirm-button',
  otp: 'input[name="otp"], input[autocomplete="one-time-code"], input[id*="otp" i]',
  otpDigit: 'input[maxlength="1"]',
  otpSubmit: 'button[type="submit"].confirm-button, button[type="submit"]',
  error: '#error-message',
  holdingsTable: 'table',
};

const NAME_KEYS = ['securityname', 'equityname', 'security_name', 'name', 'papername'];
const SYMBOL_KEYS = ['symbol', 'equitynumber', 'securitynumber', 'equity_number', 'ticker'];
const QTY_KEYS = ['quantity', 'currentbalance', 'online_nominal_value', 'nominalvalue', 'nv'];
const PRICE_KEYS = ['last_price', 'lastrate', 'lastprice', 'price_last', 'baserate', 'last_rate'];
const VALUE_KEYS = ['current_value_nis', 'marketvalue', 'holdingvalue', 'value'];
const DAY_KEYS = ['change_per', 'changepercentage', 'dailychangepercent', 'change_in_per'];
const PNL_KEYS = ['totalpnl', 'total_yield', 'profitloss', 'nominalpnl', 'daily_profit_loss'];

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

export function hasExtradeCredentials() {
  return Boolean(String(process.env.EXTRADE_USERNAME || '').trim() && String(process.env.EXTRADE_PASSWORD || ''));
}

export function getInvestmentsState() {
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    message: state.message,
    phoneHint: state.phoneHint,
    credentialsConfigured: hasExtradeCredentials(),
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

export function submitInvestmentsOtp(otpCode) {
  if (!pendingOtp || state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'The broker is not waiting for an SMS code.', '20261116.401059', 'The broker is not waiting for an SMS code.');
  }
  pendingOtp.resolve(otpCode);
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

function holdingFrom(record) {
  const name = pick(record, NAME_KEYS);
  const symbol = pick(record, SYMBOL_KEYS);
  const quantity = asNumber(pick(record, QTY_KEYS));
  const lastPrice = asNumber(pick(record, PRICE_KEYS));
  const marketValue = asNumber(pick(record, VALUE_KEYS));
  const dailyChangePercent = asNumber(pick(record, DAY_KEYS));
  const totalProfitLoss = asNumber(pick(record, PNL_KEYS));
  if (!name && !symbol) return null;
  if (quantity === null && marketValue === null && totalProfitLoss === null) return null;
  return {
    symbol: symbol == null ? '' : String(symbol),
    name: name == null ? '' : String(name),
    quantity,
    lastPrice,
    marketValue,
    dailyChangePercent,
    totalProfitLoss,
  };
}

function asRowList(value) {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object');
  if (value && typeof value === 'object') return [value];
  return [];
}

function positionRows(account) {
  const positioned = asRowList(account?.AccountPosition?.Balance);
  if (positioned.length > 0) return positioned;
  const nested = asRowList(account?.AccountPosition);
  if (nested.length > 0 && (nested[0].EquityNumber || nested[0].HebName || nested[0].OnlineNV)) return nested;
  return asRowList(account?.Balance);
}

function displayName(item) {
  if (typeof item.HebName === 'string' && item.HebName.trim()) return item.HebName.trim();
  if (typeof item.EngName === 'string' && item.EngName.trim()) return item.EngName.trim();
  if (typeof item.SubAccountName === 'string' && /[\u0590-\u05FF]/.test(item.SubAccountName)) return item.SubAccountName.trim();
  return '';
}

function rowsFromAccount(account) {
  const list = positionRows(account);
  return list
    .map((item) => {
      const quantity = asNumber(item.OnlineNV ?? item.MorningNV);
      const marketValue = asNumber(item.OnlineNisVL ?? item.OnlineVL ?? item.MorningVL);
      const name = displayName(item);
      const symbol = item.Symbol || item.EngSymbol || item.HebSymbol || item.EquityNumber || '';
      if (!name && !symbol) return null;
      if (quantity === null && marketValue === null) return null;
      return {
        symbol: String(symbol),
        name: String(name),
        quantity,
        lastPrice: asNumber(item.BaseRate ?? item.AveragePrice),
        marketValue,
        dailyChangePercent: asNumber(item.BaseRateChangePercentage ?? item.OnlinePercentage),
        totalProfitLoss: asNumber(item.ProfitLoss ?? item.AveragePriceProfitLossNis),
      };
    })
    .filter(Boolean);
}

function caseIdFromKey(key) {
  const text = String(key || '');
  const tail = text.includes('-') ? text.slice(text.lastIndexOf('-') + 1) : text;
  return /^\d{4,}$/.test(tail) ? tail : text;
}

function portfolioFromAccount(account) {
  return {
    totalValue: asNumber(account.OnlineValue),
    cashBalance: asNumber(account.OnlineCash),
    totalProfitLoss: asNumber(account.AveragePriceNisProfitLoss),
    holdings: rowsFromAccount(account),
  };
}

export function portfolioFromViews(entries) {
  const accounts = [];
  for (const entry of entries) {
    const body = entry?.body || entry;
    const account = body?.View?.Account;
    if (!account) continue;
    const id = caseIdFromKey(entry?.key) || String(accounts.length + 1);
    accounts.push({ id, ...portfolioFromAccount(account) });
  }
  accounts.sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));

  const holdings = [];
  let totalValue = 0;
  let cashBalance = 0;
  let totalProfitLoss = 0;
  let sawValue = false;
  let sawCash = false;
  let sawPnl = false;
  for (const item of accounts) {
    if (item.totalValue !== null) {
      totalValue += item.totalValue;
      sawValue = true;
    }
    if (item.cashBalance !== null) {
      cashBalance += item.cashBalance;
      sawCash = true;
    }
    if (item.totalProfitLoss !== null) {
      totalProfitLoss += item.totalProfitLoss;
      sawPnl = true;
    }
    holdings.push(...item.holdings);
  }

  return {
    totalValue: sawValue ? totalValue : null,
    cashBalance: sawCash ? cashBalance : null,
    totalProfitLoss: sawPnl ? totalProfitLoss : null,
    holdings,
    accounts,
  };
}

function sessionKeyFromPayloads(payloads) {
  for (const payload of payloads) {
    const key = payload?.Login?.SessionKey || payload?.Init?.SessionKey;
    if (typeof key === 'string' && key) return key;
  }
  return null;
}

function accountKeysFromPayloads(payloads) {
  const keys = [];
  for (const payload of payloads) {
    const raw = payload?.UserAccounts?.UserAccount;
    if (!raw) continue;
    const accounts = Array.isArray(raw) ? raw : [raw];
    for (const account of accounts) {
      const key = account?.['-key'] || account?.key;
      if (key && !keys.includes(String(key))) keys.push(String(key));
    }
  }
  return keys;
}

async function fetchBalanceViews(page, sessionKey, accountKeys) {
  return page.evaluate(
    async ({ session, keys }) => {
      const fields = 'EngName,EngSymbol,HebName,HebSymbol,Symbol,ExpirationDate,ItemType,StockType,IsEtf,IsForeign';
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      let currentSession = session || '';
      const views = [];
      const viewKeys = [];
      const statuses = [];
      const sketches = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        if (index > 0) await sleep(1300);
        try {
          const headers = currentSession ? { session: currentSession } : {};
          const encoded = encodeURIComponent(key);
          const init = await fetch(`/api/v2/json2/account/init?account=${encoded}`, {
            method: 'POST',
            credentials: 'include',
            headers,
          });
          if (init.ok) {
            const initBody = await init.json().catch(() => null);
            const nextSession = initBody?.Init?.SessionKey;
            if (typeof nextSession === 'string' && nextSession) currentSession = nextSession;
          }
          const load = async (path) => {
            let response = await fetch(path, {
              credentials: 'include',
              headers: currentSession ? { session: currentSession } : {},
            });
            if (!response.ok) {
              const errorBody = await response.clone().json().catch(() => null);
              if (errorBody?.Exception?.['-ExceptionType'] === 'MinIntervalException') {
                await sleep(1300);
                response = await fetch(path, {
                  credentials: 'include',
                  headers: currentSession ? { session: currentSession } : {},
                });
              }
            }
            const body = response.ok ? await response.json().catch(() => null) : null;
            return { status: response.status, body };
          };
          const view = await load(
            `/api/v2/json2/account/view/balances?account=${encoded}&fields=${fields}&currency=ILS`,
          );
          const countRows = (body) => {
            const account = body?.View?.Account;
            const positioned = account?.AccountPosition?.Balance;
            const list = Array.isArray(positioned) ? positioned : positioned && typeof positioned === 'object' ? [positioned] : [];
            if (list.length > 0) return list;
            const balance = account?.Balance;
            return Array.isArray(balance) ? balance : balance && typeof balance === 'object' ? [balance] : [];
          };
          const json = view.body;
          const account = json?.View?.Account;
          let rows = countRows(json);
          if (rows.length === 0 && account) {
            await sleep(1300);
            const morning = await load(
              `/api/v2/json2/account/view/balances/morning?account=${encoded}&fields=${fields}`,
            );
            const morningRows = countRows(morning.body).filter((row) => row?.HebName || row?.EngName);
            if (morningRows.length > 0) {
              account.Balance = morningRows;
              rows = morningRows;
            }
          }
          statuses.push(`${init.status}/${view.status}`);
          if (json) {
            views.push(json);
            viewKeys.push(key);
          }
          sketches.push(String(rows.length));
        } catch (error) {
          sketches.push('account-fetch-failed');
        }
      }
      return { views, viewKeys, statuses, sketches };
    },
    { session: sessionKey, keys: accountKeys },
  );
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

export function normalizeCaptured(payloads) {
  let holdings = [];
  let totalValue = null;
  let cashBalance = null;
  let totalProfitLoss = null;

  for (const payload of payloads) {
    walk(payload, (node) => {
      if (!Array.isArray(node) || node.length === 0 || node.length > 500) return;
      const rows = node.map(holdingFrom).filter(Boolean);
      if (rows.length >= 1 && rows.length >= node.length * 0.5 && rows.length > holdings.length) {
        holdings = rows;
      }
    });
    walk(payload, (node) => {
      if (Array.isArray(node)) return;
      const onlineValue = asNumber(pick(node, ['onlinevalue', 'portfoliovalue', 'totalvalue']));
      const cash = asNumber(pick(node, ['onlinecash', 'morningcash', 'cashbalance']));
      const pnl = asNumber(pick(node, ['portfoloyield', 'dailypnl', 'totalprofitloss']));
      if (onlineValue !== null) totalValue = onlineValue;
      if (cash !== null) cashBalance = cash;
      if (pnl !== null && totalProfitLoss === null) totalProfitLoss = pnl;
    });
  }

  if (totalValue === null && holdings.some((row) => row.marketValue !== null)) {
    totalValue = holdings.reduce((sum, row) => sum + (row.marketValue || 0), 0);
  }
  if (totalProfitLoss === null && holdings.some((row) => row.totalProfitLoss !== null)) {
    totalProfitLoss = holdings.reduce((sum, row) => sum + (row.totalProfitLoss || 0), 0);
  }

  return { totalValue, cashBalance, totalProfitLoss, holdings };
}

function loginUrl() {
  const raw = String(process.env.EXTRADE_LOGIN_URL || DEFAULT_LOGIN_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const err = httpError(400, 'EXTRADE_LOGIN_URL is not a valid URL.', CODES.invalidLoginUrl);
    throw err;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw httpError(400, 'EXTRADE_LOGIN_URL must be an http(s) address.', CODES.invalidLoginUrl);
  }
  return parsed;
}

async function isVisible(handle) {
  if (!handle) return false;
  return handle.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
  });
}

async function visibleError(page, password) {
  const handle = await page.$(SELECTORS.error);
  if (!handle || !(await isVisible(handle))) return '';
  const text = (await page.evaluate((element) => element.textContent || '', handle)).trim();
  if (!text) return '';
  return text.replaceAll(password, '').slice(0, 240);
}

async function detectOtp(page) {
  const single = await page.$(SELECTORS.otp);
  if (single && (await isVisible(single))) return { mode: 'single' };
  const boxes = await page.$$(SELECTORS.otpDigit);
  let visible = 0;
  for (const box of boxes) {
    if (await isVisible(box)) visible += 1;
  }
  if (visible >= 4) return { mode: 'digits', count: visible };
  return null;
}

async function fillOtp(page, code) {
  const boxes = await page.$$(SELECTORS.otpDigit);
  const visible = [];
  for (const box of boxes) {
    if (await isVisible(box)) visible.push(box);
  }
  if (visible.length >= 4) {
    const digits = code.split('');
    for (let index = 0; index < Math.min(visible.length, digits.length); index += 1) {
      await visible[index].click({ clickCount: 3 });
      await visible[index].type(digits[index], { delay: 20 });
    }
  } else {
    const field = await page.$(SELECTORS.otp);
    if (!field) throw new Error('The SMS field disappeared before the code was entered.');
    await field.click({ clickCount: 3 });
    await field.type(code, { delay: 20 });
  }
  const submit = await page.$(SELECTORS.otpSubmit);
  if (submit && (await isVisible(submit))) await submit.click();
  else await page.keyboard.press('Enter');
}

async function scrapeHoldingsFromDom(page) {
  return page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      const headers = Array.from(table.querySelectorAll('thead th, tr:first-child th, tr:first-child td')).map((cell) =>
        (cell.textContent || '').trim(),
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

async function runScrape() {
  resetRun();
  const password = String(process.env.EXTRADE_PASSWORD || '');
  const username = String(process.env.EXTRADE_USERNAME || '').trim();
  const payloads = [];
  const responsePaths = [];
  let browser = null;

  try {
    const target = loginUrl();
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    browserHandle = browser;
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(45000);
    page.setDefaultTimeout(120000);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });

    page.on('response', (response) => {
      const type = response.headers()['content-type'] || '';
      if (!type.includes('json') || response.status() >= 400) return;
      const url = response.url();
      if (!url.startsWith(target.origin)) return;
      let pathName = '';
      try {
        pathName = new URL(url).pathname;
        if (!responsePaths.includes(pathName)) responsePaths.push(pathName);
      } catch {
        /* ignore malformed urls */
      }
      response
        .text()
        .then((body) => {
          if (!body || body.length > 1_500_000) return;
          try {
            payloads.push(JSON.parse(body));
            if (payloads.length > 40) payloads.shift();
          } catch {
            /* not json */
          }
        })
        .catch(() => {});
    });

    await page.goto(target.href, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(SELECTORS.username, { timeout: 30000 });
    await page.click(SELECTORS.username, { clickCount: 3 });
    await page.type(SELECTORS.username, username, { delay: 15 });
    await page.click(SELECTORS.password, { clickCount: 3 });
    await page.type(SELECTORS.password, password, { delay: 15 });
    await page.click(SELECTORS.submit);

    const deadline = Date.now() + 20000;
    let otp = null;
    while (Date.now() < deadline) {
      try {
        const siteError = await visibleError(page, password);
        if (siteError) throw new Error(siteError);
        otp = await detectOtp(page);
        if (otp) break;
        const passwordField = await page.$(SELECTORS.password);
        const stillOnForm = passwordField && (await isVisible(passwordField));
        if (!stillOnForm && !page.url().includes('/login')) break;
      } catch (error) {
        if (!/context|destroyed|detached|navigation/i.test(error.message || '')) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (otp) {
      const code = await waitForOtp();
      await fillOtp(page, code);
    }

    const dashboard = new URL('/dashboard', target.origin).href;
    if (!page.url().includes('/dashboard')) {
      await page.goto(dashboard, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    const readyUntil = Date.now() + 10000;
    let sessionKey = null;
    let accountKeys = [];
    while (Date.now() < readyUntil && (!sessionKey || accountKeys.length === 0)) {
      sessionKey = sessionKeyFromPayloads(payloads);
      accountKeys = accountKeysFromPayloads(payloads);
      if (!sessionKey || accountKeys.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    const fetched = await fetchBalanceViews(page, sessionKey, accountKeys).catch((error) => ({
      views: [],
      statuses: [],
      failed: true,
      reason: error?.message || 'fetch failed',
    }));
    const entries = (fetched.views || []).map((body, index) => ({
      key: (fetched.viewKeys || [])[index],
      body,
    }));
    console.info(
      `investments balances session=${Boolean(sessionKey)} accounts=${accountKeys.length} views=${entries.length} rows=${(fetched.sketches || []).join(',')}${fetched.failed ? ` failed ${String(fetched.reason || '').replace(/\?.*/g, '').slice(0, 80)}` : ''}`,
    );
    const fromBalances = portfolioFromViews(entries);
    const settleUntil = Date.now() + 15000;
    let portfolio = fromBalances.holdings.length || fromBalances.totalValue !== null ? fromBalances : normalizeCaptured(payloads);
    while (Date.now() < settleUntil && portfolio.holdings.length === 0 && portfolio.totalValue === null) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      portfolio = normalizeCaptured(payloads);
    }

    if (portfolio.holdings.length === 0) {
      const table = await scrapeHoldingsFromDom(page);
      const fromDom = holdingsFromTable(table);
      if (fromDom.length > 0) portfolio = { ...portfolio, holdings: fromDom };
    }

    if (portfolio.holdings.length === 0 && portfolio.totalValue === null && portfolio.cashBalance === null) {
      const siteError = await visibleError(page, password);
      console.info(`investments paths ${responsePaths.slice(0, 20).join(' ')}`);
      throw new Error(siteError || 'Extrade Pro did not return portfolio data after login.');
    }

    finish('SUCCESS', {
      portfolio,
      error: null,
      errorCode: null,
      message: null,
    });
    console.info(`investments success holdings=${portfolio.holdings.length} cases=${portfolio.accounts?.length || 0}`);
  } catch (error) {
    finish('ERROR', {
      error: error.message || 'The investments scrape failed.',
      message: error.message || 'The investments scrape failed.',
      errorCode: error.errorCode || CODES.scrapeFailed,
      portfolio: null,
    });
    console.error(`investments failed ${state.errorCode}`);
  } finally {
    dropPendingOtp();
    running = false;
    browserHandle = null;
    if (browser) await browser.close().catch(() => {});
  }
}

export function startInvestmentsScrape() {
  if (running) {
    throw httpError(409, 'An investments scrape is already running.', CODES.alreadyRunning);
  }
  if (!hasExtradeCredentials()) {
    state.status = 'MISSING_CREDENTIALS';
    state.error = 'MISSING_CREDENTIALS';
    state.message = 'חסרים פרטי התחברות ל-Extrade Pro בקובץ .env';
    state.errorCode = CODES.missingCredentials;
    state.finishedAt = new Date().toISOString();
    console.info(`investments aborted ${CODES.missingCredentials}`);
    throw httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials, state.message);
  }

  loginUrl();
  running = true;
  void runScrape();
  return { status: 'STARTED' };
}
