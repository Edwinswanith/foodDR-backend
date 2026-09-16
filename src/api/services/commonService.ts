/**
 * Generic Prisma-backed CRUD/query helper — matches the real platform's
 * commonService.ts structure (private getClient(), (prisma as any)[model]
 * indexing, no model-name casing coercion). Four intentional deviations
 * from that reference, each because copying it verbatim would break this
 * specific checkout — noted inline where they apply:
 *
 *  - `getClient`: the reference returns `prismaPostgres` for the postgres
 *    branch. In this checkout `prismaPostgres` (config/postgresClient.ts)
 *    is an inert stub — no real Postgres schema exists here — so returning
 *    it would let a postgres-routed call reach `.create()`/etc. on an
 *    object with no model delegates, crashing with a confusing
 *    "X.create is not a function" instead of a clear error. This still
 *    throws a clear AppError for the postgres branch instead.
 *  - `deleteFromTable`'s soft delete: the reference writes `isDeleted`.
 *    This checkout's real schema (confirmed against the live DB) names the
 *    column `is_deleted` — writing `isDeleted` would throw a Prisma
 *    "unknown argument" error on every soft delete. Kept as `is_deleted`.
 *  - `executeRawQuery`: the reference builds SQL by string-substituting
 *    `@param` placeholders with quoted values before calling
 *    `$queryRawUnsafe` — a SQL-injection-shaped pattern. This version keeps
 *    the same calling contract (query text with `@paramName` placeholders +
 *    a params object) but binds values as real parameters instead.
 *  - `executeRawPostgres`/`queryRawPostgres`: the reference calls
 *    `prismaPostgres.$executeRaw`/`$queryRaw` for real. Same stub problem
 *    as `getClient` above — these throw a clear AppError instead of
 *    crashing on a stub with no such methods.
 *
 * `getFcmTokens` is genuinely functional against this checkout's real DB —
 * "MySQL" is a misleading legacy name, it actually connects to the same SQL
 * Server datasource Prisma points at (see config/mysqlConnection.ts).
 */
import { ERROR_MESSAGE } from "../constants/index";
import AppError from "../core/error-handler";
import _ from "lodash";
import { connectToMySQLDatabase } from "../../config/mysqlConnection";
import prisma from "../../config/sqlServerClient";

class CommonService {
  private getClient(client?: "postgres" | "sqlserver") {
    if (client === "postgres") {
      // Reference returns prismaPostgres here — kept as a clear throw
      // instead; see this file's header comment.
      throw new AppError(ERROR_MESSAGE.POSTGRES_NOT_CONFIGURED, [], 503);
    }
    return prisma; // default = sqlserver
  }

  async insertIntoTable(model: string, data: any, client?: "postgres" | "sqlserver") {
    try {
      const result = await (this.getClient(client) as any)[model].create({ data });
      return result;
    } catch (error) {
      console.error(`Insert failed for model "${model}":`, error);
      throw new AppError(`Insert failed for model "${model}":`, "", 400);
    }
  }

  async insertManyIntoTable(model: string, data: any[], client?: "postgres" | "sqlserver") {
    try {
      const result = await (this.getClient(client) as any)[model].createMany({ data });
      return result;
    } catch (error) {
      console.error(`Bulk insert failed for model "${model}":`, error);
      throw new AppError(`Bulk insert failed for model "${model}":`, "", 400);
    }
  }

  async updateTable(model: string, where: any, data: any) {
    try {
      const result = await (prisma as any)[model].update({
        where,
        data,
      });
      return result;
    } catch (error) {
      console.error(`Update failed for model "${model}":`, error);
      throw new AppError(`Update failed for model "${model}":`, "", 400);
    }
  }

  async updateById(model: string, id: number, data: any) {
    try {
      const result = await (prisma as any)[model].update({
        where: { id },
        data,
      });
      return result;
    } catch (error) {
      console.error(`Update by ID failed for model "${model}" with id ${id}:`, error);
      throw new AppError(`Update by ID failed for model "${model}" with id ${id}`, "", 400);
    }
  }

  async getFromTable(model: string, where: any = {}, options: any = {}, client?: "postgres" | "sqlserver") {
    try {
      const result = await (this.getClient(client) as any)[model].findFirst({ where, ...options }); // options can have include, select, orderBy, etc.
      return result;
    } catch (error) {
      console.error(`Get failed for model "${model}":`, error);
      throw new AppError(`Get failed for model "${model}":`, "", 400);
    }
  }

  async getManyFromTable(model: string, where: any = {}, options: any = {}, client?: "postgres" | "sqlserver") {
    try {
      return await (this.getClient(client) as any)[model].findMany({ where, ...options }); // options can have include, orderBy, skip, take, etc.
    } catch (error) {
      console.error(`GetMany failed for model "${model}":`, error);
      throw new AppError(`GetMany failed for model "${model}":`, "", 400);
    }
  }

  async getTotalFromTable(model: string, where: any = {}, options: any = {}) {
    try {
      return await (prisma as any)[model].count({ where }); // options can have include, orderBy, skip, take, etc.
    } catch (error) {
      console.error(`Get total failed for model "${model}":`, error);
      throw new AppError(`Get total failed for model "${model}":`, "", 400);
    }
  }

