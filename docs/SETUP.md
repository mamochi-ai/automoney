# ゼロ請求書 公開セットアップ手順（所要 約30分）

このリポジトリは「静的サイト（`site/`）」＋「ライセンス発行 Worker（`worker/`）」だけで動きます。
サーバー・DB・メール送信は不要です。上から順番に進めてください。

## 0. 事前に用意するもの（5分）

- GitHub アカウント（このリポジトリを push 済み）
- Stripe アカウント（本人確認・銀行口座登録まで完了していること。未完了だと本番決済ができません）
- Cloudflare アカウント（無料プランで可。Worker 用。Cloudflare Pages を使う場合はサイト配信にも使用）
- Node.js 20 以上（`node -v` で確認）
- 独自ドメイン（任意。なくても `*.github.io` / `*.pages.dev` で公開可能）

以降、公開URLを **`{site}`** と書きます（例: `https://zero-invoice.example` 、末尾スラッシュなし）。

---

## 1. サイトを公開する（5分）

### A. GitHub Pages（推奨・設定済み）

`.github/workflows/pages.yml` が `main` への push ごとに `npm test` を実行し、`site/` を GitHub Pages にデプロイします。

1. GitHub のリポジトリ → **Settings → Pages** → Build and deployment の **Source** を **「GitHub Actions」** に変更。
2. `main` ブランチに push（または Actions タブ → 「Test & Deploy to GitHub Pages」→ **Run workflow**）。
3. 完了後、Settings → Pages に表示される URL が `{site}` です。
   - 独自ドメインを使う場合: Settings → Pages → **Custom domain** に入力し、DNS に CNAME を追加 → **Enforce HTTPS** をオン。
   - `https://<user>.github.io/<repo>/` のようなサブパスでも、サイト内リンクはすべて相対パスなので動作します。

### B. Cloudflare Pages（代替）

1. Cloudflare ダッシュボード → **Workers & Pages → Create → Pages → Connect to Git** でこのリポジトリを選択。
2. Framework preset: **None** / Build command: **空欄** / Build output directory: **`site`**。
3. デプロイ後の `https://<project>.pages.dev` が `{site}` です。
   ※ この場合 GitHub Pages 側の deploy は不要なので、Settings → Pages を無効のままにしておけば問題ありません。

---

## 2. ライセンス署名鍵を作る（2分）

リポジトリ直下で:

```sh
node scripts/keygen.mjs
```

- 1つ目の値（PUBLIC, base64url）→ 手順3で `site/config.js` の `licensePublicKey` に貼る
- 2つ目の値（PRIVATE, PKCS8 base64）→ 手順5で Worker の secret に登録
- **PRIVATE はパスワードマネージャーに保管し、絶対にコミットしない。** 紛失すると手動発行ができず、鍵を作り直すと発行済みキーがすべて無効になります。

---

## 3. `site/config.js` を埋める（3分）

```js
export const CONFIG = {
  productName: 'ゼロ請求書',
  siteUrl: 'https://zero-invoice.example',          // ← {site}
  priceJPY: 1480,                                    // ← Stripe の価格と必ず一致させる
  stripePaymentLink: 'https://buy.stripe.com/xxxx',  // ← 手順4で作成後に貼る
  licenseClaimEndpoint: 'https://zero-invoice-license.<account>.workers.dev/claim', // ← 手順5の後
  licensePublicKey: '<keygen の PUBLIC>',
  contactEmail: 'you@example.com',                   // ← 実際に受信できるアドレス
};
```

### OGP・canonical の URL を置き換える

`site/index.html` の `<link rel="canonical">`・`og:url`・`og:image`・`twitter:image`・JSON-LD の `url` は、SNS のクローラーが JavaScript を実行しないため HTML に直接 `https://example.com` と書かれています。まとめて置換してください:

```sh
# {site} を自分の URL に（macOS は sed -i '' ...）
grep -rl 'https://example.com' site | xargs sed -i 's#https://example.com#https://zero-invoice.example#g'
grep -rn 'example.com' site   # 残っていないか確認（support@example.com は config.js で上書きされる）
```

価格を 1480 円以外にする場合は、`site/index.html` の JSON-LD（`"price": "1480"`）も合わせて変更してください（画面表示の価格は `CONFIG.priceJPY` から自動で入ります）。

---

## 4. Stripe で商品と Payment Link を作る（7分）

まず **テストモード** で一通り作って動作確認し、最後に本番モードで同じ手順を繰り返すのが安全です。

