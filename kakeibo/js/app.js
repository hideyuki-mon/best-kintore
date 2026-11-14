// 家計簿アプリ本体
// 方針: 外部通信なし / innerHTML 不使用（文字列はすべて textContent で表示）/ 鍵とデータはロック中メモリに残さない
import { deriveKey, encryptJSON, decryptJSON, randomBytes, b64e, b64d, PBKDF2_ITER } from './crypto.js';
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
const ui = { view: 'home', sub: null, ym: ymOf(dateStr()), q: '', type: 'all', onlyUncat: false, histFilter: 'all', catTab: 'expense' };
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
function toast(msg, action) {
  let box = document.getElementById('toast');
  if (!box) { box = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  box.replaceChildren(...[h('span', { class: 'toast-msg' }, msg),
    action ? btn(action.label, () => { hideToast(); action.fn(); }, 'toast-act') : null].filter(Boolean));
  box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 7000 : 3500);
}
function hideToast() { document.getElementById('toast')?.classList.remove('show'); }

// ================= シート（下から出る画面） =================
let sheetEl = null;
let sheetRender = null;
let lastFocus = null;
function openSheet(renderFn) {
  closeSheet(true);
  lastFocus = document.activeElement;
  sheetRender = renderFn;
  sheetEl = h('div', { class: 'overlay', onClick: (e) => { if (e.target === sheetEl) closeSheet(); } });
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
      const { iv, ct } = await encryptJSON(key, data);
      await db.putVault({ iv, ct, savedAt: Date.now() });
    })
    .catch((e) => {
      console.error(e);
      toast('保存できませんでした。空き容量を確認してください');
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
  const t = { id: uid(), ...data, createdAt: Date.now(), updatedAt: Date.now(), deleted: false };
  S.tx.push(t);
  if (t.pay) S.settings.lastPay = t.pay;
  addLog('create', 'tx', t.id, txLabel(t), null, t);
  save(); render();
  if (!silent) {
    toast(`記録しました：${txLabel(t)}`, { label: '取り消す', fn: () => {
      const i = S.tx.findIndex((x) => x.id === t.id);
      if (i >= 0) S.tx.splice(i, 1);
      addLog('undo', 'tx', t.id, `記録を取り消し：${txLabel(t)}`, t, null);
      save(); render();
    } });
  }
  return t;
}
function updateTx(id, patch, { verb = '変更しました' } = {}) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
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
}
function restoreTx(id) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  t.deleted = false; delete t.deletedAt; t.updatedAt = Date.now();
  addLog('restore', 'tx', id, txLabel(t), null, t);
  save(); render();
  toast(`元に戻しました：${txLabel(t)}`);
}

// ================= 起動・ロック =================
async function boot() {
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
  if (!META) renderSetup(); else renderLock();
}

function lock(reason) {
  KEY = null; S = null;
  closeSheet(true); hideToast();
  ui.view = 'home'; ui.sub = null;
  renderLock(reason);
}

async function getGuard() { return (await db.get('guard')) || { fails: 0, lockUntil: 0, failsSinceUnlock: 0 }; }

