import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CreditCard,
  Landmark,
  Loader2,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { request } from '../api.js';
import CredentialsBanner from './CredentialsBanner.jsx';

const ACTIVE = new Set(['SCRAPING', 'AWAITING_OTP']);

const money = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 2,
});

const dayFormat = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const STATUS_LABEL = {
  IDLE: 'Idle',
  SCRAPING: 'Fetching',
  AWAITING_OTP: 'SMS code needed',
  SUCCESS: 'Ready',
  ERROR: 'Failed',
  MISSING_CREDENTIALS: 'Missing credentials',
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
    return money.format(Number(value));
  }
}

function formatDay(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return dayFormat.format(date);
}

function amountClass(value) {
  const amount = Number(value);
  if (Number.isNaN(amount) || amount === 0) return 'text-ink';
  return amount > 0 ? 'text-credit' : 'text-danger';
}

function compareValues(left, right, key) {
  if (key === 'chargedAmount' || key === 'originalAmount') return Number(left[key] || 0) - Number(right[key] || 0);
  if (key === 'date') return new Date(left.date).getTime() - new Date(right.date).getTime();
  return String(left[key] || '').localeCompare(String(right[key] || ''), 'he');
}

function emptySnapshot() {
  return {
    status: 'IDLE',
    accounts: null,
    error: null,
    errorCode: null,
    phoneHint: null,
    credentialsConfigured: undefined,
  };
}

