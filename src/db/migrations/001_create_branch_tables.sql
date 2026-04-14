-- Prometheus: Branch metadata tables
-- All metadata lives in the 'system' schema (shared w/ InsForge)

CREATE SCHEMA IF NOT EXISTS system;

CREATE TABLE IF NOT EXISTS system.prometheus_branches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL UNIQUE,
    parent_id       UUID REFERENCES system.prometheus_branches(id),
    parent_schema   TEXT NOT NULL DEFAULT 'public',
    branch_schema   TEXT NOT NULL UNIQUE,
    state           TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'merged', 'deleted', 'conflict')),
    fork_point_xid  BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    merged_at       TIMESTAMPTZ,
    deleted_at      TIMESTAMPTZ,
    created_by      TEXT,
    metadata        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_prometheus_branches_state
    ON system.prometheus_branches(state);
CREATE INDEX IF NOT EXISTS idx_prometheus_branches_parent
    ON system.prometheus_branches(parent_id);

CREATE TABLE IF NOT EXISTS system.prometheus_branch_tables (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id       UUID NOT NULL
                    REFERENCES system.prometheus_branches(id) ON DELETE CASCADE,
    table_name      TEXT NOT NULL,
    copied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    row_count_at_fork BIGINT,
    parent_checksum TEXT,
    UNIQUE(branch_id, table_name)
);

CREATE TABLE IF NOT EXISTS system.prometheus_branch_log (
    id              BIGSERIAL PRIMARY KEY,
    branch_id       UUID NOT NULL
                    REFERENCES system.prometheus_branches(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,
    table_name      TEXT,
    details         JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prometheus_branch_log_branch
    ON system.prometheus_branch_log(branch_id);
