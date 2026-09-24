// Guarded Firebase deploy.
//
//   node scripts/deploy.mjs <targets…> --project=<id>
//
//   - requires an explicit project (via env-guard: --project / FIREBASE_PROJECT)
//   - pins that project with `firebase --project <id>` (never the ambient active one)
//   - production deploys need POH_CONFIRM_PROD=1 (a deliberate, separate step)
//
// Examples:
//   node scripts/deploy.mjs hosting --project=poh-community-portal-staging
//   POH_CONFIRM_PROD=1 node scripts/deploy.mjs hosting --project=poh-community-portal
import { spawnSync } from "node:child_process";
import { resolveProject, isProduction, requireProductionConfirmation } from "./env-guard.mjs";

const targets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const only = (targets.length ? targets : ["hosting"]).join(",");

const project = resolveProject();
requireProductionConfirmation(project);

const label = isProduction(project) ? `${project} (PRODUCTION)` : project;
console.log(`→ Deploying [${only}] to ${label}`);

const result = spawnSync(
  "firebase",
  ["deploy", "--only", only, "--project", project],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
