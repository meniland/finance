import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CompanyTypes, createScraper } from '@sergienko4/israeli-bank-scrapers';
import { getSessionPath } from './sessionPaths.js';

const OTP_TIMEOUT_MS = 300_000;
const AUTH_STATE_PATH = getSessionPath('bank');

const CODES = {
  missingCredentials: '20261116.401024',
  alreadyRunning: '20261116.401025',
  scrapeFailed: '20261116.401028',
  invalidDaysBack: '20261116.401031',
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

function httpError(status, error, errorCode) {
  const err = new Error(error);
  err.status = status;
  err.errorCode = errorCode;
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
 * Library hook for Beinleumi SMS verification.
 * The plan called this twoFactorRetriever; the package option is otpCodeRetriever.
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

export function submitOtp(otpCode) {
  if (!pendingOtp || state.status !== 'AWAITING_OTP') {
    throw httpError(409, 'The bank is not waiting for an SMS code.', '20261116.401027');
  }
  pendingOtp.resolve(otpCode);
}

export function getState() {
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    scraperErrorType: state.scraperErrorType,
    phoneHint: state.phoneHint,
    credentialsConfigured: hasBankCredentials(),
    accounts: state.accounts,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

export function hasBankCredentials() {
  return Boolean(String(process.env.BANK_USERNAME || '').trim() && String(process.env.BANK_PASSWORD || ''));
}

function resolveCredentials(input) {
  if (!hasBankCredentials()) {
    state.status = 'MISSING_CREDENTIALS';
    state.error = 'חסרים פרטי התחברות לבנק הבינלאומי בקובץ .env';
    state.errorCode = CODES.missingCredentials;
    state.finishedAt = new Date().toISOString();
    const err = httpError(400, 'MISSING_CREDENTIALS', CODES.missingCredentials);
    err.messageText = state.error;
    throw err;
  }

  const username = String(input.username || process.env.BANK_USERNAME || '').trim();
  const password = String(input.password || process.env.BANK_PASSWORD || '');
  return { username, password };
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

async function readAuthState() {
  try {
    const text = (await readFile(AUTH_STATE_PATH, 'utf8')).trim();
    return text || undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAuthState(next) {
  await mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
  await writeFile(AUTH_STATE_PATH, next, { mode: 0o600 });
}

function toPublicAccounts(accounts) {
  return (accounts || []).map((account) => ({
    accountNumber: account.accountNumber,
    balance: account.balance ?? null,
    windowCoverage: account.windowCoverage
      ? {
          status: account.windowCoverage.status,
          reason: account.windowCoverage.reason || null,
        }
      : null,
    txns: (account.txns || []).map((txn) => ({
      date: txn.date,
      processedDate: txn.processedDate,
      description: txn.description || '',
      memo: txn.memo || '',
      chargedAmount: txn.chargedAmount,
      originalAmount: txn.originalAmount,
      originalCurrency: txn.originalCurrency,
      status: txn.status,
      type: txn.type,
      identifier: txn.identifier ?? null,
    })),
  }));
}

async function runScrape(credentials, startDate) {
  resetRun();
  try {
    const persistentAuthState = await readAuthState();
    const options = {
      companyId: CompanyTypes.Beinleumi,
      startDate,
      otpCodeRetriever: twoFactorRetriever,
      otpTimeoutMs: OTP_TIMEOUT_MS,
      onPersistentAuthStateUpdate: writeAuthState,
    };
    if (persistentAuthState) {
      options.persistentAuthState = persistentAuthState;
    }

    const scraper = createScraper(options);
    const result = await scraper.scrape({
      username: credentials.username,
      password: credentials.password,
    });

    if (!result.success) {
      finish('ERROR', {
        error: result.errorMessage || result.errorType || 'The bank scrape failed.',
        errorCode: CODES.scrapeFailed,
        scraperErrorType: result.errorType || null,
        accounts: null,
      });
      console.error(`scrape failed ${CODES.scrapeFailed} ${result.errorType || ''}`.trim());
      return;
    }

    finish('SUCCESS', {
      accounts: toPublicAccounts(result.accounts),
      error: null,
      errorCode: null,
      scraperErrorType: null,
    });
    console.info(`scrape success accounts=${state.accounts.length}`);
  } catch (error) {
    finish('ERROR', {
      error: error.message || 'The bank scrape failed.',
      errorCode: CODES.scrapeFailed,
      scraperErrorType: null,
      accounts: null,
    });
    console.error(`scrape failed ${CODES.scrapeFailed} ${error.message}`);
  } finally {
    dropPendingOtp();
    running = false;
  }
}

export function startScrape(input = {}) {
  if (running) {
    throw httpError(409, 'A scrape is already running.', CODES.alreadyRunning);
  }

  const credentials = resolveCredentials(input);
  const startDate = resolveStartDate(input.daysBack);
  running = true;
  void runScrape(credentials, startDate);
  return { status: 'STARTED' };
}
