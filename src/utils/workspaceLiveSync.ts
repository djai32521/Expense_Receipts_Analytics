import { initializeApp, getApps, getApp } from "firebase/app";
import { apiFetch } from "./api";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";
import type { WorkspaceSourceMeta } from "../types";

export interface DriveFolderItem {
  id: string;
  name: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface DiscoveredWorkspaceItem {
  id: string;
  sourceType: "drive_file" | "gmail_attachment" | "gmail_html";
  title: string;
  subtitle: string;
  dateIso: string | null;
  sizeBytes?: number;
  mimeType: string;
  driveFileId?: string;
  driveFolderId?: string;
  driveFolderName?: string;
  driveWebViewLink?: string;
  driveOwner?: string;
  gmailMessageId?: string;
  gmailThreadId?: string;
  gmailAttachmentId?: string;
  emailFrom?: string;
  emailSubject?: string;
  htmlBody?: string;
}

export interface DateRangeFilter {
  preset: "all" | "7d" | "30d" | "90d" | "custom";
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
}

export interface WorkspaceScanOptions {
  accessToken: string;
  scanDrive: boolean;
  driveFolderId?: string;
  driveFolderName?: string;
  maxDriveFiles?: number;
  scanGmail: boolean;
  gmailQuery?: string;
  includeGmailHtml?: boolean;
  maxGmailMessages?: number;
  dateRange: DateRangeFilter;
}

export interface IngestedWorkspaceFile {
  file: File;
  sourceMeta: WorkspaceSourceMeta;
}

export interface SavedWorkspaceSession {
  accessToken: string;
  accountEmail: string;
  grantedScopes: {
    drive: boolean;
    gmail: boolean;
  };
  expiresAt: number;
}

export class WorkspaceAuthExpiredError extends Error {
  constructor(
    message = "Your Google Workspace session has expired (401). Please click 'Sign in with Google' in Step 01."
  ) {
    super(message);
    this.name = "WorkspaceAuthExpiredError";
  }
}

export const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.activity",
  "https://www.googleapis.com/auth/drive.activity.readonly",
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/drive.apps.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.install",
  "https://www.googleapis.com/auth/drive.meet.readonly",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
  "https://www.googleapis.com/auth/drive.photos.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.scripts",
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
  "https://www.googleapis.com/auth/gmail.addons.current.message.action",
  "https://www.googleapis.com/auth/gmail.addons.current.message.metadata",
  "https://www.googleapis.com/auth/gmail.addons.current.message.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.insert",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.metadata",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
];

const WEB_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

const WEB_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
WEB_DRIVE_SCOPES.forEach((s) => provider.addScope(s));
WEB_GMAIL_SCOPES.forEach((s) => provider.addScope(s));

// Flag to indicate if we are in the middle of a sign-in flow.
let isSigningIn = false;
// Cache the access token and session strictly in memory (never in localStorage or sessionStorage).
let cachedAccessToken: string | null = null;
let cachedWorkspaceSession: SavedWorkspaceSession | null = null;
let cachedGoogleClientId = "";

// Initialize auth state listener. Call this on app load.
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        cachedWorkspaceSession = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      cachedWorkspaceSession = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

// Must be called from a button click or user interaction
export const googleSignIn = async (options?: {
  includeDrive?: boolean;
  includeGmail?: boolean;
}): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const includeDrive = options?.includeDrive ?? true;
    const includeGmail = options?.includeGmail ?? true;

    const activeProvider = new GoogleAuthProvider();
    if (includeDrive) {
      WEB_DRIVE_SCOPES.forEach((s) => activeProvider.addScope(s));
    }
    if (includeGmail) {
      WEB_GMAIL_SCOPES.forEach((s) => activeProvider.addScope(s));
    }
    activeProvider.setCustomParameters({
      prompt: "consent",
      include_granted_scopes: "true",
    });

    const result = await signInWithPopup(auth, activeProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Failed to get access token from Firebase Auth");
    }

    cachedAccessToken = credential.accessToken;
    const email = result.user.email || "Google Workspace User";
    cachedWorkspaceSession = {
      accessToken: cachedAccessToken,
      accountEmail: email,
      grantedScopes: {
        drive: includeDrive || Boolean(cachedWorkspaceSession?.grantedScopes.drive),
        gmail: includeGmail || Boolean(cachedWorkspaceSession?.grantedScopes.gmail),
      },
      expiresAt: Date.now() + 3600 * 1000,
    };

    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: unknown) {
    console.error("Sign in error:", error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
  cachedWorkspaceSession = null;
};

interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GisTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void;
}

