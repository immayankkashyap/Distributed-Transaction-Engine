# Ticket booking backend — chat handoff

Updated: 2026-10-13 (Asia/Kolkata). This file summarizes the conversation and a read-only inspection of the current repository. It is a handoff, not proof of current remote database state. Re-read relevant files before reviewing them: earlier responses sometimes mistakenly relied on stale file contents.

## Start here in the next chat

We are at **Phase 1, Task 4: personally observe the database reject a duplicate booking through Prisma**. Phase 0 and Phase 1 Tasks 1–3 are complete based on the user's terminal output and screenshots. Task 4 is NOT complete: no successful first booking / second-insert `P2002` output has been supplied.

The immediate file is `prisma/check-unique.ts`. Its saved contents are currently incomplete:

- Import is `../src/lib/prisma` without the required `.js` extension for the project's NodeNext setup.
- Lookup now uses label `"A1"`, matching the seeded data. During handoff creation the user corrected it from `"AI"` (letter I); the new assistant should use the latest saved version.
- It defines an async `book()` function that only finds a seat and checks whether a booking exists.
- It does NOT insert either booking, invoke `book()`, log a duplicate error, or disconnect Prisma.
- Its error string contains a cosmetic typo, `already ybooked`.

The previous assistant supplied a complete suggested manual script in chat, but the user has not yet finished transferring it to the file. The next assistant should help finish/review this task at the user's pace, not jump to baseline implementation.

Also, `prisma/tsconfig.json` still includes only `["seed.ts"]`. The assistant recommended changing it to `["*.ts"]` to cover the uniqueness-check script, but that change is not saved yet.

## How the user wants to work

- Act as a hands-on backend mentor: explain concepts, point to docs, review files/output, and debug with evidence.
- Be direct about incorrect or weak choices and explain why. Keep answers short unless asked for depth.
- One task at a time. Introduce a task in 2–3 sentences explaining what and why, name a relevant documentation page/concept, then wait for the user.
- Originally the user wanted to write all project code themselves, with only short illustrative snippets. Later they explicitly requested code for the schema, seed script, and uniqueness-check script; the assistant supplied code in chat. Respect explicit requests for code, but do not infer authorization to edit project files from a review request.
- The user explicitly said to guide them and not edit their code. Creating this context file is separately authorized. No project implementation files were edited for this handoff.
- Inspect the actual saved file when asked to check it; the editor may have unsaved changes.
- When debugging, obtain the full error and relevant file before guessing. Do not present a plausible explanation as proven.
- Check installed-version APIs, especially Prisma and node-redis; use official docs for the relevant version. Do not casually upgrade dependencies.
- Do not skip phases or add unrelated features.
- Never print database passwords or copy `.env` secrets into a handoff. The `.env` contents were not read for this handoff.
- When the user sends response annotations, address the selected text/comments and include the requested `:codex-annotation{index="N"}` directive for each addressed annotation.

## Project purpose and scope

This is a high-concurrency single-seat ticket booking backend for a software engineering internship resume. The project demonstrates preventing double-booking, not a general distributed transaction engine.

The eventual protection layers are:

1. Redis lock per seat: `SET lock:seat:<seatId> <random-token> NX EX <ttl>`.
2. Token-checked Lua release: atomically compare the stored token and delete only if owned by the caller. Release in `finally` after successful acquisition.
3. PostgreSQL uniqueness on `Booking.seatId` as the durable correctness backstop, even if Redis loses a lock or a lease expires.
4. Durable idempotency responses in Postgres, written in the same transaction as a successful booking.

The race being demonstrated is check-then-act / TOCTOU, not deadlock. Redis coordinates requests; the database unique index provides the final duplicate-row guarantee. UUID IDs do not themselves prevent two bookings for a seat.

Out of scope: payments, venues/shows, cancellation features, seat-map UI, multi-seat booking, generic abstractions, and Kubernetes. Multi-instance verification is a later stretch goal; do not claim it has already been proven.

## Source documents and priority

