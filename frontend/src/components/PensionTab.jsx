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

const EMPTY_SNAPSHOT = {
  status: 'IDLE',
  error: null,
  errorCode: null,
  message: null,
  phoneHint: null,
  credentialsConfigured: true,
  sessionSaved: false,
  portfolio: null,
};

const PROVIDERS = {
  meni: {
    id: 'meni',
    label: 'מני',
    title: 'פנסיה וחיסכון ארוך טווח - מני (הראל)',
    subtitle: 'שליפת יתרות פנסיה, גמל והשתלמות מאזור אישי בהראל.',
    statusPath: '/api/pension/harel/status',
    scrapePath: '/api/pension/harel/scrape',
    otpPath: '/api/pension/harel/otp',
    missingEnv: 'HAREL_ID_NUMBER (ואופציונלי HAREL_PHONE_NUMBER)',
    emptyHint:
      'ההתחברות להראל הצליחה, אך עדיין לא נשלפו יתרות חיסכון. נסו לסנכרן שוב, או בדקו באזור האישי של הראל שמוצרי הפנסיה/גמל/השתלמות מוצגים.',
    badge: 'הראל',
  },
};

const EFRAT_SOURCES = [
  {
    id: 'meitav',
    badge: 'מיטב',
    title: 'מיטב גמל ופנסיה',
    subtitle: 'פנסיה, גמל והשתלמות מאזור אישי במיטב.',
    statusPath: '/api/pension/meitav/status',
    scrapePath: '/api/pension/meitav/scrape',
    otpPath: '/api/pension/meitav/otp',
    missingEnv: 'MEITAV_PENSION_ID_NUMBER ו-MEITAV_PENSION_PHONE_NUMBER',
    syncLabelSaved: 'רענון נתוני מיטב',
    syncLabelFresh: 'סנכרן נתוני מיטב',
  },
  {
    id: 'phoenix',
    badge: 'הפניקס',
    title: 'הפניקס',
    subtitle: 'קרן השתלמות וקופת גמל מאזור אישי בהפניקס.',
    statusPath: '/api/pension/phoenix/status',
    scrapePath: '/api/pension/phoenix/scrape',
    otpPath: '/api/pension/phoenix/otp',
    missingEnv: 'PHOENIX_ID_NUMBER (ואופציונלי PHOENIX_PHONE_NUMBER)',
    syncLabelSaved: 'רענון נתוני הפניקס',
    syncLabelFresh: 'סנכרן נתוני הפניקס',
  },
  {
    id: 'harel',
    badge: 'הראל',
    title: 'הראל',
    subtitle: 'קופת גמל מאזור אישי בהראל.',
    statusPath: '/api/pension/efrat/harel/status',
    scrapePath: '/api/pension/efrat/harel/scrape',
    otpPath: '/api/pension/efrat/harel/otp',
    missingEnv: 'EFRAT_HAREL_ID_NUMBER (ואופציונלי EFRAT_HAREL_PHONE_NUMBER)',
    syncLabelSaved: 'רענון נתוני הראל',
    syncLabelFresh: 'סנכרן נתוני הראל',
  },
];

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return money.format(Number(value));
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return `${percent.format(Number(value))}%`;
}

function withProviderBadge(policies, badge) {
  return (policies || []).map((policy) => ({
    ...policy,
    provider: policy.provider || badge,
  }));
}

function groupPolicies(policies) {
  const groups = [];
  const studyFundsByProvider = new Map();

  for (const policy of policies || []) {
    if (policy.productType === 'השתלמות') {
      const key = policy.provider || 'השתלמות';
      if (!studyFundsByProvider.has(key)) studyFundsByProvider.set(key, []);
      studyFundsByProvider.get(key).push(policy);
    } else {
      groups.push({
        id: `single-${policy.provider || 'x'}-${policy.policyNumber || policy.policyName}`,
        policies: [policy],
      });
    }
  }

  for (const [provider, rows] of studyFundsByProvider) {
    groups.unshift({ id: `hishtalmut-${provider}`, policies: rows });
  }
  return groups;
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

function ProviderBadge({ label }) {
  if (!label) return null;
  return (
    <span className="rounded-full border border-line bg-paper px-2.5 py-0.5 text-[11px] font-semibold text-muted">
      {label}
    </span>
  );
}

function formatDepositDate(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return String(value);
}

function asLabel(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = String(value).trim();
    return !text || text === '[object Object]' ? null : text;
  }
  if (typeof value === 'object') {
    return asLabel(value.statusDesc ?? value.label ?? value.name ?? value.value ?? null);
  }
  return null;
}

