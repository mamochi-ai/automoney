// ライセンスキー署名ヘルパー（Cloudflare Worker / Node 22 共通。依存なし、WebCrypto のみ）
//
// キー形式: ZI1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
// 署名対象: ASCII 文字列 "ZI1.<base64url(payload JSON)>"（プレフィックス込み）
// payload: { v:1, sub:<email or sid>, plan:'pro', iat:<unix秒>, sid:<session id の短いハッシュ> }
//
// Ed25519 署名は決定的なので、payload を決定的に作れば（iat = Checkout Session の created 等）
// 同じセッションから何度 claim しても同じキーが返る。

export const KEY_PREFIX = 'ZI1';

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto (crypto.subtle) is not available');
  return s;
};

export function b64uEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('invalid base64url');
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 標準 base64 / base64url どちらでも受け付ける */
export function anyB64Decode(str) {
  const clean = String(str).trim().replace(/\s+/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64uDecode(clean);
}

/** session id → 短いハッシュ（SHA-256 先頭12バイト、base64url 16文字） */
export async function shortHash(text) {
  const d = await subtle().digest('SHA-256', new TextEncoder().encode(String(text)));
  return b64uEncode(new Uint8Array(d).slice(0, 12));
}

/** PKCS8 (base64 / base64url) の Ed25519 秘密鍵を CryptoKey に */
export async function importPrivateKey(pkcs8B64) {
  if (!pkcs8B64) throw new Error('LICENSE_PRIVATE_KEY is not set');
  return subtle().importKey('pkcs8', anyB64Decode(pkcs8B64), { name: 'Ed25519' }, false, ['sign']);
}

/** payload を署名してライセンスキー文字列を返す。privateKey は CryptoKey または PKCS8 base64 文字列 */
export async function signLicense(payload, privateKey) {
  const key = typeof privateKey === 'string' ? await importPrivateKey(privateKey) : privateKey;
  const body = `${KEY_PREFIX}.${b64uEncode(new TextEncoder().encode(JSON.stringify(payload)))}`;
  const sig = await subtle().sign({ name: 'Ed25519' }, key, new TextEncoder().encode(body));
  return `${body}.${b64uEncode(new Uint8Array(sig))}`;
}

/** 標準的な payload を組み立てる（キー順固定 → 決定的） */
export function buildPayload({ sub, iat, sid, plan = 'pro' }) {
  return { v: 1, sub: String(sub), plan, iat: Math.floor(Number(iat)), sid: String(sid) };
}
