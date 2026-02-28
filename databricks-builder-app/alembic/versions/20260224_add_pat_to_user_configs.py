"""Add databricks_pat_encrypted column to user_configs.

Revision ID: 20260224_add_pat
Revises: 20260224_user_configs
Create Date: 2026-02-24
"""

import sqlalchemy as sa
from alembic import op

revision = '20260224_add_pat'
down_revision = '20260224_user_configs'
branch_labels = None
depends_on = None


def upgrade() -> None:
  op.add_column(
    'user_configs',
    sa.Column('databricks_pat_encrypted', sa.Text(), nullable=True),
  )


def downgrade() -> None:
  op.drop_column('user_configs', 'databricks_pat_encrypted')
