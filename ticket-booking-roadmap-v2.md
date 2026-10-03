# High-Concurrency Ticket Booking System — Phase-Wise Roadmap (v2)

> Stack: Express + TypeScript, Prisma → Supabase (Postgres), node-redis, Docker, k6
> Built manually, concepts pre-learned via design discussion. This roadmap sequences the build; deeper learning happens inline as each phase is hit.
>
> **v2 changes:** see the changelog at the bottom.

---

## Design decisions locked in v2

These are settled up front so the phases below don't have to relitigate them.

1. **No `Seat.status` column.** A seat is booked if and only if a `Booking` row exists for it. One source of truth, so the seat table and booking table can never disagree after a crash. `GET /seats` derives availability by joining against `Booking`.
2. **Two distinct rejection reasons**, both HTTP 409 but with different `code` fields in the body:
   - `LOCK_CONTENDED` — someone else currently holds the seat lock (a booking is in flight). Transient.
   - `SEAT_ALREADY_BOOKED` — a booking for this seat already exists. Permanent.
3. **Only permanent outcomes are stored as idempotent responses.** `201 Created` and `SEAT_ALREADY_BOOKED` are stored against the key. `LOCK_CONTENDED` is **not** stored, so a client retrying with the same key can still succeed once the lock frees up.
4. **Idempotency is checked twice:** once before the lock (cheap fast path) and once immediately after acquiring it (closes the window where an earlier attempt with the same key committed between your first check and your lock acquisition).
5. **Lock release always happens in a `finally` block**, on every path after a successful acquire.

---

## Phase 0 — Project Skeleton & Infra Connectivity

**Goal:** Prove every piece of infrastructure can talk to every other piece, before any business logic exists.

- [ ] Init Node + TypeScript project (`tsconfig.json`, `ts-node-dev` or similar for local dev)
- [ ] Install Express, Prisma, node-redis
- [ ] Create Supabase project and collect **both** connection strings:
  - the **pooled (pgbouncer) string** → used by the running app (`DATABASE_URL`)
  - the **direct string** → used only by Prisma migrations (`DIRECT_URL`)
- [ ] `.env` with `DATABASE_URL` (pooled), `DIRECT_URL` (direct), `REDIS_URL`
- [ ] In `schema.prisma` datasource block, set both `url = env("DATABASE_URL")` and `directUrl = env("DIRECT_URL")`. Without `directUrl`, `prisma migrate dev` will fail or hang through the pooler.
- [ ] Check the Prisma + Supabase docs for the pgbouncer flag the pooled URL needs
- [ ] `docker-compose.yml` — Node app service + Redis service (local dev only; Postgres is Supabase-hosted, not in Compose)
- [ ] One trivial route (`GET /health`) that pings both Postgres (via Prisma) and Redis, returns OK for both
- [ ] Confirm: app boots in Docker, reaches Supabase, reaches Redis

**Exit criteria:** `/health` returns success for both DB and Redis, from inside the container.

---

## Phase 1 — Schema & Migrations

**Goal:** Finalized data model is live in Supabase.

- [ ] Write `schema.prisma` with four models: `User`, `Seat` (id, label, createdAt — **no status field, no enum**), `Booking` (`seatId @unique`), `IdempotencyKey`
- [ ] Run `prisma migrate dev` (goes through `DIRECT_URL`)
- [ ] Seed script: create a handful of `Seat` rows (10–20) and a few `User` rows to book against
- [ ] Sanity check: manually insert a `Booking`, then try a second `Booking` for the same `seatId` on purpose
- [ ] Find the name of the unique index Postgres created on `Booking.seatId` (Prisma default is typically `Booking_seatId_key`; verify in the Supabase SQL editor). You need this name in Phase 3 to drop and restore it.

**Exit criteria:** You've personally watched the unique constraint throw an error on a forced duplicate insert, and you know the exact index name.

---

## Phase 2 — Vulnerable Baseline (`/book-seat` without locking)

**Goal:** Build the naive version on purpose, to later prove it's broken.

- [ ] `POST /book-seat` — body: `{ userId, seatId }`
- [ ] Logic, three separate awaited steps with nothing wrapping them:
  1. query: does a `Booking` exist for this `seatId`?
  2. if none: `INSERT` booking
  3. return success
