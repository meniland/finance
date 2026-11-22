import { calculateWeightedBalance } from '../utils/balanceCalculator.js';

const money = new Intl.NumberFormat('he-IL', {
  style: 'currency',
  currency: 'ILS',
  maximumFractionDigits: 2,
});

const CONFIG_HINT = 'src/config/recurringExpenses.json';

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return money.format(Number(value));
}

function amountTone(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount === 0) return 'text-ink';
  return amount > 0 ? 'text-credit' : 'text-danger';
}

function BreakdownGroup({ title, lines, emptyText }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold tracking-wide text-ink">{title}</p>
      {lines.length > 0 ? (
        <ul className="space-y-0.5">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p>{emptyText}</p>
      )}
    </div>
  );
}

export default function BalanceSummaryPanels({ bankSnapshot, calSnapshot, referenceDate }) {
  const summary = calculateWeightedBalance(bankSnapshot, calSnapshot, referenceDate || new Date());
  const bankAccount = (bankSnapshot?.accounts || [])[0];
  const bankReady = summary.isBankDataLoaded;
  const calReady = summary.isCalDataLoaded;

  return (
    <section className="grid gap-4 sm:grid-cols-2" aria-label="סיכום יתרות">
      <article className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
        <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">יתרה אמיתית בבנק</p>
        <p className={`mt-3 font-display text-3xl sm:text-4xl ${amountTone(summary.actualBankBalance)}`} dir="ltr">
          {formatMoney(summary.actualBankBalance)}
        </p>
        <p className="mt-3 text-sm text-muted">
          {!bankReady
            ? 'טען נתוני בנק בינלאומי כדי להציג יתרה'
            : bankAccount?.accountNumber
              ? `חשבון ${bankAccount.accountNumber}${
                  bankSnapshot?.finishedAt ? ` · עודכן ${new Date(bankSnapshot.finishedAt).toLocaleString('he-IL')}` : ''
                }`
              : 'יתרת עו״ש נוכחית מבינלאומי'}
        </p>
      </article>

      <article className="rounded-3xl border border-line bg-card p-5 shadow-[0_16px_40px_rgb(28_25_21_/_0.05)]">
        <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
          יתרה משוקללת (אחרי קיזוז אשראי והתחייבויות)
        </p>
        <p className={`mt-3 font-display text-3xl sm:text-4xl ${amountTone(summary.weightedBalance)}`} dir="ltr">
          {formatMoney(summary.weightedBalance)}
        </p>

        {!bankReady ? (
          <p className="mt-3 text-sm text-muted">נדרשת יתרת בנק לחישוב משוקלל</p>
        ) : (
          <div className="mt-3 space-y-3 text-sm text-muted">
            <p>
              קוזז סה״כ:{' '}
              <span className="font-medium text-ink tabular-nums" dir="ltr">
                {formatMoney(summary.totalDeducted)}
              </span>
              {summary.dayOfMonth ? ` · יום ${summary.dayOfMonth} בחודש` : ''}
            </p>

            <BreakdownGroup
              title="קיזוזי כרטיסי אשראי (CAL)"
              lines={summary.calBreakdown || []}
              emptyText={
                calReady ? 'אין קיזוזי כאל להצגה' : 'טען נתוני כאל לחישוב קיזוז חיובים עתידיים'
              }
            />

            <BreakdownGroup
              title="התחייבויות קבועות בבנק (הוראות קבע / שיקים / העברות)"
              lines={summary.recurringBreakdown || []}
              emptyText="אין התחייבויות קבועות מוגדרות"
            />

            <p className="text-xs text-muted/80">
              לעריכת סכומים או הוספת פריטים: <span dir="ltr">{CONFIG_HINT}</span>
            </p>
          </div>
        )}
      </article>
    </section>
  );
}
