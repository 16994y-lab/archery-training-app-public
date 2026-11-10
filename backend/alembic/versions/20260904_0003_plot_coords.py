"""add plot_x_norm/plot_y_norm for white buffer zone coordinates

Revision ID: 20260904_0003
Revises: 20260903_0002
Create Date: 2026-09-04
"""
from alembic import op
import sqlalchemy as sa

revision = "20260904_0003"
down_revision = "20260903_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # SQLite 不支持 ALTER TABLE DROP CONSTRAINT，用原始 SQL 重建表。
    # 托管的 Supabase PostgreSQL 则使用可逆的列/约束变更，不能执行下方 SQLite 专用 DATETIME DDL。
    if op.get_bind().dialect.name != "sqlite":
        op.add_column("arrows", sa.Column("plot_x_norm", sa.Float(), nullable=True))
        op.add_column("arrows", sa.Column("plot_y_norm", sa.Float(), nullable=True))
        bind = op.get_bind()
        legacy_constraints = bind.execute(sa.text("""
            SELECT conname, pg_get_constraintdef(oid)
            FROM pg_constraint
            WHERE conrelid = 'arrows'::regclass AND contype = 'c'
        """)).all()
        for name, definition in legacy_constraints:
            if "MANUAL_NUMBER" in definition and "MANUAL_TARGET" in definition:
                op.drop_constraint(name, "arrows", type_="check")
        op.create_check_constraint(
            "ck_arrows_plot_coordinate_pair",
            "arrows",
            "(plot_x_norm IS NULL AND plot_y_norm IS NULL) OR "
            "(plot_x_norm BETWEEN 0 AND 1 AND plot_y_norm BETWEEN 0 AND 1)",
        )
        op.create_check_constraint(
            "ck_arrows_coordinate_source",
            "arrows",
            "(source = 'MANUAL_NUMBER' AND x_norm IS NULL AND y_norm IS NULL AND plot_x_norm IS NULL AND plot_y_norm IS NULL) "
            "OR (source = 'MANUAL_TARGET' AND plot_x_norm IS NOT NULL AND plot_y_norm IS NOT NULL) "
            "OR source = 'VISION_CONFIRMED'",
        )
        return
    op.execute("""
        CREATE TABLE arrows_new (
            id VARCHAR(36) PRIMARY KEY,
            end_id VARCHAR(36) NOT NULL REFERENCES ends(id),
            sequence INTEGER NOT NULL,
            score_code VARCHAR(2) NOT NULL,
            x_norm FLOAT,
            y_norm FLOAT,
            plot_x_norm FLOAT,
            plot_y_norm FLOAT,
            target_face_index INTEGER,
            source VARCHAR(20) NOT NULL,
            note VARCHAR(500),
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (end_id, sequence),
            CHECK (sequence >= 1),
            CHECK (score_code IN ('X','10','9','8','7','6','5','4','3','2','1','M')),
            CHECK ((x_norm IS NULL AND y_norm IS NULL) OR (x_norm BETWEEN 0 AND 1 AND y_norm BETWEEN 0 AND 1)),
            CHECK ((plot_x_norm IS NULL AND plot_y_norm IS NULL) OR (plot_x_norm BETWEEN 0 AND 1 AND plot_y_norm BETWEEN 0 AND 1)),
            CHECK ((source = 'MANUAL_NUMBER' AND x_norm IS NULL AND y_norm IS NULL AND plot_x_norm IS NULL AND plot_y_norm IS NULL) OR (source = 'MANUAL_TARGET' AND plot_x_norm IS NOT NULL AND plot_y_norm IS NOT NULL) OR source = 'VISION_CONFIRMED')
        )
    """)
    op.execute("""
        INSERT INTO arrows_new (id, end_id, sequence, score_code, x_norm, y_norm, plot_x_norm, plot_y_norm, target_face_index, source, note, created_at, updated_at)
        SELECT id, end_id, sequence, score_code, x_norm, y_norm, NULL, NULL, target_face_index, source, note, created_at, updated_at FROM arrows
    """)
    op.execute("DROP TABLE arrows")
    op.execute("ALTER TABLE arrows_new RENAME TO arrows")


def downgrade() -> None:
    if op.get_bind().dialect.name != "sqlite":
        # 若已保存白区 M，降级会丢失其方向坐标；部署回滚应优先回退应用版本而非反向迁移。
        op.drop_constraint("ck_arrows_coordinate_source", "arrows", type_="check")
        op.drop_constraint("ck_arrows_plot_coordinate_pair", "arrows", type_="check")
        op.drop_column("arrows", "plot_y_norm")
        op.drop_column("arrows", "plot_x_norm")
        op.create_check_constraint(
            "ck_arrows_coordinate_source_legacy",
            "arrows",
            "(source = 'MANUAL_NUMBER' AND x_norm IS NULL AND y_norm IS NULL) "
            "OR (source = 'MANUAL_TARGET' AND x_norm IS NOT NULL AND y_norm IS NOT NULL) "
            "OR source = 'VISION_CONFIRMED'",
        )
        return
    op.execute("""
        CREATE TABLE arrows_old (
            id VARCHAR(36) PRIMARY KEY,
            end_id VARCHAR(36) NOT NULL REFERENCES ends(id),
            sequence INTEGER NOT NULL,
            score_code VARCHAR(2) NOT NULL,
            x_norm FLOAT,
            y_norm FLOAT,
            target_face_index INTEGER,
            source VARCHAR(20) NOT NULL,
            note VARCHAR(500),
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (end_id, sequence),
            CHECK (sequence >= 1),
            CHECK (score_code IN ('X','10','9','8','7','6','5','4','3','2','1','M')),
            CHECK ((x_norm IS NULL AND y_norm IS NULL) OR (x_norm BETWEEN 0 AND 1 AND y_norm BETWEEN 0 AND 1)),
            CHECK ((source = 'MANUAL_NUMBER' AND x_norm IS NULL AND y_norm IS NULL) OR (source = 'MANUAL_TARGET' AND x_norm IS NOT NULL AND y_norm IS NOT NULL) OR source = 'VISION_CONFIRMED')
        )
    """)
    op.execute("""
        INSERT INTO arrows_old (id, end_id, sequence, score_code, x_norm, y_norm, target_face_index, source, note, created_at, updated_at)
        SELECT id, end_id, sequence, score_code, x_norm, y_norm, target_face_index, source, note, created_at, updated_at FROM arrows
    """)
    op.execute("DROP TABLE arrows")
    op.execute("ALTER TABLE arrows_old RENAME TO arrows")