async function tryUnlock(pass) {
  const guard = await getGuard();
  if (Date.now() < guard.lockUntil) return { ok: false, wait: guard.lockUntil - Date.now() };
  const key = await deriveKey(pass, META.salt, META.iter);
  let state = null;
  let recovered = false;
  try {
    state = await decryptJSON(key, await db.get('vault'));
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
  S = sanitizeState(state);
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
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
function renderSetup() {
  let step = 0, kind = 'pin', p1 = '', err = '';
  const draw = () => {
    if (step === 0) {
      $app.replaceChildren(h('main', { class: 'center-screen' },
        h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '📒'),
        h('h1', null, 'ようこそ'),
        h('p', { class: 'lead' }, 'かんたんに続けられる家計簿です。'),
        h('ul', { class: 'promise' },
          h('li', null, h('b', null, '📱 この端末の中だけ'), 'に保存。どこにも送信しません。'),
          h('li', null, h('b', null, '🔒 パスコードで暗号化'), 'します。'),
          h('li', null, h('b', null, '⚠️ パスコードを忘れると'), '誰にも復元できません。バックアップ機能を使ってください。')),
        btn('はじめる', () => { step = 1; draw(); }, 'btn btn-primary btn-big')));
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
        if (v.length < 6) { err = '6文字以上にしてください'; draw(); return; }
        if (kind === 'pin' && !/^\d+$/.test(v)) { err = '数字だけで入力してください'; draw(); return; }
        if (/^(\d)\1+$/.test(v) || '01234567890'.includes(v) || '9876543210'.includes(v)) { err = '同じ数字の連続や「123456」は推測されやすいので避けてください'; draw(); return; }
        p1 = v; err = ''; step = 2; draw(); return;
      }
      if (v !== p1) { err = '1回目と違います。もう一度最初から入力してください'; p1 = ''; step = 1; draw(); return; }
      form.querySelector('button[type=submit]').disabled = true;
      form.querySelector('.status').textContent = '暗号化の準備中…';
      const salt = randomBytes(16);
      const key = await deriveKey(v, salt, PBKDF2_ITER);
      const state = defaultState();
      state.log.push({ id: uid(), at: Date.now(), act: 'security', kind: 'security', summary: 'アプリを使いはじめました' });
      const { iv, ct } = await encryptJSON(key, state);
      META = { salt, iter: PBKDF2_ITER, kind, createdAt: Date.now() };
      await db.atomic({ meta: META, vault: { iv, ct, savedAt: Date.now() } });
      KEY = key; S = state;
      render(); startIdleWatch();
      toast('準備できました。下の「＋記録」から始めましょう');
    } },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
    h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '🔒'),
    h('h1', null, isConfirm ? 'もう一度入力' : 'パスコードを決める'),
    h('label', { for: 'pass', class: 'field big-field' },
      h('span', null, isConfirm ? '確認のため、同じパスコードを入力' : 'パスコード（6文字以上）'), input),
    h('p', { id: 'pass-help', class: 'help' }, kind === 'pin' ? '数字6桁以上。長いほど安全です。' : '英数字・記号を使えます。'),
    !isConfirm ? btn(kind === 'pin' ? '英数字で設定する' : '数字だけで設定する', () => { kind = kind === 'pin' ? 'text' : 'pin'; err = ''; draw(); }, 'link-btn') : null,
    err ? h('p', { class: 'error', role: 'alert' }, err) : null,
    h('p', { class: 'status', 'aria-live': 'polite' }),
    h('button', { type: 'submit', class: 'btn btn-primary btn-big' }, isConfirm ? '設定する' : '次へ'),
    isConfirm ? btn('戻る', () => { step = 1; p1 = ''; draw(); }, 'link-btn') : null);
    $app.replaceChildren(form);
    setTimeout(() => input.focus(), 50);
  };
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
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-big', disabled: waitMs > 0 }, 'ひらく');
    const form = h('form', { class: 'center-screen', onSubmit: async (e) => {
      e.preventDefault();
      if (!input.value) return;
      submit.disabled = true; input.disabled = true;
      status.textContent = '確認中…';
      const r = await tryUnlock(input.value);
      input.value = '';
      if (!r.ok) {
        err = r.wait > 0 ? '間違いが続いたため、しばらく待ってから試してください' : 'パスコードが違います';
        draw();
      }
    } },
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
    h('div', { class: 'hero-icon', 'aria-hidden': 'true' }, '🔒'),
    h('h1', null, '家計簿'),
    reason ? h('p', { class: 'help' }, reason) : null,
    h('label', { for: 'pass', class: 'field big-field' }, h('span', null, 'パスコード'), input),
    err ? h('p', { class: 'error', role: 'alert' }, err) : null,
    waitMs > 0 ? h('p', { class: 'error', id: 'wait' }, `あと ${Math.ceil(waitMs / 1000)} 秒お待ちください`) : null,
    status,
    submit,
    btn('パスコードを忘れたとき', forgotFlow, 'link-btn'));
    $app.replaceChildren(form);
    clearInterval(countdown);
    if (waitMs > 0) countdown = setInterval(() => { if (Date.now() >= guard.lockUntil) { clearInterval(countdown); err = ''; draw(); } else { const w = document.getElementById('wait'); if (w) w.textContent = `あと ${Math.ceil((guard.lockUntil - Date.now()) / 1000)} 秒お待ちください`; } }, 1000);
    else setTimeout(() => input.focus(), 50);
  };
  draw();
}

