"""Add custom_system_prompt to projects

Revision ID: 20260223_custom_prompt
Revises: 20260223_executions
Create Date: 2026-02-23

"""
from alembic import op
import sqlalchemy as sa

revision = '20260223_custom_prompt'
down_revision = '20260223_executions'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('custom_system_prompt', sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column('projects', 'custom_system_prompt')
