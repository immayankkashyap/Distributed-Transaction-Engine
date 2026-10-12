import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";

async function start(): Promise<void> {
  await prisma.$connect();
  await redis.connect();

  const server = app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`API listening on port ${env.PORT}`);
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; closing connections`);

    const timeout = setTimeout(() => {
      console.error("Shutdown timed out");
      process.exit(1);
    }, 10_000);
    timeout.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await Promise.all([redis.close(), prisma.$disconnect()]);
    } finally {
      clearTimeout(timeout);
    }
  }

  function onSignal(signal: string): void {
    void shutdown(signal).catch((error: unknown) => {
      console.error("Shutdown failed:", error);
      process.exitCode = 1;
    });
  }

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}

start().catch(async (error: unknown) => {
  console.error("Startup failed:", error);
  await Promise.allSettled([
    redis.isOpen ? redis.close() : Promise.resolve(),
    prisma.$disconnect(),
  ]);
  process.exitCode = 1;
});
