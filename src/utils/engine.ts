import type {
  ComputedRow,
  IngestionSourceType,
  MerchantTileData,
  PositionedTile,
  ReceiptCategory,
  ReceiptFlag,
  ReceiptRow,
  ReconciliationResult,
  TileColorToken,
} from "../types";

const VALID_CATEGORIES: ReceiptCategory[] = [
  "Meals",
  "Travel",
  "Lodging",
  "Office",
  "Other",
];

const ZERO_DECIMAL_CURRENCIES = new Set(["JPY", "KRW", "VND", "CLP", "ISK"]);

export function getRowSourceType(row: ReceiptRow): IngestionSourceType {
  return row.source_meta?.sourceType || "manual_upload";
}

export function formatSourceShort(row: ReceiptRow): string {
  const st = getRowSourceType(row);
  if (st === "drive_file") {
    return row.source_meta?.driveFolderName
      ? `Drive (${row.source_meta.driveFolderName})`
      : "Google Drive";
  }
  if (st === "gmail_attachment") {
    return "Gmail Attachment";
  }
  if (st === "gmail_html") {
    return "Gmail HTML";
  }
  return "Manual Upload";
}

export function getRowSourceOrigin(row: ReceiptRow): string {
  const st = getRowSourceType(row);
  if (st === "drive_file") {
    return (
      row.source_meta?.driveFolderName ||
      row.source_meta?.driveFileName ||
      "Google Drive"
    );
  }
  if (st === "gmail_attachment" || st === "gmail_html") {
    return (
      row.source_meta?.emailFrom ||
      row.source_meta?.emailSubject ||
      "Gmail"
    );
  }
  return row.source_meta?.submittedBy || "Manual Upload";
}

function isCrossSourceDuplicatePair(
  earlier: ReceiptRow,
  later: ReceiptRow
): boolean {
  const earlierType = getRowSourceType(earlier);
  const laterType = getRowSourceType(later);
  if (earlierType !== laterType) {
    return true;
  }
  if (
    earlierType === "drive_file" &&
    earlier.source_meta?.driveFolderId &&
    later.source_meta?.driveFolderId &&
    earlier.source_meta.driveFolderId !== later.source_meta.driveFolderId
  ) {
    return true;
  }
  return false;
}

export function isZeroDecimalCurrency(currency: string): boolean {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase());
}

export function toMinorUnits(amount: number, currency: string): number {
  if (isZeroDecimalCurrency(currency)) {
    return Math.round(amount);
  }
  return Math.round(amount * 100);
}

export function fromMinorUnits(minor: number, currency: string): number {
  if (isZeroDecimalCurrency(currency)) {
    return minor;
  }
  return minor / 100;
}

export function getCurrencySymbol(currency: string): string {
  const code = (currency || "USD").toUpperCase();
  const map: Record<string, string> = {
    USD: "$",
    NZD: "$",
    AUD: "$",
    CAD: "$",
    SGD: "$",
    HKD: "$",
    GBP: "£",
    EUR: "€",
    JPY: "¥",
    CNY: "¥",
    CHF: "CHF ",
    SEK: "kr ",
    NOK: "kr ",
    DKK: "kr ",
    INR: "₹",
    KRW: "₩",
  };
  return map[code] || `${code} `;
}

export function formatCurrencyAmount(
  amount: number | null | undefined,
  currency: string
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return "—";
  }
  const code = (currency || "USD").toUpperCase();
  const sym = getCurrencySymbol(code);
  const zeroDec = isZeroDecimalCurrency(code);
  const formattedNumber = amount.toLocaleString("en-US", {
    minimumFractionDigits: zeroDec ? 0 : 2,
    maximumFractionDigits: zeroDec ? 0 : 2,
  });
  return `${sym}${formattedNumber}`;
}

export function formatDisplayDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  // Convert YYYY-MM-DD to DD/MM/YYYY as in ad1_results.png (23/09/2026)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (match) {
    return `${match[3]}/${match[2]}/${match[1]}`;
  }
  return dateStr;
}

