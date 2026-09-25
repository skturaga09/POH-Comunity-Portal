// After copy-storage-prod-to-staging, repoint every staging Firestore URL from the
// PRODUCTION Storage bucket to the STAGING bucket. Download tokens were preserved by
// the copy, so only the bucket host changes; the ?alt=media&token=… stays valid.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/Downloads/poh-staging-key.json \
//   node tools/rewrite-storage-urls-staging.mjs --project=poh-community-portal-staging [--dry-run]
//
// Safety: refuses production; requires explicit --project; only rewrites the exact
// prod bucket host substring inside string values — every other byte is untouched.
import { createRequire } from "node:module";
import { resolveProject, assertNotProduction, PRODUCTION_PROJECT_ID } from "../scripts/env-guard.mjs";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");
const has = (n) => process.argv.includes(`--${n}`);
const DRY = has("dry-run");

const PROJECT = resolveProject();
assertNotProduction(PROJECT, "rewrite-storage-urls");

const PROD_HOST = `${PRODUCTION_PROJECT_ID}.firebasestorage.app`;
const STAGING_HOST = `${PROJECT}.firebasestorage.app`;
// also cover the legacy appspot.com host form, just in case
const PROD_APPSPOT = `${PRODUCTION_PROJECT_ID}.appspot.com`;

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

function rewriteValue(v) {
  if (typeof v === "string") {
    if (v.includes(PROD_HOST)) return v.split(PROD_HOST).join(STAGING_HOST);
    if (v.includes(PROD_APPSPOT)) return v.split(PROD_APPSPOT).join(STAGING_HOST);
    return v;
  }
  if (Array.isArray(v)) return v.map(rewriteValue);
  if (v && typeof v === "object" && v.constructor === Object) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = rewriteValue(val);
    return out;
  }
  return v; // numbers, booleans, Timestamps, GeoPoints, null — untouched
}

let scanned = 0, changed = 0;

async function walk(colRef) {
  const snap = await colRef.get();
  for (const doc of snap.docs) {
    scanned++;
    const before = doc.data();
    const after = rewriteValue(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      changed++;
      if (DRY) console.log(`  would rewrite ${doc.ref.path}`);
      else await doc.ref.set(after);
    }
    for (const sub of await doc.ref.listCollections()) await walk(sub);
  }
}

(async () => {
  console.log(`→ Repointing Storage URLs in ${PROJECT}: ${PROD_HOST} → ${STAGING_HOST}${DRY ? "   [DRY RUN]" : ""}`);
  for (const c of await db.listCollections()) { process.stdout.write(`  ${c.id} … `); await walk(c); console.log("done"); }
  console.log(`\n✓ URL rewrite ${DRY ? "(dry run) " : ""}complete — ${changed} of ${scanned} docs ${DRY ? "would change" : "updated"}.`);
  process.exit(0);
})().catch((e) => { console.error("\n✗ Rewrite failed:", e.message); process.exit(1); });
