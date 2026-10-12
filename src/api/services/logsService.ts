/** Best-effort API telemetry, persisted after the response using Vercel's
 * request lifetime hook and the existing Prisma pool. Logging never blocks
 * nutrition reads/writes or opens a second SQL Server connection pool.
 */
import { Request } from "express";
import moment from "moment";
import { randomUUID } from "crypto";
import { waitUntil } from "@vercel/functions";
import prisma from "../../config/sqlServerClient";

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

  async createLog(payload: any): Promise<void> {
    // Keep the existing awaited call sites compatible, but only await scheduling.
    // waitUntil keeps the write alive after Vercel sends the HTTP response.
    waitUntil(this.writeLog(payload));
  }

  private async writeLog(payload: any): Promise<void> {
    try {
      await prisma.api_logs.create({
        data: {
          id: randomUUID(),
          api_name: payload.api_name,
          http_method: payload.method,
          request_url: payload.request_url || null,
          request_input: toNvarchar(payload.request_input),
          response: toNvarchar(payload.response),
          status: payload.error_resp ? "error" : "success",
          error_type: payload.errorType || null,
          user_id: payload.createdBy || null,
          client_ip: payload.client_ip || null,
          created_by: payload.createdBy || null,
        },
        select: { id: true },
      });
    } catch (err) {
      // Observe failures without exposing request contents or disrupting the API.
      console.error("[logsService] failed to write log:", err instanceof Error ? err.name : "Database error");
    }
  }
}

export default new LogsService();
