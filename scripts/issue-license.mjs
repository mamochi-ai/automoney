#!/usr/bin/env node
// ライセンスキーを手動発行する（招待・返金対応後の再発行・銀行振込など）。
//   node scripts/issue-license.mjs --email buyer@example.com --key <PKCS8 base64>
//   LICENSE_PRIVATE_KEY=<PKCS8 base64> node scripts/issue-license.mjs --email buyer@example.com
// オプション:
//   --email <addr>   payload.sub に入れる購入者メール（省略時は --sub 必須）
//   --sub <text>     メール以外の識別子を sub にしたい場合
//   --sid <text>     任意の参照ID（省略時は "manual:<email/sub>:<iat>" のハッシュ）
//   --iat <unix秒>   発行日時（省略時は現在時刻）
//   --pub <b64url>   発行後にこの公開鍵で検証する（任意。config.js の値を渡すと取り違え防止になる）
import { signLicense, buildPayload, shortHash } from '../worker/src/sign.js';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`--${name} に値がありません`);
    process.exit(2);
  }
  return v;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/issue-license.mjs --email <addr> [--key <PKCS8 base64>] [--sid x] [--iat unix] [--pub b64url]');
  process.exit(0);
}

const email = arg('email');
const sub = email || arg('sub');
const key = arg('key') || process.env.LICENSE_PRIVATE_KEY;
if (!sub) {
  console.error('エラー: --email（または --sub）を指定してください');
  process.exit(2);
}
if (email && !/^[^@\s]+@[^@\s]+$/.test(email)) {
  console.error('エラー: メールアドレスの形式が不正です');
  process.exit(2);
}
if (!key) {
  console.error('エラー: 秘密鍵を --key または環境変数 LICENSE_PRIVATE_KEY で指定してください（scripts/keygen.mjs の PKCS8 base64）');
  process.exit(2);
}

const iat = arg('iat') ? Number(arg('iat')) : Math.floor(Date.now() / 1000);
const sid = arg('sid') || (await shortHash(`manual:${sub}:${iat}`));
const payload = buildPayload({ sub, iat, sid });

let license;
try {
  license = await signLicense(payload, key);
} catch (e) {
  console.error('エラー: 署名に失敗しました（秘密鍵の形式を確認してください）:', e.message);
  process.exit(1);
}

const pub = arg('pub');
if (pub) {
  const { verifyLicense } = await import('../site/lib/license.js');
  const r = await verifyLicense(license, pub);
  if (!r.valid) {
    console.error('エラー: 指定した公開鍵で検証できません（鍵ペアの取り違え？）:', r.error);
    process.exit(1);
  }
  console.error('OK: 公開鍵での検証に成功');
}

console.error('payload:', JSON.stringify(payload));
console.log(license);