export function normalizeMerchantName(name: string | null): string {
  if (!name || !name.trim()) return "Unreadable merchant";
  let cleaned = name
    .trim()
    // Strip common legal/store-number suffixes like "LTD", "PTY LTD", "INC", "#1234"
    .replace(/\s+#\d+.*$/i, "")
    .replace(/\s+\b(pty\s+ltd|ltd\.?|limited|inc\.?|llc|corp\.?)\b$/i, "")
    .trim();

  if (!cleaned) cleaned = name.trim();

  // If the merchant name is > 4 chars and entirely uppercase, convert to clean Title Case
  if (
    cleaned.length > 4 &&
    cleaned === cleaned.toUpperCase() &&
    /[A-Z]/.test(cleaned)
  ) {
    cleaned = cleaned
      .toLowerCase()
      .replace(/\b([a-z])([a-z]*)/g, (_m, first: string, rest: string) => {
        const word = (first + rest).toUpperCase();
        if (["ANZ", "AT", "BP", "AA", "ASB", "BNZ", "KFC", "PB"].includes(word)) {
          return word;
        }
        return first.toUpperCase() + rest;
      });
  }

  return cleaned;
}

function normalizeForComparison(str: string | null): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

export function areMerchantsSimilar(a: string | null, b: string | null): boolean {
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.includes(normB) || normB.includes(normA)) return true;

  // Levenshtein distance check for short OCR variations
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return false;
  const dp: number[][] = Array.from({ length: normA.length + 1 }, () =>
    Array(normB.length + 1).fill(0)
  );
  for (let i = 0; i <= normA.length; i++) dp[i][0] = i;
  for (let j = 0; j <= normB.length; j++) dp[0][j] = j;
  for (let i = 1; i <= normA.length; i++) {
    for (let j = 1; j <= normB.length; j++) {
      const cost = normA[i - 1] === normB[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const distance = dp[normA.length][normB.length];
  return 1 - distance / maxLen >= 0.75;
}

export function areDatesWithinOneDay(d1: string | null, d2: string | null): boolean {
  if (!d1 || !d2) return true; // If one date is unreadable, don't reject if merchant+amount match
  if (d1.trim() === d2.trim()) return true;
  const t1 = Date.parse(d1);
  const t2 = Date.parse(d2);
  if (Number.isNaN(t1) || Number.isNaN(t2)) {
    return d1.trim() === d2.trim();
  }
  const diffDays = Math.abs(t1 - t2) / (1000 * 60 * 60 * 24);
  return diffDays <= 1.1;
}

/**
 * Verifies model-suggested duplicate pairs in code AND checks all row pairs
 * using B1 rule: same amount, date within 1 day, similar merchant.
 */
export function applyCodeVerifiedDuplicates(
  rows: ReceiptRow[],
  modelDuplicates: Array<{ row: number; duplicate_of: number; reason: string }>
): ReceiptRow[] {
  const byRowNum = new Map<number, ReceiptRow>();
  rows.forEach((r) =>
    byRowNum.set(r.row, {
      ...r,
      flags: (r.flags || []).filter(
        (f) =>
          f.type !== "cross_source_duplicate" &&
          !(f.type === "possible_duplicate" && f.source === "code")
      ),
      duplicate_of: null,
      duplicate_reason: null,
    })
  );

  const getEffectiveTotal = (r: ReceiptRow): number | null => {
    if (r.printed_total !== null && r.handwritten_tip !== null && r.handwritten_tip > 0) {
      return Number((r.printed_total + r.handwritten_tip).toFixed(2));
    }
    return r.final_total ?? r.printed_total ?? null;
  };

  const markDuplicatePair = (
    earlier: ReceiptRow,
    later: ReceiptRow,
    fallbackReason: string
  ) => {
    later.duplicate_of = earlier.row;
    if (isCrossSourceDuplicatePair(earlier, later)) {
      const crossNote = `Cross-source duplicate of #${earlier.row} (${formatSourceShort(
        earlier
      )} vs ${formatSourceShort(later)})`;
      later.duplicate_reason = crossNote;
      later.flags = [
        ...(later.flags || []),
        {
          type: "cross_source_duplicate",
          note: crossNote,
          source: "code",
        },
      ];
    } else {
      later.duplicate_reason = fallbackReason;
    }
  };

  // 1. Check model-suggested duplicate pairs with B1 code verification
  for (const cand of modelDuplicates) {
    const laterRowNum = Math.max(cand.row, cand.duplicate_of);
    const earlierRowNum = Math.min(cand.row, cand.duplicate_of);
    if (laterRowNum === earlierRowNum) continue;

    const later = byRowNum.get(laterRowNum);
    const earlier = byRowNum.get(earlierRowNum);
    if (!later || !earlier) continue;

    const amtA = getEffectiveTotal(later);
    const amtB = getEffectiveTotal(earlier);
    const sameAmount =
      amtA !== null && amtB !== null && Math.abs(amtA - amtB) <= 0.01;
    const sameCurrency =
      !earlier.currency ||
      !later.currency ||
      earlier.currency.toUpperCase().trim() ===
        later.currency.toUpperCase().trim();
    const closeDate = areDatesWithinOneDay(later.date, earlier.date);
    const simMerchant = areMerchantsSimilar(later.merchant, earlier.merchant);

    if (sameAmount && sameCurrency && closeDate && simMerchant) {
      markDuplicatePair(
        earlier,
        later,
        cand.reason || `Same merchant, date and total as #${earlier.row}`
      );
    }
  }

  // 2. Deterministic fallback pass across all pairs in case model missed an obvious duplicate
  const sortedRows = Array.from(byRowNum.values()).sort((a, b) => a.row - b.row);
  for (let i = 0; i < sortedRows.length; i++) {
    for (let j = i + 1; j < sortedRows.length; j++) {
      const earlier = sortedRows[i];
      const later = sortedRows[j];
      if (later.duplicate_of) continue;

      const amtA = getEffectiveTotal(earlier);
      const amtB = getEffectiveTotal(later);
      if (amtA === null || amtB === null || amtA <= 0) continue;

      const sameAmount = Math.abs(amtA - amtB) <= 0.01;
      const sameCurrency =
        (earlier.currency || "USD").toUpperCase().trim() ===
        (later.currency || "USD").toUpperCase().trim();
      const closeDate =
        earlier.date !== null &&
        later.date !== null &&
        areDatesWithinOneDay(earlier.date, later.date);
      const simMerchant = areMerchantsSimilar(earlier.merchant, later.merchant);

      const conflictingTime =
        Boolean(earlier.time?.trim() && later.time?.trim()) &&
        earlier.time!.trim() !== later.time!.trim();
      const conflictingCard =
        Boolean(earlier.card_last4?.trim() && later.card_last4?.trim()) &&
        earlier.card_last4!.trim() !== later.card_last4!.trim();

      // If in different photos (or same time) without conflicting time/card
      const sameTimeOrDiffPhoto =
        !conflictingTime &&
        !conflictingCard &&
        (earlier.photo_index !== later.photo_index ||
          (earlier.time !== null && earlier.time === later.time));

      if (sameAmount && sameCurrency && closeDate && simMerchant && sameTimeOrDiffPhoto) {
        markDuplicatePair(
          earlier,
          later,
          `Same merchant, date, and total as row #${earlier.row}`
        );
      }
    }
  }

  return sortedRows;
}

export function isBoxValid(box: [number, number, number, number]): boolean {
  if (!Array.isArray(box) || box.length !== 4) return false;
  const [ymin, xmin, ymax, xmax] = box;
  if (
    typeof ymin !== "number" ||
    typeof xmin !== "number" ||
    typeof ymax !== "number" ||
    typeof xmax !== "number"
  ) {
    return false;
  }
  if (ymin < 0 || xmin < 0 || ymax > 1000 || xmax > 1000) return false;
  if (ymin >= ymax || xmin >= xmax) return false;
  return true;
}

/**
 * Removes stale model flags when a user edits/resolves a specific field in ProofPanel.
 */
export function clearResolvedModelFlags(
  flags: ReceiptFlag[] | undefined,
  field:
    | "merchant"
    | "date"
    | "currency"
    | "printed_total"
    | "handwritten_tip"
    | "final_total"
    | "tax"
): ReceiptFlag[] {
  if (!Array.isArray(flags) || flags.length === 0) return [];
  return flags.filter((f) => {
    const note = (f.note || "").toLowerCase();
    if (field === "merchant" && note.includes("merchant")) return false;
    if (field === "date" && note.includes("date")) return false;
    if (field === "currency" && note.includes("currency")) return false;
    if (
      (field === "printed_total" || field === "final_total") &&
      (note.includes("total") || note.includes("sum") || f.type === "tip_changes_total")
    ) {
      return false;
    }
    if (
      field === "handwritten_tip" &&
      (note.includes("tip") || note.includes("handwrit") || f.type === "tip_changes_total")
    ) {
      return false;
    }
    if (
      field === "tax" &&
      (note.includes("tax") || note.includes("vat") || note.includes("gst"))
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Runs all B5 code checks, currency determination,merchant grouping, and reconciliation.
 */
export function computeShoeboxEngine(
  rows: ReceiptRow[],
  totalPhotos: number
): {
  computedRows: ComputedRow[];
  merchantTiles: MerchantTileData[];
  reconciliation: ReconciliationResult;
} {
  // Determine main currency: the currency with the highest total spend (or highest receipt count if 0 spend)
  const currencySpend = new Map<string, number>();
  const currencyCount = new Map<string, number>();

  for (const r of rows) {
    if (r.excluded) continue;
    const code = (r.currency || "USD").toUpperCase().trim() || "USD";
    const rawTotal =
      r.printed_total !== null && r.handwritten_tip !== null && r.handwritten_tip > 0
        ? r.printed_total + r.handwritten_tip
        : r.final_total ?? r.printed_total ?? 0;
    currencySpend.set(code, (currencySpend.get(code) || 0) + Math.max(0, rawTotal));
    currencyCount.set(code, (currencyCount.get(code) || 0) + 1);
  }

  let mainCurrency =
    (rows.find((r) => r.currency && r.currency.trim())?.currency || "USD")
      .toUpperCase()
      .trim() || "USD";
  let maxCount = -1;
  let maxSpend = -1;
  // Choose currency with most receipts / spend in normalized terms
  for (const [code, count] of currencyCount.entries()) {
    const spend = currencySpend.get(code) || 0;
    if (count > maxCount || (count === maxCount && spend > maxSpend)) {
      maxCount = count;
      maxSpend = spend;
      mainCurrency = code;
    }
  }

  const CONFIDENCE_THRESHOLD = 0.85;

  const computedRows: ComputedRow[] = rows.map((row) => {
    const effectiveCurrency = (row.currency || mainCurrency).toUpperCase().trim() || mainCurrency;
    const isForeign = effectiveCurrency !== mainCurrency;

    const conf = row.confidence || {
      merchant: 1,
      date: 1,
      printed_total: 1,
      handwritten_tip: 1,
      currency: 1,
      tax: 1,
    };

    const codeFlags: ReceiptFlag[] = [];
    const modelFlags: ReceiptFlag[] = (row.flags || [])
      .filter((f) => {
        const note = (f.note || "").toLowerCase();
        // Ignore model flags complaining about optional fields simply not being printed
        if (
          (f.type === "unreadable_field" || f.type === "low_confidence") &&
          (note.includes("tip") ||
            note.includes("time") ||
            note.includes("item") ||
            note.includes("card") ||
            note.includes("not shown") ||
            note.includes("not printed") ||
            note.includes("not present") ||
            note.includes("no tax") ||
            note.includes("none"))
        ) {
          return false;
        }
        // If user edited & resolved a field in ProofPanel, clear stale model flags for that field
        if (f.type === "unreadable_field" || f.type === "low_confidence") {
          if (
            (note.includes("tax") || note.includes("vat") || note.includes("gst")) &&
            row.tax !== null &&
            conf.tax >= CONFIDENCE_THRESHOLD
          ) {
            return false;
          }
          if (
            note.includes("merchant") &&
            row.merchant &&
            row.merchant.trim().length > 0 &&
            conf.merchant >= CONFIDENCE_THRESHOLD
          ) {
            return false;
          }
          if (
            note.includes("date") &&
            row.date &&
            row.date.trim().length > 0 &&
            conf.date >= CONFIDENCE_THRESHOLD
          ) {
            return false;
          }
          if (
            note.includes("total") &&
            (row.printed_total !== null || row.final_total !== null) &&
            conf.printed_total >= CONFIDENCE_THRESHOLD
          ) {
            return false;
          }
        }
        return true;
      })
      .map((f) => ({
        ...f,
        source: "model" as const,
      }));

    // 1. Tip arithmetic check in code (B5)
    let codeCalculatedTotal = 0;
    let tipMismatch = false;

    const hasTip = row.handwritten_tip !== null && row.handwritten_tip > 0;
    if (hasTip && row.printed_total !== null) {
      const minorPrinted = toMinorUnits(row.printed_total, effectiveCurrency);
      const minorTip = toMinorUnits(row.handwritten_tip!, effectiveCurrency);
      const minorSum = minorPrinted + minorTip;
      codeCalculatedTotal = fromMinorUnits(minorSum, effectiveCurrency);

      if (row.final_total !== null) {
        const minorFinal = toMinorUnits(row.final_total, effectiveCurrency);
        if (Math.abs(minorSum - minorFinal) >= 1) {
          tipMismatch = true;
          codeFlags.push({
            type: "tip_changes_total",
            note: `printed + tip (${formatCurrencyAmount(
              codeCalculatedTotal,
              effectiveCurrency
            )}) ≠ final (${formatCurrencyAmount(row.final_total, effectiveCurrency)})`,
            source: "code",
          });
        }
      }

      if (
        !modelFlags.some((f) => f.type === "tip_changes_total") &&
        !codeFlags.some((f) => f.type === "tip_changes_total")
      ) {
        codeFlags.push({
          type: "tip_changes_total",
          note: "tip changes total",
          source: "code",
        });
      }
    } else if (row.final_total !== null) {
      codeCalculatedTotal = row.final_total;
      if (row.printed_total !== null) {
        const minorPrinted = toMinorUnits(row.printed_total, effectiveCurrency);
        const minorFinal = toMinorUnits(row.final_total, effectiveCurrency);
        if (Math.abs(minorPrinted - minorFinal) >= 1) {
          tipMismatch = true;
          codeFlags.push({
            type: "tip_changes_total",
            note: `printed (${formatCurrencyAmount(
              row.printed_total,
              effectiveCurrency
            )}) ≠ final (${formatCurrencyAmount(
              row.final_total,
              effectiveCurrency
            )})`,
            source: "code",
          });
        }
      }
    } else if (row.printed_total !== null) {
      codeCalculatedTotal = row.printed_total;
    } else {
      codeCalculatedTotal = 0;
      codeFlags.push({
        type: "unreadable_field",
        note: "check: total unreadable",
        source: "code",
      });
    }

    // 2. Unsure fields & confidence checks (< 0.85 or null required fields per B5)
    if (!row.merchant || !row.merchant.trim()) {
      codeFlags.push({
        type: "unreadable_field",
        note: "check: merchant unreadable",
        source: "code",
      });
    } else if (conf.merchant < CONFIDENCE_THRESHOLD) {
      codeFlags.push({
        type: "low_confidence",
        note: `check: merchant (${Math.round(conf.merchant * 100)}%)`,
        source: "code",
      });
    }

    if (!row.date || !row.date.trim()) {
      codeFlags.push({
        type: "unreadable_field",
        note: "check: date unreadable",
        source: "code",
      });
    } else if (conf.date < CONFIDENCE_THRESHOLD) {
      codeFlags.push({
        type: "low_confidence",
        note: `check: date (${Math.round(conf.date * 100)}%)`,
        source: "code",
      });
    }

    if (conf.printed_total < CONFIDENCE_THRESHOLD) {
      codeFlags.push({
        type: "low_confidence",
        note: `check: total (${Math.round(conf.printed_total * 100)}%)`,
        source: "code",
      });
    }

    if (hasTip && conf.handwritten_tip < CONFIDENCE_THRESHOLD) {
      codeFlags.push({
        type: "low_confidence",
        note: `check: tip (${Math.round(conf.handwritten_tip * 100)}%)`,
        source: "code",
      });
    }

    if (!row.currency || !row.currency.trim()) {
      codeFlags.push({
        type: "unreadable_field",
        note: "check: currency unreadable",
        source: "code",
      });
    } else if (conf.currency < CONFIDENCE_THRESHOLD) {
      codeFlags.push({
        type: "low_confidence",
        note: `check: currency (${Math.round(conf.currency * 100)}%)`,
        source: "code",
      });
    }

    if (row.tax === null && row.tax_label !== null && row.tax_label.trim() !== "") {
      if (!modelFlags.some((f) => f.note.toLowerCase().includes("tax"))) {
        codeFlags.push({
          type: "unreadable_field",
          note: "check: tax unreadable",
          source: "code",
        });
      }
    } else if (row.tax !== null && conf.tax > 0 && conf.tax < CONFIDENCE_THRESHOLD) {
      if (!modelFlags.some((f) => f.note.toLowerCase().includes("tax"))) {
        codeFlags.push({
          type: "low_confidence",
          note: `check: tax (${Math.round(conf.tax * 100)}%)`,
          source: "code",
        });
      }
    }

    // 3. Out-of-range photo_index or bounding box check (B5)
    if (row.photo_index < 1 || row.photo_index > Math.max(1, totalPhotos)) {
      codeFlags.push({
        type: "low_confidence",
        note: `check: photo index ${row.photo_index} out of range`,
        source: "code",
      });
    }

    if (!isBoxValid(row.box_2d)) {
      codeFlags.push({
        type: "low_confidence",
        note: "check: receipt box out of bounds",
        source: "code",
      });
    }

    // 4. Duplicate flag (including cross-source duplicates)
    if (row.duplicate_of) {
      const earlierTarget = rows.find((r) => r.row === row.duplicate_of);
      const isCrossSource =
        (row.flags || []).some((f) => f.type === "cross_source_duplicate") ||
        Boolean(
          row.duplicate_reason &&
            row.duplicate_reason.toLowerCase().includes("cross-source")
        ) ||
        Boolean(earlierTarget && isCrossSourceDuplicatePair(earlierTarget, row));

      if (isCrossSource) {
        const crossNote =
          row.duplicate_reason ||
          (earlierTarget
            ? `Cross-source duplicate of #${row.duplicate_of} (${formatSourceShort(
                earlierTarget
              )} vs ${formatSourceShort(row)})`
            : `Cross-source duplicate of #${row.duplicate_of}`);
        codeFlags.push({
          type: "cross_source_duplicate",
          note: crossNote,
          source: "code",
        });
      } else {
        codeFlags.push({
          type: "possible_duplicate",
          note: `possible duplicate of #${row.duplicate_of}`,
          source: "code",
        });
      }
    }

    // 5. Foreign currency flag
    if (isForeign) {
      if (!modelFlags.some((f) => f.type === "foreign_currency")) {
        codeFlags.push({
          type: "foreign_currency",
          note: `kept in ${effectiveCurrency}`,
          source: "code",
        });
      }
    }

    // 6. Missing Tax Invoice B2B policy flag
    const isNotAReceipt = modelFlags.some((f) => f.type === "not_a_receipt");
    const hasTaxIdOrVat = Boolean(row.tax_id_or_vat && row.tax_id_or_vat.trim());
    if (
      !row.excluded &&
      !isNotAReceipt &&
      (row.printed_total !== null || row.final_total !== null) &&
      codeCalculatedTotal >= 75 &&
      row.tax === null &&
      !hasTaxIdOrVat &&
      row.is_tax_invoice === false
    ) {
      codeFlags.push({
        type: "missing_tax_invoice",
        note: "Over 75.00 without itemized tax or VAT invoice details",
        source: "code",
      });
    }

    // Merge flags without duplicate notes
    const allFlags: ReceiptFlag[] = [...codeFlags];
    for (const mf of modelFlags) {
      if (
        (mf.type === "possible_duplicate" ||
          mf.type === "cross_source_duplicate") &&
        !row.duplicate_of
      ) {
        // Ignore unverified model duplicate claims; only show code-verified duplicates
        continue;
      }
      const alreadyPresent = allFlags.some(
        (cf) =>
          cf.type === mf.type &&
          cf.note.toLowerCase() === mf.note.toLowerCase()
      );
      if (!alreadyPresent) {
        allFlags.push(mf);
      }
    }

    // Determine if this row counts towards "N to check"
    // If the user explicitly marked the row checked in ProofPanel (and it has a valid total & box), clear its check status
    const hasBlockingUnresolvedError =
      tipMismatch ||
      (row.printed_total === null && row.final_total === null) ||
      !isBoxValid(row.box_2d);

    const rawNeedsCheck =
      tipMismatch ||
      allFlags.some(
        (f) =>
          f.type === "possible_duplicate" ||
          f.type === "cross_source_duplicate" ||
          f.type === "missing_tax_invoice" ||
          f.type === "unreadable_field" ||
          f.type === "low_confidence" ||
          f.type === "not_a_receipt"
      );

    const needsCheck = row.checked
      ? hasBlockingUnresolvedError
      : rawNeedsCheck;

    // Choose concise primary flag label for the receipt list row
    let primaryFlagLabel: string | null = null;
    if (allFlags.some((f) => f.type === "cross_source_duplicate")) {
      primaryFlagLabel = row.duplicate_of
        ? `Cross-source duplicate of #${row.duplicate_of}`
        : "Cross-source duplicate";
    } else if (row.duplicate_of) {
      primaryFlagLabel = `possible duplicate of #${row.duplicate_of}`;
    } else if (tipMismatch) {
      primaryFlagLabel = `check: tip sum (${formatCurrencyAmount(
        codeCalculatedTotal,
        effectiveCurrency
      )}) ≠ final (${formatCurrencyAmount(row.final_total, effectiveCurrency)})`;
    } else if (
      allFlags.some(
        (f) =>
          (f.type === "unreadable_field" || f.type === "low_confidence") &&
          f.note.toLowerCase().includes("tax")
      )
    ) {
      const tf = allFlags.find(
        (f) =>
          (f.type === "unreadable_field" || f.type === "low_confidence") &&
          f.note.toLowerCase().includes("tax")
      )!;
      primaryFlagLabel =
        tf.type === "unreadable_field" ? "check: tax unreadable" : tf.note;
    } else if (allFlags.some((f) => f.type === "unreadable_field")) {
      const uf = allFlags.find((f) => f.type === "unreadable_field")!;
      primaryFlagLabel = uf.note.startsWith("check:")
        ? uf.note
        : `check: ${uf.note.toLowerCase()}`;
    } else if (allFlags.some((f) => f.type === "low_confidence")) {
      const lf = allFlags.find((f) => f.type === "low_confidence")!;
      primaryFlagLabel = lf.note;
    } else if (allFlags.some((f) => f.type === "not_a_receipt")) {
      primaryFlagLabel = "check: not a receipt";
    } else if (allFlags.some((f) => f.type === "missing_tax_invoice")) {
      primaryFlagLabel = "Missing tax invoice";
    }

    // User-entered conversion (B5: "Conversion only if the user enters a rate and a date; show both on the row.")
    let convertedMainTotal: number | null = null;
    if (
      isForeign &&
      row.user_conversion_rate &&
      row.user_conversion_rate > 0 &&
      row.user_conversion_date &&
      row.user_conversion_date.trim().length > 0
    ) {
      const rawConverted = codeCalculatedTotal * row.user_conversion_rate;
      convertedMainTotal = fromMinorUnits(
        toMinorUnits(rawConverted, mainCurrency),
        mainCurrency
      );
    }

    const safeCategory: ReceiptCategory = VALID_CATEGORIES.includes(
      row.category as ReceiptCategory
    )
      ? (row.category as ReceiptCategory)
      : "Other";

    return {
      ...row,
      category: safeCategory,
      code_calculated_total: codeCalculatedTotal,
      tip_mismatch: tipMismatch,
      effective_currency: effectiveCurrency,
      is_foreign: isForeign,
      converted_main_total: convertedMainTotal,
      all_flags: allFlags,
      needs_check: needsCheck,
      primary_flag_label: primaryFlagLabel,
    };
  });

  // Compute main-currency totals, category totals, and foreign-currency totals in minor units (cents)
  let sumOfRowsCents = 0;
  const categoryTotalsCents: Record<ReceiptCategory, number> = {
    Meals: 0,
    Travel: 0,
    Lodging: 0,
    Office: 0,
    Other: 0,
  };

  const foreignMap = new Map<string, { totalCents: number; count: number }>();

  for (const r of computedRows) {
    if (r.excluded) continue;

    // Does it participate in main currency total?
    if (!r.is_foreign) {
      const cents = toMinorUnits(r.code_calculated_total, mainCurrency);
      sumOfRowsCents += cents;
      categoryTotalsCents[r.category] += cents;
    } else if (r.converted_main_total !== null) {
      const cents = toMinorUnits(r.converted_main_total, mainCurrency);
      sumOfRowsCents += cents;
      categoryTotalsCents[r.category] += cents;
    } else {
      const fCents = toMinorUnits(r.code_calculated_total, r.effective_currency);
      const prev = foreignMap.get(r.effective_currency) || {
        totalCents: 0,
        count: 0,
      };
      foreignMap.set(r.effective_currency, {
        totalCents: prev.totalCents + fCents,
        count: prev.count + 1,
      });
    }
  }

  // Group into merchant tiles
  // 1. Main-currency merchants (including foreign rows only if converted by user)
  const mainMerchantGroups = new Map<string, ComputedRow[]>();
  // 2. Unconverted foreign-currency merchants (grouped by merchant + currency)
  const foreignMerchantGroups = new Map<string, { merchant: string; currency: string; rows: ComputedRow[] }>();

  for (const r of computedRows) {
    const merchantName = normalizeMerchantName(r.merchant);
    if (!r.is_foreign || r.converted_main_total !== null) {
      const key = merchantName.toLowerCase();
      const list = mainMerchantGroups.get(key) || [];
      list.push(r);
      mainMerchantGroups.set(key, list);
    } else {
      const key = `${merchantName.toLowerCase()}__${r.effective_currency}`;
      const existing = foreignMerchantGroups.get(key);
      if (existing) {
        existing.rows.push(r);
      } else {
        foreignMerchantGroups.set(key, {
          merchant: merchantName,
          currency: r.effective_currency,
          rows: [r],
        });
      }
    }
  }

  const rawMainTiles: MerchantTileData[] = [];
  for (const [, groupRows] of mainMerchantGroups.entries()) {
    const displayMerchant = normalizeMerchantName(groupRows[0].merchant);
    let tileCents = 0;
    for (const r of groupRows) {
      if (r.excluded) continue;
      const amt = !r.is_foreign
        ? r.code_calculated_total
        : r.converted_main_total || 0;
      tileCents += toMinorUnits(amt, mainCurrency);
    }
    const sharePercent =
      sumOfRowsCents > 0 ? (tileCents / sumOfRowsCents) * 100 : 0;
    const flaggedCount = groupRows.filter((r) => r.needs_check && !r.excluded).length;

    rawMainTiles.push({
      id: `main__${displayMerchant.toLowerCase()}`,
      name: displayMerchant,
      isForeign: false,
      isOtherGroup: false,
      currency: mainCurrency,
      totalCents: tileCents,
      totalAmount: fromMinorUnits(tileCents, mainCurrency),
      sharePercent,
      receipts: groupRows,
      flaggedCount,
    });
  }

  // Sort rawMainTiles descending by spend first
  rawMainTiles.sort((a, b) => b.totalCents - a.totalCents);

  // A5 Step 3: "Treemap: one tile per merchant in the main currency (the currency with the most spend),
  // sized by share of that currency's total. Merchants under 2% each are grouped into one 'Other merchants' tile."
  const majorMainTiles: MerchantTileData[] = [];
  const groupedIntoOtherTiles: MerchantTileData[] = [];

  for (let i = 0; i < rawMainTiles.length; i++) {
    const tile = rawMainTiles[i];
    const isUnderTwoPct = tile.sharePercent < 2 && rawMainTiles.length > 2;

    if (isUnderTwoPct) {
      groupedIntoOtherTiles.push(tile);
    } else {
      majorMainTiles.push(tile);
    }
  }

  const finalMainTiles: MerchantTileData[] = [...majorMainTiles];
  if (groupedIntoOtherTiles.length >= 1) {
    const combinedReceipts = groupedIntoOtherTiles
      .flatMap((t) => t.receipts)
      .sort((a, b) => a.row - b.row);
    const combinedCents = groupedIntoOtherTiles.reduce(
      (acc, t) => acc + t.totalCents,
      0
    );
    const combinedFlagged = combinedReceipts.filter(
      (r) => r.needs_check && !r.excluded
    ).length;
    finalMainTiles.push({
      id: "main__other_merchants",
      name: "Other merchants",
      isForeign: false,
      isOtherGroup: true,
      currency: mainCurrency,
      totalCents: combinedCents,
      totalAmount: fromMinorUnits(combinedCents, mainCurrency),
      sharePercent:
        sumOfRowsCents > 0 ? (combinedCents / sumOfRowsCents) * 100 : 0,
      receipts: combinedReceipts,
      flaggedCount: combinedFlagged,
    });
  }

  finalMainTiles.sort((a, b) => {
    if (a.isOtherGroup !== b.isOtherGroup) {
      return a.isOtherGroup ? 1 : -1;
    }
    return b.totalCents - a.totalCents;
  });

  // Build foreign-currency tiles (preserve all foreign currencies; never drop or convert)
  const rawForeignTiles: MerchantTileData[] = [];
  for (const [key, group] of foreignMerchantGroups.entries()) {
    let fCents = 0;
    for (const r of group.rows) {
      if (r.excluded) continue;
      fCents += toMinorUnits(r.code_calculated_total, group.currency);
    }
    const flaggedCount = group.rows.filter(
      (r) => r.needs_check && !r.excluded
    ).length;
    rawForeignTiles.push({
      id: `foreign__${key}`,
      name: group.merchant,
      isForeign: true,
      isOtherGroup: false,
      currency: group.currency,
      totalCents: fCents,
      totalAmount: fromMinorUnits(fCents, group.currency),
      sharePercent: 0,
      receipts: group.rows,
      flaggedCount,
    });
  }

  let foreignTiles: MerchantTileData[] = rawForeignTiles;
  if (rawForeignTiles.length > 2) {
    const byCurr = new Map<string, MerchantTileData[]>();
    for (const ft of rawForeignTiles) {
      const list = byCurr.get(ft.currency) || [];
      list.push(ft);
      byCurr.set(ft.currency, list);
    }
    foreignTiles = Array.from(byCurr.entries()).map(([curr, list]) => {
      if (list.length === 1) return list[0];
      const mergedReceipts = list
        .flatMap((t) => t.receipts)
        .sort((a, b) => a.row - b.row);
      const mergedCents = list.reduce((acc, t) => acc + t.totalCents, 0);
      return {
        id: `foreign__currency_${curr.toLowerCase()}`,
        name: `${curr} receipts`,
        isForeign: true,
        isOtherGroup: true,
        currency: curr,
        totalCents: mergedCents,
        totalAmount: fromMinorUnits(mergedCents, curr),
        sharePercent: 0,
        receipts: mergedReceipts,
        flaggedCount: mergedReceipts.filter((r) => r.needs_check && !r.excluded)
          .length,
      };
    });
  }

  foreignTiles.sort((a, b) => b.receipts.length - a.receipts.length);

  const merchantTiles = [...finalMainTiles, ...foreignTiles];

  // B5 Reconciliation check in code:
  // "Totals reconcile ✓ only when: sum of rows = sum of category totals = grand total, and row count = receipt boxes found."
  const sumOfCategoriesCents = Object.values(categoryTotalsCents).reduce(
    (acc, v) => acc + v,
    0
  );
  const sumOfMainTilesCents = finalMainTiles.reduce(
    (acc, t) => acc + t.totalCents,
    0
  );
  const validBoxesCount = computedRows.filter((r) => isBoxValid(r.box_2d)).length;

  let reconciles = true;
  let failureReason: string | null = null;

  if (sumOfRowsCents !== sumOfCategoriesCents) {
    reconciles = false;
    failureReason = "Row sum does not match category totals";
  } else if (sumOfRowsCents !== sumOfMainTilesCents) {
    reconciles = false;
    failureReason = "Row sum does not match merchant totals";
  } else if (computedRows.length !== validBoxesCount) {
    reconciles = false;
    failureReason = `${computedRows.length - validBoxesCount} receipt box(es) out of bounds`;
  } else if (computedRows.some((r) => !r.excluded && r.printed_total === null && r.final_total === null)) {
    reconciles = false;
    failureReason = "Unreadable total on 1 or more receipts";
  }

  const foreignTotals = Array.from(foreignMap.entries()).map(([currency, info]) => ({
    currency,
    totalCents: info.totalCents,
    totalAmount: fromMinorUnits(info.totalCents, currency),
    count: info.count,
  }));

  const sourceCounts: Record<IngestionSourceType, number> = {
    manual_upload: 0,
    drive_file: 0,
    gmail_attachment: 0,
    gmail_html: 0,
  };
  for (const r of computedRows) {
    if (r.excluded) continue;
    const st = getRowSourceType(r);
    sourceCounts[st] = (sourceCounts[st] || 0) + 1;
  }

  const crossSourceDuplicatesCount = computedRows.filter(
    (r) =>
      !r.excluded &&
      r.all_flags.some((f) => f.type === "cross_source_duplicate")
  ).length;

  const missingTaxInvoiceCount = computedRows.filter(
    (r) =>
      !r.excluded &&
      r.all_flags.some((f) => f.type === "missing_tax_invoice")
  ).length;

  const toCheckCount = computedRows.filter(
    (r) => r.needs_check && !r.excluded
  ).length;

  return {
    computedRows,
    merchantTiles,
    reconciliation: {
      reconciles,
      failureReason,
      mainCurrency,
      mainTotalCents: sumOfRowsCents,
      mainTotalAmount: fromMinorUnits(sumOfRowsCents, mainCurrency),
      categoryTotalsCents,
      sourceCounts,
      crossSourceDuplicatesCount,
      missingTaxInvoiceCount,
      foreignTotals,
      totalPhotos,
      totalReceipts: computedRows.length,
      activeReceiptsCount: computedRows.filter((r) => !r.excluded).length,
      toCheckCount,
    },
  };
}

/**
 * Computes a proportional binary-split / slice-and-dice treemap layout (0..1 normalised coordinates)
 * for any number of tiles (1..N) and assigns colors from ["blue-700", "blue-500", "white", "blue-900"]
 * so that no two adjacent tiles (or the open tile on the left edge) share a color.
 */
export function layoutTreemapTiles(
  tiles: MerchantTileData[],
  hasLeftOpenTile: boolean
): PositionedTile[] {
  if (tiles.length === 0) return [];

  // Assign visual area weights proportional to share of spend.
  // Foreign currency tiles aren't in % of spend, so give them a modest visual footprint (~5% of area each)
  const mainSum = tiles
    .filter((t) => !t.isForeign)
    .reduce((acc, t) => acc + Math.max(t.totalCents, 1), 0);

  const weighted = tiles.map((tile, idx) => {
    let weight = 1;
    if (!tile.isForeign) {
      weight = Math.max(tile.totalCents, mainSum * 0.025, 1);
    } else {
      weight = Math.max((mainSum || 100) * 0.05, 1);
    }
    return { tile, weight, rank: idx };
  });

  interface RectNode {
    tile: MerchantTileData;
    weight: number;
    rank: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }

  function layoutHorizontalRow(
    rowItems: Array<{ tile: MerchantTileData; weight: number; rank: number }>,
    x: number,
    y: number,
    w: number,
    h: number
  ): RectNode[] {
    if (rowItems.length === 0) return [];
    if (rowItems.length === 1) {
      return [{ ...rowItems[0], x, y, w, h }];
    }

    const rawTotal = rowItems.reduce((acc, it) => acc + it.weight, 0) || 1;
    const minFraction = Math.min(0.24, 0.85 / rowItems.length);
    const fractions = rowItems.map((it) =>
      Math.max(minFraction, it.weight / rawTotal)
    );
    const fracSum = fractions.reduce((acc, f) => acc + f, 0) || 1;

    let curX = x;
    return rowItems.map((it, idx) => {
      const normW =
        idx === rowItems.length - 1
          ? Math.max(0.04, x + w - curX)
          : w * (fractions[idx] / fracSum);
      const rect: RectNode = {
        ...it,
        x: curX,
        y,
        w: normW,
        h,
      };
      curX += normW;
      return rect;
    });
  }

  // Recursive balanced binary-split subdivision for larger merchant piles (7+ tiles)
  const aspectFactor = (hasLeftOpenTile ? 7 / 12 : 1) * 1.65;
  function subdivideBinary(
    items: Array<{ tile: MerchantTileData; weight: number; rank: number }>,
    x: number,
    y: number,
    w: number,
    h: number
  ): RectNode[] {
    if (items.length === 0) return [];
    if (items.length === 1) {
      return [{ ...items[0], x, y, w, h }];
    }

    const totalWeight = items.reduce((acc, it) => acc + it.weight, 0) || 1;
    const visualW = w * aspectFactor;
    const splitHorizontally = visualW >= h;

    if (items.length === 2) {
      const ratio = Math.min(
        0.68,
        Math.max(0.32, items[0].weight / totalWeight)
      );
      if (splitHorizontally) {
        const w1 = w * ratio;
        return [
          { ...items[0], x, y, w: w1, h },
          { ...items[1], x: x + w1, y, w: w - w1, h },
        ];
      } else {
        const h1 = h * ratio;
        return [
          { ...items[0], x, y, w, h: h1 },
          { ...items[1], x, y: y + h1, w, h: h - h1 },
        ];
      }
    }

    // Find split index k (1 <= k < items.length) closest to 48% of totalWeight
    let bestK = 1;
    let bestDiff = Infinity;
    let runningWeight = 0;
    for (let k = 1; k < items.length; k++) {
      runningWeight += items[k - 1].weight;
      const frac = runningWeight / totalWeight;
      const diff = Math.abs(frac - 0.48);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestK = k;
      }
    }

    const firstGroup = items.slice(0, bestK);
    const secondGroup = items.slice(bestK);
    const firstWeight = firstGroup.reduce((acc, it) => acc + it.weight, 0);
    const minRatio = Math.max(0.26, firstGroup.length / (items.length + 2));
    const maxRatio = Math.min(0.74, 1 - secondGroup.length / (items.length + 2));
    const ratio = Math.min(
      maxRatio,
      Math.max(minRatio, firstWeight / totalWeight)
    );

    if (splitHorizontally) {
      const w1 = w * ratio;
      return [
        ...subdivideBinary(firstGroup, x, y, w1, h),
        ...subdivideBinary(secondGroup, x + w1, y, w - w1, h),
      ];
    } else {
      const h1 = h * ratio;
      return [
        ...subdivideBinary(firstGroup, x, y, w, h1),
        ...subdivideBinary(secondGroup, x, y + h1, w, h - h1),
      ];
    }
  }

  let nodes: RectNode[] = [];
  if (weighted.length === 1) {
    nodes = [{ ...weighted[0], x: 0, y: 0, w: 1, h: 1 }];
  } else if (weighted.length === 2) {
    if (hasLeftOpenTile) {
      const totalW = weighted[0].weight + weighted[1].weight || 1;
      const topH = Math.min(0.64, Math.max(0.45, weighted[0].weight / totalW));
      nodes = [
        { ...weighted[0], x: 0, y: 0, w: 1, h: topH },
        { ...weighted[1], x: 0, y: topH, w: 1, h: 1 - topH },
      ];
    } else {
      nodes = layoutHorizontalRow(weighted, 0, 0, 1, 1);
    }
  } else if (weighted.length === 3) {
    const topGroup = weighted.slice(0, 1);
    const bottomGroup = weighted.slice(1);
    const topWeight = topGroup[0].weight;
    const totalWeight = weighted.reduce((acc, it) => acc + it.weight, 0) || 1;
    const topH = Math.min(0.6, Math.max(0.46, topWeight / totalWeight));
    nodes = [
      ...layoutHorizontalRow(topGroup, 0, 0, 1, topH),
      ...layoutHorizontalRow(bottomGroup, 0, topH, 1, 1 - topH),
    ];
  } else if (weighted.length === 4) {
    const topGroup = weighted.slice(0, 2);
    const bottomGroup = weighted.slice(2);
    const topWeight = topGroup.reduce((acc, it) => acc + it.weight, 0);
    const totalWeight = weighted.reduce((acc, it) => acc + it.weight, 0) || 1;
    const topH = Math.min(0.62, Math.max(0.46, topWeight / totalWeight));
    const topRow = layoutHorizontalRow(topGroup, 0, 0, 1, topH);
    const bottomRow = layoutHorizontalRow(bottomGroup, 0, topH, 1, 1 - topH);
    if (Math.abs(topRow[0].w - bottomRow[0].w) < 0.08) {
      const shiftedW =
        topRow[0].w >= 0.5
          ? Math.max(0.36, topRow[0].w - 0.12)
          : Math.min(0.64, topRow[0].w + 0.12);
      bottomRow[0].w = shiftedW;
      bottomRow[1].x = shiftedW;
      bottomRow[1].w = 1 - shiftedW;
    }
    nodes = [...topRow, ...bottomRow];
  } else if (weighted.length === 5) {
    // 5 tiles: exact ad1_results.png layout (top row: 2 largest tiles, bottom row: 3 tiles)
    const topGroup = weighted.slice(0, 2);
    const bottomGroup = weighted.slice(2);
    const topWeight = topGroup.reduce((acc, it) => acc + it.weight, 0);
    const totalWeight = weighted.reduce((acc, it) => acc + it.weight, 0) || 1;
    const topH = Math.min(0.62, Math.max(0.48, topWeight / totalWeight));
    nodes = [
      ...layoutHorizontalRow(topGroup, 0, 0, 1, topH),
      ...layoutHorizontalRow(bottomGroup, 0, topH, 1, 1 - topH),
    ];
  } else if (weighted.length === 6) {
    const topGroup = weighted.slice(0, 3);
    const bottomGroup = weighted.slice(3, 6);
    const topWeight = topGroup.reduce((acc, it) => acc + it.weight, 0);
    const totalWeight = weighted.reduce((acc, it) => acc + it.weight, 0) || 1;
    const topH = Math.min(0.58, Math.max(0.46, topWeight / totalWeight));
    nodes = [
      ...layoutHorizontalRow(topGroup, 0, 0, 1, topH),
      ...layoutHorizontalRow(bottomGroup, 0, topH, 1, 1 - topH),
    ];
  } else {
    // 7+ tiles: recursive binary-split treemap so every merchant >= 2% and every foreign currency gets its proportional block
    nodes = subdivideBinary(weighted, 0, 0, 1, 1);
  }

  // Graph coloring pass: ensure no two adjacent tiles share a colorToken,
  // and no tile touching x=0 shares "blue-900" when hasLeftOpenTile is true.
  const EPS = 0.002;
  function areRectsAdjacent(a: RectNode, b: RectNode): boolean {
    const touchX =
      Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS;
    const overlapY =
      Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;

    const touchY =
      Math.abs(a.y + a.h - b.y) < EPS || Math.abs(b.y + b.h - a.y) < EPS;
    const overlapX =
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS;

    return (touchX && overlapY) || (touchY && overlapX);
  }

  const paletteOrder: TileColorToken[] = [
    "blue-700",
    "blue-500",
    "white",
    "blue-900",
  ];
  const assignedColors: TileColorToken[] = new Array(nodes.length);

  // Build adjacency list
  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (areRectsAdjacent(nodes[i], nodes[j])) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }

  let steps = 0;
  const MAX_STEPS = 4000;

  function solveColoring(idx: number): boolean {
    if (idx === nodes.length) return true;
    if (++steps > MAX_STEPS) return false;

    const node = nodes[idx];
    // When no open tile on the left, the largest tile (idx 0) must be blue-900 (A3)
    if (!hasLeftOpenTile && idx === 0) {
      assignedColors[0] = "blue-900";
      return solveColoring(1);
    }

    for (let k = 0; k < paletteOrder.length; k++) {
      const candidate = paletteOrder[(idx + k) % paletteOrder.length];
      // Forbid blue-900 if touching the left open tile (which is blue-900)
      if (hasLeftOpenTile && node.x < EPS && candidate === "blue-900") {
        continue;
      }

      let conflict = false;
      for (const neighborIdx of adj[idx]) {
        if (neighborIdx < idx && assignedColors[neighborIdx] === candidate) {
          conflict = true;
          break;
        }
      }

      if (!conflict) {
        assignedColors[idx] = candidate;
        if (solveColoring(idx + 1)) {
          return true;
        }
      }
    }

    return false;
  }

  if (!solveColoring(0)) {
    // Fallback greedy pass if graph is large or has a 4-clique corner
    for (let i = 0; i < nodes.length; i++) {
      if (!hasLeftOpenTile && i === 0) {
        assignedColors[0] = "blue-900";
        continue;
      }
      const forbidden = new Set<TileColorToken>();
      if (hasLeftOpenTile && nodes[i].x < EPS) forbidden.add("blue-900");
      for (const nIdx of adj[i]) {
        if (nIdx < i) forbidden.add(assignedColors[nIdx]);
      }
      assignedColors[i] =
        paletteOrder.find((c) => !forbidden.has(c)) ||
        paletteOrder[i % paletteOrder.length];
    }
  }

  return nodes.map((node, i) => ({
    ...node.tile,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    colorToken: assignedColors[i],
    rank: node.rank,
  }));
}

export function generateReceiptsCsv(rows: ComputedRow[]): string {
  const headers = [
    "Row",
    "Photo Index",
    "Merchant",
    "Date",
    "Time",
    "Item Count",
    "Printed Total",
    "Handwritten Tip",
    "Final Total",
    "Code Verified Total",
    "Currency",
    "Tax",
    "Tax Label",
    "Category",
    "Card Last 4",
    "Duplicate Of Row",
    "Excluded",
    "Checked",
    "Conversion Rate",
    "Conversion Date",
    "Converted Total",
    "Flags",
    "source_type",
    "source_origin",
    "cost_center",
    "tax_id_or_vat",
    "is_tax_invoice",
  ];

  const escapeCsv = (val: unknown): string => {
    if (val === null || val === undefined) return "";
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.join(",")];
  for (const r of rows) {
    const flagsText = r.all_flags.map((f) => `${f.type}: ${f.note}`).join("; ");
    const sourceType = getRowSourceType(r);
    const sourceOrigin = getRowSourceOrigin(r);
    const costCenter = r.cost_center || r.source_meta?.costCenter || "";
    const taxIdOrVat = r.tax_id_or_vat || "";
    const isTaxInvoice =
      r.is_tax_invoice === true
        ? "Yes"
        : r.is_tax_invoice === false
        ? "No"
        : "";

    const rowValues = [
      r.row,
      r.photo_index,
      r.merchant || "",
      r.date || "",
      r.time || "",
      r.item_count ?? "",
      r.printed_total ?? "",
      r.handwritten_tip ?? "",
      r.final_total ?? "",
      r.code_calculated_total,
      r.effective_currency,
      r.tax ?? "",
      r.tax_label || "",
      r.category,
      r.card_last4 || "",
      r.duplicate_of ?? "",
      r.excluded ? "Yes" : "No",
      r.checked ? "Yes" : "No",
      r.user_conversion_rate ?? "",
      r.user_conversion_date ?? "",
      r.converted_main_total ?? "",
      flagsText,
      sourceType,
      sourceOrigin,
      costCenter,
      taxIdOrVat,
      isTaxInvoice,
    ];
    lines.push(rowValues.map(escapeCsv).join(","));
  }

  return lines.join("\n");
}