async function forgotFlow() {
  const ok = await confirmSheet({
    title: 'パスコードを忘れたとき',
    body: ['データは暗号化されているため、パスコードがないと誰にも（作者にも）開けません。',
      'バックアップファイルがあれば、全部消してから「設定 → バックアップ」で復元できます（そのバックアップを作った時のパスコードが必要です）。',
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
  return h('div', { class: 'month-nav' },
    btn('‹', () => { ui.ym = ymAdd(ui.ym, -1); render(); }, 'icon-btn', { 'aria-label': '前の月' }),
    h('strong', { 'aria-live': 'polite' }, ymLabel(ui.ym)),
    btn('›', () => { ui.ym = ymAdd(ui.ym, 1); render(); }, 'icon-btn', { 'aria-label': '次の月', disabled: ui.ym >= cur }),
    ui.ym !== cur ? btn('今月', () => { ui.ym = cur; render(); }, 'chip') : null);
}

// ================= ホーム =================
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
      h('p', { class: 'hero-num' }, over ? yen(-left) + ' オーバー' : yen(left)),
      h('div', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': '予算の使用率' },
        h('div', { class: 'meter-fill', width: pct + '%' })),
      h('p', { class: 'hero-sub' }, over ? `予算 ${yen(budget)} ／ 使った ${yen(tot.expense)}`
        : `1日あたり あと ${yen(Math.floor(left / daysLeft))}（残り${daysLeft}日）`));
  } else {
    hero = h('section', { class: 'card hero' },
      h('p', { class: 'hero-label' }, '今月使ったお金'),
      h('p', { class: 'hero-num' }, yen(tot.expense)),
      btn('予算を決めると「あといくら」が出ます →', () => { ui.view = 'settings'; ui.sub = 'budget'; render(); }, 'link-btn'));
  }

  const backupOld = S.tx.length >= 10 && Date.now() - (S.settings.lastBackupAt || 0) > 30 * 864e5;
  const showInstall = isIOS() && !isStandalone() && !S.settings.installHintHidden;

  return [
    pageHead(`${Number(ym.slice(5))}月の家計簿`, btn('🔒 ロック', () => lock(), 'chip', { 'aria-label': '今すぐロックする' })),
    showInstall ? h('section', { class: 'card notice' },
      h('p', null, h('b', null, '📲 ホーム画面に追加すると、アプリのように使えます')),
      h('p', { class: 'help' }, 'Safari 下の「共有」ボタン → 「ホーム画面に追加」'),
      btn('閉じる', () => { S.settings.installHintHidden = true; save(); render(); }, 'link-btn')) : null,
    hero,
    h('section', { class: 'trio' },
      h('div', null, h('span', null, '収入'), h('b', { class: 'income' }, yen(tot.income))),
      h('div', null, h('span', null, '支出'), h('b', null, yen(tot.expense))),
      h('div', null, h('span', null, '収支'), h('b', { class: tot.balance >= 0 ? 'income' : 'minus' }, signedYen(tot.balance)))),
    h('section', { class: 'card status-card' + (recordedToday ? ' done' : '') },
      recordedToday
        ? h('p', null, `✅ 今日も記録できました${st > 1 ? `（${st}日連続）` : ''}`)
        : h('p', null, '📝 今日はまだ記録していません。1件だけでもOK！')),
    uncat > 0 ? h('button', { type: 'button', class: 'card notice action-card', onClick: () => { ui.view = 'list'; ui.onlyUncat = true; ui.q = ''; ui.type = 'all'; render(); } },
      `❓ カテゴリ未分類が ${uncat}件 あります → あとで整理する`) : null,
    backupOld ? h('button', { type: 'button', class: 'card notice action-card', onClick: () => { ui.view = 'settings'; ui.sub = 'backup'; render(); } },
      '💾 しばらくバックアップしていません → 今すぐ保存') : null,
    S.favs.length ? h('section', null,
      h('h2', { class: 'section-title' }, 'よく使う（タップですぐ記録）'),
      h('div', { class: 'fav-row' }, S.favs.map((f) => h('button', { type: 'button', class: 'fav', onClick: () => {
        createTx({ type: f.type, amount: f.amount, cat: f.cat, date: dateStr(), memo: f.memo, pay: f.pay });
      } }, h('span', { class: 'fav-emoji', 'aria-hidden': 'true' }, catOf(f.cat).emoji),
      h('span', null, f.memo || catOf(f.cat).name), h('b', null, yen(f.amount)))))) : null,
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
        h('span', { class: 'tx-cat' }, c.name, t.rec ? h('span', { class: 'badge' }, '固定費') : null),
        h('span', { class: 'tx-sub' }, [showDate ? dayLabel(t.date) : null, p?.name, t.memo].filter(Boolean).join(' ・ '))),
      h('span', { class: 'tx-amt' + (t.type === 'income' ? ' income' : '') }, (t.type === 'income' ? '+' : '') + yen(t.amount))));
  }));
}

