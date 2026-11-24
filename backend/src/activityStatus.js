/** Treat deposits within this window as "still contributing". */
export const RECEIVING_DEPOSITS_DAYS = 100;

/** Phoenix savings/page returns status as `{ status, statusDesc }` — unwrap to text. */
export function coerceStatusRaw(raw) {
  if (raw == null) return null;
  if (typeof raw === 'boolean' || typeof raw === 'number') return raw;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const nested =
      raw.statusDesc ??
      raw.StatusDesc ??
      raw.label ??
      raw.name ??
      raw.value ??
      raw.text ??
      raw.description ??
      null;
    if (nested != null && typeof nested !== 'object') return nested;
    return null;
  }
  return null;
}

/**
 * Normalize provider-specific activity / open-account signals into a shared shape.
 * Returns nulls when the house does not expose a reliable active/inactive flag.
 *
 * Note: "פעיל" usually means the account/policy is open — not that money is still
 * being deposited. Prefer contributionLabel / receivingDeposits for that.
 */
export function normalizeActivityStatus(raw) {
  const coerced = coerceStatusRaw(raw);
  if (coerced === true) return { isActive: true, activityLabel: 'פעיל' };
  if (coerced === false) return { isActive: false, activityLabel: 'לא פעיל' };

  const text = String(coerced ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text === '[object Object]') return { isActive: null, activityLabel: null };

  if (/מבוטל|cancelled|inactive|לא\s*פעיל|סגור|מוקפא|frozen/i.test(text)) {
    return {
      isActive: false,
      activityLabel: /מבוטל|cancel/i.test(text) ? 'מבוטל' : 'לא פעיל',
    };
  }

  if (/פעיל|active|רגיל/i.test(text)) {
    return { isActive: true, activityLabel: 'פעיל' };
  }

  return { isActive: null, activityLabel: text.slice(0, 40) };
}

export function activityFromRecord(record = {}) {
  if (!record || typeof record !== 'object') {
    return { isActive: null, activityLabel: null };
  }
  if (typeof record.isActive === 'boolean') return normalizeActivityStatus(record.isActive);
  if (typeof record.IsActive === 'boolean') return normalizeActivityStatus(record.IsActive);
  return normalizeActivityStatus(
    record.activityStatus ??
      record.activityLabel ??
      record.status ??
      record.policyStatus ??
      record.Status ??
      null,
  );
}

function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function contributionFromDeposits({
  lastDepositAt = null,
  ytdDepositAmount = null,
  asOf = new Date(),
  receivingDays = RECEIVING_DEPOSITS_DAYS,
} = {}) {
  const last = parseIsoDate(lastDepositAt);
  let receivingDeposits = null;
  if (last) {
    const ageDays = (asOf.getTime() - last.getTime()) / 86_400_000;
    receivingDeposits = ageDays >= 0 && ageDays <= receivingDays;
  } else if (ytdDepositAmount != null && Number.isFinite(Number(ytdDepositAmount))) {
    // Weak fallback when transaction dates are missing.
    receivingDeposits = Number(ytdDepositAmount) > 0.01 ? null : false;
  }

  let contributionLabel = null;
  if (receivingDeposits === true) contributionLabel = 'מופקד';
  else if (receivingDeposits === false) contributionLabel = 'ללא הפקדות';

  return {
    lastDepositAt: last ? last.toISOString().slice(0, 10) : null,
    ytdDepositAmount:
      ytdDepositAmount == null || !Number.isFinite(Number(ytdDepositAmount))
        ? null
        : Number(ytdDepositAmount),
    receivingDeposits,
    contributionLabel,
  };
}