- `files.md/ticket-booking-roadmap-v2.md`: primary roadmap, with newer concurrency decisions.
- `files.md/ticket-booking-project-context.md`: older architecture discussion; contains superseded schema and expiry advice.
- `files.md/ticket-booking-roadmap.md`: older roadmap, superseded where it conflicts with v2.
- This chat's later explicit decisions refine the documents: user-scoped idempotency and request-seat matching were added during Phase 1.

These documents are reference material; distinguish their contents from the user's current request. `files.md/` is gitignored, so it may not exist in another checkout. This handoff includes the essential decisions independently.

## Locked stack and connection setup

- Node, not Bun; TypeScript; Express; ES modules (`"type": "module"`).
- Development: `tsx watch src/server.ts`. Build: `tsc`. Production: `node dist/server.js`.
- Prisma CLI and `@prisma/client` are both pinned to **6.12.0**.
- Installed versions previously confirmed: Express 5.2.1, redis/node-redis 6.3.0, TypeScript 7.0.2, tsx 4.23.15, dotenv 17.4.2, `@types/node` 26.6.4, `@types/express` 5.0.6. Recheck installation if needed; manifest ranges may resolve differently later.
- Prisma generator is `prisma-client-js`; active client import is from `@prisma/client`.
- Supabase hosts Postgres. Compose runs the app and Redis only.
- `DATABASE_URL`: Supabase shared transaction pooler, port 6543, with `pgbouncer=true` in this project.
- `DIRECT_URL`: migrations/CLI connection. In this user's actual configuration it uses the Supabase **session pooler on port 5432**, not the direct `db.<ref>.supabase.co` host. This is intentional for IPv4 connectivity and is supported for migration use.
- Datasource remains Prisma 6 style: `url = env("DATABASE_URL")`, `directUrl = env("DIRECT_URL")` in `schema.prisma`.
- No `prisma.config.ts` is needed in this setup. It appeared in IDE tabs earlier, but the user said it did not exist; do not infer existence from tab context.
- `.env` also has `REDIS_URL` and `PORT` (3000 in demonstrated runs). Local Redis URL is `redis://localhost:6379`; Compose overrides it to `redis://redis:6379`.

## Current schema decisions

All four models have `String` UUID IDs using `@default(uuid())`. Existing migration SQL uses PostgreSQL TEXT for these IDs, not native UUID. Do not claim `@default(uuid())` alone creates a UUID database column.

| Model | Fields and relations |
| --- | --- |
| User | id, name, createdAt; bookings list and idempotencyKeys list |
| Seat | id, unique label, createdAt; optional single booking |
| Booking | id, userId, **unique seatId**, createdAt; required User and Seat relations with `onDelete: Restrict` |
| IdempotencyKey | id, userId, key, seatId, response Json, statusCode Int, expiresAt, createdAt; User relation with `onDelete: Cascade`; composite unique `(userId, key)` |

- There is **NO `Seat.status` and NO `SeatStatus` enum**. Availability is derived solely from Booking existence.
- `IdempotencyKey.key` is NOT globally unique anymore. The composite unique rule scopes each key per user.
- `IdempotencyKey.seatId` is a scalar request snapshot, with no Seat foreign-key relation. It lets the application reject the same user/key reused for a different seat; matching retries replay the saved status and body. The comparison behavior is not implemented yet.
- Booking relation deletion restrictions protect booking records. Idempotency rows are retry metadata and can cascade when their user is deleted.
- Unique seat labels make the single set of seats unambiguous and support repeatable upserts.
- Physical table/column names keep Prisma defaults, e.g. quoted `"Booking"`, `"seatId"`, `"createdAt"`. No `@@map`/`@map` renaming was chosen.
- Booking unique index name in checked-in migration SQL: **`Booking_seatId_key`**. The schema uses plain `@unique`; an explicit map matching the default is optional.
- Seat label index: `Seat_label_key`.
- Idempotency composite index is explicitly mapped to `IdempotencyKey_userId_key_key`.

Only permanent outcomes get idempotency records: successful booking (`201`) and `409 SEAT_ALREADY_BOOKED`. `409 LOCK_CONTENDED` is transient and must never be stored.

