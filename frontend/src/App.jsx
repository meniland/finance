import { useState } from 'react';
import BankTab from './components/BankTab.jsx';
import InvestmentsTab from './components/InvestmentsTab.jsx';
import PensionTab from './components/PensionTab.jsx';

const TABS = [
  { id: 'bank', label: 'מצב חשבון' },
  { id: 'investments', label: 'השקעות' },
  { id: 'pension', label: 'פנסיה' },
];

export default function App() {
  const [tab, setTab] = useState('bank');

  return (
    <div dir="rtl" className="min-h-screen">
      <header className="mx-auto flex w-full max-w-6xl flex-wrap items-end justify-between gap-4 px-4 pt-8 sm:px-6">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-teal">כספים מקומיים</p>
          <h1 className="font-sans text-4xl font-semibold tracking-tight text-ink">החשבונות שלי</h1>
        </div>
        <nav className="flex gap-2 rounded-full border border-line bg-card p-1" aria-label="ניווט">
          {TABS.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-selected={selected}
                onClick={() => setTab(item.id)}
                className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                  selected ? 'bg-teal text-white' : 'text-ink hover:bg-paper'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>
      {tab === 'bank' ? (
        <div dir="ltr">
          <BankTab />
        </div>
      ) : tab === 'investments' ? (
        <InvestmentsTab />
      ) : (
        <PensionTab />
      )}
    </div>
  );
}
