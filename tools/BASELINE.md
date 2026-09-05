# POH Firestore reads — measured baseline (emulator)

Measured against the Firebase Emulator Suite with representative seed data
(147 residents; 2 events with 60 + 120 contributions and 15 + 15 expenses;
6 notices; 7 committee; 250 auditLogs; 10 users + 8 invites; small expansion +
feedback sets). Server reads are counted exactly inside the callables
(`pohReadStats` atomic counter); client reads are `getDocs().size`; rule reads
are analytic (one `get(users)` per guarded direct query).

Reproduce:
```
# terminal 1 — start emulators with the bundled JDK + read counter
JAVA_HOME=tools/jdk/jdk-21.0.12+8/Contents/Home PATH=$JAVA_HOME/bin:$PATH \
  POH_COUNT_READS=1 firebase emulators:start --only auth,firestore,functions --project poh-community-portal

# terminal 2 — seed then measure
cd tools
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
  GCLOUD_PROJECT=poh-community-portal node seed-emulator.mjs
node measure-baseline.mjs
```

## Results (BEFORE any optimization)

| Scenario | server | client | rules | **TOTAL** |
|---|---:|---:|---:|---:|
| **A. Resident login → dashboard** (full bootstrap) | 179 | 225 | 8 | **412** |
| B. Open Resident Directory (cached in-memory) | 0 | 0 | 0 | **0** |
| C. Open own flat details (cached in-memory) | 0 | 0 | 0 | **0** |
| D. Parking & Vehicles (cached in-memory) | 0 | 0 | 0 | **0** |
| **E. Admin login → admin dashboard** (full bootstrap) | 416 | 475 | 8 | **899** |
| F. Per in-session WRITE (resident) → full reload | 179 | 225 | 8 | **412** |
| &nbsp;&nbsp;&nbsp;Per in-session WRITE (admin) → full reload | 416 | 475 | 8 | **899** |
| &nbsp;&nbsp;&nbsp;Feedback tab (resident) | 23 | 0 | 0 | **23** |
| **G. Page/browser refresh** | = A (resident) / E (admin) | | | **412 / 899** |
| **H. Close & reopen app** | = A / E | | | **412 / 899** |

## Reconciliation (why the numbers are what they are)

**Resident A = 412**
- server 179 = status 1 · directory (1 + 147) · commonPool (1 + 1) · expansion (1 + 27)
- client 225 = events 2 · notices 6 · committee 7 · auditLogs 0 (denied) · finance 210 (event1 60+15, event2 120+15)
- rules 8 = one `get(users)` per guarded direct query (events, notices, committee, auditLogs, 2×2 finance)

**Admin E = 899** = resident 412 + auditLogs 250 (now readable) + `list` (1+12+8=21) + `settlementSummary` (1 + events 2 + eventFigures 212 + fund 1 = 216).

## Headlines

- Every login, **every refresh, every reopen, and every single write** re-runs the full bootstrap: **412 reads (resident) / 899 (admin)**.
- Directory (148) and per-event finance (210, most of it a **closed** event that never changes) dominate.
- `auditLogs` (250 and growing without bound) is the admin-only spike.
- These measured numbers are **higher** than the Phase-1 estimate (~350 / ~800), confirming the audit was, if anything, conservative.

## Projected daily reads (measured per-session × usage)

Blended ≈ 430 reads/session (mostly resident), ~3 sessions/user/day ≈ 1,290 reads/user/day.

| DAU | reads/day | under 50k free quota? |
|---:|---:|:--:|
| 50 | ~64,500 | ❌ |
| 100 | ~129,000 | ❌ |
| 200 | ~258,000 | ❌ |
| 300 | ~387,000 | ❌ |
| 500 | ~645,000 | ❌ |

