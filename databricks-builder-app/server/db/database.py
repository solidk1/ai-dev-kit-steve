"""Async database connection and session management.

Uses PostgreSQL via Lakebase autoscaling with async SQLAlchemy and psycopg3.

The runtime expects Databricks Apps to inject `PG*` environment variables from
the configured Lakebase database resource. OAuth tokens are generated from the
app service principal credentials when `PGPASSWORD` is not already present.

Note: Uses psycopg3 (postgresql+psycopg) driver which supports hostaddr
parameter for DNS resolution workaround on macOS.
"""

import asyncio
import logging
import os
import socket
import subprocess
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Optional
from urllib.parse import quote_plus, urlparse

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .models import Base

logger = logging.getLogger(__name__)

# Global engine and session factory
_engine: Optional[AsyncEngine] = None
_async_session_maker: Optional[async_sessionmaker[AsyncSession]] = None

# Token refresh
_token_refresh_task: Optional[asyncio.Task] = None
TOKEN_REFRESH_INTERVAL = 2400  # 40 minutes (tokens last ~1 hour)


def _resolve_hostname(hostname: str) -> Optional[str]:
    """Resolve hostname to IP address using system DNS tools.

    Python's socket.getaddrinfo() fails on macOS with long hostnames like
    Lakebase instance hostnames. This function uses the 'dig' command as
    a fallback to resolve the hostname.
    """
    try:
        result = socket.getaddrinfo(hostname, 5432)
        if result:
            return result[0][4][0]
    except socket.gaierror:
        pass

    try:
        result = subprocess.run(
            ["dig", "+short", hostname, "A"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        ips = [line for line in result.stdout.strip().split("\n") if line and line[0].isdigit()]
        if ips:
            logger.info(f"Resolved {hostname} -> {ips[0]} via dig (Python DNS failed)")
            return ips[0]
    except Exception as e:
        logger.warning(f"dig resolution failed for {hostname}: {e}")

    return None


def _generate_oauth_token() -> str:
    """Generate an OAuth token for Lakebase using SP credentials.

    Uses the Databricks SDK WorkspaceClient which picks up
    DATABRICKS_HOST, DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET
    automatically from the environment.
    """
    from databricks.sdk import WorkspaceClient

    w = WorkspaceClient()
    headers = w.config.authenticate()
    bearer = headers.get("Authorization", "")
    if bearer.startswith("Bearer "):
        return bearer[7:]
    # If authenticate() returns something unexpected, log and try token attribute
    logger.info(f"authenticate() returned type={type(headers)}, keys={list(headers.keys()) if isinstance(headers, dict) else 'N/A'}")
    return bearer


def _is_oauth_mode() -> bool:
    """Check if we need OAuth token mode (PGHOST set but no PGPASSWORD)."""
    return bool(os.environ.get("PGHOST")) and not bool(os.environ.get("PGPASSWORD"))


def get_database_url() -> Optional[str]:
    """Get database URL from environment.

    Returns:
        Database URL string with psycopg3 driver prefix, or None
    """
    pghost = os.environ.get("PGHOST")
    if not pghost:
        return None

    pguser = os.environ.get("PGUSER", "")
    pgpassword = os.environ.get("PGPASSWORD", "")
    pgdatabase = os.environ.get("PGDATABASE", "databricks_postgres")
    pgport = os.environ.get("PGPORT", "5432")

    # If no password, generate OAuth token from SP credentials
    if not pgpassword:
        logger.info("No PGPASSWORD set, generating OAuth token from SP credentials...")
        pgpassword = _generate_oauth_token()
        logger.info(f"OAuth token generated (len={len(pgpassword)})")

    return (
        f"postgresql+psycopg://{quote_plus(pguser)}:{quote_plus(pgpassword)}"
        f"@{pghost}:{pgport}/{pgdatabase}"
    )


def init_database(database_url: Optional[str] = None) -> AsyncEngine:
    """Initialize async database connection.

    Args:
        database_url: Optional database URL override.

    Returns:
        SQLAlchemy AsyncEngine instance

    Raises:
        ValueError: If no database configuration is available
    """
    global _engine, _async_session_maker

    url = database_url or get_database_url()
    if not url:
        raise ValueError(
            "No database configuration found. Configure a Lakebase autoscaling "
            "database resource so Databricks injects PGHOST/PGUSER/PGDATABASE."
        )

    logger.info("Using PGHOST (Lakebase autoscaling resource) for database connection")

    # Prepare connect_args with DNS workaround
    parsed = urlparse(url)
    connect_args = {}

    if parsed.hostname:
        hostaddr = _resolve_hostname(parsed.hostname)
        if hostaddr:
            connect_args["hostaddr"] = hostaddr
            logger.info(f"Resolved {parsed.hostname} -> {hostaddr}")

    # Add search_path
    schema_name = os.environ.get('LAKEBASE_SCHEMA_NAME', 'builder_app')
    if 'search_path' not in str(url):
        connect_args["options"] = f"-c search_path={schema_name},public"

    # Dispose old engine if re-initializing (token refresh)
    if _engine is not None:
        try:
            asyncio.get_event_loop().create_task(_engine.dispose())
        except Exception:
            pass

    _engine = create_async_engine(
        url,
        pool_size=int(os.environ.get("DB_POOL_SIZE", "5")),
        max_overflow=int(os.environ.get("DB_MAX_OVERFLOW", "10")),
        pool_pre_ping=True,
        pool_recycle=int(os.environ.get("DB_POOL_RECYCLE_INTERVAL", "1800")),
        pool_timeout=int(os.environ.get("DB_POOL_TIMEOUT", "10")),
        echo=False,
        connect_args=connect_args,
    )

    _async_session_maker = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autoflush=False,
    )

    return _engine


def get_engine() -> AsyncEngine:
    """Get the database engine, initializing if needed."""
    global _engine
    if _engine is None:
        init_database()
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Get the async session factory, initializing if needed."""
    global _async_session_maker
    if _async_session_maker is None:
        init_database()
    return _async_session_maker


async def get_session() -> AsyncSession:
    """Create a new async database session."""
    factory = get_session_factory()
    return factory()


@asynccontextmanager
async def session_scope() -> AsyncGenerator[AsyncSession, None]:
    """Provide a transactional scope around a series of operations."""
    session = await get_session()
    try:
        yield session
        await session.commit()
    except Exception:
        await session.rollback()
        raise
    finally:
        await session.close()


async def create_tables():
    """Create all database tables asynchronously.

    For production, use Alembic migrations instead.
    """
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


def is_postgres_configured() -> bool:
    """Check if PostgreSQL is configured."""
    return bool(os.environ.get("PGHOST"))


def get_user_facing_database_error(exc: Exception) -> Optional[str]:
    """Return a user-facing message for known database bootstrap failures."""
    message = str(exc).lower()
    missing_schema_markers = (
        'undefinedtable',
        'relation "projects" does not exist',
        'relation "conversations" does not exist',
        'relation "messages" does not exist',
        'relation "executions" does not exist',
        'relation "user_configs" does not exist',
    )
    if any(marker in message for marker in missing_schema_markers):
        return (
            'Project storage is not ready yet because the database schema has not '
            'finished initializing. Please retry in a minute or check app logs.'
        )
    return None


async def test_database_connection() -> Optional[str]:
    """Test database connection and return error message if failed.

    Returns:
        None if connection is successful, error message string if failed
    """
    if not is_postgres_configured():
        return None

    try:
        from sqlalchemy import text

        if _engine is None:
            init_database()

        async with _engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

        return None
    except Exception as e:
        return str(e)


async def start_token_refresh():
    """Start background task to refresh OAuth token periodically."""
    global _token_refresh_task

    if not _is_oauth_mode():
        return

    async def _refresh_loop():
        while True:
            await asyncio.sleep(TOKEN_REFRESH_INTERVAL)
            try:
                logger.info("Refreshing Lakebase OAuth token...")
                init_database()
                logger.info("Lakebase OAuth token refreshed successfully")
            except Exception as e:
                logger.error(f"Token refresh failed: {e}")

    _token_refresh_task = asyncio.create_task(_refresh_loop())
    logger.info(f"Token refresh scheduled every {TOKEN_REFRESH_INTERVAL}s")


async def stop_token_refresh():
    """Stop the token refresh background task."""
    global _token_refresh_task
    if _token_refresh_task:
        _token_refresh_task.cancel()
        try:
            await _token_refresh_task
        except asyncio.CancelledError:
            pass
        _token_refresh_task = None


def run_migrations() -> None:
    """Run Alembic migrations programmatically.

    Safe to run multiple times - Alembic tracks applied migrations.
    """
    if not is_postgres_configured():
        return

    import logging
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    logger = logging.getLogger(__name__)
    logger.info("Running database migrations...")

    try:
        app_root = Path(__file__).parent.parent.parent

        possible_paths = [
            app_root / "alembic.ini",
            Path("/app/python/source_code") / "alembic.ini",
            Path(".") / "alembic.ini",
        ]

        alembic_ini_path = None
        for path in possible_paths:
            if path.exists():
                alembic_ini_path = path
                break

        if not alembic_ini_path:
            logger.warning(
                f"alembic.ini not found in any of: {[str(p) for p in possible_paths]}. "
                "Skipping migrations."
            )
            return

        logger.info(f"Using alembic config from: {alembic_ini_path}")

        alembic_cfg = Config(str(alembic_ini_path))

        alembic_dir = alembic_ini_path.parent / "alembic"
        if alembic_dir.exists():
            alembic_cfg.set_main_option("script_location", str(alembic_dir))

        schema_name = os.environ.get("LAKEBASE_SCHEMA_NAME", "builder_app")
        alembic_cfg.set_main_option("lakebase_schema_name", schema_name)

        command.upgrade(alembic_cfg, "head")
        logger.info("Database migrations completed")
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        raise
