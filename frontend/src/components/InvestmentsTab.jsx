import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, LineChart, Loader2, Search } from 'lucide-react';
import { request } from '../api.js';
import CredentialsBanner from './CredentialsBanner.jsx';

const EXTRADE_ACTIVE = new Set(['SCRAPING', 'AWAITING_OTP']);
const IBKR_ACTIVE = new Set(['SYNCING']);
const MEITAV_ACTIVE = new Set(['SCRAPING', 'AWAITING_OTP']);

const moneyIls = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 2,
});

const percent = new Intl.NumberFormat('he-IL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const STATUS_LABEL = {
  IDLE: 'ממתין',
  SCRAPING: 'שולף',
  SYNCING: 'מסנכרן',
  AWAITING_OTP: 'נדרש קוד SMS',
  SUCCESS: 'מוכן',
  ERROR: 'נכשל',
  MISSING_CREDENTIALS: 'חסרים פרטים',
};

function formatMoney(value, currency = 'ILS') {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? currency : 'ILS';
  try {
    return new Intl.NumberFormat('he-IL', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(Number(value));
  } catch {
    return moneyIls.format(Number(value));
  }
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  const amount = Number(value);
  return `${amount > 0 ? '+' : ''}${percent.format(amount)}%`;
}

function amountClass(value) {
  const amount = Number(value);
  if (Number.isNaN(amount) || amount === 0) return 'text-ink';
  return amount > 0 ? 'text-credit' : 'text-danger';
}

function compareValues(left, right, key) {
  if (
    [
      'quantity',
      'lastPrice',
      'marketValue',
      'dailyChangePercent',
      'totalProfitLoss',
      'markPrice',
      'positionValue',
      'fifoPnlUnrealized',
    ].includes(key)
  ) {
    return Number(left[key] || 0) - Number(right[key] || 0);
  }
  return String(left[key] || '').localeCompare(String(right[key] || ''), 'he');
}

export default function InvestmentsTab() {
  const [broker, setBroker] = useState('extrade');
  const [snapshot, setSnapshot] = useState({
    status: 'IDLE',
    portfolio: null,
    error: null,
    errorCode: null,
    credentialsConfigured: undefined,
  });
  const [ibkrSnapshot, setIbkrSnapshot] = useState({
    status: 'IDLE',
    portfolio: null,
    error: null,
    errorCode: null,
    credentialsConfigured: undefined,
  });
  const [meitavSnapshot, setMeitavSnapshot] = useState({
    status: 'IDLE',
    portfolio: null,
    error: null,
    errorCode: null,
    credentialsConfigured: undefined,
    phoneHint: null,
  });
  const [watch, setWatch] = useState(0);
  const [ibkrWatch, setIbkrWatch] = useState(0);
  const [meitavWatch, setMeitavWatch] = useState(0);
  const [actionError, setActionError] = useState('');
  const [ibkrActionError, setIbkrActionError] = useState('');
  const [meitavActionError, setMeitavActionError] = useState('');
  const [starting, setStarting] = useState(false);
  const [ibkrStarting, setIbkrStarting] = useState(false);
  const [meitavStarting, setMeitavStarting] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [meitavOtpCode, setMeitavOtpCode] = useState('');
  const [submittingOtp, setSubmittingOtp] = useState(false);
  const [meitavSubmittingOtp, setMeitavSubmittingOtp] = useState(false);
  const [query, setQuery] = useState('');
  const [ibkrQuery, setIbkrQuery] = useState('');
  const [meitavQuery, setMeitavQuery] = useState('');
  const [sortKey, setSortKey] = useState('marketValue');
  const [sortDir, setSortDir] = useState('desc');
  const [ibkrSortKey, setIbkrSortKey] = useState('positionValue');
  const [ibkrSortDir, setIbkrSortDir] = useState('desc');
  const [meitavSortKey, setMeitavSortKey] = useState('marketValue');
  const [meitavSortDir, setMeitavSortDir] = useState('desc');
  const [caseId, setCaseId] = useState('all');
  const [ibkrCaseId, setIbkrCaseId] = useState('all');
  const [meitavCaseId, setMeitavCaseId] = useState('all');

  useEffect(() => {
    let stop = false;
    let timer;

    const tick = async () => {
      try {
        const data = await request('/api/investments/status');
        if (stop) return;
        setSnapshot(data);
        if (EXTRADE_ACTIVE.has(data.status)) timer = setTimeout(tick, 2000);
      } catch (error) {
        if (stop) return;
        setActionError(error.message);
        timer = setTimeout(tick, 2000);
      }
    };

    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [watch]);

  useEffect(() => {
    let stop = false;
    let timer;

    const tick = async () => {
      try {
        const data = await request('/api/investments/ibkr/status');
        if (stop) return;
        setIbkrSnapshot(data);
        if (IBKR_ACTIVE.has(data.status)) timer = setTimeout(tick, 2000);
      } catch (error) {
        if (stop) return;
        setIbkrActionError(error.message);
        timer = setTimeout(tick, 2000);
      }
    };

    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [ibkrWatch]);

  useEffect(() => {
    let stop = false;
    let timer;

    const tick = async () => {
      try {
        const data = await request('/api/investments/meitav/status');
        if (stop) return;
        setMeitavSnapshot(data);
        if (MEITAV_ACTIVE.has(data.status)) timer = setTimeout(tick, 2000);
      } catch (error) {
        if (stop) return;
        setMeitavActionError(error.message);
        timer = setTimeout(tick, 2000);
      }
    };

    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [meitavWatch]);

  const portfolio = snapshot.portfolio;
  const accounts = portfolio?.accounts || [];
  const activeCase = accounts.some((account) => account.id === caseId) ? caseId : 'all';
  const shown = activeCase === 'all' ? portfolio : accounts.find((account) => account.id === activeCase);
  const holdings = shown?.holdings || [];
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? holdings.filter((row) => `${row.name} ${row.symbol}`.toLowerCase().includes(needle))
      : holdings;
    return [...filtered].sort((left, right) => {
      const result = compareValues(left, right, sortKey);
      return sortDir === 'asc' ? result : -result;
    });
  }, [holdings, query, sortKey, sortDir]);

  const ibkrPortfolio = ibkrSnapshot.portfolio;
  const ibkrAccounts = ibkrPortfolio?.accounts || [];
  const activeIbkrCase = ibkrAccounts.some((account) => account.id === ibkrCaseId) ? ibkrCaseId : 'all';
  const ibkrShown = activeIbkrCase === 'all' ? ibkrPortfolio : ibkrAccounts.find((account) => account.id === activeIbkrCase);
  const ibkrHoldings = ibkrShown?.holdings || [];
  const ibkrRows = useMemo(() => {
    const needle = ibkrQuery.trim().toLowerCase();
    const filtered = needle
      ? ibkrHoldings.filter((row) => `${row.description || ''} ${row.symbol || ''}`.toLowerCase().includes(needle))
      : ibkrHoldings;
    return [...filtered].sort((left, right) => {
      const result = compareValues(left, right, ibkrSortKey);
      return ibkrSortDir === 'asc' ? result : -result;
    });
  }, [ibkrHoldings, ibkrQuery, ibkrSortKey, ibkrSortDir]);

  const meitavPortfolio = meitavSnapshot.portfolio;
  const meitavAccounts = meitavPortfolio?.accounts || [];
  const activeMeitavCase = meitavAccounts.some((account) => account.id === meitavCaseId) ? meitavCaseId : 'all';
  const meitavShown =
    activeMeitavCase === 'all' ? meitavPortfolio : meitavAccounts.find((account) => account.id === activeMeitavCase);
  const meitavHoldings = meitavShown?.holdings || [];
  const meitavRows = useMemo(() => {
    const needle = meitavQuery.trim().toLowerCase();
    const filtered = needle
      ? meitavHoldings.filter((row) => `${row.name || ''} ${row.symbol || ''}`.toLowerCase().includes(needle))
      : meitavHoldings;
    return [...filtered].sort((left, right) => {
      const result = compareValues(left, right, meitavSortKey);
      return meitavSortDir === 'asc' ? result : -result;
    });
  }, [meitavHoldings, meitavQuery, meitavSortKey, meitavSortDir]);

  const missingCredentials = snapshot.credentialsConfigured === false || snapshot.status === 'MISSING_CREDENTIALS';
  const ibkrMissingCredentials =
    ibkrSnapshot.credentialsConfigured === false || ibkrSnapshot.status === 'MISSING_CREDENTIALS';
  const meitavMissingCredentials =
    meitavSnapshot.credentialsConfigured === false || meitavSnapshot.status === 'MISSING_CREDENTIALS';
  const busy = starting || EXTRADE_ACTIVE.has(snapshot.status);
  const ibkrBusy = ibkrStarting || IBKR_ACTIVE.has(ibkrSnapshot.status);
  const meitavBusy = meitavStarting || MEITAV_ACTIVE.has(meitavSnapshot.status);
  const activeSnapshot =
    broker === 'ibkr' ? ibkrSnapshot : broker === 'meitav' ? meitavSnapshot : snapshot;
  const activeBusySet = broker === 'ibkr' ? IBKR_ACTIVE : broker === 'meitav' ? MEITAV_ACTIVE : EXTRADE_ACTIVE;

  async function fetchInvestments() {
    const previousStatus = snapshot.status;
    setActionError('');
    setStarting(true);
    setSnapshot((current) => ({ ...current, status: 'SCRAPING', error: null, errorCode: null }));
    try {
      await request('/api/investments/scrape', { method: 'POST', body: '{}' });
      setWatch((value) => value + 1);
    } catch (error) {
      if (error.code === 'MISSING_CREDENTIALS') {
        setSnapshot((current) => ({
          ...current,
          status: 'MISSING_CREDENTIALS',
          credentialsConfigured: false,
          error: error.message,
        }));
        return;
      }
      setActionError(error.message);
      setSnapshot((current) => ({ ...current, status: previousStatus }));
    } finally {
      setStarting(false);
    }
  }

  async function syncIbkr() {
    const previousStatus = ibkrSnapshot.status;
    setIbkrActionError('');
    setIbkrStarting(true);
    setIbkrSnapshot((current) => ({ ...current, status: 'SYNCING', error: null, errorCode: null }));
    try {
      await request('/api/investments/ibkr/sync', { method: 'POST', body: '{}' });
      setIbkrWatch((value) => value + 1);
    } catch (error) {
      if (error.code === 'MISSING_CREDENTIALS') {
        setIbkrSnapshot((current) => ({
          ...current,
          status: 'MISSING_CREDENTIALS',
          credentialsConfigured: false,
          error: error.message,
        }));
        return;
      }
      setIbkrActionError(error.message);
      setIbkrSnapshot((current) => ({ ...current, status: previousStatus }));
    } finally {
      setIbkrStarting(false);
    }
  }

  async function submitCode(event) {
    event.preventDefault();
    setActionError('');
    setSubmittingOtp(true);
    try {
      await request('/api/investments/otp', {
        method: 'POST',
        body: JSON.stringify({ otpCode: otpCode.trim() }),
      });
      setOtpCode('');
      setWatch((value) => value + 1);
    } catch (error) {
      setActionError(error.message);
    } finally {
      setSubmittingOtp(false);
    }
  }

  async function fetchMeitav() {
    const previousStatus = meitavSnapshot.status;
    setMeitavActionError('');
    setMeitavStarting(true);
    setMeitavSnapshot((current) => ({ ...current, status: 'SCRAPING', error: null, errorCode: null }));
    try {
      await request('/api/investments/meitav/scrape', { method: 'POST', body: '{}' });
      setMeitavWatch((value) => value + 1);
    } catch (error) {
      if (error.code === 'MISSING_CREDENTIALS') {
        setMeitavSnapshot((current) => ({
          ...current,
          status: 'MISSING_CREDENTIALS',
          credentialsConfigured: false,
          error: error.message,
        }));
        return;
      }
      setMeitavActionError(error.message);
      setMeitavSnapshot((current) => ({ ...current, status: previousStatus }));
    } finally {
      setMeitavStarting(false);
    }
  }

  async function submitMeitavCode(event) {
    event.preventDefault();
    setMeitavActionError('');
    setMeitavSubmittingOtp(true);
    try {
      await request('/api/investments/meitav/otp', {
        method: 'POST',
        body: JSON.stringify({ otpCode: meitavOtpCode.trim() }),
      });
      setMeitavOtpCode('');
      setMeitavWatch((value) => value + 1);
    } catch (error) {
      setMeitavActionError(error.message);
    } finally {
      setMeitavSubmittingOtp(false);
    }
  }

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(key === 'name' ? 'asc' : 'desc');
  }

  function toggleIbkrSort(key) {
    if (ibkrSortKey === key) {
      setIbkrSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setIbkrSortKey(key);
    setIbkrSortDir(key === 'description' || key === 'symbol' ? 'asc' : 'desc');
  }

  function toggleMeitavSort(key) {
    if (meitavSortKey === key) {
      setMeitavSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setMeitavSortKey(key);
    setMeitavSortDir(key === 'name' ? 'asc' : 'desc');
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-teal">השקעות</p>
          <h2 className="font-display text-4xl font-semibold tracking-tight text-ink">תיקי השקעות</h2>
          <p className="mt-2 max-w-xl text-sm text-muted">שווי התיק, המזומן והאחזקות נשארים על המחשב הזה.</p>
        </div>
        <p
          className={`rounded-full px-3 py-1 text-sm font-medium ${
            activeSnapshot.status === 'ERROR' || activeSnapshot.status === 'MISSING_CREDENTIALS'
              ? 'bg-danger/10 text-danger'
              : activeSnapshot.status === 'SUCCESS'
                ? 'bg-credit/10 text-credit'
                : activeSnapshot.status === 'AWAITING_OTP' || activeSnapshot.status === 'SYNCING'
                  ? 'bg-teal/10 text-teal'
                  : 'bg-ink/5 text-ink'
          }`}
          aria-live="polite"
        >
          {STATUS_LABEL[activeSnapshot.status] || activeSnapshot.status}
          {activeBusySet.has(activeSnapshot.status) ? ' · בדיקה כל 2 שניות' : ''}
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="ברוקרים">
        <CaseTab selected={broker === 'extrade'} onClick={() => setBroker('extrade')}>
          Extrade Pro
        </CaseTab>
        <CaseTab selected={broker === 'ibkr'} onClick={() => setBroker('ibkr')}>
          Interactive Brokers
        </CaseTab>
        <CaseTab selected={broker === 'meitav'} onClick={() => setBroker('meitav')}>
          מיטב טרייד
        </CaseTab>
      </nav>

      {broker === 'extrade' ? (
        <>
          {missingCredentials ? <CredentialsBanner /> : null}

          <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
                  <LineChart size={20} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">שליפת תיק</h3>
                  <p className="text-sm text-muted">התחברות ל-Extrade Pro עם הפרטים שבקובץ .env.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={fetchInvestments}
                disabled={busy || missingCredentials}
                className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : null}
                שלוף נתוני השקעות (Extrade Pro)
              </button>
            </div>
            {(actionError || snapshot.status === 'ERROR') && (
              <p className="mt-4 rounded-2xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                {actionError || snapshot.message || snapshot.error}
                {snapshot.errorCode && !actionError ? ` (${snapshot.errorCode})` : ''}
              </p>
            )}
          </section>

          {snapshot.status === 'AWAITING_OTP' && (
            <section className="rounded-3xl border border-teal/30 bg-teal/10 p-5" aria-live="polite">
              <h3 className="text-lg font-semibold">קוד SMS</h3>
              <p className="mt-1 text-sm text-muted">הזינו את הקוד שנשלח לטלפון כדי להמשיך את ההתחברות.</p>
              <form onSubmit={submitCode} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
                  קוד חד-פעמי
                  <input
                    value={otpCode}
                    onChange={(event) => setOtpCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{4,10}"
                    maxLength={10}
                    required
                    dir="ltr"
                    className="rounded-2xl border border-line bg-card px-4 py-2.5 text-lg tracking-[0.3em] outline-none focus:border-teal"
                  />
                </label>
                <button
                  type="submit"
                  disabled={submittingOtp}
                  className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-card disabled:opacity-60"
                >
                  {submittingOtp ? 'שולח…' : 'שליחת קוד'}
                </button>
              </form>
            </section>
          )}

          {snapshot.status === 'SUCCESS' && shown && (
            <>
              {accounts.length > 0 && (
                <nav className="flex flex-wrap gap-2" aria-label="תיקים">
                  <CaseTab selected={activeCase === 'all'} onClick={() => setCaseId('all')}>
                    הכל
                  </CaseTab>
                  {accounts.map((account) => (
                    <CaseTab key={account.id} selected={activeCase === account.id} onClick={() => setCaseId(account.id)}>
                      <span dir="ltr">{account.id}</span>
                    </CaseTab>
                  ))}
                </nav>
              )}
              <section className="grid gap-4 sm:grid-cols-3">
                <Kpi label="שווי תיק כולל" value={formatMoney(shown.totalValue)} />
                <Kpi label="יתרת מזומן" value={formatMoney(shown.cashBalance)} />
                <Kpi
                  label="רווח/הפסד כולל"
                  value={formatMoney(shown.totalProfitLoss)}
                  tone={amountClass(shown.totalProfitLoss)}
                />
              </section>
              <section className="rounded-3xl border border-line bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold">אחזקות</h3>
                  <label className="relative min-w-56 flex-1 sm:max-w-xs">
                    <span className="sr-only">חיפוש נייר</span>
                    <Search size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="חיפוש לפי שם או סימול"
                      className="w-full rounded-full border border-line bg-paper py-2 pr-9 pl-4 text-sm outline-none focus:border-teal"
                    />
                  </label>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs tracking-wide text-muted">
                        <SortHeader label="שם נייר / סימול" column="name" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHeader label="כמות" column="quantity" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHeader label="שער אחרון" column="lastPrice" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHeader label="שווי שוק" column="marketValue" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                        <SortHeader
                          label="שינוי יומי %"
                          column="dailyChangePercent"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={toggleSort}
                        />
                        <SortHeader
                          label="רווח/הפסד"
                          column="totalProfitLoss"
                          sortKey={sortKey}
                          sortDir={sortDir}
                          onSort={toggleSort}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-muted">
                            אין אחזקות להצגה.
                          </td>
                        </tr>
                      )}
                      {rows.map((row, index) => (
                        <tr key={`${activeCase}-${index}-${row.symbol}-${row.name}`} className="border-b border-line/80">
                          <td className="py-3 pl-4">
                            <div className="font-medium">{row.name || '—'}</div>
                            {row.symbol ? (
                              <div className="text-xs text-muted" dir="ltr">
                                {row.symbol}
                              </div>
                            ) : null}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {row.quantity ?? '—'}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {formatMoney(row.lastPrice)}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {formatMoney(row.marketValue)}
                          </td>
                          <td className={`py-3 text-left tabular-nums ${amountClass(row.dailyChangePercent)}`} dir="ltr">
                            {formatPercent(row.dailyChangePercent)}
                          </td>
                          <td className={`py-3 text-left font-medium tabular-nums ${amountClass(row.totalProfitLoss)}`} dir="ltr">
                            {formatMoney(row.totalProfitLoss)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      ) : broker === 'ibkr' ? (
        <>
          {ibkrMissingCredentials ? (
            <CredentialsBanner message="לא הוגדרו פרטי Interactive Brokers בקובץ .env – יש להזין IBKR_FLEX_TOKEN ו-IBKR_QUERY_ID ולהפעיל מחדש את השרת." />
          ) : null}

          <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
                  <LineChart size={20} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">סנכרון Flex</h3>
                  <p className="text-sm text-muted">שליפת דוח Flex מ-Interactive Brokers דרך ה-API הרשמי.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={syncIbkr}
                disabled={ibkrBusy || ibkrMissingCredentials}
                className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {ibkrBusy ? <Loader2 size={16} className="animate-spin" /> : null}
                סנכרן Interactive Brokers
              </button>
            </div>
            {(ibkrActionError || ibkrSnapshot.status === 'ERROR') && (
              <p className="mt-4 rounded-2xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                {ibkrActionError || ibkrSnapshot.message || ibkrSnapshot.error}
                {ibkrSnapshot.errorCode && !ibkrActionError ? ` (${ibkrSnapshot.errorCode})` : ''}
              </p>
            )}
          </section>

          {ibkrSnapshot.status === 'SUCCESS' && ibkrShown && (
            <>
              {ibkrAccounts.length > 0 && (
                <nav className="flex flex-wrap gap-2" aria-label="חשבונות IBKR">
                  <CaseTab selected={activeIbkrCase === 'all'} onClick={() => setIbkrCaseId('all')}>
                    הכל
                  </CaseTab>
                  {ibkrAccounts.map((account) => (
                    <CaseTab
                      key={account.id}
                      selected={activeIbkrCase === account.id}
                      onClick={() => setIbkrCaseId(account.id)}
                    >
                      <span dir="ltr">{account.id}</span>
                    </CaseTab>
                  ))}
                </nav>
              )}
              <section className="grid gap-4 sm:grid-cols-2">
                <Kpi label="שווי תיק כולל (NAV)" value={formatMoney(ibkrShown.totalValue, ibkrShown.currency)} />
                <Kpi label="יתרת מזומן" value={formatMoney(ibkrShown.cashBalance, ibkrShown.currency)} />
              </section>
              <section className="rounded-3xl border border-line bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold">אחזקות IBKR</h3>
                  <label className="relative min-w-56 flex-1 sm:max-w-xs">
                    <span className="sr-only">חיפוש נייר</span>
                    <Search size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
                    <input
                      value={ibkrQuery}
                      onChange={(event) => setIbkrQuery(event.target.value)}
                      placeholder="חיפוש לפי שם או סימול"
                      className="w-full rounded-full border border-line bg-paper py-2 pr-9 pl-4 text-sm outline-none focus:border-teal"
                    />
                  </label>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[860px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs tracking-wide text-muted">
                        <SortHeader
                          label="סימול"
                          column="symbol"
                          sortKey={ibkrSortKey}
                          sortDir={ibkrSortDir}
                          onSort={toggleIbkrSort}
                        />
                        <SortHeader
                          label="תיאור"
                          column="description"
                          sortKey={ibkrSortKey}
                          sortDir={ibkrSortDir}
                          onSort={toggleIbkrSort}
                        />
                        <SortHeader
                          label="כמות"
                          column="quantity"
                          sortKey={ibkrSortKey}
                          sortDir={ibkrSortDir}
                          onSort={toggleIbkrSort}
                        />
                        <SortHeader
                          label="שער"
                          column="markPrice"
                          sortKey={ibkrSortKey}
                          sortDir={ibkrSortDir}
                          onSort={toggleIbkrSort}
                        />
                        <SortHeader
                          label="שווי שוק"
                          column="positionValue"
                          sortKey={ibkrSortKey}
                          sortDir={ibkrSortDir}
                          onSort={toggleIbkrSort}
                        />
                        <SortHeader
                          label="רווח/הפסד לא ממומש"
                          column="fifoPnlUnrealized"
                          sortKey={ibkrSortKey}
                          sortDir={ibkrSortDir}
                          onSort={toggleIbkrSort}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {ibkrRows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-muted">
                            אין אחזקות להצגה.
                          </td>
                        </tr>
                      )}
                      {ibkrRows.map((row, index) => (
                        <tr
                          key={`ibkr-${activeIbkrCase}-${index}-${row.symbol}-${row.description}`}
                          className="border-b border-line/80"
                        >
                          <td className="py-3 pl-4 font-medium" dir="ltr">
                            {row.symbol || '—'}
                          </td>
                          <td className="py-3">
                            {row.description || '—'}
                            {row.currency ? (
                              <div className="text-xs text-muted" dir="ltr">
                                {row.currency}
                              </div>
                            ) : null}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {row.quantity ?? '—'}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {formatMoney(row.markPrice, row.currency || ibkrShown.currency)}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {formatMoney(row.positionValue, row.currency || ibkrShown.currency)}
                          </td>
                          <td
                            className={`py-3 text-left font-medium tabular-nums ${amountClass(row.fifoPnlUnrealized)}`}
                            dir="ltr"
                          >
                            {formatMoney(row.fifoPnlUnrealized, row.currency || ibkrShown.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      ) : (
        <>
          {meitavMissingCredentials ? (
            <CredentialsBanner message="לא הוגדרו פרטי מיטב טרייד בקובץ .env – יש להזין MEITAV_USERNAME ו-MEITAV_PASSWORD ולהפעיל מחדש את השרת." />
          ) : null}

          <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
                  <LineChart size={20} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">סנכרון מיטב טרייד</h3>
                  <p className="text-sm text-muted">התחברות ל-Spark של מיטב עם הפרטים שבקובץ .env.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={fetchMeitav}
                disabled={meitavBusy || meitavMissingCredentials}
                className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {meitavBusy ? <Loader2 size={16} className="animate-spin" /> : null}
                סנכרן מיטב טרייד
              </button>
            </div>
            {(meitavActionError || meitavSnapshot.status === 'ERROR') && (
              <p className="mt-4 rounded-2xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                {meitavActionError || meitavSnapshot.message || meitavSnapshot.error}
                {meitavSnapshot.errorCode && !meitavActionError ? ` (${meitavSnapshot.errorCode})` : ''}
              </p>
            )}
          </section>

          {meitavSnapshot.status === 'AWAITING_OTP' && (
            <section className="rounded-3xl border border-teal/30 bg-teal/10 p-5" aria-live="polite">
              <h3 className="text-lg font-semibold">קוד SMS</h3>
              <p className="mt-1 text-sm text-muted">
                הזינו את הקוד שנשלח
                {meitavSnapshot.phoneHint ? ` לטלפון שמסתיים ב-${meitavSnapshot.phoneHint}` : ' לטלפון'} כדי להמשיך.
              </p>
              <form onSubmit={submitMeitavCode} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
                  קוד חד-פעמי
                  <input
                    value={meitavOtpCode}
                    onChange={(event) => setMeitavOtpCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{4,10}"
                    maxLength={10}
                    required
                    dir="ltr"
                    className="rounded-2xl border border-line bg-card px-4 py-2.5 text-lg tracking-[0.3em] outline-none focus:border-teal"
                  />
                </label>
                <button
                  type="submit"
                  disabled={meitavSubmittingOtp}
                  className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-card disabled:opacity-60"
                >
                  {meitavSubmittingOtp ? 'שולח…' : 'שליחת קוד'}
                </button>
              </form>
            </section>
          )}

          {meitavSnapshot.status === 'SUCCESS' && meitavShown && (
            <>
              {meitavAccounts.length > 0 && (
                <nav className="flex flex-wrap gap-2" aria-label="תיקי מיטב">
                  <CaseTab selected={activeMeitavCase === 'all'} onClick={() => setMeitavCaseId('all')}>
                    הכל
                  </CaseTab>
                  {meitavAccounts.map((account) => (
                    <CaseTab
                      key={account.id}
                      selected={activeMeitavCase === account.id}
                      onClick={() => setMeitavCaseId(account.id)}
                    >
                      <span dir="ltr">{account.id}</span>
                    </CaseTab>
                  ))}
                </nav>
              )}
              <section className="grid gap-4 sm:grid-cols-3">
                <Kpi label="שווי תיק כולל" value={formatMoney(meitavShown.totalValue)} />
                <Kpi label="יתרת מזומן" value={formatMoney(meitavShown.cashBalance)} />
                <Kpi
                  label="רווח/הפסד כולל"
                  value={formatMoney(meitavShown.totalProfitLoss)}
                  tone={amountClass(meitavShown.totalProfitLoss)}
                />
              </section>
              <section className="rounded-3xl border border-line bg-card p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-lg font-semibold">אחזקות מיטב טרייד</h3>
                  <label className="relative min-w-56 flex-1 sm:max-w-xs">
                    <span className="sr-only">חיפוש נייר</span>
                    <Search size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
                    <input
                      value={meitavQuery}
                      onChange={(event) => setMeitavQuery(event.target.value)}
                      placeholder="חיפוש לפי שם או סימול"
                      className="w-full rounded-full border border-line bg-paper py-2 pr-9 pl-4 text-sm outline-none focus:border-teal"
                    />
                  </label>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[760px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs tracking-wide text-muted">
                        <SortHeader
                          label="שם נייר / סימול"
                          column="name"
                          sortKey={meitavSortKey}
                          sortDir={meitavSortDir}
                          onSort={toggleMeitavSort}
                        />
                        <SortHeader
                          label="כמות"
                          column="quantity"
                          sortKey={meitavSortKey}
                          sortDir={meitavSortDir}
                          onSort={toggleMeitavSort}
                        />
                        <SortHeader
                          label="שער אחרון"
                          column="lastPrice"
                          sortKey={meitavSortKey}
                          sortDir={meitavSortDir}
                          onSort={toggleMeitavSort}
                        />
                        <SortHeader
                          label="שווי שוק"
                          column="marketValue"
                          sortKey={meitavSortKey}
                          sortDir={meitavSortDir}
                          onSort={toggleMeitavSort}
                        />
                        <SortHeader
                          label="שינוי יומי %"
                          column="dailyChangePercent"
                          sortKey={meitavSortKey}
                          sortDir={meitavSortDir}
                          onSort={toggleMeitavSort}
                        />
                        <SortHeader
                          label="רווח/הפסד"
                          column="totalProfitLoss"
                          sortKey={meitavSortKey}
                          sortDir={meitavSortDir}
                          onSort={toggleMeitavSort}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {meitavRows.length === 0 && (
                        <tr>
                          <td colSpan={6} className="py-8 text-center text-muted">
                            אין אחזקות להצגה.
                          </td>
                        </tr>
                      )}
                      {meitavRows.map((row, index) => (
                        <tr
                          key={`meitav-${activeMeitavCase}-${index}-${row.symbol}-${row.name}`}
                          className="border-b border-line/80"
                        >
                          <td className="py-3 pl-4">
                            <div className="font-medium">{row.name || '—'}</div>
                            {row.symbol ? (
                              <div className="text-xs text-muted" dir="ltr">
                                {row.symbol}
                              </div>
                            ) : null}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {row.quantity ?? '—'}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {formatMoney(row.lastPrice)}
                          </td>
                          <td className="py-3 text-left tabular-nums" dir="ltr">
                            {formatMoney(row.marketValue)}
                          </td>
                          <td className={`py-3 text-left tabular-nums ${amountClass(row.dailyChangePercent)}`} dir="ltr">
                            {formatPercent(row.dailyChangePercent)}
                          </td>
                          <td
                            className={`py-3 text-left font-medium tabular-nums ${amountClass(row.totalProfitLoss)}`}
                            dir="ltr"
                          >
                            {formatMoney(row.totalProfitLoss)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

function CaseTab({ selected, onClick, children }) {
  return (
    <button
      type="button"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
        selected ? 'bg-teal text-white' : 'border border-line bg-card text-ink hover:bg-paper'
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({ label, value, tone = 'text-ink' }) {
  return (
    <article className="rounded-3xl border border-line bg-card p-5">
      <p className="text-sm text-muted">{label}</p>
      <p className={`mt-3 font-display text-3xl ${tone}`} dir="ltr">
        {value}
      </p>
    </article>
  );
}

function SortHeader({ label, column, sortKey, sortDir, onSort }) {
  const active = sortKey === column;
  const Icon = sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className="py-2 pl-4 text-right font-medium">
      <button type="button" onClick={() => onSort(column)} className="inline-flex items-center gap-1">
        {label}
        {active ? <Icon size={12} /> : null}
      </button>
    </th>
  );
}
