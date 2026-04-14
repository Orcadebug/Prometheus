import { Pool, PoolConfig } from 'pg';
import { ConnectionManager } from './db/connection';
import { BranchManager } from './core/branch-manager';
import { CowEngine } from './core/cow-engine';
import { DiffEngine } from './core/diff-engine';
import { MergeEngine } from './core/merge-engine';
import { GarbageCollector } from './core/gc';
import { branchContext } from './api/middleware/branch-context';
import { createBranchRouter } from './api/routes/branch.routes';
import { branchTools } from './mcp/branch-tools';
import { PrometheusOptions } from './types/branch.types';
import * as fs from 'fs';
import * as path from 'path';

// ─── Re-exports ───
export { BranchManager } from './core/branch-manager';
export { CowEngine } from './core/cow-engine';
export { DiffEngine } from './core/diff-engine';
export { MergeEngine } from './core/merge-engine';
export { GarbageCollector } from './core/gc';
export { branchContext } from './api/middleware/branch-context';
export { createBranchRouter } from './api/routes/branch.routes';
export { branchTools } from './mcp/branch-tools';
export * from './types/branch.types';

export interface Prometheus {
  branchManager: BranchManager;
  cowEngine: CowEngine;
  diffEngine: DiffEngine;
  mergeEngine: MergeEngine;
  gc: GarbageCollector;
  middleware: ReturnType<typeof branchContext>;
  router: ReturnType<typeof createBranchRouter>;
  tools: typeof branchTools;
  runMigrations: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Create a Prometheus instance.
 *
 * @example
 * ```ts
 * import { createPrometheus } from '@prometheus/db-branching';
 * import express from 'express';
 *
 * const app = express();
 * const prometheus = createPrometheus({ connectionString: process.env.DATABASE_URL });
 *
 * // Run migrations (once, on startup)
 * await prometheus.runMigrations();
 *
 * // Mount middleware (sets search_path based on X-Branch-Id header)
 * app.use(prometheus.middleware);
 *
 * // Mount REST API
 * app.use('/api', prometheus.router);
 * ```
 */
export function createPrometheus(
  poolConfig?: PoolConfig,
  options?: PrometheusOptions
): Prometheus {
  const conn = new ConnectionManager(poolConfig);
  const cowEngine = new CowEngine(conn);
  const diffEngine = new DiffEngine(conn);
  const mergeEngine = new MergeEngine(conn, diffEngine);
  const branchManager = new BranchManager(conn, cowEngine, diffEngine, mergeEngine);
  const gc = new GarbageCollector(conn);

  return {
    branchManager,
    cowEngine,
    diffEngine,
    mergeEngine,
    gc,
    middleware: branchContext(branchManager, cowEngine),
    router: createBranchRouter(branchManager),
    tools: branchTools,
    runMigrations: () => runMigrations(conn),
    close: () => conn.close(),
  };
}

/**
 * Run Prometheus SQL migrations.
 */
async function runMigrations(conn: ConnectionManager): Promise<void> {
  const migrationsDir = path.join(__dirname, 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await conn.getPool().query(sql);
  }
}
