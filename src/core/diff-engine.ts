import { ConnectionManager } from '../db/connection';
import {
  Branch,
  ColumnAlteration,
  ColumnDef,
  DiffResult,
  SchemaTableDiff,
  TableDiff,
} from '../types/branch.types';

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  ordinal_position: number;
}

export class DiffEngine {
  constructor(private conn: ConnectionManager) {}

  /**
   * Full diff: schema changes + data changes for all COW-copied tables.
   */
  async diff(branch: Branch): Promise<DiffResult> {
    const copiedTables = await this.conn.query<{ table_name: string }>(
      `SELECT table_name FROM system.prometheus_branch_tables
       WHERE branch_id = $1 ORDER BY table_name`,
      [branch.id]
    );

    const tables: TableDiff[] = [];
    const schemaDiffs: SchemaTableDiff[] = [];
    let totalInserted = 0;
    let totalDeleted = 0;
    let totalUpdated = 0;

    for (const { table_name } of copiedTables) {
      // Schema diff
      const schemaDiff = await this.diffTableSchema(
        branch.branchSchema,
        branch.parentSchema,
        table_name
      );
      schemaDiffs.push(schemaDiff);

      // Data diff
      const pkColumns = await this.getPrimaryKeyColumns(branch.branchSchema, table_name);
      if (pkColumns.length === 0) {
        // No PK — can only report schema changes, skip data diff
        tables.push({
          tableName: table_name,
          inserted: 0,
          deleted: 0,
          updated: 0,
          hasChanges: schemaDiff.hasChanges,
        });
        continue;
      }

      const dataDiff = await this.conn.queryOne<any>(
        `SELECT * FROM system.prometheus_diff_table($1, $2, $3, $4)`,
        [branch.branchSchema, branch.parentSchema, table_name, pkColumns]
      );

      const diff = dataDiff?.prometheus_diff_table ?? dataDiff;
      const inserted = Number(diff?.inserted ?? 0);
      const deleted = Number(diff?.deleted ?? 0);
      const updated = Number(diff?.updated ?? 0);

      tables.push({
        tableName: table_name,
        inserted,
        deleted,
        updated,
        hasChanges: inserted + deleted + updated > 0 || schemaDiff.hasChanges,
      });

      totalInserted += inserted;
      totalDeleted += deleted;
      totalUpdated += updated;
    }

    return {
      branchId: branch.id,
      branchName: branch.name,
      tables,
      schemaDiffs,
      totalInserted,
      totalDeleted,
      totalUpdated,
      tablesModified: tables.filter((t) => t.hasChanges).length,
      generatedAt: new Date(),
    };
  }

  /**
   * Compare column definitions between branch and parent for a single table.
   */
  async diffTableSchema(
    branchSchema: string,
    parentSchema: string,
    tableName: string
  ): Promise<SchemaTableDiff> {
    const [branchCols, parentCols] = await Promise.all([
      this.getColumns(branchSchema, tableName),
      this.getColumns(parentSchema, tableName),
    ]);

    const branchMap = new Map(branchCols.map((c) => [c.column_name, c]));
    const parentMap = new Map(parentCols.map((c) => [c.column_name, c]));

    const addedColumns: ColumnDef[] = [];
    const droppedColumns: string[] = [];
    const alteredColumns: ColumnAlteration[] = [];

    // Added in branch
    for (const [name, col] of branchMap) {
      if (!parentMap.has(name)) {
        addedColumns.push({
          name: col.column_name,
          dataType: col.data_type,
          isNullable: col.is_nullable === 'YES',
          defaultValue: col.column_default,
        });
      }
    }

    // Dropped from branch
    for (const [name] of parentMap) {
      if (!branchMap.has(name)) {
        droppedColumns.push(name);
      }
    }

    // Altered
    for (const [name, branchCol] of branchMap) {
      const parentCol = parentMap.get(name);
      if (!parentCol) continue;

      const changes: Partial<Record<keyof ColumnDef, { from: any; to: any }>> = {};
      if (branchCol.data_type !== parentCol.data_type) {
        changes.dataType = { from: parentCol.data_type, to: branchCol.data_type };
      }
      if (branchCol.is_nullable !== parentCol.is_nullable) {
        changes.isNullable = {
          from: parentCol.is_nullable === 'YES',
          to: branchCol.is_nullable === 'YES',
        };
      }
      if (branchCol.column_default !== parentCol.column_default) {
        changes.defaultValue = {
          from: parentCol.column_default,
          to: branchCol.column_default,
        };
      }

      if (Object.keys(changes).length > 0) {
        alteredColumns.push({
          name,
          from: {
            dataType: parentCol.data_type,
            isNullable: parentCol.is_nullable === 'YES',
            defaultValue: parentCol.column_default,
          },
          to: {
            dataType: branchCol.data_type,
            isNullable: branchCol.is_nullable === 'YES',
            defaultValue: branchCol.column_default,
          },
        });
      }
    }

    return {
      tableName,
      addedColumns,
      droppedColumns,
      alteredColumns,
      hasChanges: addedColumns.length + droppedColumns.length + alteredColumns.length > 0,
    };
  }

