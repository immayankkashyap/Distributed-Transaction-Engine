# High-Concurrency Ticket Booking System — Full Phase-Wise Roadmap

> Stack: Express + TypeScript, Prisma → Supabase (Postgres), node-redis, Docker, k6
> Built manually, concepts pre-learned via design discussion. This roadmap sequences the build; deeper learning happens inline as each phase is hit.

---

## Phase 0 — Project Skeleton & Infra Connectivity

**Goal:** Prove every piece of infrastructure can talk to every other piece, before any business logic exists.

- [ ] Init Node + TypeScript project (`tsconfig.json`, `ts-node-dev` or similar for local dev)
- [ ] Install Express, Prisma, node-redis
- [ ] Create Supabase project, grab the **pooled (pgbouncer) connection string** — not the direct one
- [ ] `.env` with `DATABASE_URL` (Supabase) and `REDIS_URL`
- [ ] `docker-compose.yml` — Node app service + Redis service (local dev only; Postgres is Supabase-hosted, not in Compose)
- [ ] One trivial route (`GET /health`) that pings both Postgres (via Prisma) and Redis, returns OK for both
- [ ] Confirm: app boots in Docker, reaches Supabase, reaches Redis

**Exit criteria:** `/health` returns success for both DB and Redis, from inside the container.

---

## Phase 1 — Schema & Migrations

**Goal:** Finalized data model is live in Supabase.

- [ ] Write `schema.prisma`: `User`, `Seat` (+ `SeatStatus` enum), `Booking` (`seatId @unique`), `IdempotencyKey`
- [ ] Run `prisma migrate dev` against Supabase
- [ ] Seed script: create a handful of `Seat` rows (e.g. 10–20) to book against
- [ ] Sanity check: manually insert/query a `User` and `Booking` via Prisma Studio or a script, confirm the `@unique` constraint actually rejects a duplicate `seatId` insert when you try it on purpose

**Exit criteria:** You've personally watched the unique constraint throw an error on a forced duplicate insert.

---

## Phase 2 — Vulnerable Baseline (`/book-seat` without locking)

**Goal:** Build the naive version on purpose, to later prove it's broken.

