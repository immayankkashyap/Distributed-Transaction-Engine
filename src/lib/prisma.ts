import { PrismaClient } from "@prisma/client";
import "../config/env.js";

// Loading env before constructing the client lets Prisma read DATABASE_URL.
export const prisma = new PrismaClient();
