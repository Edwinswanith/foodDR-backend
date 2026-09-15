/**
 * Generic Prisma-backed CRUD/query helper — full port of the real platform's
 * commonService.ts (every table access in this checkout goes through a
 * table-name string rather than a dedicated repository per model, matching
 * that convention). Ported deliberately, not copied blind — two real fixes
 * applied along the way, both noted inline where they apply:
 *
 *  - `executeRawQuery`: the original built SQL by string-substituting
 *    `@param` placeholders with quoted values before calling
 *    `$queryRawUnsafe` — a SQL-injection-shaped pattern. This version keeps
 *    the exact same calling contract (query text with `@paramName`
 *    placeholders + a params object) but binds values as real parameters
 *    instead of splicing them into the query text.
 *  - Postgres branch (`client: 'postgres'`): `prismaPostgres` in this
 *    checkout is an inert stub (`{ $disconnect() {} }` — no real Postgres
 *    schema exists here, see config/postgresClient.ts). Calling any
 *    Postgres-routed method now throws a clear, honest AppError instead of
 *    a confusing "X.create is not a function" runtime crash.
 *
 * `getFcmTokens` is genuinely functional against this checkout's real DB —
 * "MySQL" is a misleading legacy name, it actually connects to the same SQL
 * Server datasource Prisma points at (see config/mysqlConnection.ts).
 */
import prisma from "../../config/sqlServerClient";
import prismaPostgres from "../../config/postgresClient";
import { connectToMySQLDatabase } from "../../config/mysqlConnection";
import AppError from "../core/error-handler";

// Table names are accepted in any casing (existing callers pass PascalCase,
// e.g. auth.ts's `commonService.getFromTable('Roles', ...)`) and coerced to
// the lowercase-first Prisma client property name.
function modelKeyFor(tableName: string): string {
  return tableName.charAt(0).toLowerCase() + tableName.slice(1);
}

class CommonService {
  private getClient(client?: "postgres" | "sqlserver") {
    if (client === "postgres") {
      throw new AppError(
        "Postgres is not configured in this checkout (no prisma-postgres schema present) — see config/postgresClient.ts.",
        [],
        503,
      );
    }
    return prisma; // default = sqlserver, the only real client here
  }

  private modelFor(tableName: string, client?: "postgres" | "sqlserver"): any {
    const key = modelKeyFor(tableName);
    const model = (this.getClient(client) as any)[key];
    if (!model) {
      throw new Error(`commonService: no Prisma model found for table "${tableName}" (looked up as "${key}")`);
    }
    return model;
  }

  async getFromTable(tableName: string, where: Record<string, any> = {}, options: Record<string, any> = {}, client?: "postgres" | "sqlserver") {
    try {
      return await this.modelFor(tableName, client).findFirst({ where, ...options });
    } catch (error) {
      console.error(`Get failed for model "${tableName}":`, error);
      throw new AppError(`Get failed for model "${tableName}":`, "", 400);
    }
  }

  async getManyFromTable(tableName: string, where: Record<string, any> = {}, options: Record<string, any> = {}, client?: "postgres" | "sqlserver") {
    try {
      return await this.modelFor(tableName, client).findMany({ where, ...options });
    } catch (error) {
      console.error(`GetMany failed for model "${tableName}":`, error);
      throw new AppError(`GetMany failed for model "${tableName}":`, "", 400);
    }
  }

  async insertIntoTable(tableName: string, data: Record<string, any>, client?: "postgres" | "sqlserver") {
    try {
      return await this.modelFor(tableName, client).create({ data });
    } catch (error) {
      console.error(`Insert failed for model "${tableName}":`, error);
      throw new AppError(`Insert failed for model "${tableName}":`, "", 400);
    }
  }

  async insertManyIntoTable(tableName: string, data: Record<string, any>[], client?: "postgres" | "sqlserver") {
    try {
      return await this.modelFor(tableName, client).createMany({ data });
    } catch (error) {
      console.error(`Bulk insert failed for model "${tableName}":`, error);
      throw new AppError(`Bulk insert failed for model "${tableName}":`, "", 400);
    }
  }

  async updateTable(tableName: string, where: Record<string, any>, data: Record<string, any>) {
    try {
      return await this.modelFor(tableName).update({ where, data });
    } catch (error) {
      console.error(`Update failed for model "${tableName}":`, error);
      throw new AppError(`Update failed for model "${tableName}":`, "", 400);
    }
  }

  async updateById(tableName: string, id: number, data: Record<string, any>) {
    try {
      return await this.modelFor(tableName).update({ where: { id }, data });
    } catch (error) {
      console.error(`Update by ID failed for model "${tableName}" with id ${id}:`, error);
      throw new AppError(`Update by ID failed for model "${tableName}" with id ${id}`, "", 400);
    }
  }

  async updateManyInTable(tableName: string, where: Record<string, any>, data: Record<string, any>) {
    try {
      return await this.modelFor(tableName).updateMany({ where, data });
    } catch (error) {
      console.error(`UpdateMany failed for model "${tableName}":`, error);
      throw new AppError(`UpdateMany failed for model "${tableName}":`, "", 400);
    }
  }

  async deleteFromTable(tableName: string, where: Record<string, any>, soft: boolean = true) {
    try {
      if (soft) {
        return await this.modelFor(tableName).updateMany({ where, data: { is_deleted: true } });
      }
      return await this.modelFor(tableName).deleteMany({ where });
    } catch (error) {
      console.error(`Delete failed for model "${tableName}":`, error);
      throw new AppError(`Delete failed for model "${tableName}":`, "", 400);
    }
  }

