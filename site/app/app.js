// ゼロ請求書 — 作成画面（依存なし・データはlocalStorageのみ）
import {
  calcInvoice, withholdingTax, validateRegistrationNumber, formatYen,
  dueDate, ROUNDING_LABELS, receiptStampDuty,
} from '../lib/tax.js';
import { CONFIG } from '../config.js';
import { isPro, activateLicense, getStoredLicense } from '../lib/license.js';

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------
const FREE_DOC_LIMIT = 5;
const KEY = {
  current: 'zi.current', docs: 'zi.docs', clients: 'zi.clients', items: 'zi.items',
  profile: 'zi.profile', counters: 'zi.counters', assets: 'zi.assets',
};
const TYPES = {
  invoice: { label: '請求書', prefix: 'INV', amountLabel: 'ご請求金額', lead: '下記のとおりご請求申し上げます。', dueLabel: 'お支払期限', editDueLabel: '支払期日', showDue: true, showBank: true, subjectLabel: '件名' },
  estimate: { label: '見積書', prefix: 'EST', amountLabel: '御見積金額', lead: '下記のとおりお見積り申し上げます。', dueLabel: '有効期限', editDueLabel: '有効期限', showDue: true, showBank: false, subjectLabel: '件名' },
  delivery: { label: '納品書', prefix: 'DN', amountLabel: '合計金額', lead: '下記のとおり納品いたしました。', showDue: false, showBank: false, subjectLabel: '件名' },
  receipt: { label: '領収書', prefix: 'RC', amountLabel: '領収金額', lead: '上記正に領収いたしました。', showDue: false, showBank: false, subjectLabel: '但し書き（○○代として）' },
};
const RATE_OPTIONS = [
  { value: '10', label: '10%' },
  { value: '8', label: '8%※軽減' },
  { value: '0', label: '0%非課税' },
];

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** DOM生成（テキストは必ず textContent 経由 = 自動エスケープ） */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const load = (key, fallback) => {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
};
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) {
    console.warn('保存に失敗しました', e);
    toast('ブラウザの保存容量が不足しています。不要な書類や画像を削除してください。');
    return false;
  }
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n, w = 2) => String(n).padStart(w, '0');
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};
const jaDate = (s) => { const d = parseISO(s); return d ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : ''; };
const today = () => toISO(new Date());
/** マイナスは「−」（U+2212）で表示 */
const signed = (n) => (Math.round(Number(n) || 0) < 0 ? `−${formatYen(-n)}` : formatYen(n));
const yen = (n) => (Math.round(Number(n) || 0) < 0 ? `−¥${formatYen(-n)}` : `¥${formatYen(n)}`);
/** 全角英数記号→半角 */
const toHalf = (s) => String(s ?? '').replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
/**
 * 金額・数量の文字列を数値に。全角数字・カンマ・¥/円・空白・各種マイナス記号（−－ー△▲）を許容。
 * 解釈できなければ NaN。
 */
function parseAmount(v) {
  if (typeof v === 'number') return v;
  let s = toHalf(v).replace(/[,，、\s円¥￥]/g, '').replace(/^[−ー‐–—△▲]/, '-');
  if (s === '') return NaN;
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
  return NaN;
}
const num = (v) => {
  const n = parseAmount(v);
  return Number.isFinite(n) ? n : 0;
};
/** 同日の翌月（末日は丸める） */
function addMonths(d, k) {
  const last = new Date(d.getFullYear(), d.getMonth() + k + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + k, Math.min(d.getDate(), last));
}
const isMonthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();
/** 1か月後（月末なら翌月末） */
const nextMonthISO = (iso) => {
  const d = parseISO(iso);
  if (!d) return iso || '';
  return toISO(isMonthEnd(d) ? new Date(d.getFullYear(), d.getMonth() + 2, 0) : addMonths(d, 1));
};

// ---------- 取引年月日・対象期間 ----------
/** 「2026年9月1日〜9月30日」（同年なら終了日の年を省略） */
function periodText(d) {
  const s = parseISO(d.periodStart);
  const e = parseISO(d.periodEnd);
  if (s && e && toISO(s) !== toISO(e)) {
    const endText = e.getFullYear() === s.getFullYear() ? `${e.getMonth() + 1}月${e.getDate()}日` : jaDate(d.periodEnd);
    return `${jaDate(d.periodStart)}〜${endText}`;
  }
  if (s) return jaDate(d.periodStart);
  if (e) return jaDate(d.periodEnd);
  return String(d.period || '').trim() || jaDate(d.issueDate);
}
const validYMD = (y, m, dd) => {
  const d = new Date(y, m - 1, dd);
  return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === dd ? d : null;
};
/**
 * 旧バージョンの自由入力（例: "09/01〜0930", "2026年9月1日〜9月30日", "2026年9月分"）を
 * 開始日・終了日に変換。解釈できなければ null（旧テキストをそのまま表示に使う）。
 */
function parseLegacyPeriod(text, issueISO) {
  const src = toHalf(text).replace(/\s+/g, '').replace(/(まで|分)$/, '');
  if (!src) return null;
  const baseYear = (parseISO(issueISO) || new Date()).getFullYear();
  const ym = /^(\d{4})年(\d{1,2})月$/.exec(src);
  if (ym) {
    const s = validYMD(Number(ym[1]), Number(ym[2]), 1);
    return s ? { start: toISO(s), end: toISO(new Date(s.getFullYear(), s.getMonth() + 1, 0)) } : null;
  }
  const parts = src.split(/〜|~|から|–|—/);
  if (parts.length > 2) return null;
  const one = (p, ctx) => {
    let m;
    if ((m = /^(\d{4})[年/.-](\d{1,2})[月/.-](\d{1,2})日?$/.exec(p))) return validYMD(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(p))) return validYMD(+m[1], +m[2], +m[3]);
    if ((m = /^(\d{1,2})[月/.](\d{1,2})日?$/.exec(p)) || (m = /^(\d{2})(\d{2})$/.exec(p))) {
      const y = ctx ? ctx.getFullYear() : baseYear;
      const d = validYMD(y, +m[1], +m[2]);
      return d && ctx && d < ctx ? validYMD(y + 1, +m[1], +m[2]) : d;
    }
    if (ctx && (m = /^(\d{1,2})日$/.exec(p))) return validYMD(ctx.getFullYear(), ctx.getMonth() + 1, +m[1]);
    return null;
  };
  const s = one(parts[0], null);
  if (!s) return null;
  if (parts.length === 1) return { start: toISO(s), end: '' };
  const e = one(parts[1], s);
  if (!e || e < s) return null;
  return { start: toISO(s), end: toISO(e) };
}

// ---------- 郵便番号 ----------
const PREFS = ['', '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'];
const zipDigits = (v) => toHalf(v).replace(/\D/g, '');
const formatZip = (v) => {
  const d = zipDigits(v);
  return d.length === 7 ? `${d.slice(0, 3)}-${d.slice(3)}` : toHalf(v).replace(/[^\d-]/g, '');
};
/** 金額欄：桁数に応じて文字サイズを下げ、枠からはみ出さないようにする */
function amountValue(text) {
  const size = text.length <= 9 ? 'l' : text.length <= 12 ? 'm' : text.length <= 15 ? 's' : 'xs';
  return h('div', { class: 'v', dataset: { size } }, h('span', { class: 'num' }, text), h('small', null, '（税込）'));
}
/** 旧データ：住所の先頭の「〒123-4567」（〒なしで郵便番号だけの行も）を郵便番号欄へ移す */
function migrateParty(p) {
  if (!p || typeof p !== 'object') return p;
  const out = { zip: '', ...p };
  if (!out.zip && typeof out.address === 'string') {
    const m = /^\s*〒\s*([0-9０-９]{3})\s*[-‐－−ー]?\s*([0-9０-９]{4})[ \t　]*(?:\r?\n)?/.exec(out.address)
      || /^\s*([0-9０-９]{3})\s*[-‐－−ー]?\s*([0-9０-９]{4})[ \t　]*(?:\r?\n|$)/.exec(out.address);
    if (m) {
      out.zip = formatZip(m[1] + m[2]);
      out.address = out.address.slice(m[0].length).replace(/^\s+/, '');
    }
  }
  return out;
}
const zipCache = new Map();
let zipQueue = Promise.resolve();
/**
 * yubinbango の公開データ（郵便番号上3桁ごとのJSONP）から住所を引く。
 * 送信されるのは上3桁を含むファイル名のみ。
 */
