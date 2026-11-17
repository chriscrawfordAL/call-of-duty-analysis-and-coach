import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, AppConfig, DashboardData, MpMatch, UploadResult, utc } from "./api";

// Chart tokens (SVG attributes can't read CSS variables).
const C = {
  s1: "#3987e5",
  s2: "#d95926",
  s3: "#199e70",
  grid: "#2c2c2a",
  axis: "#383835",
  muted: "#898781",
  text: "#f0efec",
  surface: "#1a1a19",
  surface2: "#232322",
  good: "#0ca30c",
  critical: "#d03b3b",
};
const SEQ = ["#232322", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#6da7ec", "#9ec5f4"];

const axisProps = {
  stroke: C.axis,
  tick: { fill: C.muted, fontSize: 11 },
  tickLine: false,
} as const;
const tooltipProps = {
  contentStyle: { background: C.surface2, border: `1px solid rgba(255,255,255,0.12)`, borderRadius: 8, fontSize: 12 },
  labelStyle: { color: C.text, marginBottom: 4 },
  itemStyle: { color: C.text, padding: 0 },
  cursor: { fill: "rgba(255,255,255,0.04)", stroke: C.axis },
} as const;

const sum = <T,>(rows: T[], f: (r: T) => number | null | undefined) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
const fmt = (n: number | null | undefined, d = 2) => (n == null || !isFinite(n) ? "—" : n.toFixed(d));
const pct = (n: number | null | undefined, d = 1) => (n == null || !isFinite(n) ? "—" : `${n.toFixed(d)}%`);
const shortDate = (ts: string) => utc(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDate = (ts: string) =>
  utc(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const shortTitle = (t: string) => t.replace(/^Call of Duty:\s*/, "");

function rolling(values: (number | null)[], n: number) {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - n + 1), i + 1).filter((v): v is number => v != null);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
  });
}

// ------------------------------------------------------------------ upload

function UploadBar({ config, onUploaded }: { config: AppConfig; onUploaded: () => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const send = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const r = await api.upload(config, file);
        setResult(r);
        if (r.status === "ok") onUploaded();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
        if (input.current) input.current.value = "";
      }
    },
    [config, onUploaded],
  );

  const added = result?.new_rows
    ? Object.entries(result.new_rows)
        .filter(([t]) => ["sar_mp_matches", "sar_dmz_matches", "sar_campaign_checkpoints", "sar_sessions"].includes(t))
        .map(([t, n]) => `${n} ${t.replace("sar_", "").replace(/_/g, " ")}`)
        .join(" · ")
    : "";

  return (
    <div>
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files[0]);
        }}
      >
        <div style={{ fontSize: 26 }} aria-hidden>
          ⬆
        </div>
        <div className="grow">
          <strong>Upload an Activision SAR export</strong>
          <span className="hint">
            Drop the <code>*-ACTIVISION_ACCOUNT.html</code> file here. New matches are merged with your history;
            matches already stored are skipped.
          </span>
        </div>
        <input
          ref={input}
          type="file"
          accept=".html,.htm,text/html"
          hidden
          onChange={(e) => void send(e.target.files?.[0])}
        />
        <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Processing…" : "Choose file"}
        </button>
      </div>
      {error && (
        <div className="error" style={{ marginTop: 10 }}>
          Upload failed: {error}
        </div>
      )}
      {result?.status === "duplicate" && (
        <div className="error" style={{ marginTop: 10 }}>
          {result.message}
        </div>
      )}
      {result?.status === "ok" && (
        <div className="ok" style={{ marginTop: 10 }}>
          ✓ Upload stored. New rows: {added || "none (all already in your history)"}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "up" | "down" }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note && <div className={`delta ${tone ?? ""}`}>{note}</div>}
    </div>
  );
}

