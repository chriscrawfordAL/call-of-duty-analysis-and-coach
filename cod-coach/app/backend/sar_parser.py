"""Parse an Activision SAR (Subject Access Request) HTML export into tables.

The export is a single HTML file made of <h1> (game title) / <h2> (section)
headings, each followed by a <table> whose first row is the header row.
Parsing uses only the stdlib HTMLParser (no script execution, no network).
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

# Section (h2) names whose tables are point-in-time snapshots rather than
# event logs. Snapshots are stored per upload; event rows are de-duplicated.
SNAPSHOT_SECTIONS = {
    "general",
    "marketplace inventory",
    "marketplace balances",
}
SNAPSHOT_PREFIXES = ("preferences",)

# Friendly table names for known sections; unknown sections get sar_<slug>.
TABLE_NAMES = {
    "general": "sar_account",
    "sessions data": "sar_sessions",
    "in game purchases data": "sar_purchases",
    "marketplace inventory": "sar_inventory",
    "marketplace balances": "sar_balances",
    "multiplayer match data": "sar_mp_matches",
    "dmz match data": "sar_dmz_matches",
    "campaign checkpoint data": "sar_campaign_checkpoints",
}

# Personal fields in the "General" account table that are never persisted.
PII_KEYS = {
    "email", "firstname", "lastname", "dateofbirth", "zip", "phone", "mobile",
    "address1", "address2", "city", "state", "parentemail",
}


def slug(text: str) -> str:
    s = re.sub(r"[^0-9a-zA-Z]+", "_", text.strip().lower()).strip("_")
    return s or "col"


def normalize_section(h2: str) -> str:
    return re.sub(r"\s*\(.*?\)\s*", " ", h2 or "").strip().lower()


@dataclass
class SarTable:
    title: str              # h1, e.g. "Call of Duty: Warzone 2.0"
    section: str            # h2, e.g. "Multiplayer Match Data (reverse chronological)"
    columns: list[str]      # snake_case column names
    rows: list[list[str]]
    table_name: str = ""
    snapshot: bool = False
    record_keys: list[str] = field(default_factory=list)


@dataclass
class SarReport:
    report_id: str
    account_type: str
    username: str
    tables: list[SarTable]


class _Parser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.h1 = ""
        self.h2 = ""
        self._heading: str | None = None
        self._buf = ""
        self.tables: list[dict] = []
        self._cur: dict | None = None
        self._row: list[str] | None = None
        self._cell: str | None = None

    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2"):
            self._heading, self._buf = tag, ""
        elif tag == "table":
            self._cur = {"h1": self.h1, "h2": self.h2, "rows": []}
            self.tables.append(self._cur)
        elif tag == "tr" and self._cur is not None:
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = ""
        elif tag == "br" and self._cell is not None:
            self._cell += " "

    def handle_endtag(self, tag):
        if tag == self._heading:
            text = " ".join(self._buf.split())
            if tag == "h1":
                self.h1, self.h2 = text, ""
            else:
                self.h2 = text
            self._heading = None
        elif tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join(self._cell.split()))
            self._cell = None
        elif tag == "tr" and self._row is not None and self._cur is not None:
            self._cur["rows"].append(self._row)
            self._row = None
        elif tag == "table":
            self._cur = None

    def handle_data(self, data):
        if self._heading:
            self._buf += data
        if self._cell is not None:
            self._cell += data


def _dedupe_columns(cols: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for c in cols:
        base = slug(c)
        if base.startswith("_"):
            base = "c" + base
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.append(base if n == 0 else f"{base}_{n + 1}")
    return out


def parse_sar(html: str) -> SarReport:
    if "Activision SAR Report" not in html:
        raise ValueError("This does not look like an Activision SAR report HTML file.")
    m = re.search(r"Report ID:\s*</b>\s*([^<\s]+)", html)
    report_id = m.group(1).strip() if m else "unknown"
    m = re.search(r"Account type:\s*</b>\s*([^<\s]+)", html)
    account_type = m.group(1).strip() if m else ""

    p = _Parser()
    p.feed(html)

    username = ""
    tables: list[SarTable] = []
    for t in p.tables:
        rows = [r for r in t["rows"] if any(c != "" for c in r)]
        if not rows:
            continue
        header, body = rows[0], rows[1:]
        cols = _dedupe_columns(header)
        width = len(cols)
        body = [(r + [""] * width)[:width] for r in body]
        sec = normalize_section(t["h2"])

        if sec == "general" and cols[:2] == ["key", "value"]:
            for r in body:
                if r[0] == "userName":
                    username = r[1]
            body = [r for r in body if r[0].lower() not in PII_KEYS]

        if sec == "sessions data" and "city" in cols:  # IP-geolocated city is personal data
            ci = cols.index("city")
            cols = cols[:ci] + cols[ci + 1:]
            body = [r[:ci] + r[ci + 1:] for r in body]

        snapshot = sec in SNAPSHOT_SECTIONS or sec.startswith(SNAPSHOT_PREFIXES)
        name = TABLE_NAMES.get(sec) or ("sar_" + slug(sec))
        st = SarTable(title=t["h1"], section=t["h2"], columns=cols, rows=body,
                      table_name=name, snapshot=snapshot)
        # Record keys must be stable across exports (each SAR has a new report id),
        # so prefer the natural Match ID and otherwise hash the row content.
        mid = cols.index("match_id") if "match_id" in cols else None
        for r in body:
            natural = [r[mid]] if mid is not None and r[mid] not in ("", "NO DATA") else r
            h = hashlib.sha256("\x1f".join([st.title, sec, *natural]).encode()).hexdigest()
            st.record_keys.append(h)
        tables.append(st)

    return SarReport(report_id=report_id, account_type=account_type,
                     username=username, tables=tables)
