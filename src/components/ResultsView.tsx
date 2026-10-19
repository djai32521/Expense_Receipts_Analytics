import { t } from "../i18n";
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ComputedRow,
  FailedBatchInfo,
  MerchantTileData,
  PositionedTile,
  ReceiptCategory,
  ReceiptRow,
  ReconciliationResult,
  TileColorToken,
  UploadedPhoto,
} from "../types";
import {
  formatCurrencyAmount,
  formatDisplayDate,
  fromMinorUnits,
  generateReceiptsCsv,
  layoutTreemapTiles,
  toMinorUnits,
} from "../utils/engine";
import type { ReadingPhase } from "./LandingView";
import {
  CustomScrollList,
  RisingWord,
  RollingNumber,
  usePrefersReducedMotion,
} from "./MotionPrimitives";
import { ProofPanel } from "./ProofPanel";
import { COST_CENTER_OPTIONS } from "./WorkspaceSyncModal";
import {
  createAuditGmailDraft,
  getAccessToken,
  requestWorkspaceAccessToken,
  saveAuditCsvToDrive,
} from "../utils/workspaceLiveSync";

interface ResultsViewProps {
  photos: UploadedPhoto[];
  computedRows: ComputedRow[];
  merchantTiles: MerchantTileData[];
  reconciliation: ReconciliationResult;
  readingPhase?: ReadingPhase;
  failedBatches?: FailedBatchInfo[];
  onRetryFailedBatches?: () => void;
  onUpdateRow: (
    rowNumber: number,
    updater: (prev: ReceiptRow) => ReceiptRow
  ) => void;
  onChangeCostCenter?: (rowId: string, newCostCenter: string) => void;
  onAddFiles?: (files: FileList | File[]) => void;
  onOpenWorkspaceModal?: () => void;
  onNewPile: () => void;
}

export type GroupingMode = "tile" | "category" | "source" | "cost_center";

const CATEGORIES: ReceiptCategory[] = [
  "Meals",
  "Travel",
  "Lodging",
  "Office",
  "Other",
];

const FLAG_CHECK_TILE_ID = "__flagged_to_check__";

function getTileColors(token: TileColorToken): {
  bg: string;
  hoverBg: string;
  text: string;
  smallText: string;
} {
  switch (token) {
    case "blue-900":
      return {
        bg: "#006EFF",
        hoverBg: "#147AFF",
        text: "#FFFFFF",
        smallText: "#FFFFFF",
      };
    case "blue-700":
      return {
        bg: "#3389FF",
        hoverBg: "#4594FF",
        text: "#FFFFFF",
        smallText: "#FFFFFF",
      };
    case "blue-500":
      return {
        bg: "#6EAEFF",
        hoverBg: "#7EB7FF",
        text: "#FFFFFF",
        smallText: "#002B66",
      };
    case "white":
      return {
        bg: "#FFFFFF",
        hoverBg: "#F2F7FF",
        text: "#006EFF",
        smallText: "#006EFF",
      };
  }
}

function computeAdaptiveTitleFontSize(
  name: string,
  isLargeTile: boolean
): string {
  const len = Math.max(3, (name || "").trim().length);
  // Ensure words up to ~18 characters fit on a single crisp line inside 86cqi width
  const cqiByLen = Math.min(14.2, Math.max(7.0, 84 / (len * 0.56)));
  if (isLargeTile) {
    return `clamp(22px, ${cqiByLen.toFixed(1)}cqi, 78px)`;
  }
  const bottomCqi = Math.min(12.4, cqiByLen);
  return `clamp(17px, ${bottomCqi.toFixed(1)}cqi, 50px)`;
}

