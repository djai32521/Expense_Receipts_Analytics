import type { RawReceiptFromModel, UploadedPhoto } from "./types";

// Fictional fixtures only. No customer data, no API requests.
export function createSamples(): { raw: RawReceiptFromModel[]; photos: UploadedPhoto[] } {
  const items = [
    { merchant: "Demo Cafe", total: 12500, currency: "KRW", category: "Meals", date: "2026-10-12" },
    { merchant: "Demo Stationery", total: 34000, currency: "KRW", category: "Office", date: "2026-10-13" },
    { merchant: "Demo Taxi", total: 18500, currency: "KRW", category: "Travel", date: "2026-10-14" },
    { merchant: "Demo Cafe", total: 12500, currency: "KRW", category: "Meals", date: "2026-10-12" },
    { merchant: "Demo Diner", total: 24, tip: 4, currency: "USD", category: "Meals", date: "2026-10-15" },
  ];
  const raw: RawReceiptFromModel[] = items.map((item, i) => ({
    photo_index: i + 1, box_2d: [0, 0, 1000, 1000], merchant: item.merchant,
    date: item.date, time: "12:30", item_count: 1, printed_total: item.total,
    handwritten_tip: item.tip ?? null, final_total: item.total + (item.tip ?? 0),
    currency: item.currency, tax: null, tax_label: null, tax_id_or_vat: null,
    is_tax_invoice: false, category: item.category, card_last4: "0000",
    confidence: {merchant: 1, date: 1, printed_total: 1, handwritten_tip: 1, currency: 1, tax: 1}, flags: [],
  }));
  const photos: UploadedPhoto[] = items.map((item, i) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640"><rect width="480" height="640" fill="#fffdf6"/><g fill="#182d45" font-family="monospace" text-anchor="middle"><text x="240" y="70" font-size="16">FICTIONAL SAMPLE RECEIPT</text><text x="240" y="150" font-size="28">${item.merchant}</text><text x="240" y="200" font-size="18">${item.date} 12:30</text><text x="240" y="280" font-size="18">Item total: ${item.total}</text><text x="240" y="325" font-size="18">Tip: ${item.tip ?? 0}</text><text x="240" y="405" font-size="30">${item.currency} ${item.total + (item.tip ?? 0)}</text><text x="240" y="490" font-size="16">Card **** 0000</text><text x="240" y="550" font-size="14">DEMO ONLY - NOT A TAX INVOICE</text></g></svg>`;
    const file = new File([svg], `sample-${i + 1}.svg`, { type: "image/svg+xml" });
    return {id: `sample-${i + 1}`, globalIndex: i + 1, file, name: file.name,
      displayName: item.merchant, objectUrl: URL.createObjectURL(file), status: "done", receiptsCount: 1,
      sourceMeta: {sourceType: "manual_upload", costCenter: "Unassigned"}};
  });
  return {raw, photos};
}
