// 家計簿アプリ本体
// 方針: 外部通信なし / innerHTML 不使用（文字列はすべて textContent で表示）/ 鍵とデータはロック中メモリに残さない
import { deriveKey, encryptJSON, decryptJSON, randomBytes, b64e, b64d, PBKDF2_ITER } from './crypto.js';
import { LOCK_OPTIONS, txFields, frequentCats } from './model.js';
import * as db from './db.js';
import {
  defaultState, sanitizeState, processRecurring, toCSV, UNCAT, MAX_LOG, MAX_AMOUNT,
  dateStr, addDays, ymOf, ymAdd, ymLabel, dayLabel, daysInMonth, yen, signedYen,
  liveTx, txOfMonth, monthTotals, byCategory, streak, validAmount,
} from './model.js';

// ================= 状態 =================
let S = null;      // 復号済みデータ（ロック中は null）
let KEY = null;    // AES鍵（ロック中は null）
let META = null;   // { salt, iter, kind }
let REV = 0;       // 保存済みデータの版番号（別画面での上書き検知用）
const freshUi = () => ({ view: 'home', sub: null, ym: ymOf(dateStr()), q: '', type: 'all', onlyUncat: false, cat: null, histFilter: 'all', catTab: 'expense' });
let ui = freshUi();
let stickyDate = null; // まとめ入力用：直前に選んだ過去の日付 { date, at }
const $app = document.getElementById('app');
const uid = () => crypto.randomUUID();
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

// ================= DOM ヘルパー =================
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'width') el.style.width = v;
      else if (k === 'height') el.style.height = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
const btn = (label, onClick, cls = 'btn', extra = {}) => h('button', { type: 'button', class: cls, onClick, ...extra }, label);

// ================= トースト（取り消し付き） =================
let toastTimer = null;
// actions: { label, fn } または その配列。ロック中は操作を無視する
function toast(msg, actions) {
  const acts = [].concat(actions || []);
  let box = document.getElementById('toast');
  if (!box) { box = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  box.replaceChildren(h('span', { class: 'toast-msg' }, msg),
    acts.length ? h('span', { class: 'toast-acts' }, acts.map((a) => btn(a.label, () => { hideToast(); if (S && KEY) a.fn(); }, 'toast-act'))) : null);
  box.classList.toggle('multi', acts.length > 1);
  box.hidden = false;
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, acts.length ? 8000 : 3000);
}
function hideToast() {
  clearTimeout(toastTimer);
  const box = document.getElementById('toast');
  if (!box) return;
  box.classList.remove('show');
  setTimeout(() => { if (!box.classList.contains('show')) { box.hidden = true; box.replaceChildren(); } }, 250);
}
function removeToast() { clearTimeout(toastTimer); document.getElementById('toast')?.remove(); }

// ================= シート（下から出る画面） =================
let sheetEl = null;
let sheetRender = null;
let lastFocus = null;
function openSheet(renderFn) {
  closeSheet(true);
  hideToast();
  lastFocus = document.activeElement;
  sheetRender = renderFn;
  sheetEl = h('div', { class: 'overlay', onClick: (e) => { if (e.target === sheetEl) dismissSheet(); } });
  document.body.append(sheetEl);
  document.body.classList.add('noscroll');
  refreshSheet(true);
}
function refreshSheet(focus) {
  if (!sheetEl || !sheetRender) return;
  const keep = sheetEl.querySelector('.sheet')?.scrollTop || 0;
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, sheetRender());
  sheetEl.replaceChildren(sheet);
  sheet.scrollTop = keep;
  if (focus) sheet.querySelector('h2')?.focus();
}
function closeSheet(silent) {
  if (!sheetEl) return;
  sheetEl.remove();
  sheetEl = null; sheetRender = null; addState = null;
  document.body.classList.remove('noscroll');
  if (!silent && lastFocus && document.contains(lastFocus)) lastFocus.focus();
}
function dismissSheet() { if (addState && addState.step === 2) closeAdd(); else closeSheet(); }
function sheetHead(title, opts = {}) {
  return h('div', { class: 'sheet-head' },
    btn(opts.backLabel || '閉じる', opts.onBack || (() => closeSheet()), 'link-btn'),
    h('h2', { tabindex: '-1' }, title),
    opts.right || h('span', { class: 'spacer' }));
}

function confirmSheet({ title, body, ok = 'OK', danger = false, typed = null }) {
  return new Promise((resolve) => {
    let input = '';
    let done = false;
    let obs = null;
    const finish = (v) => { if (done) return; done = true; obs?.disconnect(); closeSheet(); resolve(v); };
    openSheet(() => {
      const okBtn = btn(ok, () => finish(true), danger ? 'btn btn-danger' : 'btn btn-primary');
      if (typed && input !== typed) okBtn.disabled = true;
      return [
        sheetHead(title, { onBack: () => finish(false), backLabel: 'やめる' }),
        h('div', { class: 'sheet-body' },
          ...[].concat(body).map((p) => h('p', null, p)),
          typed ? h('label', { class: 'field' }, h('span', null, `確認のため「${typed}」と入力してください`),
            h('input', { type: 'text', autocomplete: 'off', value: input, onInput: (e) => {
              input = e.target.value;
              okBtn.disabled = input !== typed;
            } })) : null,
          h('div', { class: 'btn-row' }, btn('やめる', () => finish(false), 'btn'), okBtn)),
      ];
    });
    obs = new MutationObserver(() => { if (!document.contains(sheetEl) && !done) { done = true; obs.disconnect(); resolve(false); } });
    obs.observe(document.body, { childList: true });
  });
}

// ================= 保存 =================
let saveChain = Promise.resolve();
function save() {
  if (!S || !KEY) return saveChain;
  const key = KEY;
  const data = S;
  saveChain = saveChain
    .then(async () => {
      if (KEY !== key) return; // ロックや鍵の切り替え後は書かない
      const { iv, ct } = await encryptJSON(key, data);
      if (KEY !== key) return;
      await db.putVault({ iv, ct, savedAt: Date.now(), rev: REV + 1 }, REV);
      REV += 1;
    })
    .catch((e) => {
      console.error(e);
      if (e && e.name === 'ConflictError') {
        lock('別の画面（タブ）でデータが更新されたため、安全のためロックしました。もう一度開いてください');
      } else {
        toast('保存できませんでした。空き容量を確認してください');
      }
    });
  return saveChain;
}

function addLog(act, kind, ref, summary, before, after) {
  S.log.push({ id: uid(), at: Date.now(), act, kind, ref, summary, before: clone(before), after: clone(after) });
  if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
}

// ================= 参照ヘルパー =================
const catOf = (id) => S.cats.find((c) => c.id === id) || { emoji: '❔', name: '(削除済み)', type: 'expense' };
const payOf = (id) => S.pays.find((p) => p.id === id);
const txLabel = (t) => `${catOf(t.cat).emoji} ${catOf(t.cat).name} ${yen(t.amount)}`;
const activeCats = (type) => S.cats.filter((c) => c.type === type && !c.archived);

// ================= 取引操作（すべて履歴に残す） =================
function createTx(data, { silent } = {}) {
  if (!validAmount(data.amount) || !data.cat) { toast('金額とカテゴリを確認してください'); return null; }
  const t = { id: uid(), ...data, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
  S.tx.push(t);
  if (t.pay) S.settings.lastPay = t.pay;
  addLog('create', 'tx', t.id, txLabel(t), null, t);
  save(); render();
  if (!silent) {
    const undo = { label: '取り消す', fn: () => {
      const i = S.tx.findIndex((x) => x.id === t.id);
      if (i >= 0) S.tx.splice(i, 1);
      addLog('undo', 'tx', t.id, `記録を取り消し：${txLabel(t)}`, t, null);
      save(); render();
    } };
    // 同じ内容を3回以上記録していたら「よく使う」への追加を提案
    const same = liveTx(S).filter((x) => x.type === t.type && x.cat === t.cat && x.amount === t.amount && (x.memo || '') === (t.memo || '')).length;
    const isFav = S.favs.some((f) => f.type === t.type && f.cat === t.cat && f.amount === t.amount && (f.memo || '') === (t.memo || ''));
    if (same >= 3 && !isFav && t.cat !== UNCAT[t.type]) {
      toast(`記録しました：${txLabel(t)}（よく使う記録ですね）`, [{ label: '⭐ワンタップに', fn: () => {
        S.favs.push({ id: uid(), type: t.type, amount: t.amount, cat: t.cat, memo: t.memo || '', pay: t.pay || '' });
        addLog('create', 'fav', null, `よく使うに追加：${txLabel(t)}`);
        save(); render(); toast('ホームの「よく使う」に追加しました');
      } }, undo]);
    } else {
      toast(`記録しました：${txLabel(t)}`, [undo, { label: 'メモ等', fn: () => openEdit(t.id) }]);
    }
  }
  return t;
}
function updateTx(id, patch, { verb = '変更しました' } = {}) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  if (!validAmount(patch.amount ?? t.amount) || !(patch.cat ?? t.cat)) { toast('金額とカテゴリを確認してください'); return; }
  const before = clone(t);
  Object.assign(t, patch, { updatedAt: Date.now() });
  addLog('update', 'tx', id, txLabel(t), before, t);
  save(); render();
  toast(`${verb}：${txLabel(t)}`, { label: '取り消す', fn: () => {
    const cur = clone(t);
    Object.assign(t, before, { updatedAt: Date.now() });
    addLog('undo', 'tx', id, `変更を取り消し：${txLabel(t)}`, cur, t);
    save(); render();
  } });
}
function deleteTx(id) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  t.deleted = true; t.deletedAt = Date.now();
  addLog('delete', 'tx', id, txLabel(t), { ...t, deleted: false }, null);
  save(); render();
  toast(`ゴミ箱へ移しました：${txLabel(t)}`, { label: '元に戻す', fn: () => restoreTx(id) });
  recentlyDeleted = { id, at: Date.now() };
}
let recentlyDeleted = null; // ホームに「さっき消した記録を戻す」を少しの間出す
function restoreTx(id) {
  if (recentlyDeleted?.id === id) recentlyDeleted = null;
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  t.deleted = false; delete t.deletedAt; t.updatedAt = Date.now();
  addLog('restore', 'tx', id, txLabel(t), null, t);
  save(); render();
  toast(`元に戻しました：${txLabel(t)}`);
}

// ================= 起動・ロック =================
async function boot() {
  // 他サイトに埋め込まれていたら表示しない（クリックジャッキング対策）
  if (window.top !== window.self) { $app.replaceChildren(); return; }
  await applyThemeFromPrefs();
  if (!window.isSecureContext || !crypto.subtle) {
    $app.replaceChildren(h('main', { class: 'center-screen' },
      h('h1', null, 'このままでは使えません'),
      h('p', null, '安全のため、https:// で始まるアドレスで開いてください。')));
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  try {
    META = await db.get('meta');
  } catch {
    $app.replaceChildren(h('main', { class: 'center-screen' }, h('h1', null, '保存領域を開けませんでした'),
      h('p', null, 'プライベートブラウズでは使えません。通常のSafariで開くか、ホーム画面のアイコンから起動してください。')));
    return;
  }
  if (META) renderLock();
  else if (isIOS() && !isStandalone()) renderInstallFirst();
  else renderSetup();
}

// iPhone では Safari とホーム画面アプリで保存場所が別。先にホーム画面へ追加してもらう
function renderInstallFirst() {
  $app.replaceChildren(h('main', { class: 'center-screen' },
    h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '📲'),
    h('h1', null, 'まずホーム画面に追加'),
    h('ol', { class: 'promise steps' },
      h('li', null, '画面下の ', h('b', null, '共有ボタン（□に↑）'), ' をタップ'),
      h('li', null, h('b', null, '「ホーム画面に追加」'), ' をタップ'),
      h('li', null, 'ホーム画面の ', h('b', null, '「家計簿」アイコン'), ' から開く')),
    h('p', { class: 'help' }, 'Safariのままだとデータが別の場所に保存され、しばらく使わないと消えることがあります。'),
    btn('Safariのまま使う（おすすめしません）', () => renderSetup(), 'link-btn center')));
}

