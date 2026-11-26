import { PrismaClient } from '@prisma/client';

const createPrisma = () => new PrismaClient();
declare const globalThis: { prismaGlobal: ReturnType<typeof createPrisma> } & typeof global;

const prisma = globalThis.prismaGlobal ?? createPrisma();
export default prisma;

// Sharing the Prisma module does not make an arbitrary model-shaped object read-only.
export const custom = { file: { count(args: { where: Record<string, unknown> }) {
  args.where.deletedAt = null;
} } };