interface GisWindow {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (response: GisTokenResponse) => void;
          error_callback?: (err: { type?: string; message?: string }) => void;
        }) => GisTokenClient;
      };
    };
  };
}

export function getSavedGoogleClientId(): string {
  return cachedGoogleClientId;
}

export function saveGoogleClientId(clientId: string): void {
  cachedGoogleClientId = clientId.trim();
}

export function getSavedWorkspaceSession(): SavedWorkspaceSession | null {
  if (!cachedWorkspaceSession || !cachedAccessToken) {
    return null;
  }
  if (Date.now() + 15_000 >= cachedWorkspaceSession.expiresAt) {
    cachedAccessToken = null;
    cachedWorkspaceSession = null;
    return null;
  }
  return cachedWorkspaceSession;
}

export function saveWorkspaceSession(session: SavedWorkspaceSession): void {
  cachedAccessToken = session.accessToken;
  cachedWorkspaceSession = session;
}

export function clearSavedWorkspaceSession(): void {
  cachedAccessToken = null;
  cachedWorkspaceSession = null;
}

export interface ServerWorkspaceConfig {
  firebaseConfig?: {
    apiKey?: string;
    authDomain?: string;
    projectId?: string;
    appId?: string;
    oAuthClientId?: string;
    oauthClientId?: string;
    [key: string]: unknown;
  } | null;
  googleClientId?: string | null;
}

export async function fetchServerWorkspaceConfig(): Promise<ServerWorkspaceConfig> {
  try {
    const res = await apiFetch("/api/workspace-config");
    if (!res.ok) return {};
    return (await res.json()) as ServerWorkspaceConfig;
  } catch {
    return {};
  }
}

export async function fetchServerGoogleClientId(): Promise<string | null> {
  const cfg = await fetchServerWorkspaceConfig();
  return cfg.googleClientId?.trim() || null;
}

