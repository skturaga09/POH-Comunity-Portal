// Seed a STAGING Firebase project with synthetic POH data for tester walkthroughs.
//
//   node tools/seed-staging.mjs --project=poh-community-portal-staging
//
// Safety:
//   - refuses to run against production (env-guard.assertNotProduction)
//   - requires an explicit --project / FIREBASE_PROJECT (no default)
//   - writes ONLY synthetic data — no real names, phones, emails, receipts, photos
//
// Auth: uses Application Default Credentials. Before running once:
//   gcloud auth application-default login
//   gcloud config set project poh-community-portal-staging
import { createRequire } from "node:module";
import { resolveProject, assertNotProduction } from "../scripts/env-guard.mjs";

const require = createRequire(import.meta.url);
const admin = require("firebase-admin"); // resolved from tools/node_modules (see tools/package.json)

const PROJECT = resolveProject();
assertNotProduction(PROJECT, "seed"); // hard-fails on poh-community-portal

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();
const emailKey = (e) => String(e).toLowerCase().replace(/[^a-z0-9]+/g, "_");

// ---- The one real thing: which Google accounts may sign in as testers ----
// iamsanthoshkumar@gmail.com is the built-in owner (→ super_admin). Add more testers
// here as { email, role, flat, name, residentType }.
const OWNER = "iamsanthoshkumar@gmail.com";
const TESTERS = [
  { email: OWNER, role: "super_admin", flat: "604", name: "Test Admin", residentType: "Owner" },
  { email: "resident.tester@example.com", role: "resident", flat: "605", name: "Test Resident", residentType: "Owner" },
  { email: "committee.tester@example.com", role: "committee", flat: "501", name: "Test Committee", residentType: "Owner" },
];

// ---- Synthetic residents (doc id = flat) ----
const RESIDENTS = [
  { flat: "604", floor: "6", ownerName: "Test Admin", residentType: "Owner", ownerEmail: OWNER, occupancyStatus: "Owner Occupied" },
  { flat: "605", floor: "6", ownerName: "Test Resident", residentType: "Owner", ownerEmail: "resident.tester@example.com", occupancyStatus: "Owner Occupied" },
  { flat: "501", floor: "5", ownerName: "Test Committee", residentType: "Owner", ownerEmail: "committee.tester@example.com", occupancyStatus: "Owner Occupied" },
  { flat: "502", floor: "5", ownerName: "Sample Owner Five", residentType: "Owner", occupancyStatus: "Owner Occupied" },
  { flat: "101", floor: "1", ownerName: "Sample Owner One", residentType: "Owner", occupancyStatus: "Tenant Occupied", tenantName: "Sample Tenant" },
  { flat: "102", floor: "1", ownerName: "Sample Owner Two", residentType: "Owner", occupancyStatus: "Owner Occupied" },
];

const COMMITTEE = [
  { name: "Sample President", role: "President", flat: "101" },
  { name: "Test Committee", role: "Treasurer", flat: "501" },
  { name: "Sample Secretary", role: "Secretary", flat: "102" },
];

const NOTICES = [
  { type: "Update", title: "Water tank cleaning — Sep 28", body: "Supply off 10am–2pm.", priority: "Normal", publishedAt: now },
  { type: "Circular", title: "AGM minutes published (staging sample)", body: "See the committee board.", priority: "Normal", publishedAt: now },
];

const FEEDBACK = [
  { type: "improvement", title: "EV charging in visitor parking", description: "Add a couple of EV points.", area: "Parking", status: "Open", supportCount: 3, commentCount: 0, anonymous: false, createdByName: "Test Resident", createdAt: now },
  { type: "bug", title: "Lift B noisy at night", description: "Rattling sound after 10pm.", area: "General", status: "Under review", supportCount: 1, commentCount: 0, anonymous: true, createdByName: "Anonymous", createdAt: now },
];

