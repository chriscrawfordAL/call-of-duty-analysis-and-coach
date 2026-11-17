export type AppConfig = { catalog: string; schema: string };

export type MpMatch = {
  title_: string;
  upload_id_: string;
  utc_timestamp: string;
  game_type: string | null;
  map: string | null;
  match_outcome: string | null;
  skill: number | null;
  score: number | null;
  shots: number | null;
  hits: number | null;
  assists: number | null;
  longest_streak: number | null;
  kills: number | null;
  deaths: number | null;
  headshots: number | null;
  damage_done: number | null;
  damage_taken: number | null;
  deadliest_weapon_name: string | null;
  deadliest_weapon_kills: number | null;
  weapon_accuracy: number | null;
  total_xp: number | null;
  rank_at_end: number | null;
};

export type DmzMatch = {
  title_: string;
  utc_timestamp: string;
  match_duration_in_seconds: number | null;
  ending_map: string | null;
  starting_primary_weapon: string | null;
  starting_plate_carrier: string | null;
  deadliest_weapon_name: string | null;
  deadliest_weapons_combatants_killed: number | null;
  combatants_killed: number | null;
  operators_killed: number | null;
  times_downed_by_enemy_combatants: number | null;
  loot_containers_opened: number | null;
  end_reason: string | null;
};

export type Checkpoint = {
  title_: string;
  utc_timestamp: string;
  difficulty: string | null;
  level_name: string | null;
  checkpoint_duration: number | null;
  deaths: number | null;
  fails: number | null;
};

export type Session = {
  utc_timestamp: string;
  launch_game_mode: string | null;
  launch_title: string | null;
};

export type Upload = {
  upload_id: string;
  uploaded_at: string;
  uploaded_by: string;
  file_name: string;
  report_id: string;
  account_username: string;
  new_rows: Record<string, number>;
};

export type DashboardData = {
  catalog: string;
  schema: string;
  uploads: Upload[];
  mp_matches: MpMatch[];
  dmz_matches: DmzMatch[];
  campaign: Checkpoint[];
  sessions: Session[];
  inventory: { items: number; distinct_items: number };
};

export type UploadResult = {
  status: "ok" | "duplicate";
  upload_id: string;
  message?: string;
  tables?: Record<string, number>;
  new_rows?: Record<string, number>;
};

export type Me = {
  user: string;
  llm_endpoint: string;
  default_catalog: string;
  default_schema: string;
};

export type ChatMsg = { role: "user" | "assistant"; content: string };

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "detail" in body) detail = String(body.detail);
    } catch {
      /* not JSON */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const qs = (p: Record<string, string>) => new URLSearchParams(p).toString();

export const api = {
  me: () => fetch("api/me").then((r) => handle<Me>(r)),
  catalogs: () => fetch("api/catalogs").then((r) => handle<{ catalogs: string[] }>(r)),
  schemas: (catalog: string) =>
    fetch(`api/schemas?${qs({ catalog })}`).then((r) => handle<{ schemas: string[] }>(r)),
  configure: (catalog: string, schema: string, create: boolean) =>
    fetch("api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog, schema_name: schema, create }),
    }).then((r) => handle<{ created: boolean }>(r)),
  upload: (cfg: AppConfig, file: File) => {
    const fd = new FormData();
    fd.append("catalog", cfg.catalog);
    fd.append("schema_name", cfg.schema);
    fd.append("file", file);
    return fetch("api/upload", { method: "POST", body: fd }).then((r) => handle<UploadResult>(r));
  },
  dashboard: (cfg: AppConfig) =>
    fetch(`api/dashboard?${qs({ catalog: cfg.catalog, schema_name: cfg.schema })}`).then((r) =>
      handle<DashboardData>(r),
    ),
  coach: (cfg: AppConfig, messages: ChatMsg[]) =>
    fetch("api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalog: cfg.catalog, schema_name: cfg.schema, messages }),
    }).then((r) => handle<{ reply: string }>(r)),
};

const KEY = "cod-coach-config-v1";
export function loadConfig(): AppConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && "catalog" in v && "schema" in v) {
      return { catalog: String(v.catalog), schema: String(v.schema) };
    }
  } catch {
    /* ignore */
  }
  return null;
}
export function saveConfig(c: AppConfig) {
  localStorage.setItem(KEY, JSON.stringify(c));
}

/** SAR timestamps are UTC "YYYY-MM-DD HH:MM:SS". */
export function utc(ts: string): Date {
  return new Date(ts.replace(" ", "T") + "Z");
}
