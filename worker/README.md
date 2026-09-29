# ライセンス発行 Worker（Cloudflare Workers）

Stripe Payment Link で支払った購入者に、Ed25519 署名済みのライセンスキーを自動発行します。
人手ゼロ・DB 不要。キーは Checkout Session ID から決定的に作られるため、同じ `session_id` で何度 claim しても同じキーが返ります。

## エンドポイント

| Method | Path | 説明 |
|---|---|---|
| GET | `/claim?session_id=cs_...` | 支払い確認 → `200 {ok, key, email}` |
| GET | `/health` | `200 {ok:true}` |
| OPTIONS | `*` | CORS プリフライト（`ALLOWED_ORIGIN` のみ許可） |

エラー: `400` session_id なし/形式不正、`402` 未払い・金額不一致・商品不一致、`404` セッションなし、`500` 設定不備、`502` Stripe エラー。
レスポンスは `{error, message}`（message は日本語）。

## 環境変数

| 名前 | 種別 | 必須 | 内容 |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | secret | ✓ | Stripe 制限付きキー `rk_live_...`（権限: **Checkout Sessions: Read** のみ）。`sk_live_...` でも動くが非推奨 |
| `LICENSE_PRIVATE_KEY` | secret | ✓ | `node scripts/keygen.mjs` の PRIVATE（PKCS8 DER の base64） |
| `ALLOWED_ORIGIN` | var | ✓ | サイトのオリジン（例 `https://zero-invoice.example`）。カンマ区切りで複数可 |
| `EXPECTED_AMOUNT` | var | – | `amount_total` の期待値（JPY は円、例 `1480`）。空なら確認しない |
| `EXPECTED_PAYMENT_LINK` | var | – | Payment Link ID `plink_...`。空なら確認しない（同じ Stripe アカウントで他商品を売る場合は設定推奨） |

## セットアップ手順

1. **鍵ペア生成**（リポジトリ直下で）
   ```sh
   node scripts/keygen.mjs
   ```
   - 1 つ目（PUBLIC, base64url）→ `site/config.js` の `licensePublicKey` に貼る
   - 2 つ目（PRIVATE, PKCS8 base64）→ 下の手順 4 で secret に登録。パスワードマネージャーにも保管（紛失すると手動発行できない）

2. **Stripe 制限付きキー作成**: Stripe ダッシュボード → 開発者 → API キー → 制限付きキーを作成 → 「Checkout Sessions」を **読み取り** にし、それ以外はなし。

3. **wrangler.toml を編集**: `ALLOWED_ORIGIN` を本番サイトのオリジンに、`EXPECTED_AMOUNT` を `CONFIG.priceJPY` と同じ値に。

4. **デプロイ**
   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put STRIPE_SECRET_KEY      # rk_live_... を貼る
   npx wrangler secret put LICENSE_PRIVATE_KEY    # keygen の PRIVATE を貼る
   npx wrangler deploy
   ```
   表示された URL（例 `https://zero-invoice-license.<account>.workers.dev`）+ `/claim` を
   `site/config.js` の `licenseClaimEndpoint` に設定。

5. **Stripe Payment Link の設定**: Payment Link の「支払い後」→「顧客をウェブサイトにリダイレクト」に
   ```
   https://<あなたのサイト>/thanks/?session_id={CHECKOUT_SESSION_ID}
   ```
   を設定（`{CHECKOUT_SESSION_ID}` は Stripe が置換するのでそのまま書く）。メールアドレス収集は既定で有効。

6. **動作確認**
   ```sh
   curl https://zero-invoice-license.<account>.workers.dev/health
   ```
   テストモードの Payment Link（`rk_test_...` キー）で一度購入し、`/thanks/` にキーが表示されることを確認してから本番キーに切り替える。

## 手動発行（銀行振込・招待・再発行）

```sh
LICENSE_PRIVATE_KEY=<PKCS8 base64> node scripts/issue-license.mjs --email buyer@example.com --pub <licensePublicKey>
```
出力された `ZI1.…` を購入者に送り、`https://<サイト>/thanks/` の「手動で有効化」欄に貼ってもらう（どのブラウザでも有効化できる）。

## 注意

- キーは署名で検証するため失効リストはありません（返金時のキー無効化は不可。買い切り低価格前提の割り切り）。
- 鍵をローテーションすると既存キーはすべて無効になります。
- ローカル開発: `npx wrangler dev` + `.dev.vars` ファイル（`STRIPE_SECRET_KEY=...` 等、コミットしない）。