// 別のタブで開かれたら、こちらはロックする（同時編集による上書きを防ぐ）
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('kakeibo') : null;
if (channel) channel.onmessage = (e) => { if (e.data === 'unlocked' && S) lock('別の画面で開かれたため、ロックしました'); };

function lock(reason) {
  KEY = null; S = null; REV = 0;
  clearTimeout(idleTimer);
  closeSheet(true); removeToast();
  ui = freshUi(); stickyDate = null; recentlyDeleted = null; addState = null;
  renderLock(reason);
}

async function getGuard() { return (await db.get('guard')) || { fails: 0, lockUntil: 0, failsSinceUnlock: 0 }; }

async function tryUnlock(pass) {
  const guard = await getGuard();
  if (Date.now() < guard.lockUntil) return { ok: false, wait: guard.lockUntil - Date.now() };
  const key = await deriveKey(pass, META.salt, META.iter);
  let state = null;
  let recovered = false;
  const vaultRec = await db.get('vault');
  try {
    state = await decryptJSON(key, vaultRec || {});
  } catch {
    try { const prev = await db.get('vault_prev'); if (prev) { state = await decryptJSON(key, prev); recovered = true; } } catch { /* 不一致 */ }
  }
  if (!state) {
    guard.fails += 1; guard.failsSinceUnlock = (guard.failsSinceUnlock || 0) + 1;
    if (guard.fails >= 5) guard.lockUntil = Date.now() + Math.min(3600e3, 30e3 * 2 ** (guard.fails - 5));
    await db.put('guard', guard);
    return { ok: false, fails: guard.fails, wait: Math.max(0, guard.lockUntil - Date.now()) };
  }
  const missed = guard.failsSinceUnlock || 0;
  await db.put('guard', { fails: 0, lockUntil: 0, failsSinceUnlock: 0 });
  KEY = key;
  REV = vaultRec?.rev || 0;
  S = sanitizeState(state);
  channel?.postMessage('unlocked');
  if (missed > 0) addLog('security', 'security', null, `前回のロック解除以降、パスコードの間違いが${missed}回ありました`);
  const added = processRecurring(S);
  for (const t of added) addLog('auto', 'tx', t.id, `固定費を自動記録：${txLabel(t)}`, null, t);
  if (added.length || missed || recovered) save();
  ui.ym = ymOf(dateStr());
  render();
  startIdleWatch();
  if (recovered) toast('最新の保存データが壊れていたため、1つ前の状態を開きました');
  else if (missed > 0) toast(`⚠️ 前回からパスコードの間違いが${missed}回ありました`);
  else if (added.length) toast(`固定費を${added.length}件、自動で記録しました`);
  return { ok: true };
}

// ---- 自動ロック ----
let idleTimer = null;
let hiddenAt = 0;
function startIdleWatch() { resetIdle(); }
function resetIdle() {
  clearTimeout(idleTimer);
  if (!S) return;
  idleTimer = setTimeout(() => lock('しばらく操作がなかったのでロックしました'), S.settings.autoLockMin * 60e3);
}
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (S) resetIdle(); }, { passive: true }));
// アプリ切り替え画面のスナップショットに金額が写らないよう、隠れる瞬間に目隠しする
const setCover = (on) => document.body.classList.toggle('privacy', on);
window.addEventListener('pagehide', () => { if (S) setCover(true); });
window.addEventListener('pageshow', () => setCover(false));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); if (S) setCover(true); return; }
  setCover(false);
  if (!S) return;
  if (Date.now() - hiddenAt >= S.settings.autoLockMin * 60e3) { lock(); return; }
  resetIdle();
  // 日付が変わっていたら固定費をチェック
  const added = processRecurring(S);
  if (added.length) {
    for (const t of added) addLog('auto', 'tx', t.id, `固定費を自動記録：${txLabel(t)}`, null, t);
    save(); render();
    toast(`固定費を${added.length}件、自動で記録しました`);
  }
});

// ================= 初回設定 =================
// パスコードの強さチェック（初回・変更で共通）
function passProblem(v, kind) {
  if (v.length < 6) return '6文字以上にしてください';
  if (kind === 'pin' && !/^\d+$/.test(v)) return '数字だけで入力してください';
  if (/^(.)\1+$/.test(v) || '01234567890123'.includes(v) || '98765432109876'.includes(v) || /^(\d\d)\1+$/.test(v)) return '同じ数字の連続や「123456」は推測されやすいので避けてください';
  return '';
}

function renderSetup() {
  let step = 0, kind = 'pin', p1 = '', err = '';
  const draw = () => {
    if (step === 0) {
      $app.replaceChildren(h('main', { class: 'center-screen' },
        h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '📒'),
        h('h1', null, 'ようこそ'),
        h('p', { class: 'lead' }, '金額とカテゴリを押すだけの、続けやすい家計簿です。'),
        h('ul', { class: 'promise' },
          h('li', null, h('b', null, '📱 この端末の中だけに保存'), 'どこにも送信しません。'),
          h('li', null, h('b', null, '🔒 パスコードで守ります'), 'iPhoneの「パスワード」に保存すれば、Face IDで開けます。')),
        btn('はじめる', () => { step = 1; draw(); }, 'btn btn-primary btn-big')));
      return;
    }
    if (step === 3) {
      let budget = 0;
      $app.replaceChildren(h('main', { class: 'center-screen' },
        h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '🎯'),
        h('h1', null, '1か月に使えるのは？'),
        h('p', { class: 'help' }, 'だいたいでOK。ホームに「今月あといくら使えるか」が出ます。あとで変えられます。'),
        amountField('1か月の予算', 0, (v) => { budget = v; }, { placeholder: '例：150000' }),
        btn('これで始める', () => {
          if (budget) { S.budget.monthly = budget; addLog('update', 'budget', null, `月の予算を ${yen(budget)} に設定`); save(); }
          finishSetup();
        }, 'btn btn-primary btn-big'),
        btn('あとで決める', finishSetup, 'link-btn center')));
      return;
    }
    const isConfirm = step === 2;
    const input = h('input', {
      id: 'pass', type: 'password', name: 'password', required: true, minlength: '6', maxlength: '64',
      autocomplete: 'new-password', inputmode: kind === 'pin' ? 'numeric' : 'text',
      'aria-describedby': 'pass-help', enterkeyhint: 'next',
    });
    const form = h('form', { class: 'center-screen', onSubmit: async (e) => {
      e.preventDefault();
      const v = input.value;
      if (!isConfirm) {
        err = passProblem(v, kind);
        if (err) { draw(); return; }
        p1 = v; step = 2; draw(); return;
      }
      if (v !== p1) { err = '1回目と違いました。もう一度最初から入力してください'; p1 = ''; step = 1; draw(); return; }
      form.querySelector('button[type=submit]').disabled = true;
      form.querySelector('.status').textContent = '準備中…';
      const salt = randomBytes(16);
      const key = await deriveKey(v, salt, PBKDF2_ITER);
      const state = defaultState();
      state.log.push({ id: uid(), at: Date.now(), act: 'security', kind: 'security', summary: 'アプリを使いはじめました' });
      const { iv, ct } = await encryptJSON(key, state);
      META = { salt, iter: PBKDF2_ITER, kind, createdAt: Date.now() };
      await db.atomic({ meta: META, vault: { iv, ct, savedAt: Date.now(), rev: 1 } });
      KEY = key; S = state; REV = 1;
      channel?.postMessage('unlocked');
      startIdleWatch();
      step = 3; draw();
    } },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
    h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '🔒'),
    h('h1', null, isConfirm ? 'もう一度入力' : 'パスコードを決める'),
    h('label', { for: 'pass', class: 'field big-field' },
      h('span', null, isConfirm ? '確認のため、同じパスコードを入力' : 'パスコード（6文字以上）'), input),
    h('p', { id: 'pass-help', class: 'help' }, kind === 'pin' ? '数字6桁以上。長いほど安全です。' : '英数字・記号を使えます。'),
    !isConfirm ? btn(kind === 'pin' ? '英数字で設定する（より安全）' : '数字だけで設定する', () => { kind = kind === 'pin' ? 'text' : 'pin'; err = ''; draw(); }, 'link-btn center') : null,
    err ? h('p', { class: 'error', role: 'alert' }, err) : null,
    h('p', { class: 'help small' }, 'パスコードは忘れると元に戻せません。iPhoneが「パスワードを保存しますか？」と聞いてきたら「保存」がおすすめです。'),
    h('p', { class: 'status', 'aria-live': 'polite' }),
    h('button', { type: 'submit', class: 'btn btn-primary btn-big' }, isConfirm ? '設定する' : '次へ'),
    isConfirm ? btn('戻る', () => { step = 1; p1 = ''; err = ''; draw(); }, 'link-btn center') : null);
    $app.replaceChildren(form);
    setTimeout(() => input.focus(), 50);
  };
  const finishSetup = () => { render(); toast('準備できました。下の「＋」から記録してみましょう'); };
  draw();
}