export function parseDriveFolderId(input: string): string {
  const trimmed = (input || "").trim();
  if (!trimmed) return "";

  const folderMatch = /\/folders\/([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (folderMatch && folderMatch[1]) {
    return folderMatch[1];
  }

  const idParamMatch = /[?&]id=([a-zA-Z0-9_-]+)/.exec(trimmed);
  if (idParamMatch && idParamMatch[1]) {
    return idParamMatch[1];
  }

  if (/\/my-drive(?:\/|$|\?|#)/i.test(trimmed)) {
    return "root";
  }

  // Reject arbitrary URLs (such as /file/d/... or non-folder links) that don't contain a folder ID
  if (
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes(" ")
  ) {
    return "";
  }

  const cleaned = trimmed.split(/[?#]/)[0].trim();
  return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : "";
}

export function resolveReceiptMimeType(
  filename: string,
  itemMimeType?: string,
  blobMimeType?: string
): string {
  const candidates = [itemMimeType, blobMimeType]
    .map((m) => (m || "").toLowerCase().trim())
    .filter((m) => m && m !== "application/octet-stream");

  for (const c of candidates) {
    if (c === "image/jpg") return "image/jpeg";
    if (
      c === "image/jpeg" ||
      c === "image/png" ||
      c === "image/webp" ||
      c === "image/heic" ||
      c === "image/heif" ||
      c === "application/pdf"
    ) {
      return c;
    }
  }

  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "pdf":
      return "application/pdf";
    default:
      return candidates[0]?.startsWith("image/") ? candidates[0] : "image/jpeg";
  }
}

function ensureFilenameHasExtension(filename: string, mimeType: string): string {
  const trimmed = (filename || "receipt").trim();
  if (/\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(trimmed)) {
    return trimmed;
  }
  switch (mimeType.toLowerCase()) {
    case "image/png":
      return `${trimmed}.png`;
    case "image/webp":
      return `${trimmed}.webp`;
    case "image/heic":
      return `${trimmed}.heic`;
    case "image/heif":
      return `${trimmed}.heif`;
    case "application/pdf":
      return `${trimmed}.pdf`;
    default:
      return `${trimmed}.jpg`;
  }
}

let gisLoadPromise: Promise<void> | null = null;

function ensureGisLoaded(): Promise<void> {
  const win = window as unknown as GisWindow;
  if (win.google?.accounts?.oauth2) {
    return Promise.resolve();
  }
  if (gisLoadPromise) {
    return gisLoadPromise;
  }
  gisLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    ) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () =>
          reject(new Error("Failed to load Google Identity Services script.")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisLoadPromise = null;
      reject(
        new Error("Failed to load Google Identity Services (gsi/client).")
      );
    };
    document.head.appendChild(script);
  });
  return gisLoadPromise;
}

export async function requestWorkspaceAccessToken(params: {
  clientId?: string;
  includeDrive: boolean;
  includeGmail: boolean;
}): Promise<{ accessToken: string; email?: string; expiresIn: number }> {
  // 1. Native Firebase Auth popup flow using provisioned firebase-applet-config.json
  if (firebaseConfig.apiKey && firebaseConfig.authDomain && !params.clientId?.trim()) {
    try {
      const signInResult = await googleSignIn({
        includeDrive: params.includeDrive,
        includeGmail: params.includeGmail,
      });
      if (signInResult) {
        return {
          accessToken: signInResult.accessToken,
          email: signInResult.user.email || undefined,
          expiresIn: 3600,
        };
      }
    } catch (fbErr: unknown) {
      const msg = fbErr instanceof Error ? fbErr.message : String(fbErr);
      const isUserCancelled =
        msg.includes("popup-closed-by-user") ||
        msg.includes("cancelled-popup-request");
      if (isUserCancelled) {
        throw new Error(
          "Google sign-in popup was closed before completing authorization."
        );
      }
      if (msg.includes("popup-blocked")) {
        throw new Error(
          "Google sign-in popup was blocked by your browser. Please allow popups for this site and try again."
        );
      }
      throw fbErr;
    }
  }

  const serverCfg = await fetchServerWorkspaceConfig();
  const cleanClientId = (
    params.clientId ||
    serverCfg.googleClientId ||
    firebaseConfig.oAuthClientId ||
    getSavedGoogleClientId() ||
    ""
  ).trim();

  if (!cleanClientId) {
    throw new Error(
      "Google OAuth is not enabled on this applet yet. Ask the AI Studio chat: 'Enable Google OAuth for Google Drive and Gmail'."
    );
  }

  await ensureGisLoaded();
  const win = window as unknown as GisWindow;
  const oauth2 = win.google?.accounts?.oauth2;
  if (!oauth2) {
    throw new Error("Google Identity Services OAuth2 client is unavailable.");
  }

  const scopes = ["https://www.googleapis.com/auth/userinfo.email"];
  if (params.includeDrive) {
    scopes.push(...WEB_DRIVE_SCOPES);
  }
  if (params.includeGmail) {
    scopes.push(...WEB_GMAIL_SCOPES);
  }

  const tokenResp = await new Promise<GisTokenResponse>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: cleanClientId,
      scope: scopes.join(" "),
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(
            new Error(
              resp.error_description ||
                resp.error ||
                "OAuth authorization failed or was cancelled."
            )
          );
          return;
        }
        resolve(resp);
      },
      error_callback: (err) => {
        reject(
          new Error(
            err?.message ||
              (err?.type === "popup_closed"
                ? "Google sign-in popup was closed."
                : "Google OAuth popup error.")
          )
        );
      },
    });
    client.requestAccessToken({ prompt: "consent" });
  });

  const accessToken = tokenResp.access_token!;
  const expiresIn = Number(tokenResp.expires_in) || 3600;

  let email: string | undefined;
  try {
    const profileRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    if (profileRes.ok) {
      const profile = (await profileRes.json()) as { email?: string };
      if (profile.email) {
        email = profile.email;
      }
    }
  } catch {
    // ignore optional userinfo lookup failure
  }

  cachedAccessToken = accessToken;
  cachedWorkspaceSession = {
    accessToken,
    accountEmail: email || "Google Workspace User",
    grantedScopes: {
      drive: params.includeDrive || Boolean(cachedWorkspaceSession?.grantedScopes.drive),
      gmail: params.includeGmail || Boolean(cachedWorkspaceSession?.grantedScopes.gmail),
    },
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return { accessToken, email, expiresIn };
}

