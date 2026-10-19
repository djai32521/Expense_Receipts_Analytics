import assert from "node:assert/strict";
import test from "node:test";
import { applyCodeVerifiedDuplicates, computeShoeboxEngine } from "../src/utils/engine.ts";
import type { ReceiptRow } from "../src/types.ts";

function row(id: number, amount: number, currency = "KRW"): ReceiptRow {
  return {id: String(id), row: id, photo_index: id, box_2d: [0, 0, 1000, 1000],
    merchant: "Test Cafe", date: "2026-10-12", time: "12:30", item_count: 1,
    printed_total: amount, handwritten_tip: null, final_total: amount, currency,
    tax: null, tax_label: null, category: "Meals", card_last4: "0000",
    confidence: {merchant: 1, date: 1, printed_total: 1, handwritten_tip: 1, currency: 1, tax: 1},
    flags: [], duplicate_of: null, excluded: false, checked: false};
}

test("duplicates are flagged; excluding the reviewed duplicate updates totals", () => {
  const checked = applyCodeVerifiedDuplicates([row(1, 12500), row(2, 12500)], []);
  assert.equal(checked[1].duplicate_of, 1);
  const { reconciliation } = computeShoeboxEngine(checked.map((item) => ({...item, excluded: Boolean(item.duplicate_of)})), 2);
  assert.equal(reconciliation.mainTotalAmount, 12500);
  assert.equal(reconciliation.activeReceiptsCount, 1);
});

test("foreign currency stays separate until a conversion is supplied", () => {
  const { reconciliation } = computeShoeboxEngine([row(1, 12500), {...row(2, 34000), merchant: "Store"}, row(3, 28, "USD")], 3);
  assert.equal(reconciliation.mainCurrency, "KRW");
  assert.equal(reconciliation.mainTotalAmount, 46500);
  assert.equal(reconciliation.foreignTotals.find((entry) => entry.currency === "USD")?.totalAmount, 28);
});
