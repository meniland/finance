import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CompanyTypes, createScraper } from '@sergienko4/israeli-bank-scrapers';
import { getSessionPath } from '../sessionPaths.js';

const OTP_TIMEOUT_MS = 300_000;
const AUTH_TOKEN_PATH = getSessionPath('visa-cal');
const CAL_API = 'https://api-cc.cal-online.co.il';
const CAL_LOGIN_SITE_ID = '8D37DF16-5812-4ACD-BAE7-CD1A5BFA2207';
const CAL_WEB_SITE_ID = '09031987-273E-2311-906C-8AF85B17C8D9';
const CAL_LOGIN_HEADERS = {
  accept: 'application/json',
  'content-type': 'application/json; charset=UTF-8',
  platform: 'android',
  version: '6.26.17',
  'user-agent':
    'Mozilla/5.0 (Linux; Android 11; Pixel 3 Build/RQ1A.210105.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.135 Mobile Safari/537.36',
  'x-site-id': CAL_LOGIN_SITE_ID,
};

const CODES = {
  missingCredentials: '20261117.401622',
  alreadyRunning: '20261117.401623',
  scrapeFailed: '20261117.401624',
  noPendingOtp: '20261117.401625',
  invalidDaysBack: '20261117.401627',
};

let running = false;
let pendingOtp = null;

