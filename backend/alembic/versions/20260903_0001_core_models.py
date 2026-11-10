"""create core training models

Revision ID: 20260903_0001
Revises:
Create Date: 2026-09-03
"""
from alembic import op
import sqlalchemy as sa

revision = "20260903_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("target_definitions", sa.Column("id", sa.String(36), primary_key=True), sa.Column("name", sa.String(80), nullable=False), sa.Column("target_type", sa.String(32), nullable=False), sa.Column("scoring_mode", sa.String(20), nullable=False), sa.Column("face_count", sa.Integer, nullable=False), sa.Column("allowed_score_codes", sa.JSON, nullable=False), sa.Column("ring_rules", sa.JSON), sa.Column("diameter_cm", sa.Float), sa.Column("is_built_in", sa.Boolean, nullable=False), sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")), sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")))
    op.create_table("training_plans", sa.Column("id", sa.String(36), primary_key=True), sa.Column("name", sa.String(80), nullable=False), sa.Column("description", sa.String(500)), sa.Column("bow_type", sa.String(20), nullable=False), sa.Column("distance_m", sa.Float, nullable=False), sa.Column("target_definition_id", sa.String(36), sa.ForeignKey("target_definitions.id"), nullable=False), sa.Column("default_arrows_per_end", sa.Integer, nullable=False), sa.Column("default_end_count", sa.Integer, nullable=False), sa.Column("equipment_note", sa.String(500)), sa.Column("status", sa.String(12), nullable=False), sa.Column("source_plan_id", sa.String(36)), sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")), sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")), sa.CheckConstraint("distance_m > 0"), sa.CheckConstraint("default_arrows_per_end BETWEEN 1 AND 12"), sa.CheckConstraint("default_end_count BETWEEN 1 AND 200"))
    op.create_table("plan_blocks", sa.Column("id", sa.String(36), primary_key=True), sa.Column("training_plan_id", sa.String(36), sa.ForeignKey("training_plans.id"), nullable=False), sa.Column("position", sa.Integer, nullable=False), sa.Column("block_type", sa.String(20), nullable=False), sa.Column("title", sa.String(80), nullable=False), sa.Column("instructions", sa.Text), sa.Column("end_count", sa.Integer), sa.Column("arrows_per_end", sa.Integer), sa.Column("duration_minutes", sa.Integer), sa.Column("is_scored", sa.Boolean, nullable=False), sa.UniqueConstraint("training_plan_id", "position"), sa.CheckConstraint("position >= 1"))
    op.create_table("training_sessions", sa.Column("id", sa.String(36), primary_key=True), sa.Column("training_plan_id", sa.String(36), sa.ForeignKey("training_plans.id")), sa.Column("plan_snapshot", sa.JSON), sa.Column("target_definition_id", sa.String(36), sa.ForeignKey("target_definitions.id"), nullable=False), sa.Column("target_snapshot", sa.JSON, nullable=False), sa.Column("bow_type", sa.String(20), nullable=False), sa.Column("distance_m", sa.Float, nullable=False), sa.Column("planned_end_count", sa.Integer, nullable=False), sa.Column("arrows_per_end", sa.Integer, nullable=False), sa.Column("status", sa.String(24), nullable=False), sa.Column("completion_mode", sa.String(12)), sa.Column("equipment_note", sa.String(500)), sa.Column("note", sa.String(2000)), sa.Column("started_at", sa.DateTime), sa.Column("confirmed_at", sa.DateTime), sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")), sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")))
    op.create_table("ends", sa.Column("id", sa.String(36), primary_key=True), sa.Column("training_session_id", sa.String(36), sa.ForeignKey("training_sessions.id"), nullable=False), sa.Column("plan_block_id", sa.String(36), sa.ForeignKey("plan_blocks.id")), sa.Column("sequence", sa.Integer, nullable=False), sa.Column("expected_arrow_count", sa.Integer, nullable=False), sa.Column("status", sa.String(12), nullable=False), sa.Column("note", sa.String(1000)), sa.Column("confirmed_at", sa.DateTime), sa.UniqueConstraint("training_session_id", "sequence"), sa.CheckConstraint("sequence >= 1"), sa.CheckConstraint("expected_arrow_count BETWEEN 1 AND 12"))
    op.create_table("arrows", sa.Column("id", sa.String(36), primary_key=True), sa.Column("end_id", sa.String(36), sa.ForeignKey("ends.id"), nullable=False), sa.Column("sequence", sa.Integer, nullable=False), sa.Column("score_code", sa.String(2), nullable=False), sa.Column("x_norm", sa.Float), sa.Column("y_norm", sa.Float), sa.Column("target_face_index", sa.Integer), sa.Column("source", sa.String(20), nullable=False), sa.Column("note", sa.String(500)), sa.Column("created_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")), sa.Column("updated_at", sa.DateTime, nullable=False, server_default=sa.text("CURRENT_TIMESTAMP")), sa.UniqueConstraint("end_id", "sequence"), sa.CheckConstraint("sequence >= 1"), sa.CheckConstraint("score_code IN ('X','10','9','8','7','6','5','4','3','2','1','M')"), sa.CheckConstraint("(x_norm IS NULL AND y_norm IS NULL) OR (x_norm BETWEEN 0 AND 1 AND y_norm BETWEEN 0 AND 1)"), sa.CheckConstraint("(source = 'MANUAL_NUMBER' AND x_norm IS NULL AND y_norm IS NULL) OR (source = 'MANUAL_TARGET' AND x_norm IS NOT NULL AND y_norm IS NOT NULL) OR source = 'VISION_CONFIRMED'"))


def downgrade() -> None:
    op.drop_table("arrows")
    op.drop_table("ends")
    op.drop_table("training_sessions")
    op.drop_table("plan_blocks")
    op.drop_table("training_plans")
    op.drop_table("target_definitions")