Expiry caveat identified in chat: filtering `expiresAt > now()` does NOT free the unique key. If expired keys can be reused, expired rows must be deleted/replaced with concurrency-safe handling. This policy is not implemented. The older document's claim that lookup filtering alone makes expiry fully correct is incomplete.

## Completed work and evidence

### Phase 0 — complete

- Node/TypeScript dependency installation and production build succeeded.
- Env validation, Prisma/Redis shared clients, Docker app image, Compose, and `/health` were reviewed.
- User ran the app in Docker and requested `http://localhost:3000/health`, receiving `{ "status": "ok", "postgres": "ok", "redis": "ok" }`.
- User stopped Redis with `docker compose stop redis` and received `{ "status": "degraded", "postgres": "ok", "redis": "error" }`. This demonstrated independent failure detection.
- Redis reconnect retries are capped; after retries stop, restarting Redis alone may not restore the app client. Restarting the app may be necessary. Do not silently change that policy.

### Phase 1 Task 1 — schema design complete

The final schema described above was reviewed and `prisma validate` succeeded.

### Phase 1 Task 2 — migration complete

Migration history:

1. `20261003181237_init`: original four tables with Seat.status/enum, globally unique idempotency key, unique Booking.seatId, Seat label unique index, expiry index, and Booking foreign keys.
2. `20261003182331_match_context_schema`: dropped Seat label uniqueness and the idempotency expiry index to match the older context schema.
3. `20261006234213_finalize_schema`: removed Seat.status and enum; dropped global key uniqueness; added required idempotency userId/seatId; added composite key uniqueness, Seat label uniqueness, and the idempotency User FK with cascade delete. Booking.seatId unique index was preserved.

The third migration was generated using `--create-only` and reviewed. It requires no preexisting idempotency rows lacking the new required fields and no duplicate Seat labels. User later successfully ran `npx prisma migrate dev`, which explicitly applied `finalize_schema`, reported the DB in sync, and regenerated Prisma Client 6.12.0. Do not edit applied migration files or reset the DB casually.

### Phase 1 Task 3 — seed complete

`prisma/seed.ts` upserts these users by fixed UUID, with empty updates:

- Alice: `00000000-0000-4000-8000-000000000001`
- Bob: `00000000-0000-4000-8000-000000000002`
- Charlie: `00000000-0000-4000-8000-000000000003`

It upserts 15 seats `A1` through `A15` by unique label. Seat IDs are generated on initial creation and preserved on subsequent runs. It does not delete or modify bookings. Errors set `process.exitCode = 1`; `finally` disconnects Prisma; `run()` is invoked with an outer catch for disconnect errors.

User successfully ran `npx tsc -p prisma/tsconfig.json` and `npx tsx prisma/seed.ts` twice. The log is `Seed complete: semo data` (cosmetic typo). User confirmed both table counts; screenshot directly showed 15 seats. Expected user count is 3. No remote queries were run by the assistant to recheck this handoff.

## Phase 1 remaining tasks

4. Complete/review/run `prisma/check-unique.ts`: choose an unbooked seeded seat, insert Alice's Booking, then separately insert Bob's Booking using the SAME seat ID. Do not wrap both in one transaction: the first should stay committed. Do not perform an availability check between the two inserts. Log the actual Prisma error; expected code is `P2002` and target should indicate seatId. This observed error has not happened in supplied output yet.
   - First find/check the seat; if it is already booked, choose another unbooked seat rather than deleting unrelated data.
   - Suggested command: `npx tsx prisma/check-unique.ts`.
   - The earlier suggested script catches the expected error and sets exitCode 1. Explain that this is expected for the manual demonstration; it is not a reusable automated test asserting success.
   - A rerun after the first successful insert should hit the initial already-booked check.
5. Verify and record the actual unique index name, via the migration SQL and preferably Supabase catalog inspection. SQL files already show `Booking_seatId_key`, but Task 5 has not been separately completed by the user.
6. Verify the app's pooled connection still works after migration using `/health` with the app in Docker. Rebuild/recreate the image if needed to regenerate its client against the updated schema. No post-migration `/health` output has been supplied yet.