- [ ] `POST /book-seat` — body: `{ userId, seatId }`
- [ ] Logic: `SELECT` seat status → if available, `INSERT` booking → `UPDATE` seat status to `BOOKED`
- [ ] **No Redis lock. No transaction wrapping. No idempotency yet.** This is deliberate.
- [ ] Keep the `UNIQUE` constraint active (it's part of the schema already) — don't disable it. You want to observe whether the constraint alone catches anything, separately from the Redis lock, in the next phase.
- [ ] `GET /seats` and `GET /seats/:id` — read endpoints to inspect state before/after tests

**Exit criteria:** Endpoint works correctly under normal, non-concurrent use (one request at a time books successfully).

---

## Phase 3 — The Chaos Test (prove the bug exists)

**Goal:** Fire concurrent requests, observe the race condition with your own eyes.

- [ ] Pick a tool: k6 (recommended — industry standard, resume-relevant) or a quick custom Node script using `Promise.all` with concurrent `fetch`/`axios` calls, if you want to start simpler and migrate to k6 later
- [ ] Script: fire 100+ concurrent `POST /book-seat` requests, all targeting the **same single seatId**, with different `userId`s
- [ ] Run it against the Phase 2 baseline
- [ ] After the run: query `SELECT COUNT(*) FROM bookings WHERE seat_id = <that seat>` — see if it's more than 1
- [ ] Record: how many requests got HTTP success? How many bookings actually exist? Does the `UNIQUE` constraint catch some of them (requests crashing with a DB error) even without the lock?
- [ ] Document this output (screenshots/logs) — this "before" data is valuable for your README/resume writeup

**Exit criteria:** You have concrete numbers showing the race condition (or, interestingly, see where the `UNIQUE` constraint alone already provides partial protection — worth noting either way).

---

## Phase 4 — The Fix: Redis Lock + Idempotency

**Goal:** Implement the full correct flow and prove it holds under the same chaos test.

- [ ] Implement lock acquire: `SET lock:seat:<id> <token> NX EX <ttl>` via node-redis
- [ ] Implement lock release: Lua script via node-redis's `scripts` config, checking token match before `DEL`
- [ ] Implement idempotency check/write using the `IdempotencyKey` Prisma model
- [ ] Rebuild `/book-seat` following the finalized order:
  1. Check idempotency key → return stored response if found & valid
  2. Acquire Redis lock → 409 if denied
  3. Check seat status in Postgres
  4. If available: one Prisma `$transaction` — insert `Booking` + insert `IdempotencyKey` together
  5. Release lock (token-checked)
  6. Return response
- [ ] Require `Idempotency-Key` header on the request; reject/handle missing header deliberately (decide and document your behavior)
- [ ] Re-run the exact same Phase 3 chaos test against this version
- [ ] Confirm: exactly 1 request succeeds, the rest get clean 409s (not silent corruption)
- [ ] Bonus check: fire the *same* idempotency key twice deliberately (simulating a client retry) — confirm the second call returns the stored result instead of a 409 or a new booking

**Exit criteria:** Chaos test on the fixed version shows exactly one booking created, rejected requests get sensible responses, and a deliberate retry with the same idempotency key is handled gracefully.

---

## Phase 5 — Polish, Edge Cases & Documentation

**Goal:** Make the project presentable and defensible in an interview.

- [ ] Handle expired idempotency keys correctly (`WHERE expiresAt > now()` check)
- [ ] Decide and implement what happens if Redis is down (lock acquisition fails/errors) — fail closed (reject booking) is the safer default; document why
- [ ] Add basic input validation (seatId/userId exist, are valid)
- [ ] Write the README: problem statement, architecture diagram (API → Redis → Postgres), before/after chaos test results with real numbers, known limitations (no idempotency cleanup job, single-instance only, no multi-seat support yet)
- [ ] Clean commit history / clear code comments at the critical sections (lock acquire, transaction, release) explaining *why*, not just *what*

**Exit criteria:** A stranger (or an interviewer) could read your README and understand the problem, your solution, and see real proof it works — without reading all your code.

---

## Plan 2 (Stretch, time-permitting — do only after Phase 5 is solid)

- [ ] Run 2–3 instances of the Express app (Docker Compose `--scale` or separate containers) behind a simple load balancer (Nginx)
- [ ] Re-run the Phase 3/4 chaos test against the load-balanced cluster — prove the Redis-based lock holds correctness across genuinely separate processes, not just multiple requests to one process
- [ ] Optional: cache seat availability reads in Redis (invalidate on booking) to reduce Postgres read load
- [ ] Optional: tune Prisma/Supabase connection pool sizing, document the pgbouncer gotcha and how you handled it
- [ ] Update README claim from "designed for horizontal scalability" to "verified under multi-instance load" once this is done

---

## V2 (Explicitly Deferred — separate project phase, not part of this roadmap's completion bar)

- [ ] Multi-seat booking in a single request
- [ ] Ordered lock acquisition (sort seat IDs before acquiring, to avoid the cross-request deadlock scenario discussed earlier)
- [ ] Possibly a third `PENDING`/`HELD` seat state for a "temporary hold during checkout" UX, if extending toward a more realistic booking flow

---

## Suggested order of learning-on-the-way

As you hit each phase, these are the things worth looking up/reading as you go rather than before starting:
- **Phase 0:** Prisma + Supabase pooled connection setup docs, Docker Compose basics for a Node service
- **Phase 3:** k6 quickstart (scripting a simple POST load test is a ~30 minute read)
- **Phase 4:** node-redis `scripts` API docs (defining and calling a Lua script), Prisma `$transaction` API
- **Phase 5:** Nothing new technically — mostly writing and polish