async function fetchGoogleJson<T>(
  url: string,
  accessToken: string
): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      clearSavedWorkspaceSession();
      throw new WorkspaceAuthExpiredError();
    }
    let errDetail = `${res.status} ${res.statusText}`;
    try {
      const errJson = (await res.json()) as {
        error?: { message?: string };
      };
      if (errJson?.error?.message) {
        errDetail = errJson.error.message;
      }
    } catch {
      // ignore parse failure
    }
    throw new Error(`Google API error: ${errDetail}`);
  }
  return (await res.json()) as T;
}

export async function listDriveFolders(
  accessToken: string,
  searchQuery?: string
): Promise<DriveFolderItem[]> {
  let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  if (searchQuery && searchQuery.trim()) {
    const escaped = searchQuery
      .trim()
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'");
    q += ` and name contains '${escaped}'`;
  }

  const params = new URLSearchParams({
    q,
    fields: "files(id,name,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
    pageSize: "30",
    includeItemsFromAllDrives: "true",
    supportsAllDrives: "true",
  });

  const data = await fetchGoogleJson<{ files?: DriveFolderItem[] }>(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    accessToken
  );

  return data.files || [];
}

export async function getDriveFolderMetadata(
  accessToken: string,
  folderId: string
): Promise<DriveFolderItem | null> {
  const cleanId = parseDriveFolderId(folderId);
  if (!cleanId || cleanId === "all") return null;
  if (cleanId === "root") {
    return { id: "root", name: "My Drive (Root)" };
  }

  try {
    const params = new URLSearchParams({
      fields: "id,name,modifiedTime,webViewLink",
      supportsAllDrives: "true",
    });
    const item = await fetchGoogleJson<DriveFolderItem>(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        cleanId
      )}?${params.toString()}`,
      accessToken
    );
    return item || null;
  } catch (err) {
    if (err instanceof WorkspaceAuthExpiredError) {
      throw err;
    }
    return null;
  }
}

function resolveDateRangeBounds(dateRange: DateRangeFilter): {
  startIso: string | null;
  endIso: string | null;
  gmailAfter: string | null;
  gmailBefore: string | null;
} {
  if (!dateRange || dateRange.preset === "all") {
    return {
      startIso: null,
      endIso: null,
      gmailAfter: null,
      gmailBefore: null,
    };
  }

  let startDateObj: Date | null = null;
  let endDateObj: Date | null = null;

  if (
    dateRange.preset === "7d" ||
    dateRange.preset === "30d" ||
    dateRange.preset === "90d"
  ) {
    const days =
      dateRange.preset === "7d" ? 7 : dateRange.preset === "30d" ? 30 : 90;
    startDateObj = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  } else if (dateRange.preset === "custom") {
    if (dateRange.startDate) {
      const parsedStart = new Date(`${dateRange.startDate}T00:00:00.000Z`);
      if (!Number.isNaN(parsedStart.getTime())) {
        startDateObj = parsedStart;
      }
    }
    if (dateRange.endDate) {
      const parsedEnd = new Date(`${dateRange.endDate}T23:59:59.999Z`);
      if (!Number.isNaN(parsedEnd.getTime())) {
        endDateObj = parsedEnd;
      }
    }
  }

  const toGmailSlashDate = (d: Date) => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}/${mm}/${dd}`;
  };

  return {
    startIso: startDateObj ? startDateObj.toISOString() : null,
    endIso: endDateObj ? endDateObj.toISOString() : null,
    gmailAfter: startDateObj ? toGmailSlashDate(startDateObj) : null,
    gmailBefore: endDateObj ? toGmailSlashDate(endDateObj) : null,
  };
}

interface DriveApiFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: {
    attachmentId?: string;
    size?: number;
    data?: string;
  };
  parts?: GmailMessagePart[];
}

interface GmailMessageDetail {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailMessagePart;
}