// ================= ロック画面 =================
function renderLock(reason) {
  let err = '';
  let countdown = null;
  const draw = async () => {
    const guard = await getGuard();
    const waitMs = Math.max(0, guard.lockUntil - Date.now());
    const input = h('input', {
      id: 'pass', type: 'password', name: 'password', autocomplete: 'current-password',
      inputmode: META.kind === 'pin' ? 'numeric' : 'text', maxlength: '64', enterkeyhint: 'go',
      disabled: waitMs > 0, 'aria-invalid': err ? 'true' : null,
    });
    const status = h('p', { class: 'status', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-big', disabled: waitMs > 0 }, 'ロック解除');
    const form = h('form', { class: 'center-screen', onSubmit: async (e) => {
      e.preventDefault();
      if (!input.value) return;
      submit.disabled = true; input.disabled = true;
      status.textContent = '確認中…';
      const r = await tryUnlock(input.value);
      input.value = '';
      if (!r.ok) {
        err = r.wait > 0 ? '' : 'パスコードが違います';
        draw();
      }
    } },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
    h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '🔒'),
    h('h1', null, '家計簿'),
    reason ? h('p', { class: 'help' }, reason) : null,
    h('label', { for: 'pass', class: 'field big-field' }, h('span', null, 'パスコード'), input),
    err ? h('p', { class: 'error', role: 'alert' }, err) : null,
    waitMs > 0 ? h('p', { class: 'error', id: 'wait' }, `間違いが続いたため、あと ${Math.ceil(waitMs / 1000)} 秒で再入力できます`) : null,
    status,
    submit,
    btn('パスコードを忘れたとき', forgotFlow, 'link-btn'));
    $app.replaceChildren(form);
    clearInterval(countdown);
    if (waitMs > 0) countdown = setInterval(() => { if (Date.now() >= guard.lockUntil) { clearInterval(countdown); err = ''; draw(); } else { const w = document.getElementById('wait'); if (w) w.textContent = `間違いが続いたため、あと ${Math.ceil((guard.lockUntil - Date.now()) / 1000)} 秒で再入力できます`; } }, 1000);
    else setTimeout(() => input.focus(), 50);
  };
  draw();
}

async function forgotFlow() {
  const ok = await confirmSheet({
    title: 'パスコードを忘れたとき',
    body: ['データは暗号化されているため、パスコードがないと誰にも（作者にも）開けません。',
      'iPhoneの「設定 → パスワード」に「家計簿」として保存されていないか確認してください。',
      'バックアップファイルがあれば、全部消してから「設定 → バックアップ」で復元できます（バックアップ用パスワードが必要です）。',
      'すべてのデータを消して、最初からやり直しますか？'],
    ok: 'すべて消してやり直す', danger: true, typed: '削除',
  });
  if (ok) await wipeAll();
}

async function wipeAll() {
  await db.clearAll();
  KEY = null; S = null; META = null;
  location.reload();
}

// ================= 全体レイアウト =================
function render() {
  if (!S) return;
  const prevKey = $app.dataset.viewKey;
  const key = ui.view + '/' + (ui.sub || '');
  const y = window.scrollY;
  const main = h('main', { id: 'main', class: 'main' }, viewContent());
  const tabs = [
    ['home', '🏠', 'ホーム'],
    ['list', '📋', '一覧'],
    ['add', '＋', '記録'],
    ['report', '📊', 'レポート'],
    ['settings', '⚙️', '設定'],
  ];
  const nav = h('nav', { class: 'tabbar', 'aria-label': 'メニュー' }, tabs.map(([id, icon, label]) => {
    if (id === 'add') return h('button', { type: 'button', class: 'tab tab-add', onClick: () => openAdd(), 'aria-label': '記録する' },
      h('span', { class: 'tab-add-circle', 'aria-hidden': 'true' }, icon), h('span', { class: 'tab-label' }, label));
    return h('button', { type: 'button', class: 'tab' + (ui.view === id ? ' active' : ''), 'aria-current': ui.view === id ? 'page' : null,
      onClick: () => { ui.view = id; ui.sub = null; if (id !== 'report' && id !== 'list') ui.ym = ymOf(dateStr()); render(); window.scrollTo(0, 0); } },
    h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'tab-label' }, label));
  }));
  $app.replaceChildren(main, nav);
  $app.dataset.viewKey = key;
  if (prevKey === key) window.scrollTo(0, y);
}

function viewContent() {
  switch (ui.view) {
    case 'list': return viewList();
    case 'report': return viewReport();
    case 'settings': return ui.sub ? viewSettingsSub() : viewSettings();
    default: return viewHome();
  }
}

function pageHead(title, right) {
  return h('header', { class: 'page-head' }, h('h1', null, title), right || null);
}
function monthNav() {
  const cur = ymOf(dateStr());
  const latest = liveTx(S).reduce((m, t) => (t.date > m ? t.date : m), '');
  const maxYm = latest && ymOf(latest) > cur ? ymOf(latest) : cur;
  return h('div', { class: 'month-nav' },
    btn('‹', () => { ui.ym = ymAdd(ui.ym, -1); render(); }, 'icon-btn', { 'aria-label': '前の月' }),
    h('strong', { 'aria-live': 'polite' }, ymLabel(ui.ym)),
    btn('›', () => { ui.ym = ymAdd(ui.ym, 1); render(); }, 'icon-btn', { 'aria-label': '次の月', disabled: ui.ym >= maxYm }),
    ui.ym !== cur ? btn('今月', () => { ui.ym = cur; render(); }, 'chip') : null);
}

// ================= ホーム =================
function trio(tot) {
  return h('section', { class: 'trio' },
    h('div', null, h('span', null, '収入'), h('b', { class: 'income' }, yen(tot.income))),
    h('div', null, h('span', null, '支出'), h('b', null, yen(tot.expense))),
    h('div', null, h('span', null, '収支'), h('b', { class: tot.balance >= 0 ? 'income' : 'minus' }, signedYen(tot.balance))));
}
const go = (view, sub = null, extra = {}) => { Object.assign(ui, { view, sub }, extra); render(); window.scrollTo(0, 0); };

function viewHome() {
  const ym = ymOf(dateStr());
  const tot = monthTotals(S, ym);
  const budget = S.budget.monthly;
  const today = dateStr();
  const todayTx = liveTx(S).filter((t) => t.date === today);
  const recordedToday = liveTx(S).some((t) => dateStr(new Date(t.createdAt)) === today);
  const st = streak(S);
  const uncat = liveTx(S).filter((t) => t.cat === UNCAT.expense || t.cat === UNCAT.income).length;
  const daysLeft = daysInMonth(ym) - Number(today.slice(8)) + 1;

  let hero;
  if (budget > 0) {
    const left = budget - tot.expense;
    const pct = Math.min(100, Math.round((tot.expense / budget) * 100));
    const over = left < 0;
    hero = h('section', { class: 'card hero' + (over ? ' over' : '') },
      h('p', { class: 'hero-label' }, over ? '⚠️ 今月の予算を超えています' : '今月あと使えるお金'),
      h('p', { class: 'hero-num' }, over ? yen(-left) : yen(left), over ? h('span', { class: 'hero-unit' }, ' オーバー') : null),
      h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': '予算の使用率' },
        h('div', { class: 'meter-fill', width: pct + '%' })),
      h('p', { class: 'hero-sub' }, over ? `予算 ${yen(budget)} ／ 使った ${yen(tot.expense)}`
        : `1日あたり あと ${yen(Math.floor(left / daysLeft))}（残り${daysLeft}日）`));
  } else {
    hero = h('section', { class: 'card hero' },
      h('p', { class: 'hero-label' }, '今月使ったお金'),
      h('p', { class: 'hero-num' }, yen(tot.expense)),
      btn('予算を決めると「あといくら」が出ます →', () => go('settings', 'budget'), 'link-btn'));
  }

  // お知らせは一度に1つだけ（優先度順）
  const sinceBackup = Date.now() - (S.settings.lastBackupAt || 0);
  const liveN = liveTx(S).length;
  const needBackup = liveN >= 10 && (S.settings.lastBackupAt ? sinceBackup > 14 * 864e5 : true);
  let notice = null;
  if (recentlyDeleted && Date.now() - recentlyDeleted.at < 120e3 && S.tx.some((t) => t.id === recentlyDeleted.id && t.deleted)) {
    const t = S.tx.find((x) => x.id === recentlyDeleted.id);
    notice = h('button', { type: 'button', class: 'card notice action-card', onClick: () => restoreTx(t.id) }, `↩️ さっき消した「${txLabel(t)}」を戻す`);
  } else if (uncat > 0) {
    notice = h('button', { type: 'button', class: 'card notice action-card', onClick: () => go('list', null, { onlyUncat: true, q: '', type: 'all', cat: null }) },
      `❓ 未分類が ${uncat}件 → ひまなときに整理`);
  } else if (needBackup) {
    notice = h('button', { type: 'button', class: 'card notice action-card', onClick: () => go('settings', 'backup') },
      '💾 データを守るためにバックアップしませんか →');
  } else if (isIOS() && !isStandalone() && !S.settings.installHintHidden) {
    notice = h('div', { class: 'card notice slim' },
      h('p', null, '📲 共有ボタン →「ホーム画面に追加」でアプリのように使えます'),
      btn('×', () => { S.settings.installHintHidden = true; save(); render(); }, 'icon-btn small', { 'aria-label': '閉じる' }));
  }

  return [
    pageHead(`${Number(ym.slice(5))}月の家計簿`),
    hero,
    trio(tot),
    h('section', { class: 'card status-card' + (recordedToday ? ' done' : '') },
      recordedToday
        ? h('p', null, `✅ 今日も記録できました${st > 1 ? `（${st}日連続）` : ''}`)
        : h('p', null, '📝 今日はまだ記録していません。1件だけでもOK！')),
    notice,
    h('section', null,
      h('h2', { class: 'section-title' }, 'よく使う（タップですぐ記録）'),
      S.favs.length
        ? h('div', { class: 'fav-row' }, S.favs.map((f) => h('button', { type: 'button', class: 'fav', onClick: () => {
          createTx({ type: f.type, amount: f.amount, cat: f.cat, date: dateStr(), memo: f.memo, pay: payOf(f.pay) ? f.pay : '' });
        } }, h('span', { class: 'fav-emoji', 'aria-hidden': 'true' }, catOf(f.cat).emoji),
        h('span', null, f.memo || catOf(f.cat).name), h('b', null, yen(f.amount)))))
        : btn('＋ コンビニ・ランチなどをワンタップ記録にする', () => go('settings', 'favs'), 'link-btn')),
    h('section', null,
      h('h2', { class: 'section-title' }, '今日の記録'),
      todayTx.length ? txListEl(todayTx) : h('p', { class: 'empty' }, 'まだありません')),
    h('section', null,
      h('h2', { class: 'section-title' }, '最近の記録'),
      (() => {
        const recent = liveTx(S).filter((t) => t.date !== today).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt).slice(0, 5);
        return recent.length ? txListEl(recent, true) : h('p', { class: 'empty' }, '記録すると、ここに表示されます');
      })()),
  ];
}

function txListEl(list, showDate) {
  return h('ul', { class: 'tx-list' }, list.map((t) => {
    const c = catOf(t.cat);
    const p = payOf(t.pay);
    return h('li', null, h('button', { type: 'button', class: 'tx', onClick: () => openEdit(t.id), 'aria-label': `${c.name} ${yen(t.amount)} ${t.type === 'income' ? '収入' : '支出'} 編集する` },
      h('span', { class: 'tx-emoji', 'aria-hidden': 'true' }, c.emoji),
      h('span', { class: 'tx-main' },
        h('span', { class: 'tx-cat' }, c.name, t.rec ? h('span', { class: 'badge' }, '固定費') : null, t.waste ? h('span', { class: 'badge' }, '😇ムダ') : null),
        h('span', { class: 'tx-sub' }, [showDate ? dayLabel(t.date) : null, p?.name, t.memo].filter(Boolean).join(' ・ '))),
      h('span', { class: 'tx-amt' + (t.type === 'income' ? ' income' : '') }, (t.type === 'income' ? '+' : '') + yen(t.amount))));
  }));
}

