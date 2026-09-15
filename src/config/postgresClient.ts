/**
 * LOCAL DEV STUB. server.ts imports this for a second Prisma client against
 * ./prisma-postgres/schema.prisma, which doesn't exist in this checkout
 * (CLAUDE.md lists it as not present). A real PrismaClient can't be
 * constructed without that schema being generated, so this exports an inert
 * object with just enough shape for server.ts's own usage ($disconnect() on
 * SIGINT) to not crash.
 */
const prismaPostgres = {
  async $disconnect(): Promise<void> {
    // no-op — no real Postgres client here, see file header.
  },
};

export default prismaPostgres;
