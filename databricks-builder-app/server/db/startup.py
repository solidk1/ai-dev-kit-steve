"""Database startup helpers."""

import asyncio
import logging

from .database import (
    init_database,
    is_postgres_configured,
    run_migrations,
    start_token_refresh,
)

logger = logging.getLogger(__name__)


def start_backup_worker() -> None:
    """Start the backup worker without importing heavy services at module load."""
    from ..services.backup_manager import start_backup_worker as _start_backup_worker

    _start_backup_worker()


async def initialize_optional_database() -> bool:
    """Initialize the database and finish migrations before serving requests."""
    if not is_postgres_configured():
        logger.warning(
            'Database not configured. Configure a Lakebase autoscaling database '
            'resource so Databricks injects PGHOST/PGUSER/PGDATABASE.'
        )
        return False

    logger.info('Initializing database...')
    try:
        init_database()
        await asyncio.to_thread(run_migrations)
        await start_token_refresh()
        start_backup_worker()
        return True
    except Exception as e:
        logger.warning(
            f'Database initialization failed: {e}\n'
            "App will continue without database features (conversations won't be persisted)."
        )
        return False