export const ResultsView: React.FC<ResultsViewProps> = ({
  photos,
  computedRows,
  merchantTiles,
  reconciliation,
  readingPhase = "idle",
  failedBatches = [],
  onRetryFailedBatches,
  onUpdateRow,
  onChangeCostCenter,
  onAddFiles,
  onOpenWorkspaceModal,
  onNewPile,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const addFilesInputRef = useRef<HTMLInputElement | null>(null);

  // On arrival, the largest merchant opens in cols 1–5, as in ad1_results.png (A5 Step 3)
  const [openTileId, setOpenTileId] = useState<string | null>(() =>
    merchantTiles.length > 0 ? merchantTiles[0].id : null
  );
  const [groupingMode, setGroupingMode] = useState<GroupingMode>("tile");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set()
  );

  // Proof state: when a receipt row is tapped (or automatically when only 1 merchant exists), cols 6-12 becomes ProofPanel
  const [selectedProofRow, setSelectedProofRow] = useState<number | null>(() =>
    merchantTiles.length === 1 && computedRows.length > 0
      ? computedRows[0].row
      : null
  );
  const [proofPhase, setProofPhase] = useState<
    "hidden" | "collapsing_treemap" | "entering" | "active" | "exiting"
  >(() =>
    merchantTiles.length === 1 && computedRows.length > 0 ? "active" : "hidden"
  );

  const [arrivalStage, setArrivalStage] = useState<number>(
    reducedMotion ? 5 : 0
  );
  const [listPhase, setListPhase] = useState<"entering" | "visible" | "exiting">(
    "entering"
  );
  const [exportSweeping, setExportSweeping] = useState(false);

  // FLIP animation snapshot storage: tileId -> DOMRect
  const tileElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const flipSnapshotRef = useRef<{
    rects: Map<string, DOMRect>;
    durationMs: number;
    easing: string;
  } | null>(null);
  const relayoutTimersRef = useRef<number[]>([]);
  const proofTimersRef = useRef<number[]>([]);

  const clearRelayoutTimers = () => {
    relayoutTimersRef.current.forEach((t) => window.clearTimeout(t));
    relayoutTimersRef.current = [];
  };

  const clearProofTimers = () => {
    proofTimersRef.current.forEach((t) => window.clearTimeout(t));
    proofTimersRef.current = [];
  };

  useEffect(() => {
    return () => {
      clearRelayoutTimers();
      clearProofTimers();
    };
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setArrivalStage(5);
      setListPhase("visible");
      return;
    }
    const t1 = window.setTimeout(() => setArrivalStage(1), 15);
    const t2 = window.setTimeout(() => setArrivalStage(2), 280);
    const t3 = window.setTimeout(() => {
      setArrivalStage(3);
      setListPhase("visible");
    }, 420);
    const t4 = window.setTimeout(() => setArrivalStage(4), 520);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
    };
  }, [reducedMotion]);

  useEffect(() => {
    if (
      openTileId &&
      openTileId !== FLAG_CHECK_TILE_ID &&
      !merchantTiles.some((t) => t.id === openTileId)
    ) {
      setOpenTileId(merchantTiles[0]?.id ?? null);
    }
  }, [merchantTiles, openTileId]);

  const captureFlipSnapshot = (durationMs: number, easing: string) => {
    if (reducedMotion) return;
    const rects = new Map<string, DOMRect>();
    tileElementsRef.current.forEach((el, id) => {
      if (el && el.isConnected) {
        rects.set(id, el.getBoundingClientRect());
      }
    });
    flipSnapshotRef.current = { rects, durationMs, easing };
  };

  // Run FLIP animations after DOM relayout without animating width, height, or font-size (A7 Rule 4)
  useLayoutEffect(() => {
    const snapshot = flipSnapshotRef.current;
    if (!snapshot || reducedMotion) return;
    flipSnapshotRef.current = null;

    const { rects, durationMs, easing } = snapshot;

    tileElementsRef.current.forEach((el, id) => {
      const prevRect = rects.get(id);
      if (!prevRect || !el || !el.isConnected) return;
      const nextRect = el.getBoundingClientRect();
      if (nextRect.width <= 0 || nextRect.height <= 0) return;

      const dx = prevRect.left - nextRect.left;
      const dy = prevRect.top - nextRect.top;
      const sx = prevRect.width / nextRect.width;
      const sy = prevRect.height / nextRect.height;

      if (
        Math.abs(dx) < 1 &&
        Math.abs(dy) < 1 &&
        Math.abs(sx - 1) < 0.005 &&
        Math.abs(sy - 1) < 0.005
      ) {
        return;
      }

      const bgEl = el.querySelector<HTMLElement>("[data-flip-bg]");
      const contentEl = el.querySelector<HTMLElement>("[data-flip-content]");

      if (bgEl && typeof bgEl.animate === "function") {
        bgEl.animate(
          [
            {
              transformOrigin: "0 0",
              transform: `translate3d(${dx}px, ${dy}px, 0) scale(${sx}, ${sy})`,
            },
            {
              transformOrigin: "0 0",
              transform: "translate3d(0px, 0px, 0) scale(1, 1)",
            },
          ],
          {
            duration: durationMs,
            easing,
          }
        );
      }

      if (contentEl && typeof contentEl.animate === "function") {
        contentEl.animate(
          [
            {
              transform: `translate3d(${dx}px, ${dy}px, 0)`,
              opacity: 0.85,
            },
            {
              transform: "translate3d(0px, 0px, 0)",
              opacity: 1,
            },
          ],
          {
            duration: durationMs,
            easing,
          }
        );
      }
    });
  }, [openTileId, merchantTiles, reducedMotion]);

  // Determine the currently open tile data (or the special "N to check" flagged list)
  const activeOpenTile: MerchantTileData | null = useMemo(() => {
    if (!openTileId) return null;
    if (openTileId === FLAG_CHECK_TILE_ID) {
      const flaggedRows = computedRows.filter(
        (r) => r.needs_check && !r.excluded
      );
      return {
        id: FLAG_CHECK_TILE_ID,
        name: "To check",
        isForeign: false,
        isOtherGroup: false,
        currency: reconciliation.mainCurrency,
        totalCents: 0,
        totalAmount: 0,
        sharePercent: 0,
        receipts: flaggedRows,
        flaggedCount: flaggedRows.length,
      };
    }
    return merchantTiles.find((t) => t.id === openTileId) || null;
  }, [openTileId, merchantTiles, computedRows, reconciliation.mainCurrency]);

  // Grouped accordion sections when groupingMode is "category" | "source" | "cost_center"
  const groupedSections = useMemo(() => {
    if (groupingMode === "tile") return [];

    const sourceRows = computedRows;
    const groups = new Map<string, ComputedRow[]>();

    if (groupingMode === "category") {
      for (const cat of CATEGORIES) groups.set(cat, []);
      for (const r of sourceRows) {
        const list = groups.get(r.category) || [];
        list.push(r);
        groups.set(r.category, list);
      }
    } else if (groupingMode === "source") {
      groups.set("Google Drive", []);
      groups.set("Gmail", []);
      groups.set("Manual Upload", []);
      for (const r of sourceRows) {
        const st = r.source_meta?.sourceType || "manual_upload";
        const key =
          st === "drive_file"
            ? "Google Drive"
            : st === "gmail_attachment" || st === "gmail_html"
            ? "Gmail"
            : "Manual Upload";
        const list = groups.get(key) || [];
        list.push(r);
        groups.set(key, list);
      }
    } else if (groupingMode === "cost_center") {
      for (const cc of COST_CENTER_OPTIONS) groups.set(cc, []);
      for (const r of sourceRows) {
        const cc =
          r.cost_center || r.source_meta?.costCenter || "Unassigned";
        const list = groups.get(cc) || [];
        list.push(r);
        groups.set(cc, list);
      }
    }

    return Array.from(groups.entries())
      .filter(([, list]) => list.length > 0)
      .map(([title, list]) => {
        const totalCents = list.reduce((acc, r) => {
          if (r.excluded) return acc;
          if (!r.is_foreign) {
            return (
              acc +
              toMinorUnits(
                r.code_calculated_total,
                reconciliation.mainCurrency
              )
            );
          }
          if (r.converted_main_total !== null) {
            return (
              acc +
              toMinorUnits(
                r.converted_main_total,
                reconciliation.mainCurrency
              )
            );
          }
          return acc;
        }, 0);
        return {
          id: `${groupingMode}:${title}`,
          title,
          receipts: list,
          totalAmount: fromMinorUnits(totalCents, reconciliation.mainCurrency),
        };
      });
  }, [groupingMode, computedRows, reconciliation.mainCurrency]);

  // Treemap shows every other merchant (or all merchants when no tile is open, or if only 1 merchant exists)
  const treemapSourceTiles = useMemo(() => {
    if (!activeOpenTile || activeOpenTile.id === FLAG_CHECK_TILE_ID) {
      return merchantTiles;
    }
    const remaining = merchantTiles.filter((t) => t.id !== activeOpenTile.id);
    // If there is only 1 merchant in the entire upload, keep it in treemap when Proof is closed so right side is never empty
    if (remaining.length === 0 && merchantTiles.length > 0) {
      return merchantTiles;
    }
    return remaining;
  }, [merchantTiles, activeOpenTile]);

  const positionedTiles: PositionedTile[] = useMemo(
    () => layoutTreemapTiles(treemapSourceTiles, Boolean(activeOpenTile)),
    [treemapSourceTiles, activeOpenTile]
  );

  const handleViewAllTile = (targetTileId: string) => {
    setGroupingMode("tile");
    if (
      targetTileId === openTileId &&
      proofPhase === "hidden" &&
      groupingMode === "tile"
    ) {
      return;
    }

    clearRelayoutTimers();
    if (proofPhase !== "hidden") {
      clearProofTimers();
      setProofPhase("hidden");
      setSelectedProofRow(null);
    }

    if (reducedMotion || !activeOpenTile) {
      captureFlipSnapshot(480, "cubic-bezier(0.76, 0, 0.24, 1)");
      setOpenTileId(targetTileId);
      setListPhase("visible");
      return;
    }

    setListPhase("exiting");
    const t1 = window.setTimeout(() => {
      captureFlipSnapshot(480, "cubic-bezier(0.76, 0, 0.24, 1)");
      setOpenTileId(targetTileId);
      setListPhase("entering");
      const t2 = window.setTimeout(() => {
        setListPhase("visible");
      }, 50);
      relayoutTimersRef.current.push(t2);
    }, 140);
    relayoutTimersRef.current.push(t1);
  };

  const handleMinimise = () => {
    if (!activeOpenTile) return;
    clearRelayoutTimers();
    if (proofPhase !== "hidden") {
      clearProofTimers();
      setProofPhase("hidden");
      setSelectedProofRow(null);
    }

    if (reducedMotion) {
      setOpenTileId(null);
      return;
    }

    setListPhase("exiting");
    const t1 = window.setTimeout(() => {
      captureFlipSnapshot(440, "cubic-bezier(0.25, 1, 0.5, 1)");
      setOpenTileId(null);
    }, 140);
    relayoutTimersRef.current.push(t1);
  };

  const handleSelectReceiptRow = (rowNum: number) => {
    clearProofTimers();
    if (!activeOpenTile && merchantTiles.length > 0) {
      const ownerTile =
        merchantTiles.find((t) => t.receipts.some((r) => r.row === rowNum)) ||
        merchantTiles[0];
      setOpenTileId(ownerTile.id);
      setListPhase("visible");
    }

    if (proofPhase === "active" || proofPhase === "entering") {
      setSelectedProofRow(rowNum);
      return;
    }

    setSelectedProofRow(rowNum);
    if (reducedMotion) {
      setProofPhase("active");
      return;
    }

    setProofPhase("collapsing_treemap");
    const totalCollapseTime = 220 + Math.min(positionedTiles.length, 5) * 30;
    const t1 = window.setTimeout(() => {
      setProofPhase("entering");
      const t2 = window.setTimeout(() => {
        setProofPhase("active");
      }, 400);
      proofTimersRef.current.push(t2);
    }, totalCollapseTime);
    proofTimersRef.current.push(t1);
  };

  const handleCloseProof = () => {
    clearProofTimers();
    if (reducedMotion) {
      setProofPhase("hidden");
      setSelectedProofRow(null);
      return;
    }
    setProofPhase("exiting");
    const t1 = window.setTimeout(() => {
      setProofPhase("hidden");
      setSelectedProofRow(null);
    }, 280);
    proofTimersRef.current.push(t1);
  };

  const handleUpdateRowWithFlip = (
    rowNumber: number,
    updater: (prev: ReceiptRow) => ReceiptRow
  ) => {
    captureFlipSnapshot(380, "cubic-bezier(0.25, 1, 0.5, 1)");
    onUpdateRow(rowNumber, updater);
  };

  const [confirmExportMode, setConfirmExportMode] = useState<
    "drive" | "gmail" | null
  >(null);
  const [driveFilename, setDriveFilename] = useState<string>(
    () => `shoebox-audit-${new Date().toISOString().slice(0, 10)}.csv`
  );
  const [gmailRecipient, setGmailRecipient] = useState<string>("");
  const [gmailSubject, setGmailSubject] = useState<string>(
    () =>
      `Shoebox Spend Audit Ledger (${new Date().toISOString().slice(0, 10)})`
  );
  const [isExportingWorkspace, setIsExportingWorkspace] =
    useState<boolean>(false);
  const [workspaceExportStatus, setWorkspaceExportStatus] = useState<{
    type: "success" | "error";
    message: string;
    linkUrl?: string;
    linkLabel?: string;
  } | null>(null);

  const handleExportCsv = () => {
    setExportSweeping(true);
    window.setTimeout(() => setExportSweeping(false), 350);

    const csv = generateReceiptsCsv(computedRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shoebox-receipts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleConfirmWorkspaceExport = async () => {
    if (!confirmExportMode || isExportingWorkspace) return;
    setIsExportingWorkspace(true);
    setWorkspaceExportStatus(null);

    try {
      let token = await getAccessToken();
      if (!token) {
        const authRes = await requestWorkspaceAccessToken({
          includeDrive: confirmExportMode === "drive",
          includeGmail: confirmExportMode === "gmail",
        });
        token = authRes.accessToken;
      }

      const csv = generateReceiptsCsv(computedRows);
      const cleanName =
        driveFilename.trim() ||
        `shoebox-audit-${new Date().toISOString().slice(0, 10)}.csv`;

      if (confirmExportMode === "drive") {
        const uploaded = await saveAuditCsvToDrive(token, cleanName, csv);
        setWorkspaceExportStatus({
          type: "success",
          message: `Saved "${uploaded.name}" (${computedRows.length} receipts) to Google Drive.`,
          linkUrl:
            uploaded.webViewLink ||
            `https://drive.google.com/file/d/${uploaded.id}/view`,
          linkLabel: t("Open in Drive ↗"),
        });
      } else {
        const summaryLines = [
          `Shoebox Workspace Spend Audit Summary`,
          `=====================================`,
          `Date: ${new Date().toISOString().slice(0, 10)}`,
          `Total Photos Audited: ${reconciliation.totalPhotos}`,
          `Total Receipts Extracted: ${reconciliation.totalReceipts}`,
          `Reconciled Spend (${reconciliation.mainCurrency}): ${formatCurrencyAmount(
            reconciliation.mainTotalAmount,
            reconciliation.mainCurrency
          )}`,
          ...(reconciliation.foreignTotals.length > 0
            ? [
                `Foreign Currencies: ${reconciliation.foreignTotals
                  .map((ft) =>
                    formatCurrencyAmount(ft.totalAmount, ft.currency)
                  )
                  .join(", ")}`,
              ]
            : []),
          `Items Flagged for Review: ${reconciliation.toCheckCount}`,
          ``,
          `Top Merchants:`,
          ...merchantTiles
            .slice(0, 8)
            .map(
              (tile) =>
                `- ${tile.name}: ${formatCurrencyAmount(
                  tile.totalAmount,
                  tile.currency
                )} (${tile.receipts.length} ${
                  tile.receipts.length === 1 ? t("receipt") : t("receipts")
                })`
            ),
          ``,
          `The full code-verified transaction ledger is attached as ${cleanName}.`,
        ];

        await createAuditGmailDraft(token, {
          to: gmailRecipient.trim() || undefined,
          subject:
            gmailSubject.trim() ||
            `Shoebox Spend Audit Ledger (${new Date()
              .toISOString()
              .slice(0, 10)})`,
          bodyText: summaryLines.join("\n"),
          csvFilename: cleanName,
          csvContent: csv,
        });

        setWorkspaceExportStatus({
          type: "success",
          message: `Created Gmail draft "${
            gmailSubject.trim() || "Shoebox Spend Audit Ledger"
          }" with ${computedRows.length} receipts attached.`,
          linkUrl: "https://mail.google.com/mail/u/0/#drafts",
          linkLabel: t("Open Gmail Drafts ↗"),
        });
      }
      setConfirmExportMode(null);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : t("Failed to export to Google Workspace.");
      setWorkspaceExportStatus({
        type: "error",
        message: msg,
      });
    } finally {
      setIsExportingWorkspace(false);
    }
  };

  const activeProofRowObj = useMemo(
    () =>
      selectedProofRow !== null
        ? computedRows.find((r) => r.row === selectedProofRow) || null
        : null,
    [selectedProofRow, computedRows]
  );

  const activeProofPhoto = useMemo(
    () =>
      activeProofRowObj
        ? photos.find((p) => p.globalIndex === activeProofRowObj.photo_index)
        : undefined,
    [activeProofRowObj, photos]
  );

  const allRowsInActivePhoto = useMemo(
    () =>
      activeProofRowObj
        ? computedRows.filter(
            (r) => r.photo_index === activeProofRowObj.photo_index
          )
        : [],
    [activeProofRowObj, computedRows]
  );

  const navigableRows = useMemo(() => {
    if (
      groupingMode === "tile" &&
      activeOpenTile &&
      activeOpenTile.receipts.length > 0
    ) {
      return activeOpenTile.receipts;
    }
    return computedRows;
  }, [groupingMode, activeOpenTile, computedRows]);

  const registerTileRef = (id: string, el: HTMLElement | null) => {
    if (el) {
      tileElementsRef.current.set(id, el);
    } else {
      tileElementsRef.current.delete(id);
    }
  };

  const hasB2BProvenanceOrFlags = reconciliation.missingTaxInvoiceCount > 0;

  const toggleAccordionGroup = (groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const renderReceiptRowItem = (r: ComputedRow, idx: number, totalLen: number) => {
    const isSelected = selectedProofRow === r.row;
    const animateIndex = Math.min(idx, 12);
    const rowVisible = arrivalStage >= 3 && listPhase !== "exiting";
    const staggerDelay =
      listPhase === "exiting"
        ? Math.max(0, (Math.min(totalLen, 10) - idx) * 12)
        : idx < 12
        ? animateIndex * 25
        : 0;

    const srcType = r.source_meta?.sourceType || "manual_upload";
    const srcBadge =
      srcType === "drive_file"
        ? "DRIVE"
        : srcType === "gmail_attachment" || srcType === "gmail_html"
        ? "GMAIL"
        : "UPLOAD";
    const costCenterValue =
      r.cost_center || r.source_meta?.costCenter || "Unassigned";
    const costCenterShort =
      costCenterValue !== "Unassigned" ? costCenterValue.split(" ")[0] : null;

    const hasCrossSourceDup = r.all_flags.some(
      (f) => f.type === "cross_source_duplicate"
    );

    // Show sub-note / flag pill whenever a receipt is flagged, checked, in t("To check"), or has conversion
    const showSubNote = Boolean(
      groupingMode !== "tile" ||
        activeOpenTile?.id === FLAG_CHECK_TILE_ID ||
        activeOpenTile?.isOtherGroup ||
        r.needs_check ||
        r.primary_flag_label ||
        r.duplicate_of ||
        r.tip_mismatch ||
        r.converted_main_total !== null ||
        r.checked
    );

    const itemsDisplay =
      r.item_count !== null && r.item_count > 0
        ? `${r.item_count} ${r.item_count === 1 ? t("item") : t("items")}`
        : "—";

    const timeDisplay = r.time && r.time.trim() ? r.time.trim() : "—";

    return (
      <li
        key={r.row}
        onClick={() => handleSelectReceiptRow(r.row)}
        className={`group cursor-pointer py-1.5 px-1.5 -mx-1.5 transition-colors duration-120 ${
          isSelected ? "bg-white/20" : "hover:bg-white/[0.08]"
        } ${r.excluded ? "opacity-50" : ""}`}
        style={{
          opacity: rowVisible ? (r.excluded ? 0.5 : 1) : 0,
          transform:
            rowVisible || reducedMotion ? "translateY(0)" : "translateY(8px)",
          transition: reducedMotion
            ? "opacity 150ms linear"
            : listPhase === "exiting"
            ? `opacity 140ms var(--ease-in) ${staggerDelay}ms`
            : `opacity 240ms var(--ease-out) ${staggerDelay}ms, transform 240ms var(--ease-out) ${staggerDelay}ms, background-color 120ms var(--ease-out)`,
        }}
      >
        {/* Single-line tabular row matching ad1_results.png + compact mono source & cost center badge */}
        <div
          className="grid items-baseline gap-1.5 leading-[1.35] tabular-nums min-w-0"
          style={{
            gridTemplateColumns:
              "2.2ch auto minmax(0, 1fr) minmax(0, 0.85fr) minmax(0, 0.85fr) auto",
            fontSize: "clamp(11.5px, 3.1cqi, 17px)",
          }}
        >
          <span className="text-left truncate">{r.row}</span>

          <span className="inline-flex items-center gap-1 shrink-0">
            {costCenterShort && (
              <span
                className="font-mono-badge px-1 py-0.5 leading-none bg-white/15 text-white/90 hidden sm:inline-block"
                style={{ fontSize: "9.5px" }}
              >
                {costCenterShort}
              </span>
            )}
          </span>

          <span
            className={`text-left truncate ${r.excluded ? "line-through" : ""}`}
          >
            {formatCurrencyAmount(
              r.code_calculated_total,
              r.effective_currency
            )}
          </span>
          <span className="text-left truncate">{itemsDisplay}</span>
          <span className="text-left truncate">{timeDisplay}</span>
          <span className="text-right whitespace-nowrap">
            {formatDisplayDate(r.date)}
          </span>
        </div>

        {/* Sub-note flag pill & inline verification / duplicate exclusion actions */}
        {showSubNote && (
          <div className="mt-0.5 pl-[2.5ch] flex items-center justify-between gap-2 text-[12px] text-white/85 leading-tight">
            <span className="truncate animate-pulse-once">
              {[
                (groupingMode !== "tile" ||
                  activeOpenTile?.id === FLAG_CHECK_TILE_ID ||
                  activeOpenTile?.isOtherGroup) &&
                r.merchant
                  ? r.merchant
                  : null,
                r.checked ? "✓ checked" : r.primary_flag_label,
                r.converted_main_total !== null
                  ? `converted ${formatCurrencyAmount(
                      r.converted_main_total,
                      reconciliation.mainCurrency
                    )} (${r.user_conversion_date})`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>

            <div className="flex items-center gap-3 shrink-0">
              {(r.needs_check || r.checked) && !r.excluded && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUpdateRowWithFlip(r.row, (prev) => ({
                      ...prev,
                      checked: !prev.checked,
                    }));
                  }}
                  className="shoebox-link text-[12px] shrink-0"
                >
                  {r.checked ? t("uncheck") : t("mark checked")}
                </button>
              )}

              {(r.duplicate_of || hasCrossSourceDup) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleUpdateRowWithFlip(r.row, (prev) => ({
                      ...prev,
                      excluded: !prev.excluded,
                    }));
                  }}
                  className="shoebox-link text-[12px] shrink-0"
                >
                  {r.excluded
                    ? t("include")
                    : hasCrossSourceDup
                    ? t("exclude duplicate")
                    : t("exclude")}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Expanded inline B2B audit controls when row is selected */}
        {isSelected && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="mt-1.5 pl-[2.5ch] pt-1.5 border-t border-white/25 flex flex-wrap items-center justify-between gap-2 text-[12px] text-white"
          >
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1">
                <span className="font-mono-badge text-white/75">{t("CAT:")}</span>
                <select
                  value={r.category}
                  onChange={(e) =>
                    handleUpdateRowWithFlip(r.row, (prev) => ({
                      ...prev,
                      category: e.target.value as ReceiptCategory,
                    }))
                  }
                  className="bg-white text-[#006EFF] px-1.5 py-0.5 text-[11.5px] outline-none"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {t(cat)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="inline-flex items-center gap-1">
                <span className="font-mono-badge text-white/75">{t("CC:")}</span>
                <select
                  value={costCenterValue}
                  onChange={(e) => {
                    const nextCc = e.target.value;
                    if (onChangeCostCenter) {
                      onChangeCostCenter(r.id, nextCc);
                    }
                    handleUpdateRowWithFlip(r.row, (prev) => ({
                      ...prev,
                      cost_center: nextCc,
                    }));
                  }}
                  className="bg-white text-[#006EFF] px-1.5 py-0.5 text-[11.5px] outline-none"
                >
                  {COST_CENTER_OPTIONS.map((cc) => (
                    <option key={cc} value={cc}>
                      {t(cc)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {r.tax_id_or_vat && (
              <span className="font-mono-badge text-white/90">
                Tax/VAT ID: {r.tax_id_or_vat}
              </span>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="w-full min-h-screen md:h-screen flex flex-col bg-white overflow-x-hidden md:overflow-hidden">
      {onAddFiles && (
        <input
          ref={addFilesInputRef}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.heic,.heif,.jpg,.jpeg,.png,.webp,.pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onAddFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
      )}

      {/* Main stage above footer: 12-column grid with 0px gutters */}
      <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-12 relative overflow-hidden">
        {/* COLS 1-5: Open Tile (when activeOpenTile !== null) */}
        {activeOpenTile && (
          <div
            ref={(el) => registerTileRef(activeOpenTile.id, el)}
            data-flip-tile-id={activeOpenTile.id}
            className="md:col-span-5 min-h-[440px] md:min-h-0 md:h-full relative flex flex-col select-none min-w-0 z-10"
          >
            {/* FLIP background surface (not clipped by parent so FLIP transitions are seamless) */}
            <div
              data-flip-bg
              className={`absolute inset-0 ${
                activeOpenTile.isForeign && groupingMode === "tile"
                  ? "hatch-white"
                  : ""
              }`}
              style={{ backgroundColor: "var(--blue-900)" }}
            />

            {/* FLIP counter-scaled content wrapper with inline-size container query */}
            <div
              data-flip-content
              className="relative z-10 flex-1 min-h-0 w-full h-full flex flex-col min-w-0 overflow-hidden"
              style={{
                color: "var(--white)",
                padding: "clamp(16px, 4.8cqi, 28px)",
                containerType: "inline-size",
              }}
            >
              {/* Top utility strip inside Cols 1-5: sync workspace & add files */}
              <div className="mb-2 flex flex-col gap-1.5 shrink-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-white/90">
                  <span className="font-mono-badge text-white/80">
                    {readingPhase !== "idle"
                      ? readingPhase === "checking_duplicates"
                        ? t("CHECKING DUPLICATES…")
                        : readingPhase === "adding_up"
                        ? t("RECONCILING LEDGER…")
                        : t("AUDITING NEW RECEIPTS…")
                      : t("AUDITED LEDGER")}
                  </span>
                  <div className="flex items-center gap-4">
                    {onAddFiles && (
                      <button
                        type="button"
                        onClick={() => addFilesInputRef.current?.click()}
                        className="shoebox-link text-[13px] text-white"
                      >{t("add files")}</button>
                    )}
                  </div>
                </div>
                {readingPhase !== "idle" && (
                  <div className="w-full h-[2px] bg-white/25 overflow-hidden">
                    <div className="h-full w-full bg-white animate-sweep" />
                  </div>
                )}
                {failedBatches.length > 0 && readingPhase === "idle" && (
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-white bg-white/15 px-2 py-1">
                    <span>
                      Couldn&apos;t read photos{" "}
                      {failedBatches
                        .map((b) =>
                          b.startPhotoIndex === b.endPhotoIndex
                            ? `${b.startPhotoIndex}`
                            : `${b.startPhotoIndex}–${b.endPhotoIndex}`
                        )
                        .join(", ")}
                    </span>
                    {onRetryFailedBatches && (
                      <button
                        type="button"
                        onClick={onRetryFailedBatches}
                        className="shoebox-link text-[12.5px] text-white"
                      >{t("try again")}</button>
                    )}
                  </div>
                )}
              </div>

              {/* Open tile header: Merchant name (or grouping title), N receipts, X% of spend, N to check, minimise */}
              <div className="shrink-0 min-w-0">
                <h1
                  className="m-0 tracking-[-0.02em] leading-[0.94] min-w-0"
                  style={{
                    fontSize: computeAdaptiveTitleFontSize(
                      groupingMode === "category"
                        ? t("By category")
                        : groupingMode === "source"
                        ? t("By source")
                        : groupingMode === "cost_center"
                        ? t("By cost center")
                        : activeOpenTile.name,
                      true
                    ),
                  }}
                >
                  <RisingWord
                    text={
                      groupingMode === "category"
                        ? t("By category")
                        : groupingMode === "source"
                        ? t("By source")
                        : groupingMode === "cost_center"
                        ? t("By cost center")
                        : activeOpenTile.name
                    }
                    visible={arrivalStage >= 2}
                    baseDelayMs={0}
                    letterStaggerMs={16}
                    letterByLetter={true}
                  />
                </h1>

                <div
                  className="mt-2 flex items-end justify-between gap-3 min-w-0"
                  style={{
                    opacity: arrivalStage >= 2 ? 1 : 0,
                    transform:
                      arrivalStage >= 2 || reducedMotion
                        ? "translateY(0)"
                        : "translateY(8px)",
                    transition: reducedMotion
                      ? "opacity 150ms linear"
                      : "opacity 280ms var(--ease-out), transform 280ms var(--ease-out)",
                  }}
                >
                  <div
                    className="flex flex-col leading-[1.18] tabular-nums min-w-0"
                    style={{ fontSize: "clamp(13.5px, 4.3cqi, 24px)" }}
                  >
                    <span className="truncate">
                      <RollingNumber
                        value={
                          groupingMode === "tile"
                            ? activeOpenTile.receipts.length
                            : computedRows.length
                        }
                      />{" "}
                      {(groupingMode === "tile"
                        ? activeOpenTile.receipts.length
                        : computedRows.length) === 1
                        ? t("receipt")
                        : t("receipts")}
                    </span>
                    {groupingMode !== "tile" ? (
                      <span className="truncate">
                        {t("Total")}{" "}
                        {formatCurrencyAmount(
                          reconciliation.mainTotalAmount,
                          reconciliation.mainCurrency
                        )}{" "}
                        · {groupedSections.length}{" "}
                        {groupedSections.length === 1 ? t("group") : t("groups")}
                      </span>
                    ) : activeOpenTile.id === FLAG_CHECK_TILE_ID ? (
                      <span className="truncate">{t("flagged for review")}</span>
                    ) : activeOpenTile.isForeign ? (
                      <span className="mt-0.5 truncate">
                        {formatCurrencyAmount(
                          activeOpenTile.totalAmount,
                          activeOpenTile.currency
                        )}{" "}
                        · kept in {activeOpenTile.currency} · not in % of spend
                      </span>
                    ) : (
                      <span className="truncate">
                        <RollingNumber
                          value={
                            activeOpenTile.sharePercent >= 10 ||
                            activeOpenTile.sharePercent === 0
                              ? Math.round(activeOpenTile.sharePercent)
                              : Number(activeOpenTile.sharePercent.toFixed(1))
                          }
                          startFromZero={true}
                        />{t("% of spend")}</span>
                    )}
                    {activeOpenTile.id !== FLAG_CHECK_TILE_ID &&
                      activeOpenTile.flaggedCount > 0 &&
                      groupingMode === "tile" && (
                        <span className="truncate">
                          <RollingNumber value={activeOpenTile.flaggedCount} />{" "}
                          to check
                        </span>
                      )}
                  </div>

                  <button
                    type="button"
                    onClick={handleMinimise}
                    className={`shoebox-link shrink-0 mb-1 ${
                      arrivalStage < 2 && !reducedMotion
                        ? "underline-draw-hidden"
                        : ""
                    }`}
                    style={{ fontSize: "clamp(13.5px, 4.3cqi, 24px)" }}
                  >{t("minimise")}</button>
                </div>

                {/* B2B audit summary line when missing tax ID flags exist */}
                {hasB2BProvenanceOrFlags && (
                  <div className="mt-2 font-mono-badge text-white/85 truncate">
                    {`${reconciliation.missingTaxInvoiceCount} missing tax ID`}
                  </div>
                )}

                {/* Grouping Mode Toggle: by category | by cost center */}
                <div className="mt-2.5 pt-2 border-t border-white/25 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px]">
                  <button
                    type="button"
                    onClick={() => setGroupingMode("tile")}
                    className={`shoebox-link ${
                      groupingMode === "tile"
                        ? "text-white"
                        : "text-white/65 hover:text-white"
                    }`}
                  >{t("selected tile")}</button>
                  <button
                    type="button"
                    onClick={() =>
                      setGroupingMode((m) =>
                        m === "category" ? "tile" : "category"
                      )
                    }
                    className={`shoebox-link ${
                      groupingMode === "category"
                        ? "text-white"
                        : "text-white/65 hover:text-white"
                    }`}
                  >{t("by category")}</button>
                  <button
                    type="button"
                    onClick={() =>
                      setGroupingMode((m) =>
                        m === "cost_center" ? "tile" : "cost_center"
                      )
                    }
                    className={`shoebox-link ${
                      groupingMode === "cost_center"
                        ? "text-white"
                        : "text-white/65 hover:text-white"
                    }`}
                  >{t("by cost center")}</button>
                </div>
              </div>

              {/* Hairline rule (draws scaleX from left in 300ms) */}
              <div
                className="w-full h-[1px] bg-white/55 my-3 shrink-0"
                style={{
                  transformOrigin: "left center",
                  transform:
                    arrivalStage >= 3 || reducedMotion
                      ? "scaleX(1)"
                      : "scaleX(0)",
                  transition: reducedMotion
                    ? "opacity 150ms linear"
                    : "transform 280ms var(--ease-out)",
                }}
              />

              {/* Scrollable receipt list or collapsible grouped accordion inside the open tile */}
              <CustomScrollList theme="on-blue" fadeLastVisibleRow={true}>
                {groupingMode !== "tile" ? (
                  groupedSections.length === 0 ? (
                    <div className="py-6 text-[17px] text-white/80">{t("No receipts in this view.")}</div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {groupedSections.map((sec) => {
                        const isCollapsed = collapsedGroups.has(sec.id);
                        return (
                          <div
                            key={sec.id}
                            className="border-b border-white/20 pb-2"
                          >
                            <button
                              type="button"
                              onClick={() => toggleAccordionGroup(sec.id)}
                              className="w-full py-1 flex items-center justify-between gap-2 text-left text-white cursor-pointer hover:bg-white/10 px-1.5 -mx-1.5 transition-colors"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[12px] text-white/80">
                                  {isCollapsed ? "▸" : "▾"}
                                </span>
                                <span className="font-mono-badge px-1.5 py-0.5 bg-white text-[#006EFF] truncate">
                                  {sec.title}
                                </span>
                                <span className="text-[13px] text-white/85 tabular-nums">
                                  ({sec.receipts.length})
                                </span>
                              </div>
                              <span className="text-[13.5px] tabular-nums shrink-0">
                                {formatCurrencyAmount(
                                  sec.totalAmount,
                                  reconciliation.mainCurrency
                                )}
                              </span>
                            </button>

                            {!isCollapsed && (
                              <ul className="m-0 mt-1 p-0 list-none flex flex-col">
                                {sec.receipts.map((r, idx) =>
                                  renderReceiptRowItem(
                                    r,
                                    idx,
                                    sec.receipts.length
                                  )
                                )}
                              </ul>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )
                ) : activeOpenTile.receipts.length === 0 ? (
                  <div className="py-6 text-[17px] text-white/80">
                    {activeOpenTile.id === FLAG_CHECK_TILE_ID
                      ? t("All flagged receipts have been checked ✓")
                      : t("No receipts in this view.")}
                  </div>
                ) : (
                  <ul className="m-0 p-0 list-none flex flex-col">
                    {activeOpenTile.receipts.map((r, idx) =>
                      renderReceiptRowItem(
                        r,
                        idx,
                        activeOpenTile.receipts.length
                      )
                    )}
                  </ul>
                )}
              </CustomScrollList>
            </div>
          </div>
        )}

        {/* COLS 6-12 (or COLS 1-12 when minimised): Treemap OR Proof Panel */}
        <div
          className={`${
            activeOpenTile ? "md:col-span-7" : "md:col-span-12"
          } min-h-[420px] md:min-h-0 md:h-full relative overflow-hidden`}
          style={{
            backgroundColor:
              arrivalStage >= 2 ? "var(--blue-900)" : "var(--white)",
          }}
        >
          {(proofPhase === "entering" ||
            proofPhase === "active" ||
            proofPhase === "exiting") &&
          activeProofRowObj ? (
            <ProofPanel
              row={activeProofRowObj}
              allRowsInPhoto={allRowsInActivePhoto}
              navigableRows={navigableRows}
              allRows={computedRows}
              photo={activeProofPhoto}
              mainCurrency={reconciliation.mainCurrency}
              phase={
                proofPhase === "exiting"
                  ? "exiting"
                  : proofPhase === "entering"
                  ? "entering"
                  : "active"
              }
              onSelectRow={(rNum) => setSelectedProofRow(rNum)}
              onUpdateRow={handleUpdateRowWithFlip}
              onClose={handleCloseProof}
            />
          ) : positionedTiles.length === 0 ? (
            <div
              className="w-full h-full flex flex-col items-start justify-between select-none"
              style={{
                backgroundColor: "var(--blue-700)",
                color: "var(--white)",
                padding: "var(--text-inset)",
              }}
            >
              <div>
                <h2
                  className="m-0 tracking-[-0.02em] leading-[0.94]"
                  style={{ fontSize: "clamp(32px, 4.5vw, 68px)" }}
                >{t("No receipts found")}</h2>
                <p className="m-0 mt-3 text-[19px] text-white/90">
                  We couldn&apos;t detect any physical receipts in the uploaded
                  photos. Try uploading a clearer photo.
                </p>
              </div>
              <button
                type="button"
                onClick={onNewPile}
                className="shoebox-link text-[22px]"
              >{t("Upload another photo")}</button>
            </div>
          ) : (
            <>
              {/* Desktop absolute-positioned proportional 2-row Poster Treemap (0px gaps) */}
              <div className="hidden md:block w-full h-full relative">
                {positionedTiles.map((tile, idx) => (
                  <TreemapTileItem
                    key={tile.id}
                    tile={tile}
                    index={idx}
                    totalTiles={positionedTiles.length}
                    arrivalStage={arrivalStage}
                    isCollapsingForProof={proofPhase === "collapsing_treemap"}
                    registerRef={(el) => registerTileRef(tile.id, el)}
                    onViewAll={() => handleViewAllTile(tile.id)}
                  />
                ))}
              </div>

              {/* Mobile (< 768px) stacked full-width tiles in rank order (A4) */}
              <div className="flex md:hidden flex-col w-full">
                {positionedTiles.map((tile, idx) => (
                  <TreemapTileItem
                    key={tile.id}
                    tile={tile}
                    index={idx}
                    totalTiles={positionedTiles.length}
                    arrivalStage={arrivalStage}
                    isCollapsingForProof={proofPhase === "collapsing_treemap"}
                    isMobileStack={true}
                    registerRef={() => {}}
                    onViewAll={() => handleViewAllTile(tile.id)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* FOOTER BAR: cols 1-12, white, 60px height on desktop (A4 & A5 Step 3 & B7) */}
      <footer
        className="w-full md:h-[60px] bg-white text-[#006EFF] px-4 md:px-[var(--text-inset)] py-2.5 md:py-0 flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4 shrink-0 select-none z-20"
        style={{
          transformOrigin: "center bottom",
          transform:
            arrivalStage >= 4 || reducedMotion ? "scaleY(1)" : "scaleY(0)",
          opacity: reducedMotion ? (arrivalStage >= 4 ? 1 : 0) : 1,
          transition: reducedMotion
            ? "opacity 150ms linear"
            : "transform 280ms var(--ease-out)",
        }}
      >
        {/* Left: Summary + reconciliation check + provenance summary / guardrail line */}
        <div className="flex flex-col justify-center min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14px] lg:text-[15.5px] leading-[1.2] tabular-nums truncate">
            <span>
              <RollingNumber value={reconciliation.totalPhotos} />{" "}
              {reconciliation.totalPhotos === 1 ? t("photo") : t("photos")}
            </span>
            <span>·</span>
            <span>
              <RollingNumber value={reconciliation.totalReceipts} />{" "}
              {reconciliation.totalReceipts === 1 ? t("receipt") : t("receipts")}
            </span>
            <span>·</span>
            <span>
              {t("Total")}{" "}
              <RollingNumber
                value={formatCurrencyAmount(
                  reconciliation.mainTotalAmount,
                  reconciliation.mainCurrency
                )}
              />
            </span>

            {reconciliation.reconciles ? (
              <span className="inline-flex items-center gap-1">
                <svg
                  className="w-3.5 h-3.5 text-[#006EFF] inline-block"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <path
                    d="M2.5 8.5L6.2 12L13.5 4"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="square"
                    pathLength="20"
                    strokeDasharray="20"
                    strokeDashoffset={arrivalStage >= 4 ? 0 : 20}
                    style={{
                      transition: "stroke-dashoffset 300ms var(--ease-out)",
                    }}
                  />
                </svg>
                <span>{t("reconciles")}</span>
              </span>
            ) : (
              <span>
                ⚠ Totals don&apos;t reconcile
                {reconciliation.failureReason
                  ? ` (${reconciliation.failureReason})`
                  : ""}
              </span>
            )}

            {reconciliation.foreignTotals.slice(0, 2).map((ft) => (
              <React.Fragment key={ft.currency}>
                <span>·</span>
                <span>
                  <RollingNumber
                    value={formatCurrencyAmount(ft.totalAmount, ft.currency)}
                  />{" "}
                  {t("kept in {currency}", {currency: ft.currency})}
                </span>
              </React.Fragment>
            ))}
          </div>

          <p className="m-0 mt-0.5 text-[11px] lg:text-[11.5px] text-[#006EFF]/75 leading-tight truncate hidden sm:block">
            {hasB2BProvenanceOrFlags ? (
              <span className="font-mono-badge mr-2">
                {`${reconciliation.missingTaxInvoiceCount} missing tax ID · `}
              </span>
            ) : null}
            <span>{t("Categories are suggestions, not tax advice. Currencies kept as printed.")}</span>
          </p>
        </div>

        {/* Right actions */}
        <div className="flex flex-wrap items-center justify-between md:justify-end gap-4 lg:gap-6 shrink-0 text-[14px] lg:text-[15.5px] pb-0.5">
          {onAddFiles && (
            <button
              type="button"
              onClick={() => addFilesInputRef.current?.click()}
              className="shoebox-link"
            >{t("add files")}</button>
          )}

          <button
            type="button"
            onClick={() => handleViewAllTile(FLAG_CHECK_TILE_ID)}
            className="shoebox-link tabular-nums"
          >
            <RollingNumber value={reconciliation.toCheckCount} />{t("to check")}</button>

          <button
            type="button"
            onClick={handleExportCsv}
            className={`shoebox-link ${exportSweeping ? "sweeping" : ""}`}
          >{t("Export CSV")}</button>

          <button type="button" onClick={onNewPile} className="shoebox-link">{t("New pile")}</button>
        </div>
      </footer>
    </div>
  );
};

interface TreemapTileItemProps {
  tile: PositionedTile;
  index: number;
  totalTiles: number;
  arrivalStage: number;
  isCollapsingForProof: boolean;
  isMobileStack?: boolean;
  registerRef: (el: HTMLElement | null) => void;
  onViewAll: () => void;
}

const TreemapTileItem: React.FC<TreemapTileItemProps> = ({
  tile,
  index,
  totalTiles,
  arrivalStage,
  isCollapsingForProof,
  isMobileStack = false,
  registerRef,
  onViewAll,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [hovered, setHovered] = useState(false);

  const colors = getTileColors(tile.colorToken);
  const isTopRowLarge = (tile.y < 0.1 && tile.h >= 0.44) || isMobileStack;

  const titleFontSize = computeAdaptiveTitleFontSize(
    tile.name,
    isTopRowLarge
  );

  const statsFontSize = isTopRowLarge
    ? "clamp(12px, 4.3cqi, 24px)"
    : "clamp(11px, 4.2cqi, 17.5px)";

  const widerThanTall = tile.w > tile.h * 1.15;
  const growStaggerMs = index * 55;
  const collapseReverseStaggerMs = Math.max(0, (totalTiles - 1 - index) * 30);

  let blockTransform = "scale(1, 1)";
  let blockOrigin = widerThanTall ? "center bottom" : "left center";
  let blockTransition = "background-color 150ms var(--ease-out)";

  if (!reducedMotion) {
    if (isCollapsingForProof) {
      blockOrigin = "center bottom";
      blockTransform = "scaleY(0)";
      blockTransition = `transform 220ms var(--ease-in) ${collapseReverseStaggerMs}ms, background-color 150ms var(--ease-out)`;
    } else if (arrivalStage < 1) {
      blockTransform = widerThanTall ? "scaleY(0)" : "scaleX(0)";
    } else {
      blockTransform = "scale(1, 1)";
      blockTransition = `transform 400ms var(--ease-soft) ${growStaggerMs}ms, background-color 150ms var(--ease-out)`;
    }
  }

  const hatchClass = tile.isForeign
    ? tile.colorToken === "white"
      ? "hatch-blue"
      : "hatch-white"
    : "";

  // Add 0.5px overlap on internal edges so percentage positioning never leaves subpixel anti-aliasing gaps
  const addWidthOverlap = tile.x + tile.w < 0.999 ? " + 0.5px" : "";
  const addHeightOverlap = tile.y + tile.h < 0.999 ? " + 0.5px" : "";

  return (
    <div
      ref={registerRef}
      data-flip-tile-id={tile.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onViewAll}
      className={`${
        isMobileStack ? "w-full min-h-[190px] relative" : "absolute"
      } cursor-pointer select-none`}
      style={
        isMobileStack
          ? undefined
          : {
              left: `${tile.x * 100}%`,
              top: `${tile.y * 100}%`,
              width: `calc(${tile.w * 100}%${addWidthOverlap})`,
              height: `calc(${tile.h * 100}%${addHeightOverlap})`,
            }
      }
    >
      {/* Flat colour block surface (unclipped by parent during FLIP) */}
      <div
        data-flip-bg
        className={`absolute inset-0 ${hatchClass}`}
        style={{
          backgroundColor: hovered ? colors.hoverBg : colors.bg,
          transformOrigin: blockOrigin,
          transform: blockTransform,
          transition: blockTransition,
        }}
      />

      {/* Counter-scaled tile typography content with inline-size container query & overflow-hidden */}
      <div
        data-flip-content
        className="relative z-10 w-full h-full flex flex-col justify-start min-w-0 overflow-hidden"
        style={{
          color: colors.text,
          padding: "clamp(12px, 4.8cqi, 26px)",
          containerType: "inline-size",
          opacity: isCollapsingForProof ? 0 : 1,
          transition: "opacity 140ms var(--ease-in)",
        }}
      >
        {/* Merchant Name: single line, character-aware cqi scale */}
        <h2
          className="m-0 tracking-[-0.02em] leading-[0.94] min-w-0"
          style={{ fontSize: titleFontSize }}
        >
          <RisingWord
            text={t(tile.name)}
            visible={arrivalStage >= 2}
            baseDelayMs={index * 45}
            letterStaggerMs={16}
            letterByLetter={true}
          />
        </h2>

        {/* Stat block (receipts, % of spend / foreign currency, N to check) + t("view all") link aligned on bottom baseline */}
        <div
          className="mt-2 flex items-end justify-between gap-2 min-w-0"
          style={{
            color:
              tile.colorToken === "blue-500" && !isTopRowLarge
                ? colors.smallText
                : colors.text,
            opacity: arrivalStage >= 2 ? 1 : 0,
            transform:
              arrivalStage >= 2 || reducedMotion
                ? "translateY(0)"
                : "translateY(8px)",
            transition: reducedMotion
              ? "opacity 150ms linear"
              : `opacity 280ms var(--ease-out) ${
                  index * 45 + 60
                }ms, transform 280ms var(--ease-out) ${index * 45 + 60}ms`,
          }}
        >
          <div
            className="flex flex-col leading-[1.18] tabular-nums min-w-0"
            style={{ fontSize: statsFontSize }}
          >
            <span className="truncate">
              <RollingNumber value={tile.receipts.length} />{" "}
              {tile.receipts.length === 1 ? t("receipt") : t("receipts")}
            </span>

            {tile.isForeign ? (
              <span className="truncate">
                {formatCurrencyAmount(tile.totalAmount, tile.currency)} · kept
                in {tile.currency}
                {isTopRowLarge || tile.w >= 0.45 ? " · not in % of spend" : ""}
              </span>
            ) : (
              <span className="truncate">
                <RollingNumber
                  value={
                    tile.sharePercent >= 10 || tile.sharePercent === 0
                      ? Math.round(tile.sharePercent)
                      : Number(tile.sharePercent.toFixed(1))
                  }
                  startFromZero={true}
                />{t("% of spend")}</span>
            )}

            {tile.flaggedCount > 0 && (
              <span className="truncate">
                <RollingNumber value={tile.flaggedCount} />{t("to check")}</span>
            )}
          </div>

          <span
            className={`shoebox-link shrink-0 mb-1 ${
              arrivalStage < 2 && !reducedMotion ? "underline-draw-hidden" : ""
            }`}
            style={{
              fontSize: statsFontSize,
            }}
          >{t("view all")}</span>
        </div>
      </div>
    </div>
  );
};
