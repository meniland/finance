/**
 * Weighted bank-balance calculator for Beinleumi + Visa CAL + recurring expenses.
 *
 * Deducts:
 * 1. Upcoming CAL billing amounts (by day-of-month / clearance rules)
 * 2. Configured recurring bank debits that have not yet cleared this month
 */

import recurringExpensesConfig from '../config/recurringExpenses.json' with { type: 'json' };

const CAL_KEYWORDS = /כאל|ויזה|visa|\bcal\b|אשראי/i;
const AMOUNT_TOLERANCE = 0.05;
const RECURRING_AMOUNT_TOLERANCE = 1;

/**
 * @param {Date|string|number} value
 * @returns {{ year: number, month: number, day: number } | null}
 */
export function israelDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value);
  const year = read('year');
  const month = read('month');
  const day = read('day');
  if (![year, month, day].every((n) => Number.isInteger(n))) return null;
  return { year, month, day };
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value.replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatIls(value) {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function cardLabel(account) {
  const raw = String(account?.accountNumber || '').trim();
  return raw.slice(-4) || raw || '????';
}

function normalizeRules(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => {
      const dueAfterDayRaw = asNumber(rule?.dueAfterDay);
      const dueAfterDay =
        dueAfterDayRaw !== null && dueAfterDayRaw >= 1 && dueAfterDayRaw <= 31
          ? Math.trunc(dueAfterDayRaw)
          : null;
      return {
        id: String(rule?.id || '').trim(),
        label: String(rule?.label || rule?.id || 'הוצאה קבועה').trim(),
        amount: Math.abs(asNumber(rule?.amount) || 0),
        matchKeywords: (Array.isArray(rule?.matchKeywords) ? rule.matchKeywords : [])
          .map((keyword) => String(keyword || '').trim())
          .filter(Boolean),
        matchExactAmount: Boolean(rule?.matchExactAmount),
        // If set, the expense only belongs to the current month after this day;
        // before that it is treated as next-month and not deducted.
        dueAfterDay,
      };
    })
    .filter((rule) => rule.amount > 0 && rule.matchKeywords.length > 0);
}

/**
 * Billing day (2 or 15) from nextChargeDate, with optional last4 fallback map.
 * @param {object} account
 * @param {Record<string, number>} [fallbackByLast4]
 */
export function billingDayOf(account, fallbackByLast4 = {}) {
  const next = israelDateParts(account?.nextChargeDate);
  if (next && (next.day === 2 || next.day === 15)) return next.day;

  const last4 = String(account?.accountNumber || '').slice(-4);
  const mapped = Number(fallbackByLast4[last4]);
  if (mapped === 2 || mapped === 15) return mapped;
  return null;
}

/**
 * Full upcoming charge for a card. Prefers CAL balance (nextTotalDebit).
 */
export function chargeAmountOf(account) {
  const balance = asNumber(account?.balance);
  if (balance !== null && balance !== 0) return Math.abs(balance);

  const txns = Array.isArray(account?.txns) ? account.txns : [];
  if (!txns.length) return 0;
  const sum = txns.reduce((total, txn) => total + Math.abs(asNumber(txn?.chargedAmount) || 0), 0);
  return Number.isFinite(sum) ? sum : 0;
}

function bankTransactions(bankData) {
  const accounts = Array.isArray(bankData?.accounts) ? bankData.accounts : [];
  return accounts.flatMap((account) =>
    (account?.txns || []).map((txn) => ({
      ...txn,
      accountNumber: account.accountNumber,
    })),
  );
}

function actualBankBalanceOf(bankData) {
  const accounts = Array.isArray(bankData?.accounts) ? bankData.accounts : [];
  if (!accounts.length) return null;
  let sum = 0;
  let saw = false;
  for (const account of accounts) {
    const balance = asNumber(account?.balance);
    if (balance === null) continue;
    sum += balance;
    saw = true;
  }
  return saw ? sum : null;
}

/**
 * Debits in the Israel calendar month of `referenceParts` (completed or pending).
 */
export function currentMonthDebits(bankData, referenceParts) {
  if (!referenceParts) return [];
  return bankTransactions(bankData).filter((txn) => {
    const amount = asNumber(txn?.chargedAmount);
    if (amount === null || amount >= 0) return false;
    const parts = israelDateParts(txn?.date || txn?.processedDate);
    if (!parts) return false;
    return parts.year === referenceParts.year && parts.month === referenceParts.month;
  });
}

/**
 * @param {object} rule
 * @param {object[]} monthDebits
 */
