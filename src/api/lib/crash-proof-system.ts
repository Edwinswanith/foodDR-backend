/**
 * LOCAL DEV STUB. The real crash-proof-system.ts presumably has actual
 * crash-recovery/reconnection logic behind these names — this version
 * provides the same shape with plain, honest implementations: a
 * console-based logger, a connection manager that genuinely pings Prisma
 * (not fake), and a session store that's just express-session's built-in
 * MemoryStore under this name (functional for local dev, not actually
 * "crash-proof" in whatever resilience sense the real one implies).
 */
import session from "express-session";
import prisma from "../../config/sqlServerClient";

type LogMeta = Record<string, unknown>;

export class ApplicationLogger {
  private static instance: ApplicationLogger;

  static getInstance(): ApplicationLogger {
    if (!ApplicationLogger.instance) {
      ApplicationLogger.instance = new ApplicationLogger();
    }
    return ApplicationLogger.instance;
  }

  private log(level: string, category: string, message: string, meta?: LogMeta): void {
    console.log(`[${level}] [${category}] ${message}`, meta ?? "");
  }

  info(category: string, message: string, meta?: LogMeta): void {
    this.log("INFO", category, message, meta);
  }

  warn(category: string, message: string, meta?: LogMeta): void {
    this.log("WARN", category, message, meta);
  }

  error(category: string, message: string, meta?: LogMeta): void {
    this.log("ERROR", category, message, meta);
  }

  debug(category: string, message: string, meta?: LogMeta): void {
    this.log("DEBUG", category, message, meta);
  }
}

export class DatabaseConnectionManager {
  private static instance: DatabaseConnectionManager;
  private connected = false;

  static getInstance(): DatabaseConnectionManager {
    if (!DatabaseConnectionManager.instance) {
      DatabaseConnectionManager.instance = new DatabaseConnectionManager();
    }
    return DatabaseConnectionManager.instance;
  }

  async connect(): Promise<boolean> {
    try {
      await prisma.$queryRaw`SELECT 1`;
      this.connected = true;
    } catch (err) {
      this.connected = false;
      console.error("[DatabaseConnectionManager] ping failed:", err);
    }
    return this.connected;
  }

  isConnectionAvailable(): boolean {
    return this.connected;
  }
}

/** Plain in-memory session store under the expected name — fine for local
 * dev, not distributed/durable. */
export class CrashProofSessionStore extends session.MemoryStore {}

/** Called once at boot (`crashProofSystem.x()`); nothing to initialize here. */
export function x(): void {
  console.log("[stub] crash-proof-system.x() — no-op, real system not present in this checkout");
}