// ================= 一覧 =================
// 検索・未分類・カテゴリで絞り込んでいるときは全期間が対象
function viewList() {
  const results = h('div', { id: 'list-results' });
  const allTime = () => !!(ui.q.trim() || ui.onlyUncat);
  const fill = () => {
    let list = allTime() ? liveTx(S) : txOfMonth(S, ui.ym);
    if (ui.type !== 'all') list = list.filter((t) => t.type === ui.type);
    if (ui.onlyUncat) list = list.filter((t) => t.cat === UNCAT.expense || t.cat === UNCAT.income);
    if (ui.cat) list = list.filter((t) => t.cat === ui.cat);
    const q = ui.q.trim().toLowerCase();
    if (q) list = list.filter((t) => [catOf(t.cat).name, t.memo, payOf(t.pay)?.name, String(t.amount)].join(' ').toLowerCase().includes(q));
    list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    const scope = h('p', { class: 'help pad' }, allTime() ? `全期間から ${list.length}件` : `${ymLabel(ui.ym)}：${list.length}件`);
    if (!list.length) { results.replaceChildren(scope, h('p', { class: 'empty' }, q || ui.onlyUncat || ui.cat || ui.type !== 'all' ? '条件に合う記録はありません' : 'この月の記録はまだありません')); return; }
    const groups = new Map();
    for (const t of list.slice(0, 500)) { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); }
    results.replaceChildren(scope, ...[...groups.entries()].map(([d, items]) => {
      const exp = items.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
      return h('section', { class: 'day-group' },
        h('h2', { class: 'day-head' }, h('span', null, (allTime() && ymOf(d) !== ymOf(dateStr()) ? d.slice(0, 4) + '年 ' : '') + dayLabel(d)), exp ? h('span', null, '支出 ' + yen(exp)) : null),
        txListEl(items));
    }));
    if (list.length > 500) results.append(h('p', { class: 'help center' }, '新しい500件を表示しています。検索で絞り込んでください'));
  };
  fill();
  const chip = (label, active, onClick) => h('button', { type: 'button', class: 'chip' + (active ? ' active' : ''), 'aria-pressed': active ? 'true' : 'false', onClick }, label);
  const trashN = S.tx.filter((t) => t.deleted).length;
  return [
    pageHead('記録の一覧'),
    allTime() ? null : monthNav(),
    allTime() ? null : trio(monthTotals(S, ui.ym)),
    h('label', { class: 'search' }, h('span', { class: 'visually-hidden' }, '検索'),
      h('input', { type: 'search', placeholder: '🔍 メモ・金額で検索（全期間）', value: ui.q, enterkeyhint: 'search', onInput: (e) => {
        const was = allTime(); ui.q = e.target.value;
        if (was !== allTime()) { render(); document.querySelector('.search input')?.focus(); } else fill();
      } })),
    h('div', { class: 'chip-row' },
      chip('すべて', ui.type === 'all' && !ui.onlyUncat && !ui.cat, () => { ui.type = 'all'; ui.onlyUncat = false; ui.cat = null; render(); }),
      chip('支出', ui.type === 'expense', () => { ui.type = 'expense'; render(); }),
      chip('収入', ui.type === 'income', () => { ui.type = 'income'; render(); }),
      chip('❓未分類', ui.onlyUncat, () => { ui.onlyUncat = !ui.onlyUncat; render(); }),
      ui.cat ? chip(`${catOf(ui.cat).emoji} ${catOf(ui.cat).name} ×`, true, () => { ui.cat = null; render(); }) : null),
    results,
    trashN ? btn(`🗑 ゴミ箱（${trashN}件）`, () => go('settings', 'trash'), 'link-btn center') : null,
  ];
}

// ================= 記録（追加・編集） =================
let addState = null;
const STICKY_MS = 10 * 60e3;
function openAdd(preset = {}) {
  closeSheet(true);
  const sticky = stickyDate && Date.now() - stickyDate.at < STICKY_MS ? stickyDate.date : null;
  const pay = payOf(S.settings.lastPay) ? S.settings.lastPay : '';
  addState = { mode: 'new', step: 1, type: 'expense', amount: '', date: sticky || dateStr(), memo: '', pay, cat: null, waste: false, ...preset };
  openSheet(renderAdd);
}
function openEdit(id) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  closeSheet(true);
  addState = { mode: 'edit', id, step: 2, type: t.type, amount: String(t.amount), date: t.date, memo: t.memo || '', pay: payOf(t.pay) ? t.pay : '', cat: t.cat, waste: !!t.waste };
  addState.orig = JSON.stringify(editSnapshot(addState));
  openSheet(renderAdd);
}
const editSnapshot = (a) => ({ type: a.type, amount: a.amount, date: a.date, memo: a.memo.trim(), pay: a.pay, cat: a.cat, waste: a.waste });

// 編集中に閉じようとしたら、変更があれば確認する
async function closeAdd() {
  const a = addState;
  if (a && a.mode === 'edit' && JSON.stringify(editSnapshot(a)) !== a.orig && validAmount(Number(a.amount)) && a.cat) {
    const snap = { ...a };
    const keep = await confirmSheet({ title: '変更を保存しますか？', body: ['このまま閉じると、変更は保存されません。'], ok: '保存する' });
    if (keep) updateTx(snap.id, txData(snap));
    return;
  }
  closeSheet();
}
const txData = (a) => ({ type: a.type, amount: Number(a.amount), cat: a.cat, date: a.date, memo: a.memo.trim().slice(0, 100), pay: a.pay, waste: a.type === 'expense' && !!a.waste });

function keypad(onKey) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'];
  return h('div', { class: 'keypad' }, keys.map((k) => btn(k, () => onKey(k), 'key' + (k === '⌫' ? ' key-del' : ''), { 'aria-label': k === '⌫' ? '1文字消す' : k })));
}
function pressKey(k) {
  let a = addState.amount;
  if (k === '⌫') a = a.slice(0, -1);
  else if (k === 'C') a = '';
  else { a = (a + k).replace(/^0+/, ''); if (Number(a) > MAX_AMOUNT) return; }
  addState.amount = a;
  const disp = sheetEl?.querySelector('.amount-display');
  if (disp) { disp.textContent = yen(Number(a || 0)); disp.classList.toggle('zero', !a); }
  const next = sheetEl?.querySelector('#next-btn');
  if (next) next.disabled = !a;
}

function renderAdd() {
  const a = addState;
  const typeToggle = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '種類' },
    ['expense', 'income'].map((tp) => h('button', { type: 'button', role: 'radio', 'aria-checked': a.type === tp ? 'true' : 'false',
      class: 'seg-btn' + (a.type === tp ? ' active' : '') + (tp === 'income' ? ' inc' : ''),
      onClick: () => { if (a.type !== tp) { a.type = tp; a.cat = null; refreshSheet(); } } }, tp === 'expense' ? '支出' : '収入')));

  if (a.step === 1) {
    if (a.mode === 'edit' && a.amountBefore == null) a.amountBefore = a.amount;
    const backToStep2 = () => { if (!a.amount) a.amount = a.amountBefore; a.amountBefore = null; a.step = 2; refreshSheet(); };
    return [
      sheetHead(a.mode === 'edit' ? '金額を直す' : '記録する', a.mode === 'edit' ? { backLabel: '‹ 戻る', onBack: backToStep2 } : {}),
      h('div', { class: 'sheet-body add-step1' },
        typeToggle,
        h('p', { class: 'amount-display' + (a.amount ? '' : ' zero'), 'aria-live': 'polite' }, yen(Number(a.amount || 0))),
        keypad(pressKey),
        h('button', { type: 'button', id: 'next-btn', class: 'btn btn-primary btn-big', disabled: !a.amount, onClick: () => { a.amountBefore = null; a.step = 2; refreshSheet(true); } },
          a.mode === 'edit' ? 'この金額にする' : '次へ（カテゴリを選ぶ）')),
    ];
  }

  const amount = Number(a.amount);
  const today = dateStr();
  const dateChips = [[today, '今日'], [addDays(today, -1), '昨日'], [addDays(today, -2), 'おととい'], [addDays(today, -3), '3日前']];
  const isOther = !dateChips.some(([d]) => d === a.date);
  const setDate = (d) => {
    if (d > today) { toast('未来の日付は選べません'); return; }
    a.date = d;
    stickyDate = d !== today ? { date: d, at: Date.now() } : null;
    refreshSheet();
  };
  const chooseCat = (catId) => {
    if (!validAmount(amount)) { a.step = 1; refreshSheet(); return; }
    if (!catId) return;
    a.cat = catId;
    const data = txData(a);
    if (stickyDate) stickyDate.at = Date.now();
    closeSheet();
    if (a.mode === 'new') createTx(data); else updateTx(a.id, data);
  };
  const tx = a.mode === 'edit' ? S.tx.find((x) => x.id === a.id) : null;
  const hist = tx ? S.log.filter((l) => l.kind === 'tx' && l.ref === tx.id).slice().reverse() : [];
  const freq = a.mode === 'new' ? frequentCats(S, a.type) : [];
  const later = activeCats(a.type).find((c) => c.system);
  const catBtn = (c) => h('button', { type: 'button', class: 'cat' + (a.cat === c.id ? ' selected' : ''), 'aria-pressed': a.cat === c.id ? 'true' : 'false', onClick: () => chooseCat(c.id) },
    h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, c.emoji),
    h('span', { class: 'cat-name' }, c.name));

  return [
    sheetHead(a.mode === 'edit' ? '記録を編集' : '記録する', { onBack: closeAdd,
      right: a.mode === 'edit' ? btn('🗑 削除', () => { closeSheet(); deleteTx(a.id); }, 'link-btn danger-link') : null }),
    h('div', { class: 'sheet-body' },
      a.mode === 'edit' ? typeToggle : null,
      h('button', { type: 'button', class: 'amount-small', onClick: () => { a.step = 1; refreshSheet(true); } },
        h('span', null, a.type === 'income' ? '収入' : '支出'), h('b', null, yen(amount)), h('span', { class: 'link' }, '金額を直す')),
      h('div', { class: 'opt' },
        h('span', { class: 'opt-label', id: 'date-l' }, '日付', stickyDate && a.mode === 'new' && a.date !== today ? h('span', { class: 'muted' }, '（まとめ入力中：同じ日付を使います）') : null),
        h('div', { class: 'chip-row', role: 'group', 'aria-labelledby': 'date-l' },
          dateChips.map(([d, l]) => h('button', { type: 'button', class: 'chip' + (a.date === d ? ' active' : ''), 'aria-pressed': a.date === d ? 'true' : 'false', onClick: () => setDate(d) }, l)),
          h('label', { class: 'chip date-chip' + (isOther ? ' active' : '') },
            h('span', null, isOther ? dayLabel(a.date) : '📅 他の日'),
            h('input', { type: 'date', value: a.date, max: today, 'aria-label': '日付を選ぶ', onChange: (e) => { if (e.target.value) setDate(e.target.value); } })))),
      h('details', { class: 'more-opts', open: a.mode === 'edit' || a.memo || null },
        h('summary', null, 'メモ・支払い方法（なくてOK）'),
        h('div', { class: 'opt opt-inline' },
          h('label', { class: 'field' }, h('span', null, 'メモ'),
            h('input', { type: 'text', maxlength: '100', value: a.memo, placeholder: '例：スーパー', enterkeyhint: 'done', onInput: (e) => { a.memo = e.target.value; } })),
          h('label', { class: 'field' }, h('span', null, '支払い方法'),
            h('select', { onChange: (e) => { a.pay = e.target.value; } },
              h('option', { value: '' }, '（指定なし）'),
              S.pays.map((p) => h('option', { value: p.id, selected: a.pay === p.id }, p.name)))),
          a.type === 'expense' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: a.waste, onChange: (e) => { a.waste = e.target.checked; } }), '😇 ムダ遣いだったかも') : null)),
      a.mode === 'edit' ? h('div', { class: 'edit-actions' },
        btn('このまま保存', () => chooseCat(a.cat), 'btn btn-primary', { disabled: !a.cat }),
        !a.cat ? h('p', { class: 'help' }, '種類を変えたので、下からカテゴリを選んでください') : null) : null,
      h('p', { class: 'step-hint' }, a.mode === 'edit' ? 'カテゴリをタップでも保存できます' : 'カテゴリをタップすると記録完了'),
      later ? h('button', { type: 'button', class: 'later-btn' + (a.cat === later.id ? ' selected' : ''), onClick: () => chooseCat(later.id) },
        h('span', { 'aria-hidden': 'true' }, '⏳'), ' 迷ったら「あとで決める」') : null,
      freq.length ? h('p', { class: 'opt-label' }, 'よく使う') : null,
      freq.length ? h('div', { class: 'cat-grid' }, freq.map((id) => catBtn(catOf(id)))) : null,
      freq.length ? h('p', { class: 'opt-label' }, 'すべて') : null,
      h('div', { class: 'cat-grid' }, activeCats(a.type).filter((c) => !c.system).map(catBtn)),
      a.mode === 'edit' ? h('div', { class: 'edit-actions' },
        btn('⭐ よく使うに追加', () => {
          if (!a.cat || !validAmount(amount)) { toast('金額とカテゴリを確認してください'); return; }
          S.favs.push({ id: uid(), type: a.type, amount, cat: a.cat, memo: a.memo.trim(), pay: a.pay });
          addLog('create', 'fav', null, `よく使うに追加：${catOf(a.cat).name} ${yen(amount)}`);
          save(); render(); toast('ホームの「よく使う」に追加しました');
        }, 'btn')) : null,
      hist.length ? h('details', { class: 'hist' },
        h('summary', null, `この記録の変更履歴（${hist.length}件）`),
        h('ul', null, hist.map((l) => h('li', null,
          h('span', { class: 'hist-time' }, fmtTime(l.at)), ' ', actLabel(l.act), ' ', l.summary)))) : null),
  ];
}

