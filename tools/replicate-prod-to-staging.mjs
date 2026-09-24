// One-way replica of PRODUCTION Firestore data into the STAGING project.
//
//   POH_CONFIRM_REPLICA=1 \
//   POH_PROD_KEY=~/Downloads/poh-prod-key.json \
//   POH_STAGING_KEY=~/Downloads/poh-staging-key.json \
//   node tools/replicate-prod-to-staging.mjs \
//        --source=poh-community-portal --dest=poh-community-portal-staging --wipe
//
// This copies REAL resident data (names, emails, phones, financials) into staging.
// That is deliberate here (exact-replica request). Handle accordingly.
//
// Safety:
//   - SOURCE must be production; DEST must NOT be production; they must differ.
//   - Production is opened READ-ONLY (we only ever .get() from it). Every write
//     targets the staging Firestore instance. The destination is re-checked to
//     be non-production before any write.
//   - Requires POH_CONFIRM_REPLICA=1 (this writes real PII into staging).
//   - Storage files (receipt/complaint photos) are NOT copied — Firestore only.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PRODUCTION_PROJECT_ID, assertNotProduction } from "../scripts/env-guard.mjs";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const arg = (n) => process.argv.map((a) => new RegExp(`^--${n}=(.+)$`).exec(a)?.[1]).find(Boolean);
const has = (n) => process.argv.includes(`--${n}`);
const fail = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };
const expand = (p) => p.replace(/^~(?=$|\/)/, process.env.HOME || "~");

const SOURCE = arg("source");
const DEST = arg("dest");
if (SOURCE !== PRODUCTION_PROJECT_ID) fail(`--source must be production (${PRODUCTION_PROJECT_ID}) — this tool reads prod, writes staging.`);
if (!DEST) fail("--dest=<staging project id> is required.");
assertNotProduction(DEST, "replicate (write to dest)"); // dest may never be production
if (DEST === SOURCE) fail("source and dest must differ.");
if (process.env.POH_CONFIRM_REPLICA !== "1") fail("Set POH_CONFIRM_REPLICA=1 to confirm copying REAL data into staging.");

const prodKeyPath = process.env.POH_PROD_KEY && expand(process.env.POH_PROD_KEY);
const stagingKeyPath = process.env.POH_STAGING_KEY && expand(process.env.POH_STAGING_KEY);
if (!prodKeyPath || !stagingKeyPath) fail("Set POH_PROD_KEY and POH_STAGING_KEY to service-account JSON file paths.");

const prodCred = JSON.parse(readFileSync(prodKeyPath, "utf8"));
const stagingCred = JSON.parse(readFileSync(stagingKeyPath, "utf8"));
if (prodCred.project_id !== SOURCE) fail(`PROD key is for '${prodCred.project_id}', expected '${SOURCE}'.`);
if (stagingCred.project_id !== DEST) fail(`STAGING key is for '${stagingCred.project_id}', expected '${DEST}'.`);

const prodApp = admin.initializeApp({ credential: admin.credential.cert(prodCred), projectId: SOURCE }, "prod");
const stagingApp = admin.initializeApp({ credential: admin.credential.cert(stagingCred), projectId: DEST }, "staging");
const srcDb = prodApp.firestore();
const dstDb = stagingApp.firestore();
// Belt-and-braces: the write target must not resolve to production.
if (stagingApp.options.projectId === PRODUCTION_PROJECT_ID) fail("Destination resolves to production — aborting.");

const stats = { docs: 0, collections: 0 };

async function wipeDest() {
  const cols = await dstDb.listCollections();
  for (const c of cols) { process.stdout.write(`  wipe ${c.id} … `); await dstDb.recursiveDelete(c); console.log("done"); }
}

// Reads from prod (srcCol), writes to staging (dstCol). Never writes to prod.
async function copyCollection(srcCol, dstCol) {
  stats.collections++;
  const snap = await srcCol.get();
  const writer = dstDb.bulkWriter();
  for (const doc of snap.docs) { writer.set(dstCol.doc(doc.id), doc.data()); stats.docs++; }
  await writer.close();
  for (const doc of snap.docs) {
    const subs = await doc.ref.listCollections();
    for (const sub of subs) await copyCollection(sub, dstCol.doc(doc.id).collection(sub.id));
  }
}

(async () => {
  console.log(`→ Replicating REAL data  ${SOURCE} → ${DEST}`);
  if (has("wipe")) { console.log("Wiping destination first…"); await wipeDest(); }
  const tops = await srcDb.listCollections();
  for (const c of tops) { process.stdout.write(`  copy ${c.id} … `); await copyCollection(c, dstDb.collection(c.id)); console.log("done"); }
  console.log(`\n✓ Replica complete: ${stats.docs} docs across ${stats.collections} collections copied into ${DEST}`);
  console.log("  NOTE: receipt/complaint photos (Storage) were NOT copied — those images may not load in staging.");
  process.exit(0);
})().catch((e) => { console.error("\n✗ Replica failed:", e.message); process.exit(1); });