1. Stripe ダッシュボード → **商品カタログ → 商品を追加**
   - 名前: `ゼロ請求書 Pro（買い切りライセンス）`
   - 価格: **1回限り** / `1480` / **JPY**（`CONFIG.priceJPY` と同じ）
2. **Payment Links → 新規作成** → 上の商品を選択。
   - 「数量の調整を許可」: オフ
   - **支払い後 → 「顧客をウェブサイトにリダイレクト」** を選び、次を入力（`{CHECKOUT_SESSION_ID}` は Stripe が置換するので**文字どおり**書く）:
     ```
     {site}/thanks/?session_id={CHECKOUT_SESSION_ID}
     ```
   - メールアドレスの収集は既定で有効のままでOK（領収書送付・問い合わせ照合に使用）。
3. 作成された `https://buy.stripe.com/...` を `CONFIG.stripePaymentLink` に貼る。
4. Payment Link の ID（`plink_...`、URL またはダッシュボードに表示）を控えておく（手順5の `EXPECTED_PAYMENT_LINK` 用・任意）。
5. **制限付き API キーを作成**: 開発者 → API キー → **制限付きキーを作成** → 「Checkout Sessions」を **読み取り** のみ、それ以外はなし → `rk_test_...` / `rk_live_...` を控える。

---

## 5. ライセンス Worker をデプロイ（5分）

1. `worker/wrangler.toml` の `[vars]` を編集:
   ```toml
   ALLOWED_ORIGIN = "https://zero-invoice.example"   # {site} のオリジン（パスなし・末尾スラッシュなし）
   EXPECTED_AMOUNT = "1480"                           # CONFIG.priceJPY と同じ
   EXPECTED_PAYMENT_LINK = "plink_..."                # 任意（同じ Stripe アカウントで他の商品も売るなら設定推奨）
   ```
   ※ `ALLOWED_ORIGIN` と `EXPECTED_AMOUNT` は秘密情報ではないので `[vars]` に書きます。`wrangler secret put` で登録しても動きますが、**同じ名前を `[vars]` と secret の両方に設定するとデプロイ時にエラー**になるので、どちらか一方にしてください。
2. デプロイ:
   ```sh
   cd worker
   npx wrangler login
   npx wrangler secret put STRIPE_SECRET_KEY     # 手順4-5 の rk_... を貼る
   npx wrangler secret put LICENSE_PRIVATE_KEY   # 手順2 の PRIVATE を貼る
   npx wrangler deploy
   ```
3. 表示された URL + `/claim` を `CONFIG.licenseClaimEndpoint` に設定。
4. 確認: `curl https://zero-invoice-license.<account>.workers.dev/health` → `{"ok":true}`

`site/config.js` を commit & push して、サイトを再デプロイします。

---

## 6. 購入フローの動作確認（3分）

1. テストモードの Payment Link で、カード番号 `4242 4242 4242 4242`（有効期限は未来の日付、CVC 任意）で購入。
2. `{site}/thanks/?session_id=cs_test_...` にリダイレクトされ、ライセンスキーが表示・有効化されることを確認。
3. `{site}/app/` で Pro 機能（保存無制限・表記なし・ロゴ/角印・CSV）が使えることを確認。
4. 問題なければ **本番モード** で手順4（商品・Payment Link・制限付きキー `rk_live_...`）をやり直し、
   `CONFIG.stripePaymentLink` と Worker の `STRIPE_SECRET_KEY` を本番の値に差し替えて再デプロイ。
   できれば本番で自分で1回購入 → Stripe から返金、まで確認すると安心です。

---

## 7. 特定商取引法に基づく表記・規約を埋める（5分）

- `site/legal/tokushoho/index.html` の **【要記入】** をすべて埋め、冒頭の「運営者向け」の枠を削除。
  - 個人で住所・電話番号を公開したくない場合は「請求があった場合には遅滞なく開示いたします」と記載できます（請求があれば実際に遅滞なく開示する必要があります）。
- `site/legal/terms/index.html`: 制定日、管轄裁判所の【要記入】。
- `site/legal/privacy/index.html`: 制定日、ホスティング事業者名。アクセス解析を入れる場合は第4節を書き換え（入れないなら枠を削除）。
- 未記入が残っていないか確認:
  ```sh
  grep -rn '要記入\|要確認' site/legal
  ```
- Stripe ダッシュボード → 設定 → **公開情報** のサポート用メール・URL、利用規約/特商法ページの URL も設定しておくと、決済画面に表示され信頼性が上がります。