// ================= レポート =================
function viewReport() {
  const ym = ui.ym;
  const tot = monthTotals(S, ym);
  const cats = byCategory(S, ym, 'expense');
  const incs = byCategory(S, ym, 'income');
  const budgetCats = S.cats.filter((c) => c.type === 'expense' && !c.archived && c.budget > 0 && !cats.some((x) => x.cat === c.id));
  const maxCat = Math.max(1, ...cats.map((c) => c.amount), ...cats.map((c) => catOf(c.cat).budget || 0), ...budgetCats.map((c) => c.budget));
  const waste = txOfMonth(S, ym).filter((t) => t.waste && t.type === 'expense').reduce((n, t) => n + t.amount, 0);

  const months = [];
  for (let i = 5; i >= 0; i--) { const m = ymAdd(ym, -i); months.push({ ym: m, ...monthTotals(S, m) }); }
  const maxM = Math.max(1, ...months.map((m) => m.expense));

  const barRow = (catId, amount) => {
    const c = catOf(catId);
    const bud = c.budget || 0;
    const over = bud > 0 && amount > bud;
    return h('li', null, h('button', { type: 'button', class: 'bar-row', onClick: () => go('list', null, { ym, cat: catId, type: 'all', q: '', onlyUncat: false }), 'aria-label': `${c.name} ${yen(amount)} の明細を見る` },
      h('div', { class: 'bar-label' }, h('span', null, `${c.emoji} ${c.name}`),
        h('span', null, h('b', null, yen(amount)), bud ? h('span', { class: 'bar-bud' + (over ? ' over' : '') }, over ? ` ⚠️ 予算${yen(bud)}を${yen(amount - bud)}超過` : ` ／ 予算${yen(bud)}`) : null,
          tot.expense ? h('span', { class: 'pct' }, ` ${Math.round((amount / tot.expense) * 100)}%`) : null)),
      h('div', { class: 'bar-track' },
        h('div', { class: 'bar-fill' + (over ? ' over' : ''), width: (amount / maxCat) * 100 + '%' }),
        bud ? h('div', { class: 'bar-budget', 'aria-hidden': 'true' }) : null)));
  };

  const list = h('ul', { class: 'bars' }, [...cats.map((x) => barRow(x.cat, x.amount)), ...budgetCats.map((c) => barRow(c.id, 0))]);
  // 予算ラインの位置（CSSOMで設定：CSPでstyle属性は使わない）
  list.querySelectorAll('.bar-row').forEach((row, i) => {
    const all = [...cats.map((x) => x.cat), ...budgetCats.map((c) => c.id)];
    const bud = catOf(all[i]).budget;
    const line = row.querySelector('.bar-budget');
    if (line && bud) line.style.left = `calc(${Math.min(100, (bud / maxCat) * 100)}% - 1px)`;
  });

  return [
    pageHead('レポート'),
    monthNav(),
    h('section', { class: 'trio' },
      h('div', null, h('span', null, '収入'), h('b', { class: 'income' }, yen(tot.income))),
      h('div', null, h('span', null, '支出'), h('b', null, yen(tot.expense))),
      h('div', null, h('span', null, '収支'), h('b', { class: tot.balance >= 0 ? 'income' : 'minus' }, signedYen(tot.balance)))),
    S.budget.monthly ? h('section', { class: 'card' },
      h('p', null, `月の予算 ${yen(S.budget.monthly)} に対して `, h('b', null, `${Math.round((tot.expense / S.budget.monthly) * 100)}%`), ' 使用',
        tot.expense > S.budget.monthly ? h('b', { class: 'minus' }, `（⚠️ ${yen(tot.expense - S.budget.monthly)} 超過）`) : null)) : null,
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '何に使った？（支出）'),
      cats.length ? h('p', { class: 'help' }, 'タップすると明細が見られます') : null,
      cats.length || budgetCats.length ? list : h('p', { class: 'empty' }, 'この月の支出はありません')),
    waste ? h('section', { class: 'card' },
      h('p', null, '😇 ムダ遣いだったかも：', h('b', null, yen(waste)), tot.expense ? `（支出の${Math.round((waste / tot.expense) * 100)}%）` : '')) : null,
    incs.length ? h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '収入の内訳'),
      h('ul', { class: 'plain-list' }, incs.map((x) => h('li', null, h('span', null, `${catOf(x.cat).emoji} ${catOf(x.cat).name}`), h('b', null, yen(x.amount)))))) : null,
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '支出の推移（6か月）'),
      h('p', { class: 'help' }, '棒をタップするとその月に切り替わります'),
      h('div', { class: 'vbars', role: 'list' }, months.map((m) => h('button', {
        type: 'button', role: 'listitem', class: 'vbar' + (m.ym === ym ? ' active' : ''), title: `${ymLabel(m.ym)} 支出 ${yen(m.expense)}`,
        'aria-label': `${ymLabel(m.ym)} 支出 ${yen(m.expense)}`, onClick: () => { ui.ym = m.ym; render(); },
      }, h('span', { class: 'vbar-val' }, m.ym === ym ? shortYen(m.expense) : ''),
      h('span', { class: 'vbar-track' }, h('span', { class: 'vbar-fill', height: (m.expense / maxM) * 100 + '%' })),
      h('span', { class: 'vbar-label' }, `${Number(m.ym.slice(5))}月`)))),
      h('details', { class: 'table-view' }, h('summary', null, '表で見る'),
        h('table', null,
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, '月'), h('th', { scope: 'col' }, '収入'), h('th', { scope: 'col' }, '支出'), h('th', { scope: 'col' }, '収支'))),
          h('tbody', null, months.map((m) => h('tr', null, h('th', { scope: 'row' }, ymLabel(m.ym)), h('td', null, yen(m.income)), h('td', null, yen(m.expense)), h('td', null, signedYen(m.balance)))))))),
  ];
}
function shortYen(n) { return n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : yen(n); }

// ================= 設定 =================
function viewSettings() {
  const row = (icon, label, sub, note) => h('li', null, h('button', { type: 'button', class: 'set-row', onClick: () => { ui.sub = sub; render(); window.scrollTo(0, 0); } },
    h('span', { class: 'set-icon', 'aria-hidden': 'true' }, icon), h('span', { class: 'set-label' }, label), note ? h('span', { class: 'set-note' }, note) : null, h('span', { class: 'chev', 'aria-hidden': 'true' }, '›')));
  const trashN = S.tx.filter((t) => t.deleted).length;
  return [
    pageHead('設定'),
    h('h2', { class: 'section-title' }, 'お金のルール'),
    h('ul', { class: 'set-list' },
      row('🎯', '予算', 'budget', S.budget.monthly ? yen(S.budget.monthly) : '未設定'),
      row('⭐', 'よく使う（ワンタップ記録）', 'favs', `${S.favs.length}件`),
      row('🔁', '固定費（毎月自動で記録）', 'recs', `${S.recs.filter((r) => r.active).length}件`),
      row('🏷', 'カテゴリ', 'cats'),
      row('💳', '支払い方法', 'pays')),
    h('h2', { class: 'section-title' }, '記録の管理'),
    h('ul', { class: 'set-list' },
      row('🕘', '操作の履歴', 'history'),
      row('🗑', 'ゴミ箱', 'trash', trashN ? `${trashN}件` : ''),
      row('💾', 'バックアップ・書き出し', 'backup', S.settings.lastBackupAt ? `前回 ${fmtDate(S.settings.lastBackupAt)}` : '未実施')),
    h('h2', { class: 'section-title' }, '安全・表示'),
    h('ul', { class: 'set-list' },
      row('🔒', 'パスコード・自動ロック', 'security', `${S.settings.autoLockMin}分`),
      row('🎨', '表示テーマ（ライト・ダーク）', 'theme'),
      row('🛡', 'このアプリの安全性について', 'about'),
      row('⚠️', 'すべてのデータを消す', 'wipe')),
    h('p', { class: 'help center' }, '家計簿 v1.1.0'),
  ];
}

function subHead(title) {
  return h('header', { class: 'page-head' },
    btn('‹ 設定', () => { ui.sub = null; render(); }, 'link-btn back'),
    h('h1', null, title));
}

function viewSettingsSub() {
  switch (ui.sub) {
    case 'budget': return viewBudget();
    case 'favs': return viewFavs();
    case 'recs': return viewRecs();
    case 'cats': return viewCats();
    case 'pays': return viewPays();
    case 'history': return viewHistory();
    case 'trash': return viewTrash();
    case 'backup': return viewBackup();
    case 'security': return viewSecurity();
    case 'theme': return viewTheme();
    case 'about': return viewAbout();
    case 'wipe': return viewWipe();
    default: ui.sub = null; return viewSettings();
  }
}

// ---- 金額入力欄 ----
function amountField(label, value, onChange, opts = {}) {
  return h('label', { class: 'field' }, h('span', null, label),
    h('div', { class: 'yen-input' }, h('span', { 'aria-hidden': 'true' }, '¥'),
      h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: value ? String(value) : '', placeholder: opts.placeholder || '0',
        onInput: (e) => { const v = e.target.value.replace(/[^\d]/g, '').slice(0, 9); e.target.value = v; onChange(v ? Number(v) : 0); } })));
}