function ActivityBadge({ policy }) {
  // Prefer contribution status when we know about recent deposits.
  const label =
    asLabel(policy?.contributionLabel) ||
    asLabel(policy?.activityLabel) ||
    (policy?.isActive === true ? 'פעיל' : policy?.isActive === false ? 'לא פעיל' : null);
  if (!label) return null;
  const positive =
    policy?.receivingDeposits === true ||
    (policy?.receivingDeposits == null &&
      policy?.isActive !== false &&
      !/לא\s*פעיל|מבוטל|סגור|ללא הפקדות/i.test(label));
  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
        positive
          ? 'border-teal/30 bg-teal/10 text-teal'
          : 'border-amber/40 bg-amber-soft text-amber'
      }`}
    >
      {label}
    </span>
  );
}

function PolicyMeta({ policy }) {
  const accountStatus =
    asLabel(policy.activityLabel) ||
    (policy.isActive === true ? 'פעיל' : policy.isActive === false ? 'לא פעיל' : null);
  const contribution =
    asLabel(policy.contributionLabel) ||
    (policy.receivingDeposits === true
      ? 'מופקד'
      : policy.receivingDeposits === false
        ? 'ללא הפקדות'
        : null);
  const lastDeposit = formatDepositDate(policy.lastDepositAt);

  return (
    <dl className="mt-4 grid gap-2 text-sm">
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted">סטטוס חשבון</dt>
        <dd>{accountStatus || '—'}</dd>
      </div>
      <div className="flex flex-wrap justify-between gap-2">
        <dt className="text-muted">הפקדות</dt>
        <dd>
          {contribution || '—'}
          {lastDeposit ? ` · אחרונה ${lastDeposit}` : ''}
        </dd>
      </div>
      {policy.ytdDepositAmount != null ? (
        <div className="flex flex-wrap justify-between gap-2">
          <dt className="text-muted">הפקדות מתחילת השנה</dt>
          <dd dir="ltr">{formatMoney(policy.ytdDepositAmount)}</dd>
        </div>
      ) : null}
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
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold tracking-wide text-muted">{head.productType || 'תוכנית'}</p>
            <ProviderBadge label={head.provider} />
            {!multi ? <ActivityBadge policy={head} /> : null}
          </div>
          <h3 className="mt-1 text-lg font-semibold leading-snug">{head.policyName || '—'}</h3>
          {multi ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {policies.map((row) => {
                const selected = String(selectedNumber) === String(row.policyNumber);
                return (
                  <li key={`${row.provider || ''}-${row.policyNumber}`}>
                    <button
                      type="button"
                      onClick={() => togglePolicy(row.policyNumber)}
                      aria-pressed={selected}
                      className={`flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-2xl border px-3 py-2 text-start text-xs font-medium transition ${
                        selected
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
                      <ActivityBadge policy={row} />
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

function useProviderSnapshot(statusPath) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [watch, setWatch] = useState(0);
  const [actionError, setActionError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    async function poll() {
      let nextStatus = 'IDLE';
      try {
        const data = await request(statusPath);
        if (cancelled) return;
        setSnapshot(data);
        nextStatus = data.status;
      } catch (error) {
        if (cancelled) return;
        setActionError(error.message || 'לא ניתן לקרוא את מצב הפנסיה.');
      }
      if (cancelled) return;
      // Keep polling after SUCCESS/IDLE so the combined אפרת view picks up a
      // scrape finished by a sibling sync card (watch only bumps on that card).
      const delay = ACTIVE.has(nextStatus) ? 1500 : 4000;
      timer = setTimeout(poll, delay);
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [watch, statusPath]);

  return { snapshot, setWatch, actionError, setActionError };
}

function ProviderSyncCard({ source }) {
  const { snapshot, setWatch, actionError, setActionError } = useProviderSnapshot(source.statusPath);
  const [starting, setStarting] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [submittingOtp, setSubmittingOtp] = useState(false);

  const missingCredentials =
    snapshot.credentialsConfigured === false || snapshot.status === 'MISSING_CREDENTIALS';
  const busy = starting || ACTIVE.has(snapshot.status);

  async function syncProvider() {
    setActionError('');
    setStarting(true);
    try {
      await request(source.scrapePath, { method: 'POST', body: '{}' });
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
      await request(source.otpPath, {
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
    <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
      {missingCredentials ? (
        <CredentialsBanner
          message={`לא הוגדרו פרטי כניסה בקובץ .env – יש להזין ${source.missingEnv} ולהפעיל מחדש את השרת.`}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
            <PiggyBank size={20} aria-hidden="true" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{source.title}</h2>
              <ProviderBadge label={source.badge} />
            </div>
            <p className="text-sm text-muted">{source.subtitle}</p>
            <p className="mt-2 text-xs text-muted">
              סטטוס: {STATUS_LABEL[snapshot.status] || snapshot.status}
              {snapshot.sessionSaved
                ? snapshot.status === 'SUCCESS'
                  ? ' · סשן שמור'
                  : ' · סשן שמור (לרוב בלי SMS)'
                : ' · נדרש SMS בכניסה הראשונה'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={syncProvider}
          disabled={busy || missingCredentials}
          className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : null}
          {snapshot.sessionSaved ? source.syncLabelSaved : source.syncLabelFresh}
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

      {snapshot.status === 'AWAITING_OTP' && (
        <div className="mt-4 rounded-3xl border border-teal/30 bg-teal/10 p-4" aria-live="polite">
          <h3 className="text-base font-semibold">קוד SMS · {source.badge}</h3>
          <p className="mt-1 text-sm text-muted">
            הזינו את הקוד שנשלח
            {snapshot.phoneHint ? ` לטלפון שמסתיים ב-${snapshot.phoneHint}` : ' לטלפון'} כדי להמשיך.
          </p>
          <form onSubmit={submitCode} className="mt-3 flex flex-wrap items-end gap-3">
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
        </div>
      )}
    </section>
  );
}

function ProviderPensionView({ provider }) {
  const { snapshot, setWatch, actionError, setActionError } = useProviderSnapshot(provider.statusPath);
  const [starting, setStarting] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [submittingOtp, setSubmittingOtp] = useState(false);

  const missingCredentials =
    snapshot.credentialsConfigured === false || snapshot.status === 'MISSING_CREDENTIALS';
  const busy = starting || ACTIVE.has(snapshot.status);
  const portfolio = snapshot.portfolio;
  const policies = withProviderBadge(portfolio?.policies || [], provider.badge);
  const groups = useMemo(() => groupPolicies(policies), [policies]);

  async function syncProvider() {
    setActionError('');
    setStarting(true);
    try {
      await request(provider.scrapePath, { method: 'POST', body: '{}' });
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
      await request(provider.otpPath, {
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
    <>
      {missingCredentials ? (
        <CredentialsBanner
          message={`לא הוגדרו פרטי כניסה בקובץ .env – יש להזין ${provider.missingEnv} ולהפעיל מחדש את השרת.`}
        />
      ) : null}

      <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
              <PiggyBank size={20} aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">{provider.title}</h2>
              <p className="text-sm text-muted">{provider.subtitle}</p>
              <p className="mt-2 text-xs text-muted">
                סטטוס: {STATUS_LABEL[snapshot.status] || snapshot.status}
                {snapshot.sessionSaved
                  ? snapshot.status === 'SUCCESS'
                    ? ' · סשן שמור'
                    : ' · סשן שמור (לרוב בלי SMS)'
                  : ' · נדרש SMS בכניסה הראשונה'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={syncProvider}
            disabled={busy || missingCredentials}
            className="inline-flex items-center gap-2 rounded-full bg-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-teal-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : null}
            {snapshot.sessionSaved ? 'רענון נתוני פנסיה' : 'סנכרן נתוני פנסיה'}
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
              {provider.emptyHint}
            </p>
          ) : null}

          <section className="grid gap-4 md:grid-cols-2">
            {groups.length === 0 ? (
              <p className="rounded-3xl border border-line bg-card p-5 text-sm text-muted">
                לא נמצאו תוכניות עם יתרה להצגה.
              </p>
            ) : (
              groups.map((group) => <PolicyGroupCard key={group.id} group={group} />)
            )}
          </section>
        </>
      )}
    </>
  );
}

function EfratPensionView() {
  const meitav = useProviderSnapshot(EFRAT_SOURCES[0].statusPath);
  const phoenix = useProviderSnapshot(EFRAT_SOURCES[1].statusPath);
  const harel = useProviderSnapshot(EFRAT_SOURCES[2].statusPath);

  const combinedPolicies = useMemo(() => {
    const meitavPolicies = withProviderBadge(
      meitav.snapshot.status === 'SUCCESS' ? meitav.snapshot.portfolio?.policies || [] : [],
      'מיטב',
    );
    const phoenixPolicies = withProviderBadge(
      phoenix.snapshot.status === 'SUCCESS' ? phoenix.snapshot.portfolio?.policies || [] : [],
      'הפניקס',
    );
    const harelPolicies = withProviderBadge(
      harel.snapshot.status === 'SUCCESS' ? harel.snapshot.portfolio?.policies || [] : [],
      'הראל',
    );
    return [...meitavPolicies, ...phoenixPolicies, ...harelPolicies];
  }, [meitav.snapshot, phoenix.snapshot, harel.snapshot]);

  const groups = useMemo(() => groupPolicies(combinedPolicies), [combinedPolicies]);

  const meitavTotal =
    meitav.snapshot.status === 'SUCCESS'
      ? Number(meitav.snapshot.portfolio?.totalPensionBalance) || 0
      : 0;
  const phoenixTotal =
    phoenix.snapshot.status === 'SUCCESS'
      ? Number(phoenix.snapshot.portfolio?.totalPensionBalance) || 0
      : 0;
  const harelTotal =
    harel.snapshot.status === 'SUCCESS'
      ? Number(harel.snapshot.portfolio?.totalPensionBalance) || 0
      : 0;
  const combinedTotal = meitavTotal + phoenixTotal + harelTotal;
  const hasAnySuccess =
    meitav.snapshot.status === 'SUCCESS' ||
    phoenix.snapshot.status === 'SUCCESS' ||
    harel.snapshot.status === 'SUCCESS';

  return (
    <>
      <section className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 rounded-2xl bg-teal/10 p-2 text-teal">
            <PiggyBank size={20} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">פנסיה וחיסכון ארוך טווח - אפרת</h2>
            <p className="text-sm text-muted">
              מיטב, הפניקס והראל (גמל). סנכרנו כל ספק בנפרד.
            </p>
          </div>
        </div>
      </section>

      {hasAnySuccess ? (
        <section className="grid gap-4 sm:grid-cols-2">
          <article className="rounded-3xl border border-line bg-card p-5">
            <p className="text-sm text-muted">סך חיסכון כולל - אפרת</p>
            <p className="mt-3 font-display text-3xl text-ink" dir="ltr">
              {formatMoney(combinedTotal)}
            </p>
            <p className="mt-2 text-xs text-muted" dir="ltr">
              מיטב: {formatMoney(meitavTotal)} + הפניקס: {formatMoney(phoenixTotal)} + הראל:{' '}
              {formatMoney(harelTotal)}
            </p>
          </article>
          <article className="rounded-3xl border border-line bg-card p-5">
            <p className="text-sm text-muted">סה״כ תוכניות וקופות</p>
            <p className="mt-3 font-display text-3xl text-ink" dir="ltr">
              {combinedPolicies.length}
            </p>
          </article>
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {EFRAT_SOURCES.map((source) => (
          <ProviderSyncCard key={source.id} source={source} />
        ))}
      </section>

      {hasAnySuccess ? (
        <section className="grid gap-4 md:grid-cols-2">
          {groups.length === 0 ? (
            <p className="rounded-3xl border border-line bg-card p-5 text-sm text-muted md:col-span-2">
              לא נמצאו תוכניות עם יתרה להצגה. סנכרנו מיטב, הפניקס ו/או הראל.
            </p>
          ) : (
            groups.map((group) => <PolicyGroupCard key={group.id} group={group} />)
          )}
        </section>
      ) : null}
    </>
  );
}

export default function PensionTab() {
  const [person, setPerson] = useState('meni');
  const provider = PROVIDERS.meni;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6" dir="rtl">
      <nav className="flex flex-wrap gap-2" aria-label="בחירת אדם">
        <CaseTab selected={person === 'meni'} onClick={() => setPerson('meni')}>
          מני
        </CaseTab>
        <CaseTab selected={person === 'efrat'} onClick={() => setPerson('efrat')}>
          אפרת
        </CaseTab>
      </nav>

      {person === 'efrat' ? (
        <EfratPensionView />
      ) : (
        <ProviderPensionView key={provider.id} provider={provider} />
      )}
    </main>
  );
}
