import { useEffect, useState } from "react";
import { api, AppConfig, loadConfig, Me, saveConfig } from "./api";
import { ConfigDialog } from "./ConfigDialog";
import { Dashboard } from "./Dashboard";
import { Coach } from "./Coach";

type Page = "dashboard" | "coach";
const PAGES: { id: Page; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "coach", label: "LLM Coach" },
];

function pageFromHash(): Page {
  return window.location.hash === "#/coach" ? "coach" : "dashboard";
}

export function App() {
  const [config, setConfig] = useState<AppConfig | null>(() => loadConfig());
  const [editing, setEditing] = useState(false);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [me, setMe] = useState<Me | null>(null);
  const [version, setVersion] = useState(0); // bump to refetch after uploads

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (p: Page) => {
    window.location.hash = p === "coach" ? "#/coach" : "#/";
    setPage(p);
  };

  const showDialog = !config || editing;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          COD <span>Coach</span>
        </div>
        <nav className="nav" aria-label="Pages">
          {PAGES.map((p) => (
            <button key={p.id} aria-current={page === p.id ? "page" : undefined} onClick={() => go(p.id)}>
              {p.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {config && (
          <button className="cfg-chip" onClick={() => setEditing(true)} title="Change catalog / schema">
            ⚙ <code>{config.catalog}.{config.schema}</code>
          </button>
        )}
      </header>

      <main>
        {config && page === "dashboard" && (
          <Dashboard config={config} version={version} onUploaded={() => setVersion((v) => v + 1)} />
        )}
        {config && page === "coach" && <Coach config={config} endpoint={me?.llm_endpoint ?? ""} version={version} />}
      </main>

      {showDialog && (
        <ConfigDialog
          initial={config}
          defaults={{ catalog: me?.default_catalog ?? "", schema: me?.default_schema ?? "cod_coach" }}
          onSaved={(c) => {
            saveConfig(c);
            setConfig(c);
            setEditing(false);
            setVersion((v) => v + 1);
          }}
          onCancel={config ? () => setEditing(false) : undefined}
        />
      )}
    </>
  );
}