// ================= 一覧 =================
function viewList() {
  const results = h('div', { id: 'list-results' });
  const fill = () => {
    let list = txOfMonth(S, ui.ym);
    if (ui.type !== 'all') list = list.filter((t) => t.type === ui.type);
    if (ui.onlyUncat) list = list.filter((t) => t.cat === UNCAT.expense || t.cat === UNCAT.income);
    const q = ui.q.trim().toLowerCase();
    if (q) list = list.filter((t) => [catOf(t.cat).name, t.memo, payOf(t.pay)?.name, String(t.amount)].join(' ').toLowerCase().includes(q));
    list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    if (!list.length) { results.replaceChildren(h('p', { class: 'empty' }, q || ui.onlyUncat || ui.type !== 'all' ? '条件に合う記録はありません' : 'この月の記録はまだありません')); return; }
    const groups = new Map();
    for (const t of list) { if (!groups.has(t.date)) groups.set(t.date, []); groups.get(t.date).push(t); }
    results.replaceChildren(...[...groups.entries()].map(([d, items]) => {
      const exp = items.filter((t) => t.type === 'expense').reduce((a, t) => a + t.amount, 0);
      return h('section', { class: 'day-group' },
        h('h2', { class: 'day-head' }, h('span', null, dayLabel(d)), exp ? h('span', null, '支出 ' + yen(exp)) : null),
        txListEl(items));
    }));
  };
  fill();
  const tot = monthTotals(S, ui.ym);
  const chip = (label, active, onClick) => h('button', { type: 'button', class: 'chip' + (active ? ' active' : ''), 'aria-pressed': active ? 'true' : 'false', onClick }, label);
  return [
    pageHead('記録の一覧'),
    monthNav(),
    h('section', { class: 'trio' },
      h('div', null, h('span', null, '収入'), h('b', { class: 'income' }, yen(tot.income))),
      h('div', null, h('span', null, '支出'), h('b', null, yen(tot.expense))),
      h('div', null, h('span', null, '収支'), h('b', { class: tot.balance >= 0 ? 'income' : 'minus' }, signedYen(tot.balance)))),
    h('label', { class: 'search' }, h('span', { class: 'visually-hidden' }, '検索'),
      h('input', { type: 'search', placeholder: '🔍 メモ・カテゴリ・金額で探す', value: ui.q, enterkeyhint: 'search', onInput: (e) => { ui.q = e.target.value; fill(); } })),
    h('div', { class: 'chip-row' },
      chip('すべて', ui.type === 'all' && !ui.onlyUncat, () => { ui.type = 'all'; ui.onlyUncat = false; render(); }),
      chip('支出', ui.type === 'expense', () => { ui.type = 'expense'; render(); }),
      chip('収入', ui.type === 'income', () => { ui.type = 'income'; render(); }),
      chip('❓未分類', ui.onlyUncat, () => { ui.onlyUncat = !ui.onlyUncat; render(); })),
    results,
  ];
}