  async getManyFlexible(model: string, where: any = {}, logic: any = {}, options: any = {}) {
    try {
      const { or = [], and = [], inConditions = {} } = logic;

      // Build OR and AND dynamically
      const orArray = [...or];
      const andArray = [...and];

      // Handle IN-like conditions
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

      return await (prisma as any)[model].findMany({
        where: finalWhere,
        ...options,
      });
    } catch (error) {
      console.error(`getManyFlexible failed for model "${model}":`, error);
      throw new AppError(`getManyFlexible failed for model "${model}"`, "", 400);
    }
  }

  async deleteFromTable(model: string, where: any, soft: boolean = true) {
    try {
      if (soft) {
        // Soft delete (mark as deleted) — real column is `is_deleted`, not
        // `isDeleted`; see this file's header comment.
        return await (prisma as any)[model].updateMany({
          where,
          data: { is_deleted: true },
        });
      } else {
        // Hard delete (remove records)
        return await (prisma as any)[model].deleteMany({
          where,
        });
      }
    } catch (error) {
      console.error(`Delete failed for model "${model}":`, error);
      throw new AppError(`Delete failed for model "${model}":`, "", 400);
    }
  }

  async countInTable(model: string, where: any = {}) {
    try {
      const result = await (prisma as any)[model].count({ where });
      return result;
    } catch (error) {
      console.error(`Count failed for model "${model}":`, error);
      throw new AppError(`Count failed for model "${model}":`, "", 400);
    }
  }

  async paginateFromTable(model: string, where: any = {}, skip = 0, take = 10, orderBy: any = { id: "desc" }) {
    try {
      const result = await (prisma as any)[model].findMany({
        where,
        skip,
        take,
        orderBy,
      });
      return result;
    } catch (error) {
      console.error(`Paginate failed for model "${model}":`, error);
      throw new AppError(`Paginate failed for model "${model}":`, "", 400);
    }
  }

  // Same calling contract as the reference (query text with `@paramName`
  // placeholders + a params object), but binds values as real SQL Server
  // parameters instead of splicing quoted literals into the query text —
  // see this file's header comment.
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
      console.error(`Raw query execution failed:`, error);
      throw new AppError(`Raw query execution failed`, "", 400);
    }
  }

  async updateManyInTable(model: string, where: any, data: any) {
    try {
      const result = await (prisma as any)[model].updateMany({
        where,
        data,
      });
      return result;
    } catch (error) {
      console.error(`UpdateMany failed for model "${model}":`, error);
      throw new AppError(`UpdateMany failed for model "${model}":`, "", 400);
    }
  }

  async getFcmTokens(query: any) {
    const pool = await connectToMySQLDatabase();
    const result = await pool.request().query(query);
    return result.recordset;
  }

  async upsertInTable(model: string, where: any, createData: any, updateData: any) {
    try {
      // Handle compound unique constraints - check if where has nested unique key
      const whereClause = where;

      return await (prisma as any)[model].upsert({
        where: whereClause,
        create: createData,
        update: updateData,
      });
    } catch (e: any) {
      console.error(`Upsert failed for model "${model}":`, e);
      console.error("Where clause:", JSON.stringify(where, null, 2));
      throw new AppError(`Upsert failed for model "${model}": ${e?.message}`, "", 400);
    }
  }

  async findOneInTable(model: string, where: any, include?: any) {
    try {
      return await (prisma as any)[model].findUnique({ where, include });
    } catch (e) {
      console.error(`Find failed for model "${model}":`, e);
      throw new AppError(`Find failed for model "${model}"`, "", 400);
    }
  }

  async groupByInTable(model: string, args: any, client?: "postgres" | "sqlserver") {
    try {
      return await (this.getClient(client) as any)[model].groupBy(args);
    } catch (error) {
      console.error(`GroupBy failed for model "${model}":`, error);
      throw new AppError(`GroupBy failed for model "${model}":`, "", 400);
    }
  }

  // Reference calls prismaPostgres.$executeRaw for real — see this file's
  // header comment on why that's replaced with a clear throw here.
  async executeRawPostgres(_query: TemplateStringsArray, ..._values: any[]): Promise<any> {
    throw new AppError(ERROR_MESSAGE.POSTGRES_NOT_CONFIGURED, [], 503);
  }

  // Reference calls prismaPostgres.$queryRaw for real — see this file's
  // header comment on why that's replaced with a clear throw here.
  async queryRawPostgres(_query: TemplateStringsArray, ..._values: any[]): Promise<any[]> {
    throw new AppError(ERROR_MESSAGE.POSTGRES_NOT_CONFIGURED, [], 503);
  }

  async upsertInTableClient(model: string, where: any, createData: any, updateData: any, client?: "postgres" | "sqlserver") {
    try {
      return await (this.getClient(client) as any)[model].upsert({
        where,
        create: createData,
        update: updateData,
      });
    } catch (e: any) {
      console.error(`Upsert failed for model "${model}":`, e);
      throw new AppError(`Upsert failed for model "${model}": ${e?.message}`, "", 400);
    }
  }
}
export default new CommonService();