// ---- 予算 ----
function viewBudget() {
  let monthly = S.budget.monthly;
  return [
    subHead('予算'),
    h('section', { class: 'card' },
      h('p', null, '1か月に使ってよい金額を決めると、ホームに「あといくら使えるか」が大きく出ます。'),
      amountField('毎月の予算（支出の合計）', monthly, (v) => { monthly = v; }, { placeholder: '例：150000' }),
      btn('保存する', () => {
        const before = S.budget.monthly;
        S.budget.monthly = monthly;
        addLog('update', 'budget', null, `月の予算を ${before ? yen(before) : '未設定'} → ${monthly ? yen(monthly) : '未設定'} に変更`);
        save(); render(); toast('予算を保存しました');
      }, 'btn btn-primary')),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, 'カテゴリごとの予算（なくてOK）'),
      h('p', { class: 'help' }, 'レポートで、超えたカテゴリに ⚠️ が出ます。'),
      h('ul', { class: 'plain-list' }, activeCats('expense').filter((c) => !c.system).map((c) => h('li', null,
        h('button', { type: 'button', class: 'row-btn', onClick: () => editCatSheet(c) },
          h('span', null, `${c.emoji} ${c.name}`), h('span', { class: 'muted' }, c.budget ? yen(c.budget) : '設定なし ›')))))),
  ];
}

// ---- よく使う ----
function viewFavs() {
  return [
    subHead('よく使う'),
    h('p', { class: 'help pad' }, 'ホーム画面に表示され、タップ1回で記録できます。（記録の編集画面からも追加できます）'),
    S.favs.length ? h('ul', { class: 'plain-list card' }, S.favs.map((f, i) => h('li', null,
      h('button', { type: 'button', class: 'row-btn', onClick: () => templateSheet('fav', f) },
        h('span', null, `${catOf(f.cat).emoji} ${f.memo || catOf(f.cat).name}`), h('b', null, yen(f.amount))),
      h('span', { class: 'order-btns' },
        btn('↑', () => { if (i > 0) { [S.favs[i - 1], S.favs[i]] = [S.favs[i], S.favs[i - 1]]; save(); render(); } }, 'icon-btn small', { 'aria-label': '上へ', disabled: i === 0 }),
        btn('↓', () => { if (i < S.favs.length - 1) { [S.favs[i + 1], S.favs[i]] = [S.favs[i], S.favs[i + 1]]; save(); render(); } }, 'icon-btn small', { 'aria-label': '下へ', disabled: i === S.favs.length - 1 }))))) : h('p', { class: 'empty' }, 'まだありません'),
    btn('＋ 追加する', () => templateSheet('fav'), 'btn btn-primary btn-wide'),
  ];
}

// ---- 固定費 ----
function viewRecs() {
  return [
    subHead('固定費'),
    h('p', { class: 'help pad' }, '家賃・サブスクなど毎月同じ支払いを登録すると、その日になったら自動で記録します。'),
    S.recs.length ? h('ul', { class: 'plain-list card' }, S.recs.map((r) => h('li', null,
      h('button', { type: 'button', class: 'row-btn', onClick: () => templateSheet('rec', r) },
        h('span', null, `${catOf(r.cat).emoji} ${r.memo || catOf(r.cat).name}`, h('span', { class: 'muted' }, ` 毎月${r.day}日${r.active ? '' : '（停止中）'}`)),
        h('b', null, yen(r.amount)))))) : h('p', { class: 'empty' }, 'まだありません'),
    btn('＋ 追加する', () => templateSheet('rec'), 'btn btn-primary btn-wide'),
  ];
}

// よく使う / 固定費 の編集シート
function templateSheet(kind, existing) {
  const isRec = kind === 'rec';
  const list = isRec ? S.recs : S.favs;
  const f = existing ? clone(existing) : { id: uid(), type: 'expense', amount: 0, cat: activeCats('expense').find((c) => !c.system)?.id, memo: '', pay: S.settings.lastPay || '', day: 1, active: true };
  let recordNow = true;
  const name = isRec ? '固定費' : 'よく使う';
  openSheet(() => [
    sheetHead(existing ? `${name}を編集` : `${name}を追加`),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'seg', role: 'radiogroup', 'aria-label': '種類' }, ['expense', 'income'].map((tp) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': f.type === tp ? 'true' : 'false', class: 'seg-btn' + (f.type === tp ? ' active' : '') + (tp === 'income' ? ' inc' : ''),
        onClick: () => { f.type = tp; f.cat = activeCats(tp).find((c) => !c.system)?.id; refreshSheet(); },
      }, tp === 'expense' ? '支出' : '収入'))),
      amountField('金額', f.amount, (v) => { f.amount = v; }),
      h('label', { class: 'field' }, h('span', null, 'カテゴリ'),
        h('select', { onChange: (e) => { f.cat = e.target.value; } }, activeCats(f.type).filter((c) => !c.system).map((c) => h('option', { value: c.id, selected: f.cat === c.id }, `${c.emoji} ${c.name}`)))),
      h('label', { class: 'field' }, h('span', null, isRec ? '名前・メモ（例：家賃）' : '表示名・メモ（例：コンビニ）'),
        h('input', { type: 'text', maxlength: '100', value: f.memo, onInput: (e) => { f.memo = e.target.value; } })),
      h('label', { class: 'field' }, h('span', null, '支払い方法'),
        h('select', { onChange: (e) => { f.pay = e.target.value; } }, h('option', { value: '' }, '（指定なし）'), S.pays.map((p) => h('option', { value: p.id, selected: f.pay === p.id }, p.name)))),
      isRec ? h('label', { class: 'field' }, h('span', null, '毎月何日？'),
        h('select', { onChange: (e) => { f.day = Number(e.target.value); } }, Array.from({ length: 31 }, (_, i) => h('option', { value: i + 1, selected: f.day === i + 1 }, `${i + 1}日${i >= 28 ? '（ない月は月末）' : ''}`)))) : null,
      isRec && existing ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.active, onChange: (e) => { f.active = e.target.checked; } }), '自動記録する（オフで一時停止）') : null,
      isRec && !existing ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: recordNow, onChange: (e) => { recordNow = e.target.checked; } }), '今月分も（日付が過ぎていれば）記録する') : null,
      h('div', { class: 'btn-row' },
        existing ? btn('削除', async () => {
          const i = list.findIndex((x) => x.id === f.id);
          const removed = list.splice(i, 1)[0];
          addLog('delete', kind, f.id, `${name}を削除：${removed.memo || catOf(removed.cat).name} ${yen(removed.amount)}`, removed, null);
          save(); closeSheet(); render();
          toast(`${name}を削除しました`, { label: '元に戻す', fn: () => { list.splice(i, 0, removed); addLog('undo', kind, f.id, `${name}の削除を取り消し`); save(); render(); } });
        }, 'btn btn-danger-outline') : null,
        btn('保存する', () => {
          if (!validAmount(f.amount)) { toast('金額を入れてください'); return; }
          if (!f.cat) { toast('カテゴリを選んでください'); return; }
          f.memo = f.memo.trim().slice(0, 100);
          if (existing) {
            const i = list.findIndex((x) => x.id === f.id);
            addLog('update', kind, f.id, `${name}を変更：${f.memo || catOf(f.cat).name} ${yen(f.amount)}`);
            // 停止→再開のときは、止めていた期間の分をまとめて記録しない（今月から再開）
            if (isRec && !list[i].active && f.active) {
              const prevYm = ymAdd(ymOf(dateStr()), -1);
              f.lastYm = list[i].lastYm && list[i].lastYm > prevYm ? list[i].lastYm : prevYm;
            }
            list[i] = { ...list[i], ...f };
            if (isRec) {
              const added = processRecurring(S);
              for (const t of added) addLog('auto', 'tx', t.id, `固定費を自動記録：${txLabel(t)}`, null, t);
            }
          } else {
            const item = isRec ? { ...f, startYm: ymOf(dateStr()), lastYm: recordNow ? null : ymOf(dateStr()) } : { id: f.id, type: f.type, amount: f.amount, cat: f.cat, memo: f.memo, pay: f.pay };
            if (isRec) { delete item.active; item.active = true; }
            list.push(item);
            addLog('create', kind, f.id, `${name}を追加：${f.memo || catOf(f.cat).name} ${yen(f.amount)}`, null, item);
            if (isRec) {
              const added = processRecurring(S);
              for (const t of added) addLog('auto', 'tx', t.id, `固定費を自動記録：${txLabel(t)}`, null, t);
            }
          }
          save(); closeSheet(); render(); toast('保存しました');
        }, 'btn btn-primary'))),
  ]);
}

// ---- カテゴリ ----
const EMOJIS = ['🍙', '🍜', '☕', '🍺', '🛒', '🧴', '🚃', '🚗', '⛽', '🏠', '💡', '📱', '🎮', '🎬', '📚', '👕', '💊', '🏥', '💇', '🎁', '👶', '🐶', '✈️', '🔁', '💰', '💼', '🎉', '📦', '🏋️', '🎵', '🧾', '💳'];
function viewCats() {
  const tp = ui.catTab;
  const list = S.cats.filter((c) => c.type === tp && !c.system);
  return [
    subHead('カテゴリ'),
    h('div', { class: 'seg pad', role: 'radiogroup', 'aria-label': '種類' }, ['expense', 'income'].map((t) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': tp === t ? 'true' : 'false', class: 'seg-btn' + (tp === t ? ' active' : ''), onClick: () => { ui.catTab = t; render(); },
    }, t === 'expense' ? '支出' : '収入'))),
    h('ul', { class: 'plain-list card' }, list.map((c) => {
      const idx = S.cats.indexOf(c);
      const sameIdx = list.indexOf(c);
      const move = (dir) => {
        const other = list[sameIdx + dir];
        if (!other) return;
        const j = S.cats.indexOf(other);
        [S.cats[idx], S.cats[j]] = [S.cats[j], S.cats[idx]];
        save(); render();
      };
      return h('li', { class: c.archived ? 'archived' : null },
        h('button', { type: 'button', class: 'row-btn', onClick: () => editCatSheet(c) },
          h('span', null, `${c.emoji} ${c.name}`), h('span', { class: 'muted' }, c.archived ? '非表示' : c.budget ? `予算 ${yen(c.budget)}` : '')),
        h('span', { class: 'order-btns' },
          btn('↑', () => move(-1), 'icon-btn small', { 'aria-label': `${c.name}を上へ`, disabled: sameIdx === 0 }),
          btn('↓', () => move(1), 'icon-btn small', { 'aria-label': `${c.name}を下へ`, disabled: sameIdx === list.length - 1 })));
    })),
    btn('＋ カテゴリを追加', () => editCatSheet(null, tp), 'btn btn-primary btn-wide'),
  ];
}
function editCatSheet(cat, type) {
  const c = cat ? clone(cat) : { id: uid(), type, emoji: '📦', name: '', budget: 0, archived: false };
  openSheet(() => [
    sheetHead(cat ? 'カテゴリを編集' : 'カテゴリを追加'),
    h('div', { class: 'sheet-body' },
      h('p', { class: 'emoji-preview', 'aria-hidden': 'true' }, c.emoji),
      h('div', { class: 'emoji-grid', role: 'group', 'aria-label': '絵文字を選ぶ' }, EMOJIS.map((e) => btn(e, () => { c.emoji = e; refreshSheet(); }, 'emoji' + (c.emoji === e ? ' selected' : ''), { 'aria-label': e }))),
      h('label', { class: 'field' }, h('span', null, '絵文字（キーボードからも入力可）'),
        h('input', { type: 'text', maxlength: '8', value: c.emoji, onChange: (e) => { c.emoji = [...e.target.value.trim()].slice(0, 2).join('') || '📦'; refreshSheet(); } })),
      h('label', { class: 'field' }, h('span', null, '名前（12文字まで）'),
        h('input', { type: 'text', maxlength: '12', value: c.name, onInput: (e) => { c.name = e.target.value; } })),
      c.type === 'expense' ? amountField('月の予算（なくてOK）', c.budget, (v) => { c.budget = v; }) : null,
      cat ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: c.archived, onChange: (e) => { c.archived = e.target.checked; } }), '記録画面に表示しない（過去の記録は残ります）') : null,
      h('div', { class: 'btn-row' },
        btn('保存する', () => {
          c.name = c.name.trim().slice(0, 12);
          if (!c.name) { toast('名前を入れてください'); return; }
          if (c.budget && !validAmount(c.budget)) c.budget = 0;
          if (cat) {
            const i = S.cats.findIndex((x) => x.id === c.id);
            addLog('update', 'cat', c.id, `カテゴリを変更：${cat.emoji}${cat.name} → ${c.emoji}${c.name}`, S.cats[i], c);
            S.cats[i] = c;
          } else {
            S.cats.push(c);
            addLog('create', 'cat', c.id, `カテゴリを追加：${c.emoji}${c.name}`, null, c);
          }
          save(); closeSheet(); render(); toast('保存しました');
        }, 'btn btn-primary'))),
  ]);
}