// ================= 記録（追加・編集） =================
let addState = null;
function openAdd(preset = {}) {
  closeSheet(true);
  addState = { mode: 'new', step: 1, type: 'expense', amount: '', date: dateStr(), memo: '', pay: S.settings.lastPay || '', cat: null, ...preset };
  openSheet(renderAdd);
}
function openEdit(id) {
  const t = S.tx.find((x) => x.id === id);
  if (!t) return;
  closeSheet(true);
  addState = { mode: 'edit', id, step: 2, type: t.type, amount: String(t.amount), date: t.date, memo: t.memo || '', pay: t.pay || '', cat: t.cat };
  openSheet(renderAdd);
}

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
    return [
      sheetHead(a.mode === 'edit' ? '金額を直す' : '記録する', a.mode === 'edit' ? { backLabel: '‹ 戻る', onBack: () => { a.step = 2; refreshSheet(); } } : {}),
      h('div', { class: 'sheet-body add-step1' },
        typeToggle,
        h('p', { class: 'step-hint' }, h('b', null, 'ステップ1'), ' 金額を入れる'),
        h('p', { class: 'amount-display' + (a.amount ? '' : ' zero'), 'aria-live': 'polite' }, yen(Number(a.amount || 0))),
        keypad(pressKey),
        h('button', { type: 'button', id: 'next-btn', class: 'btn btn-primary btn-big', disabled: !a.amount, onClick: () => { a.step = 2; refreshSheet(true); } },
          a.mode === 'edit' ? 'この金額にする' : '次へ（カテゴリを選ぶ）')),
    ];
  }

  const amount = Number(a.amount);
  const today = dateStr();
  const dateChips = [[today, '今日'], [addDays(today, -1), '昨日'], [addDays(today, -2), 'おととい']];
  const isOther = !dateChips.some(([d]) => d === a.date);
  const chooseCat = (catId) => {
    a.cat = catId;
    const data = { type: a.type, amount, cat: catId, date: a.date, memo: a.memo.trim().slice(0, 100), pay: a.pay };
    if (a.mode === 'new') { closeSheet(); createTx(data); }
    else { closeSheet(); updateTx(a.id, data); }
  };
  const tx = a.mode === 'edit' ? S.tx.find((x) => x.id === a.id) : null;
  const hist = tx ? S.log.filter((l) => l.kind === 'tx' && l.ref === tx.id).slice().reverse() : [];

  return [
    sheetHead(a.mode === 'edit' ? '記録を編集' : '記録する'),
    h('div', { class: 'sheet-body' },
      a.mode === 'edit' ? typeToggle : null,
      h('button', { type: 'button', class: 'amount-small', onClick: () => { a.step = 1; refreshSheet(true); } },
        h('span', null, a.type === 'income' ? '収入' : '支出'), h('b', null, yen(amount)), h('span', { class: 'link' }, '金額を直す')),
      h('div', { class: 'opt' },
        h('span', { class: 'opt-label', id: 'date-l' }, '日付'),
        h('div', { class: 'chip-row', role: 'group', 'aria-labelledby': 'date-l' },
          dateChips.map(([d, l]) => h('button', { type: 'button', class: 'chip' + (a.date === d ? ' active' : ''), 'aria-pressed': a.date === d ? 'true' : 'false', onClick: () => { a.date = d; refreshSheet(); } }, l)),
          h('label', { class: 'chip date-chip' + (isOther ? ' active' : '') },
            h('span', null, isOther ? dayLabel(a.date) : '📅 他の日'),
            h('input', { type: 'date', value: a.date, max: today, 'aria-label': '日付を選ぶ', onChange: (e) => { if (e.target.value) { a.date = e.target.value; refreshSheet(); } } })))),
      h('div', { class: 'opt opt-inline' },
        h('label', { class: 'field' }, h('span', null, '支払い方法'),
          h('select', { onChange: (e) => { a.pay = e.target.value; } },
            h('option', { value: '' }, '（指定なし）'),
            S.pays.map((p) => h('option', { value: p.id, selected: a.pay === p.id }, p.name)))),
        h('label', { class: 'field' }, h('span', null, 'メモ（なくてOK）'),
          h('input', { type: 'text', maxlength: '100', value: a.memo, placeholder: '例：スーパー', enterkeyhint: 'done', onInput: (e) => { a.memo = e.target.value; } }))),
      h('p', { class: 'step-hint' }, h('b', null, a.mode === 'edit' ? '' : 'ステップ2'), a.mode === 'edit' ? 'カテゴリをタップすると保存されます（今のカテゴリは枠つき）' : ' カテゴリをタップすると記録完了'),
      h('div', { class: 'cat-grid' }, [...activeCats(a.type).filter((c) => !c.system), ...activeCats(a.type).filter((c) => c.system)].map((c) => h('button', { type: 'button', class: 'cat' + (a.cat === c.id ? ' selected' : '') + (c.system ? ' cat-later' : ''), onClick: () => chooseCat(c.id) },
        h('span', { class: 'cat-emoji', 'aria-hidden': 'true' }, c.system ? '⏳' : c.emoji),
        h('span', { class: 'cat-name' }, c.system ? 'あとで決める' : c.name)))),
      a.mode === 'edit' ? h('div', { class: 'edit-actions' },
        btn('このまま保存', () => chooseCat(a.cat), 'btn btn-primary'),
        btn('⭐ よく使うに追加', () => {
          S.favs.push({ id: uid(), type: a.type, amount, cat: a.cat, memo: a.memo.trim(), pay: a.pay });
          addLog('create', 'fav', null, `よく使うに追加：${catOf(a.cat).name} ${yen(amount)}`);
          save(); render(); toast('ホームの「よく使う」に追加しました');
        }, 'btn'),
        btn('🗑 ゴミ箱へ', () => { closeSheet(); deleteTx(a.id); }, 'btn btn-danger-outline')) : null,
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
  const maxCat = Math.max(1, ...cats.map((c) => c.amount), ...cats.map((c) => catOf(c.cat).budget || 0));
  const budgetCats = S.cats.filter((c) => c.type === 'expense' && c.budget > 0 && !cats.some((x) => x.cat === c.id));

  const months = [];
  for (let i = 5; i >= 0; i--) { const m = ymAdd(ym, -i); months.push({ ym: m, ...monthTotals(S, m) }); }
  const maxM = Math.max(1, ...months.map((m) => m.expense));

  const barRow = (catId, amount) => {
    const c = catOf(catId);
    const bud = c.budget || 0;
    const over = bud > 0 && amount > bud;
    return h('li', { class: 'bar-row' },
      h('div', { class: 'bar-label' }, h('span', null, `${c.emoji} ${c.name}`),
        h('span', null, h('b', null, yen(amount)), bud ? h('span', { class: 'bar-bud' + (over ? ' over' : '') }, over ? ` ⚠️ 予算${yen(bud)}を${yen(amount - bud)}超過` : ` ／ 予算${yen(bud)}`) : null,
          tot.expense ? h('span', { class: 'pct' }, ` ${Math.round((amount / tot.expense) * 100)}%`) : null)),
      h('div', { class: 'bar-track' },
        h('div', { class: 'bar-fill' + (over ? ' over' : ''), width: (amount / maxCat) * 100 + '%' }),
        bud ? h('div', { class: 'bar-budget', 'aria-hidden': 'true' }) : null));
  };

  const list = h('ul', { class: 'bars' }, [...cats.map((x) => barRow(x.cat, x.amount)), ...budgetCats.map((c) => barRow(c.id, 0))]);
  // 予算ラインの位置（CSSOMで設定：CSPでstyle属性は使わない）
  list.querySelectorAll('.bar-row').forEach((row, i) => {
    const all = [...cats.map((x) => x.cat), ...budgetCats.map((c) => c.id)];
    const bud = catOf(all[i]).budget;
    const line = row.querySelector('.bar-budget');
    if (line && bud) line.style.left = `calc(${(bud / maxCat) * 100}% - 1px)`;
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
      cats.length || budgetCats.length ? list : h('p', { class: 'empty' }, 'この月の支出はありません')),
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
      row('🎨', '画面の明るさ', 'theme'),
      row('🛡', 'このアプリの安全性について', 'about'),
      row('⚠️', 'すべてのデータを消す', 'wipe')),
    h('p', { class: 'help center' }, '家計簿 v1.0.0'),
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
            addLog('update', kind, f.id, `${name}を変更：${f.memo || catOf(f.cat).name} ${yen(f.amount)}`, list[i], f);
            list[i] = { ...list[i], ...f };
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
          addLog('delete', 'pay', p.id, `支払い方法を削除：${p.name}`, p, null);
          save(); closeSheet(); render();
          toast('削除しました', { label: '元に戻す', fn: () => { S.pays.splice(i, 0, p); addLog('undo', 'pay', p.id, `支払い方法の削除を取り消し：${p.name}`); save(); render(); } });
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
      const canRevert = l.kind === 'tx' && l.before && (l.act === 'update' || l.act === 'undo') && S.tx.some((t) => t.id === l.ref && !t.deleted);
      const content = [h('span', { class: 'hist-time' }, fmtTime(l.at)), h('span', { class: 'log-act' }, actLabel(l.act)), h('span', { class: 'log-sum' }, l.summary || '')];
      return h('li', null, canRevert
        ? h('button', { type: 'button', class: 'log-item clickable', onClick: () => revertSheet(l) }, ...content, h('span', { class: 'chev' }, '›'))
        : h('div', { class: 'log-item' }, ...content));
    })) : h('p', { class: 'empty' }, '履歴はありません'),
    S.log.length > 300 ? h('p', { class: 'help center' }, `新しい300件を表示中（保存は最大${MAX_LOG}件）`) : null,
  ];
}
function revertSheet(l) {
  const b = l.before;
  const t = S.tx.find((x) => x.id === l.ref);
  const desc = (x) => `${x.date} ／ ${x.type === 'income' ? '収入' : '支出'} ／ ${catOf(x.cat).name} ／ ${yen(x.amount)}${x.memo ? ' ／ ' + x.memo : ''}`;
  openSheet(() => [
    sheetHead('変更前に戻す'),
    h('div', { class: 'sheet-body' },
      h('p', null, h('b', null, '今：'), desc(t)),
      h('p', null, h('b', null, '変更前：'), desc(b)),
      h('div', { class: 'btn-row' }, btn('やめる', () => closeSheet(), 'btn'),
        btn('変更前に戻す', () => {
          closeSheet();
          updateTx(t.id, { type: b.type, amount: b.amount, cat: b.cat, date: b.date, memo: b.memo, pay: b.pay }, { verb: '変更前に戻しました' });
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
      S.tx = S.tx.filter((t) => !t.deleted);
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
      h('p', null, '全データを暗号化したファイルを作ります。「ファイル」アプリやiCloud Driveに保存してください。開くには今のパスコードが必要です。'),
      h('p', { class: 'help' }, S.settings.lastBackupAt ? `前回のバックアップ：${fmtDate(S.settings.lastBackupAt)}` : 'まだバックアップしていません'),
      btn('バックアップを保存', async () => {
        const { iv, ct } = await encryptJSON(KEY, S);
        const payload = { app: 'kakeibo-backup', v: 1, iter: META.iter, kind: META.kind, salt: b64e(META.salt), iv: b64e(iv), ct: b64e(ct), createdAt: Date.now() };
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const ok = await shareOrDownload(blob, `kakeibo-backup-${dateStr()}.json`);
        if (ok) {
          S.settings.lastBackupAt = Date.now();
          addLog('backup', 'backup', null, '暗号化バックアップを作成しました');
          save(); render(); toast('バックアップを作りました');
        }
      }, 'btn btn-primary')),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '📥 バックアップから復元'),
      h('p', null, '今のデータはバックアップの内容に置き換わります。'),
      h('label', { class: 'btn file-btn' }, 'ファイルを選ぶ', h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', onChange: (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFlow(f); } }))),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '📄 CSVで書き出す（Excel・Numbers用）'),
      h('p', { class: 'warn' }, '⚠️ CSVは暗号化されません。人に見られない場所に保存し、不要になったら消してください。'),
      btn('CSVを書き出す', async () => {
        const ok = await confirmSheet({ title: 'CSVを書き出す', body: ['暗号化されていないファイルになります。共有先に注意してください。'], ok: '書き出す' });
        if (!ok) return;
        const blob = new Blob([toCSV(S)], { type: 'text/csv;charset=utf-8' });
        if (await shareOrDownload(blob, `kakeibo-${dateStr()}.csv`)) {
          addLog('backup', 'backup', null, 'CSVを書き出しました（暗号化なし）');
          save();
        }
      }, 'btn')),
  ];
}
async function importFlow(file) {
  if (file.size > 20 * 1024 * 1024) { toast('ファイルが大きすぎます'); return; }
  let payload;
  try {
    payload = JSON.parse(await file.text());
    if (payload.app !== 'kakeibo-backup' || payload.v !== 1) throw new Error();
  } catch { toast('この家計簿のバックアップファイルではありません'); return; }
  let pass = '';
  let err = '';
  let busy = false;
  openSheet(() => {
    const input = h('input', { type: 'password', autocomplete: 'off', inputmode: payload.kind === 'pin' ? 'numeric' : 'text', value: pass, onInput: (e) => { pass = e.target.value; } });
    setTimeout(() => input.focus(), 50);
    return [
      sheetHead('バックアップから復元'),
      h('form', { class: 'sheet-body', onSubmit: async (e) => {
        e.preventDefault();
        if (busy || !pass) return;
        busy = true; err = ''; refreshSheet();
        let data;
        try {
          const key = await deriveKey(pass, b64d(payload.salt), Number(payload.iter) || PBKDF2_ITER);
          data = sanitizeState(await decryptJSON(key, { iv: b64d(payload.iv), ct: b64d(payload.ct) }));
        } catch { busy = false; err = 'パスコードが違うか、ファイルが壊れています'; refreshSheet(); return; }
        closeSheet();
        const ok = await confirmSheet({ title: '置き換えますか？', body: [`バックアップ（${fmtDate(payload.createdAt)}作成・記録${data.tx.filter((t) => !t.deleted).length}件）で、今のデータ（記録${liveTx(S).length}件）を置き換えます。`], ok: '置き換える', danger: true });
        if (!ok) return;
        const prev = S;
        S = data;
        addLog('import', 'backup', null, `バックアップ（${fmtDate(payload.createdAt)}作成）から復元しました`);
        save(); render();
        toast('復元しました', { label: '取り消す', fn: () => { S = prev; addLog('undo', 'backup', null, '復元を取り消しました'); save(); render(); } });
      } },
      h('label', { class: 'field' }, h('span', null, 'バックアップを作ったときのパスコード'), input),
      err ? h('p', { class: 'error', role: 'alert' }, err) : null,
      h('button', { type: 'submit', class: 'btn btn-primary', disabled: busy }, busy ? '確認中…' : '開く')),
    ];
  });
}

// ---- パスコード・自動ロック ----
function viewSecurity() {
  let cur = '', p1 = '', p2 = '', kind = META.kind, err = '', busy = false;
  const status = h('p', { class: 'status', 'aria-live': 'polite' });
  const errEl = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'card', onSubmit: async (e) => {
    e.preventDefault();
    if (busy) return;
    err = '';
    if (p1.length < 6) err = '新しいパスコードは6文字以上にしてください';
    else if (kind === 'pin' && !/^\d+$/.test(p1)) err = '数字だけで入力してください（英数字にする場合は下で切り替え）';
    else if (p1 !== p2) err = '新しいパスコードが2回で違います';
    errEl.textContent = err;
    if (err) return;
    busy = true; status.textContent = '確認中…';
    try {
      const curKey = await deriveKey(cur, META.salt, META.iter);
      await decryptJSON(curKey, await db.get('vault'));
    } catch { busy = false; status.textContent = ''; errEl.textContent = '今のパスコードが違います'; return; }
    status.textContent = '暗号化し直しています…';
    await saveChain;
    const salt = randomBytes(16);
    const key = await deriveKey(p1, salt, PBKDF2_ITER);
    addLog('security', 'security', null, 'パスコードを変更しました');
    const { iv, ct } = await encryptJSON(key, S);
    const meta = { ...META, salt, iter: PBKDF2_ITER, kind };
    await db.atomic({ meta, vault: { iv, ct, savedAt: Date.now() } }, ['vault_prev']);
    META = meta; KEY = key;
    render(); toast('パスコードを変更しました。古いバックアップは古いパスコードで開けます');
  } },
  h('h2', { class: 'card-title' }, 'パスコードを変える'),
  h('input', { type: 'text', name: 'username', autocomplete: 'username', value: '家計簿', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }),
  h('label', { class: 'field' }, h('span', null, '今のパスコード'), h('input', { type: 'password', autocomplete: 'current-password', inputmode: META.kind === 'pin' ? 'numeric' : 'text', onInput: (e) => { cur = e.target.value; } })),
  h('label', { class: 'field' }, h('span', null, '新しいパスコード（6文字以上）'), h('input', { type: 'password', id: 'np1', autocomplete: 'new-password', inputmode: kind === 'pin' ? 'numeric' : 'text', onInput: (e) => { p1 = e.target.value; } })),
  h('label', { class: 'field' }, h('span', null, 'もう一度'), h('input', { type: 'password', id: 'np2', autocomplete: 'new-password', inputmode: kind === 'pin' ? 'numeric' : 'text', onInput: (e) => { p2 = e.target.value; } })),
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: kind === 'text', onChange: (e) => {
    kind = e.target.checked ? 'text' : 'pin';
    form.querySelectorAll('#np1,#np2').forEach((i) => i.setAttribute('inputmode', kind === 'pin' ? 'numeric' : 'text'));
  } }), '英数字のパスコードにする'),
  errEl, status,
  h('button', { type: 'submit', class: 'btn btn-primary' }, '変更する'));

  return [
    subHead('パスコード・自動ロック'),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '自動ロックまでの時間'),
      h('p', { class: 'help' }, '操作しない時間、またはアプリを閉じてからこの時間がたつとロックします。'),
      h('div', { class: 'chip-row' }, [1, 3, 5, 10, 30].map((m) => h('button', { type: 'button', class: 'chip' + (S.settings.autoLockMin === m ? ' active' : ''), 'aria-pressed': S.settings.autoLockMin === m ? 'true' : 'false',
        onClick: () => { S.settings.autoLockMin = m; addLog('update', 'security', null, `自動ロックを${m}分に変更`); save(); resetIdle(); render(); } }, `${m}分`)))),
    form,
    h('section', { class: 'card' },
      h('p', { class: 'help' }, '💡 iPhoneの「パスワード」に保存しておくと、Face IDで入力できます（ロック画面で候補が出ます）。'),
      btn('🔒 今すぐロック', () => lock(), 'btn')),
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
    subHead('画面の明るさ'),
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
    ['🚫 総当たり対策', 'パスコードを5回間違えると、待ち時間が段々長くなります。間違いがあったことは次回お知らせします。'],
    ['🧱 外部ファイルを読み込まない', 'コンテンツセキュリティポリシーで、アプリ以外のスクリプトや通信を禁止しています。'],
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
  if (e.key === 'Escape' && sheetEl) { closeSheet(); return; }
  if (addState && addState.step === 1 && sheetEl && !e.target.matches('input,select,textarea')) {
    if (/^\d$/.test(e.key)) pressKey(e.key);
    else if (e.key === 'Backspace') pressKey('⌫');
    else if (e.key === 'Enter' && addState.amount) { addState.step = 2; refreshSheet(true); }
  }
});

boot();