export function recurringRuleMatched(rule, monthDebits) {
  const keywords = (rule.matchKeywords || []).map((keyword) => String(keyword).toLowerCase());
  if (!keywords.length) return false;

  for (const txn of monthDebits) {
    const description = `${txn?.description || ''} ${txn?.memo || ''}`.toLowerCase();
    if (!keywords.some((keyword) => description.includes(keyword.toLowerCase()))) continue;

    if (rule.matchExactAmount) {
      const abs = Math.abs(asNumber(txn?.chargedAmount) || 0);
      if (Math.abs(abs - rule.amount) > RECURRING_AMOUNT_TOLERANCE) continue;
    }
    return true;
  }
  return false;
}

/**
 * True when Beinleumi already shows a CAL debit on the given Israel calendar day.
 */
export function hasClearedCalDebit(bankData, year, month, day, expectedAmounts = []) {
  const expected = expectedAmounts
    .map((value) => Math.abs(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0);

  for (const txn of bankTransactions(bankData)) {
    const amount = asNumber(txn?.chargedAmount);
    if (amount === null || amount >= 0) continue;

    const parts = israelDateParts(txn?.date || txn?.processedDate);
    if (!parts || parts.year !== year || parts.month !== month || parts.day !== day) continue;

    const description = `${txn?.description || ''} ${txn?.memo || ''}`;
    if (CAL_KEYWORDS.test(description)) return true;

    const abs = Math.abs(amount);
    if (expected.some((target) => Math.abs(target - abs) <= AMOUNT_TOLERANCE)) return true;
  }
  return false;
}

function emptyResult(overrides = {}) {
  return {
    actualBankBalance: null,
    weightedBalance: null,
    totalDeducted: 0,
    calDeducted: 0,
    recurringDeducted: 0,
    deductionBreakdown: [],
    calBreakdown: [],
    recurringBreakdown: [],
    isCalDataLoaded: false,
    isBankDataLoaded: false,
    dayOfMonth: null,
    ...overrides,
  };
}

function buildCalDecisions(bankData, calAccounts, today, options) {
  const cards = calAccounts
    .map((account) => {
      const billingDay = billingDayOf(account, options.billingDayByLast4 || {});
      const amount = chargeAmountOf(account);
      return {
        account,
        label: cardLabel(account),
        billingDay,
        amount,
      };
    })
    .filter((card) => card.billingDay === 2 || card.billingDay === 15);

  const cardsOn = (day) => cards.filter((card) => card.billingDay === day && card.amount > 0);
  const secondCards = cardsOn(2);
  const fifteenthCards = cardsOn(15);
  const dayOfMonth = today.day;

  /** @type {Array<{ card: typeof cards[number], deducted: boolean, reason: string }>} */
  const decisions = [];
  const mark = (list, deducted, reason) => {
    for (const card of list) decisions.push({ card, deducted, reason });
  };

  if (dayOfMonth > 15) {
    mark(secondCards, false, 'לא קוזז (שייך למחזור החודש הבא)');
    mark(fifteenthCards, false, 'לא קוזז (שייך למחזור החודש הבא)');
  } else if (dayOfMonth === 1) {
    mark(secondCards, true, 'קוזז');
    mark(fifteenthCards, true, 'קוזז');
  } else if (dayOfMonth === 2) {
    const cleared = hasClearedCalDebit(
      bankData,
      today.year,
      today.month,
      2,
      secondCards.map((card) => card.amount),
    );
    if (cleared) {
      mark(secondCards, false, 'לא קוזז (כבר ירד בחשבון הבנק)');
      mark(fifteenthCards, true, 'קוזז');
    } else {
      mark(secondCards, true, 'קוזז (עדיין לא ירד בבנק)');
      mark(fifteenthCards, true, 'קוזז');
    }
  } else if (dayOfMonth >= 3 && dayOfMonth <= 14) {
    mark(secondCards, false, 'לא קוזז (חיוב ה-2 כבר עבר)');
    mark(fifteenthCards, true, 'קוזז');
  } else if (dayOfMonth === 15) {
    const cleared = hasClearedCalDebit(
      bankData,
      today.year,
      today.month,
      15,
      fifteenthCards.map((card) => card.amount),
    );
    if (cleared) {
      mark(secondCards, false, 'לא קוזז (חיוב ה-2 כבר עבר)');
      mark(fifteenthCards, false, 'לא קוזז (כבר ירד בחשבון הבנק)');
    } else {
      mark(secondCards, false, 'לא קוזז (חיוב ה-2 כבר עבר)');
      mark(fifteenthCards, true, 'קוזז (עדיין לא ירד בבנק)');
    }
  }

  return decisions;
}

/**
 * Evaluate recurring expense rules against current-month bank debits.
 * Exported for unit tests.
 */
export function evaluateRecurringExpenses(bankData, referenceParts, rules = recurringExpensesConfig) {
  const normalized = normalizeRules(rules);
  const monthDebits = currentMonthDebits(bankData, referenceParts);
  const dayOfMonth = referenceParts?.day ?? null;

  return normalized.map((rule) => {
    if (rule.dueAfterDay != null && dayOfMonth != null && dayOfMonth <= rule.dueAfterDay) {
      return {
        id: rule.id,
        label: rule.label,
        amount: rule.amount,
        deducted: false,
        matched: false,
        deferredToNextMonth: true,
        line: `✓ ${rule.label}: לא קוזז (שייך לחודש הבא — אחרי ה-${rule.dueAfterDay})`,
      };
    }

    const matched = recurringRuleMatched(rule, monthDebits);
    return {
      id: rule.id,
      label: rule.label,
      amount: rule.amount,
      deducted: !matched,
      matched,
      deferredToNextMonth: false,
      line: matched
        ? `✓ ${rule.label}: לא קוזז (כבר ירד בחשבון)`
        : `- ${rule.label}: קוזז ${formatIls(rule.amount)}`,
    };
  });
}

/**
 * @param {object|null} bankData Beinleumi snapshot (`{ accounts: [...] }`)
 * @param {object|null} calData CAL snapshot (`{ accounts: [...] }`)
 * @param {Date} [referenceDate]
 * @param {{ billingDayByLast4?: Record<string, number>, recurringExpenses?: object[] }} [options]
 */
export function calculateWeightedBalance(bankData, calData, referenceDate = new Date(), options = {}) {
  const today = israelDateParts(referenceDate);
  if (!today) return emptyResult();

  const dayOfMonth = today.day;
  const actualBankBalance = actualBankBalanceOf(bankData);
  const isBankDataLoaded = actualBankBalance !== null;
  const calAccounts = Array.isArray(calData?.accounts) ? calData.accounts : [];
  const isCalDataLoaded = calAccounts.length > 0;
  const rules = options.recurringExpenses || recurringExpensesConfig;

  /** @type {string[]} */
  let calBreakdown = [];
  let calDeducted = 0;

  if (!isCalDataLoaded) {
    if (isBankDataLoaded) {
      calBreakdown = ['טען נתוני כאל לחישוב קיזוז חיובים עתידיים'];
    }
  } else {
    const decisions = buildCalDecisions(bankData, calAccounts, today, options);
    const deductedCards = decisions.filter((item) => item.deducted && item.card.amount > 0);
    calDeducted = deductedCards.reduce((sum, item) => sum + item.card.amount, 0);
    calBreakdown = decisions
      .filter((item) => item.card.amount > 0 || item.deducted)
      .map((item) => {
        const prefix = `כרטיס ${item.card.label} (חיוב ב-${item.card.billingDay})`;
        if (item.deducted) return `${prefix}: קוזז ${formatIls(item.card.amount)}`;
        return `${prefix}: ${item.reason}`;
      });

    if (calBreakdown.length === 0) {
      calBreakdown.push(
        dayOfMonth > 15
          ? 'אין קיזוז — חיובים עתידיים שייכים למחזור החודש הבא'
          : 'אין כרטיסי כאל עם סכום חיוב עתידי לקיזוז',
      );
    }
  }

  const recurringResults = isBankDataLoaded
    ? evaluateRecurringExpenses(bankData, today, rules)
    : [];
  const recurringDeducted = recurringResults
    .filter((item) => item.deducted)
    .reduce((sum, item) => sum + item.amount, 0);
  const recurringBreakdown = recurringResults.map((item) => item.line);

  const totalDeducted = calDeducted + recurringDeducted;
  const weightedBalance =
    actualBankBalance === null ? null : actualBankBalance - totalDeducted;

  const deductionBreakdown = [
    ...calBreakdown.map((line) => `כאל · ${line}`),
    ...recurringBreakdown.map((line) => `קבוע · ${line}`),
  ];

  return {
    actualBankBalance,
    weightedBalance,
    totalDeducted,
    calDeducted,
    recurringDeducted,
    deductionBreakdown,
    calBreakdown,
    recurringBreakdown,
    isCalDataLoaded,
    isBankDataLoaded,
    dayOfMonth,
  };
}
