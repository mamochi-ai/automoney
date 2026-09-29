// 計算ツール共通ヘルパー（URL状態の同期・入力の正規化・リンクコピー）
import { formatYen } from '../lib/tax.js';

/** 全角数字・記号を半角に */
export function toHalf(s) {
  return String(s ?? '').replace(/[０-９Ａ-Ｚａ-ｚ．，－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 「1,234円」「１２３４」「¥1234」などを整数（円）に。解釈できなければ null */
export function parseAmount(s) {
  const t = toHalf(s).replace(/[,\s円¥￥]/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return Math.floor(Number(t));
}

export const yen = (n) => `${formatYen(n)}円`;

const $ = (sel, root = document) => root.querySelector(sel);

/**
 * フォームの name 付き要素を URL クエリと双方向同期し、変更のたびに render() を呼ぶ。
 * 初期値（HTMLの値）と同じ項目は URL に書き出さない（always に含む項目は常に書き出す）。
 */
export function bindForm(form, render, { always = [] } = {}) {
  const els = [...form.elements].filter((el) => el.name);
  const names = [...new Set(els.map((el) => el.name))];
  const read = (name) => {
    const group = els.filter((el) => el.name === name);
    const el = group[0];
    if (el.type === 'radio') return group.find((g) => g.checked)?.value ?? '';
    if (el.type === 'checkbox') return el.checked ? '1' : '0';
    return el.value;
  };
  const write = (name, value) => {
    const group = els.filter((el) => el.name === name);
    const el = group[0];
    if (el.type === 'radio') group.forEach((g) => { g.checked = g.value === value; });
    else if (el.type === 'checkbox') el.checked = value === '1';
    else el.value = value;
  };
  const defaults = Object.fromEntries(names.map((n) => [n, read(n)]));
  const params = new URLSearchParams(location.search);
  for (const n of names) if (params.has(n)) write(n, params.get(n));

  const sync = () => {
    const p = new URLSearchParams();
    for (const n of names) {
      const v = read(n);
      if (always.includes(n) || v !== defaults[n]) p.set(n, v);
    }
    const qs = p.toString();
    const url = location.pathname + (qs ? `?${qs}` : '') + location.hash;
    try { history.replaceState(null, '', url); } catch { /* file:// など */ }
  };
  const update = () => { render(); sync(); };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  form.addEventListener('submit', (e) => { e.preventDefault(); update(); });
  render();
  if (always.length) sync();
  return { read, write, update };
}

/** [data-copy-link] ボタンで現在のURL（計算条件つき）をコピー */
export function setupCopyLink(root = document) {
  root.querySelectorAll('[data-copy-link]').forEach((btn) => {
    const label = btn.textContent;
    btn.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(location.href); ok = true; } catch {
        const ta = document.createElement('textarea');
        ta.value = location.href; document.body.append(ta); ta.select();
        try { ok = document.execCommand('copy'); } catch { ok = false; }
        ta.remove();
      }
      btn.textContent = ok ? 'URLをコピーしました' : 'コピーできませんでした';
      setTimeout(() => { btn.textContent = label; }, 1800);
    });
  });
}

export function setText(id, text) {
  const el = typeof id === 'string' ? $(`#${id}`) : id;
  if (el) el.textContent = text;
}
