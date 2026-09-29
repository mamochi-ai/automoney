import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roundYen, calcInvoice, withholdingTax, grossFromNet, receiptStampDuty,
  validateRegistrationNumber, dueDate,
} from '../site/lib/tax.js';

test('roundYen', () => {
  assert.equal(roundYen(10.5, 'floor'), 10);
  assert.equal(roundYen(10.5, 'round'), 11);
  assert.equal(roundYen(10.01, 'ceil'), 11);
  assert.equal(roundYen(-10.5, 'floor'), -10);
  assert.equal(roundYen(0.1 * 3 * 10, 'floor'), 3); // 浮動小数点誤差
});

test('calcInvoice: 税率ごとに1回だけ端数処理する', () => {
  // 1行ずつ端数処理すると 99*0.1=9.9→9 が3行で27円、合算なら 297*0.1=29.7→29円
  const r = calcInvoice([
    { qty: 1, unitPrice: 99, rate: 10 },
    { qty: 1, unitPrice: 99, rate: 10 },
    { qty: 1, unitPrice: 99, rate: 10 },
  ]);
  assert.equal(r.tax, 29);
  assert.equal(r.total, 326);
});

test('calcInvoice: 10%と8%の混在', () => {
  const r = calcInvoice([
    { qty: 2, unitPrice: 1500, rate: 10 },
    { qty: 3, unitPrice: 333, rate: 8 },
  ]);
  assert.deepEqual(r.byRate['10'], { base: 3000, tax: 300, total: 3300 });
  assert.deepEqual(r.byRate['8'], { base: 999, tax: 79, total: 1078 });
  assert.equal(r.subtotal, 3999);
  assert.equal(r.total, 4378);
});

test('calcInvoice: 税込価格モード', () => {
  const r = calcInvoice([{ qty: 1, unitPrice: 1100, rate: 10 }], { priceMode: 'inclusive' });
  assert.equal(r.tax, 100);
  assert.equal(r.subtotal, 1000);
  assert.equal(r.total, 1100);
});

test('withholdingTax', () => {
  assert.equal(withholdingTax(100_000), 10_210);
  assert.equal(withholdingTax(1_000_000), 102_100);
  assert.equal(withholdingTax(1_500_000), 204_200);
  assert.equal(withholdingTax(33_333), 3_403);
});

test('grossFromNet は手取りを満たす最小の額面', () => {
  for (const net of [0, 1, 89_790, 100_000, 897_900, 900_000, 5_000_000]) {
    const g = grossFromNet(net);
    assert.ok(g - withholdingTax(g) >= net, `net=${net}`);
    assert.ok(g === 0 || g - 1 - withholdingTax(g - 1) < net, `minimal net=${net}`);
  }
});

test('receiptStampDuty', () => {
  assert.equal(receiptStampDuty(49_999), 0);
  assert.equal(receiptStampDuty(50_000), 200);
  assert.equal(receiptStampDuty(1_000_000), 200);
  assert.equal(receiptStampDuty(1_000_001), 400);
  assert.equal(receiptStampDuty(10_000_000), 2_000);
  assert.equal(receiptStampDuty(1_000_000_001), 200_000);
});

test('validateRegistrationNumber', () => {
  // 国税庁 法人番号 公表例: 7000012050002（国税庁）
  assert.equal(validateRegistrationNumber('T7000012050002').valid, true);
  assert.equal(validateRegistrationNumber('t7000-0120-50002').valid, true);
  assert.equal(validateRegistrationNumber('T8000012050002').valid, false);
  assert.equal(validateRegistrationNumber('7000012050002').valid, false);
});

test('dueDate: 月末締め翌月末払い', () => {
  const d = dueDate(new Date(2026, 0, 31)); // 2026-01-31
  assert.equal(d.getMonth(), 1);
  assert.equal(d.getDate(), 28);
  const d2 = dueDate(new Date(2026, 10, 15), { monthsLater: 2, day: 10 });
  assert.equal(d2.getFullYear(), 2027);
  assert.equal(d2.getMonth(), 0);
  assert.equal(d2.getDate(), 10);
});
