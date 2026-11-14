// データモデルと純粋関数（表示・集計・検証）
export const MAX_AMOUNT = 999999999;
export const MAX_LOG = 5000;
export const UNCAT = { expense: 'uncat-e', income: 'uncat-i' };

const uid = () => crypto.randomUUID();

export function defaultState() {
  const cat = (type, emoji, name) => ({ id: uid(), type, emoji, name, budget: 0, archived: false });
  return {
    v: 1,
    tx: [],
    cats: [
      { id: UNCAT.expense, type: 'expense', emoji: '❓', name: '未分類', budget: 0, archived: false, system: true },
      cat('expense', '🍙', '食費'),
      cat('expense', '🍜', '外食'),
      cat('expense', '🧴', '日用品'),
      cat('expense', '🚃', '交通'),
      cat('expense', '🏠', '住まい'),
      cat('expense', '💡', '水道光熱'),
      cat('expense', '📱', '通信'),
      cat('expense', '🎮', '趣味'),
      cat('expense', '👕', '服'),
      cat('expense', '💊', '医療'),
      cat('expense', '🎁', '交際'),
      cat('expense', '📚', '学び'),
      cat('expense', '💇', '美容'),
      cat('expense', '🔁', 'サブスク'),
      cat('expense', '📦', 'その他'),
      { id: UNCAT.income, type: 'income', emoji: '❓', name: '未分類', budget: 0, archived: false, system: true },
      cat('income', '💰', '給料'),
      cat('income', '💼', '副業'),
      cat('income', '🎉', '臨時収入'),
      cat('income', '➕', 'その他'),
    ],
    pays: ['現金', 'クレジットカード', '電子マネー', '口座引き落とし'].map((name) => ({ id: uid(), name })),
    favs: [],
    recs: [],
    budget: { monthly: 0 },
    log: [],
    settings: { autoLockMin: 5, lastPay: null, lastBackupAt: 0, installHintHidden: false },
  };
}

// ---- 日付 ----
const pad = (n) => String(n).padStart(2, '0');
export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(ds, n) {
  const [y, m, d] = ds.split('-').map(Number);
  return dateStr(new Date(y, m - 1, d + n));
}
export const ymOf = (ds) => ds.slice(0, 7);
export function ymAdd(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
export function ymLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}
const WD = ['日', '月', '火', '水', '木', '金', '土'];
export function dayLabel(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const today = dateStr();
  const w = WD[new Date(y, m - 1, d).getDay()];
  if (ds === today) return `今日 ${m}/${d}(${w})`;
  if (ds === addDays(today, -1)) return `昨日 ${m}/${d}(${w})`;
  return `${m}/${d}(${w})`;
}

// ---- 金額 ----
export const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
export const signedYen = (n) => (n < 0 ? '−' : n > 0 ? '+' : '') + yen(Math.abs(n));

// ---- 集計 ----
export const liveTx = (s) => s.tx.filter((t) => !t.deleted);
export const txOfMonth = (s, ym) => liveTx(s).filter((t) => t.date.startsWith(ym));

export function monthTotals(s, ym) {
  let income = 0, expense = 0;
  for (const t of txOfMonth(s, ym)) {
    if (t.type === 'income') income += t.amount; else expense += t.amount;
  }
  return { income, expense, balance: income - expense };
}

export function byCategory(s, ym, type = 'expense') {
  const map = new Map();
  for (const t of txOfMonth(s, ym)) {
    if (t.type !== type) continue;
    map.set(t.cat, (map.get(t.cat) || 0) + t.amount);
  }
  return [...map.entries()].map(([cat, amount]) => ({ cat, amount })).sort((a, b) => b.amount - a.amount);
}

