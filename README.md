# Call of Duty Analysis & Coach

A Databricks App that turns your Activision **SAR (Subject Access Request)** data export into a
personal Call of Duty performance dashboard and an LLM-powered coach.


## Features

- **Upload** the `*-ACTIVISION_ACCOUNT.html` file from Activision's privacy portal.
- **Historical storage** in Unity Catalog Delta tables (`sar_*`). Upload new exports over time —
  matches are de-duplicated (Match ID or a content hash, independent of report ID) and identical
  files are rejected. New columns in future exports are added automatically.
- **First-run configuration** dialog to choose the catalog and an existing schema, or create a new one.
- **Dashboard:** K/D, accuracy and damage trends, DMZ extraction rate by armor, deadliest weapons,
  play-time heatmap, campaign trouble spots, upload history.
- **LLM Coach:** chat grounded in a summary of all stored history (Databricks Foundation Model API).
- **Privacy:** email, name, DOB, ZIP, phone, address and IP-geolocated city are never persisted.

## Layout

```
cod-coach/
  app/                 # deployed to Databricks Apps
    main.py            # FastAPI server (API + static frontend)
    backend/
      sar_parser.py    # stdlib HTML parser for the SAR export
      store.py         # Unity Catalog DDL, MERGE-based ingest, dashboard reads
      db.py            # SQL Statement Execution API wrapper
      coach.py         # stats summary + LLM chat
    static/            # prebuilt React frontend (output of `npm run build`)
    app.yaml
  frontend/            # React + Vite + Recharts source
  databricks.yml       # bundle: app, SQL warehouse + serving endpoint resources
scripts/parse_sar.py   # standalone exploration script
```

## Deploy

```bash
cd cod-coach/frontend && npm install && npm run build
cd .. && databricks apps deploy --profile <PROFILE> \
  --var warehouse_id=<WAREHOUSE_ID> --var serving_endpoint=<CHAT_ENDPOINT>
```

The app queries Unity Catalog **on behalf of the signed-in user** (`sql` user API scope), so users
need `USE CATALOG` / `CREATE SCHEMA` (or privileges on an existing schema). Set `AUTH_MODE=sp` in
`app.yaml` to use the app service principal instead.

## Local development

```bash
uv venv .venv && uv pip install -p .venv -r cod-coach/app/requirements.txt
cd cod-coach/app && DATABRICKS_CONFIG_PROFILE=<PROFILE> DATABRICKS_WAREHOUSE_ID=<ID> \
  SERVING_ENDPOINT=<CHAT_ENDPOINT> ../../.venv/bin/python main.py   # http://localhost:8000
```
