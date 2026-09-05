# POH dev environment (emulator-first) + Firestore read measurement

This folder is the **isolated development + measurement environment**. It never
touches production data. Development, Codex, Claude Code, and automated browser
tests should all run here against the local emulator.

## What's here

| File | Purpose |
|---|---|
| `emulator.sh` | Starts Auth + Firestore + Functions emulators using the project-local JDK, with the read counter on. |
| `seed-emulator.mjs` | Seeds representative data (147 residents, 2 events, contributions/expenses, notices, committee, auditLogs, users, feedback…). |
| `measure-baseline.mjs` | Replays scenarios A–H and prints reads per session (server + client + rules). |
| `BASELINE.md` | The recorded pre-optimization numbers. |
| `jdk/` | Project-local Temurin JDK 21 (gitignored). The Firestore emulator needs Java; this avoids a system install. |

## One-time setup

```
cd tools && npm install          # firebase + firebase-admin (harness only)
# JDK is already downloaded under tools/jdk/ (gitignored). To refresh it:
#   curl -L -o /tmp/jdk.tgz "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
#   mkdir -p tools/jdk && tar -xzf /tmp/jdk.tgz -C tools/jdk
```

## Daily loop

```
# terminal 1
cd tools && npm run emulators        # starts emulators (Emulator UI at http://127.0.0.1:4000)

# terminal 2 — seed once per emulator start, then measure any time
cd tools && npm run seed
cd tools && npm run measure
```

## Running the actual app against the emulator

`src/portal-launcher.js` auto-connects to the emulators whenever it is served
from `localhost`/`127.0.0.1` (force with `?emulator=1`, disable with
`?emulator=0`). So:

```
npm run build                 # from repo root — build src/ -> public/
firebase emulators:start --only auth,firestore,functions,hosting --project poh-community-portal
# open http://127.0.0.1:5000  → the app talks to the local emulator, not prod
```

The deployed site (`poh-community-portal.web.app`) is unaffected — the switch is
localhost-only.

## Read counter (how measurement works)

When `POH_COUNT_READS=1` (set only by `emulator.sh`), `functions/index.js`
patches the Firestore SDK to tally every server-side read into
`pohMeta/readStats`, read/reset via the `pohReadStats` callable. In production
the env var is never set, so the instrumentation is a complete no-op. Client
reads are counted directly by `measure-baseline.mjs` via `getDocs().size`.

---

## Graduating to a real cloud `poh-dev` project (when you want it)

The emulator covers day-to-day dev for free. A separate **cloud** dev project is
worth creating once you want to test on real devices / share a staging build.
These steps need the Firebase console + your account (I cannot complete the
console-only parts):

1. **Create the project** (CLI, needs your login):
   ```
   firebase projects:create poh-dev-<something-unique> --display-name "POH Dev"
   ```
   (Project IDs are globally unique; `poh-dev` alone is likely taken.)
2. **Console only:** in the new project, enable **Authentication → Google**
   provider, add authorized domains, and configure the OAuth consent screen.
   The CLI cannot do this.
3. **Firestore + Storage:** create a Firestore database (asia-south1) and a
   Storage bucket in the new project.
4. **Wire multi-project config:**
   - Add a dev entry to `.firebaserc` targets, e.g.
     `firebase use --add` → alias `dev` → `poh-dev-<...>`, alias `prod` →
     `poh-community-portal`.
   - Add a `src/portal-config.dev.js` with the dev web config and have the build
     pick it by flag (e.g. `POH_ENV=dev npm run build`).
5. **Functions on dev need Blaze:** deploying Cloud Functions to `poh-dev`
   requires the **Blaze (pay-as-you-go) plan** on that project (a billing
   decision only you can make). Hosting/Firestore/Auth work on the free Spark
   plan.
6. **Deploy rules + functions to dev, seed with anonymized data, point tests at
   it.** Never point tests at `poh-community-portal` again.

Until then: `poh-community-portal` = production; the **emulator** = dev/test.