- [ ] **No Redis lock. No transaction wrapping. No idempotency yet.** This is deliberate.
- [ ] Keep the `UNIQUE` constraint active for now (it is part of the schema)
- [ ] `GET /seats` and `GET /seats/:id` — return each seat with a derived `booked: boolean` (join/include on `Booking`)
- [ ] `GET /bookings/:userId` for manual inspection
- [ ] A small reset script/endpoint to delete all bookings between test runs

**Exit criteria:** Endpoint works correctly under normal, non-concurrent use (one request at a time books successfully; a second request for the same seat is rejected).

---

## Phase 3 — The Chaos Test (prove the bug exists)

**Goal:** Fire concurrent requests and produce two distinct "before" data sets: the raw race, and what the constraint alone achieves.

**Test setup**
- [ ] Pick a tool: k6 (recommended — industry standard, resume-relevant), or a quick `Promise.all` script to start and migrate to k6 later
- [ ] Script: fire 100+ concurrent `POST /book-seat` requests, all at the **same single `seatId`**, each with a **different `userId`**
- [ ] If using k6: generate a **unique `Idempotency-Key` per request** (e.g. combine `__VU`, `__ITER`, and a timestamp or random value). A shared key would make later phases replay one response and invalidate the results. (The baseline ignores the header, but build the habit now so the same script works in Phase 4.)

**Run A — constraint dropped (the raw race)**
- [ ] In the Supabase SQL editor (not a Prisma migration, to avoid schema drift), drop the unique index on `Booking.seatId`
- [ ] Reset bookings, run the test against the Phase 2 baseline
- [ ] Query `SELECT COUNT(*) FROM "Booking" WHERE "seatId" = <seat>` — expect **more than 1**
- [ ] Record: HTTP success count, actual booking row count
- [ ] Before moving on: delete the duplicate rows, then **recreate the unique index** (same name as before). Verify with the forced-duplicate check from Phase 1.

**Run B — constraint on (what the DB alone gives you)**
- [ ] Reset bookings, run the identical test again
- [ ] Record: how many requests returned success, how many crashed with a unique-violation (likely 500s from the unhandled error), final booking row count (expect exactly 1)
- [ ] Note the lesson: the constraint prevents corruption, but the API still misbehaves (errors instead of clean rejections, and many requests do wasted work)

**Documentation**
- [ ] Save logs/screenshots of both runs. This A-vs-B comparison is the core "before" evidence for your README.

**Exit criteria:** Run A shows more than one booking for one seat (the corruption). Run B shows the constraint containing it but with messy failures. You have numbers for both.

---

## Phase 4 — The Fix: Redis Lock + Idempotency

**Goal:** Implement the full correct flow and prove it holds under the same chaos test.

**Building blocks**
- [ ] Lock acquire: `SET lock:seat:<id> <token> NX EX <ttl>` via node-redis, with a random unique token per attempt
- [ ] Lock release: Lua script via node-redis's `scripts` config (check the docs for your installed version; mind `NUMBER_OF_KEYS`), deleting the key only if the token matches
- [ ] Idempotency repository: lookup (`WHERE expiresAt > now()`) and insert, using the `IdempotencyKey` model
- [ ] Decide and document behavior when the `Idempotency-Key` header is missing (recommended: reject with 400)

**The `/book-seat` flow (final order)**

1. Validate input and header
2. **Idempotency lookup #1** → found and unexpired: replay stored status + body, stop
3. Acquire Redis lock → denied: return `409 LOCK_CONTENDED`, **do not store** against the key, stop
4. *(from here on, every path releases the lock in a `finally`)*
5. **Idempotency lookup #2 (inside the lock)** → found: replay, stop
6. Check whether a `Booking` exists for the seat
   - exists: store key + `409 SEAT_ALREADY_BOOKED` response, return it
7. Not booked: one Prisma `$transaction` inserting `Booking` + `IdempotencyKey` together
   - unique violation on `seatId` (Prisma `P2002`) → the backstop fired; return `409 SEAT_ALREADY_BOOKED` and **increment/log a backstop-hit counter**
   - unique violation on the idempotency `key` → a concurrent attempt with the same key won; look it up and replay
   - any other error → 500, nothing stored
8. Release lock (token-checked) in `finally`
9. Return `201` with the booking

