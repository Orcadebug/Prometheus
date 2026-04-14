import { ConnectionManager } from '../db/connection';
import { DiffEngine } from './diff-engine';
import {
  Branch,
  MergeConflict,
  MergeOptions,
  MergeResult,
} from '../types/branch.types';

export class MergeEngine {
  constructor(
    private conn: ConnectionManager,
    private diff: DiffEngine
  ) {}

  /**
   * Merge branch changes into parent schema.
   */
  async merge(branch: Branch, options: MergeOptions): Promise<MergeResult> {
    const conflicts: MergeConflict[] = [];

    // 1. Detect conflicts — check if parent schema drifted since fork
    const copiedTables = await this.conn.query<{
      table_name: string;
      parent_checksum: string | null;
    }>(
      `SELECT table_name, parent_checksum
       FROM system.prometheus_branch_tables
       WHERE branch_id = $1`,
      [branch.id]
    );

    for (const { table_name, parent_checksum } of copiedTables) {
      if (options.excludeTables?.includes(table_name)) continue;

      // Check if parent table still exists
      const exists = await this.conn.queryOne<{ exists: boolean }>(
        `SELECT EXISTS(
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2
        ) AS exists`,
        [branch.parentSchema, table_name]
      );

      if (!exists?.exists) {
        conflicts.push({
          tableName: table_name,
          type: 'schema_diverged',
          description: `Table "${table_name}" no longer exists in parent schema`,
          resolution: null,
        });
        continue;
      }

      // Check checksum drift
      if (parent_checksum) {
        const currentChecksum = await this.conn.queryOne<{ prometheus_table_checksum: string }>(
          `SELECT system.prometheus_table_checksum($1, $2)`,
          [branch.parentSchema, table_name]
        );

        if (currentChecksum?.prometheus_table_checksum !== parent_checksum) {
          conflicts.push({
            tableName: table_name,
            type: 'schema_diverged',
            description: `Parent table "${table_name}" schema changed since branch was created`,
            resolution: null,
          });
        }
      }
    }

    // 2. Handle conflicts based on strategy
    if (conflicts.length > 0 && options.strategy === 'fail_on_conflict') {
      return {
        success: false,
        branchId: branch.id,
        tablesAffected: [],
        conflicts,
        migrationSql: '',
        appliedAt: null,
      };
    }

    // Apply resolution strategy to conflicts
    for (const conflict of conflicts) {
      conflict.resolution = options.strategy === 'branch_wins' ? 'branch_wins' : 'parent_wins';
    }

    // 3. Generate migration SQL
    const migrationSql = await this.diff.generateMigrationSql(branch);

    // 4. If dry run, return without applying
    if (options.dryRun) {
      return {
        success: true,
        branchId: branch.id,
        tablesAffected: copiedTables
          .filter((t) => !options.excludeTables?.includes(t.table_name))
          .map((t) => t.table_name),
        conflicts,
        migrationSql,
        appliedAt: null,
      };
    }

    // 5. Apply merge in transaction
    const tablesAffected: string[] = [];

    await this.conn.withTransaction(async (client) => {
      // Acquire advisory lock for merge
      const lockKey = hashText('merge:' + branch.id);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // Re-check branch state under lock
      const currentBranch = await client.query(
        'SELECT state FROM system.prometheus_branches WHERE id = $1',
        [branch.id]
      );
      if (currentBranch.rows[0]?.state !== 'active') {
        throw new Error('Branch state changed during merge');
      }

      // Apply migration SQL
      // Split by statements and execute (skip empty lines and comments)
      const statements = migrationSql
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('--') && s !== 'BEGIN' && s !== 'COMMIT');

      for (const stmt of statements) {
        await client.query(stmt);
      }

      // Track affected tables
      for (const { table_name } of copiedTables) {
        if (!options.excludeTables?.includes(table_name)) {
          tablesAffected.push(table_name);
        }
      }

      // Update branch state
      await client.query(
        `UPDATE system.prometheus_branches
         SET state = 'merged', merged_at = now()
         WHERE id = $1`,
        [branch.id]
      );

      // Audit log
      await client.query(
        `INSERT INTO system.prometheus_branch_log (branch_id, action, details)
         VALUES ($1, 'merge', $2)`,
        [
          branch.id,
          JSON.stringify({
            strategy: options.strategy,
            tablesAffected,
            conflictCount: conflicts.length,
          }),
        ]
      );

      // Notify PostgREST
      await client.query("SELECT pg_notify('pgrst', 'reload schema')");
    });

    return {
      success: true,
      branchId: branch.id,
      tablesAffected,
      conflicts,
      migrationSql,
      appliedAt: new Date(),
    };
  }
}

function hashText(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}
