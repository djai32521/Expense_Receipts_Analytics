import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage, setLanguage } from "./i18n";
import { apiFetch } from "./utils/api";
import { createSamples } from "./samples";
import { AppToolbar } from "./components/AppToolbar";
import { LandingView, type ReadingPhase } from "./components/LandingView";
import { usePrefersReducedMotion } from "./components/MotionPrimitives";
import { ResultsView } from "./components/ResultsView";
import { WorkspaceSyncModal } from "./components/WorkspaceSyncModal";
import type {
  FailedBatchInfo,
  RawReceiptFromModel,
  ReceiptCategory,
  ReceiptRow,
  UploadedPhoto,
  WorkspaceSourceMeta,
} from "./types";
import {
  applyCodeVerifiedDuplicates,
  computeShoeboxEngine,
} from "./utils/engine";
import {
  buildPhotoBatches,
  isSupportedImageFile,
  processPhotoInBrowser,
  processPhotosConcurrently,
  stripFileExtension,
} from "./utils/imageProcessor";
import {
  type IngestedWorkspaceFile,
  getSavedWorkspaceSession,
  initAuth,
} from "./utils/workspaceLiveSync";

const MAX_PARALLEL_BATCHES = 3;

function sanitizeRawReceipt(
  raw: RawReceiptFromModel,
  rowNumber: number,
  fallbackPhotoIndex: number,
  sourceMeta?: WorkspaceSourceMeta,
  sourcePhotoId?: string,
  receiptIndexInPhoto?: number
): ReceiptRow {
  const validCategories: ReceiptCategory[] = [
    "Meals",
    "Travel",
    "Lodging",
    "Office",
    "Other",
  ];
  const category: ReceiptCategory = validCategories.includes(
    raw.category as ReceiptCategory
  )
    ? (raw.category as ReceiptCategory)
    : "Other";

  const box: [number, number, number, number] =
    Array.isArray(raw.box_2d) && raw.box_2d.length === 4
      ? [
          Number.isFinite(Number(raw.box_2d[0])) ? Number(raw.box_2d[0]) : 0,
          Number.isFinite(Number(raw.box_2d[1])) ? Number(raw.box_2d[1]) : 0,
          Number.isFinite(Number(raw.box_2d[2])) ? Number(raw.box_2d[2]) : 1000,
          Number.isFinite(Number(raw.box_2d[3])) ? Number(raw.box_2d[3]) : 1000,
        ]
      : [100, 100, 900, 900];

  return {
    id: `receipt-${sourcePhotoId || fallbackPhotoIndex}-${receiptIndexInPhoto ?? 0}-${rowNumber}`,
    row: rowNumber,
    photo_index:
      typeof raw.photo_index === "number" && raw.photo_index >= 1
        ? raw.photo_index
        : fallbackPhotoIndex,
    box_2d: box,
    merchant: raw.merchant ?? null,
    date: raw.date ?? null,
    time: raw.time ?? null,
    item_count:
      typeof raw.item_count === "number" && !Number.isNaN(raw.item_count)
        ? Math.round(raw.item_count)
        : null,
    printed_total:
      typeof raw.printed_total === "number" && !Number.isNaN(raw.printed_total)
        ? raw.printed_total
        : null,
    handwritten_tip:
      typeof raw.handwritten_tip === "number" &&
      !Number.isNaN(raw.handwritten_tip)
        ? raw.handwritten_tip
        : null,
    final_total:
      typeof raw.final_total === "number" && !Number.isNaN(raw.final_total)
        ? raw.final_total
        : null,
    currency: raw.currency ? raw.currency.toUpperCase().trim() : null,
    tax:
      typeof raw.tax === "number" && !Number.isNaN(raw.tax) ? raw.tax : null,
    tax_label: raw.tax_label ?? null,
    tax_id_or_vat: raw.tax_id_or_vat ?? null,
    is_tax_invoice:
      typeof raw.is_tax_invoice === "boolean" ? raw.is_tax_invoice : null,
    category,
    card_last4: raw.card_last4 ?? null,
    confidence: {
      merchant: raw.confidence?.merchant ?? 0.9,
      date: raw.confidence?.date ?? 0.9,
      printed_total: raw.confidence?.printed_total ?? 0.9,
      handwritten_tip: raw.confidence?.handwritten_tip ?? 0.9,
      currency: raw.confidence?.currency ?? 0.95,
      tax: raw.confidence?.tax ?? 0.9,
    },
    flags: Array.isArray(raw.flags) ? raw.flags : [],
    duplicate_of: null,
    duplicate_reason: null,
    excluded: false,
    checked: false,
    source_meta: sourceMeta,
    cost_center: sourceMeta?.costCenter || "Unassigned",
    source_photo_id: sourcePhotoId,
    receipt_index_in_photo: receiptIndexInPhoto,
  };
}