// ---- 支払い方法 ----
function viewPays() {
  return [
    subHead('支払い方法'),
    h('ul', { class: 'plain-list card' }, S.pays.map((p) => h('li', null,
      h('button', { type: 'button', class: 'row-btn', onClick: () => paySheet(p) }, h('span', null, `💳 ${p.name}`), h('span', { class: 'muted' }, '›'))))),
    btn('＋ 追加する', () => paySheet(null), 'btn btn-primary btn-wide'),
  ];
}
function paySheet(p) {
  let name = p ? p.name : '';
  openSheet(() => [
    sheetHead(p ? '支払い方法を編集' : '支払い方法を追加'),
    h('div', { class: 'sheet-body' },
      h('label', { class: 'field' }, h('span', null, '名前（例：楽天カード）'),
        h('input', { type: 'text', maxlength: '20', value: name, onInput: (e) => { name = e.target.value; } })),
      h('p', { class: 'help' }, 'カード番号などの秘密情報は入力しないでください。'),
      h('div', { class: 'btn-row' },
        p ? btn('削除', () => {
          const i = S.pays.indexOf(p);
          S.pays.splice(i, 1);
          if (S.settings.lastPay === p.id) S.settings.lastPay = null;
          addLog('delete', 'pay', p.id, `支払い方法を削除：${p.name}`);
          save(); closeSheet(); render();
          toast('削除しました', { label: '元に戻す', fn: () => { S.pays.splice(Math.min(i, S.pays.length), 0, p); addLog('undo', 'pay', p.id, `支払い方法の削除を取り消し：${p.name}`); save(); render(); } });
        }, 'btn btn-danger-outline') : null,
        btn('保存する', () => {
          name = name.trim().slice(0, 20);
          if (!name) { toast('名前を入れてください'); return; }
          if (p) { addLog('update', 'pay', p.id, `支払い方法を変更：${p.name} → ${name}`); p.name = name; }
          else { const np = { id: uid(), name }; S.pays.push(np); addLog('create', 'pay', np.id, `支払い方法を追加：${name}`); }
          save(); closeSheet(); render(); toast('保存しました');
        }, 'btn btn-primary'))),
  ]);
}

// ---- 操作の履歴 ----
function actLabel(act) {
  return { create: '➕追加', update: '✏️変更', delete: '🗑削除', restore: '↩️復元', undo: '↩️取消', auto: '🔁自動', security: '🔒安全', purge: '🧹完全削除', backup: '💾バックアップ', import: '📥復元' }[act] || act;
}
function fmtTime(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
function fmtDate(ms) { const d = new Date(ms); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; }
function viewHistory() {
  const f = ui.histFilter;
  const groups = { all: null, tx: ['tx'], rule: ['budget', 'cat', 'fav', 'rec', 'pay'], security: ['security', 'backup'] };
  const list = S.log.filter((l) => !groups[f] || groups[f].includes(l.kind)).slice().reverse().slice(0, 300);
  const chip = (id, label) => h('button', { type: 'button', class: 'chip' + (f === id ? ' active' : ''), 'aria-pressed': f === id ? 'true' : 'false', onClick: () => { ui.histFilter = id; render(); } }, label);
  return [
    subHead('操作の履歴'),
    h('p', { class: 'help pad' }, '追加・変更・削除はすべて記録されます。記録の「変更」をタップすると、変更前の内容に戻せます。'),
    h('div', { class: 'chip-row pad' }, chip('all', 'すべて'), chip('tx', '記録'), chip('rule', '設定'), chip('security', '安全')),
    list.length ? h('ul', { class: 'log-list' }, list.map((l) => {
      const canRevert = l.kind === 'tx' && txFields(l.before) && (l.act === 'update' || l.act === 'undo') && S.tx.some((t) => t.id === l.ref && !t.deleted);
      const content = [h('span', { class: 'hist-time' }, fmtTime(l.at)), h('span', { class: 'log-act' }, actLabel(l.act)), h('span', { class: 'log-sum' }, l.summary || '')];
      return h('li', null, canRevert
        ? h('button', { type: 'button', class: 'log-item clickable', onClick: () => revertSheet(l) }, ...content, h('span', { class: 'chev' }, '›'))
        : h('div', { class: 'log-item' }, ...content));
    })) : h('p', { class: 'empty' }, '履歴はありません'),
    S.log.length > 300 ? h('p', { class: 'help center' }, `新しい300件を表示中（保存は最大${MAX_LOG}件）`) : null,
  ];
}
function revertSheet(l) {
  const b = txFields(l.before);
  const t = S.tx.find((x) => x.id === l.ref);
  if (!b || !t) { toast('この履歴からは戻せません'); return; }
  const desc = (x) => `${x.date} ／ ${x.type === 'income' ? '収入' : '支出'} ／ ${catOf(x.cat).name} ／ ${yen(x.amount)}${x.memo ? ' ／ ' + x.memo : ''}`;
  openSheet(() => [
    sheetHead('変更前に戻す'),
    h('div', { class: 'sheet-body' },
      h('p', null, h('b', null, '今：'), desc(t)),
      h('p', null, h('b', null, '変更前：'), desc(b)),
      h('div', { class: 'btn-row' }, btn('やめる', () => closeSheet(), 'btn'),
        btn('変更前に戻す', () => {
          closeSheet();
          updateTx(t.id, b, { verb: '変更前に戻しました' });
        }, 'btn btn-primary'))),
  ]);
}

// ---- ゴミ箱 ----
function viewTrash() {
  const list = S.tx.filter((t) => t.deleted).sort((a, b) => b.deletedAt - a.deletedAt);
  return [
    subHead('ゴミ箱'),
    h('p', { class: 'help pad' }, '削除した記録はここに残ります。「元に戻す」で復活できます。'),
    list.length ? h('ul', { class: 'plain-list card' }, list.map((t) => h('li', null,
      h('span', { class: 'row-text' }, `${catOf(t.cat).emoji} ${catOf(t.cat).name} ${yen(t.amount)}`, h('span', { class: 'muted' }, ` ${t.date}`)),
      btn('元に戻す', () => restoreTx(t.id), 'chip')))) : h('p', { class: 'empty' }, 'ゴミ箱は空です'),
    list.length ? btn('ゴミ箱を空にする', async () => {
      const ok = await confirmSheet({ title: 'ゴミ箱を空にする', body: [`${list.length}件の記録を完全に削除します。元に戻せません。`], ok: '完全に削除', danger: true });
      if (!ok) return;
      const n = list.length;
      const ids = new Set(list.map((t) => t.id));
      S.tx = S.tx.filter((t) => !t.deleted);
      // 完全削除した記録の内容は履歴からも消す（件数のみ残す）
      for (const l of S.log) if (l.ref && ids.has(l.ref)) { l.before = undefined; l.after = undefined; l.summary = '（完全削除された記録）'; }
      addLog('purge', 'tx', null, `ゴミ箱を空にしました（${n}件）`);
      save(); render(); toast('ゴミ箱を空にしました');
    }, 'btn btn-danger-outline btn-wide') : null,
  ];
}

// ---- バックアップ ----
async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}
function viewBackup() {
  return [
    subHead('バックアップ・書き出し'),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '💾 バックアップを保存（おすすめ）'),
      h('p', null, '全データを暗号化したファイルを作ります。「ファイル」アプリやiCloud Driveに保存してください。'),
      h('p', { class: 'help' }, 'ファイルは外に置くので、アプリのパスコードとは別の「バックアップ用パスワード（10文字以上）」で守ります。iPhoneの「パスワード」に保存しておくと安心です。'),
      h('p', { class: 'help' }, S.settings.lastBackupAt ? `前回のバックアップ：${fmtDate(S.settings.lastBackupAt)}` : 'まだバックアップしていません'),
      btn('バックアップを保存', backupFlow, 'btn btn-primary')),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '📥 バックアップから復元'),
      h('p', null, '今のデータはバックアップの内容に置き換わります（直後なら取り消せます）。'),
      h('label', { class: 'btn file-btn' }, 'ファイルを選ぶ', h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', onChange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFlow(f); } }))),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '📄 CSVで書き出す（Excel・Numbers用）'),
      h('p', { class: 'warn' }, '⚠️ CSVは暗号化されません。人に見られない場所に保存し、不要になったら消してください。'),
      btn('CSVを書き出す', async () => {
        const ok = await confirmSheet({ title: 'CSVを書き出す', body: ['暗号化されていないファイルになります。共有先に注意してください。'], ok: '書き出す' });
        if (!ok || !S) return;
        const blob = new Blob([toCSV(S)], { type: 'text/csv;charset=utf-8' });
        if (await shareOrDownload(blob, `kakeibo-${dateStr()}.csv`) && S) {
          addLog('backup', 'backup', null, 'CSVを書き出しました（暗号化なし）');
          save();
        }
      }, 'btn')),
  ];
}

const BACKUP_MIN = 10;
function backupFlow() {
  let p1 = '', p2 = '', err = '', busy = false;
  openSheet(() => [
    sheetHead('バックアップ用パスワード'),
    h('form', { class: 'sheet-body', onSubmit: async (e) => {
      e.preventDefault();
      if (busy) return;
      if (p1.length < BACKUP_MIN) err = `${BACKUP_MIN}文字以上にしてください`;
      else if (/^\d+$/.test(p1)) err = '数字だけだと推測されやすいので、英字もまぜてください';
      else if (p1 !== p2) err = '2回の入力が違います';
      else err = '';
      if (err) { refreshSheet(); return; }
      busy = true; refreshSheet();
      const salt = randomBytes(16);
      const key = await deriveKey(p1, salt, PBKDF2_ITER);
      if (!S) return;
      const { iv, ct } = await encryptJSON(key, S, 'backup');
      const payload = { app: 'kakeibo-backup', v: 2, iter: PBKDF2_ITER, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct), createdAt: Date.now() };
      closeSheet();
      const ok = await shareOrDownload(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `kakeibo-backup-${dateStr()}.json`);
      if (ok && S) {
        S.settings.lastBackupAt = Date.now();
        addLog('backup', 'backup', null, '暗号化バックアップを作成しました');
        save(); render(); toast('バックアップを作りました');
      }
    } },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿バックアップ', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
    h('p', { class: 'help' }, `英字をまぜて${BACKUP_MIN}文字以上。復元するときに必要です。忘れると復元できません。`),
    h('label', { class: 'field' }, h('span', null, 'バックアップ用パスワード'),
      h('input', { type: 'password', autocomplete: 'new-password', value: p1, onInput: (e) => { p1 = e.target.value; } })),
    h('label', { class: 'field' }, h('span', null, 'もう一度'),
      h('input', { type: 'password', autocomplete: 'new-password', value: p2, onInput: (e) => { p2 = e.target.value; } })),
    err ? h('p', { class: 'error', role: 'alert' }, err) : null,
    h('button', { type: 'submit', class: 'btn btn-primary', disabled: busy }, busy ? '暗号化しています…' : '保存する')),
  ]);
}