function lookupZip(zip) {
  const d = zipDigits(zip);
  if (d.length !== 7) return Promise.resolve(null);
  const prefix = d.slice(0, 3);
  const get = () => {
    if (zipCache.has(prefix)) return Promise.resolve(zipCache.get(prefix));
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const done = () => { clearTimeout(timer); s.remove(); };
      const timer = setTimeout(() => { done(); reject(new Error('timeout')); }, 8000);
      window.$yubin = (data) => { zipCache.set(prefix, data || {}); };
      s.src = `https://yubinbango.github.io/yubinbango-data/data/${prefix}.js`;
      s.async = true;
      s.onload = () => { done(); zipCache.has(prefix) ? resolve(zipCache.get(prefix)) : reject(new Error('no data')); };
      s.onerror = () => { done(); reject(new Error('load')); };
      document.head.append(s);
    });
  };
  // 同時に複数読み込むと $yubin が競合するので直列化
  const p = zipQueue.then(get);
  zipQueue = p.catch(() => {});
  return p.then((data) => {
    const r = data[d];
    if (!r) return null;
    return `${PREFS[Number(r[0])] || ''}${r[1] || ''}${r[2] || ''}${r[3] || ''}`;
  });
}

// ---------- 電話・メール ----------
const normalizePhone = (v) => toHalf(v).replace(/[ー−‐―–—]/g, '-').trim();
function phoneProblem(v) {
  const s = normalizePhone(v);
  if (!s) return '';
  if (/[^\d\-+() ]/.test(s)) return '電話番号に使えない文字が含まれています';
  const d = s.replace(/\D/g, '');
  if (s.startsWith('+')) return d.length >= 9 && d.length <= 15 ? '' : '電話番号の桁数を確認してください';
  if (!d.startsWith('0') || d.length < 10 || d.length > 11) return '電話番号の桁数を確認してください（市外局番から10〜11桁）';
  return '';
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/;
const emailProblem = (v) => (!String(v || '').trim() || EMAIL_RE.test(String(v).trim()) ? '' : 'メールアドレスの形式を確認してください');
const normalizeRegNo = (v) => {
  const s = toHalf(v).toUpperCase().replace(/[\s\-‐－−ー]/g, '');
  return /^\d{13}$/.test(s) ? `T${s}` : s;
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------
const store = {
  docs: load(KEY.docs, []),
  clients: load(KEY.clients, []),
  items: load(KEY.items, []),
  profile: load(KEY.profile, {}) || {},
  counters: load(KEY.counters, {}),
  assets: load(KEY.assets, {}),
};
if (store.profile.issuer) store.profile.issuer = migrateParty(store.profile.issuer);
let pro = false;
let doc;

const emptyItem = () => ({ name: '', qty: 1, unit: '式', unitPrice: 0, rate: '10' });

function seqOf(number) {
  const m = /(\d+)\s*$/.exec(String(number || ''));
  return m ? Number(m[1]) : 0;
}
function nextNumber(type) {
  const t = TYPES[type];
  let max = store.counters[type] || 0;
  for (const d of store.docs) if (d.type === type) max = Math.max(max, seqOf(d.number));
  return `${t.prefix}-${pad(max + 1, 4)}`;
}

function newDoc(type = 'invoice') {
  const p = store.profile;
  const issue = today();
  return {
    id: uid(),
    type,
    number: nextNumber(type),
    issueDate: issue,
    dueDate: TYPES[type].showDue ? toISO(type === 'estimate' ? addMonths(new Date(), 1) : dueDate(new Date(), { monthsLater: 1 })) : '',
    duePreset: type === 'estimate' ? '' : 'm1',
    subject: '',
    period: '', // 旧バージョンの自由入力（解釈できなかったものだけ表示用に残す）
    periodStart: '',
    periodEnd: '',
    client: { name: '', honorific: '御中', zip: '', address: '' },
    issuer: { name: '', zip: '', address: '', regNo: '', phone: '', email: '', bank: '', ...(p.issuer || {}) },
    items: [emptyItem()],
    priceMode: p.priceMode || 'exclusive',
    rounding: p.rounding || 'floor',
    withholding: !!p.withholding,
    notes: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function normalizeDoc(d) {
  const base = newDoc(TYPES[d?.type] ? d.type : 'invoice');
  const out = { ...base, ...d };
  // 旧データ（郵便番号欄なし）は書類自身の住所から分離する（プロフィールの郵便番号と混ざらないように先に移行）
  out.client = { ...base.client, ...(d?.client ? migrateParty(d.client) : {}) };
  out.issuer = { ...base.issuer, ...(d?.issuer ? migrateParty(d.issuer) : {}) };
  out.period = typeof out.period === 'string' ? out.period : '';
  out.periodStart = out.periodStart || '';
  out.periodEnd = out.periodEnd || '';
  if (!out.periodStart && !out.periodEnd && out.period.trim()) {
    const r = parseLegacyPeriod(out.period, out.issueDate);
    if (r) { out.periodStart = r.start; out.periodEnd = r.end; out.period = ''; }
  }
  out.items = Array.isArray(d?.items) && d.items.length ? d.items.map((it) => ({ ...emptyItem(), ...it, rate: String(it.rate ?? '10') })) : [emptyItem()];
  return out;
}

const isSaved = (id) => store.docs.some((d) => d.id === id);

function calc(d = doc) {
  const items = d.items.map((it) => ({ qty: num(it.qty), unitPrice: num(it.unitPrice), rate: Number(it.rate) }));
  const r = calcInvoice(items, { priceMode: d.priceMode, rounding: d.rounding });
  const wh = d.withholding ? withholdingTax(r.subtotal) : 0;
  return { ...r, withholding: wh, billed: r.total - wh, stamp: d.type === 'receipt' ? receiptStampDuty(r.subtotal) : 0 };
}

// ---------------------------------------------------------------------------
// 永続化
// ---------------------------------------------------------------------------
let saveTimer;
function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autosave, 350);
}
function autosave() {
  clearTimeout(saveTimer);
  doc.updatedAt = Date.now();
  save(KEY.current, doc);
  const i = store.docs.findIndex((d) => d.id === doc.id);
  if (i >= 0) {
    store.docs[i] = structuredClone(doc);
    save(KEY.docs, store.docs);
  }
  updateStatus();
}
function updateStatus() {
  const saved = isSaved(doc.id);
  $('#saveStatus').textContent = saved ? '保存済み — 変更は自動で反映されます' : '下書きを自動保存しています（一覧には未保存）';
  $('#btnSave').textContent = saved ? '保存済み' : '保存';
  $('#docCount').textContent = store.docs.length ? String(store.docs.length) : '';
}
function commitCounter(d) {
  store.counters[d.type] = Math.max(store.counters[d.type] || 0, seqOf(d.number));
  save(KEY.counters, store.counters);
}

function saveToList() {
  if (isSaved(doc.id)) { autosave(); toast('保存しました'); return; }
  if (!pro && store.docs.length >= FREE_DOC_LIMIT) {
    openPro(`無料版で保存できる書類は${FREE_DOC_LIMIT}件までです。不要な書類を削除するか、Pro版で無制限に保存できます。`);
    return;
  }
  doc.updatedAt = Date.now();
  store.docs.unshift(structuredClone(doc));
  if (!save(KEY.docs, store.docs)) { store.docs.shift(); return; }
  commitCounter(doc);
  save(KEY.current, doc);
  updateStatus();
  toast(`${TYPES[doc.type].label}を保存しました`);
}

function setDoc(d) {
  doc = normalizeDoc(d);
  save(KEY.current, doc);
  fillForm();
  renderItemsEditor();
  render();
  updateStatus();
}

// ---------------------------------------------------------------------------
// フォーム
// ---------------------------------------------------------------------------
const form = $('#editor');
const getPath = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, path, v) {
  const ks = path.split('.');
  let cur = o;
  for (let i = 0; i < ks.length - 1; i++) cur = cur[ks[i]] ??= {};
  cur[ks.at(-1)] = v;
}

function fillForm() {
  for (const el of $$('[name]', form)) {
    const v = getPath(doc, el.name);
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v ?? '';
  }
  applyTypeUI();
  updateRegNoMsg();
  updateContactMsgs(false);
  for (const z of $$('input.zip')) setZipMsg(z, '');
  markDuePreset();
  updatePeriodUI();
}

function applyTypeUI() {
  const t = TYPES[doc.type];
  for (const b of $$('.doctype button')) b.setAttribute('aria-pressed', String(b.dataset.type === doc.type));
  $('#dueField').hidden = !t.showDue;
  $('#lbl-due').textContent = t.editDueLabel || '支払期日';
  $('#bankField').hidden = !t.showBank;
  $('#lbl-subject').textContent = t.subjectLabel;
  $('#f-subject').placeholder = doc.type === 'receipt' ? '例: Webサイト制作費' : '例: 2026年9月分 Webサイト保守';
  document.title = `${t.label}作成 | ゼロ請求書 — インボイス対応・登録不要・無料`;
}

function setHint(el, input, cls, text) {
  el.className = cls ? `hint ${cls}` : 'hint';
  el.textContent = text;
  input?.classList.toggle('bad', cls === 'bad');
}

function updateRegNoMsg() {
  const el = $('#regNoMsg');
  const input = $('#f-regNo');
  const v = normalizeRegNo(doc.issuer.regNo || '');
  if (!v) {
    setHint(el, input, '', '適格請求書（インボイス）には登録番号の記載が必要です。未登録（免税事業者）の場合は空欄のままで構いません。');
    return;
  }
  const r = validateRegistrationNumber(v);
  if (r.valid) {
    setHint(el, input, 'ok', '✓ 登録番号の形式・チェックデジットはOKです');
  } else {
    const digits = v.replace(/^T/, '');
    const extra = /^\d+$/.test(digits) && digits.length !== 13 ? `（数字が${digits.length}桁です）` : '';
    setHint(el, input, 'bad', `⚠ ${r.reason}${extra}`);
  }
}

/** 電話・メールの形式チェック（保存は妨げない）。strict=false のときは「直したら消す」だけ */
function updateContactMsgs(strict = true) {
  for (const [id, msgId, fn] of [['#f-phone', '#phoneMsg', phoneProblem], ['#f-email', '#emailMsg', emailProblem]]) {
    const input = $(id);
    const msg = $(msgId);
    const problem = fn(input.value);
    if (!problem) setHint(msg, input, '', '');
    else if (strict || input.classList.contains('bad')) setHint(msg, input, 'bad', `⚠ ${problem}`);
  }
}

// ---------- 取引年月日 ----------
function updatePeriodUI() {
  const msg = $('#periodMsg');
  const s = doc.periodStart;
  const e = doc.periodEnd;
  const legacy = String(doc.period || '').trim();
  for (const c of $$('[data-period]')) c.classList.remove('on');
  if (s && e && e < s) {
    setHint(msg, $('#f-periodEnd'), 'bad', '⚠ 終了日が開始日より前になっています');
    return;
  }
  $('#f-periodEnd').classList.remove('bad');
  if (!s && !e && legacy) {
    setHint(msg, null, '', `以前の入力「${legacy}」をそのまま表示しています。日付を選ぶと置き換わります。`);
    return;
  }
  const shown = periodText(doc);
  setHint(msg, null, '', s || e ? `書類の表示：${shown}` : `空欄の場合は発行日（${shown || '未入力'}）を表示します。終了日を入れると期間になります。`);
  const preset = periodPreset(doc.issueDate);
  for (const c of $$('[data-period]')) {
    const p = preset[c.dataset.period];
    c.classList.toggle('on', !!p && !!p.start && p.start === s && p.end === e);
  }
}
function periodPreset(issueISO) {
  const d = parseISO(issueISO) || new Date();
  const y = d.getFullYear(), m = d.getMonth();
  return {
    this: { start: toISO(new Date(y, m, 1)), end: toISO(new Date(y, m + 1, 0)) },
    last: { start: toISO(new Date(y, m - 1, 1)), end: toISO(new Date(y, m, 0)) },
    issue: { start: toISO(d), end: '' },
    clear: { start: '', end: '' },
  };
}
for (const c of $$('[data-period]')) {
  c.addEventListener('click', () => {
    const p = periodPreset(doc.issueDate)[c.dataset.period];
    doc.periodStart = p.start;
    doc.periodEnd = p.end;
    if (p.start) doc.period = '';
    $('#f-periodStart').value = p.start;
    $('#f-periodEnd').value = p.end;
    updatePeriodUI();
    render();
    scheduleAutosave();
  });
}

function markDuePreset() {
  for (const c of $$('[data-due]')) c.classList.toggle('on', c.dataset.due === doc.duePreset);
}
function computeDue(preset, issueISO) {
  const d = parseISO(issueISO) || new Date();
  if (preset === 'm1') return toISO(dueDate(d, { monthsLater: 1, day: 'end' }));
  if (preset === 'm2') return toISO(dueDate(d, { monthsLater: 2, day: 'end' }));
  if (preset === 'd30') return toISO(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 30));
  return null;
}