// 連続記録日数（今日 or 昨日から遡る）
export function streak(s) {
  const days = new Set(liveTx(s).map((t) => t.createdAt && dateStr(new Date(t.createdAt))));
  let d = dateStr();
  if (!days.has(d)) d = addDays(d, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

// ---- 検証・整形 ----
export function validAmount(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_AMOUNT;
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isYm = (v) => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);

// 復元データ等を安全な形に整える（想定外の値は捨てる）
export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) throw new Error('形式が違います');
  const base = defaultState();
  const arr = (v) => (Array.isArray(v) ? v : []);
  const cats = arr(raw.cats).filter((c) => c && typeof c.id === 'string' && (c.type === 'expense' || c.type === 'income'))
    .map((c) => ({ id: str(c.id, 64), type: c.type, emoji: str(c.emoji, 8) || '📦', name: str(c.name, 12) || '名称なし',
      budget: validAmount(c.budget) ? c.budget : 0, archived: !!c.archived, system: !!c.system }));
  for (const t of ['expense', 'income']) {
    if (!cats.some((c) => c.id === UNCAT[t])) cats.unshift(base.cats.find((c) => c.id === UNCAT[t]));
  }
  const tx = arr(raw.tx).filter((t) => t && typeof t.id === 'string' && validAmount(t.amount) && isDate(t.date)
    && (t.type === 'expense' || t.type === 'income'))
    .map((t) => ({ id: str(t.id, 64), type: t.type, amount: t.amount, cat: str(t.cat, 64), date: t.date,
      memo: str(t.memo, 100), pay: str(t.pay, 64), rec: t.rec ? str(t.rec, 64) : undefined,
      createdAt: Number(t.createdAt) || Date.now(), updatedAt: Number(t.updatedAt) || Date.now(),
      deleted: !!t.deleted, deletedAt: t.deleted ? Number(t.deletedAt) || Date.now() : undefined }));
  const pays = arr(raw.pays).filter((p) => p && typeof p.id === 'string').map((p) => ({ id: str(p.id, 64), name: str(p.name, 20) || '名称なし' }));
  const favs = arr(raw.favs).filter((f) => f && typeof f.id === 'string' && validAmount(f.amount))
    .map((f) => ({ id: str(f.id, 64), type: f.type === 'income' ? 'income' : 'expense', amount: f.amount,
      cat: str(f.cat, 64), memo: str(f.memo, 100), pay: str(f.pay, 64) }));
  const recs = arr(raw.recs).filter((r) => r && typeof r.id === 'string' && validAmount(r.amount))
    .map((r) => ({ id: str(r.id, 64), type: r.type === 'income' ? 'income' : 'expense', amount: r.amount,
      cat: str(r.cat, 64), memo: str(r.memo, 100), pay: str(r.pay, 64),
      day: Math.min(31, Math.max(1, parseInt(r.day, 10) || 1)), startYm: isYm(r.startYm) ? r.startYm : ymOf(dateStr()),
      lastYm: isYm(r.lastYm) ? r.lastYm : null, active: r.active !== false }));
  const log = arr(raw.log).filter((l) => l && typeof l.id === 'string').slice(-MAX_LOG);
  return {
    v: 1, tx, cats, pays, favs, recs, log,
    budget: { monthly: validAmount(raw.budget?.monthly) ? raw.budget.monthly : 0 },
    settings: {
      autoLockMin: [1, 3, 5, 10, 30].includes(raw.settings?.autoLockMin) ? raw.settings.autoLockMin : 5,
      lastPay: typeof raw.settings?.lastPay === 'string' ? raw.settings.lastPay : null,
      lastBackupAt: Number(raw.settings?.lastBackupAt) || 0,
      installHintHidden: !!raw.settings?.installHintHidden,
    },
  };
}

// ---- 固定費（毎月の自動記録）----
// 戻り値: 追加した取引の配列
export function processRecurring(s, now = new Date()) {
  const today = dateStr(now);
  const curYm = ymOf(today);
  const added = [];
  for (const r of s.recs) {
    if (!r.active) continue;
    let ym = r.lastYm ? ymAdd(r.lastYm, 1) : r.startYm;
    let guard = 0;
    while (ym <= curYm && guard++ < 120) {
      const day = Math.min(r.day, daysInMonth(ym));
      const date = `${ym}-${pad(day)}`;
      if (date > today) break;
      const t = { id: uid(), type: r.type, amount: r.amount, cat: r.cat, date, memo: r.memo, pay: r.pay,
        rec: r.id, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
      s.tx.push(t);
      added.push(t);
      r.lastYm = ym;
      ym = ymAdd(ym, 1);
    }
  }
  return added;
}

// ---- CSV ----
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // CSVインジェクション対策
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(s) {
  const catName = (id) => s.cats.find((c) => c.id === id)?.name ?? '';
  const payName = (id) => s.pays.find((p) => p.id === id)?.name ?? '';
  const rows = [['日付', '種類', 'カテゴリ', '金額', '支払い方法', 'メモ']];
  for (const t of liveTx(s).sort((a, b) => a.date.localeCompare(b.date))) {
    rows.push([t.date, t.type === 'income' ? '収入' : '支出', catName(t.cat), t.amount, payName(t.pay), t.memo]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
