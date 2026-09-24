// Clear the STAGING outbound email queue (the "Trigger Email" `mail` collection),
// so copied/queued docs can never send real email from staging.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/Downloads/poh-staging-key.json \
//   node tools/clear-staging-mail.mjs --project=poh-community-portal-staging
//
// Safety: refuses to run against production; requires an explicit --project.
import { createRequire } from "node:module";
import { resolveProject, assertNotProduction } from "../scripts/env-guard.mjs";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const PROJECT = resolveProject();
assertNotProduction(PROJECT, "clear-staging-mail");

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const snap = await db.collection("mail").get();
console.log(`staging mail docs found: ${snap.size}`);
await db.recursiveDelete(db.collection("mail"));
console.log(`✓ cleared staging mail queue in ${PROJECT}`);
process.exit(0);
