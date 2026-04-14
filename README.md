# Prometheus

**Near-zero-cost instant metadata branching for Postgres databases.**

Prometheus enables AI agents to safely fork a production database, test schema migrations or new features in isolation, and merge changes back — all without copying data upfront.

## How It Works

```
Branch = Postgres schema + metadata row
├── CREATE: O(1) — just CREATE SCHEMA + INSERT metadata
├── READ:   search_path falls through to parent for unmodified tables
├── WRITE:  copy-on-write — table copied to branch on first mutation
├── DIFF:   PK-based comparison of branch vs parent
└── MERGE:  generates migration SQL, applies to parent
```

**Cost model**: Storage = base + sum(diverged tables only). 10 branches of a 10GB database with 5% changes each ≈ 10.5GB, not 100GB.

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

// Run migrations (once)
await prometheus.runMigrations();

// Branch-aware middleware (reads X-Branch-Id header)
app.use(prometheus.middleware);

// REST API for branch management
app.use('/api', prometheus.router);
```

## API

### REST Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/branches` | Create branch |
| `GET` | `/branches` | List branches |
| `GET` | `/branches/:id` | Get branch details |
| `DELETE` | `/branches/:id` | Delete branch |
| `GET` | `/branches/:id/diff` | Diff vs parent |
| `GET` | `/branches/:id/diff/sql` | Preview merge SQL |
| `POST` | `/branches/:id/merge` | Merge into parent |
| `GET` | `/branches/:id/tables` | List COW-copied tables |

### MCP Tools (for AI Agents)

- `create_db_branch` — Create isolated branch
- `list_db_branches` — List all branches
- `switch_db_branch` — Switch active context
- `diff_db_branch` — Show changes vs parent
- `merge_db_branch` — Merge back (with dry_run)
- `delete_db_branch` — Delete branch
- `get_db_branch_tables` — List COW-copied tables

### Programmatic

```typescript
// Create branch
const branch = await prometheus.branchManager.create({
  name: 'feature-avatars',
  createdBy: 'agent-123',
});

// Diff
const diff = await prometheus.branchManager.diffBranch(branch.id);

// Merge (dry run first)
const preview = await prometheus.branchManager.mergeBranch(branch.id, {
  strategy: 'fail_on_conflict',
  dryRun: true,
});

// Merge for real
const result = await prometheus.branchManager.mergeBranch(branch.id, {
  strategy: 'branch_wins',
  dryRun: false,
});

// Cleanup
await prometheus.gc.collect({ maxAgeDays: 7, dryRun: false });
```

## Architecture

- **Schema-based isolation** — each branch is a Postgres schema (`branch_<name>`)
- **Copy-on-write** — tables copied lazily on first write, using advisory locks for concurrency
- **Read-through** — `search_path` resolves uncopied tables from parent schema
- **Checksum drift detection** — MD5 of parent table DDL at fork time, compared at merge time
- **Protected schemas** — never touches `auth`, `system`, `realtime`, `schedules`

## Built for InsForge

Prometheus integrates with [InsForge](https://insforge.dev)'s Postgres + PostgREST architecture. The branch-context middleware intercepts requests, sets `search_path`, and triggers COW copies transparently.

## License

MIT