export default function App() {
  const language = useLanguage();
  useEffect(() => { setLanguage(language); }, [language]);
  const [isSample, setIsSample] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const [screen, setScreen] = useState<"landing" | "results">("landing");
  const [photos, setPhotos] = useState<UploadedPhoto[]>([]);
  const [privacyAccepted, setPrivacyAccepted] = useState<boolean>(true);
  const [readingPhase, setReadingPhase] = useState<ReadingPhase>("idle");
  const [totalReceiptsFound, setTotalReceiptsFound] = useState<number>(0);
  const [recentDiscoveries, setRecentDiscoveries] = useState<
    Array<{ merchant: string; total: number | null; currency: string }>
  >([]);
  const [failedBatches, setFailedBatches] = useState<FailedBatchInfo[]>([]);
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] =
    useState<boolean>(false);
  const [connectedEmail, setConnectedEmail] = useState<string | null>(
    () => getSavedWorkspaceSession()?.accountEmail ?? null
  );

  useEffect(() => {
    const unsubscribe = initAuth(
      (user) => {
        setConnectedEmail(user.email || "Google Workspace User");
      },
      () => {
        setConnectedEmail(null);
      }
    );
    return () => unsubscribe();
  }, []);

  const screenRef = useRef<"landing" | "results">(screen);
  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const photosRef = useRef<UploadedPhoto[]>([]);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  const rowsRef = useRef<ReceiptRow[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const pipelineRunIdRef = useRef<number>(0);

  // Store raw receipts by photo.id so adding/removing/re-indexing photos or retrying failed batches merges cleanly
  const receiptsByPhotoIdRef = useRef<Map<string, RawReceiptFromModel[]>>(
    new Map()
  );

  // Sends a single batch to /api/read-receipts with 1 automatic retry on failure (B2)
  const requestReadBatchWithRetry = async (
    batch: UploadedPhoto[],
    totalPhotosCount: number
  ): Promise<RawReceiptFromModel[]> => {
    const payload = {
      photos: batch.map((p) => ({
        globalIndex: p.globalIndex,
        totalPhotos: totalPhotosCount,
        mimeType: p.mimeType || "image/jpeg",
        base64Data: p.base64Data || "",
      })),
    };

    const attemptCall = async (): Promise<RawReceiptFromModel[]> => {
      const res = await apiFetch("/api/read-receipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          errData.error || `Batch request failed (${res.status})`
        );
      }
      const data = await res.json();
      return Array.isArray(data.receipts) ? data.receipts : [];
    };

    try {
      return await attemptCall();
    } catch {
      // Retry failed batch once automatically per B2
      await new Promise((r) => window.setTimeout(r, 400));
      return await attemptCall();
    }
  };

  const finalizeMergedReceiptsAndTransition = async (
    runId: number,
    activePhotosSnapshot?: UploadedPhoto[]
  ) => {
    if (pipelineRunIdRef.current !== runId) return;

    const orderedPhotos = [...(activePhotosSnapshot ?? photosRef.current)].sort(
      (a, b) => a.globalIndex - b.globalIndex
    );

    // Map existing rows by (source_photo_id, receipt_index_in_photo) so user edits on ResultsView survive adding new files
    const existingRowsByPhotoKey = new Map<string, ReceiptRow>();
    for (const r of rowsRef.current) {
      if (r.source_photo_id && typeof r.receipt_index_in_photo === "number") {
        existingRowsByPhotoKey.set(
          `${r.source_photo_id}__${r.receipt_index_in_photo}`,
          r
        );
      }
    }

    // 1. Merge batches in code: concatenate in photo order (1..orderedPhotos.length), number rows 1..N
    const orderedRaw: Array<{
      raw: RawReceiptFromModel;
      photo: UploadedPhoto;
      receiptIndexInPhoto: number;
    }> = [];

    for (const photo of orderedPhotos) {
      const list = receiptsByPhotoIdRef.current.get(photo.id) || [];
      for (let rIdx = 0; rIdx < list.length; rIdx++) {
        orderedRaw.push({
          raw: { ...list[rIdx], photo_index: photo.globalIndex },
          photo,
          receiptIndexInPhoto: rIdx,
        });
      }
    }

    const initialRows: ReceiptRow[] = orderedRaw.map((entry, idx) => {
      const rowNumber = idx + 1;
      const existing = existingRowsByPhotoKey.get(
        `${entry.photo.id}__${entry.receiptIndexInPhoto}`
      );
      if (existing) {
        return {
          ...existing,
          row: rowNumber,
          photo_index: entry.photo.globalIndex,
          source_meta: existing.source_meta ?? entry.photo.sourceMeta,
        };
      }
      return sanitizeRawReceipt(
        entry.raw,
        rowNumber,
        entry.photo.globalIndex,
        entry.photo.sourceMeta,
        entry.photo.id,
        entry.receiptIndexInPhoto
      );
    });

    // 2. Duplicate pass (B1 & A5 Step 2: "Checking for duplicates…")
    setReadingPhase("checking_duplicates");
    let modelDuplicates: Array<{
      row: number;
      duplicate_of: number;
      reason: string;
    }> = [];

    // Check if any pair of rows has a close total amount before making a network round-trip
    let hasCandidatePair = false;
    for (let i = 0; i < initialRows.length && !hasCandidatePair; i++) {
      const a =
        initialRows[i].final_total ?? initialRows[i].printed_total ?? null;
      if (a === null) continue;
      for (let j = i + 1; j < initialRows.length; j++) {
        const b =
          initialRows[j].final_total ?? initialRows[j].printed_total ?? null;
        if (b !== null && Math.abs(a - b) <= Math.max(1.5, a * 0.05)) {
          hasCandidatePair = true;
          break;
        }
      }
    }

    if (initialRows.length >= 2 && hasCandidatePair) {
      try {
        const dupRes = await apiFetch("/api/check-duplicates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rows: initialRows.map((r) => ({
              row: r.row,
              photo_index: r.photo_index,
              merchant: r.merchant,
              date: r.date,
              time: r.time,
              final_total: r.final_total,
              printed_total: r.printed_total,
              currency: r.currency,
              card_last4: r.card_last4,
              source_type: r.source_meta?.sourceType || "manual_upload",
            })),
          }),
        });
        if (dupRes.ok) {
          const dupData = await dupRes.json();
          if (Array.isArray(dupData.duplicates)) {
            modelDuplicates = dupData.duplicates;
          }
        }
      } catch (e) {
        console.warn(
          "Duplicate check call error, falling back to code check:",
          e
        );
      }
    }

    if (pipelineRunIdRef.current !== runId) return;

    // 3. Adding up in code (A5 Step 2: "Adding up…")
    setReadingPhase("adding_up");
    const verifiedRows = applyCodeVerifiedDuplicates(
      initialRows,
      modelDuplicates
    );
    rowsRef.current = verifiedRows;
    setRows(verifiedRows);

    if (screenRef.current === "results") {
      setReadingPhase("idle");
      return;
    }

    await new Promise((r) =>
      window.setTimeout(r, reducedMotion ? 80 : 200)
    );
    if (pipelineRunIdRef.current !== runId) return;

    // 4. Signature move: Landing -> Results (A7)
    setReadingPhase("transitioning_out");
    await new Promise((r) =>
      window.setTimeout(r, reducedMotion ? 140 : 960)
    );
    if (pipelineRunIdRef.current !== runId) return;

    setScreen("results");
    setReadingPhase("idle");
  };

  const runBatchesPipeline = async (
    targetPhotos: UploadedPhoto[],
    overrideTotalCount?: number,
    allPhotosSnapshot?: UploadedPhoto[]
  ) => {
    const runId = ++pipelineRunIdRef.current;
    setReadingPhase("reading_photos");
    setFailedBatches([]);

    // Mark target photos as reading
    const targetIds = new Set(targetPhotos.map((p) => p.id));
    setPhotos((prev) => {
      const next = prev.map((p) =>
        targetIds.has(p.id)
          ? { ...p, status: "reading" as const, errorText: undefined }
          : p
      );
      photosRef.current = next;
      return next;
    });

    // Preprocess target photos concurrently with per-photo error isolation
    const processedPhotos: UploadedPhoto[] = [];
    const newFailedBatches: FailedBatchInfo[] = [];

    const prepResults = await Promise.all(
      targetPhotos.map(async (p) => {
        try {
          const ready = await processPhotoInBrowser({
            ...p,
            status: "reading" as const,
            errorText: undefined,
          });
          return { ok: true as const, photo: ready };
        } catch (err: unknown) {
          const message =
            err instanceof Error
              ? err.message
              : `Could not process ${p.name}`;
          return { ok: false as const, photo: p, message };
        }
      })
    );

    if (pipelineRunIdRef.current !== runId) return;

    const processedById = new Map<string, UploadedPhoto>();
    const failedPrepIds = new Map<string, string>();

    for (const res of prepResults) {
      if (res.ok) {
        processedPhotos.push(res.photo);
        processedById.set(res.photo.id, res.photo);
      } else {
        failedPrepIds.set(res.photo.id, res.message);
        newFailedBatches.push({
          batchId: 900 + res.photo.globalIndex,
          startPhotoIndex: res.photo.globalIndex,
          endPhotoIndex: res.photo.globalIndex,
          photoIds: [res.photo.id],
          errorMessage: res.message,
        });
      }
    }

    setPhotos((prev) => {
      const next = prev.map((p) => {
        if (processedById.has(p.id)) return processedById.get(p.id)!;
        if (failedPrepIds.has(p.id)) {
          return {
            ...p,
            status: "error" as const,
            errorText: failedPrepIds.get(p.id),
          };
        }
        return p;
      });
      photosRef.current = next;
      return next;
    });

    if (processedPhotos.length === 0) {
      setFailedBatches(newFailedBatches);
      setReadingPhase("idle");
      return;
    }

    const totalCount =
      overrideTotalCount ??
      allPhotosSnapshot?.length ??
      photosRef.current.length;
    const batches = buildPhotoBatches(processedPhotos);

    // Run batches with max concurrency of 3 (B2)
    let nextBatchIndex = 0;

    const worker = async () => {
      while (nextBatchIndex < batches.length) {
        if (pipelineRunIdRef.current !== runId) return;
        const bIdx = nextBatchIndex++;
        const batch = batches[bIdx];
        const batchPhotoIds = new Set(batch.map((p) => p.id));
        const photoByGlobalIdx = new Map<number, UploadedPhoto>();
        for (const p of batch) {
          photoByGlobalIdx.set(p.globalIndex, p);
        }

        try {
          const batchReceipts = await requestReadBatchWithRetry(
            batch,
            totalCount
          );
          if (pipelineRunIdRef.current !== runId) return;

          // Group returned receipts by photo.id
          const byPhotoId = new Map<string, RawReceiptFromModel[]>();
          for (const p of batch) {
            byPhotoId.set(p.id, []);
          }

          for (const rec of batchReceipts) {
            const matchedPhoto =
              photoByGlobalIdx.get(rec.photo_index) ??
              (typeof rec.photo_index === "number" &&
              rec.photo_index >= 1 &&
              rec.photo_index <= batch.length
                ? batch[rec.photo_index - 1]
                : batch[0]);
            const list = byPhotoId.get(matchedPhoto.id) || [];
            list.push({ ...rec, photo_index: matchedPhoto.globalIndex });
            byPhotoId.set(matchedPhoto.id, list);
          }

          for (const [photoId, list] of byPhotoId.entries()) {
            receiptsByPhotoIdRef.current.set(photoId, list);
          }

          // Compute new running total of receipts found across all completed photos
          let runningTotal = 0;
          const latestMerchants: Array<{
            merchant: string;
            total: number | null;
            currency: string;
          }> = [];
          receiptsByPhotoIdRef.current.forEach((list) => {
            runningTotal += list.length;
            for (const item of list) {
              if (item.merchant) {
                latestMerchants.push({
                  merchant: item.merchant,
                  total: item.final_total ?? item.printed_total ?? null,
                  currency: item.currency || "USD",
                });
              }
            }
          });
          setTotalReceiptsFound(runningTotal);
          setRecentDiscoveries(latestMerchants.slice(-6));

          setPhotos((prev) => {
            const next = prev.map((p) => {
              if (!batchPhotoIds.has(p.id)) return p;
              const foundForPhoto = byPhotoId.get(p.id)?.length ?? 0;
              return {
                ...p,
                status: "done" as const,
                receiptsCount: foundForPhoto,
              };
            });
            photosRef.current = next;
            return next;
          });
        } catch (err: unknown) {
          if (pipelineRunIdRef.current !== runId) return;
          const message =
            err instanceof Error ? err.message : "Batch read failed";
          const startPhotoIndex = batch[0].globalIndex;
          const endPhotoIndex = batch[batch.length - 1].globalIndex;
          newFailedBatches.push({
            batchId: bIdx + 1,
            startPhotoIndex,
            endPhotoIndex,
            photoIds: batch.map((p) => p.id),
            errorMessage: message,
          });

          setPhotos((prev) => {
            const next = prev.map((p) =>
              batchPhotoIds.has(p.id)
                ? { ...p, status: "error" as const, errorText: message }
                : p
            );
            photosRef.current = next;
            return next;
          });
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(MAX_PARALLEL_BATCHES, batches.length) },
      () => worker()
    );
    await Promise.all(workers);

    if (pipelineRunIdRef.current !== runId) return;

    if (newFailedBatches.length > 0) {
      setFailedBatches(newFailedBatches);
      if (screenRef.current === "results") {
        await finalizeMergedReceiptsAndTransition(runId, allPhotosSnapshot);
      } else {
        setReadingPhase("idle");
      }
      return;
    }

    await finalizeMergedReceiptsAndTransition(runId, allPhotosSnapshot);
  };

  const runBatchesPipelineRef = useRef(runBatchesPipeline);
  runBatchesPipelineRef.current = runBatchesPipeline;

  const handleAddFiles = useCallback((fileList: FileList | File[]) => {
    const incoming = Array.from(fileList).filter(isSupportedImageFile);
    if (incoming.length === 0) return;

    const startIdx = photosRef.current.length;
    const newlyAdded: UploadedPhoto[] = incoming.map((file, idx) => ({
      id: `${file.name}-${file.size}-${Date.now()}-${idx}-${Math.random()
        .toString(36)
        .slice(2, 7)}`,
      globalIndex: startIdx + idx + 1,
      file,
      name: file.name,
      displayName: stripFileExtension(file.name),
      objectUrl: URL.createObjectURL(file),
      status: "idle",
      receiptsCount: 0,
      sourceMeta: {
        sourceType: "manual_upload",
        costCenter: "Unassigned",
      },
    }));

    const combined = [...photosRef.current, ...newlyAdded].map((p, i) => ({
      ...p,
      globalIndex: i + 1,
    }));
    photosRef.current = combined;
    setPhotos(combined);

    if (screenRef.current === "results") {
      const pendingPhotos = combined.filter(
        (p) => p.status !== "done" || !receiptsByPhotoIdRef.current.has(p.id)
      );
      void runBatchesPipelineRef.current(
        pendingPhotos.length > 0 ? pendingPhotos : combined.slice(startIdx),
        combined.length,
        combined
      );
      return;
    }

    // Pre-shrink & strip EXIF concurrently in the background while user is on Landing screen
    void processPhotosConcurrently(newlyAdded, 4, (processed) => {
      setPhotos((prev) => {
        const next = prev.map((p) =>
          p.id === processed.id
            ? {
                ...p,
                objectUrl: processed.objectUrl,
                base64Data: processed.base64Data,
                mimeType: processed.mimeType,
                width: processed.width,
                height: processed.height,
                byteSize: processed.byteSize,
              }
            : p
        );
        photosRef.current = next;
        return next;
      });
    }).catch(() => {
      // Any individual decode error will be caught and surfaced during batch pipeline
    });
  }, []);

  const handleIngestWorkspaceFiles = useCallback(
    (items: IngestedWorkspaceFile[]) => {
      const validItems = items.filter((it) => isSupportedImageFile(it.file));
      if (validItems.length === 0) return;

      const startIdx = photosRef.current.length;
      const newlyAdded: UploadedPhoto[] = validItems.map((item, idx) => ({
        id: `ws-${item.file.name}-${item.file.size}-${Date.now()}-${idx}-${Math.random()
          .toString(36)
          .slice(2, 7)}`,
        globalIndex: startIdx + idx + 1,
        file: item.file,
        name: item.file.name,
        displayName: stripFileExtension(item.file.name),
        objectUrl: URL.createObjectURL(item.file),
        status: "idle",
        receiptsCount: 0,
        sourceMeta: item.sourceMeta,
      }));

      const combined = [...photosRef.current, ...newlyAdded].map((p, i) => ({
        ...p,
        globalIndex: i + 1,
      }));
      photosRef.current = combined;
      setPhotos(combined);
      setPrivacyAccepted(true);

      if (screenRef.current === "results") {
        const pendingPhotos = combined.filter(
          (p) => p.status !== "done" || !receiptsByPhotoIdRef.current.has(p.id)
        );
        void runBatchesPipelineRef.current(
          pendingPhotos.length > 0 ? pendingPhotos : combined.slice(startIdx),
          combined.length,
          combined
        );
      } else {
        // Clean up any stale receipt entries for photos that haven't finished reading yet
        const donePhotoIds = new Set(
          combined.filter((p) => p.status === "done").map((p) => p.id)
        );
        Array.from(receiptsByPhotoIdRef.current.keys()).forEach((k) => {
          if (!donePhotoIds.has(k)) {
            receiptsByPhotoIdRef.current.delete(k);
          }
        });
        if (donePhotoIds.size === 0) {
          setTotalReceiptsFound(0);
          setRecentDiscoveries([]);
        }
        const pendingPhotos = combined.filter((p) => p.status !== "done");
        void runBatchesPipelineRef.current(
          pendingPhotos.length > 0 ? pendingPhotos : combined,
          combined.length,
          combined
        );
      }
    },
    []
  );

  const handleRemovePhoto = useCallback((id: string) => {
    receiptsByPhotoIdRef.current.delete(id);
    let runningTotal = 0;
    receiptsByPhotoIdRef.current.forEach((list) => {
      runningTotal += list.length;
    });
    setTotalReceiptsFound(runningTotal);
    if (runningTotal === 0) {
      setRecentDiscoveries([]);
    }

    setFailedBatches((prev) =>
      prev
        .map((b) => ({
          ...b,
          photoIds: b.photoIds.filter((pid) => pid !== id),
        }))
        .filter((b) => b.photoIds.length > 0)
    );

    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.objectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(target.objectUrl);
      }
      const next = prev
        .filter((p) => p.id !== id)
        .map((p, i) => ({
          ...p,
          globalIndex: i + 1,
        }));
      photosRef.current = next;
      return next;
    });
  }, []);

  const handleStartVisualise = () => {
    if (photos.length === 0 || !privacyAccepted || readingPhase !== "idle") {
      return;
    }
    const pendingPhotos = photos.filter(
      (p) => p.status !== "done" || !receiptsByPhotoIdRef.current.has(p.id)
    );
    if (pendingPhotos.length === 0) {
      const runId = ++pipelineRunIdRef.current;
      setFailedBatches([]);
      void finalizeMergedReceiptsAndTransition(runId, photos);
      return;
    }
    if (pendingPhotos.length < photos.length) {
      void runBatchesPipeline(pendingPhotos, photos.length, photos);
      return;
    }
    receiptsByPhotoIdRef.current.clear();
    setTotalReceiptsFound(0);
    setRecentDiscoveries([]);
    void runBatchesPipeline(photos, photos.length, photos);
  };

  const handleRetryFailedBatches = () => {
    if (failedBatches.length === 0 || readingPhase !== "idle") return;
    const failedIds = new Set(failedBatches.flatMap((b) => b.photoIds));
    const toRetry = photos.filter((p) => failedIds.has(p.id));
    if (toRetry.length > 0) {
      void runBatchesPipeline(toRetry, photos.length, photos);
    }
  };

  const handleUpdateRow = useCallback(
    (rowNumber: number, updater: (prev: ReceiptRow) => ReceiptRow) => {
      setRows((prevRows) => {
        const next = prevRows.map((r) => (r.row === rowNumber ? updater(r) : r));
        rowsRef.current = next;
        return next;
      });
    },
    []
  );

  const handleChangeCostCenter = useCallback(
    (rowId: string, newCostCenter: string) => {
      setRows((prevRows) => {
        const next = prevRows.map((r) =>
          r.id === rowId ? { ...r, cost_center: newCostCenter } : r
        );
        rowsRef.current = next;
        return next;
      });
    },
    []
  );

  const handleNewPile = useCallback(() => {
    setIsSample(false);
    pipelineRunIdRef.current++;
    photosRef.current.forEach((p) => {
      if (p.objectUrl.startsWith("blob:")) {
        URL.revokeObjectURL(p.objectUrl);
      }
    });
    receiptsByPhotoIdRef.current.clear();
    photosRef.current = [];
    rowsRef.current = [];
    setPhotos([]);
    setRows([]);
    setTotalReceiptsFound(0);
    setRecentDiscoveries([]);
    setFailedBatches([]);
    setReadingPhase("idle");
    setScreen("landing");
  }, []);

  const engineOutput = useMemo(
    () => computeShoeboxEngine(rows, Math.max(1, photos.length)),
    [rows, photos.length]
  );

  const handleSample = () => {
    handleNewPile();
    const { raw, photos: samplePhotos } = createSamples();
    const sampleRows = applyCodeVerifiedDuplicates(raw.map((receipt, index) =>
      sanitizeRawReceipt(receipt, index + 1, index + 1, samplePhotos[index].sourceMeta, samplePhotos[index].id, 0)), []);
    samplePhotos.forEach((photo, index) => receiptsByPhotoIdRef.current.set(photo.id, [raw[index]]));
    photosRef.current = samplePhotos;
    rowsRef.current = sampleRows;
    setPhotos(samplePhotos);
    setRows(sampleRows);
    setTotalReceiptsFound(sampleRows.length);
    setIsSample(true);
    setScreen("results");
  };

  return (
    <>
      <AppToolbar onSample={handleSample} onWorkspace={() => setIsWorkspaceModalOpen(true)} isSample={isSample} busy={readingPhase !== "idle"} />
      <main className="app-shell">
      {screen === "results" ? (
        <ResultsView
          photos={photos}
          computedRows={engineOutput.computedRows}
          merchantTiles={engineOutput.merchantTiles}
          reconciliation={engineOutput.reconciliation}
          readingPhase={readingPhase}
          failedBatches={failedBatches}
          onRetryFailedBatches={handleRetryFailedBatches}
          onUpdateRow={handleUpdateRow}
          onChangeCostCenter={handleChangeCostCenter}
          onAddFiles={handleAddFiles}
          onOpenWorkspaceModal={() => setIsWorkspaceModalOpen(true)}
          onNewPile={handleNewPile}
        />
      ) : (
        <LandingView
          photos={photos}
          privacyAccepted={privacyAccepted}
          readingPhase={readingPhase}
          totalReceiptsFound={totalReceiptsFound}
          recentDiscoveries={recentDiscoveries}
          failedBatches={failedBatches}
          connectedEmail={connectedEmail}
          onAddFiles={handleAddFiles}
          onRemovePhoto={handleRemovePhoto}
          onTogglePrivacy={() => setPrivacyAccepted((v) => !v)}
          onStartVisualise={handleStartVisualise}
          onRetryFailedBatches={handleRetryFailedBatches}
          onOpenWorkspaceModal={() => setIsWorkspaceModalOpen(true)}
        />
      )}
      </main>
      <WorkspaceSyncModal isOpen={isWorkspaceModalOpen} onClose={() => setIsWorkspaceModalOpen(false)} onIngestFiles={handleIngestWorkspaceFiles} connectedEmail={connectedEmail} onConnectedEmailChange={setConnectedEmail} />
    </>
  );
}
