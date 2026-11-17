"""COD Coach — Databricks App (FastAPI backend + prebuilt React frontend)."""
from __future__ import annotations

import logging
import os
from pathlib import Path

from databricks.sdk import WorkspaceClient
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import coach, store
from backend.db import Sql, SqlError
from backend.sar_parser import parse_sar

log = logging.getLogger("cod-coach")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="COD Coach")
STATIC = Path(__file__).parent / "static"
MAX_UPLOAD = 25 * 1024 * 1024

_sp_client: WorkspaceClient | None = None


def sp_client() -> WorkspaceClient:
    """App service principal (or local CLI profile when running locally)."""
    global _sp_client
    if _sp_client is None:
        _sp_client = WorkspaceClient()
    return _sp_client


def user_client(request: Request) -> WorkspaceClient:
    """On-behalf-of-user client when the Apps proxy forwards a user token.

    Data access (catalogs, schemas, tables) uses the signed-in user's own Unity
    Catalog permissions. Set AUTH_MODE=sp to use the app service principal instead.
    """
    token = request.headers.get("x-forwarded-access-token")
    if token and os.environ.get("AUTH_MODE", "obo").lower() != "sp":
        return WorkspaceClient(host=sp_client().config.host, token=token, auth_type="pat")
    return sp_client()


def sql_for(request: Request) -> Sql:
    return Sql(user_client(request))


def user_name(request: Request) -> str:
    return (request.headers.get("x-forwarded-email")
            or request.headers.get("x-forwarded-preferred-username")
            or "local-user")


@app.exception_handler(SqlError)
async def sql_error_handler(_: Request, exc: SqlError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(ValueError)
async def value_error_handler(_: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


# ---------------------------------------------------------------- API

@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return {
        "user": user_name(request),
        "llm_endpoint": coach.endpoint_name(),
        "default_catalog": os.environ.get("DEFAULT_CATALOG", ""),
        "default_schema": os.environ.get("DEFAULT_SCHEMA", "cod_coach"),
    }


@app.get("/api/catalogs")
def catalogs(request: Request):
    return {"catalogs": store.list_catalogs(sql_for(request))}


@app.get("/api/schemas")
def schemas(request: Request, catalog: str):
    return {"schemas": store.list_schemas(sql_for(request), catalog)}


class ConfigIn(BaseModel):
    catalog: str
    schema_name: str
    create: bool = False


@app.post("/api/config")
def configure(request: Request, cfg: ConfigIn):
    return store.ensure_schema(sql_for(request), cfg.catalog, cfg.schema_name, cfg.create)


@app.post("/api/upload")
async def upload(request: Request, catalog: str = Form(...), schema_name: str = Form(...),
                 file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "File is larger than 25 MB.")
    try:
        html = data.decode("utf-8")
    except UnicodeDecodeError:
        html = data.decode("latin-1")
    report = parse_sar(html)
    result = store.ingest(sql_for(request), catalog, schema_name, report,
                          file_name=file.filename or "upload.html", file_bytes=data,
                          uploaded_by=user_name(request))
    log.info("upload %s -> %s", file.filename, result.get("status"))
    return result


@app.get("/api/dashboard")
def dashboard(request: Request, catalog: str, schema_name: str):
    return store.dashboard_data(sql_for(request), catalog, schema_name)


class ChatIn(BaseModel):
    catalog: str
    schema_name: str
    messages: list[dict]


@app.post("/api/coach")
def coach_chat(request: Request, body: ChatIn):
    endpoint = coach.endpoint_name()
    if not endpoint:
        raise HTTPException(500, "No LLM serving endpoint is configured (SERVING_ENDPOINT).")
    data = store.dashboard_data(sql_for(request), body.catalog, body.schema_name)
    summary = coach.build_summary(data)
    if not data["mp_matches"] and not data["dmz_matches"] and not data["campaign"]:
        return {"reply": "I don't see any match data yet. Upload your Activision SAR HTML file on the "
                         "Dashboard page and then ask me again.", "summary": summary}
    try:
        reply = coach.chat(sp_client(), endpoint, summary, body.messages)
    except Exception as exc:  # surface serving errors to the UI
        log.exception("coach failed")
        raise HTTPException(502, f"LLM call failed: {exc}") from exc
    return {"reply": reply, "summary": summary}


# ---------------------------------------------------------------- frontend

if (STATIC / "assets").exists():
    app.mount("/assets", StaticFiles(directory=STATIC / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    index = STATIC / "index.html"
    if not index.exists():
        return JSONResponse({"detail": "Frontend not built. Run `npm run build` in frontend/."}, 404)
    return FileResponse(index)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DATABRICKS_APP_PORT", 8000)))