function ChartCard({ title, sub, children, height = 240 }: { title: string; sub?: string; children: React.ReactElement; height?: number }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {sub && <p className="sub">{sub}</p>}
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Heatmap({ stamps }: { stamps: string[] }) {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  stamps.forEach((s) => {
    const d = utc(s);
    grid[(d.getDay() + 6) % 7][d.getHours()] += 1;
  });
  const max = Math.max(1, ...grid.flat());
  const color = (v: number) => (v === 0 ? SEQ[0] : SEQ[Math.min(SEQ.length - 1, 1 + Math.floor(((v - 1) / max) * (SEQ.length - 1)))]);
  return (
    <div className="card">
      <h3>When you play</h3>
      <p className="sub">Game launches and matches by day and hour (your local time)</p>
      <div className="heat">
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="hlabel">
            {h % 3 === 0 ? h : ""}
          </div>
        ))}
        {grid.map((row, di) => (
          <Row key={di} day={days[di]} row={row} color={color} />
        ))}
      </div>
      <div className="legend-scale">
        Fewer {SEQ.slice(1).map((c) => <span key={c} className="sw" style={{ background: c }} />)} More
      </div>
    </div>
  );
}
function Row({ day, row, color }: { day: string; row: number[]; color: (v: number) => string }) {
  return (
    <>
      <div className="dlabel">{day}</div>
      {row.map((v, h) => (
        <div key={h} className="cell" style={{ background: color(v) }} title={`${day} ${h}:00 — ${v} event${v === 1 ? "" : "s"}`} />
      ))}
    </>
  );
}

// ------------------------------------------------------------------ dashboard