  /**
   * Generate migration SQL to apply branch changes to parent.
   */
  async generateMigrationSql(branch: Branch): Promise<string> {
    const diffResult = await this.diff(branch);
    const lines: string[] = ['-- Prometheus: Migration from branch "' + branch.name + '"', 'BEGIN;', ''];

    for (const schemaDiff of diffResult.schemaDiffs) {
      const tn = quoteIdent(branch.parentSchema) + '.' + quoteIdent(schemaDiff.tableName);

      // Schema changes
      for (const col of schemaDiff.addedColumns) {
        const nullable = col.isNullable ? '' : ' NOT NULL';
        const def = col.defaultValue ? ` DEFAULT ${col.defaultValue}` : '';
        lines.push(`ALTER TABLE ${tn} ADD COLUMN ${quoteIdent(col.name)} ${col.dataType}${nullable}${def};`);
      }
      for (const col of schemaDiff.droppedColumns) {
        lines.push(`ALTER TABLE ${tn} DROP COLUMN ${quoteIdent(col)};`);
      }
      for (const alt of schemaDiff.alteredColumns) {
        if (alt.to.dataType && alt.to.dataType !== alt.from.dataType) {
          lines.push(
            `ALTER TABLE ${tn} ALTER COLUMN ${quoteIdent(alt.name)} TYPE ${alt.to.dataType};`
          );
        }
        if (alt.to.isNullable !== undefined && alt.to.isNullable !== alt.from.isNullable) {
          lines.push(
            `ALTER TABLE ${tn} ALTER COLUMN ${quoteIdent(alt.name)} ${alt.to.isNullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`
          );
        }
      }
    }

    // Data changes
    for (const tableDiff of diffResult.tables) {
      if (!tableDiff.hasChanges) continue;

      const pkCols = await this.getPrimaryKeyColumns(branch.branchSchema, tableDiff.tableName);
      if (pkCols.length === 0) continue;

      const bTable = quoteIdent(branch.branchSchema) + '.' + quoteIdent(tableDiff.tableName);
      const pTable = quoteIdent(branch.parentSchema) + '.' + quoteIdent(tableDiff.tableName);
      const pkJoin = pkCols.map((c) => `b.${quoteIdent(c)} = p.${quoteIdent(c)}`).join(' AND ');
      const pkWhere = pkCols.map((c) => `p.${quoteIdent(c)} IS NULL`).join(' AND ');

      if (tableDiff.inserted > 0) {
        lines.push(`-- Inserts for ${tableDiff.tableName}`);
        lines.push(
          `INSERT INTO ${pTable} SELECT b.* FROM ${bTable} b LEFT JOIN ${pTable} p ON ${pkJoin} WHERE ${pkWhere};`
        );
      }

      if (tableDiff.deleted > 0) {
        lines.push(`-- Deletes for ${tableDiff.tableName}`);
        const pkWhereB = pkCols.map((c) => `b.${quoteIdent(c)} IS NULL`).join(' AND ');
        lines.push(
          `DELETE FROM ${pTable} p USING (SELECT * FROM ${pTable}) AS existing WHERE NOT EXISTS (SELECT 1 FROM ${bTable} b WHERE ${pkJoin});`
        );
      }

      if (tableDiff.updated > 0) {
        lines.push(`-- Updates for ${tableDiff.tableName}`);
        const allCols = await this.getColumns(branch.branchSchema, tableDiff.tableName);
        const nonPkCols = allCols
          .filter((c) => !pkCols.includes(c.column_name))
          .map((c) => c.column_name);
        const setClauses = nonPkCols
          .map((c) => `${quoteIdent(c)} = b.${quoteIdent(c)}`)
          .join(', ');

        if (setClauses) {
          lines.push(
            `UPDATE ${pTable} p SET ${setClauses} FROM ${bTable} b WHERE ${pkJoin} AND b::text IS DISTINCT FROM p::text;`
          );
        }
      }
    }

    lines.push('', 'COMMIT;');
    return lines.join('\n');
  }

  /**
   * Get primary key columns for a table.
   */
  async getPrimaryKeyColumns(schema: string, tableName: string): Promise<string[]> {
    const rows = await this.conn.query<{ attname: string }>(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relname = $2
         AND i.indisprimary
       ORDER BY a.attnum`,
      [schema, tableName]
    );
    return rows.map((r) => r.attname);
  }

  private async getColumns(schema: string, tableName: string): Promise<ColumnInfo[]> {
    return this.conn.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable, column_default, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2
       ORDER BY ordinal_position`,
      [schema, tableName]
    );
  }
}

function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
