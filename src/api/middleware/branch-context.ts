import { Request, Response, NextFunction } from 'express';
import { BranchManager } from '../../core/branch-manager';
import { CowEngine } from '../../core/cow-engine';
import { Branch } from '../../types/branch.types';

declare global {
  namespace Express {
    interface Request {
      branch?: Branch;
      searchPath?: string;
    }
  }
}

/**
 * Express middleware that sets up branch context.
 *
 * Reads branch from:
 *   - X-Branch-Id header
 *   - X-Branch-Name header
 *   - ?branch= query param
 *
 * For mutating requests (POST/PUT/PATCH/DELETE), triggers COW copy
 * of the target table before the request proceeds.
 */
export function branchContext(branchManager: BranchManager, cowEngine: CowEngine) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const branchRef =
      (req.headers['x-branch-id'] as string) ??
      (req.headers['x-branch-name'] as string) ??
      (req.query.branch as string);

    if (!branchRef) return next();

    try {
      const branch = await branchManager.resolve(branchRef);
      if (!branch) {
        return res.status(404).json({ error: 'Branch not found' });
      }
      if (branch.state !== 'active') {
        return res.status(409).json({ error: `Branch is in "${branch.state}" state` });
      }

      // For mutations, trigger COW copy of target table
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const tableName = extractTableFromPath(req.path);
        if (tableName) {
          await cowEngine.ensureCopied(branch, tableName);
        }
      }

      req.branch = branch;
      req.searchPath = `${branch.branchSchema}, ${branch.parentSchema}`;
      next();
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Branch context error' });
    }
  };
}

/**
 * Extract table name from REST path.
 * Handles patterns like:
 *   /rest/v1/todos → todos
 *   /api/tables/todos/records → todos
 *   /todos → todos
 */
function extractTableFromPath(path: string): string | null {
  // PostgREST style: /rest/v1/<table>
  const restMatch = path.match(/\/rest\/v\d+\/([a-z_][a-z0-9_]*)/i);
  if (restMatch) return restMatch[1];

  // InsForge style: /api/tables/<table>/records
  const apiMatch = path.match(/\/api\/tables\/([a-z_][a-z0-9_]*)\/records/i);
  if (apiMatch) return apiMatch[1];

  // Direct: /<table>
  const directMatch = path.match(/^\/([a-z_][a-z0-9_]*)$/i);
  if (directMatch) return directMatch[1];

  return null;
}
