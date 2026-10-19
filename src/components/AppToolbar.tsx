import { useEffect, useRef, useState } from "react";
import { setLanguage, t, useLanguage } from "../i18n";
import { getApiBase, isPages, saveApiBase } from "../utils/api";

export function AppToolbar({ onSample, onWorkspace, isSample, busy }: { onSample: () => void; onWorkspace: () => void; isSample: boolean; busy: boolean }) {
  const language = useLanguage();
  const [open, setOpen] = useState(false);
  const [base, setBase] = useState(getApiBase);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialogRef.current?.showModal(); else dialogRef.current?.close(); }, [open]);
  return <>
    <header className="app-toolbar">
      <span className="toolbar-brand">Shoebox <small>{isSample ? t("Sample data · fictional receipts") : isPages && !getApiBase() ? "DEMO" : t(getApiBase() ? "Connected API server" : "Local API server")}</small></span>
      <nav aria-label={t("Language")}>
        <button type="button" aria-pressed={language === "ko"} onClick={() => setLanguage("ko")}>한국어</button>
        <button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
        <button type="button" disabled={busy} onClick={onSample}>{t("Try sample receipts")}</button>
        <button type="button" disabled={busy} onClick={onWorkspace}>{t("Connect Workspace")}</button>
        <button type="button" onClick={() => {setBase(getApiBase()); setError(""); setOpen(true);}}>{t("Connection settings")}</button>
      </nav>
    </header>
    {isPages && !getApiBase() && <p className="pages-notice">{t("GitHub Pages demo: try sample receipts, or connect your API server to analyze uploads.")}</p>}
    <dialog ref={dialogRef} className="connection-dialog" onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="connection-title">
      <form onSubmit={(event) => {event.preventDefault(); try {saveApiBase(base); setOpen(false);} catch {setError(t("Enter a valid HTTPS URL (HTTP is allowed for localhost)."));}}}>
        <h2 id="connection-title">{t("Connection settings")}</h2>
        <p>{t("Use an HTTPS server you trust. Uploaded receipts will be sent to this server. Leave blank to use the local server.")}</p>
        <label htmlFor="api-base">{t("API server URL")}</label>
        <input autoFocus id="api-base" type="url" placeholder="https://your-api.example.com" value={base} onChange={(e) => setBase(e.target.value)} />
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" onClick={() => setOpen(false)}>{t("Cancel")}</button><button type="submit">{t("Save")}</button></div>
      </form>
    </dialog>
  </>;
}