async function seed() {
  console.log(`→ Seeding SYNTHETIC data into ${PROJECT}`);
  const batch = () => db.batch();

  // Testers → accessInvites (auto-activated to users/{uid} on first sign-in)
  let b = batch();
  for (const t of TESTERS) {
    b.set(db.collection("accessInvites").doc(emailKey(t.email)), {
      email: t.email, name: t.name, role: t.role, status: "active", flat: t.flat, residentType: t.residentType, updatedAt: now,
    }, { merge: true });
  }
  for (const r of RESIDENTS) b.set(db.collection("residents").doc(r.flat), { id: r.flat, ...r, updatedAt: now }, { merge: true });
  for (let i = 0; i < COMMITTEE.length; i++) b.set(db.collection("committee").doc(`c${i + 1}`), COMMITTEE[i], { merge: true });
  for (let i = 0; i < NOTICES.length; i++) b.set(db.collection("notices").doc(`n${i + 1}`), { id: `n${i + 1}`, ...NOTICES[i] }, { merge: true });
  for (let i = 0; i < FEEDBACK.length; i++) b.set(db.collection("feedbackItems").doc(`f${i + 1}`), { id: `f${i + 1}`, ...FEEDBACK[i] }, { merge: true });
  b.set(db.collection("pohMeta").doc("directoryVersion"), { version: Date.now(), updatedAt: now }, { merge: true });
  await b.commit();

  // Active event + finance subcollections
  const eventRef = db.collection("events").doc("ganesh-2026");
  await eventRef.set({
    id: "ganesh-2026", name: "Ganesh Chaturthi 2026", status: "Active", active: true,
    date: "2026-09-15", targetAmount: 92000, commonPoolAllocation: 0,
    spocs: [{ flat: "604", floor: "6", name: "Test Admin" }, { flat: "501", floor: "5", name: "Test Committee" }],
    updatedAt: now,
  }, { merge: true });

  const contribs = [
    { floor: "6", flat: "604", name: "Test Admin", amount: 2000, paymentMode: "UPI", reference: "UPI123", status: "Received", date: "2026-09-05" },
    { floor: "6", flat: "605", name: "Test Resident", amount: 1500, paymentMode: "Cash", reference: "", status: "Received", date: "2026-09-06" },
    { floor: "5", flat: "501", name: "Test Committee", amount: 2500, paymentMode: "Bank Transfer", reference: "NEFT9", status: "Received", date: "2026-09-06" },
    { floor: "1", flat: "101", name: "Sample Owner One", amount: 1000, paymentMode: "UPI", reference: "UPI777", status: "Received", date: "2026-09-07" },
  ];
  const expenses = [
    { category: "Decorations", description: "Flowers & pandal", amount: 8400, paidBy: "Floor 6 SPOC", paymentMode: "UPI", reference: "UPI55", status: "Approved", receiptUrls: [] },
    { category: "Sound", description: "Speaker rental", amount: 6500, paidBy: "Test Committee", paymentMode: "Cash", reference: "", status: "Pending", receiptUrls: [] },
  ];
  let fb = batch();
  contribs.forEach((c, i) => fb.set(eventRef.collection("contributions").doc(`ct${i + 1}`), { id: `ct${i + 1}`, eventId: "ganesh-2026", ...c, createdAt: now }, { merge: true }));
  expenses.forEach((e, i) => fb.set(eventRef.collection("expenses").doc(`ex${i + 1}`), { id: `ex${i + 1}`, eventId: "ganesh-2026", ...e, date: new Date().toISOString(), createdAt: now }, { merge: true }));
  await fb.commit();

  // One ticket + a notification for the owner
  await db.collection("tickets").doc("POH-604-0001").set({
    id: "POH-604-0001", flat: "604", floor: "6", category: "Plumbing", priority: "Normal",
    title: "Kitchen sink leak", description: "Water pooling under the sink.", status: "Open",
    raisedByEmail: OWNER, raisedByName: "Test Admin", commentCount: 0, createdAt: now, updatedAt: now,
  }, { merge: true });
  await db.collection("notifications").add({ recipientEmail: OWNER, title: "Welcome to POH One TEST", body: "This is synthetic staging data.", read: false, createdAt: now });

  console.log("✓ Seed complete: testers, residents, committee, notices, feedback, an active event with finance, a ticket, and a notification.");
}

seed().then(() => process.exit(0)).catch((e) => { console.error("✗ Seed failed:", e.message); process.exit(1); });
