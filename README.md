# Prometheus

**Near-zero-cost instant metadata branching for Postgres databases.**

Prometheus enables AI agents to safely fork a production database, test schema migrations or new features in isolation, and merge changes back — all without copying data upfront.

Built for [InsForge](https://insforge.dev) | [GitHub](https://github.com/InsForge/insforge)

## How It Works

```
Branch = Postgres schema + metadata row
├── CREATE: O(1) — just CREATE SCHEMA + INSERT metadata
├── READ:   search_path falls through to parent for unmodified tables
├── WRITE:  copy-on-write — table copied to branch on first mutation
├── DIFF:   PK-based comparison of branch vs parent
└── MERGE:  generates migration SQL, applies to parent
```

**Cost model**: Storage = base + sum(diverged tables only). 10 branches of a 10GB database with 5% changes each = 10.5GB total, not 100GB.

## Quick Start

```bash
npm install @prometheus/db-branching
```

```typescript
import { createPrometheus } from '@prometheus/db-branching';
import express from 'express';

const app = express();
const prometheus = createPrometheus({
  connectionString: process.env.DATABASE_URL,
});

// Run migrations (once, on startup)
await prometheus.runMigrations();

// Branch-aware middleware (reads X-Branch-Id header)
app.use(prometheus.middleware);

// REST API for branch management
app.use('/api', prometheus.router);
```

## Core Concepts

### Branch Lifecycle

```
create ──> active ──> merged
                 └──> deleted
```

1. **Create** — Instant. Only creates an empty Postgres schema and a metadata row. Zero data copied.
2. **Work** — Reads fall through to parent via `search_path`. On first write to a table, copy-on-write kicks in: the table is fully copied into the branch schema, then the write proceeds against the branch copy.
3. **Diff** — Compares each COW-copied table against its parent using primary key joins. Detects inserts, deletes, updates, and schema changes (added/dropped/altered columns).
4. **Merge** — Generates migration SQL from the diff. Supports dry-run mode. Detects conflicts when the parent schema has drifted since branch creation (via DDL checksum).
5. **Delete** — `DROP SCHEMA CASCADE` + metadata cleanup. Garbage collector handles orphans.

### Copy-on-Write (COW)

Tables are only copied when a mutation targets them. The COW engine:
- Acquires a Postgres advisory lock (`pg_advisory_xact_lock`) to prevent double-copy under concurrency
- Uses double-check pattern: check metadata, acquire lock, check again, then copy
- Copies structure via `CREATE TABLE ... (LIKE ... INCLUDING ALL)` + data via `INSERT ... SELECT`
- Resets sequences to `max(pk) + 1` to avoid collisions on merge
- Sends `NOTIFY pgrst` to refresh PostgREST schema cache

### Merge Strategies

| Strategy | Behavior |
|----------|----------|
| `fail_on_conflict` | Aborts if parent schema drifted since branch creation |
| `branch_wins` | Branch changes overwrite parent for conflicting rows |
| `parent_wins` | Only branch inserts and branch-only schema changes applied |

### Protected Schemas

Prometheus never reads from or writes to: `auth`, `system` (except its own `prometheus_*` tables), `realtime`, `schedules`, `pg_catalog`, `information_schema`.

## API Reference

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/branches` | Create a branch |
| `GET` | `/branches` | List all branches |
| `GET` | `/branches/:id` | Get branch details |
| `DELETE` | `/branches/:id` | Delete a branch |
| `GET` | `/branches/:id/diff` | Diff branch vs parent |
| `GET` | `/branches/:id/diff/sql` | Preview merge migration SQL |
| `POST` | `/branches/:id/merge` | Merge branch into parent |
| `GET` | `/branches/:id/tables` | List COW-copied tables |

#### Examples

```bash
# Create a branch
curl -X POST http://localhost:3000/api/branches \
  -H "Content-Type: application/json" \
  -d '{"name": "feature-avatars", "createdBy": "agent-123"}'

# Query using branch context (reads/writes isolated)
curl http://localhost:3000/rest/v1/users \
  -H "X-Branch-Name: feature-avatars"

# Diff
curl http://localhost:3000/api/branches/feature-avatars/diff

# Preview merge SQL (dry run)
curl -X POST http://localhost:3000/api/branches/feature-avatars/merge \
  -H "Content-Type: application/json" \
  -d '{"strategy": "fail_on_conflict", "dryRun": true}'

# Merge for real
curl -X POST http://localhost:3000/api/branches/feature-avatars/merge \
  -H "Content-Type: application/json" \
  -d '{"strategy": "branch_wins", "dryRun": false}'
```

### MCP Tools (for AI Agents)

Prometheus ships MCP tool definitions for seamless AI agent integration:

| Tool | Description |
|------|-------------|
| `create_db_branch` | Create isolated branch (instant, near-zero cost) |
| `list_db_branches` | List all branches with status |
| `switch_db_branch` | Switch active branch context |
| `diff_db_branch` | Show changes vs parent (inserts/updates/deletes/schema) |
| `merge_db_branch` | Merge back with dry-run support and conflict detection |
| `delete_db_branch` | Delete branch and drop schema |
| `get_db_branch_tables` | List COW-copied tables in a branch |

### Programmatic API

```typescript
const prometheus = createPrometheus({
  connectionString: process.env.DATABASE_URL,
});

// Create branch — instant, O(1)
const branch = await prometheus.branchManager.create({
  name: 'feature-avatars',
  createdBy: 'agent-123',
});

// Branch from another branch (nested)
const child = await prometheus.branchManager.create({
  name: 'sub-feature',
  parentBranch: 'feature-avatars',
});

// Diff — see what changed
const diff = await prometheus.branchManager.diffBranch(branch.id);
// → { tables: [{ tableName: 'users', inserted: 2, deleted: 0, updated: 1 }], ... }

// Preview merge SQL
const sql = await prometheus.branchManager.getMergeSql(branch.id);

// Merge (dry run)
const preview = await prometheus.branchManager.mergeBranch(branch.id, {
  strategy: 'fail_on_conflict',
  dryRun: true,
});

// Merge (apply)
const result = await prometheus.branchManager.mergeBranch(branch.id, {
  strategy: 'branch_wins',
  dryRun: false,
});

// Garbage collection
await prometheus.gc.collect({ maxAgeDays: 7, dryRun: false });

// Cleanup
await prometheus.close();
```

## Architecture

```
src/
  types/branch.types.ts          — TypeScript interfaces
  db/
    connection.ts                — Pool wrapper + withBranchContext()
    migrations/
      001_create_branch_tables.sql  — Metadata tables
      002_create_helper_functions.sql — COW + diff SQL functions
  core/
    branch-manager.ts            — Branch lifecycle orchestrator
    cow-engine.ts                — Copy-on-write with advisory locks
    diff-engine.ts               — Schema + data diffing
    merge-engine.ts              — Conflict detection + merge
    gc.ts                        — Garbage collection
  api/
    routes/branch.routes.ts      — REST endpoints
    middleware/branch-context.ts  — Express middleware (search_path + COW)
  mcp/branch-tools.ts            — MCP tool definitions
  index.ts                       — Entry point + createPrometheus() factory
```

### Key Design Decisions

| Decision | Why |
|----------|-----|
| Schema-based isolation (not row tagging) | True SQL isolation, works with PostgREST, no query rewriting |
| Lazy COW (not eager copy) | Branch creation is O(1), pay only for what you modify |
| Advisory locks (not row locks) | Prevent double-copy without blocking reads |
| Middleware COW (not trigger COW) | Reliable interception before DML executes |
| `search_path` read-through (not views) | Zero setup per table, automatic for new parent tables |
| MD5 checksum for drift detection | Simple, fast, catches any parent DDL change since fork |

## Testing

26 integration tests covering all core functionality. Requires a local Postgres instance.

```bash
# Create test database
createdb prometheus_test

# Run tests
npm test
```

### Test Coverage

| Category | Tests | Verified |
|----------|-------|----------|
| Branch Creation | 4 | O(1) cost, deduplication, name validation, protected schemas |
| Listing/Resolution | 4 | List, resolve by name/ID, state filtering |
| Copy-on-Write | 3 | Lazy copy, idempotency, missing table error |
| Read-Through | 2 | Parent data visible, branch mutations isolated |
| Diff Engine | 5 | Clean diff, inserts, deletes, updates, schema changes |
| Migration SQL | 1 | Valid SQL generation with ALTER + INSERT |
| Merge | 2 | Dry-run safety, real merge applies to parent |
| Deletion | 1 | Schema dropped, state updated |
| Nested Branches | 1 | Child reads parent branch via search_path chain |
| Garbage Collection | 1 | Detects orphaned schemas |
| Audit Log | 1 | Logs create + cow_copy actions |
| Connection Hygiene | 1 | search_path reset after context exit |

## Built for InsForge

Prometheus integrates with [InsForge](https://insforge.dev)'s Postgres + PostgREST architecture:

- **Middleware** intercepts requests, sets `search_path`, triggers COW transparently
- **Protected schemas** respects InsForge's `auth`, `system`, `realtime`, `schedules` boundaries
- **PostgREST compatible** — sends `NOTIFY pgrst` after schema changes
- **MCP tools** enable AI agents (Claude Code, Cursor, Copilot) to branch/diff/merge via natural language

## Requirements

- PostgreSQL 14+
- Node.js 18+
- `pg` and `express` as peer dependencies

## License

MIT
