"""Unity Catalog persistence for SAR uploads: schema setup, ingest, and reads."""
from __future__ import annotations

import hashlib
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from collections import OrderedDict

from .db import Sql, SqlError, fq, ident, lit
from .sar_parser import SarReport, SarTable

META_COLS = OrderedDict([
    ("_upload_id", "STRING"),
    ("_report_id", "STRING"),
    ("_title", "STRING"),
    ("_section", "STRING"),
    ("_record_key", "STRING"),
    ("_row_num", "INT"),
    ("_ingested_at", "TIMESTAMP"),
])
UPLOADS_TABLE = "sar_uploads"
CHUNK = 800


# ---------------------------------------------------------------- catalog/schema

def list_catalogs(sql: Sql) -> list[str]:
    rows = sql.run("SHOW CATALOGS")
    names = [r.get("catalog") or next(iter(r.values())) for r in rows]
    return sorted(n for n in names if n and n not in ("system", "samples", "__databricks_internal"))


def list_schemas(sql: Sql, catalog: str) -> list[str]:
    rows = sql.run(f"SHOW SCHEMAS IN {ident(catalog)}")
    names = [r.get("databaseName") or r.get("namespace") or next(iter(r.values())) for r in rows]
    return sorted(n for n in names if n and n != "information_schema")


def ensure_schema(sql: Sql, catalog: str, schema: str, create: bool) -> dict:
    existing = list_schemas(sql, catalog)
    created = False
    if schema not in existing:
        if not create:
            raise SqlError(f"Schema {catalog}.{schema} does not exist.")
        sql.run(f"CREATE SCHEMA IF NOT EXISTS {ident(catalog)}.{ident(schema)} "
                f"COMMENT 'Call of Duty SAR coach data'")
        created = True
    sql.run(f"""CREATE TABLE IF NOT EXISTS {fq(catalog, schema, UPLOADS_TABLE)} (
        upload_id STRING, uploaded_at TIMESTAMP, uploaded_by STRING, file_name STRING,
        file_sha256 STRING, file_bytes BIGINT, report_id STRING, account_type STRING,
        account_username STRING, tables_json STRING, new_rows_json STRING)
        COMMENT 'One row per Activision SAR HTML file uploaded through the app'""")
    return {"catalog": catalog, "schema": schema, "created": created}


def table_columns(sql: Sql, catalog: str, schema: str, table: str) -> list[str]:
    try:
        rows = sql.run(f"SHOW COLUMNS IN {fq(catalog, schema, table)}")
    except SqlError:
        return []
    return [r.get("col_name") or next(iter(r.values())) for r in rows]


def existing_tables(sql: Sql, catalog: str, schema: str) -> set[str]:
    rows = sql.run(f"SHOW TABLES IN {ident(catalog)}.{ident(schema)}")
    return {r.get("tableName") for r in rows if r.get("tableName")}


# ---------------------------------------------------------------- ingest

def _ensure_table(sql: Sql, catalog: str, schema: str, table: str, cols: list[str]) -> None:
    target = fq(catalog, schema, table)
    have = table_columns(sql, catalog, schema, table)
    if not have:
        defs = [f"{ident(c)} {t}" for c, t in META_COLS.items()] + [f"{ident(c)} STRING" for c in cols]
        sql.run(f"CREATE TABLE IF NOT EXISTS {target} ({', '.join(defs)}) "
                f"TBLPROPERTIES ('delta.columnMapping.mode' = 'name')")
        return
    missing = [c for c in cols if c not in have]
    if missing:  # schema evolution: newer exports may add columns
        sql.run(f"ALTER TABLE {target} ADD COLUMNS ({', '.join(f'{ident(c)} STRING' for c in missing)})")


def _value_rows(group: list[SarTable], cols: list[str], upload_id: str, report_id: str):
    seen: set[str] = set()
    for t in group:
        idx = {c: i for i, c in enumerate(t.columns)}
        for n, (row, key) in enumerate(zip(t.rows, t.record_keys)):
            if not t.snapshot:
                if key in seen:
                    continue
                seen.add(key)
            vals = [lit(upload_id), lit(report_id), lit(t.title), lit(t.section), lit(key), str(n),
                    "current_timestamp()"]
            vals += [lit(row[idx[c]]) if c in idx else "NULL" for c in cols]
            yield "(" + ", ".join(vals) + ")"