export function Dashboard({ config, version, onUploaded }: { config: AppConfig; version: number; onUploaded: () => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string>("all");

  useEffect(() => {
    setError(null);
    api
      .dashboard(config)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, [config, version]);

  const titles = useMemo(() => [...new Set((data?.mp_matches ?? []).map((m) => m.title_))].sort(), [data]);
  useEffect(() => {
    if (title !== "all" && !titles.includes(title)) setTitle("all");
  }, [titles, title]);

  const mp: MpMatch[] = useMemo(
    () => (data?.mp_matches ?? []).filter((m) => title === "all" || m.title_ === title),
    [data, title],
  );

  const view = useMemo(() => {
    if (!data) return null;
    const kills = sum(mp, (m) => m.kills);
    const deaths = sum(mp, (m) => m.deaths);
    const shots = sum(mp, (m) => m.shots);
    const hits = sum(mp, (m) => m.hits);
    const dd = sum(mp, (m) => m.damage_done);
    const dt = sum(mp, (m) => m.damage_taken);
    const half = Math.floor(mp.length / 2);
    const kd = (g: MpMatch[]) => sum(g, (m) => m.kills) / Math.max(1, sum(g, (m) => m.deaths));
    const acc = (g: MpMatch[]) => (100 * sum(g, (m) => m.hits)) / Math.max(1, sum(g, (m) => m.shots));
    const trendOk = mp.length >= 6;

    const accVals = mp.map((m) => (m.shots ? (100 * (m.hits ?? 0)) / m.shots : null));
    const kdVals = mp.map((m) => (m.kills ?? 0) / Math.max(1, m.deaths ?? 0));
    const accRoll = rolling(accVals, 5);
    const kdRoll = rolling(kdVals, 5);
    const perMatch = mp.map((m, i) => ({
      i: i + 1,
      label: shortDate(m.utc_timestamp),
      when: longDate(m.utc_timestamp),
      map: m.map && m.map !== "NO DATA" ? m.map : "Unknown map",
      kills: m.kills ?? 0,
      deaths: m.deaths ?? 0,
      damageDone: m.damage_done ?? 0,
      damageTaken: m.damage_taken ?? 0,
      accuracy: accVals[i] == null ? null : +accVals[i]!.toFixed(1),
      accRoll: accRoll[i] == null ? null : +accRoll[i]!.toFixed(1),
      kd: +kdVals[i].toFixed(2),
      kdRoll: kdRoll[i] == null ? null : +kdRoll[i]!.toFixed(2),
    }));

    // DMZ
    const dmz = data.dmz_matches;
    const resolved = dmz.filter((r) => r.end_reason === "Player Exfiled" || r.end_reason === "Player Eliminated");
    const exfil = resolved.filter((r) => r.end_reason === "Player Exfiled").length;
    const byKey = (key: "starting_plate_carrier" | "starting_primary_weapon") => {
      const g = new Map<string, { runs: number; exfil: number }>();
      resolved.forEach((r) => {
        const k = r[key] || "Unknown";
        const v = g.get(k) ?? { runs: 0, exfil: 0 };
        v.runs += 1;
        if (r.end_reason === "Player Exfiled") v.exfil += 1;
        g.set(k, v);
      });
      return [...g.entries()]
        .map(([name, v]) => ({ name, runs: v.runs, exfil: v.exfil, rate: Math.round((100 * v.exfil) / v.runs) }))
        .sort((a, b) => b.runs - a.runs);
    };

    // Weapons (deadliest-weapon kills across MP + DMZ)
    const w = new Map<string, number>();
    const bad = new Set(["", "NO DATA", "Not Equipped"]);
    mp.forEach((m) => {
      if (m.deadliest_weapon_name && !bad.has(m.deadliest_weapon_name))
        w.set(m.deadliest_weapon_name, (w.get(m.deadliest_weapon_name) ?? 0) + (m.deadliest_weapon_kills ?? 0));
    });
    dmz.forEach((m) => {
      if (m.deadliest_weapon_name && !bad.has(m.deadliest_weapon_name))
        w.set(m.deadliest_weapon_name, (w.get(m.deadliest_weapon_name) ?? 0) + (m.deadliest_weapons_combatants_killed ?? 0));
    });
    const weapons = [...w.entries()]
      .map(([name, kills]) => ({ name, kills }))
      .filter((x) => x.kills > 0)
      .sort((a, b) => b.kills - a.kills)
      .slice(0, 8);

    // Campaign
    const lv = new Map<string, { deaths: number; fails: number; checkpoints: number; seconds: number; last: string }>();
    data.campaign.forEach((c) => {
      const k = c.level_name || "Unknown";
      const v = lv.get(k) ?? { deaths: 0, fails: 0, checkpoints: 0, seconds: 0, last: c.utc_timestamp };
      v.deaths += c.deaths ?? 0;
      v.fails += c.fails ?? 0;
      v.checkpoints += 1;
      v.seconds += c.checkpoint_duration ?? 0;
      if (c.utc_timestamp > v.last) v.last = c.utc_timestamp;
      lv.set(k, v);
    });
    const levels = [...lv.entries()].map(([name, v]) => ({ name, ...v, minutes: Math.round(v.seconds / 60) })).sort((a, b) => b.deaths - a.deaths);

    const stamps = [
      ...data.sessions.map((s) => s.utc_timestamp),
      ...data.mp_matches.map((m) => m.utc_timestamp),
      ...data.dmz_matches.map((m) => m.utc_timestamp),
    ].filter(Boolean);

    return {
      kills, deaths, kd: deaths ? kills / deaths : null, acc: shots ? (100 * hits) / shots : null,
      dmgRatio: dt ? dd / dt : null, avgDmg: mp.length ? dd / mp.length : null,
      kdTrend: trendOk ? { old: kd(mp.slice(0, half)), new: kd(mp.slice(half)) } : null,
      accTrend: trendOk ? { old: acc(mp.slice(0, half)), new: acc(mp.slice(half)) } : null,
      perMatch, dmz, exfil, resolved: resolved.length,
      byArmor: byKey("starting_plate_carrier"), byWeapon: byKey("starting_primary_weapon"),
      weapons, levels, stamps,
    };
  }, [data, mp]);

  const hasAny = data && (data.mp_matches.length || data.dmz_matches.length || data.campaign.length);

  return (
    <div>
      <UploadBar config={config} onUploaded={onUploaded} />

      {error && (
        <div className="error" style={{ marginTop: 16 }}>
          Could not load dashboard from <code>{config.catalog}.{config.schema}</code>: {error}
        </div>
      )}

      {!data && !error && (
        <div className="grid kpis" style={{ marginTop: 20 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      )}

      {data && !hasAny && (
        <div className="empty">
          <h2>No match history yet</h2>
          <p>
            Request your data from Activision's privacy portal, then upload the HTML file above. Each new export
            extends your history.
          </p>
        </div>
      )}

      {data && hasAny && view && (
        <>
          {titles.length > 0 && (
            <div className="filters">
              <span className="hint">Multiplayer title:</span>
              <div className="seg" role="group" aria-label="Title filter">
                <button aria-pressed={title === "all"} onClick={() => setTitle("all")}>
                  All
                </button>
                {titles.map((t) => (
                  <button key={t} aria-pressed={title === t} onClick={() => setTitle(t)}>
                    {shortTitle(t)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid kpis" style={{ marginTop: 16 }}>
            <Kpi label="Matches tracked" value={String(mp.length + view.dmz.length)} note={`${mp.length} MP/BR · ${view.dmz.length} DMZ`} />
            <Kpi
              label="K/D ratio"
              value={fmt(view.kd)}
              note={view.kdTrend ? `${fmt(view.kdTrend.old)} → ${fmt(view.kdTrend.new)} (older vs newer half)` : `${view.kills} kills / ${view.deaths} deaths`}
              tone={view.kdTrend ? (view.kdTrend.new >= view.kdTrend.old ? "up" : "down") : undefined}
            />
            <Kpi
              label="Accuracy"
              value={pct(view.acc)}
              note={view.accTrend ? `${pct(view.accTrend.old)} → ${pct(view.accTrend.new)}` : undefined}
              tone={view.accTrend ? (view.accTrend.new >= view.accTrend.old ? "up" : "down") : undefined}
            />
            <Kpi label="Damage done ÷ taken" value={fmt(view.dmgRatio)} note={`${fmt(view.avgDmg, 0)} avg damage / match`} />
            <Kpi
              label="DMZ extraction rate"
              value={view.resolved ? pct((100 * view.exfil) / view.resolved, 0) : "—"}
              note={`${view.exfil} of ${view.resolved} runs exfiled`}
            />
            <Kpi label="Uploads" value={String(data.uploads.length)} note={`${data.inventory.distinct_items} distinct items owned`} />
          </div>

          {view.perMatch.length > 0 && (
            <>
              <div className="section-title">Multiplayer & Battle Royale</div>
              <div className="grid two">
                <ChartCard title="Kills and deaths per match" sub="Oldest → newest">
                  <BarChart data={view.perMatch} barGap={2} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" {...axisProps} minTickGap={20} />
                    <YAxis {...axisProps} allowDecimals={false} />
                    <Tooltip {...tooltipProps} labelFormatter={(_, p) => (p?.[0] ? `${p[0].payload.when} · ${p[0].payload.map}` : "")} />
                    <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} iconType="circle" iconSize={8} />
                    <Bar isAnimationActive={false} dataKey="kills" name="Kills" fill={C.s1} radius={[4, 4, 0, 0]} maxBarSize={14} />
                    <Bar isAnimationActive={false} dataKey="deaths" name="Deaths" fill={C.s2} radius={[4, 4, 0, 0]} maxBarSize={14} />
                  </BarChart>
                </ChartCard>

                <ChartCard title="Accuracy trend" sub="Hits ÷ shots per match, with 5-match rolling average">
                  <LineChart data={view.perMatch} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" {...axisProps} minTickGap={20} />
                    <YAxis {...axisProps} unit="%" />
                    <Tooltip {...tooltipProps} formatter={(v: number) => `${v}%`} labelFormatter={(_, p) => (p?.[0] ? `${p[0].payload.when} · ${p[0].payload.map}` : "")} />
                    <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} iconType="circle" iconSize={8} />
                    <Line isAnimationActive={false} dataKey="accuracy" name="Match accuracy" stroke={C.axis} strokeWidth={0} dot={{ r: 4, fill: "#6da7ec", stroke: C.surface, strokeWidth: 2 }} />
                    <Line isAnimationActive={false} dataKey="accRoll" name="5-match average" stroke={C.s1} strokeWidth={2} dot={false} connectNulls />
                  </LineChart>
                </ChartCard>

                <ChartCard title="Damage done vs taken" sub="Out-damaging opponents but dying more means fights aren't being finished">
                  <LineChart data={view.perMatch} margin={{ top: 4, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" {...axisProps} minTickGap={20} />
                    <YAxis {...axisProps} />
                    <Tooltip {...tooltipProps} labelFormatter={(_, p) => (p?.[0] ? `${p[0].payload.when} · ${p[0].payload.map}` : "")} />
                    <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} iconType="circle" iconSize={8} />
                    <Line isAnimationActive={false} dataKey="damageDone" name="Damage done" stroke={C.s1} strokeWidth={2} dot={{ r: 3, fill: C.s1, stroke: C.surface, strokeWidth: 2 }} />
                    <Line isAnimationActive={false} dataKey="damageTaken" name="Damage taken" stroke={C.s2} strokeWidth={2} dot={{ r: 3, fill: C.s2, stroke: C.surface, strokeWidth: 2 }} />
                  </LineChart>
                </ChartCard>

                <ChartCard title="K/D trend" sub="Per match and 5-match rolling average">
                  <LineChart data={view.perMatch} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="label" {...axisProps} minTickGap={20} />
                    <YAxis {...axisProps} />
                    <Tooltip {...tooltipProps} labelFormatter={(_, p) => (p?.[0] ? `${p[0].payload.when} · ${p[0].payload.map}` : "")} />
                    <Legend wrapperStyle={{ fontSize: 12, color: C.muted }} iconType="circle" iconSize={8} />
                    <Line isAnimationActive={false} dataKey="kd" name="Match K/D" stroke={C.axis} strokeWidth={0} dot={{ r: 4, fill: "#6da7ec", stroke: C.surface, strokeWidth: 2 }} />
                    <Line isAnimationActive={false} dataKey="kdRoll" name="5-match average" stroke={C.s3} strokeWidth={2} dot={false} connectNulls />
                  </LineChart>
                </ChartCard>
              </div>
            </>
          )}

          {(view.dmz.length > 0 || view.weapons.length > 0) && (
            <>
              <div className="section-title">DMZ & Loadouts</div>
              <div className="grid two">
                {view.byArmor.length > 0 && (
                  <ChartCard title="DMZ extraction rate by starting armor" sub="Share of runs ending in exfil · hover for run counts" height={Math.max(140, view.byArmor.length * 44)}>
                    <BarChart data={view.byArmor} layout="vertical" margin={{ top: 0, right: 56, left: 8, bottom: 0 }}>
                      <CartesianGrid stroke={C.grid} horizontal={false} />
                      <XAxis type="number" domain={[0, 100]} unit="%" {...axisProps} />
                      <YAxis type="category" dataKey="name" width={130} {...axisProps} />
                      <Tooltip {...tooltipProps} formatter={(v: number, _n, p) => [`${v}% (${p.payload.exfil}/${p.payload.runs} runs)`, "Extraction rate"]} />
                      <Bar isAnimationActive={false} dataKey="rate" fill={C.s3} radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: "right", fill: C.muted, fontSize: 11, formatter: (v: number) => `${v}%` }} />
                    </BarChart>
                  </ChartCard>
                )}
                {view.weapons.length > 0 && (
                  <ChartCard title="Deadliest weapons" sub="Kills credited to your deadliest weapon each match (MP + DMZ)" height={Math.max(160, view.weapons.length * 34)}>
                    <BarChart data={view.weapons} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }}>
                      <CartesianGrid stroke={C.grid} horizontal={false} />
                      <XAxis type="number" {...axisProps} allowDecimals={false} />
                      <YAxis type="category" dataKey="name" width={150} {...axisProps} />
                      <Tooltip {...tooltipProps} />
                      <Bar isAnimationActive={false} dataKey="kills" name="Kills" fill={C.s1} radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: "right", fill: C.muted, fontSize: 11 }} />
                    </BarChart>
                  </ChartCard>
                )}
              </div>

              {view.dmz.length > 0 && (
                <div className="card" style={{ marginTop: 16 }}>
                  <h3>DMZ runs</h3>
                  <p className="sub">Most recent first</p>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>When</th><th>Map</th><th>Primary</th><th>Armor</th>
                          <th className="num">Mins</th><th className="num">Kills</th><th className="num">Downed</th><th className="num">Loot</th><th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...view.dmz].reverse().map((r, i) => (
                          <tr key={i}>
                            <td>{longDate(r.utc_timestamp)}</td>
                            <td>{r.ending_map}</td>
                            <td>{r.starting_primary_weapon}</td>
                            <td>{r.starting_plate_carrier}</td>
                            <td className="num">{fmt((r.match_duration_in_seconds ?? 0) / 60, 0)}</td>
                            <td className="num">{r.combatants_killed ?? "—"}</td>
                            <td className="num">{r.times_downed_by_enemy_combatants != null && r.times_downed_by_enemy_combatants >= 0 ? r.times_downed_by_enemy_combatants : "—"}</td>
                            <td className="num">{r.loot_containers_opened ?? "—"}</td>
                            <td>
                              {r.end_reason === "Player Exfiled" ? (
                                <span className="pill good">✓ Exfiled</span>
                              ) : r.end_reason === "Player Eliminated" ? (
                                <span className="pill bad">✕ Eliminated</span>
                              ) : (
                                <span className="pill">{r.end_reason}</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          <div className="section-title">Habits & Campaign</div>
          <div className="grid two">
            <Heatmap stamps={view.stamps} />
            {view.levels.length > 0 ? (
              <ChartCard title="Campaign deaths by level" sub="Where you get stuck" height={Math.max(160, view.levels.length * 34)}>
                <BarChart data={view.levels} layout="vertical" margin={{ top: 0, right: 40, left: 8, bottom: 0 }}>
                  <CartesianGrid stroke={C.grid} horizontal={false} />
                  <XAxis type="number" {...axisProps} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" width={130} {...axisProps} />
                  <Tooltip {...tooltipProps} formatter={(v: number, n, p) => (n === "Deaths" ? [`${v} (${p.payload.fails} fails, ${p.payload.minutes} min)`, n] : [v, n])} />
                  <Bar isAnimationActive={false} dataKey="deaths" name="Deaths" fill={C.s2} radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: "right", fill: C.muted, fontSize: 11 }} />
                </BarChart>
              </ChartCard>
            ) : (
              <div className="card"><h3>Campaign</h3><p className="sub">No campaign checkpoints in your uploads yet.</p></div>
            )}
          </div>

          <div className="section-title">Upload history</div>
          <div className="card">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Uploaded (UTC)</th><th>File</th><th>Report ID</th><th>By</th>
                    <th className="num">New MP</th><th className="num">New DMZ</th><th className="num">New checkpoints</th><th className="num">New sessions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.uploads.map((u) => (
                    <tr key={u.upload_id}>
                      <td>{u.uploaded_at?.slice(0, 19)}</td>
                      <td>{u.file_name}</td>
                      <td>{u.report_id}</td>
                      <td>{u.uploaded_by}</td>
                      <td className="num">{u.new_rows.sar_mp_matches ?? 0}</td>
                      <td className="num">{u.new_rows.sar_dmz_matches ?? 0}</td>
                      <td className="num">{u.new_rows.sar_campaign_checkpoints ?? 0}</td>
                      <td className="num">{u.new_rows.sar_sessions ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
