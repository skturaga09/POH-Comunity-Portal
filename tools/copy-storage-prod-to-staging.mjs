// One-way copy of Cloud Storage objects (receipt/complaint photos) from the
// PRODUCTION bucket into the STAGING bucket, so images resolve in staging.
//
//   POH_CONFIRM_REPLICA=1 \
//   POH_PROD_KEY=~/Downloads/poh-prod-key.json \
//   POH_STAGING_KEY=~/Downloads/poh-staging-key.json \
//   node tools/copy-storage-prod-to-staging.mjs \
//        --source=poh-community-portal --dest=poh-community-portal-staging \
//        [--prefix=event-receipts/] [--dry-run]
//
// Safety:
//   - SOURCE must be production; DEST must NOT be production; they must differ.
//   - Production bucket is opened READ-ONLY (download only). Uploads target the
//     staging bucket only, re-checked to be non-production before any write.
//   - Requires POH_CONFIRM_REPLICA=1. Skips objects already present with the
//     same size, so it is safe to re-run.
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
const PREFIX = arg("prefix") || "";
const DRY = has("dry-run");
if (SOURCE !== PRODUCTION_PROJECT_ID) fail(`--source must be production (${PRODUCTION_PROJECT_ID}).`);
if (!DEST) fail("--dest=<staging project id> is required.");
assertNotProduction(DEST, "copy-storage (write to dest)");
if (DEST === SOURCE) fail("source and dest must differ.");
if (process.env.POH_CONFIRM_REPLICA !== "1") fail("Set POH_CONFIRM_REPLICA=1 to confirm copying real photos into staging.");

const prodKeyPath = process.env.POH_PROD_KEY && expand(process.env.POH_PROD_KEY);
const stagingKeyPath = process.env.POH_STAGING_KEY && expand(process.env.POH_STAGING_KEY);
if (!prodKeyPath || !stagingKeyPath) fail("Set POH_PROD_KEY and POH_STAGING_KEY to service-account JSON file paths.");

const prodCred = JSON.parse(readFileSync(prodKeyPath, "utf8"));
const stagingCred = JSON.parse(readFileSync(stagingKeyPath, "utf8"));
if (prodCred.project_id !== SOURCE) fail(`PROD key is for '${prodCred.project_id}', expected '${SOURCE}'.`);
if (stagingCred.project_id !== DEST) fail(`STAGING key is for '${stagingCred.project_id}', expected '${DEST}'.`);

const SRC_BUCKET = arg("source-bucket") || `${SOURCE}.firebasestorage.app`;
const DST_BUCKET = arg("dest-bucket") || `${DEST}.firebasestorage.app`;
if (DST_BUCKET.startsWith(`${PRODUCTION_PROJECT_ID}.`)) fail("Destination bucket resolves to production — aborting.");

const prodApp = admin.initializeApp({ credential: admin.credential.cert(prodCred), projectId: SOURCE, storageBucket: SRC_BUCKET }, "prod");
const stagingApp = admin.initializeApp({ credential: admin.credential.cert(stagingCred), projectId: DEST, storageBucket: DST_BUCKET }, "staging");
const srcBucket = prodApp.storage().bucket();
const dstBucket = stagingApp.storage().bucket();

(async () => {
  console.log(`→ Copying Storage  ${SRC_BUCKET}${PREFIX ? " /" + PREFIX : ""} → ${DST_BUCKET}${DRY ? "   [DRY RUN]" : ""}`);
  const [files] = await srcBucket.getFiles({ prefix: PREFIX });
  let copied = 0, skipped = 0, failed = 0;
  for (const file of files) {
    if (file.name.endsWith("/")) continue; // folder placeholder
    try {
      const dstFile = dstBucket.file(file.name);
      const [exists] = await dstFile.exists();
      if (exists) {
        const [sm] = await file.getMetadata();
        const [dm] = await dstFile.getMetadata();
        if (String(sm.size) === String(dm.size)) { skipped++; continue; }
      }
      if (DRY) { console.log(`  would copy  ${file.name}`); copied++; continue; }
      const [buf] = await file.download();
      const [meta] = await file.getMetadata();
      await dstFile.save(buf, { contentType: meta.contentType, resumable: false, metadata: { metadata: meta.metadata || {} } });
      copied++;
      if (copied % 25 === 0) console.log(`  …${copied} copied`);
    } catch (e) {
      failed++;
      console.warn(`  ! ${file.name}: ${e.message}`);
    }
  }
  console.log(`\n✓ Storage copy done — ${copied} copied, ${skipped} already present, ${failed} failed (of ${files.length} objects).`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error("\n✗ Storage copy failed:", e.message); process.exit(1); });