def ingest(sql: Sql, catalog: str, schema: str, report: SarReport, *, file_name: str,
           file_bytes: bytes, uploaded_by: str) -> dict:
    ensure_schema(sql, catalog, schema, create=False)
    sha = hashlib.sha256(file_bytes).hexdigest()
    uploads = fq(catalog, schema, UPLOADS_TABLE)
    dup = sql.run(f"SELECT upload_id, uploaded_at FROM {uploads} WHERE file_sha256 = {lit(sha)} LIMIT 1")
    if dup:
        return {"status": "duplicate", "upload_id": dup[0]["upload_id"],
                "message": f"This exact file was already uploaded at {dup[0]['uploaded_at']} UTC. No new data added."}

    upload_id = str(uuid.uuid4())
    groups: "OrderedDict[str, list[SarTable]]" = OrderedDict()
    for t in report.tables:
        groups.setdefault(t.table_name, []).append(t)

    def write(table: str, group: list[SarTable]) -> tuple[str, int, int]:
        cols: list[str] = []
        for t in group:
            cols += [c for c in t.columns if c not in cols]
        _ensure_table(sql, catalog, schema, table, cols)
        target = fq(catalog, schema, table)
        all_cols = list(META_COLS) + cols
        col_list = ", ".join(ident(c) for c in all_cols)
        values = list(_value_rows(group, cols, upload_id, report.report_id))
        inserted = 0
        snapshot = group[0].snapshot
        for i in range(0, len(values), CHUNK):
            chunk = ",\n".join(values[i:i + CHUNK])
            if snapshot:
                sql.run(f"INSERT INTO {target} ({col_list}) VALUES {chunk}")
                inserted += min(CHUNK, len(values) - i)
            else:
                res = sql.run(
                    f"MERGE INTO {target} t USING (SELECT * FROM VALUES {chunk} AS s({col_list})) s "
                    f"ON t.`_record_key` = s.`_record_key` "
                    f"WHEN NOT MATCHED THEN INSERT ({col_list}) VALUES ({', '.join('s.' + ident(c) for c in all_cols)})")
                if res and "num_inserted_rows" in res[0]:
                    inserted += int(res[0]["num_inserted_rows"] or 0)
        return table, sum(len(t.rows) for t in group), inserted

    # Tables are independent, so write them concurrently to keep uploads fast.
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda kv: write(*kv), groups.items()))
    table_rows = {t: n for t, n, _ in results}
    new_rows = {t: i for t, _, i in results}

    sql.run(f"""INSERT INTO {uploads} VALUES ({lit(upload_id)}, current_timestamp(), {lit(uploaded_by)},
        {lit(file_name)}, {lit(sha)}, {len(file_bytes)}, {lit(report.report_id)}, {lit(report.account_type)},
        {lit(report.username)}, {lit(json.dumps(table_rows))}, {lit(json.dumps(new_rows))})""")
    return {"status": "ok", "upload_id": upload_id, "report_id": report.report_id,
            "tables": table_rows, "new_rows": new_rows}


# ---------------------------------------------------------------- reads

MP_COLS = ["utc_timestamp", "game_type", "map", "match_outcome", "skill", "score", "shots", "hits",
           "assists", "longest_streak", "kills", "deaths", "headshots", "damage_done", "damage_taken",
           "deadliest_weapon_name", "deadliest_weapon_kills", "weapon_accuracy",
           "percentage_of_time_moving", "total_xp", "rank_at_end", "prestige_at_end"]
DMZ_COLS = ["utc_timestamp", "match_duration_in_seconds", "ending_map", "starting_primary_weapon",
            "starting_secondary_weapon", "starting_plate_carrier", "starting_squad_size",
            "deadliest_weapon_name", "deadliest_weapons_combatants_killed", "combatants_killed",
            "operators_killed", "agents_killed", "times_downed_by_enemy_combatants",
            "loot_containers_opened", "cash_extracted", "end_reason", "story_missions_completed",
            "side_ops_completed", "dynamic_ops_completed", "times_revived_from_down"]
