"""LLM Coach: summarize stored gameplay history and chat with a serving endpoint."""
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import ChatMessage, ChatMessageRole


def _sum(rows, k):
    return sum(r.get(k) or 0 for r in rows)


def _ratio(a, b, nd=2):
    return round(a / b, nd) if b else None


def _mp_block(rows: list[dict]) -> dict:
    kills, deaths = _sum(rows, "kills"), _sum(rows, "deaths")
    shots, hits = _sum(rows, "shots"), _sum(rows, "hits")
    dd, dt = _sum(rows, "damage_done"), _sum(rows, "damage_taken")
    half = len(rows) // 2
    trend = {}
    if len(rows) >= 6:
        for label, g in (("older_half", rows[:half]), ("newer_half", rows[half:])):
            trend[label] = {
                "kd": _ratio(_sum(g, "kills"), max(_sum(g, "deaths"), 1)),
                "accuracy_pct": _ratio(100 * _sum(g, "hits"), _sum(g, "shots"), 1),
                "avg_damage_done": _ratio(_sum(g, "damage_done"), len(g), 0),
            }
    weapons = Counter()
    for r in rows:
        if r.get("deadliest_weapon_name") not in (None, "", "NO DATA", "Not Equipped"):
            weapons[r["deadliest_weapon_name"]] += r.get("deadliest_weapon_kills") or 0
    return {
        "matches": len(rows),
        "first": rows[0]["utc_timestamp"] if rows else None,
        "last": rows[-1]["utc_timestamp"] if rows else None,
        "outcomes": dict(Counter(r.get("match_outcome") for r in rows)),
        "maps": dict(Counter(r.get("map") for r in rows).most_common(8)),
        "game_types": dict(Counter(r.get("game_type") for r in rows if r.get("game_type"))),
        "kills": kills, "deaths": deaths, "kd": _ratio(kills, deaths),
        "accuracy_pct": _ratio(100 * hits, shots, 1),
        "headshot_pct_of_kills": _ratio(100 * _sum(rows, "headshots"), kills, 1),
        "damage_done": dd, "damage_taken": dt, "damage_ratio": _ratio(dd, dt),
        "avg_kills_per_match": _ratio(kills, len(rows)),
        "best_streak": max((r.get("longest_streak") or 0 for r in rows), default=0),
        "trend": trend,
        "deadliest_weapons_kills": dict(weapons.most_common(6)),
        "last_10_matches": [
            {k: r.get(k) for k in ("utc_timestamp", "map", "game_type", "match_outcome", "kills", "deaths",
                                   "damage_done", "damage_taken", "weapon_accuracy", "skill",
                                   "deadliest_weapon_name")}
            for r in rows[-10:]
        ],
    }


def _dmz_block(rows: list[dict]) -> dict:
    def exfil(g):
        g = [r for r in g if r.get("end_reason") in ("Player Exfiled", "Player Eliminated")]
        return {"runs": len(g), "exfil_rate_pct": _ratio(100 * sum(r["end_reason"] == "Player Exfiled" for r in g), len(g), 0)}

    by = lambda key: {k: exfil(v) for k, v in _group(rows, key).items()}
    return {
        "runs": len(rows),
        "end_reasons": dict(Counter(r.get("end_reason") for r in rows)),
        "overall": exfil(rows),
        "by_starting_plate_carrier": by("starting_plate_carrier"),
        "by_starting_primary_weapon": by("starting_primary_weapon"),
        "avg_combatants_killed": _ratio(_sum(rows, "combatants_killed"), len(rows), 1),
        "operators_killed_total": _sum(rows, "operators_killed"),
        "avg_loot_containers": _ratio(_sum(rows, "loot_containers_opened"), len(rows), 1),
        "cash_extracted_total": _sum(rows, "cash_extracted"),
        "recent_runs": [
            {k: r.get(k) for k in ("utc_timestamp", "ending_map", "match_duration_in_seconds",
                                   "starting_primary_weapon", "starting_plate_carrier", "combatants_killed",
                                   "times_downed_by_enemy_combatants", "loot_containers_opened", "end_reason")}
            for r in rows[-10:]
        ],
    }


