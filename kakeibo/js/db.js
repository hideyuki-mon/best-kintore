// IndexedDB ラッパー（端末内にのみ保存。サーバー送信は一切しない）
const DB_NAME = 'kakeibo';
const STORE = 'kv';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      db.onclose = () => { dbp = null; }; // iOS でバックグラウンド復帰後に切断されることがある
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

function runTx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    let failure = null;
    try {
      fn(s, (r) => { result = r; }, (err) => { failure = err; t.abort(); });
    } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(failure || t.error);
    t.onabort = () => reject(failure || t.error || new Error('transaction aborted'));
  }));
}

// 接続が切れていたら1回だけ張り直して再試行
async function tx(mode, fn) {
  try {
    return await runTx(mode, fn);
  } catch (e) {
    if (e && (e.name === 'InvalidStateError' || e.name === 'UnknownError')) {
      dbp = null;
      return runTx(mode, fn);
    }
    throw e;
  }
}

export function get(key) {
  return tx('readonly', (s, done) => {
    const r = s.get(key);
    r.onsuccess = () => done(r.result);
  });
}

export function put(key, value) {
  return tx('readwrite', (s) => { s.put(value, key); });
}

// 金庫の保存:
// - 保存済みの版番号(rev)が想定と違えば中止（別タブ・別画面での上書き事故を防ぐ）
// - 直前の版を vault_prev に退避してから書き込む（同一トランザクション）
export class ConflictError extends Error { constructor() { super('conflict'); this.name = 'ConflictError'; } }
export function putVault(value, expectedRev) {
  return tx('readwrite', (s, done, fail) => {
    const r = s.get('vault');
    r.onsuccess = () => {
      const cur = r.result;
      if (cur && (cur.rev || 0) !== expectedRev) { fail(new ConflictError()); return; }
      if (cur) s.put(cur, 'vault_prev');
      s.put(value, 'vault');
    };
  });
}

export function clearAll() {
  return tx('readwrite', (s) => { s.clear(); });
}

// 複数キーの書き込み・削除を1トランザクションで行う（パスコード変更など、途中で失敗すると困る処理用）
export function atomic(puts = {}, deletes = []) {
  return tx('readwrite', (s) => {
    for (const [k, v] of Object.entries(puts)) s.put(v, k);
    for (const k of deletes) s.delete(k);
  });
}
