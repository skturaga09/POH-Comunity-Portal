// Renumber ground-floor flats from the portal's "G01…G21" to the builder's "001…021".
//
//   node tools/renumber-ground-flats.mjs --project=<id>            # dry run: report only
//   node tools/renumber-ground-flats.mjs --project=<id> --apply    # write the changes
//   POH_CONFIRM_PROD=1 node tools/renumber-ground-flats.mjs --project=poh-community-portal --apply
//
// What changes:
//   - residents/G01 → residents/001 (doc copied to the new id, old doc deleted)
//   - every string value under a key containing "flat" (flat, flatNo, profile.flat,
//     spocs[].flat, …) in every collection and sub-collection
// What stays: the floor itself ("G" = Ground floor), auditLogs and mail (history text).
// Run against staging first. Re-running is safe: nothing matches once renumbered.
import { createRequire } from "node:module";
import { resolveProject, requireProductionConfirmation } from "../scripts/env-guard.mjs";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const PROJECT = resolveProject();
if (APPLY) requireProductionConfirmation(PROJECT);
admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();

const SKIP = new Set(["auditLogs", "mail"]);
const GROUND = /^G0?(\d{1,2})$/i;
// "G01" → "001", "G7" → "007"; anything else unchanged.
const renumber = (flat) => {
  const m = String(flat).trim().match(GROUND);
  return m ? `0${m[1].padStart(2, "0")}` : flat;
};

// Rewrite flat values in plain objects/arrays; leave Timestamps, refs etc. untouched.
function rewrite(value, key = "") {
  if (typeof value === "string") return /flat/i.test(key) ? renumber(value) : value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, key));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, k)]));
  }
  return value;
}

// Self-check before touching any data.
const assert = require("node:assert/strict");
assert.equal(renumber("G01"), "001"); assert.equal(renumber("g21"), "021"); assert.equal(renumber("G7"), "007");
assert.equal(renumber("101"), "101"); assert.equal(renumber("G101"), "G101");
assert.deepEqual(rewrite({ flat: "G05", floor: "G", name: "G05", spocs: [{ floor: "G", flat: "G02" }], profile: { flat: "G03" } }),
  { flat: "005", floor: "G", name: "G05", spocs: [{ floor: "G", flat: "002" }], profile: { flat: "003" } });

const changes = [];
async function scan(collectionRef) {
  for (const doc of (await collectionRef.get()).docs) {
    const data = doc.data();
    const next = rewrite(data);
    const newId = collectionRef.id === "residents" ? renumber(doc.id) : doc.id;
    if (newId !== doc.id || JSON.stringify(next) !== JSON.stringify(data)) changes.push({ doc, data: next, newId });
    else if (GROUND.test(doc.id)) console.warn(`! ${doc.ref.path}: id looks like a ground-floor flat; not renamed (only residents are)`);
    for (const sub of await doc.ref.listCollections()) await scan(sub);
  }
}

for (const col of await db.listCollections()) if (!SKIP.has(col.id)) await scan(col);

const renamed = changes.filter((c) => c.newId !== c.doc.id);
for (const c of renamed) {
  if (!(await c.doc.ref.listCollections()).length) continue;
  console.error(`✗ ${c.doc.ref.path} has sub-collections; renaming would orphan them. Aborting.`);
  process.exit(1);
}
const clash = renamed.find((c) => changes.some((o) => o.doc.ref.parent.path === c.doc.ref.parent.path && o.doc.id === c.newId));
if (clash) { console.error(`✗ ${clash.doc.ref.parent.path}/${clash.newId} already exists. Aborting.`); process.exit(1); }

console.log(`${PROJECT}: ${changes.length} document(s) to update, ${renamed.length} resident(s) renamed`);
for (const c of changes) console.log(`  ${c.doc.ref.path}${c.newId !== c.doc.id ? ` → ${c.newId}` : ""}`);
if (!APPLY) { console.log("\nDry run — nothing written. Re-run with --apply to write."); process.exit(0); }

let batch = db.batch(); let ops = 0;
const queue = async (fn) => { fn(batch); if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; } };
for (const c of changes) {
  if (c.newId === c.doc.id) await queue((b) => b.set(c.doc.ref, c.data));
  else {
    await queue((b) => b.set(c.doc.ref.parent.doc(c.newId), { ...c.data, id: c.data.id === c.doc.id ? c.newId : c.data.id }));
    await queue((b) => b.delete(c.doc.ref));
  }
}
// Clients cache the directory by version; bump it so everyone refetches the new numbers.
await queue((b) => b.set(db.doc("pohMeta/directoryVersion"), { v: admin.firestore.FieldValue.increment(1), at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }));
await batch.commit();
console.log(`\n✓ Applied ${changes.length} update(s).`);