function decodeBase64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64UrlToUtf8(base64Url: string): string {
  try {
    const bytes = decodeBase64UrlToUint8Array(base64Url);
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

export async function scanWorkspaceSources(
  options: WorkspaceScanOptions
): Promise<DiscoveredWorkspaceItem[]> {
  const discovered: DiscoveredWorkspaceItem[] = [];
  const bounds = resolveDateRangeBounds(options.dateRange);

  if (options.scanDrive) {
    const cleanFolderId = options.driveFolderId
      ? parseDriveFolderId(options.driveFolderId)
      : "";
    const clauses: string[] = [
      "trashed = false",
      "(mimeType contains 'image/' or mimeType = 'application/pdf')",
    ];
    if (cleanFolderId && cleanFolderId !== "all") {
      const escapedFolder = cleanFolderId
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'");
      clauses.unshift(`'${escapedFolder}' in parents`);
    }
    if (bounds.startIso) {
      clauses.push(`modifiedTime >= '${bounds.startIso}'`);
    }
    if (bounds.endIso) {
      clauses.push(`modifiedTime <= '${bounds.endIso}'`);
    }

    const params = new URLSearchParams({
      q: clauses.join(" and "),
      fields:
        "files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,owners(emailAddress,displayName))",
      pageSize: String(options.maxDriveFiles || 50),
      orderBy: "name",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
    });

    const driveData = await fetchGoogleJson<{ files?: DriveApiFile[] }>(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      options.accessToken
    );

    const folderLabel = options.driveFolderName || "Google Drive";
    for (const f of driveData.files || []) {
      const rawDate = f.createdTime || f.modifiedTime || null;
      const dateIso = rawDate ? rawDate.slice(0, 10) : null;
      const owner =
        f.owners?.[0]?.emailAddress || f.owners?.[0]?.displayName || undefined;
      const resolvedMime = resolveReceiptMimeType(f.name, f.mimeType);

      discovered.push({
        id: `drive_${f.id}`,
        sourceType: "drive_file",
        title: f.name,
        subtitle: options.driveFolderName
          ? `Drive · ${options.driveFolderName}`
          : "Google Drive",
        dateIso,
        sizeBytes: f.size ? Number(f.size) : undefined,
        mimeType: resolvedMime,
        driveFileId: f.id,
        driveFolderId:
          cleanFolderId && cleanFolderId !== "all" ? cleanFolderId : undefined,
        driveFolderName: folderLabel,
        driveWebViewLink: f.webViewLink,
        driveOwner: owner,
      });
    }
  }

  if (options.scanGmail) {
    let q =
      options.gmailQuery && options.gmailQuery.trim()
        ? options.gmailQuery.trim()
        : "has:attachment (receipt OR invoice OR folio) filename:(jpg OR jpeg OR png OR webp OR pdf)";
    if (bounds.gmailAfter) {
      q += ` after:${bounds.gmailAfter}`;
    }
    if (bounds.gmailBefore) {
      q += ` before:${bounds.gmailBefore}`;
    }

    const listParams = new URLSearchParams({
      q,
      maxResults: String(options.maxGmailMessages || 20),
    });

    const msgListData = await fetchGoogleJson<{
      messages?: Array<{ id: string; threadId: string }>;
    }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${listParams.toString()}`,
      options.accessToken
    );

    const messages = msgListData.messages || [];
    const batchSize = 5;

    for (let i = 0; i < messages.length; i += batchSize) {
      const chunk = messages.slice(i, i + batchSize);
      const details = await Promise.all(
        chunk.map((m) =>
          fetchGoogleJson<GmailMessageDetail>(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
              m.id
            )}?format=full`,
            options.accessToken
          ).catch((err) => {
            if (err instanceof WorkspaceAuthExpiredError) throw err;
            return null;
          })
        )
      );

      for (const detail of details) {
        if (!detail || !detail.payload) continue;
        const headers = detail.payload.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
            ?.value || "";

        const emailSubject = getHeader("Subject") || "Receipt Email";
        const emailFrom = getHeader("From") || "Gmail Sender";
        const internalMs = detail.internalDate
          ? Number(detail.internalDate)
          : NaN;
        const dateIso = !Number.isNaN(internalMs)
          ? new Date(internalMs).toISOString().slice(0, 10)
          : null;

        let foundAttachment = false;
        let htmlContent = "";
        let plainContent = "";

        const walkParts = (part: GmailMessagePart) => {
          const mime = (part.mimeType || "").toLowerCase().trim();
          const fname = (part.filename || "").trim();
          const partHeaders = part.headers || [];
          const disposition =
            partHeaders
              .find((h) => h.name?.toLowerCase() === "content-disposition")
              ?.value?.toLowerCase() || "";
          const hasContentId = partHeaders.some(
            (h) => h.name?.toLowerCase() === "content-id"
          );
          const isPdf =
            mime === "application/pdf" || /\.pdf$/i.test(fname);
          const isTinyInlineImage =
            !isPdf &&
            (disposition.startsWith("inline") || hasContentId) &&
            typeof part.body?.size === "number" &&
            part.body.size > 0 &&
            part.body.size < 10_240;

          const isSupportedAttachment =
            !isTinyInlineImage &&
            (mime === "image/jpeg" ||
              mime === "image/jpg" ||
              mime === "image/png" ||
              mime === "image/webp" ||
              mime === "image/heic" ||
              mime === "image/heif" ||
              mime === "application/pdf" ||
              /\.(jpe?g|png|webp|heic|heif|pdf)$/i.test(fname));

          if (isSupportedAttachment && part.body?.attachmentId) {
            foundAttachment = true;
            const resolvedMime = resolveReceiptMimeType(fname, mime);
            const fallbackTitle = ensureFilenameHasExtension(
              fname || emailSubject,
              resolvedMime
            );
            discovered.push({
              id: `gmail_att_${detail.id}_${part.body.attachmentId.slice(0, 16)}`,
              sourceType: "gmail_attachment",
              title: fallbackTitle,
              subtitle: `Gmail · ${emailFrom}`,
              dateIso,
              sizeBytes: part.body.size,
              mimeType: resolvedMime,
              gmailMessageId: detail.id,
              gmailThreadId: detail.threadId,
              gmailAttachmentId: part.body.attachmentId,
              emailFrom,
              emailSubject,
            });
          } else if (options.includeGmailHtml && part.body?.data) {
            if (mime === "text/html" && !htmlContent) {
              htmlContent = decodeBase64UrlToUtf8(part.body.data);
            } else if (mime === "text/plain" && !plainContent) {
              plainContent = decodeBase64UrlToUtf8(part.body.data);
            }
          }

          if (Array.isArray(part.parts)) {
            for (const sub of part.parts) {
              walkParts(sub);
            }
          }
        };

        walkParts(detail.payload);

        const bestEmailBody = htmlContent || plainContent;
        if (!foundAttachment && options.includeGmailHtml && bestEmailBody) {
          discovered.push({
            id: `gmail_html_${detail.id}`,
            sourceType: "gmail_html",
            title: emailSubject,
            subtitle: `Gmail HTML · ${emailFrom}`,
            dateIso,
            mimeType: "image/jpeg",
            gmailMessageId: detail.id,
            gmailThreadId: detail.threadId,
            emailFrom,
            emailSubject,
            htmlBody: bestEmailBody,
          });
        }
      }
    }
  }

  return discovered;
}

