// Approve one tester login in a STAGING Firebase project (local one-off; do NOT commit real emails).
//
//   node tools/add-tester.mjs --project=poh-community-portal-staging \
//        --email=someone@gmail.com [--role=resident] [--flat=605] [--name="Test Resident"]
//
// The email is read from the command line only — it is never written to any file in the repo.
// Safety: refuses to run against production; requires an explicit --project.
import { createRequire } from "node:module";
import { resolveProject, assertNotProduction } from "../scripts/env-guard.mjs";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const arg = (name) =>
  process.argv.map((a) => new RegExp(`^--${name}=(.+)$`).exec(a)?.[1]).find(Boolean);

const PROJECT = resolveProject();
assertNotProduction(PROJECT, "add-tester");

const emailArg = arg("email");
if (!emailArg) {
  console.error("\n✗ Pass --email=<google-account-email>  (comma-separate for several)\n");
  process.exit(1);
}
const emails = emailArg.split(",").map((e) => e.trim()).filter(Boolean);
const role = arg("role") || "resident";
const flat = arg("flat") || "";
const name = arg("name") || "Test Resident";
const residentType = arg("residentType") || "Owner";

const emailKey = (e) => String(e).toLowerCase().replace(/[^a-z0-9]+/g, "_");

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

const batch = db.batch();
for (const email of emails) {
  batch.set(
    db.collection("accessInvites").doc(emailKey(email)),
    { email, name, role, status: "active", flat, residentType, updatedAt: now },
    { merge: true },
  );
}
await batch.commit();

for (const email of emails) {
  console.log(`✓ Approved ${email} as ${role}${flat ? ` (flat ${flat})` : ""} in ${PROJECT}`);
}
console.log("  They can now sign in — if already on 'Awaiting approval', tap Check again.");
process.exit(0);