function saveIssuerProfile() {
  store.profile.issuer = { ...doc.issuer };
  save(KEY.profile, store.profile);
}

// ---------- 郵便番号 → 住所 ----------
const zipAuto = new Map(); // 住所欄id → 直前に自動入力した住所
const zipLast = new Map(); // 郵便番号欄id → 直前に検索した7桁
function setZipMsg(input, text, cls = '') {
  const msg = document.getElementById(input.dataset.zipMsg);
  if (msg) setHint(msg, null, cls, text);
}
function onZipInput(el) {
  const raw = el.value;
  const d = zipDigits(raw);
  // 全角・ハイフンなしでも 123-4567 に整形
  const shown = d.length === 7 ? formatZip(raw) : toHalf(raw).replace(/[^\d-]/g, '');
  if (shown !== raw) el.value = shown;
  setPath(doc, el.name, el.value);
  if (d.length !== 7) {
    zipLast.delete(el.id);
    setZipMsg(el, d.length > 7 ? '⚠ 郵便番号は7桁です' : '', d.length > 7 ? 'bad' : '');
    return;
  }
  if (zipLast.get(el.id) === d) return;
  zipLast.set(el.id, d);
  setZipMsg(el, '住所を検索しています…');
  lookupZip(d).then((addr) => {
    if (zipDigits(el.value) !== d) return; // 検索中に変更された
    if (!addr) { setZipMsg(el, '該当する住所が見つかりませんでした（手入力してください）'); return; }
    const target = document.getElementById(el.dataset.zipFor);
    const cur = target.value.trim();
    if (!cur || cur === zipAuto.get(target.id)) {
      target.value = addr;
      zipAuto.set(target.id, addr);
      setPath(doc, target.name, addr);
      if (target.name.startsWith('issuer.')) saveIssuerProfile();
      setZipMsg(el, '住所を自動入力しました（番地を追記してください）', 'ok');
      render();
      scheduleAutosave();
    } else if (!cur.startsWith(addr)) {
      setZipMsg(el, `この郵便番号の住所：${addr}（入力済みの住所は変更していません）`);
    } else {
      setZipMsg(el, '');
    }
  }).catch(() => {
    zipLast.delete(el.id);
    setZipMsg(el, '住所を自動取得できませんでした（手入力してください）');
  });
}

