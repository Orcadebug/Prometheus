import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { ConnectionManager } from '../src/db/connection';
import { CowEngine } from '../src/core/cow-engine';
import { DiffEngine } from '../src/core/diff-engine';
import { MergeEngine } from '../src/core/merge-engine';
import { BranchManager } from '../src/core/branch-manager';
import { GarbageCollector } from '../src/core/gc';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL = 'postgresql://localhost:5432/prometheus_test';

let conn: ConnectionManager;
let cow: CowEngine;
let diff: DiffEngine;
let merge: MergeEngine;
let branchManager: BranchManager;
let gc: GarbageCollector;
let pool: Pool;

async function runMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'src', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
  }
}

async function cleanupAll() {
  // Drop all branch schemas
  const schemas = await pool.query(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'branch_%'`
  );
  for (const { nspname } of schemas.rows) {
    await pool.query(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
  }
  // Clear metadata tables
  await pool.query('DELETE FROM system.prometheus_branch_log').catch(() => {});
  await pool.query('DELETE FROM system.prometheus_branch_tables').catch(() => {});
  await pool.query('DELETE FROM system.prometheus_branches').catch(() => {});
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  conn = new ConnectionManager({ connectionString: DATABASE_URL });
  cow = new CowEngine(conn);
  diff = new DiffEngine(conn);
  merge = new MergeEngine(conn, diff);
  branchManager = new BranchManager(conn, cow, diff, merge);
  gc = new GarbageCollector(conn);

  // Run migrations
  await runMigrations();

  // Create test tables in public schema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS public.posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES public.users(id),
      title TEXT NOT NULL,
      body TEXT,
      published BOOLEAN DEFAULT false
    );
  `);

  // Seed test data
  await pool.query(`
    INSERT INTO public.users (name, email) VALUES
      ('Alice', 'alice@test.com'),
      ('Bob', 'bob@test.com'),
      ('Charlie', 'charlie@test.com')
    ON CONFLICT DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO public.posts (user_id, title, body, published) VALUES
      (1, 'First Post', 'Hello world', true),
      (2, 'Second Post', 'Testing', false)
    ON CONFLICT DO NOTHING;
  `);
});

afterAll(async () => {
  await cleanupAll();
  await pool.query('DROP TABLE IF EXISTS public.posts CASCADE');
  await pool.query('DROP TABLE IF EXISTS public.users CASCADE');
  await conn.close();
  await pool.end();
});

beforeEach(async () => {
  await cleanupAll();
});

// ═══════════════════════════════════════════════
// TEST 1: Branch Creation
// ═══════════════════════════════════════════════
describe('Branch Creation', () => {
  it('should create a branch with O(1) cost', async () => {
    const branch = await branchManager.create({
      name: 'feature-test',
      createdBy: 'test-agent',
    });

    expect(branch.name).toBe('feature-test');
    expect(branch.branchSchema).toBe('branch_feature_test');
    expect(branch.parentSchema).toBe('public');
    expect(branch.state).toBe('active');
    expect(branch.createdBy).toBe('test-agent');

    // Verify schema was created
    const schemaExists = await pool.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
      ['branch_feature_test']
    );
    expect(schemaExists.rows.length).toBe(1);

    // Verify NO tables were copied (O(1) creation)
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      ['branch_feature_test']
    );
    expect(tables.rows.length).toBe(0);
  });

  it('should reject duplicate branch names', async () => {
    await branchManager.create({ name: 'dup-test' });
    await expect(branchManager.create({ name: 'dup-test' })).rejects.toThrow('already exists');
  });

  it('should reject invalid branch names', async () => {
    // Names starting with digits are invalid
    await expect(branchManager.create({ name: '123-start' })).rejects.toThrow();
    // Special characters are invalid
    await expect(branchManager.create({ name: 'has spaces' })).rejects.toThrow();
    await expect(branchManager.create({ name: 'has@symbol' })).rejects.toThrow();
  });

  it('should reject protected schema names', async () => {
    await expect(branchManager.create({ name: 'auth' })).rejects.toThrow('protected');
    await expect(branchManager.create({ name: 'system' })).rejects.toThrow('protected');
  });
});

