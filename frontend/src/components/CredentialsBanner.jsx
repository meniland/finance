export default function CredentialsBanner() {
  return (
    <p className="rounded-2xl border border-amber/30 bg-amber-soft px-4 py-3 text-sm leading-6 text-amber" role="status">
      לא הוגדרו פרטי התחברות בקובץ .env – יש להזין שם משתמש וסיסמה ולהפעיל מחדש את השרת כדי לשלוף נתונים.
    </p>
  );
}
