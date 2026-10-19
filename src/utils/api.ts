import { t } from "../i18n";

const KEY = "shoebox-api-base";
export const isPages = location.hostname.endsWith(".github.io");
export function getApiBase(): string {
  try { return localStorage.getItem(KEY) || import.meta.env.VITE_API_BASE_URL || ""; }
  catch { return import.meta.env.VITE_API_BASE_URL || ""; }
}
export function saveApiBase(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed) {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
      throw new Error(t("Enter a valid HTTPS URL (HTTP is allowed for localhost)."));
    }
  }
  if (trimmed) localStorage.setItem(KEY, trimmed);
  else localStorage.removeItem(KEY);
}
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = getApiBase();
  if (isPages && !base) {
    return Promise.reject(new Error(t("Connect an API server in Connection settings to analyze uploaded receipts. You can also try sample receipts.")));
  }
  return fetch(`${base}${path}`, init);
}