// ═══════════════════════════════════════════════
// TEST 2: Branch Listing & Resolution
// ═══════════════════════════════════════════════
describe('Branch Listing', () => {
  it('should list branches', async () => {
    await branchManager.create({ name: 'branch-a' });
    await branchManager.create({ name: 'branch-b' });

    const all = await branchManager.list();
    expect(all.length).toBe(2);
  });

  it('should resolve by name', async () => {
    const created = await branchManager.create({ name: 'resolve-test' });
    const resolved = await branchManager.resolve('resolve-test');
    expect(resolved?.id).toBe(created.id);
  });

  it('should resolve by id', async () => {
    const created = await branchManager.create({ name: 'resolve-id-test' });
    const resolved = await branchManager.resolve(created.id);
    expect(resolved?.id).toBe(created.id);
  });

  it('should filter by state', async () => {
    await branchManager.create({ name: 'active-branch' });
    const active = await branchManager.list('active');
    expect(active.length).toBe(1);
    const deleted = await branchManager.list('deleted');
    expect(deleted.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════
// TEST 3: Copy-on-Write
// ═══════════════════════════════════════════════
describe('Copy-on-Write', () => {
  it('should COW-copy table on ensureCopied', async () => {
    const branch = await branchManager.create({ name: 'cow-test' });

    // Before COW: no tables in branch schema
    const before = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [branch.branchSchema]
    );
    expect(before.rows.length).toBe(0);

    // Trigger COW
    const copied = await cow.ensureCopied(branch, 'users');
    expect(copied).toBe(true);

    // After COW: users table exists in branch schema
    const after = await pool.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [branch.branchSchema]
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].table_name).toBe('users');

    // Data was copied
    const branchData = await pool.query(
      `SELECT count(*) as cnt FROM "${branch.branchSchema}".users`
    );
    expect(Number(branchData.rows[0].cnt)).toBe(3); // Alice, Bob, Charlie

    // Metadata tracked
    const tracked = await cow.getCopiedTables(branch.id);
    expect(tracked.length).toBe(1);
    expect(tracked[0].tableName).toBe('users');
  });

  it('should no-op on second ensureCopied', async () => {
    const branch = await branchManager.create({ name: 'cow-noop' });
    await cow.ensureCopied(branch, 'users');
    const secondCopy = await cow.ensureCopied(branch, 'users');
    expect(secondCopy).toBe(false); // Already copied
  });

  it('should error on nonexistent table', async () => {
    const branch = await branchManager.create({ name: 'cow-missing' });
    await expect(cow.ensureCopied(branch, 'nonexistent')).rejects.toThrow('not found');
  });
});

// ═══════════════════════════════════════════════
// TEST 4: Read-Through via search_path
// ═══════════════════════════════════════════════
describe('Read-Through', () => {
  it('should read parent tables through search_path', async () => {
    const branch = await branchManager.create({ name: 'read-through' });

    // Query users via branch context (NOT cow-copied yet)
    const result = await conn.withBranchContext(
      branch.branchSchema,
      branch.parentSchema,
      async (client) => {
        const res = await client.query('SELECT count(*) as cnt FROM users');
        return res.rows[0];
      }
    );

    // Should see parent data (3 users)
    expect(Number(result.cnt)).toBe(3);
  });

  it('should read branch-modified data after COW + mutation', async () => {
    const branch = await branchManager.create({ name: 'read-modified' });

    // COW copy users
    await cow.ensureCopied(branch, 'users');

    // Insert into branch copy
    await conn.withBranchContext(
      branch.branchSchema,
      branch.parentSchema,
      async (client) => {
        await client.query(`INSERT INTO users (name, email) VALUES ('Dave', 'dave@test.com')`);
      }
    );

    // Branch should see 4 users
    const branchCount = await conn.withBranchContext(
      branch.branchSchema,
      branch.parentSchema,
      async (client) => {
        const res = await client.query('SELECT count(*) as cnt FROM users');
        return Number(res.rows[0].cnt);
      }
    );
    expect(branchCount).toBe(4);

    // Parent should still see 3 users
    const parentCount = await pool.query('SELECT count(*) as cnt FROM public.users');
    expect(Number(parentCount.rows[0].cnt)).toBe(3);
  });
});

// ═══════════════════════════════════════════════
// TEST 5: Diff Engine
// ═══════════════════════════════════════════════
describe('Diff Engine', () => {
  it('should detect no changes on fresh COW copy', async () => {
    const branch = await branchManager.create({ name: 'diff-clean' });
    await cow.ensureCopied(branch, 'users');

    const result = await branchManager.diffBranch(branch.id);
    expect(result.tablesModified).toBe(0);
    expect(result.totalInserted).toBe(0);
    expect(result.totalDeleted).toBe(0);
    expect(result.totalUpdated).toBe(0);
  });

  it('should detect inserts', async () => {
    const branch = await branchManager.create({ name: 'diff-insert' });
    await cow.ensureCopied(branch, 'users');

    // Insert in branch
    await pool.query(
      `INSERT INTO "${branch.branchSchema}".users (name, email) VALUES ('Eve', 'eve@test.com')`
    );

    const result = await branchManager.diffBranch(branch.id);
    expect(result.totalInserted).toBe(1);
    expect(result.tables[0].inserted).toBe(1);
  });

  it('should detect deletes', async () => {
    const branch = await branchManager.create({ name: 'diff-delete' });
    await cow.ensureCopied(branch, 'users');

    // Delete from branch
    await pool.query(
      `DELETE FROM "${branch.branchSchema}".users WHERE email = 'charlie@test.com'`
    );

    const result = await branchManager.diffBranch(branch.id);
    expect(result.totalDeleted).toBe(1);
  });

  it('should detect updates', async () => {
    const branch = await branchManager.create({ name: 'diff-update' });
    await cow.ensureCopied(branch, 'users');

    // Update in branch
    await pool.query(
      `UPDATE "${branch.branchSchema}".users SET name = 'Alice Updated' WHERE email = 'alice@test.com'`
    );

    const result = await branchManager.diffBranch(branch.id);
    expect(result.totalUpdated).toBe(1);
  });

  it('should detect schema changes (added column)', async () => {
    const branch = await branchManager.create({ name: 'diff-schema' });
    await cow.ensureCopied(branch, 'users');

    // Add column in branch
    await pool.query(
      `ALTER TABLE "${branch.branchSchema}".users ADD COLUMN avatar_url TEXT`
    );

    const result = await branchManager.diffBranch(branch.id);
    const schemaDiff = result.schemaDiffs.find(s => s.tableName === 'users');
    expect(schemaDiff?.addedColumns.length).toBe(1);
    expect(schemaDiff?.addedColumns[0].name).toBe('avatar_url');
  });
});

// ═══════════════════════════════════════════════
// TEST 6: Migration SQL Generation
// ═══════════════════════════════════════════════
describe('Migration SQL', () => {
  it('should generate valid migration SQL', async () => {
    const branch = await branchManager.create({ name: 'migration-sql' });
    await cow.ensureCopied(branch, 'users');

    // Make changes
    await pool.query(
      `INSERT INTO "${branch.branchSchema}".users (name, email) VALUES ('Frank', 'frank@test.com')`
    );
    await pool.query(
      `ALTER TABLE "${branch.branchSchema}".users ADD COLUMN bio TEXT`
    );

    const sql = await branchManager.getMergeSql(branch.id);
    expect(sql).toContain('BEGIN');
    expect(sql).toContain('COMMIT');
    expect(sql).toContain('ADD COLUMN');
    expect(sql).toContain('INSERT INTO');
  });
});

// ═══════════════════════════════════════════════
// TEST 7: Merge
// ═══════════════════════════════════════════════
describe('Merge', () => {
  it('should dry-run merge without applying', async () => {
    const branch = await branchManager.create({ name: 'merge-dry' });
    await cow.ensureCopied(branch, 'users');
    await pool.query(
      `INSERT INTO "${branch.branchSchema}".users (name, email) VALUES ('Grace', 'grace@test.com')`
    );

    const result = await branchManager.mergeBranch(branch.id, {
      strategy: 'fail_on_conflict',
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.appliedAt).toBeNull();
    expect(result.migrationSql).toContain('INSERT');

    // Parent should NOT have the new user
    const parentCount = await pool.query('SELECT count(*) as cnt FROM public.users');
    expect(Number(parentCount.rows[0].cnt)).toBe(3);
  });

  it('should merge branch into parent', async () => {
    const branch = await branchManager.create({ name: 'merge-real' });
    await cow.ensureCopied(branch, 'users');

    // Insert in branch
    await pool.query(
      `INSERT INTO "${branch.branchSchema}".users (name, email) VALUES ('Hank', 'hank@test.com')`
    );

    // Merge
    const result = await branchManager.mergeBranch(branch.id, {
      strategy: 'branch_wins',
      dryRun: false,
    });

    expect(result.success).toBe(true);
    expect(result.appliedAt).not.toBeNull();

    // Parent should now have 4 users
    const parentCount = await pool.query('SELECT count(*) as cnt FROM public.users');
    expect(Number(parentCount.rows[0].cnt)).toBe(4);

    // Branch state should be 'merged'
    const mergedBranch = await branchManager.get(branch.id);
    expect(mergedBranch?.state).toBe('merged');

    // Clean up the inserted user for other tests
    await pool.query(`DELETE FROM public.users WHERE email = 'hank@test.com'`);
  });
});

// ═══════════════════════════════════════════════
// TEST 8: Branch Deletion
// ═══════════════════════════════════════════════
describe('Branch Deletion', () => {
  it('should delete branch and drop schema', async () => {
    const branch = await branchManager.create({ name: 'delete-test' });
    await cow.ensureCopied(branch, 'users');

    await branchManager.delete(branch.id);

    // Schema should be gone
    const schemaExists = await pool.query(
      `SELECT 1 FROM pg_namespace WHERE nspname = $1`,
      [branch.branchSchema]
    );
    expect(schemaExists.rows.length).toBe(0);

    // Branch state should be 'deleted'
    const deleted = await branchManager.get(branch.id);
    expect(deleted?.state).toBe('deleted');

    // Should not resolve anymore
    const resolved = await branchManager.resolve('delete-test');
    expect(resolved).toBeNull();
  });
});

// ═══════════════════════════════════════════════
// TEST 9: Nested Branches (branch from branch)
// ═══════════════════════════════════════════════
describe('Nested Branches', () => {
  it('should create branch from another branch', async () => {
    const parent = await branchManager.create({ name: 'parent-branch' });
    await cow.ensureCopied(parent, 'users');

    // Modify parent branch
    await pool.query(
      `INSERT INTO "${parent.branchSchema}".users (name, email) VALUES ('Ivy', 'ivy@test.com')`
    );

    // Create child branch from parent
    const child = await branchManager.create({
      name: 'child-branch',
      parentBranch: 'parent-branch',
    });

    expect(child.parentId).toBe(parent.id);
    expect(child.parentSchema).toBe(parent.branchSchema);

    // Child should see parent branch's data via read-through
    const result = await conn.withBranchContext(
      child.branchSchema,
      child.parentSchema,
      async (client) => {
        const res = await client.query('SELECT count(*) as cnt FROM users');
        return Number(res.rows[0].cnt);
      }
    );
    expect(result).toBe(4); // 3 original + 1 from parent branch
  });
});

// ═══════════════════════════════════════════════
// TEST 10: Garbage Collection
// ═══════════════════════════════════════════════
describe('Garbage Collection', () => {
  it('should find orphaned schemas', async () => {
    // Create a schema manually (orphaned — no metadata)
    await pool.query('CREATE SCHEMA IF NOT EXISTS branch_orphan_test');

    const report = await gc.collect({ maxAgeDays: 0, dryRun: true });
    expect(report.orphanedSchemas).toContain('branch_orphan_test');
    expect(report.cleanedUp).toBe(false);

    // Clean up
    await pool.query('DROP SCHEMA IF EXISTS branch_orphan_test CASCADE');
  });
});

// ═══════════════════════════════════════════════
// TEST 11: Audit Log
// ═══════════════════════════════════════════════
describe('Audit Log', () => {
  it('should log branch operations', async () => {
    const branch = await branchManager.create({ name: 'audit-test' });
    await cow.ensureCopied(branch, 'users');

    const logs = await conn.query<any>(
      `SELECT action, table_name FROM system.prometheus_branch_log
       WHERE branch_id = $1 ORDER BY id`,
      [branch.id]
    );

    expect(logs.length).toBe(2);
    expect(logs[0].action).toBe('create');
    expect(logs[1].action).toBe('cow_copy');
    expect(logs[1].table_name).toBe('users');
  });
});

// ═══════════════════════════════════════════════
// TEST 12: Connection Manager
// ═══════════════════════════════════════════════
describe('Connection Manager', () => {
  it('should reset search_path after withBranchContext', async () => {
    const branch = await branchManager.create({ name: 'conn-test' });

    // Use branch context
    await conn.withBranchContext(
      branch.branchSchema,
      branch.parentSchema,
      async (client) => {
        const res = await client.query('SHOW search_path');
        expect(res.rows[0].search_path).toContain('branch_conn_test');
      }
    );

    // After context, pool connections should have default search_path
    const result = await pool.query('SHOW search_path');
    // Default search_path should not contain branch schema
    expect(result.rows[0].search_path).not.toContain('branch_conn_test');
  });
});
