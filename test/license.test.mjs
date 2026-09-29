import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { signLicense, buildPayload, b64uEncode, b64uDecode } from '../worker/src/sign.js';
import { handleRequest } from '../worker/src/index.js';
import {
  verifyLicense,
  activateLicense,
  getStoredLicense,
  isPro,
  clearLicense,
} from '../site/lib/license.js';

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pub: publicKey.export({ format: 'jwk' }).x,
    priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

const K = makeKeys();
const OTHER = makeKeys();
const payload = buildPayload({ sub: 'buyer@example.com', iat: 1760000000, sid: 'abc123' });

test('sign → verify roundtrip (WebCrypto)', async () => {
  const key = await signLicense(payload, K.priv);
  assert.match(key, /^ZI1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const r = await verifyLicense(key, K.pub);
  assert.equal(r.valid, true, r.error);
  assert.deepEqual(r.payload, payload);
});

test('sign → verify roundtrip (vendored noble fallback)', async () => {
  const key = await signLicense(payload, K.priv);
  const r = await verifyLicense(key, K.pub, { forceFallback: true });
  assert.equal(r.valid, true, r.error);
  const bad = await verifyLicense(key, OTHER.pub, { forceFallback: true });
  assert.equal(bad.valid, false);
});

test('signing is deterministic', async () => {
  assert.equal(await signLicense(payload, K.priv), await signLicense(payload, K.priv));
});

test('whitespace/newlines in pasted key are tolerated', async () => {
  const key = await signLicense(payload, K.priv);
  const messy = `  ${key.slice(0, 30)}\n${key.slice(30)}  `;
  assert.equal((await verifyLicense(messy, K.pub)).valid, true);
});

test('tampered payload fails', async () => {
  const key = await signLicense(payload, K.priv);
  const [p, , s] = key.split('.');
  const evil = b64uEncode(new TextEncoder().encode(JSON.stringify({ ...payload, sub: 'thief@example.com' })));
  const r = await verifyLicense(`${p}.${evil}.${s}`, K.pub);
  assert.equal(r.valid, false);
  assert.ok(r.error);
});

test('tampered signature fails', async () => {
  const key = await signLicense(payload, K.priv);
  const [p, b, s] = key.split('.');
  const sig = b64uDecode(s);
  sig[0] ^= 1;
  assert.equal((await verifyLicense(`${p}.${b}.${b64uEncode(sig)}`, K.pub)).valid, false);
});

test('wrong public key fails', async () => {
  const key = await signLicense(payload, K.priv);
  const r = await verifyLicense(key, OTHER.pub);
  assert.equal(r.valid, false);
  assert.match(r.error, /無効/);
});

test('wrong plan / version rejected even if validly signed', async () => {
  const key = await signLicense({ ...payload, plan: 'free' }, K.priv);
  assert.equal((await verifyLicense(key, K.pub)).valid, false);
  const key2 = await signLicense({ ...payload, v: 2 }, K.priv);
  assert.equal((await verifyLicense(key2, K.pub)).valid, false);
});

test('malformed keys fail with an error message', async () => {
  const cases = ['', null, undefined, 'hello', 'ZI1.abc', 'ZI2.a.b', 'ZI1..', 'ZI1.!!!.@@@', 'ZI1.eyJ2IjoxfQ.AAAA', 'ZI1.bm90anNvbg.' + 'A'.repeat(86)];
  for (const c of cases) {
    const r = await verifyLicense(c, K.pub);
    assert.equal(r.valid, false, String(c));
    assert.equal(typeof r.error, 'string');
  }
});

test('unconfigured public key gives a clear error', async () => {
  const key = await signLicense(payload, K.priv);
  const r = await verifyLicense(key, 'REPLACE_WITH_PUBLIC_KEY');
  assert.equal(r.valid, false);
  assert.match(r.error, /公開鍵/);
});

test('storage helpers are safe in Node without localStorage', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { value: undefined, configurable: true, writable: true });
    assert.equal(getStoredLicense(), null);
    assert.equal(await isPro(), false);
    clearLicense();
    // activateLicense uses CONFIG key (placeholder) → invalid, no throw
    const r = await activateLicense('garbage');
    assert.equal(r.ok, false);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
});

// ---------------- Worker ----------------

const ORIGIN = 'https://zero-invoice.example';
const ENV = {
  STRIPE_SECRET_KEY: 'rk_test_x',
  LICENSE_PRIVATE_KEY: K.priv,
  ALLOWED_ORIGIN: `${ORIGIN}, http://localhost:8080`,
  EXPECTED_AMOUNT: '1480',
};
const SID = 'cs_test_a1B2c3D4e5F6g7H8i9J0';

