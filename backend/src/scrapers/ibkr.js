import { XMLParser } from 'fast-xml-parser';

const SEND_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const GET_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
const USER_AGENT = 'Node/24 finance-local';
const INITIAL_WAIT_MS = 3000;
const RETRY_WAIT_MS = 2500;
const MAX_FETCH_ATTEMPTS = 8;

const CODES = {
  missingCredentials: '20261117.401527',
  alreadyRunning: '20261117.401528',
  syncFailed: '20261117.401529',
  triggerFailed: '20261117.401530',
};

const RETRYABLE_ERROR_CODES = new Set(['1001', '1004', '1005', '1006', '1007', '1008', '1009', '1018', '1021']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

let running = false;

const state = {
  status: 'IDLE',
  error: null,
  errorCode: null,
  message: null,
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

export function hasIbkrCredentials() {
  return Boolean(String(process.env.IBKR_FLEX_TOKEN || '').trim() && String(process.env.IBKR_QUERY_ID || '').trim());
}

export function getIbkrState() {
  return {
    status: state.status,
    error: state.error,
    errorCode: state.errorCode,
    message: state.message,
    credentialsConfigured: hasIbkrCredentials(),
    portfolio: state.portfolio,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

function resetRun() {
  state.status = 'SYNCING';
  state.error = null;
  state.errorCode = null;
  state.message = null;
  state.portfolio = null;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
}

function finish(status, extra = {}) {
  state.status = status;
  state.finishedAt = new Date().toISOString();
  Object.assign(state, extra);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/,/g, '').trim();
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickField(row, ...keys) {
  if (!row || typeof row !== 'object') return undefined;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return undefined;
}

async function fetchXml(url, params) {
  const target = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    target.searchParams.set(key, String(value));
  }
  const response = await fetch(target, {
    headers: {
      Accept: 'application/xml, text/xml, */*',
      'User-Agent': USER_AGENT,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`IBKR Flex HTTP ${response.status}`);
  }
  return { text, parsed: parser.parse(text) };
}

function flexResponseRoot(parsed) {
  return parsed?.FlexStatementResponse || parsed?.FlexQueryResponse || parsed || {};
}

function extractReferenceCode(parsed) {
  const root = flexResponseRoot(parsed);
  const status = String(root.Status || '').trim();
  if (status && status.toLowerCase() !== 'success') {
    const code = String(root.ErrorCode || root.errorCode || '').trim();
    const message = String(root.ErrorMessage || root.errorMessage || root.Status || 'Flex SendRequest failed').trim();
    const err = new Error(message);
    err.errorCode = CODES.triggerFailed;
    err.ibkrCode = code;
    throw err;
  }
  const reference = String(root.ReferenceCode || root.referenceCode || '').trim();
  if (!reference) {
    const err = new Error('IBKR Flex did not return a ReferenceCode.');
    err.errorCode = CODES.triggerFailed;
    throw err;
  }
  return reference;
}

function isRetryableStatement(parsed, text) {
  const root = flexResponseRoot(parsed);
  const status = String(root.Status || '').trim().toLowerCase();
  if (status === 'success') return false;
  if (status === 'warn' || status === 'fail' || status === 'failure') {
    const code = String(root.ErrorCode || root.errorCode || '').trim();
    return RETRYABLE_ERROR_CODES.has(code);
  }
  if (/FlexStatementResponse/i.test(text) && /ErrorCode/i.test(text)) {
    const code = String(root.ErrorCode || root.errorCode || '').trim();
    return RETRYABLE_ERROR_CODES.has(code);
  }
  return false;
}

function statementError(parsed) {
  const root = flexResponseRoot(parsed);
  const code = String(root.ErrorCode || root.errorCode || '').trim();
  const message = String(root.ErrorMessage || root.errorMessage || 'IBKR Flex GetStatement failed').trim();
  const err = new Error(code ? `${message} (${code})` : message);
  err.errorCode = CODES.syncFailed;
  err.ibkrCode = code;
  return err;
}

function findNodes(node, name, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, name, out);
    return out;
  }
  if (Object.prototype.hasOwnProperty.call(node, name)) {
    out.push(...asList(node[name]));
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') findNodes(value, name, out);
  }
  return out;
}

function accountIdFrom(row, fallback = '') {
  const raw = pickField(row, 'accountId', 'AccountId', 'accountID', 'acctId', 'AcctId');
  const text = String(raw || fallback || '').trim();
  return text || '';
}

function normalizeOpenPosition(row) {
  const symbol = String(pickField(row, 'symbol', 'Symbol', 'ticker', 'Ticker') || '').trim();
  const description = String(pickField(row, 'description', 'Description', 'name', 'Name') || '').trim();
  const quantity = asNumber(pickField(row, 'position', 'Position', 'quantity', 'Quantity'));
  const markPrice = asNumber(pickField(row, 'markPrice', 'MarkPrice', 'closePrice', 'ClosePrice'));
  const positionValue = asNumber(pickField(row, 'positionValue', 'PositionValue', 'marketValue', 'MarketValue'));
  const fifoPnlUnrealized = asNumber(
    pickField(row, 'fifoPnlUnrealized', 'FifoPnlUnrealized', 'fifoPnLUnrealized', 'unrealizedPnl', 'UnrealizedPnL'),
  );
  const currency = String(pickField(row, 'currency', 'Currency') || '').trim() || null;
  if (!symbol && !description) return null;
  if (quantity === null && positionValue === null) return null;
  return {
    symbol,
    description,
    quantity,
    markPrice,
    positionValue,
    fifoPnlUnrealized,
    currency,
  };
}

function cashFromRows(rows) {
  const list = asList(rows).filter(Boolean);
  let base = list.find((row) => String(pickField(row, 'currency', 'Currency') || '').toUpperCase() === 'BASE_SUMMARY');
  if (!base) base = list.find((row) => String(pickField(row, 'currency', 'Currency') || '').toUpperCase() === 'BASE');
  if (!base && list.length === 1) base = list[0];
  if (!base) {
    const nonSummary = list.filter((row) => {
      const currency = String(pickField(row, 'currency', 'Currency') || '').toUpperCase();
      return currency && currency !== 'BASE_SUMMARY' && currency !== 'BASE';
    });
    if (nonSummary.length === 1) base = nonSummary[0];
  }
  if (!base) return { cashBalance: null, currency: null };
  return {
    cashBalance: asNumber(
      pickField(base, 'endingCash', 'EndingCash', 'endingSettledCash', 'EndingSettledCash', 'cash', 'Cash'),
    ),
    currency: String(pickField(base, 'currency', 'Currency') || '').trim() || null,
  };
}

function equityFromRows(rows) {
  const list = asList(rows).filter(Boolean);
  if (list.length === 0) return { totalValue: null, cashBalance: null };
  const latest = list[list.length - 1];
  return {
    totalValue: asNumber(pickField(latest, 'total', 'Total', 'totalLong', 'TotalLong', 'equity', 'Equity')),
    cashBalance: asNumber(pickField(latest, 'cash', 'Cash', 'totalCash', 'TotalCash')),
  };
}

function portfolioFromParts({ id, holdings, cashRows, equityRows }) {
  const cash = cashFromRows(cashRows);
  const equity = equityFromRows(equityRows);
  let totalValue = equity.totalValue;
  let cashBalance = equity.cashBalance ?? cash.cashBalance;
  const currency =
    cash.currency && cash.currency.toUpperCase() !== 'BASE_SUMMARY' && cash.currency.toUpperCase() !== 'BASE'
      ? cash.currency
      : holdings.find((row) => row.currency)?.currency || null;

  if (totalValue === null && holdings.some((row) => row.positionValue !== null)) {
    totalValue = holdings.reduce((sum, row) => sum + (row.positionValue || 0), 0);
    if (cashBalance !== null) totalValue += cashBalance;
  }

  return {
    id,
    totalValue,
    cashBalance,
    currency,
    holdings,
  };
}

function statementsFromParsed(parsed) {
  const statements = findNodes(parsed, 'FlexStatement');
  if (statements.length > 0) return statements;

  const root = parsed?.FlexQueryResponse || parsed;
  const wrapped = root?.FlexStatements?.FlexStatement;
  return asList(wrapped).filter(Boolean);
}

function ensureBucket(map, id) {
  if (!map.has(id)) {
    map.set(id, { id, holdings: [], cashRows: [], equityRows: [] });
  }
  return map.get(id);
}

export function normalizeFlexStatement(parsed) {
  const byAccount = new Map();
  const statements = statementsFromParsed(parsed);

  if (statements.length > 0) {
    for (const statement of statements) {
      const id = accountIdFrom(statement) || 'unknown';
      const bucket = ensureBucket(byAccount, id);
      bucket.holdings.push(
        ...asList(statement?.OpenPositions?.OpenPosition || statement?.OpenPosition)
          .map(normalizeOpenPosition)
          .filter(Boolean),
      );
      bucket.cashRows.push(...asList(statement?.CashReport?.CashReportCurrency || statement?.CashReportCurrency));
      bucket.equityRows.push(
        ...asList(
          statement?.EquitySummaryInBase?.EquitySummaryByReportDateInBase ||
            statement?.EquitySummaryByReportDateInBase,
        ),
      );
    }
  } else {
    for (const row of findNodes(parsed, 'OpenPosition')) {
      const id = accountIdFrom(row) || 'unknown';
      ensureBucket(byAccount, id).holdings.push(...[normalizeOpenPosition(row)].filter(Boolean));
    }
    for (const row of findNodes(parsed, 'CashReportCurrency')) {
      const id = accountIdFrom(row) || 'unknown';
      ensureBucket(byAccount, id).cashRows.push(row);
    }
    for (const row of findNodes(parsed, 'EquitySummaryByReportDateInBase')) {
      const id = accountIdFrom(row) || 'unknown';
      ensureBucket(byAccount, id).equityRows.push(row);
    }
  }

  if (byAccount.size === 0) {
    return {
      totalValue: null,
      cashBalance: null,
      currency: null,
      holdings: [],
      accounts: [],
    };
  }

  if (byAccount.size === 1 && byAccount.has('unknown')) {
    const only = byAccount.get('unknown');
    only.holdings = findNodes(parsed, 'OpenPosition').map(normalizeOpenPosition).filter(Boolean);
    only.cashRows = findNodes(parsed, 'CashReportCurrency');
    only.equityRows = findNodes(parsed, 'EquitySummaryByReportDateInBase');
  }

  const accounts = [...byAccount.values()]
    .map((bucket) => portfolioFromParts(bucket))
    .filter(
      (account) =>
        account.holdings.length > 0 || account.totalValue !== null || account.cashBalance !== null || account.id !== 'unknown',
    )
    .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));

  const holdings = [];
  let totalValue = 0;
  let cashBalance = 0;
  let sawValue = false;
  let sawCash = false;
  let currency = null;

  for (const account of accounts) {
    if (account.totalValue !== null) {
      totalValue += account.totalValue;
      sawValue = true;
    }
    if (account.cashBalance !== null) {
      cashBalance += account.cashBalance;
      sawCash = true;
    }
    if (!currency && account.currency) currency = account.currency;
    holdings.push(...account.holdings);
  }

  return {
    totalValue: sawValue ? totalValue : null,
    cashBalance: sawCash ? cashBalance : null,
    currency,
    holdings,
    accounts,
  };
}