async function renderGmailHtmlToReceiptFile(
  item: DiscoveredWorkspaceItem
): Promise<File> {
  const canvas = document.createElement("canvas");
  canvas.width = 1000;
  canvas.height = 1300;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context unavailable for HTML email rendering.");
  }

  // Warm archival paper backdrop
  ctx.fillStyle = "#F5F2EB";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Inner receipt card
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(60, 50, 880, 1200);
  ctx.strokeStyle = "#1E1D1A";
  ctx.lineWidth = 2;
  ctx.strokeRect(60, 50, 880, 1200);

  // Header metadata
  ctx.fillStyle = "#111111";
  ctx.font = "bold 24px monospace";
  ctx.fillText("EMAIL RECEIPT / TAX INVOICE", 100, 105);

  ctx.font = "18px monospace";
  ctx.fillStyle = "#333333";
  ctx.fillText(`From: ${(item.emailFrom || "").slice(0, 68)}`, 100, 145);
  ctx.fillText(`Subject: ${(item.emailSubject || "").slice(0, 65)}`, 100, 175);
  ctx.fillText(`Date: ${item.dateIso || "Unknown"}`, 100, 205);

  ctx.beginPath();
  ctx.moveTo(100, 225);
  ctx.lineTo(900, 225);
  ctx.strokeStyle = "#CCCCCC";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Strip HTML tags while preserving table cell spacing and block line breaks
  const rawHtml = item.htmlBody || "";
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(rawHtml);
  let textContent = rawHtml;
  if (looksLikeHtml) {
    const doc = new DOMParser().parseFromString(rawHtml, "text/html");
    doc
      .querySelectorAll("style, script, noscript, head, svg")
      .forEach((el) => el.remove());
    doc.querySelectorAll("br").forEach((el) => el.replaceWith("\n"));
    doc.querySelectorAll("td, th").forEach((el) => el.append("   "));
    doc
      .querySelectorAll(
        "p, div, tr, li, h1, h2, h3, h4, h5, h6, section, article, header, footer, blockquote"
      )
      .forEach((el) => el.append("\n"));
    textContent = doc.body?.textContent || "";
  }

  const normalizedLines = textContent
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim());

  ctx.fillStyle = "#111111";
  ctx.font = "17px monospace";

  let y = 265;
  const maxCharsPerLine = 72;
  let consecutiveBlanks = 0;

  for (const trimmed of normalizedLines) {
    if (!trimmed) {
      consecutiveBlanks++;
      if (consecutiveBlanks <= 1) {
        y += 14;
      }
      continue;
    }
    consecutiveBlanks = 0;

    // Word-wrap on whitespace so currency numbers and dates are never split across two lines
    const words = trimmed.split(" ");
    let currentLine = "";
    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
      } else if (currentLine.length + 1 + word.length <= maxCharsPerLine) {
        currentLine += ` ${word}`;
      } else {
        if (y > 1210) break;
        ctx.fillText(currentLine, 100, y);
        y += 24;
        currentLine = word;
      }
      while (currentLine.length > maxCharsPerLine) {
        if (y > 1210) break;
        ctx.fillText(currentLine.slice(0, maxCharsPerLine), 100, y);
        y += 24;
        currentLine = currentLine.slice(maxCharsPerLine);
      }
    }
    if (currentLine && y <= 1210) {
      ctx.fillText(currentLine, 100, y);
      y += 24;
    }
    if (y > 1210) break;
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))),
      "image/jpeg",
      0.92
    );
  });

  const safeName =
    (item.title || "gmail-receipt")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 60) + ".jpg";
  return new File([blob], safeName, { type: "image/jpeg" });
}

