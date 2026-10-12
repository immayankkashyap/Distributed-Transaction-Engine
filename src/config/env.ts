import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function connectionUrl(name: string, schemes: string[]): string {
  const value = required(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid connection URL`);
  }
  if (!schemes.includes(parsed.protocol) || !parsed.hostname) {
    throw new Error(`${name} has an unsupported URL scheme or no host`);
  }
  return value;
}

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

// const bookingMode = process.env.BOOKING_MODE ?? "baseline";
// if (bookingMode !== "baseline" && bookingMode !== "safe") {
//   throw new Error("BOOKING_MODE must be baseline or safe");
// }

export const env = {
  DATABASE_URL: connectionUrl("DATABASE_URL", ["postgresql:", "postgres:"]),
  DIRECT_URL: connectionUrl("DIRECT_URL", ["postgresql:", "postgres:"]),
  REDIS_URL: connectionUrl("REDIS_URL", ["redis:", "rediss:"]),
  // BOOKING_MODE: bookingModue,
  PORT: port,
} as const;
