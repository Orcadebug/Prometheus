import { Pool, PoolClient, PoolConfig } from 'pg';

export class ConnectionManager {
  private pool: Pool;

  constructor(config?: PoolConfig) {
    this.pool = new Pool({
      max: 20,
      idleTimeoutMillis: 30_000,
      ...config,
    });
  }

  getPool(): Pool {
    return this.pool;
  }

  async query<T = any>(text: string, params?: any[]): Promise<T[]> {
    const result = await this.pool.query(text, params);
    return result.rows;
  }

  async queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /**
   * Execute callback within a branch context.
   * Sets search_path to branch schema + parent schema, resets on completion.
   */
  async withBranchContext<T>(
    branchSchema: string,
    parentSchema: string,
    fn: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `SET search_path = ${quoteIdent(branchSchema)}, ${quoteIdent(parentSchema)}, public`
      );
      return await fn(client);
    } finally {
      await client.query('RESET search_path').catch(() => {});
      client.release();
    }
  }

  /**
   * Execute callback within a transaction.
   */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function quoteIdent(name: string): string {
  // Simple identifier quoting — escape double quotes
  return '"' + name.replace(/"/g, '""') + '"';
}
