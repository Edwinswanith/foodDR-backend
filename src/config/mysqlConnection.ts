/**
 * LOCAL DEV STUB — genuinely functional (uses the real `mssql` package,
 * already a dependency), despite the misleading "mysql" name carried over
 * from the real codebase (it actually connects to the SQL Server datasource,
 * same one Prisma points at). Requires DATABASE_URL-equivalent MSSQL_*
 * env vars in .env; pool creation fails loudly if they're missing rather
 * than silently returning a broken pool.
 */
import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

export async function connectToMySQLDatabase(): Promise<sql.ConnectionPool> {
  if (pool?.connected) return pool;

  const config: sql.config = {
    server: process.env.MSSQL_HOST || "",
    port: process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : 1433,
    database: process.env.MSSQL_DATABASE || "",
    user: process.env.MSSQL_USER || "",
    password: process.env.MSSQL_PASSWORD || "",
    options: {
      encrypt: process.env.MSSQL_ENCRYPT !== "false",
      trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERT === "true",
    },
  };

  if (!config.server || !config.user) {
    throw new Error(
      "connectToMySQLDatabase: MSSQL_HOST/MSSQL_USER not set in .env — this is a local dev stub, not the real config/mysqlConnection.ts.",
    );
  }

  pool = await new sql.ConnectionPool(config).connect();
  return pool;
}
