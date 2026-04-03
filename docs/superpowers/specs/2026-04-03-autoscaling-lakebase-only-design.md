# Autoscaling-Only Lakebase Design

## Goal
Make `databricks-builder-app` support only Lakebase autoscaling and remove all provisioned-tier and static URL database configuration paths.

## Scope
- Remove support for `LAKEBASE_INSTANCE_NAME`.
- Remove support for `LAKEBASE_PG_URL`.
- Keep Lakebase runtime configuration autoscaling-only via injected `PG*` environment variables.
- Keep `LAKEBASE_ENDPOINT` as the canonical deployment-time identifier for the autoscaling Postgres resource.
- Ensure deployment config and deployment scripts provision or verify the autoscaling Postgres resource before app startup tasks that need the database.

## Architecture
The app runtime will treat injected `PGHOST`, `PGUSER`, `PGDATABASE`, `PGPORT`, and an OAuth-derived password as the only valid database connection mechanism. The deployment flow will use `LAKEBASE_ENDPOINT` to discover endpoint metadata and generate temporary credentials when it needs to run migrations, grants, or local deployment checks outside the deployed app runtime.

## Components

### Runtime database layer
`server/db/database.py` and `server/db/startup.py` will become autoscaling-only:
- database configured when `PGHOST` is present
- OAuth token refresh remains for autoscaling credentials
- error/help text refers only to autoscaling resource injection

### Deployment flow
`scripts/deploy.sh` will:
- accept `LAKEBASE_ENDPOINT` and `LAKEBASE_DATABASE_NAME`
- use `databricks postgres` commands instead of `databricks database`
- derive host, token, and identity from the autoscaling endpoint
- fail clearly if the autoscaling Postgres resource is not configured
- verify the resource before migrations or grants

### App configuration and docs
`app.yaml.example`, `.env.example`, and `README.md` will describe only the autoscaling setup:
- canonical env var: `LAKEBASE_ENDPOINT`
- optional logical DB name: `LAKEBASE_DATABASE_NAME`
- no provisioned instance examples
- no static URL examples

## Data Flow
1. Deployment config provides `LAKEBASE_ENDPOINT`.
2. Deployment script verifies the autoscaling endpoint exists and is reachable.
3. Deployed Databricks App receives injected `PG*` vars from the configured Lakebase resource.
4. Runtime generates OAuth credentials as needed and connects via SQLAlchemy/psycopg.

## Error Handling
- Missing `PGHOST` at runtime disables DB-backed features with autoscaling-specific guidance.
- Missing `LAKEBASE_ENDPOINT` during deployment fails early with a clear deployment error.
- Invalid or inaccessible endpoint during deployment fails before migrations.

## Testing
- Add or update tests for autoscaling-only configuration detection.
- Add or update tests that reject removed legacy config paths.
- Verify targeted backend tests and relevant app checks after edits.