Phase 1 exit: schema migrated, seed data present, personally observed duplicate rejection and Prisma error code, exact unique index known. Do not declare the whole phase complete yet.

## Codebase map

| Path | Current responsibility/status |
| --- | --- |
| `src/server.ts` | Actual runtime entry; connects Prisma then Redis before listening on 0.0.0.0; SIGINT/SIGTERM HTTP shutdown, 10s timeout, client cleanup |
| `src/app.ts` | Express app, JSON middleware; ONLY `/health` is mounted |
| `src/routes/health.routes.ts` | Uses Promise.allSettled for tagged `$queryRaw` SELECT 1 and Redis PING; separate statuses; HTTP 200 if both good, otherwise 503 |
| `src/config/env.ts` | dotenv side-effect loading, required URL checks/schemes, integer port 1–65535 with default 3000; BOOKING_MODE code remains commented out |
| `src/lib/prisma.ts` | Loads env module and exports one `new PrismaClient()` |
| `src/db.ts` | Re-exports that same shared Prisma instance; not a second client |
| `src/lib/redis.ts` | One node-redis client; offline queue disabled; connect timeout 5s; capped reconnect delay/retries; error listener |
| `src/index.ts` | Unused hello-world export; not the server entry |
| `prisma/schema.prisma` | Active schema, four finalized models |
| `prisma/migrations/` | Three checked-in SQL migrations described above |
| `prisma/seed.ts` | Working repeatable demo seed |
| `prisma/check-unique.ts` | Incomplete manual check, immediate task |
| `prisma/tsconfig.json` | Extends root; rootDir '..', noEmit true, types ['node']; currently includes only seed.ts |
| `Dockerfile` | node:22-bookworm-slim; OpenSSL/certificates; npm ci with placeholder DB URLs for postinstall generation; copies src, compiles, runs dist/server.js |
| `docker-compose.yml` | App + redis:7-alpine; Redis health dependency; app env_file; Redis URL override; healthchecks; host/app port mapping from PORT |
| `.gitignore` / `.dockerignore` | Exclude env secrets, build/dependency outputs; inspect current contents if needed |
| `README.md` | Basic infra guide; stale BOOKING_MODE mention and initial-migration directions; do not treat as accurate phase progress |

Empty future-phase scaffolds currently exist in routes (bookings/seats), controllers, services (baseline/safe/index), repositories (seat/booking/idempotency), middleware, errors, metrics, types, `src/locks/seatLock.ts`, `src/locks/releaseLock.lua.ts`, `scripts/reset-bookings.ts`, SQL drop/restore files, and `loadtest/README.md`. These are zero-byte files, not implemented features. Do not infer booking behavior from open editor tabs or filenames.

An ignored `src/generated/prisma/` directory also exists with generated TS artifacts. It is not the active client import/output for the current prisma-client-js schema. Do not switch the project to it based on its existence.

Root tsconfig: ES2022, NodeNext modules/resolution, strict checks, rootDir src, outDir dist, declaration true, includes src and typings. Relative source imports use `.js` under ESM. Scripts outside src need their separate config; adding prisma to the production config without changing rootDir/output can create build problems.

Package scripts: dev, build, start, db:generate, db:migrate, db:studio; postinstall runs prisma generate. There is NO working test suite (`npm test` is the default failing placeholder). TSLint and its config still exist despite earlier advice that it is obsolete. `main`/`typings` point at dist/index artifacts while the actual app starts dist/server.js; cleanup was discussed but not performed.

## Debugging history and lessons