CAMPAIGN_COLS = ["utc_timestamp", "difficulty", "level_name", "checkpoint_duration", "deaths", "fails"]
SESSION_COLS = ["utc_timestamp", "launch_game_mode", "launch_title", "device_type"]
PURCHASE_COLS = ["utc_timestamp", "title", "type", "product", "exchange_type", "currency", "cost"]

NUMERIC = {"skill", "score", "shots", "hits", "assists", "longest_streak", "kills", "deaths", "headshots",
           "damage_done", "damage_taken", "deadliest_weapon_kills", "weapon_accuracy",
           "percentage_of_time_moving", "total_xp", "rank_at_end", "prestige_at_end",
           "match_duration_in_seconds", "starting_squad_size", "deadliest_weapons_combatants_killed",
           "combatants_killed", "operators_killed", "agents_killed", "times_downed_by_enemy_combatants",
           "loot_containers_opened", "cash_extracted", "story_missions_completed", "side_ops_completed",
           "dynamic_ops_completed", "times_revived_from_down", "checkpoint_duration", "fails", "cost"}


def _num(v):
    if v is None or v == "":
        return None
    try:
        return float(str(v).rstrip("%").replace(",", ""))
    except ValueError:
        return None


def _select(sql: Sql, catalog: str, schema: str, table: str, wanted: list[str], tables: set[str],
            limit: int = 20000) -> list[dict]:
    if table not in tables:
        return []
    have = set(table_columns(sql, catalog, schema, table))
    parts = ["`_title` AS title_", "`_upload_id` AS upload_id_"]
    parts += [ident(c) if c in have else f"CAST(NULL AS STRING) AS {ident(c)}" for c in wanted]
    order = "utc_timestamp" if "utc_timestamp" in have else "_ingested_at"
    rows = sql.run(f"SELECT {', '.join(parts)} FROM {fq(catalog, schema, table)} "
                   f"ORDER BY {ident(order)} LIMIT {limit}")
    for r in rows:
        for k in list(r):
            if k in NUMERIC:
                r[k] = _num(r[k])
    return rows


def dashboard_data(sql: Sql, catalog: str, schema: str) -> dict:
    tables = existing_tables(sql, catalog, schema)

    def uploads():
        if UPLOADS_TABLE not in tables:
            return []
        rows = sql.run(
            f"SELECT upload_id, CAST(uploaded_at AS STRING) uploaded_at, uploaded_by, file_name, report_id, "
            f"account_username, new_rows_json FROM {fq(catalog, schema, UPLOADS_TABLE)} ORDER BY uploaded_at DESC")
        for u in rows:
            try:
                u["new_rows"] = json.loads(u.pop("new_rows_json") or "{}")
            except json.JSONDecodeError:
                u["new_rows"] = {}
        return rows

    def inventory():
        if "sar_inventory" not in tables:
            return {"items": 0, "distinct_items": 0}
        inv = fq(catalog, schema, "sar_inventory")
        r = sql.run(
            f"WITH latest AS (SELECT `_upload_id` u FROM {inv} ORDER BY `_ingested_at` DESC LIMIT 1) "
            f"SELECT count(*) items, count(DISTINCT item_name) distinct_items FROM {inv} "
            f"WHERE `_upload_id` = (SELECT u FROM latest) AND item_name NOT IN ('Unspecified', 'NO DATA')")
        return {k: int(v or 0) for k, v in r[0].items()} if r else {"items": 0, "distinct_items": 0}

    jobs = {
        "uploads": uploads,
        "inventory": inventory,
        "mp_matches": lambda: _select(sql, catalog, schema, "sar_mp_matches", MP_COLS, tables),
        "dmz_matches": lambda: _select(sql, catalog, schema, "sar_dmz_matches", DMZ_COLS, tables),
        "campaign": lambda: _select(sql, catalog, schema, "sar_campaign_checkpoints", CAMPAIGN_COLS, tables),
        "sessions": lambda: _select(sql, catalog, schema, "sar_sessions", SESSION_COLS, tables),
        "purchases": lambda: _select(sql, catalog, schema, "sar_purchases", PURCHASE_COLS, tables),
    }
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        futures = {k: pool.submit(f) for k, f in jobs.items()}
        out = {k: f.result() for k, f in futures.items()}
    return {"catalog": catalog, "schema": schema, **out}