async function triggerReport(token, queryId) {
  const { parsed } = await fetchXml(SEND_URL, { t: token, q: queryId, v: '3' });
  return extractReferenceCode(parsed);
}

async function fetchReport(token, referenceCode) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    const { text, parsed } = await fetchXml(GET_URL, { t: token, q: referenceCode, v: '3' });
    if (isRetryableStatement(parsed, text)) {
      lastError = statementError(parsed);
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    const root = flexResponseRoot(parsed);
    const status = String(root.Status || '').trim().toLowerCase();
    if (status === 'fail' || status === 'failure' || status === 'warn') {
      throw statementError(parsed);
    }
    if (parsed?.FlexQueryResponse || findNodes(parsed, 'OpenPosition').length || findNodes(parsed, 'CashReportCurrency').length) {
      return parsed;
    }
    if (parsed?.FlexStatementResponse) {
      lastError = statementError(parsed);
      await sleep(RETRY_WAIT_MS);
      continue;
    }
    return parsed;
  }
  throw lastError || new Error('IBKR Flex report was not ready in time.');
}

export function startIbkrSync() {
  if (!hasIbkrCredentials()) {
    finish('MISSING_CREDENTIALS', {
      error: 'MISSING_CREDENTIALS',
      message: 'חסרים פרטי התחברות ל-Interactive Brokers בקובץ .env',
      errorCode: CODES.missingCredentials,
      portfolio: null,
    });
    throw httpError(
      400,
      'MISSING_CREDENTIALS',
      CODES.missingCredentials,
      'חסרים פרטי התחברות ל-Interactive Brokers בקובץ .env',
    );
  }
  if (running) {
    throw httpError(409, 'An Interactive Brokers sync is already running.', CODES.alreadyRunning);
  }

  const token = String(process.env.IBKR_FLEX_TOKEN || '').trim();
  const queryId = String(process.env.IBKR_QUERY_ID || '').trim();
  running = true;
  resetRun();

  (async () => {
    try {
      const referenceCode = await triggerReport(token, queryId);
      await sleep(INITIAL_WAIT_MS);
      const statement = await fetchReport(token, referenceCode);
      const portfolio = normalizeFlexStatement(statement);
      if (
        portfolio.holdings.length === 0 &&
        portfolio.totalValue === null &&
        portfolio.cashBalance === null
      ) {
        throw new Error('Interactive Brokers Flex report did not include portfolio data.');
      }
      finish('SUCCESS', {
        portfolio,
        error: null,
        errorCode: null,
        message: null,
      });
      console.info(`ibkr success holdings=${portfolio.holdings.length} cases=${portfolio.accounts?.length || 0}`);
    } catch (error) {
      finish('ERROR', {
        error: error.message || 'The Interactive Brokers sync failed.',
        message: error.message || 'The Interactive Brokers sync failed.',
        errorCode: error.errorCode || CODES.syncFailed,
        portfolio: null,
      });
      console.error(`ibkr failed ${state.errorCode}`);
    } finally {
      running = false;
    }
  })();

  return { status: 'STARTED' };
}
