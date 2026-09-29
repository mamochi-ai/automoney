// ゼロ請求書 Pro ライセンス検証（ブラウザ / Node 共通。トップレベルで DOM に触れない）
//
// キー形式: ZI1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
// 署名対象は "ZI1.<base64url(payload JSON)>"。発行側は worker/src/sign.js。
// 検証は WebCrypto Ed25519 を優先し、未対応ブラウザでは同梱の @noble/ed25519 にフォールバック。
import { CONFIG } from '../config.js';

const STORAGE_KEY = 'zi.license';
const PREFIX = 'ZI1';

function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]+$/.test(str)) throw new Error('invalid base64url');
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function normalizeKey(key) {
  return typeof key === 'string' ? key.replace(/\s+/g, '') : '';
}

let _webCryptoEd25519 = null; // null=未判定, true/false

async function ed25519Verify(pubBytes, sigBytes, msgBytes, forceFallback) {
  const subtle = globalThis.crypto?.subtle;
  if (!forceFallback && subtle && _webCryptoEd25519 !== false) {
    try {
      const k = await subtle.importKey('raw', pubBytes, { name: 'Ed25519' }, false, ['verify']);
      _webCryptoEd25519 = true;
      return await subtle.verify({ name: 'Ed25519' }, k, sigBytes, msgBytes);
    } catch (e) {
      if (_webCryptoEd25519 === true) throw e; // 対応済みなのに失敗 = 鍵不正など
      _webCryptoEd25519 = false; // 未対応 → フォールバック
    }
  }
  let noble;
  try {
    noble = await import('./vendor/noble-ed25519.js');
  } catch {
    throw new Error('unsupported');
  }
  if (!subtle) throw new Error('unsupported'); // noble の非同期 SHA-512 も crypto.subtle が必要
  return noble.verifyAsync(sigBytes, msgBytes, pubBytes, { zip215: false });
}

/**
 * @param {string} key
 * @param {string} [publicKeyB64u] テスト用に差し替え可能
 * @param {{forceFallback?: boolean}} [opts] テスト用: WebCrypto を使わず同梱実装で検証
 * @returns {Promise<{valid:boolean, payload?:object, error?:string}>}
 */
export async function verifyLicense(key, publicKeyB64u = CONFIG.licensePublicKey, opts = {}) {
  const k = normalizeKey(key);
  if (!k) return { valid: false, error: 'ライセンスキーが入力されていません。' };
  const parts = k.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    return { valid: false, error: 'ライセンスキーの形式が正しくありません（ZI1. で始まる文字列です）。' };
  }

  let pub, sig, payload;
  try {
    pub = b64uDecode(publicKeyB64u);
    if (pub.length !== 32) throw new Error();
  } catch {
    return { valid: false, error: 'サイトの公開鍵が設定されていません（管理者向け: config.js の licensePublicKey）。' };
  }
  try {
    sig = b64uDecode(parts[2]);
    if (sig.length !== 64) throw new Error();
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(parts[1])));
    if (!payload || typeof payload !== 'object') throw new Error();
  } catch {
    return { valid: false, error: 'ライセンスキーの形式が正しくありません。コピー漏れがないか確認してください。' };
  }

  let ok;
  try {
    ok = await ed25519Verify(pub, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`), opts.forceFallback);
  } catch (e) {
    if (e && e.message === 'unsupported') {
      return { valid: false, error: 'お使いのブラウザはライセンス検証に対応していません。最新版の Chrome / Edge / Firefox / Safari でお試しください。' };
    }
    return { valid: false, error: 'ライセンスキーを検証できませんでした。' };
  }
  if (!ok) return { valid: false, error: 'ライセンスキーが無効です（署名が一致しません）。' };
  if (payload.v !== 1 || payload.plan !== 'pro') {
    return { valid: false, error: 'このバージョンでは使えないライセンスキーです。' };
  }
  return { valid: true, payload };
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

let _cache = null; // { key, pub, result }

export function getStoredLicense() {
  try {
    const v = storage()?.getItem(STORAGE_KEY);
    return v || null;
  } catch {
    return null;
  }
}

/** 検証して localStorage に保存（publicKeyB64u はテスト用） */
export async function activateLicense(key, publicKeyB64u = CONFIG.licensePublicKey) {
  const k = normalizeKey(key);
  const r = await verifyLicense(k, publicKeyB64u);
  if (!r.valid) return { ok: false, error: r.error };
  try {
    const s = storage();
    if (!s) throw new Error();
    s.setItem(STORAGE_KEY, k);
  } catch {
    return { ok: false, error: 'ブラウザにライセンスを保存できませんでした（プライベートモードやストレージ制限をご確認ください）。' };
  }
  _cache = { key: k, pub: publicKeyB64u, result: true };
  const sub = String(r.payload.sub || '');
  return sub.includes('@') ? { ok: true, email: sub } : { ok: true };
}

/** 保存済みキーを検証（結果はメモリにキャッシュ。publicKeyB64u はテスト用） */
export async function isPro(publicKeyB64u = CONFIG.licensePublicKey) {
  const k = getStoredLicense();
  if (!k) return false;
  if (_cache && _cache.key === k && _cache.pub === publicKeyB64u) return _cache.result;
  const r = await verifyLicense(k, publicKeyB64u);
  _cache = { key: k, pub: publicKeyB64u, result: r.valid };
  return r.valid;
}

export function clearLicense() {
  _cache = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
