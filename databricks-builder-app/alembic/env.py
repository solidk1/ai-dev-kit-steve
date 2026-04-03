"""Alembic environment configuration for database migrations.

Uses sync psycopg3 driver for migrations (simpler and avoids async event loop issues).
Runtime database access also uses psycopg3 for async access.
"""

import os
from logging.config import fileConfig

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import create_engine, pool

# Load environment variables from .env.local
load_dotenv('.env.local')

# Import models for autogenerate support
from server.db.models import Base
from server.db.database import _resolve_hostname

# this is the Alembic Config object
config = context.config

# Setup logging from alembic.ini
if config.config_file_name is not None:
  fileConfig(config.config_file_name)

# Target metadata for autogenerate
target_metadata = Base.metadata

# Store resolved hostaddr for connect_args
_resolved_hostaddr = None


def get_url_and_connect_args():
  """Get database URL and connect_args from environment.

  Returns tuple of (url, connect_args) for psycopg3 driver.
  """
  global _resolved_hostaddr
  connect_args = {}

  from server.db.database import get_database_url
  url = get_database_url()

  if not url:
    raise ValueError(
      'Database not configured. Configure a Lakebase autoscaling database '
      'resource so Databricks injects PGHOST/PGUSER/PGDATABASE.'
    )

  # Resolve hostname for DNS workaround
  from urllib.parse import urlparse
  parsed = urlparse(url)
  if parsed.hostname:
    _resolved_hostaddr = _resolve_hostname(parsed.hostname)
    if _resolved_hostaddr:
      connect_args['hostaddr'] = _resolved_hostaddr

  return url, connect_args


def run_migrations_offline():
  """Run migrations in 'offline' mode.

  This configures the context with just a URL
  and not an Engine, though an Engine is acceptable
  here as well. By skipping the Engine creation
  we don't even need a DBAPI to be available.

  Calls to context.execute() here emit the given string to the
  script output.
  """
  url, _ = get_url_and_connect_args()
  context.configure(
    url=url,
    target_metadata=target_metadata,
    literal_binds=True,
    dialect_opts={'paramstyle': 'named'},
  )

  with context.begin_transaction():
    context.run_migrations()


def run_migrations_online():
  """Run migrations in 'online' mode using sync engine."""
  url, connect_args = get_url_and_connect_args()

  # Get schema name from Alembic config or environment
  schema_name = config.get_main_option('lakebase_schema_name') or os.environ.get('LAKEBASE_SCHEMA_NAME', 'builder_app')

  # Validate schema name to prevent SQL injection (only allow alphanumeric + underscores)
  import re
  if not re.match(r'^[a-zA-Z_][a-zA-Z0-9_]*$', schema_name):
    raise ValueError(f'Invalid schema name: {schema_name!r} — must be alphanumeric/underscores only')

  # Add search_path to connect_args so tables are created in the custom schema
  connect_args.setdefault('options', f'-c search_path={schema_name},public')

  connectable = create_engine(
    url,
    poolclass=pool.NullPool,
    connect_args=connect_args,
  )

  with connectable.connect() as connection:
    # Create the schema if it doesn't exist (SP has CREATE on the database)
    from sqlalchemy import text
    connection.execute(text(f'CREATE SCHEMA IF NOT EXISTS {schema_name}'))
    connection.commit()

    context.configure(
      connection=connection,
      target_metadata=target_metadata,
    )

    with context.begin_transaction():
      context.run_migrations()

  connectable.dispose()


if context.is_offline_mode():
  run_migrations_offline()
else:
  run_migrations_online()
