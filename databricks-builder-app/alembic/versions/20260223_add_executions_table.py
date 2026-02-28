"""Add executions table

Revision ID: 20260223_executions
Revises: 20260115_warehouse_workspace
Create Date: 2026-02-23

"""
from alembic import op
import sqlalchemy as sa

revision = '20260223_executions'
down_revision = '20260115_warehouse_workspace'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'executions',
        sa.Column('id', sa.String(50), primary_key=True),
        sa.Column('conversation_id', sa.String(50), sa.ForeignKey('conversations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('project_id', sa.String(50), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('status', sa.String(20), nullable=False, server_default='running'),
        sa.Column('events_json', sa.Text, nullable=False, server_default='[]'),
        sa.Column('error', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_executions_conversation_status', 'executions', ['conversation_id', 'status'])
    op.create_index('ix_executions_conversation_created', 'executions', ['conversation_id', 'created_at'])


def downgrade() -> None:
    op.drop_index('ix_executions_conversation_created', table_name='executions')
    op.drop_index('ix_executions_conversation_status', table_name='executions')
    op.drop_table('executions')