form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('input', (e) => {
  const el = e.target;
  if (el.closest('#items')) return onItemInput(e);
  if (!el.name) return;
  const prevIssue = doc.issueDate;
  if (el.classList.contains('zip')) onZipInput(el);
  else setPath(doc, el.name, el.type === 'checkbox' ? el.checked : el.value);
  const v = getPath(doc, el.name);
  if (el.name.startsWith('issuer.')) {
    saveIssuerProfile();
    if (el.name === 'issuer.regNo') updateRegNoMsg();
    if (el.name === 'issuer.phone' || el.name === 'issuer.email') updateContactMsgs(false);
  }
  if (['priceMode', 'rounding', 'withholding'].includes(el.name)) {
    store.profile[el.name] = v;
    save(KEY.profile, store.profile);
    if (el.name === 'priceMode') renderItemsEditor();
  }
  if (el.name === 'issueDate') {
    if (doc.duePreset) {
      const due = computeDue(doc.duePreset, doc.issueDate);
      if (due) { doc.dueDate = due; $('#f-dueDate').value = due; }
    }
    // 「発行日と同じ」にしていた取引年月日は発行日に追従
    if (prevIssue && doc.periodStart === prevIssue && !doc.periodEnd && doc.issueDate) {
      doc.periodStart = doc.issueDate;
      $('#f-periodStart').value = doc.issueDate;
    }
    updatePeriodUI();
  }
  if (el.name === 'periodStart' || el.name === 'periodEnd') {
    if (doc.periodStart || doc.periodEnd) doc.period = '';
    updatePeriodUI();
  }
  if (el.name === 'dueDate') { doc.duePreset = ''; markDuePreset(); }
  render();
  scheduleAutosave();
});
// 入力確定時の正規化（全角→半角など）
function normalizeField(el, fn) {
  el.addEventListener('change', () => {
    const v = fn(el.value);
    if (v !== el.value) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  });
}
normalizeField($('#f-regNo'), normalizeRegNo);
normalizeField($('#f-phone'), normalizePhone);
normalizeField($('#f-email'), (v) => toHalf(v).replace(/\s/g, ''));
normalizeField($('#f-number'), (v) => toHalf(v).trim());
for (const id of ['#f-phone', '#f-email']) $(id).addEventListener('change', () => updateContactMsgs(true));

// Enter（iPadの「次へ」）で次の入力欄へ。IME変換中は何もしない
form.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  const el = e.target;
  if (el.tagName !== 'INPUT' || ['checkbox', 'button', 'file'].includes(el.type)) return;
  e.preventDefault();
  const fields = $$('input:not([type=checkbox]):not([type=file]):not([hidden]),select,textarea', form)
    .filter((x) => !x.disabled && x.offsetParent !== null);
  const next = fields[fields.indexOf(el) + 1];
  if (next) next.focus(); else el.blur();
});

for (const c of $$('[data-due]')) {
  c.addEventListener('click', () => {
    doc.duePreset = c.dataset.due;
    doc.dueDate = computeDue(c.dataset.due, doc.issueDate);
    $('#f-dueDate').value = doc.dueDate;
    markDuePreset();
    render();
    scheduleAutosave();
  });
}

for (const b of $$('.doctype button')) {
  b.addEventListener('click', () => {
    const type = b.dataset.type;
    if (type === doc.type) return;
    const prev = doc.type;
    doc.type = type;
    // 番号が自動採番のままなら、新しい種類の番号に振り直す
    if (!doc.number || doc.number.startsWith(`${TYPES[prev].prefix}-`)) doc.number = nextNumber(type);
    if (TYPES[type].showDue && !doc.dueDate) {
      doc.duePreset = 'm1';
      doc.dueDate = computeDue('m1', doc.issueDate);
    }
    fillForm();
    render();
    scheduleAutosave();
  });
}

// ---------------------------------------------------------------------------
// 明細エディタ
// ---------------------------------------------------------------------------
function formatQty(q) {
  const n = parseAmount(q);
  if (!Number.isFinite(n)) return String(q ?? '');
  const s = Math.abs(n).toLocaleString('ja-JP', { maximumFractionDigits: 3 });
  return n < 0 ? `−${s}` : s;
}
/** 入力欄の表示用（空欄・解釈できない入力はそのまま） */
function amountDisplay(v, kind) {
  if (v === '' || v == null) return '';
  const n = parseAmount(v);
  if (!Number.isFinite(n)) return String(v);
  return kind === 'qty' ? formatQty(n) : signed(n);
}
/** 編集用（カンマなし・半角） */
function amountRaw(v) {
  const n = parseAmount(v);
  return Number.isFinite(n) ? String(n) : String(v ?? '');
}

function renderItemsEditor() {
  const box = $('#items');
  const c = calc();
  const priceLabel = doc.priceMode === 'inclusive' ? '単価（税込）' : '単価（税抜）';
  box.replaceChildren(...doc.items.map((it, i) => {
    const id = (k) => `it-${i}-${k}`;
    return h('div', { class: 'item' + (num(it.unitPrice) < 0 ? ' discount' : ''), dataset: { i } },
      h('div', { class: 'item-top' },
        h('span', { class: 'item-no', 'aria-hidden': 'true' }, i + 1),
        h('input', { id: id('name'), 'aria-label': `${i + 1}行目 品目`, placeholder: '品目・内容', value: it.name, list: 'itemMaster', enterkeyhint: 'next', dataset: { k: 'name' } })),
      h('div', { class: 'item-grid' },
        h('div', null, h('label', { for: id('qty') }, '数量'), h('input', { id: id('qty'), type: 'text', class: 'num amt', inputmode: 'decimal', enterkeyhint: 'next', autocomplete: 'off', value: amountDisplay(it.qty, 'qty'), dataset: { k: 'qty' } })),
        h('div', null, h('label', { for: id('unit') }, '単位'), h('input', { id: id('unit'), value: it.unit, placeholder: '式', enterkeyhint: 'next', dataset: { k: 'unit' } })),
        h('div', null, h('label', { for: id('price') }, priceLabel), h('input', { id: id('price'), type: 'text', class: 'num amt', inputmode: 'numeric', enterkeyhint: 'next', autocomplete: 'off', placeholder: '0', value: amountDisplay(it.unitPrice, 'price'), dataset: { k: 'unitPrice' } })),
        h('div', null, h('label', { for: id('rate') }, '税率'),
          h('select', { id: id('rate'), dataset: { k: 'rate' } },
            RATE_OPTIONS.map((o) => h('option', { value: o.value, selected: String(it.rate) === o.value }, o.label))))),
      h('div', { class: 'item-foot' },
        h('span', { class: 'item-amt', dataset: { amt: i } }, `金額 ${yen(c.lines[i])}`),
        h('div', { class: 'item-btns' },
          h('button', { type: 'button', class: 'ibtn', title: '単価の符号を反転（値引き ⇄ 通常）', 'aria-label': `${i + 1}行目の単価の符号を反転`, onclick: () => flipSign(i) }, '±'),
          h('button', { type: 'button', class: 'ibtn', title: '上へ', 'aria-label': `${i + 1}行目を上へ`, disabled: i === 0, onclick: () => moveItem(i, -1) }, '↑'),
          h('button', { type: 'button', class: 'ibtn', title: '下へ', 'aria-label': `${i + 1}行目を下へ`, disabled: i === doc.items.length - 1, onclick: () => moveItem(i, 1) }, '↓'),
          h('button', { type: 'button', class: 'ibtn', title: '品目マスタに登録', onclick: () => saveItemMaster(i) }, '登録'),
          h('button', { type: 'button', class: 'ibtn del', title: '削除', 'aria-label': `${i + 1}行目を削除`, onclick: () => removeItem(i) }, '×'))));
  }));
}

