import { ConnectionManager } from '../db/connection';
import { CowEngine } from './cow-engine';
import { DiffEngine } from './diff-engine';
import { MergeEngine } from './merge-engine';
import {
  Branch,
  BranchCreateOptions,
  BranchState,
  BranchTable,
  DiffResult,
  MergeOptions,
  MergeResult,
  PROTECTED_SCHEMAS,
} from '../types/branch.types';

const SCHEMA_PREFIX = 'branch_';
const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export class BranchManager {
  constructor(
    private conn: ConnectionManager,
    private cow: CowEngine,
    private diff: DiffEngine,
    private merge: MergeEngine
  ) {}

  /**
   * Create a new branch. O(1) — only creates schema + metadata row.
   */
  async create(options: BranchCreateOptions): Promise<Branch> {
    const name = options.name.toLowerCase().trim();
    this.validateName(name);

    const branchSchema = SCHEMA_PREFIX + name.replace(/-/g, '_');

    // Resolve parent
    let parentSchema = 'public';
    let parentId: string | null = null;

    if (options.parentBranch) {
      const parent = await this.resolve(options.parentBranch);
      if (!parent) throw new Error(`Parent branch "${options.parentBranch}" not found`);
      parentSchema = parent.branchSchema;
      parentId = parent.id;
    }

    // Check name uniqueness
    const existing = await this.conn.queryOne(
      'SELECT 1 FROM system.prometheus_branches WHERE name = $1 AND state != $2',
      [name, 'deleted']
    );
    if (existing) throw new Error(`Branch "${name}" already exists`);

    // Create in transaction
    const branch = await this.conn.withTransaction(async (client) => {
      // Create empty schema
      await client.query(`CREATE SCHEMA ${quoteIdent(branchSchema)}`);

      // Insert metadata
      const result = await client.query(
        `INSERT INTO system.prometheus_branches
           (name, parent_id, parent_schema, branch_schema, state, fork_point_xid, created_by, metadata)
         VALUES ($1, $2, $3, $4, 'active', txid_current(), $5, $6)
         RETURNING *`,
        [
          name,
          parentId,
          parentSchema,
          branchSchema,
          options.createdBy ?? null,
          JSON.stringify(options.metadata ?? {}),
        ]
      );

      // Audit log
      await client.query(
        `INSERT INTO system.prometheus_branch_log (branch_id, action, details)
         VALUES ($1, 'create', $2)`,
        [result.rows[0].id, JSON.stringify({ parentSchema, branchSchema })]
      );

      return result.rows[0];
    });

    return this.mapRow(branch);
  }

  /**
   * Resolve branch by name or ID.
   */
  async resolve(nameOrId: string): Promise<Branch | null> {
    const row = await this.conn.queryOne(
      `SELECT * FROM system.prometheus_branches
       WHERE (name = $1 OR id::text = $1) AND state != 'deleted'`,
      [nameOrId]
    );
    return row ? this.mapRow(row) : null;
  }

  /**
   * Get branch by ID.
   */
  async get(id: string): Promise<Branch | null> {
    const row = await this.conn.queryOne(
      'SELECT * FROM system.prometheus_branches WHERE id = $1',
      [id]
    );
    return row ? this.mapRow(row) : null;
  }

  /**
   * List all branches.
   */
  async list(state?: BranchState): Promise<Branch[]> {
    let query = 'SELECT * FROM system.prometheus_branches';
    const params: any[] = [];

    if (state) {
      query += ' WHERE state = $1';
      params.push(state);
    }

    query += ' ORDER BY created_at DESC';
    const rows = await this.conn.query(query, params);
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Delete a branch. Drops schema CASCADE and updates metadata.
   */
  async delete(branchId: string): Promise<void> {
    const branch = await this.get(branchId);
    if (!branch) throw new Error('Branch not found');
    if (branch.state === 'deleted') throw new Error('Branch already deleted');

    await this.conn.withTransaction(async (client) => {
      // Acquire advisory lock
      const lockKey = hashText('delete:' + branchId);
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);

      // Drop schema and all COW-copied tables
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(branch.branchSchema)} CASCADE`);

      // Update metadata
      await client.query(
        `UPDATE system.prometheus_branches
         SET state = 'deleted', deleted_at = now()
         WHERE id = $1`,
        [branchId]
      );

      // Audit log
      await client.query(
        `INSERT INTO system.prometheus_branch_log (branch_id, action)
         VALUES ($1, 'delete')`,
        [branchId]
      );

      // Notify PostgREST
      await client.query("SELECT pg_notify('pgrst', 'reload schema')");
    });
  }

  /**
   * Get COW-copied tables for a branch.
   */
  async getTables(branchId: string): Promise<BranchTable[]> {
    return this.cow.getCopiedTables(branchId);
  }

  /**
   * Diff branch against its parent.
   */
  async diffBranch(branchId: string): Promise<DiffResult> {
    const branch = await this.get(branchId);
    if (!branch) throw new Error('Branch not found');
    return this.diff.diff(branch);
  }

  /**
   * Generate migration SQL for merging branch.
   */
  async getMergeSql(branchId: string): Promise<string> {
    const branch = await this.get(branchId);
    if (!branch) throw new Error('Branch not found');
    return this.diff.generateMigrationSql(branch);
  }

  /**
   * Merge branch into parent.
   */
  async mergeBranch(branchId: string, options: MergeOptions): Promise<MergeResult> {
    const branch = await this.get(branchId);
    if (!branch) throw new Error('Branch not found');
    if (branch.state !== 'active') throw new Error(`Cannot merge branch in "${branch.state}" state`);
    return this.merge.merge(branch, options);
  }

  private validateName(name: string): void {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        'Branch name must start with alphanumeric, contain only lowercase letters, numbers, hyphens, underscores'
      );
    }
    if (name.length > 63) {
      throw new Error('Branch name too long (max 63 chars)');
    }
    // Reject protected schema names
    if ((PROTECTED_SCHEMAS as readonly string[]).includes(name)) {
      throw new Error(`Cannot use protected schema name "${name}"`);
    }
  }

  private mapRow(row: any): Branch {
    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id,
      parentSchema: row.parent_schema,
      branchSchema: row.branch_schema,
      state: row.state,
      forkPointXid: row.fork_point_xid?.toString() ?? null,
      createdAt: new Date(row.created_at),
      mergedAt: row.merged_at ? new Date(row.merged_at) : null,
      deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
      createdBy: row.created_by,
      metadata: row.metadata ?? {},
    };
  }
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

function hashText(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash;
}
