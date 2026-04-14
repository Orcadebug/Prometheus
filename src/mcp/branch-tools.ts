/**
 * MCP Tool definitions for AI agent integration.
 * These follow the Model Context Protocol tool schema format.
 */
export const branchTools = [
  {
    name: 'create_db_branch',
    description:
      'Create a new database branch for isolated development. Near-zero cost — only creates a schema and metadata row, no data is copied until the first write (copy-on-write). Use this before testing schema migrations or new features.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Branch name (lowercase alphanumeric, hyphens, underscores)',
        },
        parent: {
          type: 'string',
          description: 'Parent branch name to fork from. Defaults to main (public schema).',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_db_branches',
    description: 'List all database branches with their current status (active, merged, deleted).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        state: {
          type: 'string',
          enum: ['active', 'merged', 'deleted'],
          description: 'Filter by branch state.',
        },
      },
    },
  },
  {
    name: 'switch_db_branch',
    description:
      'Switch the active database branch context. All subsequent queries will read from this branch (with fallthrough to parent for unmodified tables). Writes trigger automatic copy-on-write.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Branch name or ID to switch to.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'diff_db_branch',
    description:
      'Show all changes in a branch compared to its parent. Returns per-table summary of inserts, updates, deletes, and schema changes (added/dropped/altered columns).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Branch name or ID to diff.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'merge_db_branch',
    description:
      'Merge a branch back into its parent schema. Generates migration SQL from the diff and applies it. Supports dry_run mode to preview changes without applying. Detects conflicts when the parent schema has drifted since the branch was created.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Branch name or ID to merge.',
        },
        strategy: {
          type: 'string',
          enum: ['branch_wins', 'parent_wins', 'fail_on_conflict'],
          description:
            'Conflict resolution strategy. "fail_on_conflict" (default) aborts on any conflict. "branch_wins" overwrites parent with branch changes. "parent_wins" only applies inserts and branch-only schema changes.',
          default: 'fail_on_conflict',
        },
        dry_run: {
          type: 'boolean',
          description: 'If true, returns the migration SQL without applying it.',
          default: true,
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'delete_db_branch',
    description:
      'Delete a database branch. Drops the branch schema (CASCADE) and all COW-copied tables. This is irreversible.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Branch name or ID to delete.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_db_branch_tables',
    description:
      'List all tables that have been copy-on-write copied into a branch. Tables not in this list are read-through from the parent schema.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Branch name or ID.',
        },
      },
      required: ['name'],
    },
  },
];
