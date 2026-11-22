import {
  billingDayOf,
  calculateWeightedBalance,
  chargeAmountOf,
  evaluateRecurringExpenses,
  hasClearedCalDebit,
  israelDateParts,
} from '../src/utils/balanceCalculator.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const bank = {
  accounts: [
    {
      accountNumber: '591254',
      balance: 10000,
      txns: [
        {
          date: '2026-11-01T22:00:00.000Z',
          description: 'עפ"י הרשאה כאל',
          chargedAmount: -5000,
          status: 'completed',
        },
        {
          date: '2026-11-01T22:00:00.000Z',
          description: 'הורא.קבע 3290525',
          chargedAmount: -2000,
          status: 'completed',
        },
        {
          date: '2026-11-01T22:00:00.000Z',
          description: 'הורא.קבע 3290526',
          chargedAmount: -1200,
          status: 'completed',
        },
        {
          date: '2026-10-19T21:00:00.000Z',
          description: 'בית ספר יסודי ה',
          chargedAmount: -530.08,
          status: 'completed',
        },
      ],
    },
  ],
};

const cal = {
  accounts: [
    { accountNumber: '4034', balance: 2000, nextChargeDate: '2026-12-02T00:00:00.000Z', txns: [] },
    { accountNumber: '0467', balance: 1500, nextChargeDate: '2026-12-15T00:00:00.000Z', txns: [] },
  ],
};

assert(billingDayOf(cal.accounts[0]) === 2, 'billing 2');
assert(billingDayOf(cal.accounts[1]) === 15, 'billing 15');
assert(chargeAmountOf(cal.accounts[0]) === 2000, 'charge');

const after15 = calculateWeightedBalance(bank, cal, new Date('2026-11-19T10:00:00+02:00'));
assert(after15.calDeducted === 0, `after15 cal deduct 0 got ${after15.calDeducted}`);
// Fixture clears 3290525+3290526 only; 7500 is after the 28th → next month; rest still deduct.
const expectedRecurring = 600 + 600 + 1000 + 530.08;
assert(after15.recurringDeducted === expectedRecurring, `recurring got ${after15.recurringDeducted}`);
assert(
  after15.weightedBalance === 10000 - expectedRecurring,
  `weighted got ${after15.weightedBalance}`,
);
assert(after15.recurringBreakdown.some((line) => line.includes('3290525') && line.includes('לא קוזז')), 'hk cleared');
assert(after15.recurringBreakdown.some((line) => line.includes('יסודי') && line.includes('קוזז')), 'school pending');
assert(
  after15.recurringBreakdown.some((line) => line.includes('7,500') && line.includes('חודש הבא')),
  '7500 deferred',
);

const after28 = calculateWeightedBalance(bank, cal, new Date('2026-11-29T10:00:00+02:00'));
assert(after28.recurringBreakdown.some((line) => line.includes('7,500') && line.includes('קוזז')), '7500 active after 28');

const day1 = calculateWeightedBalance(bank, cal, new Date('2026-11-01T10:00:00+02:00'));
assert(day1.calDeducted === 3500, `day1 cal got ${day1.calDeducted}`);

const day2Cleared = calculateWeightedBalance(bank, cal, new Date('2026-11-02T10:00:00+02:00'));
assert(day2Cleared.calDeducted === 1500, `day2 cleared only 15th got ${day2Cleared.calDeducted}`);

const bankNoClear = { accounts: [{ accountNumber: '1', balance: 10000, txns: [] }] };
const day2Open = calculateWeightedBalance(bankNoClear, cal, new Date('2026-11-02T10:00:00+02:00'));
assert(day2Open.calDeducted === 3500, `day2 open both got ${day2Open.calDeducted}`);
assert(
  day2Open.recurringDeducted === 2000 + 1200 + 600 + 600 + 1000 + 530.08,
  `all recurring open except deferred 7500 got ${day2Open.recurringDeducted}`,
);

const mid = calculateWeightedBalance(bank, cal, new Date('2026-11-10T10:00:00+02:00'));
assert(mid.calDeducted === 1500, 'mid only 15');

const day15ClearedBank = {
  accounts: [
    {
      accountNumber: '1',
      balance: 8000,
      txns: [{ date: '2026-11-14T22:00:00.000Z', description: 'עפ"י הרשאה כאל', chargedAmount: -1500 }],
    },
  ],
};
const day15 = calculateWeightedBalance(day15ClearedBank, cal, new Date('2026-11-15T10:00:00+02:00'));
assert(day15.calDeducted === 0, `day15 cleared got ${day15.calDeducted}`);

const noCal = calculateWeightedBalance(bank, { accounts: null }, new Date('2026-11-10T10:00:00+02:00'));
assert(noCal.isCalDataLoaded === false, 'cal not loaded');
assert(noCal.calDeducted === 0, 'no cal deduct');
assert(noCal.recurringDeducted > 0, 'recurring still applies without cal');

assert(hasClearedCalDebit(bank, 2026, 11, 2, [2000]) === true, 'cleared detect');

const parts = israelDateParts(new Date('2026-11-19T10:00:00+02:00'));
const evaluated = evaluateRecurringExpenses(bank, parts);
assert(evaluated.find((item) => item.id === 'hk-3290525')?.matched === true, 'match 3290525');
assert(evaluated.find((item) => item.id === 'school-yesodi-h')?.matched === false, 'school not this month');

console.log('balanceCalculator ok');