function onItemInput(e) {
  const el = e.target;
  const row = el.closest('.item');
  if (!row || !el.dataset.k) return;
  const i = Number(row.dataset.i);
  doc.items[i][el.dataset.k] = el.value;
  if (el.classList.contains('amt')) {
    el.classList.toggle('bad', el.value.trim() !== '' && !Number.isFinite(parseAmount(el.value)) && !/^[−ー‐–—△▲-]$/.test(el.value.trim()));
    row.classList.toggle('discount', num(doc.items[i].unitPrice) < 0);
  }
  if (el.dataset.k === 'name') {
    const m = store.items.find((x) => x.name === el.value);
    if (m && e.inputType !== 'insertText' && e.inputType !== 'deleteContentBackward') {
      Object.assign(doc.items[i], { unit: m.unit, unitPrice: m.unitPrice, rate: String(m.rate) });
      renderItemsEditor();
      $(`#it-${i}-qty`)?.focus();
    }
  }
  updateLineAmounts();
  render();
  scheduleAutosave();
}
// 数量・単価：フォーカスでカンマを外して全選択（上書きしやすく）、確定でカンマ付きに整形
$('#items').addEventListener('focusin', (e) => {
  const el = e.target;
  if (!el.classList?.contains('amt')) return;
  const raw = amountRaw(el.value);
  if (raw !== el.value) el.value = raw;
  // iOS Safari はフォーカス直後の選択が解除されるため遅延させる
  try { el.select(); } catch {}
  const atFocus = el.value;
  setTimeout(() => { if (document.activeElement === el && el.value === atFocus) { try { el.setSelectionRange(0, el.value.length); } catch { el.select(); } } }, 0);
});
$('#items').addEventListener('focusout', (e) => {
  const el = e.target;
  if (!el.classList?.contains('amt')) return;
  const row = el.closest('.item');
  const i = Number(row.dataset.i);
  const k = el.dataset.k;
  const n = parseAmount(el.value);
  if (Number.isFinite(n)) doc.items[i][k] = n;
  else if (el.value.trim() === '' || /^[−ー‐–—△▲-]$/.test(el.value.trim())) doc.items[i][k] = k === 'qty' ? '' : 0;
  el.value = amountDisplay(doc.items[i][k], k === 'qty' ? 'qty' : 'price');
  el.classList.toggle('bad', el.value !== '' && !Number.isFinite(parseAmount(el.value)));
  updateLineAmounts();
  render();
  scheduleAutosave();
});
function updateLineAmounts() {
  const c = calc();
  for (const el of $$('[data-amt]')) el.textContent = `金額 ${yen(c.lines[Number(el.dataset.amt)] || 0)}`;
}
function flipSign(i) {
  const n = num(doc.items[i].unitPrice);
  doc.items[i].unitPrice = n ? -n : 0;
  renderItemsEditor();
  render();
  scheduleAutosave();
}
function moveItem(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= doc.items.length) return;
  [doc.items[i], doc.items[j]] = [doc.items[j], doc.items[i]];
  renderItemsEditor();
  render();
  scheduleAutosave();
}
function removeItem(i) {
  doc.items.splice(i, 1);
  if (!doc.items.length) doc.items.push(emptyItem());
  renderItemsEditor();
  render();
  scheduleAutosave();
}
function addRow(extra) {
  const last = doc.items.at(-1);
  doc.items.push({ ...emptyItem(), rate: last ? last.rate : '10', ...extra });
  return doc.items.length - 1;
}
$('#btnAddItem').addEventListener('click', () => {
  const i = addRow();
  renderItemsEditor();
  render();
  scheduleAutosave();
  $(`#it-${i}-name`)?.focus();
});
$('#btnAddDiscount').addEventListener('click', () => {
  const i = addRow({ name: '値引き', qty: 1, unit: '式', unitPrice: 0 });
  renderItemsEditor();
  render();
  scheduleAutosave();
  // 単価欄に「-」を入れておき、続けて数字を打つだけで負の金額になるように
  const el = $(`#it-${i}-price`);
  if (el) {
    el.focus();
    setTimeout(() => { el.value = '-'; el.setSelectionRange(1, 1); }, 0);
  }
  toast('値引き行を追加しました（単価はマイナスで入力。±ボタンで符号を反転できます）');
});

// ---------------------------------------------------------------------------
// マスタ（取引先・品目）
// ---------------------------------------------------------------------------
function renderMasters() {
  $('#itemMaster').replaceChildren(...store.items.map((m) => h('option', { value: m.name }, `${m.unit || ''} ${yen(m.unitPrice)} ${m.rate}%`)));
  $('#clientMaster').replaceChildren(...store.clients.map((c) => h('option', { value: c.name })));
  const pick = $('#clientPick');
  pick.replaceChildren(h('option', { value: '' }, store.clients.length ? '保存済みの取引先から選ぶ…' : '保存済みの取引先はありません'),
    ...store.clients.map((c, i) => h('option', { value: String(i) }, `${c.name} ${c.honorific || ''}`)));
  pick.disabled = !store.clients.length;

  const cl = $('#clientList');
  cl.replaceChildren(...(store.clients.length ? store.clients.map((c, i) => h('div', { class: 'master-row' },
    h('span', null, `${c.name} ${c.honorific || ''}`),
    h('button', { type: 'button', class: 'ibtn del', onclick: () => { store.clients.splice(i, 1); save(KEY.clients, store.clients); renderMasters(); } }, '削除')))
    : [h('div', { class: 'empty' }, '「この取引先を保存」で登録できます')]));
  const il = $('#itemList');
  il.replaceChildren(...(store.items.length ? store.items.map((m, i) => h('div', { class: 'master-row' },
    h('span', null, `${m.name}（${yen(m.unitPrice)}／${m.unit || '-'}・${RATE_OPTIONS.find((o) => o.value === String(m.rate))?.label || ''}）`),
    h('button', { type: 'button', class: 'ibtn del', onclick: () => { store.items.splice(i, 1); save(KEY.items, store.items); renderMasters(); } }, '削除')))
    : [h('div', { class: 'empty' }, '明細の「登録」ボタンで品目を登録できます')]));
}
$('#btnSaveClient').addEventListener('click', () => {
  const c = doc.client;
  if (!c.name.trim()) { toast('取引先名を入力してください'); $('#f-clientName').focus(); return; }
  const i = store.clients.findIndex((x) => x.name === c.name);
  const rec = { name: c.name, honorific: c.honorific, zip: c.zip || '', address: c.address || '' };
  if (i >= 0) store.clients[i] = rec; else store.clients.push(rec);
  save(KEY.clients, store.clients);
  renderMasters();
  toast(i >= 0 ? '取引先を更新しました' : '取引先を保存しました');
});
$('#clientPick').addEventListener('change', (e) => {
  const c = e.target.value === '' ? null : store.clients[Number(e.target.value)];
  e.target.value = '';
  if (c) applyClient(c);
});
$('#f-clientName').addEventListener('change', (e) => {
  const c = store.clients.find((x) => x.name === e.target.value);
  if (c) applyClient(c);
});
function applyClient(c) {
  doc.client = migrateParty({ name: c.name, honorific: c.honorific ?? '御中', zip: c.zip || '', address: c.address || '' });
  fillForm();
  render();
  scheduleAutosave();
}
function saveItemMaster(i) {
  const it = doc.items[i];
  if (!String(it.name).trim()) { toast('品目名を入力してください'); return; }
  const rec = { name: it.name, unit: it.unit, unitPrice: num(it.unitPrice), rate: String(it.rate), priceMode: doc.priceMode };
  const j = store.items.findIndex((x) => x.name === it.name);
  if (j >= 0) store.items[j] = rec; else store.items.push(rec);
  save(KEY.items, store.items);
  renderMasters();
  toast(`「${it.name}」を品目マスタに${j >= 0 ? '更新' : '登録'}しました`);
}
$('#btnMasters').addEventListener('click', () => { renderMasters(); $('#masterDialog').showModal(); });

