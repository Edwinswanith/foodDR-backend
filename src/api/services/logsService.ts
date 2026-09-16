/**
 * Genuinely functional, writes to the real `fooddr.api_logs` table (confirmed
 * via `npx prisma db pull` against the live database).
 *
 * Persistence goes through the project's raw parameterized SQL Server pool
 * (connectToMySQLDatabase — a legacy name for the real MSSQL connection, see
 * config/mysqlConnection.ts) with the `mssql` package's typed `.input()`
 * binding, matching the query-based pattern used elsewhere in this codebase
 * (commonService.getFcmTokens) instead of a Prisma-specific implementation.
 * The table is explicitly schema-qualified (`fooddr.api_logs`) because the
 * raw pool, unlike Prisma's DATABASE_URL (`schema=fooddr`), doesn't set a
 * default schema and would otherwise resolve against `dbo`.
 *
 * `toNvarchar()`: getPayloadInput() returns `request_input`/`response` as
 * whatever raw value the caller passed (often an object, e.g. `req.body`),
 * not a pre-stringified string. mssql's `.input()` needs an actual string
 * for an NVarChar column, so createLog stringifies non-string values here
 * before binding — without it, every log write for a call site that passes
 * an object (the common case) would throw at the database layer.
 */
import { Request } from "express";
import moment from "moment";
import sql from "mssql";
import { connectToMySQLDatabase } from "../../config/mysqlConnection";

function toNvarchar(value: any): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

class LogsService {
  // // eslint-disable-next-line default-param-last
  async getPayloadInput(payload: any = {}, api_name: string = "", id: any = "", req: Request, error: any = {}, errorType: string = "", response: any = {}) {
    let fullUrl: string = req.protocol + '://' + req.get('host') + req.originalUrl;
    let clientIp: any = req.headers['x-forwarded-for'] ?? req.ip;
    const currentUTC = moment.utc().format('YYYY-MM-DD HH:mm:ss');

    return {
      request_url: fullUrl,
      request_headers: req.headers,
      request_input: payload,
      error_resp: error,
      errorType: errorType,
      api_name: api_name,
      method: req.method,
      client_ip: clientIp,
      createdDate: currentUTC,
      createdBy: null,
      response: response
    }
  }

  async createLog(payload: any) {
    try {
      const pool = await connectToMySQLDatabase();

      const query = `
                INSERT INTO fooddr.api_logs
                (id, api_name, http_method, request_url, request_input, response, status, error_type, user_id, client_ip, created_by)
                VALUES
                (@id, @api_name, @http_method, @request_url, @request_input, @response, @status, @error_type, @user_id, @client_ip, @created_by);
            `;

      await pool
        .request()
        .input("id", sql.NVarChar(64), crypto.randomUUID())
        .input("api_name", sql.NVarChar(120), payload.api_name)
        .input("http_method", sql.NVarChar(10), payload.method)
        .input("request_url", sql.NVarChar(500), payload.request_url || null)
        .input("request_input", sql.NVarChar(sql.MAX), toNvarchar(payload.request_input))
        .input("response", sql.NVarChar(sql.MAX), toNvarchar(payload.response))
        .input("status", sql.NVarChar(20), payload.error_resp ? "error" : "success")
        .input("error_type", sql.NVarChar(120), payload.errorType || null)
        .input("user_id", sql.NVarChar(64), payload.createdBy || null)
        .input("client_ip", sql.NVarChar(64), payload.client_ip || null)
        .input("created_by", sql.NVarChar(64), payload.createdBy || null)
        .query(query);
    } catch (err) {
      // Never let logging itself break the request — matches this repo's
      // documented "logsService pool timeouts must not crash the server" rule.
      console.error("[logsService] failed to write log:", err);
    }
  }
}

export default new LogsService();
