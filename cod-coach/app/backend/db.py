"""SQL warehouse access via the Databricks SDK Statement Execution API."""
from __future__ import annotations

import os
import re
import time
from typing import Any

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import Disposition, Format, StatementState

_IDENT_RE = re.compile(r"^[A-Za-z0-9_\-]{1,255}$")


class SqlError(RuntimeError):
    pass


def ident(name: str) -> str:
    """Backtick-quote a catalog/schema/table/column identifier after validation."""
    if not name or not _IDENT_RE.match(name):
        raise ValueError(f"Invalid identifier: {name!r}")
    return f"`{name}`"


def fq(catalog: str, schema: str, table: str) -> str:
    return f"{ident(catalog)}.{ident(schema)}.{ident(table)}"


def lit(v: Any) -> str:
    """SQL literal for a Python value (strings are escaped for Databricks SQL)."""
    if v is None:
        return "NULL"
    s = str(v).replace("\\", "\\\\").replace("'", "\\'")
    return f"'{s}'"


class Sql:
    def __init__(self, client: WorkspaceClient, warehouse_id: str | None = None):
        self.w = client
        self.warehouse_id = warehouse_id or os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
        if not self.warehouse_id:
            raise SqlError("DATABRICKS_WAREHOUSE_ID is not configured for this app.")

    def run(self, statement: str, timeout_s: int = 300) -> list[dict]:
        resp = self.w.statement_execution.execute_statement(
            statement=statement,
            warehouse_id=self.warehouse_id,
            wait_timeout="50s",
            disposition=Disposition.INLINE,
            format=Format.JSON_ARRAY,
        )
        deadline = time.time() + timeout_s
        while resp.status and resp.status.state in (StatementState.PENDING, StatementState.RUNNING):
            if time.time() > deadline:
                self.w.statement_execution.cancel_execution(resp.statement_id)
                raise SqlError("Query timed out")
            time.sleep(1)
            resp = self.w.statement_execution.get_statement(resp.statement_id)

        state = resp.status.state if resp.status else None
        if state != StatementState.SUCCEEDED:
            msg = resp.status.error.message if resp.status and resp.status.error else str(state)
            raise SqlError(msg)

        if not resp.manifest or not resp.manifest.schema or not resp.manifest.schema.columns:
            return []
        cols = [c.name for c in resp.manifest.schema.columns]
        rows: list[list] = []
        result = resp.result
        while result is not None:
            rows.extend(result.data_array or [])
            if result.next_chunk_index is None:
                break
            result = self.w.statement_execution.get_statement_result_chunk_n(
                resp.statement_id, result.next_chunk_index)
        return [dict(zip(cols, r)) for r in rows]