// ---------------------------------------------------------------------------
// プレビュー（＝印刷される書類）
// ---------------------------------------------------------------------------
function rateLabel(rate) {
  const r = String(rate);
  return r === '8' ? '8%※' : r === '0' ? '非課税' : '10%';
}

function render() {
  const t = TYPES[doc.type];
  const c = calc();
  const is = doc.issuer;
  const inclusive = doc.priceMode === 'inclusive';
  const hasReduced = doc.items.some((it) => String(it.rate) === '8');
  const amountDue = c.billed;
  const logo = pro && store.assets.logo;
  const seal = pro && store.assets.seal;

  // 見出し・メタ
  const meta = h('table', { class: 'd-meta' },
    h('tbody', null,
      h('tr', null, h('th', null, 'No.'), h('td', null, doc.number)),
      h('tr', null, h('th', null, doc.type === 'receipt' ? '受領日' : '発行日'), h('td', null, jaDate(doc.issueDate)))));
  const top = h('div', { class: 'd-top' }, h('h1', { class: 'd-title' }, t.label), meta);

  // 宛先ブロック
  const clientName = doc.client.name.trim();
  const to = h('div', { class: 'd-to' },
    h('div', { class: 'd-client' },
      h('span', { class: clientName ? '' : 'd-empty-hint' }, clientName || '（取引先名）'),
      h('span', { class: 'hon' }, doc.client.honorific || '')),
    doc.client.zip || doc.client.address ? h('div', { class: 'd-caddr' }, [doc.client.zip ? `〒${doc.client.zip}` : '', doc.client.address].filter(Boolean).join('\n')) : null);

  if (doc.type === 'receipt') {
    to.append(
      h('div', { class: 'd-amount' },
        h('div', { class: 'k' }, t.amountLabel),
        amountValue(`${yen(amountDue)}-`)),
      h('div', { class: 'd-proviso' }, `但し　${doc.subject.trim() || '　　　　　　　　'}　として`),
      h('div', { class: 'd-received' }, t.lead),
      c.stamp > 0 ? h('div', { class: 'd-stamp' }, h('span', null, '収入印紙'), h('span', null, `${formatYen(c.stamp)}円`)) : null);
  } else {
    to.append(
      h('p', { class: 'd-lead' }, t.lead),
      h('div', { class: 'd-subject' }, h('span', { class: 'k' }, '件名'), h('span', { class: 'v' }, doc.subject || '')),
      h('div', { class: 'd-subject' }, h('span', { class: 'k' }, '取引年月日'), h('span', { class: 'v' }, periodText(doc))),
      t.showDue ? h('div', { class: 'd-subject' }, h('span', { class: 'k' }, t.dueLabel), h('span', { class: 'v' }, jaDate(doc.dueDate))) : null,
      h('div', { class: 'd-amount' },
        h('div', { class: 'k' }, t.amountLabel),
        amountValue(yen(amountDue))));
  }
  if (doc.type === 'receipt') {
    to.append(h('div', { class: 'd-subject', style: 'margin-top:3mm' }, h('span', { class: 'k' }, '取引年月日'), h('span', { class: 'v' }, periodText(doc))));
  }

  // 発行者ブロック
  const from = h('div', { class: 'd-from' },
    logo ? h('img', { class: 'd-logo', src: logo, alt: '' }) : null,
    h('div', { class: 'd-iname' + (is.name ? '' : ' d-empty-hint') }, is.name || '（発行者名）'),
    is.zip || is.address ? h('div', { class: 'd-iaddr' }, [is.zip ? `〒${is.zip}` : '', is.address].filter(Boolean).join('\n')) : null,
    is.phone ? h('div', null, `TEL ${is.phone}`) : null,
    is.email ? h('div', null, is.email) : null,
    is.regNo ? h('div', { class: 'd-reg' }, h('span', { class: 'k' }, '登録番号 '), normalizeRegNo(is.regNo)) : null,
    seal ? h('img', { class: 'd-seal', src: seal, alt: '' }) : null);

  // 明細表
  const minRows = 6;
  const rows = doc.items.map((it, i) => h('tr', null,
    h('td', { class: 'c' }, i + 1),
    h('td', null, it.name, String(it.rate) === '8' ? h('span', { class: 'mark' }, '※') : null),
    h('td', { class: 'n' }, it.qty === '' ? '' : formatQty(it.qty)),
    h('td', { class: 'c' }, it.unit),
    h('td', { class: 'n' }, signed(num(it.unitPrice))),
    h('td', { class: 'c' }, rateLabel(it.rate)),
    h('td', { class: 'n' }, signed(c.lines[i]))));
  for (let k = rows.length; k < minRows; k++) rows.push(h('tr', { class: 'empty' }, Array.from({ length: 7 }, () => h('td'))));
  const table = h('table', { class: 'd-items' },
    h('colgroup', null, h('col', { class: 'no' }), h('col'), h('col', { class: 'qty' }), h('col', { class: 'unit' }), h('col', { class: 'price' }), h('col', { class: 'rate' }), h('col', { class: 'amt' })),
    h('thead', null, h('tr', null, ['No', '品目・内容', '数量', '単位', inclusive ? '単価(税込)' : '単価', '税率', inclusive ? '金額(税込)' : '金額'].map((x) => h('th', null, x)))),
    h('tbody', null, rows));

  // 合計（税率ごとの対価の額と消費税額）
  const order = ['10', '8', '0'];
  const rateRows = [];
  for (const key of order) {
    const b = c.byRate[key];
    if (!b) continue;
    const name = key === '10' ? '10%対象' : key === '8' ? '8%対象（軽減税率※）' : '非課税・不課税';
    if (key === '0') {
      rateRows.push(h('tr', { class: 'sub' }, h('th', null, name), h('td', null, yen(b.total))));
    } else if (inclusive) {
      rateRows.push(h('tr', { class: 'sub' }, h('th', null, `${name}（税込）`), h('td', null, yen(b.total))));
      rateRows.push(h('tr', { class: 'sub' }, h('th', null, `　うち消費税（${key}%）`), h('td', null, yen(b.tax))));
    } else {
      rateRows.push(h('tr', { class: 'sub' }, h('th', null, `${name}（税抜）`), h('td', null, yen(b.base))));
      rateRows.push(h('tr', { class: 'sub' }, h('th', null, `　消費税（${key}%）`), h('td', null, yen(b.tax))));
    }
  }
  const totals = h('table', { class: 'd-totals' }, h('tbody', null,
    h('tr', null, h('th', null, '小計（税抜）'), h('td', null, yen(c.subtotal))),
    h('tr', null, h('th', null, '消費税'), h('td', null, yen(c.tax))),
    rateRows,
    c.withholding
      ? [h('tr', { class: 'total' }, h('th', null, '合計（税込）'), h('td', null, yen(c.total))),
        h('tr', null, h('th', null, '源泉徴収税額'), h('td', null, `−${yen(c.withholding)}`)),
        h('tr', { class: 'grand' }, h('th', null, t.amountLabel), h('td', null, yen(c.billed)))]
      : h('tr', { class: 'grand' }, h('th', null, '合計（税込）'), h('td', null, yen(c.total)))));

  const notesCol = h('div', { class: 'd-notes-col' },
    hasReduced ? h('p', { class: 'd-reduced' }, '※印は軽減税率（8%）対象品目です。') : null,
    doc.withholding ? h('p', { class: 'd-reduced' }, `源泉徴収税額は税抜金額 ${yen(c.subtotal)} に対して計算しています。`) : null);

  const bank = t.showBank && is.bank ? h('div', { class: 'd-box' }, h('h4', null, 'お振込先'), h('p', null, is.bank)) : null;
  const notes = doc.notes.trim() ? h('div', { class: 'd-box' }, h('h4', null, '備考'), h('p', null, doc.notes)) : null;

  const paper = $('#paper');
  paper.replaceChildren(...[
    top,
    h('div', { class: 'd-head' }, to, from),
    table,
    h('div', { class: 'd-bottom' }, notesCol, totals),
    bank,
    notes,
    h('div', { class: 'd-spacer' }),
    pro ? null : h('div', { class: 'd-credit' }, 'ゼロ請求書で作成'),
  ].filter(Boolean));

  renderSummary(c);
  fitPreview();
}


