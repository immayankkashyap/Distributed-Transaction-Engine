
# Distributed Transaction Engine

## Prisma and Supabase

Prisma connects to the Supabase Postgres database. Copy `.env.example` to `.env` when setting up a new checkout, then fill in the Supabase connection strings:

- `DATABASE_URL`: transaction pooler URL for the application (port `6543`).
- `DIRECT_URL`: direct connection or session pooler URL for Prisma CLI operations (port `5432`).

Install dependencies and apply the initial schema migration:

```sh
npm install
npm run db:migrate -- --name init
```

The migration is checked in under `prisma/migrations`. The generated Prisma Client is created during install and can be regenerated with `npm run db:generate`. Open Prisma Studio with `npm run db:studio`.

`DATABASE_URL` needs `?pgbouncer=true` for Supabase's transaction pooler. `DIRECT_URL` can use Supabase's direct connection or the session pooler on port `5432` when direct IPv6 access is unavailable. Keep `.env` private; it is excluded by `.gitignore`.

## Phase 0: infrastructure connectivity

Set `REDIS_URL=redis://localhost:6379`, `BOOKING_MODE=baseline`, and `PORT=3000` in `.env` for local development. Start Redis through Docker Compose, then run the API locally with `npm run dev`:

```sh
docker compose up -d redis
npm run dev
```

To run the API and Redis in containers:

```sh
docker compose up --build -d
docker compose exec -T app node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(async r => { console.log(r.status, await r.json()); process.exit(r.ok ? 0 : 1) })"
```

The expected response is HTTP `200` with `{ "status": "ok", "postgres": "ok", "redis": "ok" }`. A failed dependency returns HTTP `503` with its status set to `error`. Docker Compose passes `redis://redis:6379` to the app container while the host `.env` keeps `redis://localhost:6379`. The Supabase database stays hosted outside Docker.

The shared Prisma Client is exported from `src/lib/prisma.ts`. Stop containers with `docker compose down`.
