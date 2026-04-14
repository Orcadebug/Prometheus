-- Prometheus: Helper functions for COW copy and diff

-- ─── COW Copy ───
-- Copies a single table from parent schema to branch schema.
-- Uses advisory lock to prevent double-copy under concurrency.
CREATE OR REPLACE FUNCTION system.prometheus_cow_copy(
    p_branch_schema TEXT,
    p_parent_schema TEXT,
    p_table_name    TEXT,
    p_branch_id     UUID
) RETURNS VOID AS $$
DECLARE
    lock_key BIGINT;
    already_copied BOOLEAN;
    row_count BIGINT;
BEGIN
    -- Deterministic lock key from branch + table
    lock_key := hashtext(p_branch_schema || '.' || p_table_name);
    PERFORM pg_advisory_xact_lock(lock_key);

    -- Double-check after acquiring lock
    SELECT EXISTS(
        SELECT 1 FROM system.prometheus_branch_tables
        WHERE branch_id = p_branch_id AND table_name = p_table_name
    ) INTO already_copied;

    IF already_copied THEN
        RETURN;
    END IF;

    -- Copy table structure (indexes, defaults, constraints, NOT NULL)
    EXECUTE format(
        'CREATE TABLE %I.%I (LIKE %I.%I INCLUDING ALL)',
        p_branch_schema, p_table_name, p_parent_schema, p_table_name
    );

    -- Copy data
    EXECUTE format(
        'INSERT INTO %I.%I SELECT * FROM %I.%I',
        p_branch_schema, p_table_name, p_parent_schema, p_table_name
    );

    -- Get row count
    EXECUTE format(
        'SELECT count(*) FROM %I.%I', p_branch_schema, p_table_name
    ) INTO row_count;

    -- Reset sequences to max(pk)+1 to avoid collisions on merge
    -- Finds all serial/identity columns and resets their sequences
    PERFORM system.prometheus_reset_sequences(p_branch_schema, p_table_name);

    -- Record the copy
    INSERT INTO system.prometheus_branch_tables
        (branch_id, table_name, row_count_at_fork, parent_checksum)
    VALUES (
        p_branch_id,
        p_table_name,
        row_count,
        system.prometheus_table_checksum(p_parent_schema, p_table_name)
    );

    -- Audit log
    INSERT INTO system.prometheus_branch_log (branch_id, action, table_name, details)
    VALUES (p_branch_id, 'cow_copy', p_table_name,
            jsonb_build_object('row_count', row_count));

    -- Notify PostgREST to reload schema cache
    PERFORM pg_notify('pgrst', 'reload schema');
END;
$$ LANGUAGE plpgsql;


-- ─── Reset Sequences ───
-- After COW copy, reset branch sequences to max(pk)+1
CREATE OR REPLACE FUNCTION system.prometheus_reset_sequences(
    p_schema TEXT,
    p_table_name TEXT
) RETURNS VOID AS $$
DECLARE
    seq_rec RECORD;
    max_val BIGINT;
BEGIN
    FOR seq_rec IN
        SELECT
            pg_get_serial_sequence(format('%I.%I', p_schema, p_table_name), a.attname) AS seq_name,
            a.attname AS col_name
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = p_schema
          AND c.relname = p_table_name
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND pg_get_serial_sequence(format('%I.%I', p_schema, p_table_name), a.attname) IS NOT NULL
    LOOP
        EXECUTE format(
            'SELECT COALESCE(max(%I), 0) FROM %I.%I',
            seq_rec.col_name, p_schema, p_table_name
        ) INTO max_val;

        EXECUTE format(
            'SELECT setval(%L, greatest(%s, 1))',
            seq_rec.seq_name, max_val + 1
        );
    END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ─── Table Checksum ───
-- MD5 hash of table DDL for drift detection at merge time
CREATE OR REPLACE FUNCTION system.prometheus_table_checksum(
    p_schema TEXT,
    p_table_name TEXT
) RETURNS TEXT AS $$
DECLARE
    ddl_text TEXT;
BEGIN
    SELECT string_agg(
        column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, 'NULL'),
        '|' ORDER BY ordinal_position
    )
    INTO ddl_text
    FROM information_schema.columns
    WHERE table_schema = p_schema
      AND table_name = p_table_name;

    RETURN md5(COALESCE(ddl_text, ''));
END;
$$ LANGUAGE plpgsql;


-- ─── Diff Table ───
-- Compares rows between branch and parent using primary key join.
-- Returns JSON summary of inserts, deletes, updates.
CREATE OR REPLACE FUNCTION system.prometheus_diff_table(
    p_branch_schema TEXT,
    p_parent_schema TEXT,
    p_table_name    TEXT,
    p_pk_columns    TEXT[]
) RETURNS JSONB AS $$
DECLARE
    pk_join TEXT;
    inserted BIGINT;
    deleted BIGINT;
    updated BIGINT;
BEGIN
    -- Build PK join clause: b."col" = p."col" AND ...
    SELECT string_agg(
        format('b.%I = p.%I', col, col), ' AND '
    )
    INTO pk_join
    FROM unnest(p_pk_columns) AS col;

    -- Inserts: in branch but not parent
    EXECUTE format(
        'SELECT count(*) FROM %I.%I b LEFT JOIN %I.%I p ON %s WHERE p.%I IS NULL',
        p_branch_schema, p_table_name,
        p_parent_schema, p_table_name,
        pk_join,
        p_pk_columns[1]
    ) INTO inserted;

    -- Deletes: in parent but not branch
    EXECUTE format(
        'SELECT count(*) FROM %I.%I p LEFT JOIN %I.%I b ON %s WHERE b.%I IS NULL',
        p_parent_schema, p_table_name,
        p_branch_schema, p_table_name,
        pk_join,
        p_pk_columns[1]
    ) INTO deleted;

    -- Updates: same PK, different content
    EXECUTE format(
        'SELECT count(*) FROM %I.%I b JOIN %I.%I p ON %s WHERE b::text IS DISTINCT FROM p::text',
        p_branch_schema, p_table_name,
        p_parent_schema, p_table_name,
        pk_join
    ) INTO updated;

    RETURN jsonb_build_object(
        'table', p_table_name,
        'inserted', inserted,
        'deleted', deleted,
        'updated', updated,
        'has_changes', (inserted + deleted + updated) > 0
    );
END;
$$ LANGUAGE plpgsql;