function renderSummary(c) {
  const t = TYPES[doc.type];
  const row = (cls, k, v) => h('div', { class: cls || null }, h('span', null, k), h('span', null, v));
  const taxed = ['10', '8'].filter((k) => c.byRate[k]);
  const out = [
    row('', doc.priceMode === 'inclusive' ? '小計（税抜換算）' : '小計（税抜）', yen(c.subtotal)),
    row('', '消費税', yen(c.tax)),
  ];
  if (taxed.length > 1) out.push(h('div', { class: 'sub' }, taxed.map((k) => `${k}%: ${yen(c.byRate[k].tax)}`).join(' ／ ')));
  out.push(row(c.withholding ? 'total' : 'grand', '合計（税込）', yen(c.total)));
  if (c.withholding) {
    out.push(row('neg', '源泉徴収税額', `−${yen(c.withholding)}`));
    out.push(row('grand', doc.type === 'invoice' ? '差引ご請求額' : `差引${t.amountLabel}`, yen(c.billed)));
  }
  $('#sumMini').replaceChildren(...out);

  const note = $('#stampNote');
  if (doc.type !== 'receipt') { note.hidden = true; return; }
  note.hidden = false;
  note.replaceChildren(
    h('div', null, '必要な収入印紙：', h('strong', null, c.stamp ? `${formatYen(c.stamp)}円` : '不要（非課税）')),
    h('div', { class: 'muted' },
      `消費税額を区分記載しているため、税抜金額 ${yen(c.subtotal)} で判定しています（5万円未満は非課税）。`,
      'PDFをメール等で送る電子の領収書には印紙は不要です。紙で渡す場合に貼付・消印してください。'));
}

// A4プレビューを横幅に合わせて縮小
const scaler = $('#scaler');
function fitPreview() {
  const paper = $('#paper');
  const w = scaler.clientWidth;
  const pw = paper.offsetWidth;
  const s = Math.min(1, w / pw);
  paper.style.transform = s < 1 ? `scale(${s})` : '';
  scaler.style.height = `${Math.ceil(paper.offsetHeight * s)}px`;
}
new ResizeObserver(() => fitPreview()).observe(scaler);

// ---------------------------------------------------------------------------
// 保存済み一覧・複製・バックアップ
// ---------------------------------------------------------------------------
function renderDocList() {
  const list = $('#docList');
  $('#listLimit').textContent = pro
    ? `${store.docs.length}件保存中（Pro版：無制限）`
    : `${store.docs.length} / ${FREE_DOC_LIMIT}件保存中（無料版は${FREE_DOC_LIMIT}件まで）`;
  if (!store.docs.length) {
    list.replaceChildren(h('div', { class: 'empty' }, 'まだ保存された書類はありません。ツールバーの「保存」で一覧に追加できます。'));
    return;
  }
  list.replaceChildren(...store.docs.map((d) => {
    const c = calc(normalizeDoc(d));
    return h('div', { class: 'doc-row' + (d.id === doc.id ? ' current' : '') },
      h('div', { class: 'doc-info' },
        h('div', { class: 't' }, h('span', { class: 'doc-kind' }, TYPES[d.type]?.label || ''), `${d.client?.name || '（取引先未入力）'}${d.subject ? ' — ' + d.subject : ''}`),
        h('div', { class: 's' }, `${d.number}　${jaDate(d.issueDate)}　${yen(c.billed)}`)),
      h('div', { class: 'doc-btns' },
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { setDoc(structuredClone(d)); $('#listDialog').close(); toast('書類を開きました'); } }, '開く'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { duplicate(d); $('#listDialog').close(); } }, '複製'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-label': '削除', onclick: () => deleteDoc(d) }, '削除')));
  }));
}

function bumpMonthText(s) {
  return String(s || '').replace(/(\d{4})年(\d{1,2})月/g, (_, y, m) => {
    const d = new Date(Number(y), Number(m), 1); // 翌月
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  });
}

/** 毎月の定期請求向け：日付・番号・「○年○月」を1か月進めて複製 */
function duplicate(src) {
  const d = normalizeDoc(structuredClone(src));
  d.id = uid();
  d.number = nextNumber(d.type);
  const issue = parseISO(d.issueDate) || new Date();
  const nextIssue = isMonthEnd(issue) ? new Date(issue.getFullYear(), issue.getMonth() + 2, 0) : addMonths(issue, 1);
  d.issueDate = toISO(nextIssue);
  if (d.duePreset) d.dueDate = computeDue(d.duePreset, d.issueDate);
  else if (d.dueDate) {
    const due = parseISO(d.dueDate);
    d.dueDate = toISO(isMonthEnd(due) ? new Date(due.getFullYear(), due.getMonth() + 2, 0) : addMonths(due, 1));
  }
  d.subject = bumpMonthText(d.subject);
  d.period = bumpMonthText(d.period);
  if (d.periodStart) d.periodStart = nextMonthISO(d.periodStart);
  if (d.periodEnd) d.periodEnd = nextMonthISO(d.periodEnd);
  d.issuer = { ...d.issuer, ...(store.profile.issuer || {}) };
  d.createdAt = d.updatedAt = Date.now();
  setDoc(d);
  toast('複製しました（日付と番号を1か月分進めています）。内容を確認して「保存」してください');
}

function deleteDoc(d) {
  if (!confirm(`「${d.number} ${d.client?.name || ''}」を削除しますか？この操作は取り消せません。`)) return;
  store.docs = store.docs.filter((x) => x.id !== d.id);
  save(KEY.docs, store.docs);
  renderDocList();
  updateStatus();
}

