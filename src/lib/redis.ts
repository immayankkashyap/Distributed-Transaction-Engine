import { createClient } from "redis";
import { env } from "../config/env.js";

export const redis = createClient({
  url: env.REDIS_URL,
  disableOfflineQueue: true,
  socket: {
    connectTimeout: 5_000,
    reconnectStrategy: (attempt) =>
      attempt > 5 ? new Error("Redis is unavailable") : Math.min(attempt * 200, 2_000),
  },
});

redis.on("error", (error) => {
  console.error("Redis connection error:", error);
});
