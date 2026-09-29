// ゼロ請求書 ライセンス発行 Worker（Cloudflare Workers, module syntax, 依存なし）
//
//   GET /claim?session_id=cs_...  → Stripe Checkout Session を確認し、支払い済みなら署名済みライセンスキーを返す
//   GET /health                   → {ok:true}
//
// env (wrangler.toml [vars] / `wrangler secret put`):
//   STRIPE_SECRET_KEY    (secret) Stripe シークレットキー（制限付きキー推奨: Checkout Sessions 読み取りのみ）
//   LICENSE_PRIVATE_KEY  (secret) Ed25519 秘密鍵 PKCS8 base64（scripts/keygen.mjs で生成）
//   ALLOWED_ORIGIN       (var)    サイトのオリジン（例 https://zero-invoice.example）。カンマ区切りで複数可
//   EXPECTED_AMOUNT      (var,任意) 期待する amount_total（JPY なので円そのまま。例 "1480"）
//   EXPECTED_PAYMENT_LINK(var,任意) 期待する Payment Link ID（plink_...）

import { signLicense, buildPayload, shortHash } from './sign.js';

const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const list = allowedOrigins(env);
  const h = { Vary: 'Origin' };
  if (origin && (list.includes(origin) || list.includes('*'))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request, env),
    },
  });
}

async function fetchCheckoutSession(sessionId, env, fetchImpl) {
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
  return fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': '2024-06-20',
    },
  });
}

export async function handleClaim(request, env, fetchImpl) {
  const url = new URL(request.url);
  const sessionId = (url.searchParams.get('session_id') || '').trim();
  if (!sessionId) return json(request, env, 400, { error: 'missing_session_id', message: 'session_id がありません' });
  if (!SESSION_ID_RE.test(sessionId)) return json(request, env, 400, { error: 'invalid_session_id', message: 'session_id の形式が不正です' });
  if (!env.STRIPE_SECRET_KEY || !env.LICENSE_PRIVATE_KEY) {
    return json(request, env, 500, { error: 'server_misconfigured', message: 'サーバー設定が未完了です' });
  }

  let res;
  try {
    res = await fetchCheckoutSession(sessionId, env, fetchImpl);
  } catch {
    return json(request, env, 502, { error: 'stripe_unreachable', message: '決済サービスに接続できませんでした' });
  }
  if (res.status === 404) return json(request, env, 404, { error: 'session_not_found', message: '決済セッションが見つかりません' });
  if (!res.ok) return json(request, env, 502, { error: 'stripe_error', message: '決済情報の取得に失敗しました' });

  let session;
  try {
    session = await res.json();
  } catch {
    return json(request, env, 502, { error: 'stripe_bad_response', message: '決済情報の取得に失敗しました' });
  }

  if (session.payment_status !== 'paid') {
    return json(request, env, 402, { error: 'not_paid', message: 'お支払いが完了していません', payment_status: session.payment_status ?? null });
  }
  if (env.EXPECTED_AMOUNT && String(session.amount_total) !== String(env.EXPECTED_AMOUNT).trim()) {
    return json(request, env, 402, { error: 'amount_mismatch', message: '支払金額が一致しません' });
  }
  if (env.EXPECTED_PAYMENT_LINK && session.payment_link !== String(env.EXPECTED_PAYMENT_LINK).trim()) {
    return json(request, env, 402, { error: 'product_mismatch', message: '対象商品の決済ではありません' });
  }

  const sid = await shortHash(session.id || sessionId);
  const email = session.customer_details?.email || session.customer_email || null;
  const payload = buildPayload({
    sub: email || `sid:${sid}`,
    iat: Number(session.created) || 0, // 決定的: 再 claim でも同じキー
    sid,
  });
  let key;
  try {
    key = await signLicense(payload, env.LICENSE_PRIVATE_KEY);
  } catch {
    return json(request, env, 500, { error: 'sign_failed', message: 'ライセンスの発行に失敗しました' });
  }
  return json(request, env, 200, { ok: true, key, email });
}

/** fetchImpl はテスト用に差し替え可能 */
export async function handleRequest(request, env = {}, fetchImpl = (...args) => fetch(...args)) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(request, env, 405, { error: 'method_not_allowed' });
  }
  if (path === '/health') return json(request, env, 200, { ok: true });
  if (path === '/claim') return handleClaim(request, env, fetchImpl);
  return json(request, env, 404, { error: 'not_found' });
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
