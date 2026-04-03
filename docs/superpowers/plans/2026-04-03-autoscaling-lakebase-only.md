# Autoscaling-Only Lakebase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove provisioned/static Lakebase support from `databricks-builder-app` and make deployment/runtime consistently target Lakebase autoscaling.

**Architecture:** The app runtime will accept only Databricks Apps PostgreSQL resource injection (`PG*` environment variables). Deployment-time migration and grant helpers will derive temporary connection settings from `LAKEBASE_ENDPOINT` using `databricks postgres` commands and will fail fast if the autoscaling resource is missing or not configured.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic, pytest, bash, Databricks CLI, Databricks SDK for Python

---

### Task 1: Lock runtime config to autoscaling-only

**Files:**
- Modify: `databricks-builder-app/server/test_startup_and_db_errors.py`
- Modify: `databricks-builder-app/server/db/database.py`
- Modify: `databricks-builder-app/server/db/startup.py`
- Modify: `databricks-builder-app/alembic/env.py`

- [ ] **Step 1: Write failing tests**

```python
def test_is_postgres_configured_requires_pghost(monkeypatch):
    from server.db.database import is_postgres_configured

    monkeypatch.delenv("PGHOST", raising=False)
    monkeypatch.setenv("LAKEBASE_PG_URL", "postgresql://legacy")

    assert is_postgres_configured() is False


def test_get_database_url_rejects_legacy_static_url(monkeypatch):
    from server.db.database import get_database_url

    monkeypatch.delenv("PGHOST", raising=False)
    monkeypatch.setenv("LAKEBASE_PG_URL", "postgresql://legacy")

    assert get_database_url() is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./.venv/bin/pytest server/test_startup_and_db_errors.py -q`
Expected: FAIL because legacy config is still accepted.

- [ ] **Step 3: Write minimal implementation**

```python
def get_database_url() -> Optional[str]:
    pghost = os.environ.get("PGHOST")
    if not pghost:
        return None
    ...


def is_postgres_configured() -> bool:
    return bool(os.environ.get("PGHOST"))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./.venv/bin/pytest server/test_startup_and_db_errors.py -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add databricks-builder-app/server/test_startup_and_db_errors.py databricks-builder-app/server/db/database.py databricks-builder-app/server/db/startup.py databricks-builder-app/alembic/env.py
git commit -m "refactor: remove legacy lakebase runtime paths"
```

### Task 2: Make deploy/setup scripts autoscaling-only

**Files:**
- Modify: `databricks-builder-app/scripts/deploy.sh`
- Modify: `databricks-builder-app/scripts/setup.sh`

- [ ] **Step 1: Write the failing deployment assertions**

Add a targeted shell/Python-backed test path inside the script changes first by defining the expected behavior:

```bash
# expected checks
# - require LAKEBASE_ENDPOINT (env or app.yaml)
# - derive host/token/user from databricks postgres commands
# - fail if app has no database resource configured
```

- [ ] **Step 2: Run a focused validation command**

Run: `bash -n scripts/deploy.sh && bash -n scripts/setup.sh`
Expected: PASS for syntax before semantic changes.

- [ ] **Step 3: Write minimal implementation**

```bash
# parse LAKEBASE_ENDPOINT / LAKEBASE_DATABASE_NAME from app.yaml
# databricks postgres get-endpoint "$LAKEBASE_ENDPOINT"
# databricks postgres generate-database-credential "$LAKEBASE_ENDPOINT"
# databricks apps get "$APP_NAME" --output json | python check for database resources
```

- [ ] **Step 4: Re-run syntax and focused script validation**

Run: `bash -n scripts/deploy.sh && bash -n scripts/setup.sh`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add databricks-builder-app/scripts/deploy.sh databricks-builder-app/scripts/setup.sh
git commit -m "refactor: align deployment with autoscaling lakebase"
```

### Task 3: Update examples and docs

**Files:**
- Modify: `databricks-builder-app/.env.example`
- Modify: `databricks-builder-app/app.yaml.example`
- Modify: `databricks-builder-app/app.yaml`
- Modify: `databricks-builder-app/README.md`

- [ ] **Step 1: Write the failing expectation**

Search for removed legacy terms:

```bash
rg "LAKEBASE_INSTANCE_NAME|LAKEBASE_PG_URL|database-instance" databricks-builder-app
```

Expected: matches exist before the cleanup.

- [ ] **Step 2: Update docs/config**

```yaml
- name: LAKEBASE_ENDPOINT
  value: "projects/<project>/branches/production/endpoints/primary"
- name: LAKEBASE_DATABASE_NAME
  value: "databricks_postgres"
```

- [ ] **Step 3: Re-run the search**

Run: `rg "LAKEBASE_INSTANCE_NAME|LAKEBASE_PG_URL" databricks-builder-app`
Expected: no matches in active app/runtime/docs files that describe supported setup.

- [ ] **Step 4: Commit**

```bash
git add databricks-builder-app/.env.example databricks-builder-app/app.yaml.example databricks-builder-app/app.yaml databricks-builder-app/README.md
git commit -m "docs: document autoscaling-only lakebase setup"
```

### Task 4: Verify edited paths

**Files:**
- Test: `databricks-builder-app/server/test_startup_and_db_errors.py`
- Verify: `databricks-builder-app/scripts/deploy.sh`
- Verify: `databricks-builder-app/scripts/setup.sh`

- [ ] **Step 1: Run targeted backend tests**

Run: `./.venv/bin/pytest server/test_startup_and_db_errors.py server/test_fastmcp_compat.py -q`
Expected: PASS

- [ ] **Step 2: Run script syntax checks**

Run: `bash -n scripts/deploy.sh && bash -n scripts/setup.sh`
Expected: PASS

- [ ] **Step 3: Run lints for changed files**

Use the editor diagnostics for the touched backend files and fix anything newly introduced.

- [ ] **Step 4: Final status check**

Run: `git status --short`
Expected: only intended edits remain.
