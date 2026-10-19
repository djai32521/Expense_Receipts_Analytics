import { t } from "../i18n";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ComputedRow,
  ReceiptCategory,
  ReceiptRow,
  UploadedPhoto,
} from "../types";
import {
  clearResolvedModelFlags,
  formatCurrencyAmount,
  getCurrencySymbol,
} from "../utils/engine";
import { RollingNumber, usePrefersReducedMotion } from "./MotionPrimitives";
import { COST_CENTER_OPTIONS } from "./WorkspaceSyncModal";

interface ProofPanelProps {
  row: ComputedRow;
  allRowsInPhoto: ComputedRow[];
  navigableRows?: ComputedRow[];
  allRows?: ComputedRow[];
  photo: UploadedPhoto | undefined;
  mainCurrency: string;
  phase: "entering" | "active" | "exiting";
  onSelectRow: (rowNumber: number) => void;
  onUpdateRow: (
    rowNumber: number,
    updater: (prev: ReceiptRow) => ReceiptRow
  ) => void;
  onClose: () => void;
}

const CATEGORIES: ReceiptCategory[] = [
  "Meals",
  "Travel",
  "Lodging",
  "Office",
  "Other",
];

export const ProofPanel: React.FC<ProofPanelProps> = ({
  row,
  allRowsInPhoto,
  navigableRows = [],
  allRows = [],
  photo,
  mainCurrency,
  phase,
  onSelectRow,
  onUpdateRow,
  onClose,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [stage, setStage] = useState<number>(reducedMotion ? 5 : 0);
  const [zoomToBox, setZoomToBox] = useState<boolean>(true);
  const imageContainerRef = useRef<HTMLDivElement | null>(null);
  const [draggingCorner, setDraggingCorner] = useState<
    "nw" | "ne" | "sw" | "se" | null
  >(null);
  const frozenCameraRef = useRef<{
    scale: number;
    panX: number;
    panY: number;
  } | null>(null);

  const orderedNavRows = useMemo(
    () =>
      navigableRows.length > 0
        ? navigableRows
        : allRows.length > 0
        ? allRows
        : allRowsInPhoto,
    [navigableRows, allRows, allRowsInPhoto]
  );

  const currentNavIndex = useMemo(
    () => orderedNavRows.findIndex((r) => r.row === row.row),
    [orderedNavRows, row.row]
  );

  const prevNavRow = useMemo(() => {
    if (currentNavIndex > 0) return orderedNavRows[currentNavIndex - 1];
    if (currentNavIndex === -1 && orderedNavRows.length > 0) {
      const earlier = orderedNavRows.filter((r) => r.row < row.row);
      return earlier.length > 0 ? earlier[earlier.length - 1] : null;
    }
    return null;
  }, [orderedNavRows, currentNavIndex, row.row]);

  const nextNavRow = useMemo(() => {
    if (currentNavIndex >= 0 && currentNavIndex < orderedNavRows.length - 1) {
      return orderedNavRows[currentNavIndex + 1];
    }
    if (currentNavIndex === -1 && orderedNavRows.length > 0) {
      return orderedNavRows.find((r) => r.row > row.row) ?? orderedNavRows[0];
    }
    return null;
  }, [orderedNavRows, currentNavIndex, row.row]);

  const nextFlaggedRow = useMemo(() => {
    const pool = allRows.length > 0 ? allRows : orderedNavRows;
    if (pool.length === 0) return null;
    const poolIdx = pool.findIndex((r) => r.row === row.row);
    const startIdx = poolIdx >= 0 ? poolIdx : 0;
    for (let offset = 1; offset <= pool.length; offset++) {
      const candidate = pool[(startIdx + offset) % pool.length];
      if (
        candidate.row !== row.row &&
        candidate.needs_check &&
        !candidate.excluded
      ) {
        return candidate;
      }
    }
    return null;
  }, [allRows, orderedNavRows, row.row]);

  // Close proof panel on Escape key; navigate receipts with ArrowUp/ArrowDown when not typing in an input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) {
        return;
      }
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "SELECT" ||
        activeTag === "TEXTAREA"
      ) {
        return;
      }
      if ((e.key === "ArrowUp" || e.key === "ArrowLeft") && prevNavRow) {
        e.preventDefault();
        onSelectRow(prevNavRow.row);
      } else if (
        (e.key === "ArrowDown" || e.key === "ArrowRight") &&
        nextNavRow
      ) {
        e.preventDefault();
        onSelectRow(nextNavRow.row);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onSelectRow, prevNavRow, nextNavRow]);

  // Run staged entrance choreography from A7:
  // 0: panel grows scaleX (450ms, soft)
  // 1 (250ms): photo fades in (250ms)
  // 2 (450ms): receipt outline draws clockwise (400ms)
  // 3 (750ms): photo pans and scales to centre the box (500ms, ease-in-out)
  // 4 (950ms): "Row N" tag pops on spring; sum lines stagger in (50ms)
  useEffect(() => {
    if (reducedMotion) {
      setStage(5);
      return;
    }
    if (phase === "exiting") {
      setStage(0);
      return;
    }

    setStage(0);
    const t1 = window.setTimeout(() => setStage(1), 220);
    const t2 = window.setTimeout(() => setStage(2), 420);
    const t3 = window.setTimeout(() => setStage(3), 750);
    const t4 = window.setTimeout(() => setStage(4), 950);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
    };
  }, [row.row, phase, reducedMotion]);

  // Handle dragging bounding box corners locally at 60fps and commit once on pointerup (B5)
  const [draftBox, setDraftBox] = useState<
    [number, number, number, number] | null
  >(null);
  const draftBoxRef = useRef<[number, number, number, number] | null>(null);

  useEffect(() => {
    setDraftBox(null);
    draftBoxRef.current = null;
  }, [row.row]);

  useEffect(() => {
    if (!draggingCorner) return;

    const handlePointerMove = (e: PointerEvent) => {
      const container = imageContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const relX = Math.max(
        0,
        Math.min(1000, Math.round(((e.clientX - rect.left) / rect.width) * 1000))
      );
      const relY = Math.max(
        0,
        Math.min(1000, Math.round(((e.clientY - rect.top) / rect.height) * 1000))
      );

      let [ymin, xmin, ymax, xmax] = draftBoxRef.current ?? row.box_2d;
      const minSize = 25;
      if (draggingCorner === "nw") {
        ymin = Math.min(relY, ymax - minSize);
        xmin = Math.min(relX, xmax - minSize);
      } else if (draggingCorner === "ne") {
        ymin = Math.min(relY, ymax - minSize);
        xmax = Math.max(relX, xmin + minSize);
      } else if (draggingCorner === "sw") {
        ymax = Math.max(relY, ymin + minSize);
        xmin = Math.min(relX, xmax - minSize);
      } else if (draggingCorner === "se") {
        ymax = Math.max(relY, ymin + minSize);
        xmax = Math.max(relX, xmin + minSize);
      }
      const nextBox: [number, number, number, number] = [
        ymin,
        xmin,
        ymax,
        xmax,
      ];
      draftBoxRef.current = nextBox;
      setDraftBox(nextBox);
    };

    const handlePointerUp = () => {
      const committedBox = draftBoxRef.current;
      draftBoxRef.current = null;
      setDraftBox(null);
      frozenCameraRef.current = null;
      setDraggingCorner(null);
      if (committedBox) {
        onUpdateRow(row.row, (prev) => ({
          ...prev,
          box_2d: committedBox,
        }));
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [draggingCorner, row.row, row.box_2d, onUpdateRow]);

  const [ymin, xmin, ymax, xmax] = draftBox ?? row.box_2d;
  const boxCenterX = (xmin + xmax) / 20; // 0..100%
  const boxCenterY = (ymin + ymax) / 20; // 0..100%
  const boxWPercent = Math.max(8, (xmax - xmin) / 10);
  const boxHPercent = Math.max(8, (ymax - ymin) / 10);

  // Camera pan & scale to centre the receipt box when stage >= 3
  const shouldCameraPan =
    !reducedMotion &&
    stage >= 3 &&
    zoomToBox &&
    ymin >= 0 &&
    ymax <= 1000;

  const computedScale = shouldCameraPan
    ? Math.min(2.15, Math.max(1.18, 72 / Math.max(boxWPercent, boxHPercent)))
    : 1;
  const computedPanX = shouldCameraPan ? (50 - boxCenterX) * 0.55 : 0;
  const computedPanY = shouldCameraPan ? (50 - boxCenterY) * 0.55 : 0;

  const targetScale = draggingCorner && frozenCameraRef.current
    ? frozenCameraRef.current.scale
    : computedScale;
  const panX = draggingCorner && frozenCameraRef.current
    ? frozenCameraRef.current.panX
    : computedPanX;
  const panY = draggingCorner && frozenCameraRef.current
    ? frozenCameraRef.current.panY
    : computedPanY;

  const relevantConfidence =
    row.handwritten_tip !== null && row.handwritten_tip > 0
      ? {
          label: "tip",
          pct: Math.round((row.confidence?.handwritten_tip ?? 0.85) * 100),
        }
      : {
          label: "total",
          pct: Math.round((row.confidence?.printed_total ?? 0.95) * 100),
        };

  const currencySymbol = getCurrencySymbol(row.effective_currency);
  const sourceMeta = row.source_meta ?? photo?.sourceMeta;
  const sourceType = sourceMeta?.sourceType ?? "manual_upload";
  const effectiveCostCenter =
    row.cost_center || sourceMeta?.costCenter || "Unassigned";

  return (
    <div
      className="w-full h-full flex flex-col justify-between overflow-y-auto no-native-scrollbar select-none"
      style={{
        backgroundColor: "var(--blue-200)",
        color: "var(--blue-900)",
        padding: "var(--text-inset)",
        transformOrigin: "left center",
        transform:
          reducedMotion
            ? "none"
            : phase === "exiting"
            ? "scaleX(0)"
            : "scaleX(1)",
        opacity: reducedMotion ? (phase === "exiting" ? 0 : 1) : 1,
        transition: reducedMotion
          ? "opacity 150ms linear"
          : phase === "exiting"
          ? "transform 300ms var(--ease-in)"
          : "transform 450ms var(--ease-soft)",
      }}
    >
      {/* Top bar inside proof panel */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-2 shrink-0">
        <div className="flex flex-wrap items-center gap-3.5 text-[16px] lg:text-[18px] tabular-nums">
          <span>
            {t("Row {row}", {row: row.row})} · Photo {row.photo_index}
            {photo?.displayName ? ` · ${photo.displayName}` : ""}
          </span>
          <button
            type="button"
            onClick={() => setZoomToBox((z) => !z)}
            className="shoebox-link text-[16px] lg:text-[18px]"
          >
            {zoomToBox ? "full photo" : t("focus box")}
          </button>
        </div>

        <div className="flex items-center gap-4 text-[16px] lg:text-[18px] tabular-nums">
          {(orderedNavRows.length > 1 || Boolean(prevNavRow || nextNavRow)) && (
            <>
              <button
                type="button"
                disabled={!prevNavRow}
                onClick={() => prevNavRow && onSelectRow(prevNavRow.row)}
                className="shoebox-link text-[15px] lg:text-[17px]"
              >{t("← prev")}</button>
              <button
                type="button"
                disabled={!nextNavRow}
                onClick={() => nextNavRow && onSelectRow(nextNavRow.row)}
                className="shoebox-link text-[15px] lg:text-[17px]"
              >{t("next →")}</button>
            </>
          )}
          {nextFlaggedRow && nextFlaggedRow.row !== row.row && (
            <button
              type="button"
              onClick={() => onSelectRow(nextFlaggedRow.row)}
              className="shoebox-link text-[15px] lg:text-[17px]"
            >{t("next to check")}</button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="shoebox-link text-[18px] lg:text-[20px]"
          >{t("close")}</button>
        </div>
      </div>

      {/* Architectural Provenance Bar above the receipt image crop */}
      <div className="mb-2.5 px-3 py-2 bg-white/85 border border-[#006EFF]/30 flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#006EFF] shrink-0">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="truncate">{t("File:")}<strong>{photo?.name || `Photo ${row.photo_index}`}</strong>{" "}
            · Cost Center: <strong>{t(effectiveCostCenter)}</strong>
          </span>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          {row.duplicate_of && (
            <button
              type="button"
              onClick={() => onSelectRow(row.duplicate_of!)}
              className="shoebox-link text-[13px] text-[#006EFF]"
            >
              {t("compare with #{row}", {row: row.duplicate_of ?? ""})}
            </button>
          )}
        </div>
      </div>

      {/* Photo viewport with receipt bounding boxes */}
      <div className="relative flex-1 min-h-[150px] w-full overflow-hidden flex items-center justify-center bg-[#B0D2FC]">
        {photo?.objectUrl ? (
          <div
            className="relative max-w-full max-h-full flex items-center justify-center"
            style={{
              opacity: stage >= 1 ? 1 : 0,
              transform: `scale(${targetScale}) translate(${panX}%, ${panY}%)`,
              transition: draggingCorner
                ? "none"
                : reducedMotion
                ? "opacity 150ms linear"
                : "opacity 250ms var(--ease-out), transform 500ms var(--ease-in-out)",
            }}
          >
            <div ref={imageContainerRef} className="relative inline-block">
              {photo.mimeType === "application/pdf" ||
              photo.name.toLowerCase().endsWith(".pdf") ? (
                <div className="w-[340px] sm:w-[440px] h-[30vh] lg:h-[36vh] bg-white border border-[#006EFF] flex flex-col overflow-hidden">
                  <div className="px-3 py-1.5 bg-[#F5F9FF] border-b border-[#006EFF]/30 flex items-center justify-between gap-2 text-[12px] text-[#006EFF] shrink-0">
                    <span className="font-mono-badge px-1.5 py-0.5 bg-[#006EFF] text-white">{t("PDF RECEIPT")}</span>
                    <span className="truncate flex-1">{photo.name}</span>
                    <a
                      href={photo.objectUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shoebox-link text-[12px] shrink-0"
                    >{t("open pdf ↗")}</a>
                  </div>
                  <iframe
                    src={photo.objectUrl}
                    title={t("Receipt PDF {photo}", {photo: row.photo_index})}
                    className="w-full flex-1 border-0 bg-white"
                  />
                </div>
              ) : (
                <img
                  src={photo.objectUrl}
                  alt={t("Receipt photo {photo}", {photo: row.photo_index})}
                  referrerPolicy="no-referrer"
                  className="block max-h-[32vh] lg:max-h-[38vh] w-auto max-w-full object-contain select-none pointer-events-none"
                />
              )}

              {/* Other receipts on the same photo (click to select that row) */}
              {allRowsInPhoto
                .filter((other) => other.row !== row.row)
                .map((other) => {
                  const [oYmin, oXmin, oYmax, oXmax] = other.box_2d;
                  return (
                    <button
                      key={other.row}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectRow(other.row);
                      }}
                      title={t("Select Row {row}", {row: other.row})}
                      className="absolute border border-dashed border-[#006EFF]/60 hover:border-[#006EFF] bg-[#006EFF]/5 hover:bg-[#006EFF]/15 transition-colors cursor-pointer group"
                      style={{
                        top: `${oYmin / 10}%`,
                        left: `${oXmin / 10}%`,
                        height: `${Math.max(2, (oYmax - oYmin) / 10)}%`,
                        width: `${Math.max(2, (oXmax - oXmin) / 10)}%`,
                      }}
                    >
                      <span className="absolute -top-6 left-0 px-1.5 py-0.5 text-[13px] bg-white text-[#006EFF] tabular-nums whitespace-nowrap opacity-85 group-hover:opacity-100">
                        {t("Row {row}", {row: other.row})}
                      </span>
                    </button>
                  );
                })}

              {/* Active receipt box: 2px blue-900 clockwise SVG draw + draggable corners */}
              <div
                className="absolute pointer-events-none"
                style={{
                  top: `${ymin / 10}%`,
                  left: `${xmin / 10}%`,
                  height: `${Math.max(2, (ymax - ymin) / 10)}%`,
                  width: `${Math.max(2, (xmax - xmin) / 10)}%`,
                }}
              >
                <svg
                  className="w-full h-full overflow-visible"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  <rect
                    x="0"
                    y="0"
                    width="100"
                    height="100"
                    fill="rgba(0, 110, 255, 0.08)"
                    stroke="#006EFF"
                    strokeWidth="2"
                    vectorEffect="non-scaling-stroke"
                    pathLength="400"
                    strokeDasharray="400"
                    strokeDashoffset={stage >= 2 ? 0 : 400}
                    style={{
                      transition: reducedMotion
                        ? "opacity 150ms linear"
                        : "stroke-dashoffset 400ms var(--ease-out)",
                    }}
                  />
                </svg>

                {/* "Row N" tag popping on spring */}
                <div
                  className="absolute -top-7 left-0 px-2 py-0.5 bg-[#006EFF] text-white text-[15px] tabular-nums whitespace-nowrap"
                  style={{
                    transform:
                      stage >= 4
                        ? "scale(1) translateY(0)"
                        : "scale(0.6) translateY(6px)",
                    opacity: stage >= 4 ? 1 : 0,
                    transformOrigin: "bottom left",
                    transition: reducedMotion
                      ? "opacity 150ms linear"
                      : "transform 300ms var(--ease-spring), opacity 200ms var(--ease-out)",
                  }}
                >
                  {t("Row {row}", {row: row.row})}
                </div>

                {/* Draggable corner handles to adjust box_2d in code */}
                {(["nw", "ne", "sw", "se"] as const).map((corner) => {
                  const posClass =
                    corner === "nw"
                      ? "-top-1.5 -left-1.5 cursor-nwse-resize"
                      : corner === "ne"
                      ? "-top-1.5 -right-1.5 cursor-nesw-resize"
                      : corner === "sw"
                      ? "-bottom-1.5 -left-1.5 cursor-nesw-resize"
                      : "-bottom-1.5 -right-1.5 cursor-nwse-resize";
                  return (
                    <div
                      key={corner}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        frozenCameraRef.current = {
                          scale: computedScale,
                          panX: computedPanX,
                          panY: computedPanY,
                        };
                        setDraggingCorner(corner);
                      }}
                      title={t("Drag corner to adjust receipt bounding box")}
                      className={`pointer-events-auto absolute w-3 h-3 bg-white border-2 border-[#006EFF] ${posClass}`}
                      style={{
                        opacity: stage >= 2 ? 1 : 0,
                        transition: "opacity 200ms var(--ease-out)",
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-[18px] text-[#006EFF]/70">
            {t("Photo {photo} preview unavailable", {photo: row.photo_index})}
          </div>
        )}
      </div>

      {/* Editable proof details + 3-line sum below the photo */}
      <div className="pt-3 shrink-0 flex flex-col gap-2.5">
        {/* Active flags & verification banner when receipt has review flags or is marked checked */}
        {(row.all_flags.length > 0 || row.checked) && (
          <div
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 bg-white/75 text-[#006EFF] text-[14.5px] lg:text-[15.5px] tabular-nums"
            style={{
              opacity: stage >= 4 ? 1 : 0,
              transition: "opacity 250ms var(--ease-out)",
            }}
          >
            <span className="truncate">
              {row.checked && !row.needs_check
                ? "✓ Checked — review flags resolved"
                : `To check: ${row.all_flags.map((f) => f.note).join(" · ")}`}
            </span>

            <div className="flex flex-wrap items-center gap-4 shrink-0">
              {row.tip_mismatch && (
                <button
                  type="button"
                  onClick={() =>
                    onUpdateRow(row.row, (prev) => ({
                      ...prev,
                      final_total: row.code_calculated_total,
                      confidence: { ...prev.confidence, printed_total: 1 },
                      flags: clearResolvedModelFlags(prev.flags, "final_total"),
                    }))
                  }
                  className="shoebox-link text-[14.5px]"
                >
                  use code sum (
                  {formatCurrencyAmount(
                    row.code_calculated_total,
                    row.effective_currency
                  )}
                  )
                </button>
              )}

              {row.duplicate_of !== null && row.duplicate_of !== undefined && (
                <button
                  type="button"
                  onClick={() => onSelectRow(row.duplicate_of!)}
                  className="shoebox-link text-[14.5px]"
                >
                  {t("compare with #{row}", {row: row.duplicate_of ?? ""})}
                </button>
              )}

              <button
                type="button"
                onClick={() =>
                  onUpdateRow(row.row, (prev) => ({
                    ...prev,
                    checked: !prev.checked,
                  }))
                }
                className="shoebox-link text-[14.5px]"
              >
                {row.checked ? t("uncheck") : t("mark checked")}
              </button>
            </div>
          </div>
        )}

        {/* Editable Merchant, Date, Category, Cost Center, Tax/VAT ID, Currency */}
        <div
          className="grid grid-cols-2 md:grid-cols-12 gap-2.5 pb-2.5 border-b border-[#006EFF]/25"
          style={{
            opacity: stage >= 4 ? 1 : 0,
            transform: stage >= 4 ? "translateY(0)" : "translateY(8px)",
            transition: reducedMotion
              ? "opacity 150ms linear"
              : "opacity 300ms var(--ease-out), transform 300ms var(--ease-out)",
          }}
        >
          <label className="col-span-2 md:col-span-3 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#006EFF]/75">{t("Merchant")}</span>
            <input
              type="text"
              value={row.merchant ?? ""}
              placeholder={t("Unreadable merchant")}
              onChange={(e) =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  merchant: e.target.value || null,
                  confidence: { ...prev.confidence, merchant: 1 },
                  flags: clearResolvedModelFlags(prev.flags, "merchant"),
                }))
              }
              className="bg-white/75 focus:bg-white text-[#006EFF] px-2 py-1 text-[16px] outline-none border border-transparent focus:border-[#006EFF]"
            />
          </label>

          <label className="col-span-1 md:col-span-2 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#006EFF]/75">{t("Date")}</span>
            <input
              type="text"
              value={row.date ?? ""}
              placeholder="YYYY-MM-DD"
              onChange={(e) =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  date: e.target.value || null,
                  confidence: { ...prev.confidence, date: 1 },
                  flags: clearResolvedModelFlags(prev.flags, "date"),
                }))
              }
              className="bg-white/75 focus:bg-white text-[#006EFF] px-2 py-1 text-[16px] tabular-nums outline-none border border-transparent focus:border-[#006EFF]"
            />
          </label>

          <label className="col-span-1 md:col-span-2 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#006EFF]/75">{t("Category")}</span>
            <select
              value={row.category}
              onChange={(e) =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  category: e.target.value as ReceiptCategory,
                }))
              }
              className="bg-white/75 focus:bg-white text-[#006EFF] px-2 py-1 text-[16px] outline-none border border-transparent focus:border-[#006EFF]"
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(cat)}
                </option>
              ))}
            </select>
          </label>

          <label className="col-span-1 md:col-span-2 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#006EFF]/75">{t("Cost Center")}</span>
            <select
              value={effectiveCostCenter}
              onChange={(e) =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  cost_center: e.target.value,
                }))
              }
              className="bg-white/75 focus:bg-white text-[#006EFF] px-2 py-1 text-[15px] outline-none border border-transparent focus:border-[#006EFF]"
            >
              {COST_CENTER_OPTIONS.map((cc) => (
                <option key={cc} value={cc}>
                  {t(cc)}
                </option>
              ))}
            </select>
          </label>

          <label className="col-span-1 md:col-span-2 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#006EFF]/75">{t("Tax / VAT ID")}</span>
            <input
              type="text"
              value={row.tax_id_or_vat ?? ""}
              placeholder="None"
              onChange={(e) =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  tax_id_or_vat: e.target.value || null,
                  is_tax_invoice: e.target.value.trim()
                    ? true
                    : prev.is_tax_invoice,
                }))
              }
              className="bg-white/75 focus:bg-white text-[#006EFF] px-2 py-1 text-[15px] font-mono outline-none border border-transparent focus:border-[#006EFF]"
            />
          </label>

          <label className="col-span-2 md:col-span-1 flex flex-col gap-0.5">
            <span className="text-[13px] text-[#006EFF]/75">{t("Curr")}</span>
            <input
              type="text"
              value={row.currency ?? ""}
              maxLength={4}
              onChange={(e) =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  currency: e.target.value.toUpperCase() || null,
                  confidence: { ...prev.confidence, currency: 1 },
                  flags: clearResolvedModelFlags(prev.flags, "currency"),
                }))
              }
              className="bg-white/75 focus:bg-white text-[#006EFF] px-2 py-1 text-[16px] uppercase tabular-nums outline-none border border-transparent focus:border-[#006EFF]"
            />
          </label>
        </div>

        {/* Three-line sum (printed total, handwritten tip, final total) + metadata */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
          <div className="md:col-span-7 flex flex-col gap-1.5 text-[18px] tabular-nums">
            {/* Line 1: Printed total */}
            <div
              className="flex items-center justify-between gap-4"
              style={{
                opacity: stage >= 4 ? 1 : 0,
                transform: stage >= 4 ? "translateY(0)" : "translateY(6px)",
                transition: reducedMotion
                  ? "opacity 150ms linear"
                  : "opacity 250ms var(--ease-out) 0ms, transform 250ms var(--ease-out) 0ms",
              }}
            >
              <span>{t("Printed total")}</span>
              <div className="flex items-center gap-1">
                <span>{currencySymbol}</span>
                <input
                  type="number"
                  step="0.01"
                  value={row.printed_total ?? ""}
                  placeholder="0.00"
                  onChange={(e) => {
                    const rawVal =
                      e.target.value === "" ? null : parseFloat(e.target.value);
                    const nextPrinted = Number.isNaN(rawVal as number)
                      ? null
                      : rawVal;
                    onUpdateRow(row.row, (prev) => {
                      const hasNoTip =
                        prev.handwritten_tip === null ||
                        prev.handwritten_tip <= 0;
                      const shouldSyncFinal =
                        hasNoTip &&
                        (prev.final_total === prev.printed_total ||
                          prev.final_total === null);
                      return {
                        ...prev,
                        printed_total: nextPrinted,
                        final_total: shouldSyncFinal
                          ? nextPrinted
                          : prev.final_total,
                        confidence: { ...prev.confidence, printed_total: 1 },
                        flags: clearResolvedModelFlags(
                          prev.flags,
                          "printed_total"
                        ),
                      };
                    });
                  }}
                  className="w-28 text-right bg-white/75 focus:bg-white text-[#006EFF] px-2 py-0.5 tabular-nums outline-none border border-transparent focus:border-[#006EFF]"
                />
              </div>
            </div>

            {/* Line 2: Handwritten tip */}
            <div
              className="flex items-center justify-between gap-4"
              style={{
                opacity: stage >= 4 ? 1 : 0,
                transform: stage >= 4 ? "translateY(0)" : "translateY(6px)",
                transition: reducedMotion
                  ? "opacity 150ms linear"
                  : "opacity 250ms var(--ease-out) 50ms, transform 250ms var(--ease-out) 50ms",
              }}
            >
              <span>{t("Handwritten tip")}</span>
              <div className="flex items-center gap-1">
                <span>{currencySymbol}</span>
                <input
                  type="number"
                  step="0.01"
                  value={row.handwritten_tip ?? ""}
                  placeholder="—"
                  onChange={(e) => {
                    const val =
                      e.target.value === "" ? null : parseFloat(e.target.value);
                    onUpdateRow(row.row, (prev) => ({
                      ...prev,
                      handwritten_tip: Number.isNaN(val as number) ? null : val,
                      confidence: { ...prev.confidence, handwritten_tip: 1 },
                      flags: clearResolvedModelFlags(
                        prev.flags,
                        "handwritten_tip"
                      ),
                    }));
                  }}
                  className="w-28 text-right bg-white/75 focus:bg-white text-[#006EFF] px-2 py-0.5 tabular-nums outline-none border border-transparent focus:border-[#006EFF]"
                />
              </div>
            </div>

            {/* Line 3: Final total */}
            <div
              className="flex items-center justify-between gap-4 pt-1 border-t border-[#006EFF]/30"
              style={{
                opacity: stage >= 4 ? 1 : 0,
                transform: stage >= 4 ? "translateY(0)" : "translateY(6px)",
                transition: reducedMotion
                  ? "opacity 150ms linear"
                  : "opacity 250ms var(--ease-out) 100ms, transform 250ms var(--ease-out) 100ms",
              }}
            >
              <span>{t("Final total (code sum)")}</span>
              <div className="flex items-center gap-3">
                <RollingNumber
                  value={formatCurrencyAmount(
                    row.code_calculated_total,
                    row.effective_currency
                  )}
                  className="text-[20px]"
                />
                <input
                  type="number"
                  step="0.01"
                  value={row.final_total ?? ""}
                  placeholder="printed"
                  title={t("Receipt printed/written final total")}
                  onChange={(e) => {
                    const val =
                      e.target.value === "" ? null : parseFloat(e.target.value);
                    onUpdateRow(row.row, (prev) => ({
                      ...prev,
                      final_total: Number.isNaN(val as number) ? null : val,
                      confidence: { ...prev.confidence, printed_total: 1 },
                      flags: clearResolvedModelFlags(prev.flags, "final_total"),
                    }));
                  }}
                  className="w-24 text-right bg-white/55 focus:bg-white text-[#006EFF] px-2 py-0.5 text-[16px] tabular-nums outline-none border border-transparent focus:border-[#006EFF]"
                />
              </div>
            </div>
          </div>

          {/* Right column: Tax, Time, Items, Duplicate / Exclude, Foreign conversion */}
          <div
            className="md:col-span-5 flex flex-col gap-2 text-[16px]"
            style={{
              opacity: stage >= 4 ? 1 : 0,
              transition: "opacity 250ms var(--ease-out) 150ms",
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[#006EFF]/80">
                Tax {row.tax_label ? `(${row.tax_label})` : ""}
              </span>
              <input
                type="number"
                step="0.01"
                value={row.tax ?? ""}
                placeholder="—"
                onChange={(e) => {
                  const val =
                    e.target.value === "" ? null : parseFloat(e.target.value);
                  onUpdateRow(row.row, (prev) => ({
                    ...prev,
                    tax: Number.isNaN(val as number) ? null : val,
                    confidence: { ...prev.confidence, tax: 1 },
                    flags: clearResolvedModelFlags(prev.flags, "tax"),
                  }));
                }}
                className="w-24 text-right bg-white/75 focus:bg-white text-[#006EFF] px-2 py-0.5 tabular-nums outline-none"
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-[#006EFF]/80">{t("Items / Time")}</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  value={row.item_count ?? ""}
                  placeholder="—"
                  onChange={(e) => {
                    const val =
                      e.target.value === ""
                        ? null
                        : parseInt(e.target.value, 10);
                    onUpdateRow(row.row, (prev) => ({
                      ...prev,
                      item_count: Number.isNaN(val as number) ? null : val,
                    }));
                  }}
                  className="w-16 text-right bg-white/75 focus:bg-white text-[#006EFF] px-1.5 py-0.5 tabular-nums outline-none"
                />
                <input
                  type="text"
                  value={row.time ?? ""}
                  placeholder="—"
                  onChange={(e) =>
                    onUpdateRow(row.row, (prev) => ({
                      ...prev,
                      time: e.target.value || null,
                    }))
                  }
                  className="w-24 text-right bg-white/75 focus:bg-white text-[#006EFF] px-1.5 py-0.5 tabular-nums outline-none"
                />
              </div>
            </div>

            {/* Optional foreign currency rate + date conversion (B5) */}
            {row.is_foreign && (
              <div className="pt-1 border-t border-[#006EFF]/20 flex flex-col gap-1">
                <span className="text-[13px] text-[#006EFF]/80">
                  {t("Convert to {currency} (requires rate & date):", {currency: mainCurrency})}
                </span>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    step="0.0001"
                    placeholder="Rate"
                    value={row.user_conversion_rate ?? ""}
                    onChange={(e) => {
                      const val =
                        e.target.value === ""
                          ? null
                          : parseFloat(e.target.value);
                      onUpdateRow(row.row, (prev) => ({
                        ...prev,
                        user_conversion_rate: Number.isNaN(val as number)
                          ? null
                          : val,
                      }));
                    }}
                    className="w-20 bg-white/75 focus:bg-white text-[#006EFF] px-1.5 py-0.5 text-[14px] tabular-nums outline-none"
                  />
                  <input
                    type="text"
                    placeholder="YYYY-MM-DD"
                    value={row.user_conversion_date ?? ""}
                    onChange={(e) =>
                      onUpdateRow(row.row, (prev) => ({
                        ...prev,
                        user_conversion_date: e.target.value || null,
                      }))
                    }
                    className="flex-1 bg-white/75 focus:bg-white text-[#006EFF] px-1.5 py-0.5 text-[14px] tabular-nums outline-none"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom confidence & exclusion line */}
        <div
          className="flex flex-wrap items-center justify-between gap-4 pt-1 text-[16px] text-[#006EFF]"
          style={{
            opacity: stage >= 4 ? 1 : 0,
            transition: "opacity 250ms var(--ease-out) 160ms",
          }}
        >
          <span>
            Calculated in code · {relevantConfidence.label} read at{" "}
            {relevantConfidence.pct}% confidence
            {row.converted_main_total !== null
              ? ` · converted: ${formatCurrencyAmount(
                  row.converted_main_total,
                  mainCurrency
                )} (${row.user_conversion_date})`
              : ""}
          </span>

          <div className="flex items-center gap-5">
            {!row.excluded && (
              <button
                type="button"
                onClick={() =>
                  onUpdateRow(row.row, (prev) => ({
                    ...prev,
                    checked: !prev.checked,
                  }))
                }
                className="shoebox-link text-[16px]"
              >
                {row.checked ? "✓ checked" : t("mark checked")}
              </button>
            )}

            <button
              type="button"
              onClick={() =>
                onUpdateRow(row.row, (prev) => ({
                  ...prev,
                  excluded: !prev.excluded,
                }))
              }
              className="shoebox-link text-[16px]"
            >
              {row.excluded ? t("include in totals") : t("exclude from totals")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
