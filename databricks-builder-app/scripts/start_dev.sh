#!/bin/bash
# Development startup script
# Runs both backend and frontend in development mode

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(dirname "$PROJECT_DIR")"

cd "$PROJECT_DIR"

echo "Starting development servers..."

if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.env.local"
  set +a
fi

if [ -n "${LAKEBASE_ENDPOINT:-}" ] && [ -z "${PGHOST:-}" ]; then
  echo "Resolving Lakebase autoscaling endpoint for local development..."
  VENV_PYTHON="$PROJECT_DIR/.venv/bin/python3"
  [ ! -x "$VENV_PYTHON" ] && VENV_PYTHON="python3"
  eval "$($VENV_PYTHON - <<'PY'
import os
import shlex

from databricks.sdk import WorkspaceClient

endpoint_name = os.environ.get("LAKEBASE_ENDPOINT")
database_name = os.environ.get("LAKEBASE_DATABASE_NAME", "databricks_postgres")

if not endpoint_name:
    raise SystemExit(0)

w = WorkspaceClient()
endpoint = w.postgres.get_endpoint(name=endpoint_name)
cred = w.postgres.generate_database_credential(endpoint=endpoint_name)
me = w.current_user.me()

host = ""
if endpoint.status and endpoint.status.hosts:
    host = endpoint.status.hosts.host or ""
if not host:
    raise SystemExit(f"Lakebase endpoint {endpoint_name} does not have a host yet")

exports = {
    "PGHOST": host,
    "PGPORT": "5432",
    "PGDATABASE": database_name,
    "PGUSER": me.user_name or "",
    "PGPASSWORD": cred.token or "",
    "PGSSLMODE": "require",
}

for key, value in exports.items():
    print(f"export {key}={shlex.quote(value)}")
PY
)"
fi

# Kill any existing processes on the ports
echo "Checking for existing processes..."
lsof -ti:8000 | xargs kill -9 2>/dev/null || true
lsof -ti:3000 | xargs kill -9 2>/dev/null || true
sleep 1

# Install sibling packages (databricks-tools-core and databricks-mcp-server)
echo "Installing Databricks MCP packages..."
uv pip install -e "$REPO_ROOT/databricks-tools-core" -e "$REPO_ROOT/databricks-mcp-server" --quiet 2>/dev/null || {
  echo "Installing with pip..."
  pip install -e "$REPO_ROOT/databricks-tools-core" -e "$REPO_ROOT/databricks-mcp-server" --quiet
}

# Function to kill background processes on exit
cleanup() {
    echo ""
    echo "Shutting down servers..."
    kill $(jobs -p) 2>/dev/null || true
    exit 0
}
trap cleanup SIGINT SIGTERM

# Start backend
echo "Starting backend on http://localhost:8000..."
uv run uvicorn server.app:app --reload --port 8000 --reload-dir server &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 2

# Start frontend
echo "Starting frontend on http://localhost:3000..."
cd client

# Check if node_modules exists, install if not
if [ ! -d "node_modules" ]; then
  echo "Installing frontend dependencies..."
  npm install
fi

npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "Development servers running:"
echo "  Backend:  http://localhost:8000"
echo "  Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

# Wait for processes
wait