export async function downloadWorkspaceItemsAsFiles(
  accessToken: string,
  items: DiscoveredWorkspaceItem[],
  defaultCostCenter?: string,
  onProgress?: (
    completed: number,
    total: number,
    currentItemTitle: string
  ) => void
): Promise<IngestedWorkspaceFile[]> {
  const results: Array<IngestedWorkspaceFile | null> = new Array(
    items.length
  ).fill(null);
  let nextIndex = 0;
  let completedCount = 0;
  const concurrency = Math.min(4, Math.max(1, items.length));

  const downloadSingleItem = async (
    item: DiscoveredWorkspaceItem
  ): Promise<IngestedWorkspaceFile> => {
    const cleanCostCenter = defaultCostCenter?.trim() || undefined;

    if (item.sourceType === "drive_file" && item.driveFileId) {
      const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        item.driveFileId
      )}?alt=media&supportsAllDrives=true`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        if (res.status === 401) {
          clearSavedWorkspaceSession();
          throw new WorkspaceAuthExpiredError();
        }
        throw new Error(
          `Failed to download Drive file "${item.title}" (${res.status})`
        );
      }
      const blob = await res.blob();
      const mimeType = resolveReceiptMimeType(
        item.title,
        item.mimeType,
        blob.type
      );
      const fileName = ensureFilenameHasExtension(item.title, mimeType);
      const file = new File([blob], fileName, { type: mimeType });

      return {
        file,
        sourceMeta: {
          sourceType: "drive_file",
          costCenter: cleanCostCenter,
          driveFileId: item.driveFileId,
          driveFolderId: item.driveFolderId,
          driveFolderName: item.driveFolderName,
          driveFileName: item.title,
          driveWebViewLink: item.driveWebViewLink,
          driveCreatedTime: item.dateIso || undefined,
          driveOwner: item.driveOwner,
        },
      };
    }

    if (
      item.sourceType === "gmail_attachment" &&
      item.gmailMessageId &&
      item.gmailAttachmentId
    ) {
      const data = await fetchGoogleJson<{ data?: string }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
          item.gmailMessageId
        )}/attachments/${encodeURIComponent(item.gmailAttachmentId)}`,
        accessToken
      );
      if (!data.data) {
        throw new Error(`Empty Gmail attachment payload for "${item.title}".`);
      }
      const bytes = decodeBase64UrlToUint8Array(data.data);
      const mimeType = resolveReceiptMimeType(item.title, item.mimeType);
      const fileName = ensureFilenameHasExtension(item.title, mimeType);
      const file = new File([bytes], fileName, { type: mimeType });

      return {
        file,
        sourceMeta: {
          sourceType: "gmail_attachment",
          costCenter: cleanCostCenter,
          gmailMessageId: item.gmailMessageId,
          gmailThreadId: item.gmailThreadId,
          emailFrom: item.emailFrom,
          emailSubject: item.emailSubject,
          emailDate: item.dateIso || undefined,
          attachmentFilename: item.title,
        },
      };
    }

    if (item.sourceType === "gmail_html") {
      const file = await renderGmailHtmlToReceiptFile(item);
      return {
        file,
        sourceMeta: {
          sourceType: "gmail_html",
          costCenter: cleanCostCenter,
          gmailMessageId: item.gmailMessageId,
          gmailThreadId: item.gmailThreadId,
          emailFrom: item.emailFrom,
          emailSubject: item.emailSubject,
          emailDate: item.dateIso || undefined,
        },
      };
    }

    throw new Error(
      `Unsupported workspace item sourceType: ${item.sourceType}`
    );
  };

  let lastItemError: unknown = null;

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) break;
      const item = items[idx];
      try {
        const ingested = await downloadSingleItem(item);
        results[idx] = ingested;
      } catch (err: unknown) {
        if (err instanceof WorkspaceAuthExpiredError) {
          throw err;
        }
        lastItemError = err;
        console.warn(`Skipping failed Workspace item "${item.title}":`, err);
      } finally {
        completedCount++;
        onProgress?.(completedCount, items.length, item.title);
      }
    }
  });

  await Promise.all(workers);
  const downloaded = results.filter(
    (r): r is IngestedWorkspaceFile => r !== null
  );
  if (downloaded.length === 0 && lastItemError) {
    throw lastItemError;
  }
  return downloaded;
}

