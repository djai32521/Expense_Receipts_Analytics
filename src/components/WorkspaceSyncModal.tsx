import { t } from "../i18n";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  type DateRangeFilter,
  type DiscoveredWorkspaceItem,
  type DriveFolderItem,
  type IngestedWorkspaceFile,
  WorkspaceAuthExpiredError,
  clearSavedWorkspaceSession,
  downloadWorkspaceItemsAsFiles,
  getDriveFolderMetadata,
  getSavedWorkspaceSession,
  listDriveFolders,
  logout,
  parseDriveFolderId,
  requestWorkspaceAccessToken,
  saveWorkspaceSession,
  scanWorkspaceSources,
} from "../utils/workspaceLiveSync";
import { RollingNumber, usePrefersReducedMotion } from "./MotionPrimitives";

export const COST_CENTER_OPTIONS = [
  "CC-410 Sales",
  "CC-205 Eng",
  "CC-100 Ops",
  "CC-300 G&A",
  "Unassigned",
] as const;

export interface WorkspaceSyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  onIngestFiles: (items: IngestedWorkspaceFile[]) => void;
  connectedEmail?: string | null;
  onConnectedEmailChange?: (email: string | null) => void;
}

const DEFAULT_GMAIL_QUERY =
  "has:attachment (receipt OR invoice OR folio) filename:(jpg OR jpeg OR png OR webp OR pdf)";

function formatBytes(bytes?: number): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatShortIsoDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

