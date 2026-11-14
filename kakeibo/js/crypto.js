// 暗号化ユーティリティ（Web Crypto API のみ使用・外部ライブラリなし）
// - 鍵導出: PBKDF2-SHA256（60万回）
// - 暗号化: AES-GCM 256bit（改ざん検知つき）
// - 鍵は extractable=false で生成し、メモリ上にのみ保持する
export const PBKDF2_ITER = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(passcode, salt, iterations = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(String(passcode).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// 用途ごとに追加認証データ(AAD)を分け、本体用の暗号文をバックアップとして（またはその逆に）流用できないようにする
const aad = (purpose) => enc.encode(`kakeibo|${purpose}|v1`);

export async function encryptJSON(key, obj, purpose = 'vault') {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(purpose) }, key, enc.encode(JSON.stringify(obj))
  );
  return { iv, ct: new Uint8Array(ct) };
}

// 失敗（パスコード違い・改ざん）の場合は例外を投げる
export async function decryptJSON(key, { iv, ct }, purpose = 'vault') {
  if (!iv || !ct) throw new Error('empty');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(purpose) }, key, ct);
  return JSON.parse(dec.decode(pt));
}

export function b64e(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

export function b64d(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
