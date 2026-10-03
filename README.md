
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

Import the shared client from `src/db.ts`. Keep `.env` private; it is excluded by `.gitignore`.