function stripeMock(session, status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(session), { status, headers: { 'Content-Type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

function req(path, origin = ORIGIN, method = 'GET') {
  return new Request(`https://w.example${path}`, { method, headers: origin ? { Origin: origin } : {} });
}

const paidSession = {
  id: SID,
  created: 1760000000,
  payment_status: 'paid',
  amount_total: 1480,
  customer_details: { email: 'buyer@example.com' },
};

test('worker: paid session → 200 with verifiable, deterministic key', async () => {
  const f = stripeMock(paidSession);
  const res = await handleRequest(req(`/claim?session_id=${SID}`), ENV, f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.email, 'buyer@example.com');
  const v = await verifyLicense(body.key, K.pub);
  assert.equal(v.valid, true, v.error);
  assert.equal(v.payload.sub, 'buyer@example.com');
  assert.equal(v.payload.iat, 1760000000);
  assert.equal(v.payload.plan, 'pro');
  assert.equal(typeof v.payload.sid, 'string');
  assert.ok(!v.payload.sid.includes(SID));

  // Stripe call shape
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.stripe.com/v1/checkout/sessions/${SID}`);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer rk_test_x');

  // re-claim returns identical key
  const res2 = await handleRequest(req(`/claim?session_id=${SID}`), ENV, stripeMock(paidSession));
  assert.equal((await res2.json()).key, body.key);
});

test('worker: session without email uses sid hash as sub', async () => {
  const s = { ...paidSession, customer_details: null };
  const res = await handleRequest(req(`/claim?session_id=${SID}`), ENV, stripeMock(s));
  const body = await res.json();
  const v = await verifyLicense(body.key, K.pub);
  assert.equal(v.payload.sub, `sid:${v.payload.sid}`);
  assert.equal(body.email, null);
});

test('worker: unpaid → 402', async () => {
  const res = await handleRequest(req(`/claim?session_id=${SID}`), ENV, stripeMock({ ...paidSession, payment_status: 'unpaid' }));
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, 'not_paid');
  assert.equal(body.key, undefined);
});

test('worker: amount mismatch → 402', async () => {
  const res = await handleRequest(req(`/claim?session_id=${SID}`), ENV, stripeMock({ ...paidSession, amount_total: 100 }));
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, 'amount_mismatch');
});

test('worker: payment link mismatch → 402 when EXPECTED_PAYMENT_LINK set', async () => {
  const env = { ...ENV, EXPECTED_PAYMENT_LINK: 'plink_good' };
  const bad = await handleRequest(req(`/claim?session_id=${SID}`), env, stripeMock({ ...paidSession, payment_link: 'plink_other' }));
  assert.equal(bad.status, 402);
  const ok = await handleRequest(req(`/claim?session_id=${SID}`), env, stripeMock({ ...paidSession, payment_link: 'plink_good' }));
  assert.equal(ok.status, 200);
});

test('worker: missing / invalid session_id → 400, Stripe not called', async () => {
  const f = stripeMock(paidSession);
  const r1 = await handleRequest(req('/claim'), ENV, f);
  assert.equal(r1.status, 400);
  assert.equal((await r1.json()).error, 'missing_session_id');
  const r2 = await handleRequest(req('/claim?session_id=../../v1/customers'), ENV, f);
  assert.equal(r2.status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(r1.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('worker: unknown session → 404; Stripe error → 502; misconfig → 500', async () => {
  const r404 = await handleRequest(req(`/claim?session_id=${SID}`), ENV, stripeMock({ error: {} }, 404));
  assert.equal(r404.status, 404);
  const r502 = await handleRequest(req(`/claim?session_id=${SID}`), ENV, stripeMock({ error: {} }, 500));
  assert.equal(r502.status, 502);
  const rThrow = await handleRequest(req(`/claim?session_id=${SID}`), ENV, async () => { throw new Error('net'); });
  assert.equal(rThrow.status, 502);
  const r500 = await handleRequest(req(`/claim?session_id=${SID}`), { ...ENV, LICENSE_PRIVATE_KEY: '' }, stripeMock(paidSession));
  assert.equal(r500.status, 500);
});

test('worker: CORS restricted to ALLOWED_ORIGIN', async () => {
  const evil = await handleRequest(req(`/claim?session_id=${SID}`, 'https://evil.example'), ENV, stripeMock(paidSession));
  assert.equal(evil.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(evil.headers.get('Vary'), 'Origin');

  const local = await handleRequest(req('/health', 'http://localhost:8080'), ENV, stripeMock(paidSession));
  assert.equal(local.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');

  const pre = await handleRequest(req('/claim', ORIGIN, 'OPTIONS'), ENV, stripeMock(paidSession));
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.match(pre.headers.get('Access-Control-Allow-Methods'), /GET/);

  const preEvil = await handleRequest(req('/claim', 'https://evil.example', 'OPTIONS'), ENV, stripeMock(paidSession));
  assert.equal(preEvil.headers.get('Access-Control-Allow-Origin'), null);
});

test('worker: /health, 404, 405', async () => {
  const h = await handleRequest(req('/health'), ENV, stripeMock(paidSession));
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  assert.equal((await handleRequest(req('/nope'), ENV)).status, 404);
  assert.equal((await handleRequest(req('/claim', ORIGIN, 'POST'), ENV)).status, 405);
});

test('activateLicense / isPro / clearLicense with in-memory localStorage', async () => {
  const mem = new Map();
  const fake = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true, writable: true });
  try {
    clearLicense();
    assert.equal(await isPro(K.pub), false);
    const key = await signLicense(payload, K.priv);

    const bad = await activateLicense(key, OTHER.pub);
    assert.equal(bad.ok, false);
    assert.equal(getStoredLicense(), null);

    const r = await activateLicense(key, K.pub);
    assert.deepEqual(r, { ok: true, email: 'buyer@example.com' });
    assert.equal(mem.get('zi.license'), key);
    assert.equal(getStoredLicense(), key);
    assert.equal(await isPro(K.pub), true);
    assert.equal(await isPro(OTHER.pub), false); // cache keyed by public key too

    // tampered stored value is re-verified
    const [pp, pb, ps] = key.split('.');
    const tsig = b64uDecode(ps);
    tsig[10] ^= 0xff;
    mem.set('zi.license', `${pp}.${pb}.${b64uEncode(tsig)}`);
    assert.equal(await isPro(K.pub), false);

    clearLicense();
    assert.equal(getStoredLicense(), null);
    assert.equal(await isPro(K.pub), false);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
});

test('localStorage accessor that throws is handled', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
  try {
    assert.equal(getStoredLicense(), null);
    clearLicense();
    const key = await signLicense(payload, K.priv);
    const r = await activateLicense(key, K.pub);
    assert.equal(r.ok, false);
    assert.match(r.error, /保存/);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
});
