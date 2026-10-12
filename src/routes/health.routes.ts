import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

export const healthRouter = Router();

healthRouter.get("/", async (_request, response) => {
  const [database, cache] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);

  const postgresOk = database.status === "fulfilled";
  const redisOk = cache.status === "fulfilled" && cache.value === "PONG";
  const healthy = postgresOk && redisOk;

  response.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    postgres: postgresOk ? "ok" : "error",
    redis: redisOk ? "ok" : "error",
  });
});