function download(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

$('#btnExport').addEventListener('click', () => {
  autosave();
  const data = {
    app: 'zero-invoice', version: 1, exportedAt: new Date().toISOString(),
    data: { docs: store.docs, clients: store.clients, items: store.items, profile: store.profile, counters: store.counters, assets: store.assets, current: doc },
  };
  download(`zero-invoice-backup-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
  toast('バックアップを書き出しました');
});
$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const json = JSON.parse(await file.text());
    if (json?.app !== 'zero-invoice' || !json.data) throw new Error('形式が違います');
    const dd = json.data;
    if (!confirm(`バックアップ（書類${(dd.docs || []).length}件）から復元します。現在のデータは置き換えられます。よろしいですか？`)) return;
    store.docs = Array.isArray(dd.docs) ? dd.docs.map(normalizeDoc) : [];
    store.clients = Array.isArray(dd.clients) ? dd.clients : [];
    store.items = Array.isArray(dd.items) ? dd.items : [];
    store.profile = dd.profile && typeof dd.profile === 'object' ? dd.profile : {};
    store.counters = dd.counters && typeof dd.counters === 'object' ? dd.counters : {};
    store.assets = dd.assets && typeof dd.assets === 'object' ? sanitizeAssets(dd.assets) : {};
    for (const k of ['docs', 'clients', 'items', 'profile', 'counters', 'assets']) save(KEY[k], store[k]);
    setDoc(dd.current || store.docs[0] || newDoc());
    renderMasters();
    renderDocList();
    refreshAssetButtons();
    toast('バックアップから復元しました');
  } catch (err) {
    alert(`復元できませんでした：${err.message}`);
  }
});
function sanitizeAssets(a) {
  const ok = (v) => typeof v === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v);
  return { logo: ok(a.logo) ? a.logo : undefined, seal: ok(a.seal) ? a.seal : undefined };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
$('#btnCsv').addEventListener('click', () => {
  if (!pro) { openPro('保存済み書類の一覧をCSVで書き出す機能はPro版でご利用いただけます。'); return; }
  const head = ['種類', '番号', '発行日', '支払期日', '取引先', '件名', '税抜金額', '消費税', '税込金額', '源泉徴収税額', '請求金額'];
  const rows = store.docs.map((raw) => {
    const d = normalizeDoc(raw);
    const c = calc(d);
    return [TYPES[d.type].label, d.number, d.issueDate, TYPES[d.type].showDue ? d.dueDate : '', d.client.name, d.subject, c.subtotal, c.tax, c.total, c.withholding, c.billed];
  });
  const csv = '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  download(`zero-invoice-${today()}.csv`, csv, 'text/csv;charset=utf-8');
  toast('CSVを書き出しました');
});

// ---------------------------------------------------------------------------
// Pro（ロゴ・角印、モーダル、ライセンス）
// ---------------------------------------------------------------------------
function openPro(reason = '') {
  $('#proReason').textContent = reason;
  $('#licenseMsg').textContent = '';
  $('#licenseMsg').className = 'hint';
  $('#proDialog').showModal();
}

$('#licenseForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('#licenseKey').value.trim();
  const msg = $('#licenseMsg');
  if (!key) { msg.className = 'hint bad'; msg.textContent = 'ライセンスキーを貼り付けてください'; return; }
  const btn = $('#btnActivate');
  btn.disabled = true;
  msg.className = 'hint';
  msg.textContent = '確認しています…';
  try {
    const r = await activateLicense(key);
    if (r?.ok) {
      pro = true;
      applyPlan();
      msg.className = 'hint ok';
      msg.textContent = `✓ Pro版が有効になりました${r.email ? `（${r.email}）` : ''}`;
      $('#licenseKey').value = '';
      setTimeout(() => $('#proDialog').open && $('#proDialog').close(), 1400);
      toast('Pro版が有効になりました。ありがとうございます！');
    } else {
      msg.className = 'hint bad';
      msg.textContent = `⚠ ${r?.error || 'ライセンスキーを確認できませんでした'}`;
    }
  } catch (err) {
    msg.className = 'hint bad';
    msg.textContent = `⚠ 有効化に失敗しました：${err?.message || err}`;
  } finally {
    btn.disabled = false;
  }
});

function applyPlan() {
  const badge = $('#planBadge');
  badge.textContent = pro ? 'Pro版' : '無料版';
  badge.classList.toggle('is-pro', pro);
  badge.title = pro && getStoredLicense() ? 'ライセンス有効' : '';
  for (const t of $$('.pro-tag')) t.hidden = pro;
  refreshAssetButtons();
  render();
  if ($('#listDialog').open) renderDocList();
}

let assetTarget = null;
for (const b of $$('[data-asset-pick]')) {
  b.addEventListener('click', () => {
    if (!pro) { openPro(b.dataset.assetPick === 'logo' ? 'ロゴ画像の表示はPro版の機能です。' : '角印・印影画像の表示はPro版の機能です。'); return; }
    assetTarget = b.dataset.assetPick;
    $('#assetFile').click();
  });
}
for (const b of $$('[data-asset-clear]')) {
  b.addEventListener('click', () => {
    delete store.assets[b.dataset.assetClear];
    save(KEY.assets, store.assets);
    refreshAssetButtons();
    render();
  });
}
$('#assetFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !assetTarget) return;
  try {
    const dataUrl = await shrinkImage(file, assetTarget === 'seal' ? 360 : 640);
    const prev = store.assets[assetTarget];
    store.assets[assetTarget] = dataUrl;
    if (!save(KEY.assets, store.assets)) { store.assets[assetTarget] = prev; return; }
    refreshAssetButtons();
    render();
    toast(assetTarget === 'seal' ? '角印を設定しました' : 'ロゴを設定しました');
  } catch {
    alert('画像を読み込めませんでした。PNG/JPEG形式の画像をお試しください。');
  }
});
/** localStorage に収まるよう縮小して PNG の dataURL に */
function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.naturalWidth * s));
      cv.height = Math.max(1, Math.round(img.naturalHeight * s));
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load')); };
    img.src = url;
  });
}
function refreshAssetButtons() {
  for (const b of $$('[data-asset-clear]')) b.hidden = !(pro && store.assets[b.dataset.assetClear]);
  for (const b of $$('[data-asset-pick]')) b.textContent = pro && store.assets[b.dataset.assetPick] ? '変更' : '画像を選ぶ';
}

// ---------------------------------------------------------------------------
// ツールバー・ダイアログ
// ---------------------------------------------------------------------------
$('#btnNew').addEventListener('click', () => {
  autosave();
  if (!isSaved(doc.id) && hasContent(doc) && !confirm('現在の下書きは一覧に保存されていません。新しい書類を作成しますか？（下書きは破棄されます）')) return;
  setDoc(newDoc(doc.type));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  toast(`新しい${TYPES[doc.type].label}を作成しました`);
});
function hasContent(d) {
  return !!(d.client.name || d.subject || d.notes || d.items.some((it) => it.name || num(it.unitPrice)));
}
$('#btnSave').addEventListener('click', saveToList);
$('#btnList').addEventListener('click', () => { renderDocList(); $('#listDialog').showModal(); });
const doPrint = () => { autosave(); fitPreview(); window.print(); };
$('#btnPrint').addEventListener('click', doPrint);
$('#btnPrint2').addEventListener('click', doPrint);

for (const dlg of $$('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dlg) dlg.close();
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveToList(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') { autosave(); }
});
window.addEventListener('beforeprint', () => {
  const paper = $('#paper');
  paper.style.transform = '';
});
window.addEventListener('afterprint', fitPreview);
window.addEventListener('pagehide', autosave);

// 他タブでの変更を反映
window.addEventListener('storage', (e) => {
  if (e.key === KEY.docs) { store.docs = load(KEY.docs, []); updateStatus(); if ($('#listDialog').open) renderDocList(); }
  if (e.key === KEY.clients || e.key === KEY.items) { store.clients = load(KEY.clients, []); store.items = load(KEY.items, []); renderMasters(); }
});

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
function init() {
  $('#f-rounding').replaceChildren(...Object.entries(ROUNDING_LABELS).map(([v, l]) => h('option', { value: v }, l)));
  $('#proPrice').textContent = `¥${formatYen(CONFIG.priceJPY)}`;
  $('#proBuy').href = CONFIG.stripePaymentLink;
  $('#proBuy').textContent = `Pro版を購入する（¥${formatYen(CONFIG.priceJPY)}）`;

  const cur = load(KEY.current, null);
  doc = cur ? normalizeDoc(cur) : newDoc('invoice');
  const params = new URLSearchParams(location.search);
  const qt = params.get('type');
  if (TYPES[qt] && (!cur || !hasContent(doc))) doc = newDoc(qt);

  fillForm();
  renderItemsEditor();
  renderMasters();
  refreshAssetButtons();
  render();
  updateStatus();
  save(KEY.current, doc);

  isPro().then((v) => { pro = !!v; applyPlan(); }).catch((e) => console.warn('ライセンス確認に失敗', e));
}
init();
