"""Add user_configs table for per-user settings.

Revision ID: 20260224_user_configs
Revises: 20260223_custom_prompt
Create Date: 2026-02-24
"""

import sqlalchemy as sa
from alembic import op

revision = '20260224_user_configs'
down_revision = '20260223_custom_prompt'
branch_labels = None
depends_on = None


def upgrade() -> None:
  op.create_table(
    'user_configs',
    sa.Column('user_email', sa.String(255), primary_key=True),
    sa.Column('default_catalog', sa.String(255), nullable=True),
    sa.Column('default_schema', sa.String(255), nullable=True),
    sa.Column('workspace_folder', sa.String(500), nullable=True),
    sa.Column('model', sa.String(255), nullable=True),
    sa.Column('model_mini', sa.String(255), nullable=True),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
  )


def downgrade() -> None:
  op.drop_table('user_configs')
