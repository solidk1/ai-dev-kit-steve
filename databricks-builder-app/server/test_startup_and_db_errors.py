import pytest


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


@pytest.mark.anyio
async def test_initialize_optional_database_runs_migrations_before_ready(monkeypatch):
    from server.db import startup as startup_module

    calls: list[str] = []

    monkeypatch.setattr(startup_module, 'is_postgres_configured', lambda: True)
    monkeypatch.setattr(startup_module, 'init_database', lambda: calls.append('init'))
    monkeypatch.setattr(startup_module, 'run_migrations', lambda: calls.append('migrate'))

    async def fake_start_token_refresh():
        calls.append('token')

    monkeypatch.setattr(startup_module, 'start_token_refresh', fake_start_token_refresh)
    monkeypatch.setattr(startup_module, 'start_backup_worker', lambda: calls.append('backup'))

    ready = await startup_module.initialize_optional_database()

    assert ready is True
    assert calls == ['init', 'migrate', 'token', 'backup']


def test_get_user_facing_database_error_translates_missing_projects_table():
    from server.db.database import get_user_facing_database_error

    detail = get_user_facing_database_error(
        Exception('psycopg.errors.UndefinedTable: relation "projects" does not exist')
    )

    assert detail == (
        'Project storage is not ready yet because the database schema has not finished '
        'initializing. Please retry in a minute or check app logs.'
    )


def test_get_user_facing_database_error_returns_none_for_other_errors():
    from server.db.database import get_user_facing_database_error

    assert get_user_facing_database_error(Exception('some other failure')) is None