---

## 8. Google Search Console にサイトマップを送信（3分）

1. `site/sitemap.xml` と `site/robots.txt` があるか確認。なければ作成（URL は `{site}` に置換）:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
     <url><loc>{site}/</loc></url>
     <url><loc>{site}/app/</loc></url>
     <url><loc>{site}/tools/</loc></url>
     <url><loc>{site}/tools/gensen/</loc></url>
     <url><loc>{site}/tools/tedori-gyakusan/</loc></url>
     <url><loc>{site}/tools/shohizei/</loc></url>
     <url><loc>{site}/tools/inshi/</loc></url>
     <url><loc>{site}/tools/touroku-bangou/</loc></url>
     <url><loc>{site}/tools/shiharai-kijitsu/</loc></url>
     <url><loc>{site}/legal/terms/</loc></url>
     <url><loc>{site}/legal/privacy/</loc></url>
     <url><loc>{site}/legal/tokushoho/</loc></url>
   </urlset>
   ```
   ```text
   # robots.txt
   User-agent: *
   Allow: /
   Sitemap: {site}/sitemap.xml
   ```
2. https://search.google.com/search-console → **プロパティを追加**
   - 独自ドメイン: 「ドメイン」を選び DNS の TXT レコードで確認
   - `github.io` / `pages.dev`: 「URL プレフィックス」を選び、HTML タグ（`<meta name="google-site-verification">`）を `site/index.html` の `<head>` に追加して push
3. 左メニュー **サイトマップ** → `sitemap.xml` を送信。
4. **URL 検査** でトップページと各ツールページの「インデックス登録をリクエスト」。
5. （任意）Bing Webmaster Tools でも Search Console からインポート可能。

---

## 公開前チェックリスト

**サイト**
- [ ] `{site}` でトップ・`/app/`・`/tools/`・`/legal/*` が表示される（HTTPS）
- [ ] `site/config.js` の `REPLACE_ME` / `REPLACE_WITH_PUBLIC_KEY` がすべて置き換わっている（`grep -rn REPLACE site/config.js` が空）
- [ ] `site/index.html` の `https://example.com` を置換済み
- [ ] `contactEmail` 宛のメールが実際に受信できる
- [ ] トップの「Proを購入する」ボタンが Stripe の決済画面に飛ぶ
- [ ] OGP 確認: X の投稿画面に URL を貼ってカード画像が出る（または Facebook シェアデバッガー）

**決済・ライセンス**
- [ ] Stripe の価格 = `CONFIG.priceJPY` = `EXPECTED_AMOUNT` = JSON-LD の price
- [ ] Payment Link のリダイレクト先が `{site}/thanks/?session_id={CHECKOUT_SESSION_ID}`
- [ ] Worker `/health` が `{"ok":true}`
- [ ] `ALLOWED_ORIGIN` が `{site}` のオリジンと完全一致（`https://`、末尾スラッシュなし）
- [ ] テストモードで購入 → キー発行 → Pro 有効化まで通った
- [ ] 本番モードの Payment Link と `rk_live_` キーに切り替えた
- [ ] 秘密鍵（PRIVATE）をパスワードマネージャーに保管し、リポジトリに含まれていない（`git grep -n MC4CAQAw` が空）

**法務**
- [ ] 特商法表記の【要記入】を埋め、運営者向けの枠を削除
- [ ] 利用規約・プライバシーポリシーの日付・【要記入】を更新
- [ ] アクセス解析を入れた場合、プライバシーポリシー第4節を更新

**集客**
- [ ] Search Console にサイトマップ送信・インデックス登録リクエスト
- [ ] `docs/LAUNCH.md` の 30日カレンダーを開始

## 困ったとき

| 症状 | 確認すること |
|---|---|
| /thanks/ で「CORS」エラー | `ALLOWED_ORIGIN` のスキーム・ホスト・末尾スラッシュ |
| 402（未払い・金額不一致） | Stripe の価格と `EXPECTED_AMOUNT`、`EXPECTED_PAYMENT_LINK` の ID |
| 500（設定不備） | `wrangler secret list` で 2 つの secret が登録されているか |
| キーが「署名が不正」 | `CONFIG.licensePublicKey` と Worker の PRIVATE が同じ keygen 実行のペアか |
| 購入者がキーを紛失 | 同じ `session_id` で `/thanks/` を開けば同じキーが再表示される。無理なら `scripts/issue-license.mjs` で手動発行（`worker/README.md` 参照） |
