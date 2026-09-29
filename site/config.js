// ここだけ書き換えればデプロイ可能。docs/SETUP.md 参照。
export const CONFIG = {
  productName: 'ゼロ請求書',
  siteUrl: 'https://example.com',            // 本番URL（sitemap/OGP用）
  priceJPY: 1480,                             // Pro 買い切り価格
  stripePaymentLink: 'https://buy.stripe.com/REPLACE_ME', // Stripe Payment Link
  licenseClaimEndpoint: 'https://zero-invoice-license.REPLACE_ME.workers.dev/claim',
  // scripts/keygen.mjs で生成した Ed25519 公開鍵 (base64url, raw 32bytes)
  licensePublicKey: 'REPLACE_WITH_PUBLIC_KEY',
  contactEmail: 'support@example.com',
};