export const WorkspaceSyncModal: React.FC<WorkspaceSyncModalProps> = ({
  isOpen,
  onClose,
  onIngestFiles,
  connectedEmail,
  onConnectedEmailChange,
}) => {
  const reducedMotion = usePrefersReducedMotion();
  const [isClosing, setIsClosing] = useState(false);

  // Step 1: OAuth & Source Selection (hydrated from sessionStorage if active)
  const [accessToken, setAccessToken] = useState<string | null>(
    () => getSavedWorkspaceSession()?.accessToken ?? null
  );
  const [accountEmail, setAccountEmail] = useState<string | null>(
    () => connectedEmail ?? getSavedWorkspaceSession()?.accountEmail ?? null
  );
  const [grantedScopes, setGrantedScopes] = useState<{
    drive: boolean;
    gmail: boolean;
  }>(
    () =>
      getSavedWorkspaceSession()?.grantedScopes ?? {
        drive: false,
        gmail: false,
      }
  );
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [scanDrive, setScanDrive] = useState<boolean>(true);
  const [scanGmail, setScanGmail] = useState<boolean>(true);

  // Step 2: Drive Folder, Gmail Query, Date Range & Cost Center
  const [folderInput, setFolderInput] = useState<string>("");
  const [selectedFolder, setSelectedFolder] = useState<DriveFolderItem | null>(
    null
  );
  const [driveFolders, setDriveFolders] = useState<DriveFolderItem[]>([]);
  const [folderSearch, setFolderSearch] = useState<string>("");
  const [isLoadingFolders, setIsLoadingFolders] = useState<boolean>(false);
  const [folderResolveStatus, setFolderResolveStatus] = useState<string | null>(
    null
  );
  const [maxDriveFiles, setMaxDriveFiles] = useState<10 | 25 | 50>(50);

  const [gmailQuery, setGmailQuery] = useState<string>(DEFAULT_GMAIL_QUERY);
  const [includeGmailHtml, setIncludeGmailHtml] = useState<boolean>(true);

  const [datePreset, setDatePreset] =
    useState<DateRangeFilter["preset"]>("all");
  const [customStartDate, setCustomStartDate] = useState<string>("");
  const [customEndDate, setCustomEndDate] = useState<string>("");

  const [defaultCostCenter, setDefaultCostCenter] =
    useState<string>("CC-410 Sales");

  // Step 3: Discovery & Batch Ingestion
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [hasScannedOnce, setHasScannedOnce] = useState<boolean>(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [discoveredItems, setDiscoveredItems] = useState<
    DiscoveredWorkspaceItem[]
  >([]);
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    new Set()
  );

  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<{
    completed: number;
    total: number;
    currentTitle: string;
  } | null>(null);

  const handleExpiredToken = useCallback(
    (customMessage?: string) => {
      clearSavedWorkspaceSession();
      setAccessToken(null);
      setAccountEmail(null);
      setGrantedScopes({ drive: false, gmail: false });
      onConnectedEmailChange?.(null);
      const msg =
        customMessage ||
        t("Your Google Workspace session expired. Please click 'Sign in with Google' in Step 01.");
      setAuthError(msg);
      setScanError(msg);
    },
    [onConnectedEmailChange]
  );

  // Re-verify persisted OAuth session whenever the drawer opens
  useEffect(() => {
    if (!isOpen) return;
    const savedSession = getSavedWorkspaceSession();
    if (savedSession) {
      setAccessToken(savedSession.accessToken);
      setAccountEmail(savedSession.accountEmail);
      setGrantedScopes(savedSession.grantedScopes);
      onConnectedEmailChange?.(savedSession.accountEmail);
    } else if (accessToken || accountEmail) {
      setAccessToken(null);
      setAccountEmail(null);
      setGrantedScopes({ drive: false, gmail: false });
      onConnectedEmailChange?.(null);
    }
  }, [isOpen]);

  const handleTriggerClose = useCallback(() => {
    if (isDownloading || isClosing) return;
    if (reducedMotion) {
      onClose();
      return;
    }
    setIsClosing(true);
    window.setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 240);
  }, [isDownloading, isClosing, reducedMotion, onClose]);

  // Close on Escape key with exit animation
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isDownloading) {
        e.stopPropagation();
        handleTriggerClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, isDownloading, handleTriggerClose]);

  // Fetch Drive folders when connected & scanDrive is enabled
  useEffect(() => {
    if (!isOpen || !accessToken || !scanDrive) return;
    let cancelled = false;
    setIsLoadingFolders(true);
    const timer = window.setTimeout(() => {
      void listDriveFolders(accessToken, folderSearch.trim() || undefined)
        .then((folders) => {
          if (cancelled) return;
          setDriveFolders(folders);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          if (err instanceof WorkspaceAuthExpiredError) {
            handleExpiredToken(err.message);
          }
        })
        .finally(() => {
          if (!cancelled) setIsLoadingFolders(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [isOpen, accessToken, scanDrive, folderSearch, handleExpiredToken]);

  const handleDisconnectAccount = () => {
    void logout();
    clearSavedWorkspaceSession();
    setAccessToken(null);
    setAccountEmail(null);
    setGrantedScopes({ drive: false, gmail: false });
    setDriveFolders([]);
    onConnectedEmailChange?.(null);
  };

  const runScanWithToken = async (
    token: string,
    folderOverride?: DriveFolderItem | null
  ) => {
    setScanError(null);
    let activeFolder = folderOverride ?? selectedFolder;

    // Always check if folderInput has a Drive link or folder ID that hasn't been resolved yet
    // or differs from the currently active folder, so pasting + clicking scan works on the first click.
    if (scanDrive && folderInput.trim()) {
      const parsedId = parseDriveFolderId(folderInput.trim());
      if (!parsedId) {
        setSelectedFolder(null);
        setFolderResolveStatus(
          t("Could not parse a valid Drive Folder ID from that URL.")
        );
        setScanError(
          "Invalid Google Drive folder URL or ID. Paste a Drive folder link (.../folders/...) or clear the folder input."
        );
        return;
      }
      if (
        !activeFolder ||
        activeFolder.id !== parsedId ||
        activeFolder.name.startsWith("Folder ")
      ) {
        try {
          const meta = await getDriveFolderMetadata(token, parsedId);
          activeFolder = meta || {
            id: parsedId,
            name: `Folder (${parsedId.slice(0, 8)}…)`,
          };
          setSelectedFolder(activeFolder);
          setFolderResolveStatus(
            meta
              ? `Selected "${meta.name}"`
              : `Using folder ID ${parsedId.slice(0, 12)}…`
          );
        } catch (err: unknown) {
          if (err instanceof WorkspaceAuthExpiredError) {
            handleExpiredToken(err.message);
            return;
          }
          activeFolder = {
            id: parsedId,
            name: `Folder (${parsedId.slice(0, 8)}…)`,
          };
          setSelectedFolder(activeFolder);
        }
      }
    }

    setIsScanning(true);
    setHasScannedOnce(true);
    try {
      const items = await scanWorkspaceSources({
        accessToken: token,
        scanDrive,
        driveFolderId: activeFolder?.id,
        driveFolderName: activeFolder?.name,
        maxDriveFiles,
        scanGmail,
        gmailQuery: gmailQuery.trim() || DEFAULT_GMAIL_QUERY,
        includeGmailHtml,
        maxGmailMessages: 25,
        dateRange: {
          preset: datePreset,
          startDate: datePreset === "custom" ? customStartDate : undefined,
          endDate: datePreset === "custom" ? customEndDate : undefined,
        },
      });
      setDiscoveredItems(items);
      setSelectedItemIds(new Set(items.map((it) => it.id)));
    } catch (err: unknown) {
      if (err instanceof WorkspaceAuthExpiredError) {
        handleExpiredToken(err.message);
        return;
      }
      const msg =
        err instanceof Error ? err.message : t("Failed to scan Workspace sources");
      setScanError(msg);
    } finally {
      setIsScanning(false);
    }
  };

  const connectAccount = async (
    overrideDrive?: boolean,
    overrideGmail?: boolean,
    autoScanIfFolderStaged = false
  ): Promise<string | null> => {
    const wantDrive = overrideDrive ?? scanDrive;
    const wantGmail = overrideGmail ?? scanGmail;
    if (!wantDrive && !wantGmail) {
      setAuthError("Select at least one source (Google Drive or Gmail).");
      return null;
    }

    setIsConnecting(true);
    setAuthError(null);
    setScanError(null);
    try {
      const res = await requestWorkspaceAccessToken({
        includeDrive: wantDrive,
        includeGmail: wantGmail,
      });
      const email = res.email || "Google Workspace User";
      const nextScopes = {
        drive: wantDrive || grantedScopes.drive,
        gmail: wantGmail || grantedScopes.gmail,
      };
      setAccessToken(res.accessToken);
      setAccountEmail(email);
      onConnectedEmailChange?.(email);
      setGrantedScopes(nextScopes);
      saveWorkspaceSession({
        accessToken: res.accessToken,
        accountEmail: email,
        grantedScopes: nextScopes,
        expiresAt: Date.now() + res.expiresIn * 1000,
      });

      // If the user already pasted a Drive folder URL/ID before connecting, resolve its name
      // and automatically scan it if triggered from the Step 01 connect button!
      let resolvedPreFolder: DriveFolderItem | null = selectedFolder;
      const rawFolderText = folderInput.trim() || selectedFolder?.id || "";
      if (wantDrive && rawFolderText) {
        const parsedId = parseDriveFolderId(rawFolderText);
        if (parsedId) {
          const meta = await getDriveFolderMetadata(res.accessToken, parsedId);
          resolvedPreFolder = meta || {
            id: parsedId,
            name: `Folder (${parsedId.slice(0, 8)}…)`,
          };
          setSelectedFolder(resolvedPreFolder);
          setFolderResolveStatus(
            meta
              ? `Selected "${meta.name}"`
              : `Using folder ID ${parsedId.slice(0, 12)}…`
          );
        }
      }

      if (autoScanIfFolderStaged && (resolvedPreFolder || folderInput.trim())) {
        void runScanWithToken(res.accessToken, resolvedPreFolder);
      }

      return res.accessToken;
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : t("Google Sign-In failed");
      setAuthError(msg);
      return null;
    } finally {
      setIsConnecting(false);
    }
  };

  const handleApplyFolderInput = async (rawValue?: string) => {
    const target = (rawValue ?? folderInput).trim();
    if (!target) {
      setSelectedFolder(null);
      setFolderResolveStatus(null);
      return;
    }
    const parsedId = parseDriveFolderId(target);
    if (!parsedId) {
      setSelectedFolder(null);
      setFolderResolveStatus(
        "Could not parse a valid Drive Folder ID. Paste a Drive folder link (.../folders/...) or folder ID."
      );
      return;
    }

    if (!accessToken) {
      setSelectedFolder({
        id: parsedId,
        name: `Folder ${parsedId.slice(0, 10)}…`,
      });
      setFolderResolveStatus(
        t("Folder ID staged — sign in with Google to auto-verify & scan.")
      );
      return;
    }

    setFolderResolveStatus(t("Resolving folder…"));
    try {
      const meta = await getDriveFolderMetadata(accessToken, parsedId);
      if (meta) {
        setSelectedFolder(meta);
        setFolderResolveStatus(`Selected "${meta.name}"`);
      } else {
        setSelectedFolder({
          id: parsedId,
          name: `Folder (${parsedId.slice(0, 10)}…)`,
        });
        setFolderResolveStatus(`Using folder ID ${parsedId.slice(0, 12)}…`);
      }
    } catch (err: unknown) {
      if (err instanceof WorkspaceAuthExpiredError) {
        handleExpiredToken(err.message);
        return;
      }
      setSelectedFolder({
        id: parsedId,
        name: `Folder (${parsedId.slice(0, 10)}…)`,
      });
      setFolderResolveStatus(`Using folder ID ${parsedId.slice(0, 12)}…`);
    }
  };

  const needsScopeUpgrade =
    Boolean(accessToken) &&
    ((scanDrive && !grantedScopes.drive) ||
      (scanGmail && !grantedScopes.gmail));

  const handleScanSources = async () => {
    setScanError(null);
    if (!scanDrive && !scanGmail) {
      setScanError(t("Enable Google Drive Folder and/or Gmail before scanning."));
      return;
    }

    let token = accessToken;
    if (!token || needsScopeUpgrade) {
      token = await connectAccount(scanDrive, scanGmail, false);
      if (!token) return;
    }

    await runScanWithToken(token);
  };

  const handleToggleItem = (id: string) => {
    setSelectedItemIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectedItems = useMemo(
    () => discoveredItems.filter((it) => selectedItemIds.has(it.id)),
    [discoveredItems, selectedItemIds]
  );

  const handleIngestSelected = async () => {
    if (!accessToken || selectedItems.length === 0 || isDownloading) return;
    setIsDownloading(true);
    setScanError(null);
    setDownloadProgress({
      completed: 0,
      total: selectedItems.length,
      currentTitle: selectedItems[0]?.title || "",
    });

    try {
      const files = await downloadWorkspaceItemsAsFiles(
        accessToken,
        selectedItems,
        defaultCostCenter,
        (completed, total, currentItemTitle) => {
          setDownloadProgress({
            completed,
            total,
            currentTitle: currentItemTitle,
          });
        }
      );

      if (files.length === 0) {
        setScanError(
          t("Could not download any of the selected items. Check file permissions.")
        );
        setIsDownloading(false);
        setDownloadProgress(null);
        return;
      }

      onIngestFiles(files);
      setIsDownloading(false);
      setDownloadProgress(null);
      handleTriggerClose();
    } catch (err: unknown) {
      setIsDownloading(false);
      setDownloadProgress(null);
      if (err instanceof WorkspaceAuthExpiredError) {
        handleExpiredToken(err.message);
        return;
      }
      const msg =
        err instanceof Error
          ? err.message
          : t("Failed to download Workspace items");
      setScanError(msg);
    }
  };

  if (!isOpen && !isClosing) return null;

  const downloadPct =
    downloadProgress && downloadProgress.total > 0
      ? Math.round((downloadProgress.completed / downloadProgress.total) * 100)
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end select-none"
      role="dialog"
      aria-modal="true"
      aria-label={t("Google Workspace Live Sync")}
    >
      {/* Architectural backdrop */}
      <div
        onClick={handleTriggerClose}
        className={`fixed inset-0 bg-[#001F4D]/60 ${
          reducedMotion ? "" : "animate-backdrop-in"
        }`}
        style={{
          opacity: isClosing ? 0 : 1,
          transition: "opacity 240ms var(--ease-out)",
        }}
      />

      {/* Right-hand full-height architectural slide-over drawer (0px border-radius, crisp 1px hairlines) */}
      <div
        className={`relative z-10 w-full max-w-[680px] h-full bg-white text-[#006EFF] border-l border-[#006EFF] flex flex-col overflow-hidden ${
          reducedMotion
            ? ""
            : isClosing
            ? "animate-drawer-out"
            : "animate-drawer-in"
        }`}
      >
        {/* TOP ARCHITECTURAL HEADER BLOCK (#006EFF) */}
        <div className="bg-[#006EFF] text-white px-6 py-5 border-b border-white/25 shrink-0 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="font-mono-badge px-2 py-0.5 bg-white text-[#006EFF]">{t("GOOGLE WORKSPACE")}</span>
              <span className="font-mono-badge text-white/80">{t("DRIVE & GMAIL OAUTH 2.0")}{" "}</span>
            </div>
            <h2 className="m-0 mt-2 text-[28px] md:text-[34px] tracking-[-0.02em] leading-[0.95]">{t("Sync Drive & Gmail Receipts")}{" "}</h2>
            <p className="m-0 mt-1.5 text-[14.5px] text-white/85 leading-[1.35]">{t("Pull receipt photos from a shared Drive folder or billing emails from Gmail directly into the Shoebox audit engine.")}</p>
          </div>

          <button
            type="button"
            disabled={isDownloading}
            onClick={handleTriggerClose}
            className="shoebox-link text-white text-[17px] shrink-0 mt-1"
          >{t("close ×")}</button>
        </div>

        {/* SCROLLABLE BODY */}
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[#006EFF]/25">
          {/* STEP 1: GOOGLE ACCOUNT & SCOPE SELECTION */}
          <section className="p-6 bg-[#F5F9FF]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span className="font-mono-badge px-1.5 py-0.5 bg-[#006EFF] text-white">{t("STEP 01")}</span>
                <h3 className="m-0 text-[19px] tracking-[-0.01em]">{t("Google Account & Scope Selection")}{" "}</h3>
              </div>
            </div>

            {/* Source Selection Checkboxes */}
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div
                onClick={() => setScanDrive((v) => !v)}
                role="checkbox"
                aria-checked={scanDrive}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    setScanDrive((v) => !v);
                  }
                }}
                className={`p-3.5 border cursor-pointer flex items-start gap-3 transition-colors ${
                  scanDrive
                    ? "bg-white border-[#006EFF]"
                    : "bg-white/60 border-[#006EFF]/35 hover:border-[#006EFF]"
                }`}
              >
                <span
                  className={`mt-0.5 w-4 h-4 shrink-0 border border-[#006EFF] flex items-center justify-center ${
                    scanDrive ? "bg-[#006EFF] text-white" : "bg-white"
                  }`}
                >
                  {scanDrive && "✓"}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-badge px-1.5 py-0.5 bg-[#BEDBFF] text-[#006EFF]">
                      DRIVE
                    </span>
                    <span className="text-[15.5px]">{t("Google Drive Folder")}</span>
                  </div>
                  <p className="m-0 mt-1 text-[12.5px] text-[#006EFF]/75 leading-snug">{t("Scan receipt images & PDFs inside any Drive folder.")}{" "}</p>
                </div>
              </div>

              <div
                onClick={() => setScanGmail((v) => !v)}
                role="checkbox"
                aria-checked={scanGmail}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    setScanGmail((v) => !v);
                  }
                }}
                className={`p-3.5 border cursor-pointer flex items-start gap-3 transition-colors ${
                  scanGmail
                    ? "bg-white border-[#006EFF]"
                    : "bg-white/60 border-[#006EFF]/35 hover:border-[#006EFF]"
                }`}
              >
                <span
                  className={`mt-0.5 w-4 h-4 shrink-0 border border-[#006EFF] flex items-center justify-center ${
                    scanGmail ? "bg-[#006EFF] text-white" : "bg-white"
                  }`}
                >
                  {scanGmail && "✓"}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-badge px-1.5 py-0.5 bg-[#BEDBFF] text-[#006EFF]">
                      GMAIL
                    </span>
                    <span className="text-[15.5px]">{t("Gmail Receipts & Invoices")}{" "}</span>
                  </div>
                  <p className="m-0 mt-1 text-[12.5px] text-[#006EFF]/75 leading-snug">{t("Optional — pull receipt attachments & HTML billing emails.")}{" "}</p>
                </div>
              </div>
            </div>

            {/* Standard Sign in with Google Button & Connected Status */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {accessToken ? (
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono-badge px-2.5 py-1 bg-[#006EFF] text-white inline-flex items-center gap-2">
                    <span>{t("● CONNECTED")}</span>
                    {accountEmail && <span>• {accountEmail}</span>}
                  </span>
                  {needsScopeUpgrade && (
                    <button
                      type="button"
                      disabled={isConnecting}
                      onClick={() =>
                        void connectAccount(scanDrive, scanGmail, true)
                      }
                      className="shoebox-link text-[14px] text-[#006EFF]"
                    >{t("authorize new scope →")}</button>
                  )}
                  <button
                    type="button"
                    disabled={isConnecting}
                    onClick={handleDisconnectAccount}
                    className="shoebox-link text-[13px] text-[#006EFF]/75"
                  >{t("sign out")}</button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={isConnecting}
                  onClick={() =>
                    void connectAccount(scanDrive, scanGmail, true)
                  }
                  className="gsi-material-button"
                >
                  <div className="gsi-material-button-state"></div>
                  <div className="gsi-material-button-content-wrapper">
                    <div className="gsi-material-button-icon">
                      <svg
                        version="1.1"
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 48 48"
                        style={{ display: "block" }}
                      >
                        <path
                          fill="#EA4335"
                          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                        ></path>
                        <path
                          fill="#4285F4"
                          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                        ></path>
                        <path
                          fill="#FBBC05"
                          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                        ></path>
                        <path
                          fill="#34A853"
                          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                        ></path>
                        <path fill="none" d="M0 0h48v48H0z"></path>
                      </svg>
                    </div>
                    <span className="gsi-material-button-contents">
                      {isConnecting
                        ? t("Signing in with Google…")
                        : t("Sign in with Google")}
                    </span>
                    <span style={{ display: "none" }}>{t("Sign in with Google")}</span>
                  </div>
                </button>
              )}
            </div>

            {authError && (
              <div className="mt-3 p-2.5 bg-[#006EFF] text-white text-[13.5px] flex items-center justify-between gap-3">
                <span>{authError}</span>
                <button
                  type="button"
                  disabled={isConnecting}
                  onClick={() =>
                    void connectAccount(scanDrive, scanGmail, true)
                  }
                  className="shoebox-link text-white text-[13px] shrink-0"
                >{t("try again →")}</button>
              </div>
            )}
          </section>

          {/* STEP 2: DRIVE FOLDER, GMAIL QUERY, DATE RANGE & COST CENTER */}
          <section className="p-6 bg-white flex flex-col gap-5">
            <div className="flex items-center gap-2.5">
              <span className="font-mono-badge px-1.5 py-0.5 bg-[#006EFF] text-white">{t("STEP 02")}</span>
              <h3 className="m-0 text-[19px] tracking-[-0.01em]">{t("Source Filters & Cost Center Tagging")}{" "}</h3>
            </div>

            {/* GOOGLE DRIVE CONTROLS */}
            {scanDrive && (
              <div className="p-4 bg-[#F5F9FF] border border-[#006EFF]/40 flex flex-col gap-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-badge px-1.5 py-0.5 bg-[#006EFF] text-white">{t("DRIVE FOLDER")}</span>
                    <span className="text-[15px]">
                      {selectedFolder
                        ? `Active: ${selectedFolder.name}`
                        : t("All accessible Drive receipt files")}
                    </span>
                  </div>

                  {selectedFolder && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFolder(null);
                        setFolderInput("");
                        setFolderResolveStatus(null);
                      }}
                      className="shoebox-link text-[13px]"
                    >{t("clear folder filter")}</button>
                  )}
                </div>

                {/* Paste Drive Folder URL or ID */}
                <div className="flex flex-col gap-1">
                  <label className="text-[13px] text-[#006EFF]/80">{t("Paste Google Drive Folder URL or Folder ID:")}</label>
                  <div className="flex items-stretch gap-2">
                    <input
                      type="text"
                      value={folderInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFolderInput(val);
                        if (!val.trim()) {
                          setSelectedFolder(null);
                          setFolderResolveStatus(null);
                        } else if (
                          val.includes("/folders/") ||
                          val.includes("id=")
                        ) {
                          void handleApplyFolderInput(val);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleApplyFolderInput();
                        }
                      }}
                      placeholder={t("https://drive.google.com/drive/folders/1a2b3c... or Folder ID")}
                      className="flex-1 bg-white text-[#006EFF] px-3 py-1.5 text-[14px] border border-[#006EFF] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void handleApplyFolderInput()}
                      className="px-3.5 py-1.5 bg-[#006EFF] text-white font-mono-badge cursor-pointer hover:bg-[#3389FF] transition-colors shrink-0"
                    >{t("USE FOLDER")}</button>
                  </div>
                  {folderResolveStatus && (
                    <span className="text-[12px] text-[#006EFF]/80">
                      {folderResolveStatus}
                    </span>
                  )}
                </div>

                {/* In-App Drive Folder Browser */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] text-[#006EFF]/80">{t("Or pick a folder from your Google Drive:")}</span>
                    <input
                      type="text"
                      value={folderSearch}
                      onChange={(e) => setFolderSearch(e.target.value)}
                      placeholder={t("Search folders (e.g. Shoebox Test Receipts)…")}
                      className="w-56 sm:w-64 bg-white text-[#006EFF] px-2.5 py-1 text-[13px] border border-[#006EFF]/50 focus:border-[#006EFF] outline-none"
                    />
                  </div>

                  <div className="max-h-[144px] overflow-y-auto border border-[#006EFF]/30 bg-white divide-y divide-[#006EFF]/15">
                    {!accessToken ? (
                      <div className="px-3 py-3 text-[13px] text-[#006EFF]/70">{t("Connect your Google account in Step 01 to browse your Drive folders live, or paste a folder link above.")}</div>
                    ) : isLoadingFolders ? (
                      <div className="px-3 py-3 text-[13px] text-[#006EFF]/75">{t("Loading folders from Google Drive…")}</div>
                    ) : driveFolders.length === 0 ? (
                      <div className="px-3 py-3 text-[13px] text-[#006EFF]/70">{t("No matching folders found. Paste a Drive folder URL above to use it directly.")}</div>
                    ) : (
                      driveFolders.map((folder) => {
                        const isSelected = selectedFolder?.id === folder.id;
                        return (
                          <button
                            key={folder.id}
                            type="button"
                            onClick={() => {
                              setSelectedFolder(isSelected ? null : folder);
                              setFolderInput(isSelected ? "" : folder.id);
                              setFolderResolveStatus(
                                isSelected
                                  ? null
                                  : `Selected "${folder.name}"`
                              );
                            }}
                            className={`w-full px-3 py-2 text-left flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                              isSelected
                                ? "bg-[#006EFF] text-white"
                                : "bg-white text-[#006EFF] workspace-row-hover"
                            }`}
                          >
                            <span className="truncate text-[14px]">
                              📁 {folder.name}
                            </span>
                            <span
                              className={`font-mono-badge shrink-0 ${
                                isSelected
                                  ? "text-white"
                                  : "text-[#006EFF]/70"
                              }`}
                            >
                              {isSelected ? "[SELECTED ✓]" : "SELECT"}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Max Drive Files Selector */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[13px] text-[#006EFF]/80">{t("Max files to scan from folder:")}</span>
                  <div className="flex items-center gap-1.5">
                    {([10, 25, 50] as const).map((limit) => (
                      <button
                        key={limit}
                        type="button"
                        onClick={() => setMaxDriveFiles(limit)}
                        className={`font-mono-badge px-2.5 py-1 border border-[#006EFF] cursor-pointer transition-colors ${
                          maxDriveFiles === limit
                            ? "bg-[#006EFF] text-white"
                            : "bg-white text-[#006EFF] hover:bg-[#BEDBFF]"
                        }`}
                      >
                        {limit}{" "}{t("FILES")}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* GMAIL CONTROLS */}
            {scanGmail && (
              <div className="p-4 bg-[#F5F9FF] border border-[#006EFF]/40 flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono-badge px-1.5 py-0.5 bg-[#006EFF] text-white">{t("GMAIL SEARCH QUERY")}</span>
                  <button
                    type="button"
                    onClick={() => setGmailQuery(DEFAULT_GMAIL_QUERY)}
                    className="shoebox-link text-[12.5px]"
                  >{t("reset default query")}</button>
                </div>

                <input
                  type="text"
                  value={gmailQuery}
                  onChange={(e) => setGmailQuery(e.target.value)}
                  className="w-full bg-white text-[#006EFF] px-3 py-1.5 text-[13.5px] border border-[#006EFF] outline-none font-mono"
                />

                <div
                  onClick={() => setIncludeGmailHtml((v) => !v)}
                  role="checkbox"
                  aria-checked={includeGmailHtml}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      setIncludeGmailHtml((v) => !v);
                    }
                  }}
                  className="flex items-center gap-2.5 cursor-pointer text-[13.5px]"
                >
                  <span
                    className={`w-4 h-4 shrink-0 border border-[#006EFF] flex items-center justify-center text-[11px] ${
                      includeGmailHtml
                        ? "bg-[#006EFF] text-white"
                        : "bg-white"
                    }`}
                  >
                    {includeGmailHtml && "✓"}
                  </span>
                  <span>
                    {t("Also rasterize HTML email body receipts (e.g. Uber, Lyft, airline e-receipts without image attachments)")}
                  </span>
                </div>
              </div>
            )}

            {/* DATE RANGE FILTER */}
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono-badge text-[#006EFF]">
                  {t("DATE RANGE FILTER (DRIVE & GMAIL)")}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  {(
                    [
                      { id: "all", label: t("All dates") },
                      { id: "7d", label: t("Last 7d") },
                      { id: "30d", label: t("Last 30d") },
                      { id: "90d", label: t("Last 90d") },
                      { id: "custom", label: "Custom" },
                    ] as const
                  ).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setDatePreset(p.id)}
                      className={`font-mono-badge px-2.5 py-1 border border-[#006EFF] cursor-pointer transition-colors ${
                        datePreset === p.id
                          ? "bg-[#006EFF] text-white"
                          : "bg-white text-[#006EFF] hover:bg-[#BEDBFF]"
                      }`}
                    >
                      {t(p.label)}
                    </button>
                  ))}
                </div>
              </div>

              {datePreset === "custom" && (
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <label className="flex flex-col gap-1 text-[12.5px]">
                    <span>{t("From date")}</span>
                    <input
                      type="date"
                      value={customStartDate}
                      onChange={(e) => setCustomStartDate(e.target.value)}
                      className="bg-white text-[#006EFF] px-2.5 py-1 border border-[#006EFF] outline-none tabular-nums"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[12.5px]">
                    <span>{t("To date")}</span>
                    <input
                      type="date"
                      value={customEndDate}
                      onChange={(e) => setCustomEndDate(e.target.value)}
                      className="bg-white text-[#006EFF] px-2.5 py-1 border border-[#006EFF] outline-none tabular-nums"
                    />
                  </label>
                </div>
              )}
            </div>

            {/* DEFAULT COST CENTER TAG */}
            <div className="flex flex-col gap-2">
              <span className="font-mono-badge text-[#006EFF]">{t("DEFAULT COST CENTER TAG")}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                {COST_CENTER_OPTIONS.map((cc) => (
                  <button
                    key={cc}
                    type="button"
                    onClick={() => setDefaultCostCenter(cc)}
                    className={`font-mono-badge px-2.5 py-1 border border-[#006EFF] cursor-pointer transition-colors ${
                      defaultCostCenter === cc
                        ? "bg-[#006EFF] text-white"
                        : "bg-white text-[#006EFF] hover:bg-[#BEDBFF]"
                    }`}
                  >
                    {t(cc)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* STEP 3: LIVE DISCOVERY PREVIEW & BATCH INGESTION */}
          <section className="p-6 bg-white flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="font-mono-badge px-1.5 py-0.5 bg-[#006EFF] text-white">{t("STEP 03")}</span>
                <h3 className="m-0 text-[19px] tracking-[-0.01em]">{t("Live Discovery & Batch Audit Ingestion")}{" "}</h3>
              </div>

              <button
                type="button"
                disabled={isScanning || isDownloading}
                onClick={() => void handleScanSources()}
                className="shoebox-link text-[17px] text-[#006EFF]"
              >
                {isScanning
                  ? t("scanning workspace…")
                  : t("scan selected sources →")}
              </button>
            </div>

            {/* Indeterminate sweep progress bar while scanning */}
            {isScanning && (
              <div className="w-full h-[3px] bg-[#BEDBFF] overflow-hidden">
                <div className="h-full w-full bg-[#006EFF] animate-sweep" />
              </div>
            )}

            {scanError && (
              <div className="p-3 bg-[#006EFF] text-white text-[13.5px]">
                {scanError}
              </div>
            )}

            {/* Discovered items list */}
            {hasScannedOnce && !isScanning && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between gap-2 text-[13.5px]">
                  <span className="tabular-nums">{t("Found")}{" "}
                    <strong>
                      <RollingNumber value={discoveredItems.length} />
                    </strong>{" "}
                    {discoveredItems.length === 1
                      ? t("workspace item")
                      : t("workspace items")}{" "}
                    ({selectedItems.length} selected)
                  </span>

                  {discoveredItems.length > 0 && (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setSelectedItemIds(
                            new Set(discoveredItems.map((i) => i.id))
                          )
                        }
                        className="shoebox-link text-[13px]"
                      >{t("select all")}</button>
                      <button
                        type="button"
                        onClick={() => setSelectedItemIds(new Set())}
                        className="shoebox-link text-[13px]"
                      >{t("deselect all")}</button>
                    </div>
                  )}
                </div>

                {discoveredItems.length === 0 ? (
                  <div className="p-5 bg-[#F5F9FF] border border-[#006EFF]/30 text-[14px] text-[#006EFF]/80">
                    {t("No matching receipt images or billing emails found for the current folder / date filter. Try selecting")}{" "}
                    <strong>{t("All dates")}</strong>{t("or choosing another Drive folder.")}</div>
                ) : (
                  <div className="max-h-[260px] overflow-y-auto border border-[#006EFF] divide-y divide-[#006EFF]/20 bg-white">
                    {discoveredItems.map((item, idx) => {
                      const checked = selectedItemIds.has(item.id);
                      const isDrive = item.sourceType === "drive_file";
                      const staggerDelay = Math.min(idx * 30, 450);

                      return (
                        <div
                          key={item.id}
                          onClick={() => handleToggleItem(item.id)}
                          className={`px-3.5 py-2.5 flex items-center justify-between gap-3 cursor-pointer workspace-row-hover ${
                            reducedMotion ? "" : "animate-row-stagger"
                          } ${checked ? "bg-[#F5F9FF]" : "bg-white opacity-70"}`}
                          style={
                            reducedMotion
                              ? undefined
                              : { animationDelay: `${staggerDelay}ms` }
                          }
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={`w-4 h-4 shrink-0 border border-[#006EFF] flex items-center justify-center text-[11px] ${
                                checked
                                  ? "bg-[#006EFF] text-white"
                                  : "bg-white"
                              }`}
                            >
                              {checked && "✓"}
                            </span>

                            <span
                              className={`font-mono-badge px-1.5 py-0.5 shrink-0 ${
                                isDrive
                                  ? "bg-[#006EFF] text-white"
                                  : "bg-[#BEDBFF] text-[#006EFF]"
                              }`}
                            >
                              {isDrive ? "[DRIVE]" : "[GMAIL]"}
                            </span>

                            <div className="min-w-0 flex flex-col">
                              <span className="text-[14.5px] truncate">
                                {item.title}
                              </span>
                              <span className="text-[12px] text-[#006EFF]/75 truncate">
                                {item.subtitle}
                              </span>
                            </div>
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0 text-[12px] text-[#006EFF]/80 tabular-nums">
                            {item.sizeBytes ? (
                              <span>{formatBytes(item.sizeBytes)}</span>
                            ) : null}
                            <span>{formatShortIsoDate(item.dateIso)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* BOTTOM STICKY INGESTION BAR */}
        <div className="px-6 py-4 bg-[#BEDBFF] border-t border-[#006EFF] shrink-0 flex flex-col gap-2">
          {isDownloading && downloadProgress && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[13px] tabular-nums">
                <span className="truncate pr-2">{t("Downloading {done} of {count} ({name})…", {done: downloadProgress.completed, count: downloadProgress.total, name: downloadProgress.currentTitle})}
                </span>
                <span className="font-mono-badge">{downloadPct}%</span>
              </div>
              <div className="w-full h-[4px] bg-white overflow-hidden">
                <div
                  className="h-full bg-[#006EFF] transition-all duration-150"
                  style={{ width: `${downloadPct}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col min-w-0 gap-0.5">
              <div className="text-[13.5px] text-[#006EFF] truncate">
                {t("Cost Center")}:{" "}
                <span className="font-mono-badge px-1.5 py-0.5 bg-white text-[#006EFF]">
                  {defaultCostCenter}
                </span>
              </div>
              <span className="text-[11.5px] text-[#006EFF]/80 truncate">{t("By ingesting, you consent to sending selected receipts to Gemini for extraction.")}</span>
            </div>

            <button
              type="button"
              disabled={selectedItems.length === 0 || isDownloading}
              onClick={() => void handleIngestSelected()}
              className="shoebox-link text-[20px] md:text-[22px] text-[#006EFF] disabled:opacity-40 shrink-0"
            >
              {isDownloading ? (
                <span>{t("ingesting {done} of {count}…", {done: downloadProgress?.completed ?? 0, count: selectedItems.length})}
                </span>
              ) : (
                <span>{t("ingest & audit")}{" "}
                  <RollingNumber value={selectedItems.length} />{" "}
                  {selectedItems.length === 1 ? t("file") : t("files")} →
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
