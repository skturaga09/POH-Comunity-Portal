# Deploy & seed safety

Guards so test/dev work can never accidentally hit production (`poh-community-portal`).

## Rules (enforced by `scripts/env-guard.mjs`)
1. **A project must be named explicitly.** No default — production is never assumed.
   Pass `--project=<id>` or set `FIREBASE_PROJECT=<id>`.
2. **Destructive ops refuse production.** Seeding/wiping against `poh-community-portal`
   hard-fails (`assertNotProduction`).
3. **Production deploy is deliberate.** It's a separate, confirmed step — set
   `POH_CONFIRM_PROD=1`.

## Commands
```bash
# Deploy to any (non-prod) project — needs an explicit id, no prod fallback
node scripts/deploy.mjs hosting --project=<staging-project-id>
#   or: FIREBASE_PROJECT=<id> npm run deploy -- hosting

# Production — separate & confirmed (blocks without POH_CONFIRM_PROD=1)
POH_CONFIRM_PROD=1 npm run deploy:prod        # hosting → poh-community-portal
POH_CONFIRM_PROD=1 npm run deploy:functions   # functions → poh-community-portal

# Preview channel (safe — a temporary URL, never live prod)
npm run deploy:staging
```
Every deploy is **pinned** with `firebase --project <id>`, so it never rides the
ambient `firebase use` selection.

## Seeding
`tools/seed-emulator.mjs` is **emulator-only** — it already hard-fails unless the
`FIRESTORE_EMULATOR_HOST` / `FIREBASE_AUTH_EMULATOR_HOST` env vars are set, so it can't
touch a real project. Any future script that seeds a **real staging** project must call:
```js
import { resolveProject, assertNotProduction } from "./scripts/env-guard.mjs";
const project = resolveProject();
assertNotProduction(project, "seed");   // refuses poh-community-portal
```
Never copy production names, phone numbers, emails, receipts, or photos into a
non-production project — seed synthetic data only.
