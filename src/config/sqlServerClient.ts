/**
 * LOCAL DEV STUB location, but a genuinely real Prisma client — the actual
 * wms platform's sqlServerClient.ts presumably does the same thing (export a
 * singleton PrismaClient for prisma/schema.prisma). Requires DATABASE_URL in
 * .env to actually connect; the app still boots without it — only queries
 * fail until it's set.
 */
import { PrismaClient } from "@prisma/client";

const prismaSqlServer = new PrismaClient();

export default prismaSqlServer;