async function importFlow(file) {
  if (file.size > 20 * 1024 * 1024) { toast('ファイルが大きすぎます'); return; }
  let payload;
  try {
    payload = JSON.parse(await file.text());
    if (payload.app !== 'kakeibo-backup' || payload.v !== 2) throw new Error();
    if (typeof payload.salt !== 'string' || typeof payload.iv !== 'string' || typeof payload.ct !== 'string') throw new Error();
  } catch { toast('この家計簿のバックアップファイルではありません'); return; }
  const iter = Number(payload.iter);
  if (!Number.isInteger(iter) || iter < 100000 || iter > 10000000) { toast('バックアップファイルの形式が正しくありません'); return; }
  const created = Number(payload.createdAt) || 0;
  let pass = '';
  let err = '';
  let busy = false;
  openSheet(() => {
    const input = h('input', { type: 'password', autocomplete: 'current-password', value: pass, onInput: (e) => { pass = e.target.value; } });
    setTimeout(() => input.focus(), 50);
    return [
      sheetHead('バックアップから復元'),
      h('form', { class: 'sheet-body', onSubmit: async (e) => {
        e.preventDefault();
        if (busy || !pass) return;
        busy = true; err = ''; refreshSheet();
        let data;
        try {
          const key = await deriveKey(pass, b64d(payload.salt), iter);
          data = sanitizeState(await decryptJSON(key, { iv: b64d(payload.iv), ct: b64d(payload.ct) }, 'backup'));
        } catch { busy = false; err = 'パスワードが違うか、ファイルが壊れています'; refreshSheet(); return; }
        if (!S) return;
        closeSheet();
        const ok = await confirmSheet({ title: '置き換えますか？', body: [`バックアップ（${created ? fmtDate(created) : '日付不明'}作成・記録${data.tx.filter((t) => !t.deleted).length}件）で、今のデータ（記録${liveTx(S).length}件）を置き換えます。`], ok: '置き換える', danger: true });
        if (!ok || !S) return;
        const prev = S;
        S = data;
        addLog('import', 'backup', null, `バックアップ（${created ? fmtDate(created) : '日付不明'}作成）から復元しました`);
        save(); render();
        toast('復元しました', { label: '取り消す', fn: () => { S = prev; addLog('undo', 'backup', null, '復元を取り消しました'); save(); render(); } });
      } },
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿バックアップ', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
      h('label', { class: 'field' }, h('span', null, 'バックアップ用パスワード'), input),
      err ? h('p', { class: 'error', role: 'alert' }, err) : null,
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: busy }, busy ? '確認中…' : '開く')),
    ];
  });
}

// ---- パスコード・自動ロック ----
async function canOpenWith(key) {
  for (const k of ['vault', 'vault_prev']) {
    try { const v = await db.get(k); if (v) { await decryptJSON(key, v); return true; } } catch { /* 次へ */ }
  }
  return false;
}
function viewSecurity() {
  let cur = '', p1 = '', p2 = '', kind = META.kind, busy = false;
  const status = h('p', { class: 'status', 'aria-live': 'polite' });
  const errEl = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    if (busy) return;
    const err = passProblem(p1, kind) || (p1 !== p2 ? '新しいパスコードが2回で違います' : '');
    errEl.textContent = err;
    if (err) return;
    busy = true;
    document.body.classList.add('busy'); // 処理中は操作させない（途中で保存が割り込むのを防ぐ）
    status.textContent = '確認中…';
    try {
      const curKey = await deriveKey(cur, META.salt, META.iter);
      if (!(await canOpenWith(curKey))) { errEl.textContent = '今のパスコードが違います'; status.textContent = ''; return; }
      status.textContent = '暗号化し直しています…';
      const salt = randomBytes(16);
      const key = await deriveKey(p1, salt, PBKDF2_ITER);
      // 保存の順番待ちの列に入れて、ほかの保存と絶対に重ならないようにする
      const job = saveChain.then(async () => {
        if (!S) throw new Error('locked');
        addLog('security', 'security', null, 'パスコードを変更しました');
        const { iv, ct } = await encryptJSON(key, S);
        const meta = { ...META, salt, iter: PBKDF2_ITER, kind };
        const rev = REV + 1;
        await db.atomic({ meta, vault: { iv, ct, savedAt: Date.now(), rev } }, ['vault_prev']);
        META = meta; KEY = key; REV = rev;
      });
      saveChain = job.catch(() => {});
      await job;
      render(); toast('パスコードを変更しました');
    } catch (ex) {
      console.error(ex);
      errEl.textContent = '変更できませんでした。もう一度お試しください';
      status.textContent = '';
    } finally {
      busy = false;
      document.body.classList.remove('busy');
    }
  } },
  h('h2', { class: 'card-title' }, 'パスコードを変える'),
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
  h('label', { class: 'field' }, h('span', null, '今のパスコード'), h('input', { type: 'password', autocomplete: 'current-password', inputmode: META.kind === 'pin' ? 'numeric' : 'text', onInput: (e) => { cur = e.target.value; } })),
  h('label', { class: 'field' }, h('span', null, '新しいパスコード（6文字以上）'), h('input', { type: 'password', id: 'np1', autocomplete: 'new-password', inputmode: kind === 'pin' ? 'numeric' : 'text', onInput: (e) => { p1 = e.target.value; } })),
  h('label', { class: 'field' }, h('span', null, 'もう一度'), h('input', { type: 'password', id: 'np2', autocomplete: 'new-password', inputmode: kind === 'pin' ? 'numeric' : 'text', onInput: (e) => { p2 = e.target.value; } })),
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: kind === 'text', onChange: (e) => {
    kind = e.target.checked ? 'text' : 'pin';
    form.querySelectorAll('#np1,#np2').forEach((i) => i.setAttribute('inputmode', kind === 'pin' ? 'numeric' : 'text'));
  } }), '英数字のパスコードにする（より安全）'),
  errEl, status,
  h('button', { type: 'submit', class: 'btn btn-primary' }, '変更する'));

  return [
    subHead('パスコード・自動ロック'),
    h('section', { class: 'card' },
      btn('🔒 今すぐロック', () => lock(), 'btn'),
      h('p', { class: 'help' }, '💡 iPhoneの「パスワード」に保存しておくと、ロック画面でFace IDを使って入力できます。')),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '自動ロックまでの時間'),
      h('p', { class: 'help' }, '操作しない時間、またはアプリを閉じてからこの時間がたつとロックします。短いほど安全、長いほどラクです。'),
      h('div', { class: 'chip-row' }, LOCK_OPTIONS.map((m) => h('button', { type: 'button', class: 'chip' + (S.settings.autoLockMin === m ? ' active' : ''), 'aria-pressed': S.settings.autoLockMin === m ? 'true' : 'false',
        onClick: () => { S.settings.autoLockMin = m; addLog('update', 'security', null, `自動ロックを${m}分に変更`); save(); resetIdle(); render(); } }, m === 60 ? '1時間' : `${m}分`)))),
    form,
  ];
}

// ---- 表示テーマ（ロック前にも使うため、平文の prefs に保存。機密ではない） ----
async function applyThemeFromPrefs() {
  try { const p = await db.get('prefs'); applyTheme(p?.theme || 'auto'); } catch { applyTheme('auto'); }
}
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches) ? '#15171a' : '#f6f5f2');
}
function viewTheme() {
  const cur = document.documentElement.dataset.theme || 'auto';
  return [
    subHead('表示テーマ'),
    h('div', { class: 'chip-row pad' }, [['auto', '端末に合わせる'], ['light', 'ライト'], ['dark', 'ダーク']].map(([id, l]) => h('button', {
      type: 'button', class: 'chip' + (cur === id ? ' active' : ''), 'aria-pressed': cur === id ? 'true' : 'false',
      onClick: async () => { applyTheme(id); await db.put('prefs', { theme: id }); render(); },
    }, l))),
  ];
}

function viewAbout() {
  const items = [
    ['📱 端末の中だけに保存', 'データはこのiPhoneの中（ブラウザの保存領域）にだけあります。インターネットへは一切送信しません。広告・解析ツールもありません。'],
    ['🔒 強い暗号化', 'パスコードから鍵を作り（PBKDF2 60万回）、AES-256-GCMで暗号化して保存します。改ざんされると開けなくなるので気づけます。'],
    ['🧠 鍵はメモリの中だけ', 'パスコードや鍵は保存しません。ロックすると、画面とメモリからデータを消します。'],
    ['⏱ 自動ロック', `${S.settings.autoLockMin}分操作がない、またはアプリを閉じて${S.settings.autoLockMin}分たつとロックします。`],
    ['🚫 総当たり対策', 'このアプリの画面では、パスコードを5回間違えると待ち時間が段々長くなり、間違いがあったことを次回お知らせします。（端末そのものを盗まれた場合に備え、iPhone本体のパスコードも必ず設定してください）'],
    ['💾 バックアップは別パスワード', 'iCloudなど外に置くファイルなので、10文字以上のバックアップ用パスワードで暗号化します。'],
    ['🙈 のぞき見対策', 'アプリを切り替えるときは画面を隠し、アプリ切り替え画面に金額が写らないようにしています。'],
    ['🧱 外部ファイルを読み込まない', 'コンテンツセキュリティポリシーで、アプリ以外のスクリプトや通信を禁止しています。他のサイトの中に埋め込まれた場合は表示しません。'],
    ['⚠️ 注意してほしいこと', 'パスコードを忘れると復元できません。定期的にバックアップしてください。CSVは暗号化されません。'],
  ];
  return [subHead('このアプリの安全性'), h('ul', { class: 'about-list' }, items.map(([t, d]) => h('li', { class: 'card' }, h('h2', { class: 'card-title' }, t), h('p', null, d))))];
}

function viewWipe() {
  return [
    subHead('すべてのデータを消す'),
    h('section', { class: 'card' },
      h('p', null, 'この端末から家計簿のデータ・設定をすべて消します。元に戻せません。'),
      h('p', { class: 'help' }, '必要なら、先に「バックアップ」を作ってください。'),
      btn('すべて消す', async () => {
        const ok = await confirmSheet({ title: '本当に消しますか？', body: ['すべての記録・設定が消えます。元に戻せません。'], ok: 'すべて消す', danger: true, typed: '削除' });
        if (ok) await wipeAll();
      }, 'btn btn-danger')),
  ];
}

// ================= 端末判定 =================
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }

// キーボード入力（PC・外部キーボード用）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetEl) { dismissSheet(); return; }
  if (addState && addState.step === 1 && sheetEl && !e.target.matches('input,select,textarea')) {
    if (/^\d$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('⌫');
    else if (e.key === 'Enter' && addState.amount) { addState.step = 2; refreshSheet(true); }
  }
});

boot();