def _group(rows, key):
    g = defaultdict(list)
    for r in rows:
        g[r.get(key) or "unknown"].append(r)
    return g


def _campaign_block(rows: list[dict]) -> dict:
    levels = {}
    for lvl, g in _group(rows, "level_name").items():
        levels[lvl] = {"checkpoints": len(g), "deaths": _sum(g, "deaths"), "fails": _sum(g, "fails"),
                       "seconds": _sum(g, "checkpoint_duration")}
    return {"checkpoints": len(rows), "difficulty": dict(Counter(r.get("difficulty") for r in rows)),
            "levels": levels}


def build_summary(data: dict) -> dict:
    mp_by_title = _group(data.get("mp_matches", []), "title_")
    hours = Counter()
    for s in data.get("sessions", []):
        ts = s.get("utc_timestamp") or ""
        if len(ts) >= 13:
            hours[int(ts[11:13])] += 1
    return {
        "uploads": len(data.get("uploads", [])),
        "multiplayer_by_title": {t: _mp_block(rows) for t, rows in mp_by_title.items()},
        "dmz": _dmz_block(data.get("dmz_matches", [])) if data.get("dmz_matches") else None,
        "campaign": _campaign_block(data.get("campaign", [])) if data.get("campaign") else None,
        "sessions": {"count": len(data.get("sessions", [])),
                     "launches_by_utc_hour": dict(sorted(hours.items())),
                     "modes": dict(Counter(s.get("launch_game_mode") for s in data.get("sessions", [])))},
        "inventory": data.get("inventory"),
    }


SYSTEM_PROMPT = """You are "Coach", an expert Call of Duty performance coach (Warzone, DMZ, Multiplayer, Campaign).
You are given a JSON summary of ONE player's own match history, parsed from their Activision data export (SAR).

Rules:
- Ground every claim in the numbers provided; cite the specific stat (e.g. "your K/D on Rebirth Island is 0.58").
- Be honest about sample size: if a split has fewer than ~5 matches, call it a hypothesis, not a fact.
- Known data quirks: in Warzone every non-1st-place finish is recorded as "loss", so do not treat the win rate as meaningful;
  values of -1 or "NO DATA" mean missing; "skill" is an opaque internal rating.
- The data has NO positional, timeline, opponent, or loadout-attachment detail. Do not invent it; you may suggest
  what to watch for in their own gameplay recordings instead.
- Give concrete, actionable drills and habits (aim, positioning, plating, engagement choice, loadouts, session length).
- Use short sections and bullet points. Keep answers under ~350 words unless asked for more.
"""


def chat(client: WorkspaceClient, endpoint: str, summary: dict, messages: list[dict]) -> str:
    msgs = [ChatMessage(role=ChatMessageRole.SYSTEM,
                        content=SYSTEM_PROMPT + "\n\nPLAYER DATA SUMMARY (JSON):\n" + json.dumps(summary, default=str))]
    for m in messages[-20:]:
        role = ChatMessageRole.ASSISTANT if m.get("role") == "assistant" else ChatMessageRole.USER
        msgs.append(ChatMessage(role=role, content=str(m.get("content", ""))[:8000]))
    resp = client.serving_endpoints.query(name=endpoint, messages=msgs, max_tokens=1500)
    if resp.choices:
        msg = resp.choices[0].message
        content = msg.content if msg else ""
        if isinstance(content, list):  # some providers return content blocks
            content = "".join(c.get("text", "") for c in content if isinstance(c, dict))
        return content or ""
    return ""


def endpoint_name() -> str:
    return os.environ.get("SERVING_ENDPOINT", "")
