"""Add response stats columns to messages

Revision ID: 20260316_msg_stats
Revises: 20260228_claude_md
Create Date: 2026-03-16
"""

from alembic import op
import sqlalchemy as sa

revision = '20260316_msg_stats'
down_revision = '20260228_claude_md'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('messages', sa.Column('duration_ms', sa.Integer(), nullable=True))
    op.add_column('messages', sa.Column('num_turns', sa.Integer(), nullable=True))
    op.add_column('messages', sa.Column('input_tokens', sa.Integer(), nullable=True))
    op.add_column('messages', sa.Column('output_tokens', sa.Integer(), nullable=True))
    op.add_column('messages', sa.Column('cache_read_tokens', sa.Integer(), nullable=True))
    op.add_column('messages', sa.Column('cache_creation_tokens', sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column('messages', 'cache_creation_tokens')
    op.drop_column('messages', 'cache_read_tokens')
    op.drop_column('messages', 'output_tokens')
    op.drop_column('messages', 'input_tokens')
    op.drop_column('messages', 'num_turns')
    op.drop_column('messages', 'duration_ms')
