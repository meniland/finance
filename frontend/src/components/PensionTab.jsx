import { useEffect, useMemo, useState } from 'react';
import { Landmark, Loader2, PiggyBank } from 'lucide-react';
import { request } from '../api.js';
import CredentialsBanner from './CredentialsBanner.jsx';

const ACTIVE = new Set(['SCRAPING', 'AWAITING_OTP']);

const money = new Intl.NumberFormat('he-IL', {
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
  AWAITING_OTP: 'נדרש קוד SMS',
  SUCCESS: 'מוכן',
  ERROR: 'נכשל',
  MISSING_CREDENTIALS: 'חסרים פרטים',
};

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return money.format(Number(value));
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${percent.format(Number(value))}%`;
}

/** Group multi-account products (השתלמות) so the UI can toggle per policy. */
function groupPolicies(policies) {
  const groups = [];
  const studyFunds = [];
  for (const policy of policies || []) {
    if (policy.productType === 'השתלמות') studyFunds.push(policy);
    else groups.push({ id: `single-${policy.policyNumber || policy.policyName}`, policies: [policy] });
  }
  if (studyFunds.length) {
    groups.unshift({ id: 'hishtalmut', policies: studyFunds });
  }
  return groups;
}

function PolicyMeta({ policy }) {
  return (
    <dl className="mt-4 grid gap-2 text-sm">
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted">מסלול השקעה</dt>
        <dd>{policy.investmentTrack || '—'}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted">דמי ניהול מהפקדה</dt>
        <dd dir="ltr">{formatPercent(policy.depositFeePercent)}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted">דמי ניהול מצבירה</dt>
        <dd dir="ltr">{formatPercent(policy.accumulationFeePercent)}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted">תשואה שנתית</dt>
        <dd dir="ltr">{formatPercent(policy.annualYieldPercent)}</dd>
      </div>
    </dl>
  );
}

function PolicyGroupCard({ group }) {
  const policies = group.policies;
  const multi = policies.length > 1;
  const [selectedNumber, setSelectedNumber] = useState(null);

  const total = useMemo(
    () => policies.reduce((sum, row) => sum + (Number(row.balance) || 0), 0),
    [policies],
  );
  const selected = policies.find((row) => String(row.policyNumber) === String(selectedNumber)) || null;
  const head = policies[0];
  const showMeta = multi ? Boolean(selected) : true;
  const displayBalance = multi && !selected ? total : (selected || head).balance;

  function togglePolicy(policyNumber) {
    setSelectedNumber((current) =>
      String(current) === String(policyNumber) ? null : policyNumber,
    );
  }

  return (
    <article className="rounded-3xl border border-line bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-2xl bg-paper p-2 text-teal">
          <Landmark size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-muted">{head.productType || 'תוכנית'}</p>
          <h3 className="mt-1 text-lg font-semibold leading-snug">{head.policyName || '—'}</h3>
          {multi ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {policies.map((row) => {
                const active = String(selectedNumber) === String(row.policyNumber);
                return (
                  <li key={row.policyNumber}>
                    <button
                      type="button"
                      onClick={() => togglePolicy(row.policyNumber)}
                      aria-pressed={active}
                      className={`flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-2xl border px-3 py-2 text-start text-xs font-medium transition ${
                        active
                          ? 'border-teal bg-teal/10 text-teal'
                          : 'border-line bg-paper text-muted hover:border-teal/40 hover:text-ink'
                      }`}
                    >
                      <span dir="ltr" className="font-semibold">
                        מס׳ {row.policyNumber}
                      </span>
                      <span className="min-w-0 flex-1 text-end font-normal text-ink/80">
                        {row.employerName || 'מעסיק לא ידוע'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : head.policyNumber ? (
            <p className="mt-1 text-xs text-muted">
              <span dir="ltr">מס׳ פוליסה: {head.policyNumber}</span>
              {head.employerName ? <span> · {head.employerName}</span> : null}
            </p>
          ) : null}
          {multi && !selected ? (
            <p className="mt-2 text-xs text-muted">לחצו על מספר חשבון לפירוט מסלול ודמי ניהול</p>
          ) : null}
        </div>
      </div>
      <p className="mt-4 font-display text-2xl text-ink" dir="ltr">
        {formatMoney(displayBalance)}
      </p>
      {multi && !selected ? (
        <p className="mt-1 text-xs text-muted">סכום כולל לכל חשבונות ההשתלמות</p>
      ) : null}
      {showMeta ? <PolicyMeta policy={selected || head} /> : null}
    </article>
  );
}

export default function PensionTab() {
  const [snapshot, setSnapshot] = useState({
    status: 'IDLE',
    error: null,
    errorCode: null,
    message: null,
    phoneHint: null,
    credentialsConfigured: true,
    sessionSaved: false,
    portfolio: null,
  });
  const [watch, setWatch] = useState(0);
  const [actionError, setActionError] = useState('');
  const [starting, setStarting] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [submittingOtp, setSubmittingOtp] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
      try {
        const data = await request('/api/pension/harel/status');
        if (cancelled) return;
        setSnapshot(data);
        if (ACTIVE.has(data.status)) {
          timer = setTimeout(poll, 1500);
        }
      } catch (error) {
        if (cancelled) return;
        setActionError(error.message || 'לא ניתן לקרוא את מצב הפנסיה.');
        timer = setTimeout(poll, 3000);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [watch]);

  const missingCredentials =
    snapshot.credentialsConfigured === false || snapshot.status === 'MISSING_CREDENTIALS';
  const busy = starting || ACTIVE.has(snapshot.status);
  const portfolio = snapshot.portfolio;
  const policies = portfolio?.policies || [];
  const groups = useMemo(() => groupPolicies(policies), [policies]);

  async function syncHarel() {
    setActionError('');
    setStarting(true);
    try {
      await request('/api/pension/harel/scrape', { method: 'POST', body: '{}' });
      setWatch((value) => value + 1);
    } catch (error) {
      setActionError(error.message || 'הסנכרון נכשל.');
      setWatch((value) => value + 1);
    } finally {
      setStarting(false);
    }
  }

  async function submitCode(event) {
    event.preventDefault();
    setActionError('');
    setSubmittingOtp(true);
    try {
      await request('/api/pension/harel/otp', {
        method: 'POST',
        body: JSON.stringify({ otpCode: otpCode.trim() }),
      });
      setOtpCode('');
      setWatch((value) => value + 1);
    } catch (error) {
      setActionError(error.message || 'שליחת הקוד נכשלה.');
    } finally {
      setSubmittingOtp(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6" dir="rtl">
      {missingCredentials ? (
        <CredentialsBanner message="לא הוגדר מספר תעודת זהות להראל בקובץ .env – יש להזין HAREL_ID_NUMBER (ואופציונלי HAREL_PHONE_NUMBER) ולהפעיל מחדש את השרת." />
      ) : null}

      <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
              <PiggyBank size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">פנסיה וחיסכון ארוך טווח</h2>
              <p className="text-sm text-muted">שליפת יתרות פנסיה, גמל והשתלמות מאזור אישי בהראל.</p>
              <p className="mt-2 text-xs text-muted">
                סטטוס: {STATUS_LABEL[snapshot.status] || snapshot.status}
                {snapshot.sessionSaved ? ' · סשן שמור (לרוב בלי SMS)' : ' · נדרש SMS בכניסה הראשונה'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={syncHarel}
            disabled={busy || missingCredentials}
            className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {snapshot.sessionSaved ? 'רענון נתוני פנסיה' : 'סנכרן נתוני פנסיה (הראל)'}
          </button>
        </div>
        {snapshot.status === 'SUCCESS' && snapshot.message ? (
          <p className="mt-4 rounded-2xl bg-teal/10 px-3 py-2 text-sm text-teal">{snapshot.message}</p>
        ) : null}
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
          <p className="mt-1 text-sm text-muted">
            הזינו את הקוד שנשלח
            {snapshot.phoneHint ? ` לטלפון שמסתיים ב-${snapshot.phoneHint}` : ' לטלפון'} כדי להמשיך.
          </p>
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

      {snapshot.status === 'SUCCESS' && portfolio && (
        <>
          <section className="grid gap-4 sm:grid-cols-2">
            <article className="rounded-3xl border border-line bg-card p-5">
              <p className="text-sm text-muted">סך חיסכון פנסיוני והשתלמות</p>
              <p className="mt-3 font-display text-3xl text-ink" dir="ltr">
                {formatMoney(portfolio.totalPensionBalance)}
              </p>
            </article>
            <article className="rounded-3xl border border-line bg-card p-5">
              <p className="text-sm text-muted">מספר תוכניות</p>
              <p className="mt-3 font-display text-3xl text-ink" dir="ltr">
                {policies.length}
              </p>
            </article>
          </section>

          {policies.length === 0 || portfolio.totalPensionBalance == null ? (
            <p className="rounded-3xl border border-amber/30 bg-amber-soft px-4 py-3 text-sm text-amber" role="status">
              ההתחברות להראל הצליחה, אך עדיין לא נשלפו יתרות חיסכון. נסו לסנכרן שוב, או בדקו באזור האישי של הראל שמוצרי הפנסיה/גמל/השתלמות מוצגים.
            </p>
          ) : null}

          <section className="grid gap-4 md:grid-cols-2">
            {groups.length === 0 ? (
              <p className="rounded-3xl border border-line bg-card p-5 text-sm text-muted">לא נמצאו תוכניות עם יתרה להצגה.</p>
            ) : (
              groups.map((group) => <PolicyGroupCard key={group.id} group={group} />)
            )}
          </section>
        </>
      )}
    </main>
  );
}
