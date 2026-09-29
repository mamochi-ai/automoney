// ZeroInvoice 税計算エンジン（純粋関数・依存なし・ブラウザ/Node両対応）
// 金額はすべて「円」の整数で扱う。

/** @typedef {'floor'|'round'|'ceil'} Rounding */

export const ROUNDING_LABELS = { floor: '切り捨て', round: '四捨五入', ceil: '切り上げ' };

/** 円未満の端数処理（負数でも「絶対値に対して」処理する） */
export function roundYen(value, mode = 'floor') {
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  // 浮動小数点誤差対策: 1e-9 未満のズレは吸収
  const fix = (x) => Math.round(x * 1e6) / 1e6;
  let r;
  if (mode === 'ceil') r = Math.ceil(fix(abs));
  else if (mode === 'round') r = Math.round(fix(abs));
  else r = Math.floor(fix(abs));
  return sign * r || 0;
}

/**
 * 適格請求書の税額計算。端数処理は「1請求書・税率ごとに1回」（インボイス制度のルール）。
 * @param {Array<{qty:number, unitPrice:number, rate:10|8|0, reduced?:boolean}>} items
 *   rate: 10=標準税率, 8=軽減税率, 0=非課税/不課税
 * @param {{priceMode?:'exclusive'|'inclusive', rounding?:Rounding}} opts
 * @returns {{
 *   lines: number[],
 *   byRate: Record<string,{base:number, tax:number, total:number}>,
 *   subtotal:number, tax:number, total:number
 * }}
 *   subtotal = 税抜合計, total = 税込合計
 */
export function calcInvoice(items, opts = {}) {
  const priceMode = opts.priceMode ?? 'exclusive';
  const rounding = opts.rounding ?? 'floor';
  const lines = items.map((it) => roundYen((Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 'round'));
  const byRate = {};
  items.forEach((it, i) => {
    const key = String(it.rate ?? 10);
    byRate[key] ??= { sum: 0 };
    byRate[key].sum += lines[i];
  });
  let subtotal = 0, tax = 0, total = 0;
  const out = {};
  for (const [key, { sum }] of Object.entries(byRate)) {
    const rate = Number(key);
    let base, t;
    if (priceMode === 'inclusive') {
      t = roundYen((sum * rate) / (100 + rate), rounding);
      base = sum - t;
    } else {
      base = sum;
      t = roundYen((sum * rate) / 100, rounding);
    }
    out[key] = { base, tax: t, total: base + t };
    subtotal += base; tax += t; total += base + t;
  }
  return { lines, byRate: out, subtotal, tax, total };
}

/**
 * 源泉徴収税額（報酬・料金等。復興特別所得税込み）
 * 100万円以下: 10.21% / 100万円超の部分: 20.42%。1円未満切り捨て。
 * 消費税が区分記載されている場合は税抜金額を base に渡すこと。
 */
export function withholdingTax(base) {
  const b = Math.max(0, Math.floor(Number(base) || 0));
  if (b <= 1_000_000) return Math.floor((b * 1021) / 10000);
  return Math.floor(((b - 1_000_000) * 2042) / 10000) + 102_100;
}

/**
 * 手取り額から逆算して、源泉徴収前の報酬額（税抜）を求める。
 * 「手取りで○○円欲しい」フリーランス向け。
 */
export function grossFromNet(net) {
  const n = Math.max(0, Math.floor(Number(net) || 0));
  // 近似解から前後を探索して、手取り >= net となる最小の額面を返す
  let guess = n <= 1_000_000 - 102_100 ? Math.floor(n / (1 - 0.1021)) : Math.floor((n - 102_100) / (1 - 0.2042));
  guess = Math.max(0, guess - 5);
  while (guess > 0 && guess - 1 - withholdingTax(guess - 1) >= n) guess--;
  while (guess - withholdingTax(guess) < n) guess++;
  return guess;
}

// 印紙税額一覧（第17号の1文書: 売上代金に係る金銭の受取書）
const STAMP_17_1 = [
  [50_000, 0], // 5万円未満は非課税
  [1_000_000, 200],
  [2_000_000, 400],
  [3_000_000, 600],
  [5_000_000, 1_000],
  [10_000_000, 2_000],
  [20_000_000, 4_000],
  [30_000_000, 6_000],
  [50_000_000, 10_000],
  [100_000_000, 20_000],
  [200_000_000, 40_000],
  [300_000_000, 60_000],
  [500_000_000, 100_000],
  [1_000_000_000, 150_000],
];

/**
 * 領収書（売上代金の受取書）に必要な収入印紙額。
 * amount: 記載金額（消費税が区分記載されていれば税抜額）。
 * 5万円未満は非課税（上限は「未満」、以降の区分は「以下」）。
 */
export function receiptStampDuty(amount) {
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  if (a < 50_000) return 0;
  for (let i = 1; i < STAMP_17_1.length; i++) {
    if (a <= STAMP_17_1[i][0]) return STAMP_17_1[i][1];
  }
  return 200_000;
}

/**
 * 適格請求書発行事業者の登録番号（T + 13桁）の形式・チェックデジット検証。
 * @returns {{valid:boolean, reason?:string}}
 */
export function validateRegistrationNumber(input) {
  const s = String(input ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^T\d{13}$/.test(s)) return { valid: false, reason: '「T」+13桁の数字で入力してください' };
  const digits = s.slice(1);
  const check = Number(digits[0]);
  const body = digits.slice(1); // 12桁
  let sum = 0;
  for (let n = 1; n <= 12; n++) {
    const p = Number(body[12 - n]); // 下位から n 桁目
    sum += p * (n % 2 === 1 ? 1 : 2);
  }
  const expected = 9 - (sum % 9);
  if (expected !== check) return { valid: false, reason: 'チェックデジットが一致しません（番号の打ち間違いの可能性）' };
  return { valid: true };
}

/** 3桁カンマ区切り（円記号なし） */
export function formatYen(n) {
  return (Math.round(Number(n) || 0)).toLocaleString('ja-JP');
}

/**
 * 支払期日の計算（例: 月末締め翌月末払い）。
 * @param {Date} issueDate
 * @param {{monthsLater?:number, day?:number|'end'}} terms day='end' で月末
 */
export function dueDate(issueDate, { monthsLater = 1, day = 'end' } = {}) {
  const y = issueDate.getFullYear();
  const m = issueDate.getMonth() + monthsLater;
  const last = new Date(y, m + 1, 0).getDate();
  const d = day === 'end' ? last : Math.min(Number(day), last);
  return new Date(y, m, d);
}