Even 50 daily users exceed the free tier today. Target after the CRITICAL +
HIGH optimizations: ~30–45 reads/session (see the audit's §12), which brings
300 DAU comfortably under 50k.

---

## After the CRITICAL batch (C-1 + C-2) — measured

- **C-1**: load contributions/expenses only for **non-closed** events; closed
  events use their frozen `settlementFigures` summary (0 sub-reads) and are
  lazy-loaded only when their dashboard is opened.
- **C-2**: resident profile / vehicle edits do a **scoped directory refresh**
  instead of re-running the whole bootstrap.

| Scenario | before | after | Δ |
|---|---:|---:|---:|
| A. Resident login → dashboard | 412 | **275** | −33% |
| E. Admin login → dashboard | 899 | **762** | −15% |
| F. Resident in-session WRITE | 412 | **148** | −64% |
| Admin in-session WRITE | 899 | **762** | −15% |
| G/H. Refresh / reopen (resident) | 412 | **275** | −33% |

Remaining dominant costs (addressed by the HIGH batch, not yet done):
directory 148 (H-1 cache + version sentinel), active-event finance 75 and
admin `settlementSummary` re-reading all events server-side (M-3), auditLogs 250
for admins (H-4 pagination), expansion 27 eager (H-3 lazy). With those, the
per-session target of ~30–45 reads (300 DAU under free tier) is reachable.

Reproduce the after-numbers: same steps as above (the harness driver mirrors the
new client logic — closed-event finance skipped, resident write = directory only).

---

## After the HIGH batch (H-1, H-3, H-4) — measured

- **H-1**: directory cached in localStorage (5-min TTL, masked/non-editor view
  only); refresh/reopen within the TTL skips the 148-read directory fetch. Own
  edits force a fresh fetch.
- **H-3**: the 4 expansion collections are lazy-loaded on first open of
  Amenities/Move/Contacts/Gallery or the admin console, not eagerly at bootstrap.
- **H-4**: `auditLogs` read as `orderBy(createdAt desc) limit(50)` instead of the
  whole (unbounded) collection; non-admins skip it entirely.

| Scenario | baseline | after CRITICAL | after HIGH | total Δ |
|---|---:|---:|---:|---:|
| A. Resident login (cold) | 412 | 275 | **246** | −40% |
| **G/H. Resident refresh / reopen (warm cache)** | 412 | 275 | **98** | **−76%** |
| E. Admin login (cold) | 899 | 762 | **534** | −41% |
| F. Resident write (scoped) | 412 | 148 | **148** | −64% |
| First open Amenities/Move/etc | (in bootstrap) | (in bootstrap) | **28** once | now lazy |
| Feedback tab | 23 | 23 | 23 | — |

Reconciliation: resident cold 246 = server 151 (status 1 + directory 148 +
commonPool 2) + client 90 (active-event finance 75 + events 2 + notices 6 +
committee 7) + rules 5. Warm refresh 98 = same minus the directory call (server
drops 148→3). Admin cold 534 = server 388 (…+ list 21 + settlementSummary 216) +
client 140 (audit now 50, not 250) + rules 6.

## Revised daily projection (measured)

Assuming a resident's day ≈ 2 cold sessions + 2 warm refreshes + 1 expansion open
≈ 2×246 + 2×98 + 28 ≈ **~570 reads/user/day** (was ~1,290 at baseline, −56%):

| DAU | reads/day | under 50k free quota? |
|---:|---:|:--:|
| 50 | ~28,500 | ✅ comfortable |
| 80 | ~45,600 | ✅ (near limit) |
| 100 | ~57,000 | ⚠️ slightly over |
| 200 | ~114,000 | ❌ |
| 300 | ~171,000 | ❌ |

From "even 50 DAU breaks the free tier" to **comfortably supporting ~80 daily
users free**. Reaching 300–500 DAU needs the MEDIUM batch (below).

---

## After the MEDIUM batch (M-A directory version sentinel, M-3 admin finance dedup) — measured

- **M-A**: a `pohMeta/directoryVersion` counter is bumped on every residents
  write. `status`/`directory` return it; the client reuses its cached directory
  whenever the version is unchanged — so **most** returning-resident sessions
  read **0** directory docs (not just refreshes within a 5-min TTL). The TTL is
  now just a 12h safety backstop.
- **M-3**: the admin `settlementSummary` reuses each closed event's frozen
  `settlementFigures` instead of re-reading its contributions/expenses.

| Scenario | baseline | CRITICAL | HIGH | MEDIUM |
|---|---:|---:|---:|---:|
| A. Resident login (cold, dir changed) | 412 | 275 | 246 | 248 |
| **Resident session, dir unchanged (the norm)** | 412 | 275 | 98¹ | **99** |
| E. Admin login (cold) | 899 | 762 | 534 | **400** |
| F. Resident write (scoped) | 412 | 148 | 148 | 149 |

¹ At HIGH this only applied to refreshes within 5 min; at MEDIUM it applies to
every session where the directory hasn't changed.

Admin cold reconciliation: server 254 (status 2 + directory 149 + commonPool 2 +
list 21 + settlementSummary **80**, was 216) + client 140 + rules 6 = 400.

## Revised daily projection (measured, after MEDIUM)

A returning resident's first session/day is cold (248, or after any community
directory edit), the rest are warm (99). Say 1 cold + 2 warm ≈ **~450
reads/user/day** (baseline ~1,290, −65%):

| DAU | reads/day | under 50k free quota? |
|---:|---:|:--:|
| 50 | ~22,500 | ✅ |
| 100 | ~45,000 | ✅ |
| 120 | ~54,000 | ⚠️ at the line |
| 200 | ~90,000 | ❌ |
| 300 | ~135,000 | ❌ |

**~100–120 daily users now fit the free tier** (from "even 50 breaks it"). The
per-session floor is now the active-event finance (75) + events/notices/committee
(15) re-read every session. Pushing to 300–500 DAU would mean caching those too
(a version sentinel on the active event / reference collections) or moving to the
Blaze plan — which at these volumes costs on the order of cents/day.
