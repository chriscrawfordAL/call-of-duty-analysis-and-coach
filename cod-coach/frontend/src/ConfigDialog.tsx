import { useEffect, useState } from "react";
import { api, AppConfig } from "./api";

type Props = {
  initial: AppConfig | null;
  defaults: { catalog: string; schema: string };
  onSaved: (c: AppConfig) => void;
  onCancel?: () => void;
};

const NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;

export function ConfigDialog({ initial, defaults, onSaved, onCancel }: Props) {
  const [catalogs, setCatalogs] = useState<string[] | null>(null);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [catalog, setCatalog] = useState(initial?.catalog ?? "");
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [schema, setSchema] = useState(initial?.schema ?? "");
  const [newSchema, setNewSchema] = useState(defaults.schema || "cod_coach");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .catalogs()
      .then(({ catalogs }) => {
        setCatalogs(catalogs);
        if (!catalog) {
          const pick = catalogs.includes(defaults.catalog) ? defaults.catalog : catalogs[0] ?? "";
          setCatalog(pick);
        }
      })
      .catch((e: Error) => setError(`Could not list catalogs: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!catalog) return;
    setSchemas(null);
    api
      .schemas(catalog)
      .then(({ schemas }) => {
        setSchemas(schemas);
        if (schemas.includes(schema)) return;
        if (schemas.includes(newSchema)) {
          setSchema(newSchema);
          setMode("existing");
        } else {
          setSchema(schemas[0] ?? "");
          setMode(schemas.length ? "existing" : "new");
        }
      })
      .catch((e: Error) => setError(`Could not list schemas in ${catalog}: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog]);

  const target = mode === "new" ? newSchema.trim() : schema;
  const nameOk = NAME_RE.test(target);
  const exists = mode === "new" && schemas?.includes(target);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.configure(catalog, target, mode === "new");
      const cfg = { catalog, schema: target };
      onSaved(cfg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="backdrop" role="dialog" aria-modal="true" aria-labelledby="cfg-title">
      <div className="dialog">
        <h2 id="cfg-title">Where should your data live?</h2>
        <p className="lead">
          Pick the Unity Catalog location for your match history. Every SAR file you upload is merged into
          tables here (<code>sar_*</code>), so your history keeps growing across exports.
        </p>

        <div className="field">
          <label htmlFor="cfg-catalog">Catalog</label>
          <select id="cfg-catalog" value={catalog} onChange={(e) => setCatalog(e.target.value)} disabled={!catalogs}>
            {!catalogs && <option>Loading catalogs…</option>}
            {catalogs?.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="radio-row" role="radiogroup" aria-label="Schema">
          <label>
            <input
              type="radio"
              checked={mode === "existing"}
              onChange={() => setMode("existing")}
              disabled={!schemas?.length}
            />
            Use existing schema
          </label>
          <label>
            <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
            Create new schema
          </label>
        </div>

        {mode === "existing" ? (
          <div className="field">
            <label htmlFor="cfg-schema">Schema</label>
            <select id="cfg-schema" value={schema} onChange={(e) => setSchema(e.target.value)} disabled={!schemas}>
              {!schemas && <option>Loading schemas…</option>}
              {schemas?.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="cfg-new">New schema name</label>
            <input id="cfg-new" value={newSchema} onChange={(e) => setNewSchema(e.target.value)} />
            <span className="hint">
              {exists
                ? "That schema already exists — it will be reused."
                : nameOk
                  ? `Will create ${catalog}.${target} (requires CREATE SCHEMA on the catalog).`
                  : "Use letters, numbers, underscores or hyphens."}
            </span>
          </div>
        )}

        {error && <div className="error">{error}</div>}

        <div className="actions">
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={!catalog || !nameOk || saving}>
            {saving ? "Saving…" : mode === "new" && !exists ? "Create & continue" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
