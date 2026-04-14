import { ConnectionManager } from '../db/connection';
import { GCOptions, GCReport } from '../types/branch.types';

export class GarbageCollector {
  constructor(private conn: ConnectionManager) {}

  /**
   * Clean up stale branches and orphaned schemas.
   */
  async collect(options: GCOptions): Promise<GCReport> {
    const orphanedSchemas = await this.findOrphanedSchemas();
    const staleBranches = await this.findStaleBranches(options.maxAgeDays);

    if (options.dryRun) {
      return { orphanedSchemas, staleBranches, cleanedUp: false };
    }

    // Drop orphaned schemas
    for (const schema of orphanedSchemas) {
      await this.conn.withTransaction(async (client) => {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      });
    }

    // Clean up stale branch metadata
    for (const branchId of staleBranches) {
      await this.conn.withTransaction(async (client) => {
        // Schema already dropped (or should be) for deleted/merged branches
        const row = await client.query(
          'SELECT branch_schema FROM system.prometheus_branches WHERE id = $1',
          [branchId]
        );
        if (row.rows[0]) {
          await client.query(
            `DROP SCHEMA IF EXISTS "${row.rows[0].branch_schema}" CASCADE`
          );
        }
        await client.query(
          'DELETE FROM system.prometheus_branches WHERE id = $1',
          [branchId]
        );
      });
    }

    return { orphanedSchemas, staleBranches, cleanedUp: true };
  }

  /**
   * Find schemas starting with 'branch_' that have no matching metadata row.
   */
  private async findOrphanedSchemas(): Promise<string[]> {
    const rows = await this.conn.query<{ schema_name: string }>(
      `SELECT n.nspname AS schema_name
       FROM pg_namespace n
       WHERE n.nspname LIKE 'branch_%'
         AND NOT EXISTS (
           SELECT 1 FROM system.prometheus_branches b
           WHERE b.branch_schema = n.nspname AND b.state != 'deleted'
         )`
    );
    return rows.map((r) => r.schema_name);
  }

  /**
   * Find branches in deleted/merged state older than maxAgeDays.
   */
  private async findStaleBranches(maxAgeDays: number): Promise<string[]> {
    const rows = await this.conn.query<{ id: string }>(
      `SELECT id FROM system.prometheus_branches
       WHERE state IN ('deleted', 'merged')
         AND COALESCE(deleted_at, merged_at, created_at) < now() - interval '1 day' * $1`,
      [maxAgeDays]
    );
    return rows.map((r) => r.id);
  }
}
