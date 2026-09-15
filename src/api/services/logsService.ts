/**
 * Genuinely functional, writes to the real `api_logs` table (confirmed via
 * `npx prisma db pull` against the live database — the fictional `logs`
 * model this previously targeted doesn't exist there). Matches the (body,
 * action, extra, req, error, status?, message?) calling shape used by
 * nutritionController.ts and the original authController.ts pattern
 * documented in this repo's CLAUDE.md; the public LogPayload shape is left
 * unchanged so every existing call site keeps working — only createLog's
 * internal write was remapped onto api_logs' real column names.
 */
import { randomUUID } from "crypto";
import { Request } from "express";
import prisma from "../../config/sqlServerClient";

interface LogPayload {
  request_url: string;
  request_input: string;
  api_name: string;
  method: string;
  client_ip: string;
  createdDate: string;
  createdBy: string;
  response: string;
  error_resp: string | null;
  error_type: string | null;
}

class LogsService {
  async getPayloadInput(
    body: unknown,
    action: string,
    extra: unknown,
    req: Request,
    error?: unknown,
    status?: string,
    message?: string,
  ): Promise<LogPayload> {
    const isSuccess = status === "success";
    return {
      request_url: req.originalUrl || req.url || "",
      request_input: JSON.stringify(body ?? {}),
      api_name: action,
      method: req.method,
      client_ip: req.ip || "",
      createdDate: new Date().toISOString(),
      createdBy: String((req.body as any)?.authUserId || (req.body as any)?.userId || ""),
      response: isSuccess ? JSON.stringify({ message, data: extra }) : "",
      error_resp: isSuccess ? null : JSON.stringify(error instanceof Error ? error.message : error ?? extra),
      error_type: isSuccess || !error ? null : (error as any)?.name || "Error",
    };
  }

  async createLog(payload: LogPayload): Promise<void> {
    try {
      await prisma.api_logs.create({
        data: {
          id: randomUUID(),
          api_name: payload.api_name,
          http_method: payload.method,
          request_url: payload.request_url,
          request_input: payload.request_input,
          response: payload.response,
          status: payload.error_resp ? "error" : "success",
          error_type: payload.error_type,
          user_id: payload.createdBy || null,
          client_ip: payload.client_ip,
          created_by: payload.createdBy || null,
        },
      });
    } catch (err) {
      // Never let logging itself break the request — matches this repo's
      // documented "logsService pool timeouts must not crash the server" rule.
      console.error("[logsService] failed to write log:", err);
    }
  }
}

export default new LogsService();
