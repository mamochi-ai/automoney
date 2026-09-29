#!/usr/bin/env node
// Ed25519 ライセンス署名鍵ペアを生成する。
//   node scripts/keygen.mjs
// 出力:
//   PUBLIC  … raw 32 バイトの base64url。site/config.js の CONFIG.licensePublicKey に貼る。
//   PRIVATE … PKCS8 (DER) の標準 base64。Worker の secret LICENSE_PRIVATE_KEY に設定する
//             (`cd worker && npx wrangler secret put LICENSE_PRIVATE_KEY`)。
//             scripts/issue-license.mjs の --key / 環境変数 LICENSE_PRIVATE_KEY にも同じ値を使う。
// 秘密鍵はリポジトリにコミットしないこと。パスワードマネージャー等に保管。
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const jwk = publicKey.export({ format: 'jwk' }); // jwk.x = raw 32 bytes base64url
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ publicKey: jwk.x, privateKeyPkcs8: pkcs8 }));
} else {
  console.log('# site/config.js → licensePublicKey (raw Ed25519, base64url):');
  console.log(jwk.x);
  console.log('');
  console.log('# Worker secret LICENSE_PRIVATE_KEY (PKCS8 DER, base64) — 絶対に公開しないこと:');
  console.log(pkcs8);
}
