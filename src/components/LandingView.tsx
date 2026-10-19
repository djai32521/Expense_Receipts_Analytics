import { t } from "../i18n";
import React, { useEffect, useRef, useState } from "react";
import type { FailedBatchInfo, UploadedPhoto } from "../types";
import { formatCurrencyAmount } from "../utils/engine";
import {
  CustomScrollList,
  RisingWord,
  RollingNumber,
  usePrefersReducedMotion,
} from "./MotionPrimitives";

export type ReadingPhase =
  | "idle"
  | "reading_photos"
  | "checking_duplicates"
  | "adding_up"
  | "transitioning_out";

interface LandingViewProps {
  photos: UploadedPhoto[];
  privacyAccepted: boolean;
  readingPhase: ReadingPhase;
  totalReceiptsFound: number;
  recentDiscoveries?: Array<{
    merchant: string;
    total: number | null;
    currency: string;
  }>;
  failedBatches: FailedBatchInfo[];
  connectedEmail?: string | null;
  onAddFiles: (files: FileList | File[]) => void;
  onRemovePhoto: (id: string) => void;
  onTogglePrivacy: () => void;
  onStartVisualise: () => void;
  onRetryFailedBatches: () => void;
  onOpenWorkspaceModal?: () => void;
}

export const LandingView: React.FC<LandingViewProps> = ({
  photos,
  privacyAccepted,
  readingPhase,
  totalReceiptsFound,
  recentDiscoveries = [],
  failedBatches,
  connectedEmail = null,
  onAddFiles,
  onRemovePhoto,
  onTogglePrivacy,
  onStartVisualise,
  onRetryFailedBatches,
  onOpenWorkspaceModal,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [scrollTrigger, setScrollTrigger] = useState(0);
  const [nudgeTerms, setNudgeTerms] = useState(false);

  const [loadStep, setLoadStep] = useState<number>(reducedMotion ? 10 : 0);
  const [exitStep, setExitStep] = useState<number>(0);

  const isReading =
    readingPhase === "reading_photos" ||
    readingPhase === "checking_duplicates" ||
    readingPhase === "adding_up";
  const isExiting = readingPhase === "transitioning_out";
  const canVisualise = photos.length > 0 && readingPhase === "idle";

  useEffect(() => {
    if (reducedMotion) {
      setLoadStep(10);
      return;
    }
    const timers = [
      window.setTimeout(() => setLoadStep(1), 20),
      window.setTimeout(() => setLoadStep(2), 150),
      window.setTimeout(() => setLoadStep(3), 400),
      window.setTimeout(() => setLoadStep(4), 500),
      window.setTimeout(() => setLoadStep(5), 650),
      window.setTimeout(() => setLoadStep(6), 750),
      window.setTimeout(() => setLoadStep(7), 900),
      window.setTimeout(() => setLoadStep(8), 1100),
    ];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [reducedMotion]);

  // A7 Signature move: Landing -> results
  // 0ms: all text exits (fade & rise 8px, 180ms, ease-in)
  // 120ms: file card collapses scaleY to its top edge (260ms, ease-in)
  // 200ms: action bar collapses scaleY to bottom (260ms); right panel collapses scaleX to right edge (300ms, ease-in)
  // 480ms: blue landing block resizes scaleX(5/7) to cols 1-5 (500ms, ease-in-out)
  useEffect(() => {
    if (readingPhase !== "transitioning_out") {
      setExitStep(0);
      return;
    }
    if (reducedMotion) {
      setExitStep(4);
      return;
    }
    setExitStep(1);
    const t1 = window.setTimeout(() => setExitStep(2), 120);
    const t2 = window.setTimeout(() => setExitStep(3), 200);
    const t3 = window.setTimeout(() => setExitStep(4), 480);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [readingPhase, reducedMotion]);

  const prevPhotosLenRef = useRef(photos.length);
  useEffect(() => {
    if (photos.length > prevPhotosLenRef.current) {
      setScrollTrigger((n) => n + 1);
    }
    prevPhotosLenRef.current = photos.length;
  }, [photos.length]);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    if (isReading || isExiting) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onAddFiles(e.dataTransfer.files);
    }
  };

  const openFilePicker = () => {
    if (isReading || isExiting) return;
    fileInputRef.current?.click();
  };

  const completedPhotosCount = photos.filter((p) => p.status === "done").length;

  let step2Label =
    t("Gemini reads every receipt, tax ID, and handwritten tip");
  if (readingPhase === "reading_photos") {
    step2Label = t("Reading {count} photos…", { count: photos.length });
  } else if (readingPhase === "checking_duplicates") {
    step2Label = t("Checking for duplicates…");
  } else if (
    readingPhase === "adding_up" ||
    readingPhase === "transitioning_out"
  ) {
    step2Label = t("Adding up…");
  }

  const getStepStatus = (stepNum: 1 | 2 | 3): "idle" | "active" | "done" => {
    if (!isReading && !isExiting) {
      return "idle";
    }
    if (stepNum === 1) return "done";
    if (stepNum === 2) {
      return readingPhase === "adding_up" || isExiting ? "done" : "active";
    }
    return readingPhase === "adding_up" || isExiting ? "active" : "idle";
  };

  return (
    <div className="w-full min-h-screen md:h-screen flex flex-col md:grid md:grid-cols-12 bg-white overflow-x-hidden md:overflow-hidden">
      <input
        ref={fileInputRef}
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

      {/* LEFT BLOCK: cols 1-7 on Landing, resizes scaleX(5/7) to cols 1-5 on transition to Results */}
      <div
        className="md:col-span-7 min-h-[420px] md:h-full flex flex-col justify-between relative z-10 select-none overflow-hidden"
        style={{
          backgroundColor: "var(--blue-900)",
          color: "var(--white)",
          padding: "var(--text-inset)",
          transformOrigin: "left top",
          transform: reducedMotion
            ? "none"
            : exitStep >= 4
            ? "scaleX(0.7142857)" // 5/7 -> exact cols 1-5 width
            : loadStep >= 1
            ? "scaleX(1)"
            : "scaleX(0)",
          transition: reducedMotion
            ? "opacity 150ms linear"
            : exitStep >= 4
            ? "transform 480ms var(--ease-in-out)"
            : "transform 600ms var(--ease-soft)",
        }}
      >
        {/* Top-left: Wordmark & Tagline + Live Running Count (A5 Step 2) */}
        <div
          style={{
            opacity: exitStep >= 1 ? 0 : 1,
            transform:
              exitStep >= 1 && !reducedMotion
                ? "translateY(-8px)"
                : "translateY(0)",
            transition: reducedMotion
              ? "opacity 150ms linear"
              : "opacity 180ms var(--ease-in), transform 180ms var(--ease-in)",
          }}
        >
          <div
            className="mb-1.5 flex items-center gap-2"
            style={{
              opacity: loadStep >= 4 ? 1 : 0,
              transition: "opacity 300ms var(--ease-out)",
            }}
          >
            <span className="font-mono-badge px-2 py-0.5 bg-white/15 text-white">{t("SPEND AUDIT")}</span>
          </div>

          <h1
            className="m-0 tracking-[-0.02em] leading-[0.9]"
            style={{
              fontSize: "clamp(60px, 12.6vw, 190px)",
            }}
          >
            <RisingWord
              text="Shoebox"
              visible={loadStep >= 4 && exitStep === 0}
              baseDelayMs={0}
              letterStaggerMs={22}
              durationMs={500}
              easing="var(--ease-spring)"
              letterByLetter={true}
            />
          </h1>

          <p
            className="m-0 mt-2 tracking-[-0.01em]"
            style={{
              fontSize: "clamp(20px, 2.5vw, 37px)",
              lineHeight: 1.1,
              opacity: loadStep >= 6 ? 1 : 0,
              transform:
                loadStep >= 6 || reducedMotion
                  ? "translateY(0)"
                  : "translateY(12px)",
              transition: reducedMotion
                ? "opacity 150ms linear"
                : "opacity 400ms var(--ease-out), transform 400ms var(--ease-out)",
            }}
          >{t("Receipts in, audited ledger out.")}</p>

          {/* Large running count under the wordmark during reading (A5 Step 2) */}
          {(isReading || totalReceiptsFound > 0) && (
            <div className="mt-5 md:mt-7 flex flex-col gap-1.5">
              <div
                className="tracking-[-0.02em] leading-[0.95] tabular-nums"
                style={{
                  fontSize: "clamp(30px, 4vw, 58px)",
                  opacity: 1,
                  transition: "opacity 200ms var(--ease-out)",
                }}
              >
                <RollingNumber value={totalReceiptsFound} />{" "}
                {totalReceiptsFound === 1 ? "receipt found" : t("receipts found")}
              </div>
              {isReading && (
                <p className="m-0 text-[16px] md:text-[18px] text-white/85 tabular-nums">
                  {readingPhase === "reading_photos"
                    ? t("Reading {done} of {count} photos…", { done: completedPhotosCount, count: photos.length })
                    : readingPhase === "checking_duplicates"
                    ? t("Checking pile for duplicate receipts…")
                    : t("Verifying totals in code…")}
                </p>
              )}
              {isReading && recentDiscoveries.length > 0 && (
                <p className="m-0 text-[15px] md:text-[16px] text-white/75 tabular-nums truncate max-w-[90%]">
                  {recentDiscoveries
                    .slice(-2)
                    .map(
                      (d) =>
                        `${d.merchant}${
                          d.total !== null
                            ? ` (${formatCurrencyAmount(d.total, d.currency)})`
                            : ""
                        }`
                    )
                    .join(" · ")}
                </p>
              )}
            </div>
          )}

          {/* Failed batch retry banner if any batch failed after automatic retry (B2) */}
          {failedBatches.length > 0 && (
            <div className="mt-4 flex flex-col gap-1 text-[16px] md:text-[18px] text-white">
              <div className="flex flex-wrap items-center gap-3">
                <span>
                  {t("Couldn't read photos")}{" "}
                  {failedBatches
                    .map((b) =>
                      b.startPhotoIndex === b.endPhotoIndex
                        ? `${b.startPhotoIndex}`
                        : `${b.startPhotoIndex}–${b.endPhotoIndex}`
                    )
                    .join(", ")}
                  ,
                </span>
                <button
                  type="button"
                  onClick={onRetryFailedBatches}
                  className="shoebox-link text-white"
                >{t("try again")}</button>
              </div>
              {failedBatches[0]?.errorMessage && (
                <span className="text-[13px] text-white/80">
                  {failedBatches[0].errorMessage}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Lower third: t("Getting started") at col 4, Numbered steps at col 4-7 on desktop (A4) */}
        <div
          className="pt-6 pb-4 md:pb-[clamp(16px,4.5vh,52px)] grid grid-cols-7"
          style={{
            opacity: exitStep >= 1 ? 0 : 1,
            transform:
              exitStep >= 1 && !reducedMotion
                ? "translateY(-8px)"
                : "translateY(0)",
            transition: reducedMotion
              ? "opacity 150ms linear"
              : "opacity 180ms var(--ease-in) 20ms, transform 180ms var(--ease-in) 20ms",
          }}
        >
          <div className="col-span-7 md:col-start-2 md:col-span-6 lg:col-start-3 lg:col-span-5 mb-3 md:mb-4">
            <h2
              className="m-0 tracking-[-0.01em]"
              style={{
                fontSize: "clamp(22px, 2.3vw, 34px)",
                lineHeight: 1.15,
                opacity: loadStep >= 7 ? 1 : 0,
                transform:
                  loadStep >= 7 || reducedMotion
                    ? "translateY(0)"
                    : "translateY(8px)",
                transition: reducedMotion
                  ? "opacity 150ms linear"
                  : "opacity 300ms var(--ease-out), transform 300ms var(--ease-out)",
              }}
            >{t("Getting started")}</h2>
          </div>

          <ol
            className="col-span-7 md:col-start-2 md:col-span-6 lg:col-start-4 lg:col-span-4 m-0 p-0 list-none flex flex-col gap-2"
            style={{ fontSize: "clamp(14.5px, 1.2vw, 18px)" }}
          >
            {(
              [
                {
                  num: 1 as const,
                  text: t("Drop receipt photos or choose files from your device"),
                },
                { num: 2 as const, text: step2Label },
                {
                  num: 3 as const,
                  text: t("Code verifies totals, catches duplicates, and reconciles spend"),
                },
              ] as const
            ).map((step, idx) => {
              const status = getStepStatus(step.num);
              const delayMs = (idx + 1) * 60;
              return (
                <li
                  key={step.num}
                  className="flex items-start gap-3 leading-[1.35]"
                  style={{
                    opacity: loadStep >= 7 ? 1 : 0,
                    transform:
                      loadStep >= 7 || reducedMotion
                        ? "translateY(0)"
                        : "translateY(8px)",
                    transition: reducedMotion
                      ? "opacity 150ms linear"
                      : `opacity 300ms var(--ease-out) ${delayMs}ms, transform 300ms var(--ease-out) ${delayMs}ms`,
                  }}
                >
                  <span className="w-5 mt-0.5 flex items-center justify-start shrink-0 tabular-nums">
                    {status === "active" ? (
                      <span
                        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white text-[#006EFF] text-[13px]"
                        style={{
                          transform: "scale(1)",
                          transition: "transform 300ms var(--ease-spring)",
                        }}
                      >
                        {step.num}
                      </span>
                    ) : status === "done" ? (
                      <svg
                        className="w-4 h-4 text-white"
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
                          strokeDashoffset="0"
                        />
                      </svg>
                    ) : (
                      <span>{step.num}.</span>
                    )}
                  </span>
                  <span>{t(step.text)}</span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* RIGHT COLUMN: cols 8-12 (5 columns wide) */}
      <div className="md:col-span-5 flex flex-col min-h-[500px] md:h-full min-w-0">
        {/* Top 91%: Right panel (blue-200) — whole panel is the drop target, holds white file card in cols 9-11 */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isReading && !isExiting) setIsDraggingOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setIsDraggingOver(false);
            }
          }}
          onDrop={handleDrop}
          className="relative flex-1 md:h-[91%] min-h-0 flex flex-col items-center justify-center overflow-hidden px-5 sm:px-8 md:px-6 lg:px-8 xl:px-0 py-[clamp(16px,4vh,56px)]"
          style={{
            backgroundColor: isDraggingOver ? "#CFE4FF" : "var(--blue-200)",
            color: "var(--blue-900)",
            transformOrigin: exitStep >= 3 ? "right center" : "center bottom",
            transform: reducedMotion
              ? "none"
              : exitStep >= 3
              ? "scaleX(0)"
              : loadStep >= 2
              ? "scaleY(1)"
              : "scaleY(0)",
            opacity: reducedMotion ? (exitStep >= 3 ? 0 : 1) : 1,
            transition: reducedMotion
              ? "opacity 150ms linear, background-color 150ms var(--ease-out)"
              : exitStep >= 3
              ? "transform 300ms var(--ease-in), background-color 150ms var(--ease-out)"
              : "transform 500ms var(--ease-soft), background-color 150ms var(--ease-out)",
          }}
        >
          {/* White file card (cols 9-11 => ~68% of 5-col right panel, 16px radius — the only rounded element) */}
          <div className="relative z-10 w-full max-w-[460px] xl:max-w-none xl:w-[68%] h-full min-h-0 flex flex-col justify-center">
            <div
              onClick={() => {
                if (!isReading && !isExiting) {
                  openFilePicker();
                }
              }}
              role="button"
              tabIndex={isReading || isExiting ? -1 : 0}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (
                  !isReading &&
                  !isExiting &&
                  (e.key === "Enter" || e.key === " ")
                ) {
                  e.preventDefault();
                  openFilePicker();
                }
              }}
              aria-label={t("Drop receipt photos here or choose photos")}
              className={`bg-white rounded-[16px] flex-1 min-h-[240px] max-h-[540px] md:max-h-[62vh] flex flex-col p-5 sm:p-6 md:px-6 md:py-5 select-none overflow-hidden ${
                isReading || isExiting ? "cursor-default" : "cursor-pointer"
              }`}
              style={{
                color: "var(--blue-900)",
                transformOrigin: "center top",
                transform: reducedMotion
                  ? "none"
                  : exitStep >= 2
                  ? "scaleY(0)"
                  : loadStep >= 5
                  ? "scaleY(1)"
                  : "scaleY(0)",
                opacity: reducedMotion ? (exitStep >= 2 ? 0 : 1) : 1,
                transition: reducedMotion
                  ? "opacity 150ms linear"
                  : exitStep >= 2
                  ? "transform 260ms var(--ease-in)"
                  : "transform 400ms var(--ease-out)",
              }}
            >
              <div
                className="flex-1 min-h-0 flex flex-col"
                style={{
                  opacity: exitStep >= 1 ? 0 : 1,
                  transform:
                    exitStep >= 1 && !reducedMotion
                      ? "translateY(-8px)"
                      : "translateY(0)",
                  transition: reducedMotion
                    ? "opacity 150ms linear"
                    : "opacity 180ms var(--ease-in), transform 180ms var(--ease-in)",
                }}
              >
                {photos.length === 0 ? (
                  <div className="flex-1 flex flex-col items-start justify-center gap-2 text-[18px] lg:text-[20px] leading-[1.35]">
                    <span>
                      {isDraggingOver
                        ? t("Drop to add")
                        : t("Drop receipt photos here")}
                    </span>
                    {!isDraggingOver && (
                      <div className="flex flex-wrap items-center gap-4 text-[16px] lg:text-[18px]">
                        <span className="shoebox-link">{t("or choose photos")}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <CustomScrollList
                      theme="on-white"
                      fadeLastVisibleRow={true}
                      scrollToBottomTrigger={scrollTrigger}
                    >
                      <ul className="m-0 p-0 list-none flex flex-col">
                        {photos.map((photo, idx) => (
                          <FileRowItem
                            key={photo.id}
                            photo={photo}
                            index={idx}
                            isReading={isReading}
                            onRemove={() => onRemovePhoto(photo.id)}
                          />
                        ))}
                      </ul>
                    </CustomScrollList>

                    {!isReading && !isExiting && (
                      <div className="pt-2.5 mt-1 border-t border-[#006EFF]/15 flex flex-wrap items-center justify-between gap-3 text-[14px] lg:text-[15px] shrink-0">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="shoebox-link">{t("or choose photos")}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Privacy tick under the card on the right panel (A5 Step 1 & B7) */}
            <div
              className="mt-3 md:mt-4 shrink-0 select-none"
              style={{
                opacity: exitStep >= 1 ? 0 : loadStep >= 6 ? 1 : 0,
                transform:
                  exitStep >= 1 && !reducedMotion
                    ? "translateY(-8px)"
                    : "translateY(0)",
                transition: reducedMotion
                  ? "opacity 150ms linear"
                  : exitStep >= 1
                  ? "opacity 180ms var(--ease-in), transform 180ms var(--ease-in)"
                  : "opacity 300ms var(--ease-out)",
              }}
            >
              <div className="mb-2 flex flex-col gap-1.5 text-[#006EFF]/85 text-[11px] lg:text-[11.5px] leading-[1.35]">
                <p className="m-0">
                  By using this feature, you confirm that you have the necessary
                  rights to any content that you upload. Do not generate content
                  that infringes on others’ intellectual property or privacy
                  rights. Your use of this generative AI service is subject to
                  our{" "}
                  <a
                    href="https://policies.google.com/terms/generative-ai/use-policy"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline hover:opacity-80"
                  >{t("Prohibited Use Policy")}</a>
                  .
                </p>
              </div>

              <div className="text-[#006EFF] text-[13px] lg:text-[13.5px] leading-[1.35]">{t("Do not upload sensitive or private information. Uploaded data is sent to the Google Gemini API for processing.")}</div>
            </div>
          </div>
        </div>

        {/* Bottom 9%: White action bar (cols 8-12) */}
        <div
          onClick={() => {
            if (!canVisualise && !isReading && !isExiting) {
              if (photos.length === 0) {
                openFilePicker();
              }
            }
          }}
          className="h-[60px] md:h-[9%] min-h-[54px] bg-white flex items-center justify-center px-4 select-none shrink-0"
          style={{
            color: "var(--blue-900)",
            transformOrigin: "center bottom",
            transform: reducedMotion
              ? "none"
              : exitStep >= 3
              ? "scaleY(0)"
              : loadStep >= 3
              ? "scaleY(1)"
              : "scaleY(0)",
            opacity: reducedMotion ? (exitStep >= 3 ? 0 : 1) : 1,
            transition: reducedMotion
              ? "opacity 150ms linear"
              : exitStep >= 3
              ? "transform 240ms var(--ease-in)"
              : "transform 300ms var(--ease-out)",
          }}
        >
          <button
            type="button"
            disabled={!canVisualise}
            onClick={(e) => {
              e.stopPropagation();
              onStartVisualise();
            }}
            className={`shoebox-link text-[22px] md:text-[26px] lg:text-[28px] tracking-[-0.01em] ${
              loadStep < 8 && !reducedMotion ? "underline-draw-hidden" : ""
            }`}
            style={{
              opacity:
                exitStep >= 1
                  ? 0
                  : canVisualise || isReading
                  ? 1
                  : loadStep >= 3
                  ? 0.4
                  : 0,
              transform:
                exitStep >= 1 && !reducedMotion
                  ? "translateY(-8px)"
                  : undefined,
              transition: reducedMotion
                ? "opacity 150ms linear"
                : "opacity 200ms var(--ease-out), transform 120ms var(--ease-out)",
            }}
          >
            <span className="inline-flex items-baseline gap-1.5">
              {isReading ? (
                readingPhase === "reading_photos" ? (
                  <>
                    <span>{t("reading")}</span>
                    <RollingNumber value={completedPhotosCount} />
                    <span>{t("of {count}…", {count: photos.length})}</span>
                  </>
                ) : readingPhase === "checking_duplicates" ? (
                  <span>{t("checking duplicates…")}</span>
                ) : (
                  <span>{t("adding up…")}</span>
                )
              ) : photos.length > 0 ? (
                <>
                  <span>{t("visualise")}</span>
                  <RollingNumber value={photos.length} />
                  <span>{photos.length === 1 ? t("photo") : t("photos")}</span>
                </>
              ) : (
                <span>{t("visualise data")}</span>
              )}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

interface FileRowItemProps {
  photo: UploadedPhoto;
  index: number;
  isReading: boolean;
  onRemove: () => void;
}

const FileRowItem: React.FC<FileRowItemProps> = ({
  photo,
  index,
  isReading,
  onRemove,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [entered, setEntered] = useState(reducedMotion);

  useEffect(() => {
    if (reducedMotion) {
      setEntered(true);
      return;
    }
    const t = window.setTimeout(
      () => setEntered(true),
      Math.min(index * 40, 320)
    );
    return () => window.clearTimeout(t);
  }, [index, reducedMotion]);

  return (
    <li
      className="group relative border-b border-[#006EFF]/20 overflow-hidden transition-all"
      style={{
        maxHeight: entered ? "52px" : "0px",
        opacity: entered ? 1 : 0,
        transition: reducedMotion
          ? "opacity 150ms linear"
          : "max-height 200ms var(--ease-out), opacity 200ms var(--ease-out)",
      }}
    >
      <div
        className="flex items-center justify-between py-2 text-[15px] lg:text-[16px] leading-[1.2] tabular-nums gap-2"
        style={{
          transform:
            entered || reducedMotion ? "translateX(0)" : "translateX(-8px)",
          transition: reducedMotion
            ? "none"
            : "transform 200ms var(--ease-out)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="min-w-0 flex flex-col">
            <span className="truncate">{photo.displayName}</span>
          </div>
        </div>

        {/* Right status or hover remove x */}
        <div className="flex items-center gap-2 shrink-0">
          {photo.status === "reading" && (
            <span className="text-[14px] text-[#006EFF]/75">{t("reading")}</span>
          )}

          {photo.status === "done" && (
            <span className="inline-flex items-center gap-1.5 text-[14px] lg:text-[15px] text-[#006EFF]">
              <RollingNumber value={photo.receiptsCount} />
              <span>
                {photo.receiptsCount === 1 ? t("receipt") : t("receipts")}
              </span>
              <svg
                className="w-3.5 h-3.5 text-[#006EFF]"
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
                  strokeDashoffset="0"
                  style={{
                    transition: "stroke-dashoffset 300ms var(--ease-out)",
                  }}
                />
              </svg>
            </span>
          )}

          {photo.status === "error" && (
            <span className="text-[14px] text-[#006EFF]">{t("failed")}</span>
          )}

          {!isReading && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              aria-label={t("Remove {name}", { name: photo.displayName })}
              className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-[#006EFF] hover:opacity-80 px-1 text-[18px] leading-none transition-opacity duration-120 cursor-pointer"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {/* Progress fill under the row while its batch is in flight (A5 Step 2 & A7) */}
      {(photo.status === "reading" || photo.status === "done") && (
        <div className="absolute left-0 right-0 bottom-0 h-[3px] overflow-hidden pointer-events-none">
          <div
            className={`h-full w-full bg-[#3389FF] ${
              photo.status === "reading" ? "animate-sweep" : ""
            }`}
            style={{
              transformOrigin: "left center",
              transform: photo.status === "done" ? "scaleX(1)" : undefined,
              transition:
                photo.status === "done"
                  ? "transform 200ms var(--ease-out)"
                  : undefined,
            }}
          />
        </div>
      )}
    </li>
  );
};
