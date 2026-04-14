import { Pool, PoolClient } from 'pg';

// ─── Branch State Machine ───
export type BranchState = 'active' | 'merged' | 'deleted' | 'conflict';

// ─── Core Entities ───
export interface Branch {
  id: string;
  name: string;
  parentId: string | null;
  parentSchema: string;
  branchSchema: string;
  state: BranchState;
  forkPointXid: string | null;
  createdAt: Date;
  mergedAt: Date | null;
  deletedAt: Date | null;
  createdBy: string | null;
  metadata: Record<string, unknown>;
}

export interface BranchTable {
  id: string;
  branchId: string;
  tableName: string;
  copiedAt: Date;
  rowCountAtFork: number;
  parentChecksum: string | null;
}

export interface BranchLogEntry {
  id: number;
  branchId: string;
  action: string;
  tableName: string | null;
  details: Record<string, unknown>;
  createdAt: Date;
}

// ─── Diff Types ───
export interface DiffResult {
  branchId: string;
  branchName: string;
  tables: TableDiff[];
  schemaDiffs: SchemaTableDiff[];
  totalInserted: number;
  totalDeleted: number;
  totalUpdated: number;
  tablesModified: number;
  generatedAt: Date;
}

export interface TableDiff {
  tableName: string;
  inserted: number;
  deleted: number;
  updated: number;
  hasChanges: boolean;
}

export interface SchemaTableDiff {
  tableName: string;
  addedColumns: ColumnDef[];
  droppedColumns: string[];
  alteredColumns: ColumnAlteration[];
  hasChanges: boolean;
}

export interface ColumnDef {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
}

export interface ColumnAlteration {
  name: string;
  from: Partial<ColumnDef>;
  to: Partial<ColumnDef>;
}

// ─── Merge Types ───
export interface MergeResult {
  success: boolean;
  branchId: string;
  tablesAffected: string[];
  conflicts: MergeConflict[];
  migrationSql: string;
  appliedAt: Date | null;
}

export interface MergeConflict {
  tableName: string;
  type: 'schema_diverged' | 'concurrent_modification' | 'constraint_violation';
  description: string;
  resolution: 'branch_wins' | 'parent_wins' | 'manual' | null;
}

// ─── Options ───
export interface BranchCreateOptions {
  name: string;
  parentBranch?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

export type MergeStrategy = 'branch_wins' | 'parent_wins' | 'fail_on_conflict';

export interface MergeOptions {
  strategy: MergeStrategy;
  dryRun?: boolean;
  excludeTables?: string[];
}

export interface GCOptions {
  maxAgeDays: number;
  dryRun: boolean;
}

export interface GCReport {
  orphanedSchemas: string[];
  staleBranches: string[];
  cleanedUp: boolean;
}

// ─── Prometheus Factory Options ───
export interface PrometheusOptions {
  schemaPrefix?: string; // default: 'branch_'
}

// ─── Protected Schemas ───
export const PROTECTED_SCHEMAS = [
  'auth',
  'system',
  'realtime',
  'schedules',
  'pg_catalog',
  'information_schema',
  'pg_toast',
] as const;

export type ProtectedSchema = (typeof PROTECTED_SCHEMAS)[number];