export default function BankTab() {
  const [provider, setProvider] = useState('beinleumi');
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [calSnapshot, setCalSnapshot] = useState(emptySnapshot);
  const [watch, setWatch] = useState(0);
  const [calWatch, setCalWatch] = useState(0);
  const [actionError, setActionError] = useState('');
  const [calActionError, setCalActionError] = useState('');
  const [starting, setStarting] = useState(false);
  const [calStarting, setCalStarting] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [calOtpCode, setCalOtpCode] = useState('');
  const [submittingOtp, setSubmittingOtp] = useState(false);
  const [calSubmittingOtp, setCalSubmittingOtp] = useState(false);
  const [query, setQuery] = useState('');
  const [calQuery, setCalQuery] = useState('');
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const [calSortKey, setCalSortKey] = useState('date');
  const [calSortDir, setCalSortDir] = useState('desc');
  const [selectedCalAccount, setSelectedCalAccount] = useState(null);

  useEffect(() => {
    let stop = false;
    let timer;

    const tick = async () => {
      try {
        const data = await request('/api/status');
        if (stop) return;
        setSnapshot(data);
        if (ACTIVE.has(data.status)) timer = setTimeout(tick, 2000);
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
        const data = await request('/api/cal/status');
        if (stop) return;
        setCalSnapshot(data);
        if (ACTIVE.has(data.status)) timer = setTimeout(tick, 2000);
      } catch (error) {
        if (stop) return;
        setCalActionError(error.message);
        timer = setTimeout(tick, 2000);
      }
    };

    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [calWatch]);

  const rows = useMemo(() => {
    const accounts = snapshot.accounts || [];
    const needle = query.trim().toLowerCase();
    const flattened = accounts.flatMap((account) =>
      (account.txns || []).map((txn) => ({
        ...txn,
        accountNumber: account.accountNumber,
      })),
    );
    const filtered = needle
      ? flattened.filter((txn) =>
          [txn.description, txn.memo, txn.status, txn.accountNumber, String(txn.chargedAmount)]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
      : flattened;

    return [...filtered].sort((left, right) => {
      const result = compareValues(left, right, sortKey);
      return sortDir === 'asc' ? result : -result;
    });
  }, [snapshot.accounts, query, sortKey, sortDir]);

  const activeCalAccount = useMemo(() => {
    if (selectedCalAccount == null) return null;
    const present = (calSnapshot.accounts || []).some(
      (account) => String(account.accountNumber) === String(selectedCalAccount),
    );
    return present ? selectedCalAccount : null;
  }, [calSnapshot.accounts, selectedCalAccount]);

  const calRows = useMemo(() => {
    const accounts = calSnapshot.accounts || [];
    const needle = calQuery.trim().toLowerCase();
    const scoped = activeCalAccount
      ? accounts.filter((account) => String(account.accountNumber) === String(activeCalAccount))
      : accounts;
    const flattened = scoped.flatMap((account) =>
      (account.txns || []).map((txn) => ({
        ...txn,
        accountNumber: account.accountNumber,
      })),
    );
    const filtered = needle
      ? flattened.filter((txn) =>
          [
            txn.description,
            txn.memo,
            txn.status,
            txn.accountNumber,
            String(txn.chargedAmount),
            String(txn.originalAmount),
          ]
            .join(' ')
            .toLowerCase()
            .includes(needle),
        )
      : flattened;

    return [...filtered].sort((left, right) => {
      const result = compareValues(left, right, calSortKey);
      return calSortDir === 'asc' ? result : -result;
    });
  }, [calSnapshot.accounts, calQuery, calSortKey, calSortDir, activeCalAccount]);

  const missingCredentials = snapshot.credentialsConfigured === false || snapshot.status === 'MISSING_CREDENTIALS';
  const calMissingCredentials =
    calSnapshot.credentialsConfigured === false || calSnapshot.status === 'MISSING_CREDENTIALS';
  const busy = starting || ACTIVE.has(snapshot.status);
  const calBusy = calStarting || ACTIVE.has(calSnapshot.status);
  const activeSnapshot = provider === 'cal' ? calSnapshot : snapshot;

  async function fetchBankData() {
    const previousStatus = snapshot.status;
    setActionError('');
    setStarting(true);
    setSnapshot((current) => ({ ...current, status: 'SCRAPING', error: null, errorCode: null }));
    try {
      await request('/api/scrape', { method: 'POST', body: '{}' });
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

  async function fetchCalData() {
    const previousStatus = calSnapshot.status;
    setCalActionError('');
    setCalStarting(true);
    setCalSnapshot((current) => ({ ...current, status: 'SCRAPING', error: null, errorCode: null }));
    try {
      await request('/api/cal/scrape', { method: 'POST', body: '{}' });
      setCalWatch((value) => value + 1);
    } catch (error) {
      if (error.code === 'MISSING_CREDENTIALS') {
        setCalSnapshot((current) => ({
          ...current,
          status: 'MISSING_CREDENTIALS',
          credentialsConfigured: false,
          error: error.message,
        }));
        return;
      }
      setCalActionError(error.message);
      setCalSnapshot((current) => ({ ...current, status: previousStatus }));
    } finally {
      setCalStarting(false);
    }
  }

  async function submitCode(event) {
    event.preventDefault();
    setActionError('');
    setSubmittingOtp(true);
    try {
      await request('/api/otp', {
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

  async function submitCalCode(event) {
    event.preventDefault();
    setCalActionError('');
    setCalSubmittingOtp(true);
    try {
      await request('/api/cal/otp', {
        method: 'POST',
        body: JSON.stringify({ otpCode: calOtpCode.trim() }),
      });
      setCalOtpCode('');
      setCalWatch((value) => value + 1);
    } catch (error) {
      setCalActionError(error.message);
    } finally {
      setCalSubmittingOtp(false);
    }
  }

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(key);
    setSortDir(key === 'description' || key === 'status' ? 'asc' : 'desc');
  }

  function toggleCalSort(key) {
    if (calSortKey === key) {
      setCalSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setCalSortKey(key);
    setCalSortDir(key === 'description' || key === 'status' ? 'asc' : 'desc');
  }

  const failure = snapshot.status === 'ERROR' ? snapshot.error : '';
  const calFailure = calSnapshot.status === 'ERROR' ? calSnapshot.error : '';

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-teal uppercase">Account status</p>
          <h2 className="font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">מצב חשבון</h2>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Local snapshot of bank and credit-card activity. Credentials stay in the server environment.
          </p>
        </div>
        <StatusPill status={activeSnapshot.status} />
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="ספקי חשבון">
        <ProviderTab selected={provider === 'beinleumi'} onClick={() => setProvider('beinleumi')}>
          Beinleumi
        </ProviderTab>
        <ProviderTab selected={provider === 'cal'} onClick={() => setProvider('cal')}>
          כאל (Visa CAL)
        </ProviderTab>
      </nav>

      {provider === 'beinleumi' ? (
        <>
          {missingCredentials ? <CredentialsBanner /> : null}

          <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
                  <Landmark size={20} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">Account fetch</h3>
                  <p className="text-sm text-muted">Pulls the window set by DAYS_BACK, defaulting to 30 days.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={fetchBankData}
                disabled={busy || missingCredentials}
                className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                Fetch bank data
              </button>
            </div>
            {(actionError || failure) && (
              <p className="mt-4 flex items-start gap-2 rounded-2xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>
                  {actionError || failure}
                  {snapshot.errorCode && !actionError ? ` (${snapshot.errorCode})` : ''}
                </span>
              </p>
            )}
          </section>

          {snapshot.status === 'AWAITING_OTP' && (
            <section className="rounded-3xl border border-teal/30 bg-teal/10 p-5" aria-live="polite">
              <h3 className="text-lg font-semibold">SMS code</h3>
              <p className="mt-1 text-sm text-muted">
                The bank sent a code
                {snapshot.phoneHint ? ` to ${snapshot.phoneHint}` : ''}. Enter it to continue this login.
              </p>
              <form onSubmit={submitCode} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
                  One-time code
                  <input
                    value={otpCode}
                    onChange={(event) => setOtpCode(event.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{4,10}"
                    maxLength={10}
                    required
                    className="rounded-2xl border border-line bg-card px-4 py-2.5 text-lg tracking-[0.3em] outline-none focus:border-teal"
                  />
                </label>
                <button
                  type="submit"
                  disabled={submittingOtp}
                  className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-card disabled:opacity-60"
                >
                  {submittingOtp ? 'Submitting…' : 'Submit code'}
                </button>
              </form>
            </section>
          )}

          {snapshot.accounts?.length > 0 && (
            <section className="grid gap-4 sm:grid-cols-2">
              {snapshot.accounts.map((account) => (
                <article key={account.accountNumber} className="rounded-3xl border border-line bg-card p-5">
                  <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">Account</p>
                  <p className="mt-1 font-mono text-lg" dir="ltr">
                    {account.accountNumber}
                  </p>
                  <p className={`mt-4 font-display text-4xl ${amountClass(account.balance)}`}>
                    {formatMoney(account.balance)}
                  </p>
                  <p className="mt-2 text-sm text-muted">
                    {account.txns.length} transaction{account.txns.length === 1 ? '' : 's'}
                    {account.windowCoverage?.status === 'unproven' ? ' · date window may be incomplete' : ''}
                  </p>
                </article>
              ))}
            </section>
          )}

          {snapshot.status === 'SUCCESS' && (
            <section className="rounded-3xl border border-line bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-lg font-semibold">Transactions</h3>
                <label className="relative min-w-56 flex-1 sm:max-w-xs">
                  <span className="sr-only">Search transactions</span>
                  <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search description, amount, status"
                    className="w-full rounded-full border border-line bg-paper py-2 pr-4 pl-9 text-sm outline-none focus:border-teal"
                  />
                </label>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs tracking-wide text-muted uppercase">
                      <SortHeader label="Date" column="date" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                      <SortHeader
                        label="Description"
                        column="description"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortHeader
                        label="Charged amount"
                        column="chargedAmount"
                        sortKey={sortKey}
                        sortDir={sortDir}
                        onSort={toggleSort}
                        align="right"
                      />
                      <SortHeader label="Status" column="status" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-muted">
                          No transactions match this view.
                        </td>
                      </tr>
                    )}
                    {rows.map((txn) => (
                      <tr
                        key={`${txn.accountNumber}-${txn.identifier}-${txn.date}-${txn.chargedAmount}-${txn.description}`}
                        className="border-b border-line/80"
                      >
                        <td className="py-3 pr-4 whitespace-nowrap tabular-nums">{formatDay(txn.date)}</td>
                        <td className="py-3 pr-4" dir="rtl" lang="he">
                          <div className="font-medium">{txn.description || '—'}</div>
                          {txn.memo ? <div className="text-xs text-muted">{txn.memo}</div> : null}
                          {(snapshot.accounts || []).length > 1 ? (
                            <div className="text-xs text-muted" dir="ltr">
                              {txn.accountNumber}
                            </div>
                          ) : null}
                        </td>
                        <td
                          className={`py-3 pr-4 text-right font-medium whitespace-nowrap tabular-nums ${amountClass(txn.chargedAmount)}`}
                        >
                          {formatMoney(txn.chargedAmount)}
                        </td>
                        <td className="py-3 capitalize">{txn.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : (
        <>
          {calMissingCredentials ? (
            <CredentialsBanner message="לא הוגדרו פרטי כאל בקובץ .env – יש להזין CAL_USERNAME ו-CAL_PASSWORD ולהפעיל מחדש את השרת." />
          ) : null}

          <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
                  <CreditCard size={20} aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-lg font-semibold">שליפת כאל</h3>
                  <p className="text-sm text-muted">חיובים וסיכומי כרטיס מ-Visa CAL לפי DAYS_BACK.</p>
                </div>
              </div>
              <button
                type="button"
                onClick={fetchCalData}
                disabled={calBusy || calMissingCredentials}
                className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
              >
                {calBusy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                שלוף נתוני כאל (CAL)
              </button>
            </div>
            {(calActionError || calFailure) && (
              <p className="mt-4 flex items-start gap-2 rounded-2xl bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>
                  {calActionError || calFailure}
                  {calSnapshot.errorCode && !calActionError ? ` (${calSnapshot.errorCode})` : ''}
                </span>
              </p>
            )}
          </section>

          {calSnapshot.status === 'AWAITING_OTP' && (
            <section className="rounded-3xl border border-teal/30 bg-teal/10 p-5" aria-live="polite">
              <h3 className="text-lg font-semibold">קוד SMS</h3>
              <p className="mt-1 text-sm text-muted">
                כאל שלחה קוד
                {calSnapshot.phoneHint ? ` אל ${calSnapshot.phoneHint}` : ''}. הזינו אותו כדי להמשיך.
              </p>
              <form onSubmit={submitCalCode} className="mt-4 flex flex-wrap items-end gap-3">
                <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm font-medium">
                  קוד חד-פעמי
                  <input
                    value={calOtpCode}
                    onChange={(event) => setCalOtpCode(event.target.value)}
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
                  disabled={calSubmittingOtp}
                  className="rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-card disabled:opacity-60"
                >
                  {calSubmittingOtp ? 'שולח…' : 'שליחת קוד'}
                </button>
              </form>
            </section>
          )}

          {calSnapshot.accounts?.length > 0 && (
            <section className="grid gap-4 sm:grid-cols-2">
              {calSnapshot.accounts.map((account) => {
                const selected = String(activeCalAccount) === String(account.accountNumber);
                return (
                  <button
                    key={account.accountNumber}
                    type="button"
                    aria-pressed={selected}
                    onClick={() =>
                      setSelectedCalAccount((current) =>
                        String(current) === String(account.accountNumber) ? null : account.accountNumber,
                      )
                    }
                    className={`rounded-3xl border bg-card p-5 text-right transition ${
                      selected
                        ? 'border-teal ring-2 ring-teal/25 shadow-[0_12px_28px_rgb(28_25_21_/_0.08)]'
                        : 'border-line hover:border-teal/50'
                    }`}
                  >
                    <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">כרטיס</p>
                    <p className="mt-1 font-mono text-lg" dir="ltr">
                      {account.accountNumber}
                    </p>
                    <p className={`mt-4 font-display text-4xl ${amountClass(account.balance)}`}>
                      {formatMoney(account.balance)}
                    </p>
                    <p className="mt-2 text-sm text-muted">סה״כ לחיוב הבא</p>
                    <p className="mt-3 text-sm text-ink">
                      מועד חיוב הבא:{' '}
                      <span className="font-medium tabular-nums" dir="ltr">
                        {account.nextChargeDate ? formatDay(account.nextChargeDate) : '—'}
                      </span>
                    </p>
                    <p className="mt-2 text-sm text-muted">
                      {account.txns.length} עסקאות
                      {account.windowCoverage?.status === 'unproven' ? ' · ייתכן שהחלון חלקי' : ''}
                      {selected ? ' · מסונן' : ''}
                    </p>
                  </button>
                );
              })}
            </section>
          )}

          {calSnapshot.status === 'SUCCESS' && (
            <section className="rounded-3xl border border-line bg-card p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold">עסקאות כאל</h3>
                  {activeCalAccount ? (
                    <p className="mt-1 text-sm text-muted">
                      מציג כרטיס{' '}
                      <span className="font-mono tabular-nums" dir="ltr">
                        {activeCalAccount}
                      </span>
                      {' · '}
                      <button
                        type="button"
                        onClick={() => setSelectedCalAccount(null)}
                        className="font-medium text-teal hover:underline"
                      >
                        הצג הכל
                      </button>
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-muted">לחצו על כרטיס כדי לסנן את העסקאות שלו</p>
                  )}
                </div>
                <label className="relative min-w-56 flex-1 sm:max-w-xs">
                  <span className="sr-only">חיפוש עסקאות</span>
                  <Search size={16} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
                  <input
                    value={calQuery}
                    onChange={(event) => setCalQuery(event.target.value)}
                    placeholder="חיפוש לפי בית עסק, סכום או סטטוס"
                    className="w-full rounded-full border border-line bg-paper py-2 pr-9 pl-4 text-sm outline-none focus:border-teal"
                  />
                </label>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[860px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-xs tracking-wide text-muted">
                      <SortHeader
                        label="תאריך"
                        column="date"
                        sortKey={calSortKey}
                        sortDir={calSortDir}
                        onSort={toggleCalSort}
                      />
                      <SortHeader
                        label="בית עסק"
                        column="description"
                        sortKey={calSortKey}
                        sortDir={calSortDir}
                        onSort={toggleCalSort}
                      />
                      <SortHeader
                        label="סכום מקורי"
                        column="originalAmount"
                        sortKey={calSortKey}
                        sortDir={calSortDir}
                        onSort={toggleCalSort}
                        align="right"
                      />
                      <SortHeader
                        label="סכום לחיוב"
                        column="chargedAmount"
                        sortKey={calSortKey}
                        sortDir={calSortDir}
                        onSort={toggleCalSort}
                        align="right"
                      />
                      <SortHeader
                        label="סטטוס"
                        column="status"
                        sortKey={calSortKey}
                        sortDir={calSortDir}
                        onSort={toggleCalSort}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {calRows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-muted">
                          אין עסקאות להצגה.
                        </td>
                      </tr>
                    )}
                    {calRows.map((txn) => (
                      <tr
                        key={`cal-${txn.accountNumber}-${txn.identifier}-${txn.date}-${txn.chargedAmount}-${txn.description}`}
                        className="border-b border-line/80"
                      >
                        <td className="py-3 pl-4 whitespace-nowrap tabular-nums" dir="ltr">
                          {formatDay(txn.date)}
                        </td>
                        <td className="py-3 pl-4" dir="rtl" lang="he">
                          <div className="font-medium">{txn.description || '—'}</div>
                          {txn.memo ? <div className="text-xs text-muted">{txn.memo}</div> : null}
                          {!activeCalAccount && (calSnapshot.accounts || []).length > 1 ? (
                            <div className="text-xs text-muted" dir="ltr">
                              {txn.accountNumber}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3 pl-4 text-left whitespace-nowrap tabular-nums" dir="ltr">
                          {formatMoney(txn.originalAmount, txn.originalCurrency || 'ILS')}
                        </td>
                        <td
                          className={`py-3 pl-4 text-left font-medium whitespace-nowrap tabular-nums ${amountClass(txn.chargedAmount)}`}
                          dir="ltr"
                        >
                          {formatMoney(txn.chargedAmount)}
                        </td>
                        <td className="py-3 capitalize">{txn.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function ProviderTab({ selected, onClick, children }) {
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

function StatusPill({ status }) {
  const tone =
    status === 'ERROR' || status === 'MISSING_CREDENTIALS'
      ? 'bg-danger/10 text-danger'
      : status === 'SUCCESS'
        ? 'bg-credit/10 text-credit'
        : status === 'AWAITING_OTP'
          ? 'bg-teal/10 text-teal'
          : 'bg-ink/5 text-ink';
  return (
    <p className={`rounded-full px-3 py-1 text-sm font-medium ${tone}`} aria-live="polite">
      {STATUS_LABEL[status] || status}
      {ACTIVE.has(status) ? ' · checking every 2s' : ''}
    </p>
  );
}

function SortHeader({ label, column, sortKey, sortDir, onSort, align = 'left' }) {
  const active = sortKey === column;
  const Icon = sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={`py-2 pr-4 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`inline-flex items-center gap-1 ${align === 'right' ? 'flex-row-reverse' : ''}`}
      >
        {label}
        {active ? <Icon size={12} /> : null}
      </button>
    </th>
  );
}