const state = {
  status: 'IDLE',
  error: null,
  errorCode: null,
  scraperErrorType: null,
  phoneHint: null,
  accounts: null,
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

function resetRun() {
  state.status = 'SCRAPING';
  state.error = null;
  state.errorCode = null;
  state.scraperErrorType = null;
  state.phoneHint = null;
  state.accounts = null;
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

/**
 * Safety net if CAL ever asks for SMS.
 * Current VisaCal pipeline is API-direct and does not send OTP.
 */
function twoFactorRetriever(phoneHint) {
  state.status = 'AWAITING_OTP';
  state.phoneHint = phoneHint ? String(phoneHint) : null;

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
        state.phoneHint = null;
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

export function submitCalOtp(otpCode) {
  if (!pendingOtp || state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'CAL is not waiting for an SMS code.', CODES.noPendingOtp);
  }
  pendingOtp.resolve(otpCode);
}

export function hasCalCredentials() {
  return Boolean(String(process.env.CAL_USERNAME || '').trim() && String(process.env.CAL_PASSWORD || ''));
}

export function getCalState() {
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    scraperErrorType: state.scraperErrorType,
    phoneHint: state.phoneHint,
    credentialsConfigured: hasCalCredentials(),
    accounts: state.accounts,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

function resolveCredentials() {
  if (!hasCalCredentials()) {
    finish('MISSING_CREDENTIALS', {
      error: 'MISSING_CREDENTIALS',
      errorCode: CODES.missingCredentials,
      scraperErrorType: null,
      accounts: null,
    });
    state.error = 'חסרים פרטי התחברות לכאל (Visa CAL) בקובץ .env';
    throw httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials, state.error);
  }

  return {
    username: String(process.env.CAL_USERNAME || '').trim(),
    password: String(process.env.CAL_PASSWORD || ''),
  };
}

function resolveStartDate(daysBackInput) {
  const raw = daysBackInput ?? process.env.DAYS_BACK ?? '30';
  const daysBack = Number(raw);
  if (!Number.isInteger(daysBack) || daysBack < 1 || daysBack > 3650) {
    throw httpError(400, 'DAYS_BACK must be a whole number from 1 to 3650.', CODES.invalidDaysBack);
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysBack);
  return start;
}

async function readAuthToken() {
  try {
    const text = (await readFile(AUTH_TOKEN_PATH, 'utf8')).trim();
    return text || undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAuthToken(next) {
  if (!next || typeof next !== 'string') return;
  await mkdir(path.dirname(AUTH_TOKEN_PATH), { recursive: true });
  await writeFile(AUTH_TOKEN_PATH, next, { mode: 0o600 });
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeChargeDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

async function calPost(pathname, { bearer = '', body = {}, login = false } = {}) {
  const headers = login
    ? { ...CAL_LOGIN_HEADERS }
    : {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-site-id': CAL_WEB_SITE_ID,
        'User-Agent': 'Node/24 finance-local',
      };
  if (bearer) headers.Authorization = `CALAuthScheme ${bearer}`;
  const response = await fetch(`${CAL_API}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) {
    throw new Error(`CAL HTTP ${response.status} on ${pathname}`);
  }
  const json = await response.json();
  const statusCode = Number(json?.statusCode);
  if (Number.isFinite(statusCode) && statusCode !== 1) {
    throw new Error(`CAL statusCode ${statusCode} on ${pathname}`);
  }
  return json;
}

function framesFromStatus(body) {
  const result = body?.result;
  if (!result || typeof result !== 'object') return [];
  const groups = [result.calIssuedCards, result.bankIssuedCards];
  const frames = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    frames.push(...asList(group.accountLevelFrames));
    frames.push(...asList(group.cardLevelFrames));
  }
  return frames.filter((frame) => frame && typeof frame === 'object');
}

function sessionTokenFromLogin(body) {
  const result = body?.result;
  if (!result || typeof result !== 'object') return '';
  for (const key of ['calConnectToken', 'token', 'Token', 'authToken', 'sessionToken', 'accessToken']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function longTermHashFromLogin(body) {
  const result = body?.result;
  if (!result || typeof result !== 'object') return '';
  for (const key of ['hash', 'Hash', 'otpLongTermToken', 'longTermToken']) {
    const value = result[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function openCalSession(credentials, otpLongTermToken) {
  if (otpLongTermToken) {
    try {
      const warm = await calPost('/Authentication/api/login/bioLogin', {
        login: true,
        body: { hash: otpLongTermToken },
      });
      const warmToken = sessionTokenFromLogin(warm);
      const warmHash = longTermHashFromLogin(warm);
      if (warmHash) await writeAuthToken(warmHash);
      if (warmToken) return warmToken;
    } catch {
      /* fall through to cold login */
    }
  }

  const cold = await calPost('/Authentication/api/login/regularLogin', {
    login: true,
    body: {
      username: credentials.username,
      password: credentials.password,
      uuid: randomUUID(),
      newPassword: null,
    },
  });
  const coldToken = sessionTokenFromLogin(cold);
  const coldHash = longTermHashFromLogin(cold);
  if (coldHash) await writeAuthToken(coldHash);
  if (!coldToken) throw new Error('CAL login did not return a session token');
  return coldToken;
}

function nextDateFromDebitDay(day) {
  const debitDay = Number(day);
  if (!Number.isInteger(debitDay) || debitDay < 1 || debitDay > 28) return null;
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const today = Date.UTC(year, month, now.getUTCDate());
  let candidate = Date.UTC(year, month, debitDay);
  if (candidate <= today) candidate = Date.UTC(year, month + 1, debitDay);
  return new Date(candidate).toISOString();
}

async function nextChargeDatesByLast4(bearer) {
  const map = new Map();
  if (!bearer) return map;

  const init = await calPost('/Authentication/api/account/init', {
    bearer,
    body: { tokenGuid: '' },
  });
  const cards = asList(init?.result?.cards).filter(
    (card) => String(card?.cardUniqueId || '').trim() && String(card?.last4Digits || '').trim(),
  );
  if (!cards.length) return map;

  // One Frames call for every card — asking for a closed/returned card alone
  // can return CAL statusCode 112 and abort the whole lookup.
  const status = await calPost('/Frames/api/Frames/GetTotalFrameStatus', {
    bearer,
    body: {
      cardsForFrameData: cards.map((card) => ({
        cardUniqueId: String(card.cardUniqueId).trim(),
      })),
    },
  });
  const frames = framesFromStatus(status);
  const framesById = new Map(
    frames.map((frame) => [String(frame.cardUniqueId || '').trim(), frame]),
  );
  const calGroupDate = normalizeChargeDate(status?.result?.calIssuedCards?.nextTotalDebitDateForAccount);
  const bankGroupDate = normalizeChargeDate(
    status?.result?.bankIssuedCards?.nextTotalDebitDateForAccount,
  );

  for (const card of cards) {
    const cardUniqueId = String(card.cardUniqueId).trim();
    const last4 = String(card.last4Digits).trim();
    const frame = framesById.get(cardUniqueId);
    const groupDate = card.isCardCalIssuer ? calGroupDate : bankGroupDate;
    const nextChargeDate =
      normalizeChargeDate(frame?.nextDebitDate ?? frame?.nextTotalDebitDate ?? frame?.debitDate) ||
      groupDate ||
      nextDateFromDebitDay(card.currentDebitDay);
    if (nextChargeDate) map.set(last4, nextChargeDate);
  }
  return map;
}

const CURRENCY_ALIASES = {
  ILS: 'ILS',
  NIS: 'ILS',
  'שח': 'ILS',
  'ש"ח': 'ILS',
  '₪': 'ILS',
  '376': 'ILS',
  '0': 'ILS',
  USD: 'USD',
  US: 'USD',
  $: 'USD',
  '840': 'USD',
  EUR: 'EUR',
  '€': 'EUR',
  '978': 'EUR',
  GBP: 'GBP',
  '£': 'GBP',
  '826': 'GBP',
};

function normalizeCurrencyCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 'ILS';
  if (CURRENCY_ALIASES[raw]) return CURRENCY_ALIASES[raw];
  const upper = raw.toUpperCase();
  if (CURRENCY_ALIASES[upper]) return CURRENCY_ALIASES[upper];
  if (/^[A-Z]{3}$/.test(upper)) return upper;
  return upper;
}

function isIlsCurrency(value) {
  return normalizeCurrencyCode(value) === 'ILS';
}

/**
 * israeli-bank-scrapers auto-map sometimes swaps CAL FX rows:
 * chargedAmount gets the foreign figure while originalAmount gets the ILS billed amount.
 * Detect that case and restore charged=ILS / original=foreign.
 */
export function normalizeCalTxn(txn) {
  if (!txn || typeof txn !== 'object') return txn;

  let chargedAmount = Number(txn.chargedAmount);
  let originalAmount = Number(txn.originalAmount);
  const chargedOk = Number.isFinite(chargedAmount);
  const originalOk = Number.isFinite(originalAmount);
  const originalCurrency = normalizeCurrencyCode(txn.originalCurrency);

  if (
    chargedOk &&
    originalOk &&
    !isIlsCurrency(originalCurrency) &&
    Math.abs(originalAmount) > Math.abs(chargedAmount) &&
    Math.abs(chargedAmount) > 0
  ) {
    const ilsAmount = originalAmount;
    const foreignAmount = chargedAmount;
    chargedAmount = ilsAmount;
    originalAmount = foreignAmount;
  }

  return {
    date: txn.date,
    processedDate: txn.processedDate,
    description: txn.description || '',
    memo: txn.memo || '',
    chargedAmount: chargedOk ? chargedAmount : txn.chargedAmount,
    originalAmount: originalOk ? originalAmount : txn.originalAmount,
    originalCurrency,
    status: txn.status,
    type: txn.type,
    identifier: txn.identifier ?? null,
  };
}

function toPublicAccounts(accounts, chargeDates = new Map()) {
  return (accounts || []).map((account) => {
    const last4 = String(account.accountNumber || '').slice(-4);
    return {
      accountNumber: account.accountNumber,
      balance: account.balance ?? null,
      nextChargeDate: chargeDates.get(last4) || chargeDates.get(String(account.accountNumber || '')) || null,
      windowCoverage: account.windowCoverage
        ? {
            status: account.windowCoverage.status,
            reason: account.windowCoverage.reason || null,
          }
        : null,
      txns: (account.txns || []).map((txn) => normalizeCalTxn(txn)),
    };
  });
}

async function runScrape(credentials, startDate) {
  resetRun();
  try {
    const otpLongTermToken = await readAuthToken();
    let sessionBearer = '';
    const scraper = createScraper({
      companyId: CompanyTypes.VisaCal,
      startDate,
      otpCodeRetriever: twoFactorRetriever,
      otpTimeoutMs: OTP_TIMEOUT_MS,
      onAuthFlowComplete: (info) => {
        if (info?.longTermToken) {
          void writeAuthToken(info.longTermToken);
        }
        if (typeof info?.bearer === 'string' && info.bearer) {
          sessionBearer = info.bearer;
        }
      },
    });

    const scrapeInput = {
      username: credentials.username,
      password: credentials.password,
    };
    if (otpLongTermToken) scrapeInput.otpLongTermToken = otpLongTermToken;

    const result = await scraper.scrape(scrapeInput);

    if (result?.persistentOtpToken) {
      await writeAuthToken(result.persistentOtpToken);
    }

    if (!result.success) {
      finish('ERROR', {
        error: result.errorMessage || result.errorType || 'The CAL scrape failed.',
        errorCode: CODES.scrapeFailed,
        scraperErrorType: result.errorType || null,
        accounts: null,
      });
      console.error(`cal failed ${CODES.scrapeFailed} ${result.errorType || ''}`.trim());
      return;
    }

    let chargeDates = new Map();
    try {
      const storedHash = result?.persistentOtpToken || otpLongTermToken || (await readAuthToken());
      const tokenForDates = await openCalSession(credentials, storedHash);
      console.info(`cal charge-date session=${Boolean(tokenForDates)} bearerFromScrape=${Boolean(sessionBearer)}`);
      chargeDates = await nextChargeDatesByLast4(tokenForDates);
    } catch (error) {
      console.error(`cal charge-date lookup failed ${error.message}`);
    }

    const accounts = toPublicAccounts(result.accounts, chargeDates);
    finish('SUCCESS', {
      accounts,
      error: null,
      errorCode: null,
      scraperErrorType: null,
    });
    const dated = accounts.filter((account) => account.nextChargeDate).length;
    console.info(`cal success accounts=${accounts.length} chargeDates=${dated}`);
  } catch (error) {
    finish('ERROR', {
      error: error.message || 'The CAL scrape failed.',
      errorCode: CODES.scrapeFailed,
      scraperErrorType: null,
      accounts: null,
    });
    console.error(`cal failed ${CODES.scrapeFailed} ${error.message}`);
  } finally {
    dropPendingOtp();
    running = false;
  }
}

export function startCalScrape(input = {}) {
  if (running) {
    throw httpError(409, 'A CAL scrape is already running.', CODES.alreadyRunning);
  }

  const credentials = resolveCredentials();
  const startDate = resolveStartDate(input.daysBack);
  running = true;
  void runScrape(credentials, startDate);
  return { status: 'STARTED' };
}
