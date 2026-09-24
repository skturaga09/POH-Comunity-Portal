// Deploy / seed safety guard.
//
// Enforces the rules that keep test/dev work off production:
//   - a Firebase project must be named EXPLICITLY (no default; production is never assumed)
//   - destructive operations (seed/wipe) refuse to run against production
//   - deploying to production is a deliberate, confirmed step (POH_CONFIRM_PROD=1)
//
// Used by scripts/deploy.mjs and by any seed/maintenance script that writes data.

export const PRODUCTION_PROJECT_ID = "poh-community-portal";

/** The target project — from --project=<id>, FIREBASE_PROJECT, or GCLOUD_PROJECT. No default. */
export function resolveProject() {
  const fromArg = process.argv
    .map((a) => /^--project=(.+)$/.exec(a)?.[1])
    .find(Boolean);
  const project = fromArg || process.env.FIREBASE_PROJECT || process.env.GCLOUD_PROJECT;
  if (!project) {
    fail(
      "No Firebase project specified.\n" +
        "  Pass --project=<id> or set FIREBASE_PROJECT=<id>.\n" +
        "  There is no default — production is never assumed.",
    );
  }
  return project;
}

export function isProduction(project) {
  return project === PRODUCTION_PROJECT_ID;
}

/** Refuse a destructive op (seeding, wiping, importing) against production. */
export function assertNotProduction(project, op = "this destructive operation") {
  if (isProduction(project)) {
    fail(
      `Refusing to run ${op} against PRODUCTION (${project}).\n` +
        "  Point it at a staging/dev project instead.",
    );
  }
}

/** Deploying to production requires an explicit, deliberate confirmation. */
export function requireProductionConfirmation(project) {
  if (isProduction(project) && process.env.POH_CONFIRM_PROD !== "1") {
    fail(
      `Production deploy to '${project}' is blocked by default.\n` +
        "  This is a separate, manual step: re-run with POH_CONFIRM_PROD=1 to proceed.",
    );
  }
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}
