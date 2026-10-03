# High-Concurrency Ticket Booking System — Project Context

> This file is a complete summary of a design discussion for a resume/portfolio project. Paste this into a new chat to continue from where this left off. The project is being built by the user **manually, without AI-generated code** — AI was used only for conceptual learning and architecture discussion.

---

## 1. What This Project Actually Is

**Working title:** High-Concurrency Distributed Transaction Engine (original brief's name — aspirational framing)

**What it actually is, precisely:** A concurrency-safe **ticket/seat booking backend** for a single contested resource type (seats). It is a focused, simplified study of the one hardest technical problem that real systems like BookMyShow/District face — preventing double-booking when thousands of requests hit the same seat concurrently — stripped of all unrelated product surface area.

**Explicitly NOT in scope:**
- Seat maps/visual layouts
- Payments/payment gateway integration
- Multiple shows/venues/showtimes
- Search, recommendations, notifications, cancellations
- A generic/pluggable "transaction engine" abstraction (that would be a different, much larger project)

**Honest framing for resume/README:**
> "A concurrency-safe booking service for a single contested resource type (seats), built to demonstrate distributed locking and idempotency patterns that generalize to any high-contention resource-allocation problem — e.g., payments, inventory, reservations."

**Why this project is a good fit for Stripe specifically:** Stripe's core business is money moving under concurrent load with zero tolerance for double-processing. Idempotency keys, race conditions on balance updates, and distributed locks are close to the center of Stripe's engineering culture (their public API itself requires idempotency keys on mutating requests). This project's core failure mode (double-booking) is the conceptual twin of "double-charging a customer."

---

## 2. Core Conceptual Problems Solved (in the order discussed)

### 2.1 The Race Condition (TOCTOU bug)

**Root cause:** The gap between "check" (read) and "act" (write) is not atomic. Two requests can both read "available" before either writes "booked."

```
Request A: SELECT status FROM seats WHERE id=1   → 'available'
Request B: SELECT status FROM seats WHERE id=1   → 'available'   (A hasn't written yet)
Request A: INSERT booking + UPDATE seat → 'booked'  → succeeds
Request B: INSERT booking + UPDATE seat → 'booked'  → succeeds
```

Result: **silent data corruption** — two valid-looking booking rows for one seat, no error thrown, nothing crashes. Only discoverable via data audit.

**Key distinction learned:** This is NOT a deadlock. Deadlock = processes frozen, waiting on each other, nothing proceeds. Race condition = nothing is blocked, everything "succeeds," but the result is wrong. Race conditions are scarier because they fail silently.

**Formal name:** TOCTOU (Time Of Check to Time Of Use) bug.

### 2.2 Lock Granularity: Per-Seat, Not Global

**Reasoning:** Lock scope should be the smallest set of data where two concurrent operations could actually conflict. Two different seats share no data, so they can safely proceed in true parallel — a global lock would force unrelated bookings to queue behind each other unnecessarily.

**Rule derived:** `Lock scope = the smallest set of data where two concurrent operations could conflict.` Too wide = correctness but wasted waiting. Too narrow = speed but reintroduced race condition.

**Decision: per-seat locking** (`lock:seat:<seatId>`).

### 2.3 Multi-Seat Deadlock (deferred to V2)

If a single request needs multiple locks (e.g., booking 4 seats together), acquiring them in arbitrary order can deadlock:

```
Customer A wants [5, 6] → acquires 5, waits for 6
Customer B wants [6, 5] → acquires 6, waits for 5
→ both stuck forever (circular wait)
```

**Standard fix (for V2, not yet implemented):** Always acquire locks in a consistent, predetermined order (e.g., sort seat IDs numerically before acquiring any locks). Same idea as the classic dining-philosophers problem solution.

**Scope decision:** V1 = single-seat booking only, no multi-lock ordering needed. V2 = extend to multi-seat booking and implement ordered lock acquisition.

### 2.4 Why a Naive In-Memory/SQL Lock Still Has the Same Bug

```js
if (locks[seatId] === undefined) {   // CHECK
  locks[seatId] = true;               // ACT
}
```

This has the exact same TOCTOU shape as the original bug — two requests can both see `undefined` before either sets the flag, if there's an `await` boundary between the check and the act (true for any real Redis/DB call; pure synchronous JS on a single thread would NOT race, but real async code always has this gap).

**Key realized pattern:** Every fix in this project is "turn a check-then-act sequence into one atomic operation." This repeats three times: (1) the booking itself, (2) lock acquisition, (3) lock release.

**Important correction made during discussion:** `UPDATE seats SET isLocked = true WHERE id = 42 AND isLocked = false` in Postgres IS actually atomic too (Postgres evaluates WHERE and performs the update as one atomic step per row). So Redis is NOT chosen because Postgres can't do atomic check-and-set — it's chosen for **operational reasons**:
- Speed (in-memory vs disk-backed round trip)
- Not consuming limited Postgres connection pool slots for lock churn
- Built-in TTL/expiry (auto-releases on crash)
- Separation of concerns (Postgres = durable source of truth; Redis = disposable fast coordination layer)

### 2.5 Redis `SET NX EX` — The Atomic Lock Primitive

```
SET lock:seat:42 "<unique-token>" NX EX 5
```
- `NX` = only set if key does not already exist
- `EX 5` = auto-expire after 5 seconds (protects against crashed holder)
- Redis executes this as ONE atomic internal operation (single-threaded command execution) — no gap between check and set, even under massive concurrent load.

### 2.6 Safe Lock Release (the token problem)

**The danger of naive release:**
```
Time 0:   Request A acquires lock, TTL=5s
Time 0-6: A gets stuck (slow query, GC pause, etc.)
Time 5:   TTL expires, Redis auto-deletes the lock
Time 5.1: Request B acquires the now-free lock
Time 6:   A finally finishes, blindly does DEL lock:seat:42
              → deletes B's lock, not its own!
```
This reintroduces the race condition one level removed — a third request C could now acquire while B is still mid-operation.

**The fix: ownership tokens + atomic Lua script**
- Acquire with a unique random token: `SET lock:seat:42 "<token>" NX EX 5`
- Release only if the token still matches, via an atomic Lua script (NOT two separate Redis calls, which would reintroduce TOCTOU again):

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end
```

Redis guarantees Lua scripts run atomically — no other command interleaves mid-script.

### 2.7 Redis Crash Scenario — Why a `UNIQUE` Constraint Is Still Needed

**Scenario:** Even with a correct lock, if Redis crashes/flushes mid-transaction (after a request has read "available" but before it writes "booked"), a second request can slip in, acquire the now-nonexistent lock, and also book the seat. The lock alone is not a complete guarantee.

**Resolved question: does this need a third seat status (`pending`)?**
**No** — a third status doesn't fix this (writing "pending" has the same check-then-act shape as the original bug, just moved). The actual fix is a `UNIQUE` constraint on `Booking.seatId` — this makes it **structurally impossible** for two booking rows to exist for the same seat, enforced by Postgres itself regardless of what the application layer believed.

**Design principle: defense in depth.** Redis lock = fast-path guard (handles the common case cheaply). `UNIQUE` constraint = correctness guarantee of last resort (catches the rare case where the lock layer fails).

**Note:** A third state (`PENDING`/`HELD`) IS genuinely needed for a *different*, deferred feature — temporary seat holds while a user is on a payment page (like BookMyShow's "seat reserved for 5 minutes" UX). This is a product feature, not a V1 correctness requirement.

**Why the constraint must live on `Booking.seatId`, not derived from `Seat.status` alone:** The duplicate rows show up in the `bookings` table (two INSERTs both succeeding), not the seats table. Even if `Seat.status = BOOKED`, nothing inherently stops a second `INSERT INTO bookings` unless the DB itself enforces uniqueness on `seatId`.

### 2.8 Idempotency Keys (separate problem from locking)

**Definition:** An operation is idempotent if doing it once has the same effect as doing it N times. `POST /book-seat` is NOT naturally idempotent — calling it twice naively creates two bookings.

**Critical distinction:**
- **Lock solves:** two *different* requests (different users) racing for the same seat.
- **Idempotency solves:** the *same single logical request* (same user's intent) being sent more than once — due to client retry after timeout, network blips, double-tap bugs, load balancer retries, etc.

The lock does NOT protect against this — its job is to let the first request through, and a retry of that same request looks identical to the lock.

**Mechanism:**
1. Client generates a unique key (UUID) per logical attempt, sent as `Idempotency-Key` header.
2. On retry, client reuses the SAME key (does not generate a new one for the same intention).
3. Server checks: has this key been seen before?
   - Yes → return the stored response immediately, do nothing else.
   - No → process normally, then store the key + response.

**Why this must be client-generated, not server-inferred:** `userId + seatId` isn't a reliable uniqueness signal — a user might legitimately want to book the same seat twice in unrelated situations (e.g., booked, cancelled, re-booking later). Only the client knows whether this is "the same intention" or "a new one."

**Why storing the key must be atomic with the booking write:** If the server crashes between "booking succeeded" and "key saved separately," a retry would not find the key and could create a duplicate booking (relying on the `UNIQUE` constraint to catch it, but then the response is a confusing error instead of the graceful original result). **Resolution: wrap the `Booking` insert and `IdempotencyKey` insert in the SAME Postgres transaction** — either both commit or neither does.

**Important realization (user's own insight, confirmed correct):** The scenario "transaction committed successfully but the HTTP response got lost on the way back to the client" is NOT a flaw idempotency fails to cover — it is literally the exact scenario idempotency keys exist to handle. On retry, the client resends the same key, the server finds the already-committed result, and returns it. **Idempotency doesn't prevent responses from getting lost — it makes it safe not to know whether they did, by making retries harmless.**

### 2.9 Correct Request Ordering Inside `/book-seat`

A wrong ordering attempt was walked through and corrected. The final correct order:

```
1. Check idempotency key FIRST
   → found (not expired)? Return stored response immediately. STOP.
   → not found? continue.

2. Acquire Redis lock for seatId (SET NX EX with unique token)
   → denied? Return 409 Conflict. STOP.
   → acquired? continue.

3. Check seat status in Postgres (now safely inside the lock)

4. If available: run ONE Postgres transaction that does both:
      - INSERT Booking (seatId UNIQUE constraint = backstop)
      - INSERT IdempotencyKey (same key, storing this response)
   If not available: prepare a failure response

5. Release lock (via token-check Lua script, NOT a blind DEL)

6. Return response
```

**Why idempotency check must come BEFORE lock acquisition (not just before the DB check):** If two retries of the *same* original request arrive close together, and idempotency is checked only after lock acquisition, the second retry would try to acquire a lock already held by the first retry — and get a **false 409 "seat taken by someone else,"** when actually it was its own earlier attempt. Checking idempotency first avoids this in the case where the first attempt already finished and wrote the key. (A known, acceptable V1 limitation: if both retries arrive before either has written the key yet, a transient 409 can still occur — not over-engineered for in V1.)

---

## 3. Tech Stack (finalized)

| Layer | Choice | Reasoning |
|---|---|---|
| Backend framework | **Express + TypeScript** | Pure backend focus, no UI needed; Next.js API routes would add unnecessary frontend-framework surface area for zero benefit here |
| Redis client | **node-redis** (not ioredis) | Official, vendor-maintained client. Originally ioredis was suggested for easier Lua script ergonomics (`defineCommand`), but user correctly pointed out node-redis v4+ now supports named Lua functions via its `scripts` config object, closing that gap. Chosen for "boring, officially-supported tooling" as a deliberate engineering-judgment signal. |
| ORM | **Prisma** | Type-safe queries, clean transaction API |
| Database hosting | **Supabase** (hosted Postgres) | User intends to actually deploy this project, not just run it locally — so local Docker Postgres was dropped in favor of a hosted instance |
| Containerization | **Docker** — scoped down to just the Node/Express app (and optionally Redis for local dev); Postgres is no longer in Docker Compose since it's hosted on Supabase | |
| Load testing | k6 suggested as the stronger choice over a custom script (industry standard, resume-relevant) | |

**Known gotcha flagged:** Prisma + serverless/stateless deploy + Supabase Postgres connection pooling is a known pain point — must use Supabase's **pooled connection string (pgbouncer mode)**, not the direct one, or risk exhausting connections under load (ironic given the whole project is about handling load).

---

## 4. Scalability Scope Decision

Two different concepts, deliberately not conflated:
- **Concurrency correctness** — does the system stay correct when many requests hit the same resource at once? (This is the locking/idempotency work above.)
- **Scalability** — can the system handle more total load by adding more resources (servers), without breaking? (A separate concern.)

**V1 (current plan):** Single running instance, but the Redis locking layer is architected *as if* multiple instances exist — no in-memory state anywhere, everything coordinated purely through Redis. This is "scalability-ready design," not yet empirically proven.

**Plan 2 (later, time-permitting, NOT part of core V1):**
- Actually run 2–3 instances of the Express app behind a load balancer (e.g., Nginx or Docker Compose scaling)
- Re-run the chaos/stress test against the real multi-instance cluster to empirically prove the lock holds correctness across genuinely separate processes
- Possibly: read-caching for seat availability (cache reads in Redis, invalidate on booking), connection pool tuning
- Explicitly deferred/optional: Kubernetes/auto-scaling infra — flagged as high risk of looking impressive without being properly load-tested, which is worse than not having it

**Honest README framing depending on how far the project gets:**
- If only V1 done: "designed for horizontal scalability, single-instance deployed"
- If Plan 2 done: "verified under multi-instance load" (stronger claim, also true)

---

## 5. Database Schema (Prisma)

```prisma
model User {
  id        String   @id @default(uuid())
  name      String
  createdAt DateTime @default(now())
  bookings  Booking[]
}

model Seat {
  id        String     @id @default(uuid())
  label     String     // e.g. "A1", "Row-5-Seat-12"
  status    SeatStatus @default(AVAILABLE)
  booking   Booking?
  createdAt DateTime   @default(now())
}

enum SeatStatus {
  AVAILABLE
  BOOKED
}
// NOTE: Two states are sufficient for V1 (see section 2.7 reasoning).
// A third state (PENDING/HELD) is deferred — only needed for a future
// "temporary hold during payment" feature, not for crash-safety.

model Booking {
  id        String   @id @default(uuid())
  userId    String
  seatId    String   @unique   // THE critical constraint — structural guarantee,
                                 // catches double-booking even if Redis lock fails
  user      User     @relation(fields: [userId], references: [id])
  seat      Seat     @relation(fields: [seatId], references: [id])
  createdAt DateTime @default(now())
}

model IdempotencyKey {
  id         String   @id @default(uuid())
  key        String   @unique   // the client-sent Idempotency-Key header value
  response   Json                // stored response payload (success or failure)
  statusCode Int                 // so the exact original HTTP status can be replayed
  expiresAt  DateTime
  createdAt  DateTime @default(now())
}
```

**Idempotency storage decision:** Postgres (Prisma model) chosen over Redis, specifically for **durability** — idempotency is a correctness guarantee (protects against duplicate bookings/charges), not a performance optimization, so it should survive a Redis crash. Also allows writing the `IdempotencyKey` row in the SAME transaction as the `Booking` insert (see section 2.8).

**Expiry logic (since Postgres has no native TTL):**
- Part 1 (required): treat expired keys as "not found" at read time — `WHERE expiresAt > now()` check in the lookup query. This alone makes expiry functionally correct.
- Part 2 (cleanup, optional for V1): no active deletion needed for a portfolio-scale demo. Documented as a known limitation / future-work item (a real system would need a scheduled cleanup job, e.g. `pg_cron` or an app-level periodic `DELETE WHERE expiresAt < now()`).

---

## 6. API Surface (planned, not yet built)

```
POST   /book-seat          — core endpoint (see ordering in section 2.9)
GET    /seats               — list seats + status (for chaos-test setup/verification)
GET    /seats/:id            — single seat status (debugging)
GET    /bookings/:userId    — a user's bookings (manual testing/demo)
```

`POST /book-seat` request needs: `userId`, `seatId` in body, `Idempotency-Key` header.

---

## 7. Development Phases (as currently understood, adapted from original brief)

- **Phase 0 (added, not in original brief):** Project skeleton — Docker Compose for Node app (+ Redis for local dev), confirm connectivity to Supabase Postgres via Prisma, before any business logic.
- **Phase 1:** Finalize schema (above), run Prisma migrations against Supabase.
- **Phase 2:** Build the **vulnerable baseline** `/book-seat` — deliberately no Redis lock, naive check-then-act. (Still keep the `UNIQUE` constraint on `Booking.seatId` even here, so later comparisons can show "DB constraint alone" vs "DB + Redis lock" as separate experiments, not just a binary before/after.)
- **Phase 3:** Chaos test — fire 100+ concurrent requests at the same seat (k6 preferred over custom script), observe double-booking by querying the DB afterward.
- **Phase 4:** Implement the fix — Redis lock (per-seat, `SET NX EX` + token-based Lua release) + idempotency keys, following the exact ordering in section 2.9. Re-run chaos test, show ~1 success and the rest cleanly rejected (409s / idempotent replays).
- **Phase 5 (stretch, Plan 2):** Multi-instance deployment + load balancer, re-run chaos test against the real cluster. Possibly read-caching, connection pool tuning.
- **V2 (explicitly deferred):** Multi-seat booking with ordered lock acquisition to avoid deadlock (section 2.3).

---

## 8. Where the Conversation Left Off

Just finished nailing down the exact request ordering for `/book-seat` (section 2.9) and why idempotency must be checked before lock acquisition. **Next step was about to be:** continuing the API/architecture discussion — likely next would be the actual Express route handler structure, how Prisma transactions are expressed in code, and how the Lua release script gets wired up via node-redis's `scripts` config. Schema and core architecture are conceptually settled; no code has been written yet (by design — user wants to build it manually).