  async countInTable(tableName: string, where: Record<string, any> = {}) {
    try {
      return await this.modelFor(tableName).count({ where });
    } catch (error) {
      console.error(`Count failed for model "${tableName}":`, error);
      throw new AppError(`Count failed for model "${tableName}":`, "", 400);
    }
  }

  async getTotalFromTable(tableName: string, where: Record<string, any> = {}) {
    try {
      return await this.modelFor(tableName).count({ where });
    } catch (error) {
      console.error(`Get total failed for model "${tableName}":`, error);
      throw new AppError(`Get total failed for model "${tableName}":`, "", 400);
    }
  }

  async paginateFromTable(tableName: string, where: Record<string, any> = {}, skip = 0, take = 10, orderBy: Record<string, any> = { id: "desc" }) {
    try {
      return await this.modelFor(tableName).findMany({ where, skip, take, orderBy });
    } catch (error) {
      console.error(`Paginate failed for model "${tableName}":`, error);
      throw new AppError(`Paginate failed for model "${tableName}":`, "", 400);
    }
  }

  async findOneInTable(tableName: string, where: Record<string, any>, include?: Record<string, any>) {
    try {
      return await this.modelFor(tableName).findUnique({ where, include });
    } catch (error) {
      console.error(`Find failed for model "${tableName}":`, error);
      throw new AppError(`Find failed for model "${tableName}"`, "", 400);
    }
  }

  async groupByInTable(tableName: string, args: Record<string, any>, client?: "postgres" | "sqlserver") {
    try {
      return await this.modelFor(tableName, client).groupBy(args);
    } catch (error) {
      console.error(`GroupBy failed for model "${tableName}":`, error);
      throw new AppError(`GroupBy failed for model "${tableName}":`, "", 400);
    }
  }

  // Dynamically builds OR/AND/IN where-clauses on top of a base `where`.
  // logic.inConditions: { field: values[] } becomes an `OR` `{ field: { in: values } }`
  // entry per field — same shape the real callers pass.
  async getManyFlexible(
    tableName: string,
    where: Record<string, any> = {},
    logic: { or?: any[]; and?: any[]; inConditions?: Record<string, any[]> } = {},
    options: Record<string, any> = {},
  ) {
    try {
      const { or = [], and = [], inConditions = {} } = logic;
      const orArray = [...or];
      const andArray = [...and];

      for (const [field, values] of Object.entries(inConditions)) {
        if (Array.isArray(values)) {
          orArray.push({ [field]: { in: values } });
        }
      }

      const finalWhere = {
        ...where,
        ...(orArray.length > 0 && { OR: orArray }),
        ...(andArray.length > 0 && { AND: andArray }),
      };

      return await this.modelFor(tableName).findMany({ where: finalWhere, ...options });
    } catch (error) {
      console.error(`getManyFlexible failed for model "${tableName}":`, error);
      throw new AppError(`getManyFlexible failed for model "${tableName}"`, "", 400);
    }
  }

  async upsertInTable(tableName: string, where: Record<string, any>, createData: Record<string, any>, updateData: Record<string, any>) {
    try {
      return await this.modelFor(tableName).upsert({ where, create: createData, update: updateData });
    } catch (e: any) {
      console.error(`Upsert failed for model "${tableName}":`, e);
      console.error("Where clause:", JSON.stringify(where, null, 2));
      throw new AppError(`Upsert failed for model "${tableName}": ${e?.message}`, "", 400);
    }
  }

  async upsertInTableClient(tableName: string, where: Record<string, any>, createData: Record<string, any>, updateData: Record<string, any>, client?: "postgres" | "sqlserver") {
    try {
      return await this.modelFor(tableName, client).upsert({ where, create: createData, update: updateData });
    } catch (e: any) {
      console.error(`Upsert failed for model "${tableName}":`, e);
      throw new AppError(`Upsert failed for model "${tableName}": ${e?.message}`, "", 400);
    }
  }

  // Same external contract as the original (query text with `@paramName`
  // placeholders + a params object), but binds values as real SQL Server
  // parameters (@P1, @P2, ...) instead of splicing quoted literals into the
  // query text — see this file's header comment.
  async executeRawQuery(query: string, params: Record<string, any> = {}): Promise<any[]> {
    try {
      let finalQuery = query;
      const values: any[] = [];
      for (const [key, value] of Object.entries(params)) {
        const placeholder = `@${key}`;
        if (finalQuery.includes(placeholder)) {
          values.push(value);
          finalQuery = finalQuery.split(placeholder).join(`@P${values.length}`);
        }
      }
      const result = await prisma.$queryRawUnsafe(finalQuery, ...values);
      return Array.isArray(result) ? result : [];
    } catch (error) {
      console.error("Raw query execution failed:", error);
      throw new AppError("Raw query execution failed", "", 400);
    }
  }

  // No real Postgres client in this checkout — see this file's header comment.
  async executeRawPostgres(_query: TemplateStringsArray, ..._values: any[]): Promise<any> {
    throw new AppError("Postgres is not configured in this checkout (no prisma-postgres schema present).", [], 503);
  }

  async queryRawPostgres(_query: TemplateStringsArray, ..._values: any[]): Promise<any[]> {
    throw new AppError("Postgres is not configured in this checkout (no prisma-postgres schema present).", [], 503);
  }

  // Genuinely functional: "MySQL" is a legacy name — connectToMySQLDatabase
  // actually opens a pool against this checkout's real SQL Server datasource
  // (see config/mysqlConnection.ts). Same as the original: `query` is a
  // complete, ready-to-run SQL string with no parameter binding on this
  // path — callers are responsible for not building it from raw user input.
  async getFcmTokens(query: string) {
    const pool = await connectToMySQLDatabase();
    const result = await pool.request().query(query);
    return result.recordset;
  }
}

export default new CommonService();