**Verification**
- [ ] Re-run the exact Phase 3 test (unique key per request) against the fixed version
- [ ] Tally responses by status **and** `code`. Expected: exactly 1 × `201`, the remainder split between `LOCK_CONTENDED` and `SEAT_ALREADY_BOOKED`, backstop-hit counter at 0, zero 500s, exactly 1 booking row
- [ ] **Retry test:** send the *same* idempotency key twice, sequentially → second call returns the stored `201` with the same booking, no second row
- [ ] **Concurrent retry test:** send the same key several times at once → exactly one booking, all callers get a consistent result (this is what lookup #2 and the key-conflict branch exist for)
- [ ] **Backstop test:** deliberately defeat the lock (e.g. flush Redis or delete the lock key mid-run, or temporarily disable the lock check) and re-run → the UNIQUE constraint still prevents a second row, and the backstop counter is greater than 0. This is your proof of defense in depth.

**Exit criteria:** Chaos test shows exactly one booking, every rejection carries a meaningful `code`, both retry tests pass, and the backstop test shows the constraint catching what the lock missed.

---

## Phase 5 — Polish, Edge Cases & Documentation

**Goal:** Make the project presentable and defensible in an interview.

- [ ] Verify expired idempotency keys are treated as not found
- [ ] Decide and implement behavior when Redis is down (recommended: fail closed — reject the booking — and document why)
- [ ] Input validation (seatId/userId exist and are well-formed)
- [ ] README: problem statement, architecture diagram (API → Redis → Postgres), the Phase 3 Run A / Run B results and the Phase 4 results with real numbers, the backstop test, and known limitations (no idempotency cleanup job, single-instance only, no multi-seat support yet)
- [ ] Clean commit history and comments at the critical sections (lock acquire, second idempotency check, transaction, `finally` release) explaining *why*, not just *what*

**Exit criteria:** A stranger could read the README and understand the problem, the solution, and see real proof it works without reading the code.

---

## Plan 2 (Stretch, time-permitting — only after Phase 5 is solid)

- [ ] Run 2–3 instances of the Express app (Docker Compose `--scale` or separate containers) behind a simple load balancer (Nginx)
- [ ] Re-run the Phase 3/4 tests against the cluster — prove the Redis lock holds across genuinely separate processes
- [ ] Optional: cache seat availability reads in Redis (invalidate on booking)
- [ ] Optional: tune Prisma/Supabase connection pool sizing, document the pgbouncer gotcha and how you handled it
- [ ] Update README claim from "designed for horizontal scalability" to "verified under multi-instance load" once done

---

## V2 (Explicitly Deferred)

- [ ] Multi-seat booking in a single request
- [ ] Ordered lock acquisition (sort seat IDs before acquiring, to avoid cross-request deadlock)
- [ ] Possibly a `PENDING`/`HELD` state for a "temporary hold during checkout" UX. Note: this is where a status column would legitimately come back, as a product feature rather than a correctness mechanism.

---

## Suggested order of learning-on-the-way

- **Phase 0:** Prisma + Supabase pooled/direct connection setup, Docker Compose basics for a Node service
- **Phase 3:** k6 quickstart (scripting a POST load test with per-iteration unique headers)
- **Phase 4:** node-redis `scripts` API docs, Prisma `$transaction` API, how Prisma surfaces `P2002` errors
- **Phase 5:** Nothing new technically — mostly writing and polish

---

## Changelog (v1 → v2)

| # | Problem in v1 | Fix in v2 |
|---|---|---|
| 1 | Phase 3 ran with the UNIQUE constraint on, so `COUNT(*) > 1` could never appear | Two runs: A with the index dropped (raw race), B with it on (constraint alone); index name captured in Phase 1, restored after Run A |
| 2 | Phase 4 transaction didn't update `Seat.status`, risking booking/status disagreement | `Seat.status` and the enum removed; availability derived from `Booking` existence |
| 3 | Idempotency checked only once, before the lock | Second lookup added right after lock acquisition, plus handling for same-key unique violation |
| 4 | "Clean 409s" didn't distinguish why a request was rejected | `LOCK_CONTENDED` vs `SEAT_ALREADY_BOOKED` codes; only permanent outcomes stored against the key; results tallied by code |
| 5 | Migrations would fail through the Supabase pooler | `DIRECT_URL` + `directUrl` added in Phase 0 |
| 6 | Load test could reuse one idempotency key, replaying a single response | Unique key per request in k6; shared key only in the deliberate retry tests |
| 7 | Release only mentioned as a final step | Release in `finally` on every post-acquire path |
| 8 | Only the lock path was tested | Added backstop test (defeat the lock, show UNIQUE still holds) and concurrent same-key retry test |
