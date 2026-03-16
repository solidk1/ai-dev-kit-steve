"""Add claude_md to projects

Revision ID: 20260228_claude_md
Revises: 20260224_add_pat
Create Date: 2026-02-28
"""

from alembic import op
import sqlalchemy as sa

revision = '20260228_claude_md'
down_revision = '20260224_add_pat'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('claude_md', sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column('projects', 'claude_md')
