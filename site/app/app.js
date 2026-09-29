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
const yen = (n) => `¥${formatYen(n)}`;
const num = (v) => {
  const s = String(v ?? '').replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,，\s円¥￥]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
/** 同日の翌月（末日は丸める） */
function addMonths(d, k) {
  const last = new Date(d.getFullYear(), d.getMonth() + k + 1, 0).getDate();
  return new Date(d.getFullYear(), d.getMonth() + k, Math.min(d.getDate(), last));
}
const isMonthEnd = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();

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
  profile: load(KEY.profile, {}),
  counters: load(KEY.counters, {}),
  assets: load(KEY.assets, {}),
};
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
    period: '',
    client: { name: '', honorific: '御中', address: '' },
    issuer: { name: '', address: '', regNo: '', phone: '', email: '', bank: '', ...(p.issuer || {}) },
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
  out.client = { ...base.client, ...(d?.client || {}) };
  out.issuer = { ...base.issuer, ...(d?.issuer || {}) };
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
  markDuePreset();
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

function updateRegNoMsg() {
  const el = $('#regNoMsg');
  const input = $('#f-regNo');
  const v = (doc.issuer.regNo || '').trim();
  input.classList.remove('bad');
  if (!v) {
    el.className = 'hint';
    el.textContent = '適格請求書（インボイス）には登録番号の記載が必要です。未登録（免税事業者）の場合は空欄のままで構いません。';
    return;
  }
  const r = validateRegistrationNumber(v);
  if (r.valid) {
    el.className = 'hint ok';
    el.textContent = '✓ 登録番号の形式・チェックデジットはOKです';
  } else {
    el.className = 'hint bad';
    input.classList.add('bad');
    el.textContent = `⚠ ${r.reason}`;
  }
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

form.addEventListener('submit', (e) => e.preventDefault());
form.addEventListener('input', (e) => {
  const el = e.target;
  if (el.closest('#items')) return onItemInput(e);
  if (!el.name) return;
  const v = el.type === 'checkbox' ? el.checked : el.value;
  setPath(doc, el.name, v);
  if (el.name.startsWith('issuer.')) {
    store.profile.issuer = { ...doc.issuer };
    save(KEY.profile, store.profile);
    if (el.name === 'issuer.regNo') updateRegNoMsg();
  }
  if (['priceMode', 'rounding', 'withholding'].includes(el.name)) {
    store.profile[el.name] = v;
    save(KEY.profile, store.profile);
    if (el.name === 'priceMode') renderItemsEditor();
  }
  if (el.name === 'issueDate' && doc.duePreset) {
    const due = computeDue(doc.duePreset, doc.issueDate);
    if (due) { doc.dueDate = due; $('#f-dueDate').value = due; }
  }
  if (el.name === 'dueDate') { doc.duePreset = ''; markDuePreset(); }
  render();
  scheduleAutosave();
});
// 入力確定時の登録番号の正規化（全角→半角・大文字）
$('#f-regNo').addEventListener('change', (e) => {
  const v = e.target.value.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).toUpperCase().replace(/[\s-]/g, '');
  if (v !== e.target.value) { e.target.value = v; e.target.dispatchEvent(new Event('input', { bubbles: true })); }
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
function renderItemsEditor() {
  const box = $('#items');
  const c = calc();
  const priceLabel = doc.priceMode === 'inclusive' ? '単価（税込）' : '単価（税抜）';
  box.replaceChildren(...doc.items.map((it, i) => {
    const id = (k) => `it-${i}-${k}`;
    return h('div', { class: 'item', dataset: { i } },
      h('div', { class: 'item-top' },
        h('span', { class: 'item-no', 'aria-hidden': 'true' }, i + 1),
        h('input', { id: id('name'), 'aria-label': `${i + 1}行目 品目`, placeholder: '品目・内容', value: it.name, list: 'itemMaster', dataset: { k: 'name' } })),
      h('div', { class: 'item-grid' },
        h('div', null, h('label', { for: id('qty') }, '数量'), h('input', { id: id('qty'), class: 'num', inputmode: 'decimal', value: it.qty, dataset: { k: 'qty' } })),
        h('div', null, h('label', { for: id('unit') }, '単位'), h('input', { id: id('unit'), value: it.unit, placeholder: '式', dataset: { k: 'unit' } })),
        h('div', null, h('label', { for: id('price') }, priceLabel), h('input', { id: id('price'), class: 'num', inputmode: 'numeric', value: it.unitPrice, dataset: { k: 'unitPrice' } })),
        h('div', null, h('label', { for: id('rate') }, '税率'),
          h('select', { id: id('rate'), dataset: { k: 'rate' } },
            RATE_OPTIONS.map((o) => h('option', { value: o.value, selected: String(it.rate) === o.value }, o.label))))),
      h('div', { class: 'item-foot' },
        h('span', { class: 'item-amt', dataset: { amt: i } }, `金額 ${yen(c.lines[i])}`),
        h('div', { class: 'item-btns' },
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
function updateLineAmounts() {
  const c = calc();
  for (const el of $$('[data-amt]')) el.textContent = `金額 ${yen(c.lines[Number(el.dataset.amt)] || 0)}`;
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
$('#btnAddItem').addEventListener('click', () => {
  const last = doc.items.at(-1);
  doc.items.push({ ...emptyItem(), rate: last ? last.rate : '10' });
  renderItemsEditor();
  render();
  scheduleAutosave();
  $(`#it-${doc.items.length - 1}-name`)?.focus();
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
  const rec = { name: c.name, honorific: c.honorific, address: c.address || '' };
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
  doc.client = { name: c.name, honorific: c.honorific ?? '御中', address: c.address || '' };
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
    doc.client.address ? h('div', { class: 'd-caddr' }, doc.client.address) : null);

  if (doc.type === 'receipt') {
    to.append(
      h('div', { class: 'd-amount' },
        h('div', { class: 'k' }, t.amountLabel),
        h('div', { class: 'v' }, `${yen(amountDue)}-`, h('small', null, '（税込）'))),
      h('div', { class: 'd-proviso' }, `但し　${doc.subject.trim() || '　　　　　　　　'}　として`),
      h('div', { class: 'd-received' }, t.lead),
      c.stamp > 0 ? h('div', { class: 'd-stamp' }, h('span', null, '収入印紙'), h('span', null, `${formatYen(c.stamp)}円`)) : null);
  } else {
    to.append(
      h('p', { class: 'd-lead' }, t.lead),
      h('div', { class: 'd-subject' }, h('span', { class: 'k' }, '件名'), h('span', { class: 'v' }, doc.subject || '')),
      h('div', { class: 'd-subject' }, h('span', { class: 'k' }, '取引年月日'), h('span', { class: 'v' }, doc.period.trim() || jaDate(doc.issueDate))),
      t.showDue ? h('div', { class: 'd-subject' }, h('span', { class: 'k' }, t.dueLabel), h('span', { class: 'v' }, jaDate(doc.dueDate))) : null,
      h('div', { class: 'd-amount' },
        h('div', { class: 'k' }, t.amountLabel),
        h('div', { class: 'v' }, yen(amountDue), h('small', null, '（税込）'))));
  }
  if (doc.type === 'receipt') {
    to.append(h('div', { class: 'd-subject', style: 'margin-top:3mm' }, h('span', { class: 'k' }, '取引年月日'), h('span', { class: 'v' }, doc.period.trim() || jaDate(doc.issueDate))));
  }

  // 発行者ブロック
  const from = h('div', { class: 'd-from' },
    logo ? h('img', { class: 'd-logo', src: logo, alt: '' }) : null,
    h('div', { class: 'd-iname' + (is.name ? '' : ' d-empty-hint') }, is.name || '（発行者名）'),
    is.address ? h('div', { class: 'd-iaddr' }, is.address) : null,
    is.phone ? h('div', null, `TEL ${is.phone}`) : null,
    is.email ? h('div', null, is.email) : null,
    is.regNo ? h('div', { class: 'd-reg' }, h('span', { class: 'k' }, '登録番号 '), String(is.regNo).trim().toUpperCase()) : null,
    seal ? h('img', { class: 'd-seal', src: seal, alt: '' }) : null);

  // 明細表
  const minRows = 6;
  const rows = doc.items.map((it, i) => h('tr', null,
    h('td', { class: 'c' }, i + 1),
    h('td', null, it.name, String(it.rate) === '8' ? h('span', { class: 'mark' }, '※') : null),
    h('td', { class: 'n' }, it.qty === '' ? '' : formatQty(it.qty)),
    h('td', { class: 'c' }, it.unit),
    h('td', { class: 'n' }, formatYen(num(it.unitPrice))),
    h('td', { class: 'c' }, rateLabel(it.rate)),
    h('td', { class: 'n' }, formatYen(c.lines[i]))));
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

function formatQty(q) {
  const n = num(q);
  return Number.isInteger(n) ? n.toLocaleString('ja-JP') : String(n);
}

function renderSummary(c) {
  const t = TYPES[doc.type];
  const lines = [
    ['小計（税抜）', yen(c.subtotal)],
    ['消費税', yen(c.tax)],
    ['合計（税込）', yen(c.total)],
  ];
  if (c.withholding) lines.push(['源泉徴収税額', `−${yen(c.withholding)}`]);
  $('#sumMini').replaceChildren(
    ...lines.map(([k, v]) => h('div', null, h('span', null, k), h('span', null, v))),
    h('div', { class: 'grand' }, h('span', null, c.withholding ? t.amountLabel : '合計（税込）'), h('span', null, yen(c.billed))));

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