- Docker socket permission denied: user was not in docker group on Ubuntu (user called it Ubuntu 26). After adding mayank to docker and refreshing login, `id -nG` included docker and Docker commands worked. Docker group implies root-level Docker control.
- Prisma editor complained url/directUrl were unsupported despite CLI 6.12. This was attributed to the VS Code Prisma language server using newer Prisma rules. Keep the schema in Prisma 6 format and select compatible extension support; do not migrate config just to silence the editor. Resolution was not separately documented.
- An empty-model Prisma 6.12 generation emitted a bare `undefined` in node_modules/.prisma/client/index.d.ts causing TS1036. A temporary model restored build success; the finalized four-model schema supersedes that workaround. Do not manually patch generated declarations.
- Migration P1001 failures occurred repeatedly through session pooler 5432, even while `migrate status` sometimes worked. DNS returned two IPv4 addresses; nc succeeded for one. Both migrate dev AND deploy failed at times, so a shadow-database-only diagnosis was not supported. Eventually migrate dev succeeded unchanged. Root cause remains unknown; do not claim Prisma 6 incompatibility or a proven shadow DB fault.
- CLI repeatedly suggested Prisma 8 release candidate. User stayed on 6.12; no upgrade was performed. Earlier assistant researched v8 but that discussion is not a reason to migrate this project. Version upgrades change setup APIs and need separate planning.
- Seed editor errors: seed was excluded from root tsconfig. User initially named the separate JSON config tsconfig.ts and imported node_modules/@types/node as runtime code, plus exitcode/exitCbode typos. Fixed config filename, removed invalid runtime import (now commented), used process.exitCode, added .js import and function invocation/finally. Seed typecheck and execution then succeeded.
- Some assistant replies overstated conclusions or gave stale line references. Prefer current file inspection and distinguish completed user evidence from suggestions.

## Later roadmap (context only; do not implement now)

- Phase 2: deliberately vulnerable POST /book-seat; separate check, insert, response; no Redis lock, no transaction wrapper, no idempotency. Keep database seat uniqueness initially. Add read endpoints deriving booked state and reset tooling.
- Phase 3: 100+ concurrent requests for one seat, distinct requests/keys. Run A temporarily drops the unique index to show actual duplicate rows; clean duplicates and recreate the exact index afterward. Run B keeps it and shows one row with messy unhandled unique errors. Save counts and logs. Manual index removal is still temporary schema drift; the old roadmap wording claiming otherwise is inaccurate. Do not run migrations during that experiment.
- Phase 4: fixed flow validates input/header, looks up scoped idempotency, acquires per-seat token lock, rechecks idempotency, checks Booking, stores permanent rejection or atomically commits Booking + idempotency response, releases in finally. Handle seat versus idempotency unique violations distinctly. Replay must validate seat identity. Track backstop hits and deliberately defeat locks in a separate backstop test.
- Concurrent retries can still receive transient LOCK_CONTENDED while an earlier request is in progress; do not promise every simultaneous caller immediately gets an identical replay without additional coordination. The second lookup only catches outcomes committed by the time the lock is acquired.
- Phase 5: expired-key handling, Redis-down behavior (recommended fail closed), validation, documentation/results. Multi-instance/load balancing and multi-seat booking are later stretch/deferred work.
- Seed currently has only three users; if later tests require 100 distinct valid users, expand fixtures at that phase rather than sending nonexistent user IDs.

## Useful commands already used

```sh
npm run build
npm run dev
npx prisma validate
npx prisma migrate status
npx prisma migrate dev --name finalize_schema --create-only
npx prisma migrate dev
npx prisma generate
npx tsc -p prisma/tsconfig.json
npx tsx prisma/seed.ts
npx tsx prisma/check-unique.ts
docker compose up --build
docker compose stop redis
docker compose start redis
```

Supabase SQL seed checks used: `SELECT COUNT(*) FROM "User";` and `SELECT COUNT(*) FROM "Seat";`. Database rows, passwords, connection state, and container state should not be assumed current from historical chat output.

## Handoff creation scope

On 2026-10-13 the assistant inspected the repository, roadmap v2, schema, migration SQL, seed, manual-check script, server/config/client files, container config, and empty scaffold sizes. Git status was initially clean. While the handoff was being written, a user-owned change to `prisma/check-unique.ts` corrected its label to A1; that change was preserved and this document was refreshed. No tests, builds, seed executions, migrations, external writes, or secret reads were performed during handoff creation. The assistant only added this `context.md`.
