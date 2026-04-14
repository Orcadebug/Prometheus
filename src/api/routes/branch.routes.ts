import { Router, Request, Response } from 'express';
import { BranchManager } from '../../core/branch-manager';
import { MergeStrategy } from '../../types/branch.types';

export function createBranchRouter(branchManager: BranchManager): Router {
  const router = Router();

  // ─── Create Branch ───
  router.post('/branches', async (req: Request, res: Response) => {
    try {
      const { name, parentBranch, createdBy, metadata } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      const branch = await branchManager.create({ name, parentBranch, createdBy, metadata });
      res.status(201).json(branch);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── List Branches ───
  router.get('/branches', async (req: Request, res: Response) => {
    try {
      const state = req.query.state as any;
      const branches = await branchManager.list(state);
      res.json({ branches, count: branches.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Get Branch ───
  router.get('/branches/:id', async (req: Request, res: Response) => {
    try {
      const branch = await branchManager.resolve(req.params.id);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
      res.json(branch);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Delete Branch ───
  router.delete('/branches/:id', async (req: Request, res: Response) => {
    try {
      const branch = await branchManager.resolve(req.params.id);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
      await branchManager.delete(branch.id);
      res.json({ deleted: true, id: branch.id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── Diff Branch ───
  router.get('/branches/:id/diff', async (req: Request, res: Response) => {
    try {
      const branch = await branchManager.resolve(req.params.id);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
      const diff = await branchManager.diffBranch(branch.id);
      res.json(diff);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Get Merge SQL (dry run) ───
  router.get('/branches/:id/diff/sql', async (req: Request, res: Response) => {
    try {
      const branch = await branchManager.resolve(req.params.id);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
      const sql = await branchManager.getMergeSql(branch.id);
      res.type('text/sql').send(sql);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Merge Branch ───
  router.post('/branches/:id/merge', async (req: Request, res: Response) => {
    try {
      const branch = await branchManager.resolve(req.params.id);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });

      const strategy: MergeStrategy = req.body.strategy ?? 'fail_on_conflict';
      const dryRun = req.body.dryRun ?? false;
      const excludeTables = req.body.excludeTables;

      const result = await branchManager.mergeBranch(branch.id, {
        strategy,
        dryRun,
        excludeTables,
      });

      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ─── List COW-copied Tables ───
  router.get('/branches/:id/tables', async (req: Request, res: Response) => {
    try {
      const branch = await branchManager.resolve(req.params.id);
      if (!branch) return res.status(404).json({ error: 'Branch not found' });
      const tables = await branchManager.getTables(branch.id);
      res.json({ tables, count: tables.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