function encodeUtf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function encodeUtf8ToBase64Url(text: string): string {
  return encodeUtf8ToBase64(text)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function saveAuditCsvToDrive(
  accessToken: string,
  filename: string,
  csvContent: string,
  folderId?: string
): Promise<{ id: string; name: string; webViewLink?: string }> {
  const boundary = "shoebox_drive_multipart_boundary_" + Date.now();
  const metadata: Record<string, unknown> = {
    name: filename,
    mimeType: "text/csv",
    description: "Shoebox Workspace Spend Audit & Receipt Reconciliation Ledger",
  };
  if (folderId && folderId !== "all" && folderId !== "root") {
    metadata.parents = [folderId];
  }

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/csv; charset=UTF-8\r\n\r\n` +
    `${csvContent}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (!res.ok) {
    if (res.status === 401) {
      clearSavedWorkspaceSession();
      throw new WorkspaceAuthExpiredError();
    }
    let errDetail = `${res.status} ${res.statusText}`;
    try {
      const errJson = (await res.json()) as { error?: { message?: string } };
      if (errJson?.error?.message) errDetail = errJson.error.message;
    } catch {
      // ignore
    }
    throw new Error(`Google Drive upload failed: ${errDetail}`);
  }

  return (await res.json()) as { id: string; name: string; webViewLink?: string };
}

export async function createAuditGmailDraft(
  accessToken: string,
  options: {
    to?: string;
    subject: string;
    bodyText: string;
    csvFilename: string;
    csvContent: string;
  }
): Promise<{ id: string; message?: { id: string; threadId: string } }> {
  const boundary = "shoebox_gmail_mime_boundary_" + Date.now();
  const cleanTo = (options.to || "").trim();
  const csvBase64 = encodeUtf8ToBase64(options.csvContent);

  const headers = [
    ...(cleanTo ? [`To: ${cleanTo}`] : []),
    `Subject: ${options.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];

  const mimeMessage =
    headers.join("\r\n") +
    "\r\n\r\n" +
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 7bit\r\n\r\n` +
    `${options.bodyText}\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/csv; name="${options.csvFilename}"\r\n` +
    `Content-Disposition: attachment; filename="${options.csvFilename}"\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n` +
    `${csvBase64}\r\n` +
    `--${boundary}--`;

  const raw = encodeUtf8ToBase64Url(mimeMessage);

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: { raw },
      }),
    }
  );

  if (!res.ok) {
    if (res.status === 401) {
      clearSavedWorkspaceSession();
      throw new WorkspaceAuthExpiredError();
    }
    let errDetail = `${res.status} ${res.statusText}`;
    try {
      const errJson = (await res.json()) as { error?: { message?: string } };
      if (errJson?.error?.message) errDetail = errJson.error.message;
    } catch {
      // ignore
    }
    throw new Error(`Gmail draft creation failed: ${errDetail}`);
  }

  return (await res.json()) as {
    id: string;
    message?: { id: string; threadId: string };
  };
}

