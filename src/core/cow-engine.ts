import { PoolClient } from 'pg';
import { ConnectionManager } from '../db/connection';
import { Branch, BranchTable, PROTECTED_SCHEMAS } from '../types/branch.types';

export class CowEngine {
  constructor(private conn: ConnectionManager) {}

  /**
   * Ensure a table is COW-copied into the branch schema.
   * No-op if already copied. Uses advisory lock for concurrency safety.
   */
  async ensureCopied(branch: Branch, tableName: string): Promise<boolean> {
    this.validateTable(tableName);

    // Fast path: check if already copied
    const existing = await this.conn.queryOne<BranchTable>(
      `SELECT id FROM system.prometheus_branch_tables
       WHERE branch_id = $1 AND table_name = $2`,
      [branch.id, tableName]
    );
    if (existing) return false;

    // Verify source table exists in parent schema
    const tableExists = await this.conn.queryOne<{ exists: boolean }>(
      `SELECT EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      ) AS exists`,
      [branch.parentSchema, tableName]
    );
    if (!tableExists?.exists) {
      throw new Error(`Table "${tableName}" not found in schema "${branch.parentSchema}"`);
    }

    // COW copy inside transaction (advisory lock is transaction-scoped)
    await this.conn.withTransaction(async (client) => {
      await client.query(
        `SELECT system.prometheus_cow_copy($1, $2, $3, $4)`,
        [branch.branchSchema, branch.parentSchema, tableName, branch.id]
      );
    });

    return true;
  }

  /**
   * Get all COW-copied tables for a branch.
   */
  async getCopiedTables(branchId: string): Promise<BranchTable[]> {
    return this.conn.query<BranchTable>(
      `SELECT id, branch_id AS "branchId", table_name AS "tableName",
              copied_at AS "copiedAt", row_count_at_fork AS "rowCountAtFork",
              parent_checksum AS "parentChecksum"
       FROM system.prometheus_branch_tables
       WHERE branch_id = $1
       ORDER BY copied_at`,
      [branchId]
    );
  }

  /**
   * Check if a specific table has been COW-copied.
   */
  async isCopied(branchId: string, tableName: string): Promise<boolean> {
    const row = await this.conn.queryOne(
      `SELECT 1 FROM system.prometheus_branch_tables
       WHERE branch_id = $1 AND table_name = $2`,
      [branchId, tableName]
    );
    return !!row;
  }

  /**
   * List all tables in the parent schema that are available for branching.
   */
  async listBranchableTables(parentSchema: string): Promise<string[]> {
    const rows = await this.conn.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [parentSchema]
    );
    return rows.map((r) => r.table_name);
  }

  private validateTable(tableName: string): void {
    // Reject any table name that looks like it belongs to a protected schema
    const lower = tableName.toLowerCase();
    if (lower.startsWith('prometheus_')) {
      throw new Error('Cannot branch Prometheus metadata tables');
    }
  }
}
