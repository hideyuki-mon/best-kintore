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
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(s, (r) => { result = r; })).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  }));
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

// 金庫の保存: 直前の版を vault_prev に退避してから書き込む（同一トランザクション）
export function putVault(value) {
  return tx('readwrite', (s) => {
    const r = s.get('vault');
    r.onsuccess = () => {
      if (r.result) s.put(r.result, 'vault_prev');
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
