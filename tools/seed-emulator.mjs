// Seed the Firestore + Auth emulators with representative POH data so the
// baseline measurement (tools/measure-baseline.mjs) reflects realistic read
// volumes. Run via: npm run seed:emulator  (see package.json). NEVER points at
// production — it hard-fails unless the emulator env vars are set.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const admin = require("firebase-admin"); // resolved from functions/node_modules via package.json

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error("Refusing to seed: FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST not set. This script is emulator-only.");
  process.exit(1);
}

const PROJECT_ID = process.env.GCLOUD_PROJECT || "poh-community-portal";
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();
const auth = admin.auth();

const FLOORS = ["G", "1", "2", "3", "4", "5", "6"];       // 7 floors
const PER_FLOOR = 21;                                        // 7 * 21 = 147 flats
const OWNER_EMAIL = "iamsanthoshkumar@gmail.com";           // super_admin (matches functions)
const RESIDENT_EMAIL = "resident.tester@example.com";       // ordinary resident test user
const RESIDENT_FLAT = "301";                                // resident.tester owns this flat

const rnd = (n) => Math.floor(Math.random() * n);
const pad2 = (n) => String(n).padStart(2, "0");

function flatId(floor, i) { return `${floor}${pad2(i)}`; }

// Build the 147 residents with a realistic occupancy + vehicle mix.
function buildResidents() {
  const residents = [];
  for (const floor of FLOORS) {
    for (let i = 1; i <= PER_FLOOR; i++) {
      const flat = flatId(floor, i);
      const roll = rnd(100);
      let occupancyStatus = "Owner Occupied";
      if (roll >= 60 && roll < 85) occupancyStatus = "Tenant Occupied";
      else if (roll >= 85 && roll < 95) occupancyStatus = "Vacant";
      else if (roll >= 95) occupancyStatus = "Unverified";

      const vehicles = [];
      const vroll = rnd(100);
      if (vroll < 45) vehicles.push({ type: "Four wheeler", details: `KA01AB${1000 + rnd(9000)}` });
      if (vroll < 70) vehicles.push({ type: "Two wheeler", details: `KA02CD${1000 + rnd(9000)}` });

      const isResidentTester = flat === RESIDENT_FLAT;
      residents.push({
        id: flat,
        flat,
        floor,
        occupancyStatus,
        ownerName: `Owner ${flat}`,
        ownerMobile: `98${String(40000000 + rnd(9999999)).slice(0, 8)}`,
        ownerEmail: isResidentTester ? RESIDENT_EMAIL : `owner.${flat.toLowerCase()}@example.com`,
        tenantName: occupancyStatus === "Tenant Occupied" ? `Tenant ${flat}` : "",
        tenantMobile: occupancyStatus === "Tenant Occupied" ? `97${String(40000000 + rnd(9999999)).slice(0, 8)}` : "",
        parkingLevel: `Basement ${1 + rnd(2)}`,
        parkingSlots: String(1 + rnd(2)),
        vehicles,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
  }
  return residents;
}

async function commitInChunks(items, toRef) {
  // Firestore batches cap at 500 writes.
  let batch = db.batch();
  let n = 0;
  let written = 0;
  for (const item of items) {
    const { ref, data } = toRef(item);
    batch.set(ref, data);
    n++; written++;
    if (n === 450) { await batch.commit(); batch = db.batch(); n = 0; }
  }
  if (n) await batch.commit();
  return written;
}

async function seedResidents() {
  const residents = buildResidents();
  const written = await commitInChunks(residents, (r) => {
    const { id, ...data } = r;
    return { ref: db.collection("residents").doc(id), data };
  });
  console.log(`  residents: ${written}`);
  return residents;
}

async function seedEvents(residents) {
  // One ACTIVE event and one CLOSED/settled event.
  const events = [
    {
      id: "INDEPENDENCE-2026",
      name: "Independence Day 2026", status: "Active", active: true,
      date: "2026-08-15", description: "Community Independence Day celebration.",
      contributionAmount: 500, commonPoolAllocation: 0,
      spocs: [{ floor: "3", flat: RESIDENT_FLAT }],
      contributedFlats: 60, expenseCount: 15, settled: false
    },
    {
      id: "DIWALI-2025",
      name: "Diwali 2025", status: "Completed", active: false,
      date: "2025-11-01", description: "Diwali festivities and dinner.",
      contributionAmount: 500, commonPoolAllocation: 5000,
      settlementStatus: "Closed", spocs: [],
      contributedFlats: 120, expenseCount: 15, settled: true
    }
  ];

  for (const ev of events) {
    const { contributedFlats, expenseCount, settled, ...eventData } = ev;
    if (settled) {
      eventData.settlementFigures = { collected: contributedFlats * 500, poolAllocated: 5000, spent: 42000, balance: contributedFlats * 500 + 5000 - 42000, pendingExpenses: 0 };
    }
    await db.collection("events").doc(ev.id).set(eventData);

    // contributions (one per contributing flat)
    const contribFlats = residents.slice(0, contributedFlats);
    await commitInChunks(contribFlats, (r, idx) => ({
      ref: db.collection("events").doc(ev.id).collection("contributions").doc(),
      data: { flat: r.flat, floor: r.floor, ownerName: r.ownerName, amount: 500, paymentMode: rnd(2) ? "UPI" : "Cash", reference: `TXN${100000 + rnd(900000)}`, date: ev.date, createdAt: admin.firestore.FieldValue.serverTimestamp() }
    }));

    // expenses
    const expenses = Array.from({ length: expenseCount }, (_, i) => ({ i }));
    await commitInChunks(expenses, ({ i }) => ({
      ref: db.collection("events").doc(ev.id).collection("expenses").doc(),
      data: { category: ["Decor", "Food", "Sound", "Prizes", "Misc"][i % 5], description: `Expense ${i + 1}`, amount: 1000 + rnd(4000), status: i < expenseCount - 2 ? "Approved" : "Pending", paidBy: "Committee", paymentMode: "UPI", createdAt: admin.firestore.FieldValue.serverTimestamp() }
    }));
    console.log(`  event ${ev.id}: ${contributedFlats} contributions, ${expenseCount} expenses`);
  }
  return events;
}

async function seedSimpleCollections() {
  const notices = Array.from({ length: 6 }, (_, i) => ({ title: `Notice ${i + 1}`, body: "Community update body text.", type: "Update", priority: ["normal", "high", "critical", "normal", "low", "normal"][i], published: true, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
  await commitInChunks(notices, (n) => ({ ref: db.collection("notices").doc(), data: n }));
  console.log(`  notices: ${notices.length}`);

  const committee = Array.from({ length: 7 }, (_, i) => ({ name: `Member ${i + 1}`, role: ["President", "Secretary", "Treasurer", "Member", "Member", "Member", "Member"][i], visible: true }));
  await commitInChunks(committee, (c) => ({ ref: db.collection("committee").doc(), data: c }));
  console.log(`  committee: ${committee.length}`);

  const amenity = Array.from({ length: 5 }, (_, i) => ({ amenity: "Clubhouse", flat: `${1 + i}0${i}`, date: "2026-09-0" + (i + 1), status: "Pending" }));
  await commitInChunks(amenity, (a) => ({ ref: db.collection("amenityBookings").doc(), data: a }));
  const moves = Array.from({ length: 4 }, (_, i) => ({ flat: `${2 + i}0${i}`, type: "Move-in", status: "Requested" }));
  await commitInChunks(moves, (m) => ({ ref: db.collection("moveRequests").doc(), data: m }));
  const contacts = Array.from({ length: 8 }, (_, i) => ({ name: `Contact ${i + 1}`, phone: "1800" + (100000 + i), category: "Emergency" }));
  await commitInChunks(contacts, (c) => ({ ref: db.collection("emergencyContacts").doc(), data: c }));
  const gallery = Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/photo${i}.jpg`, caption: `Photo ${i + 1}` }));
  await commitInChunks(gallery, (g) => ({ ref: db.collection("galleryPhotos").doc(), data: g }));
  console.log(`  expansion: amenity 5, moves 4, contacts 8, gallery 10`);

  // auditLogs — deliberately large to reflect the unbounded, append-only growth.
  const audits = Array.from({ length: 250 }, (_, i) => ({ action: "Recorded action", entity: "System", detail: `event ${i}`, actor: OWNER_EMAIL, actorName: "Admin", createdAt: admin.firestore.FieldValue.serverTimestamp() }));
  await commitInChunks(audits, (a) => ({ ref: db.collection("auditLogs").doc(), data: a }));
  console.log(`  auditLogs: ${audits.length}`);

  await db.collection("system").doc("communityFund").set({ balance: 12000, lastEventId: "DIWALI-2025" });
  await db.collection("system").doc("migration").set({ at: admin.firestore.FieldValue.serverTimestamp(), note: "seed" });

  // feedback board (small) with supporters + comments to exercise the N+1.
  for (let i = 0; i < 6; i++) {
    const ref = db.collection("feedbackItems").doc();
    await ref.set({ type: "improvement", title: `Idea ${i + 1}`, description: "A community idea.", area: "General", status: "Open", supportCount: rnd(10), commentCount: 2, anonymous: false, createdByEmail: OWNER_EMAIL, createdByName: "Admin", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await ref.collection("comments").doc().set({ body: "Comment 1", createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await ref.collection("comments").doc().set({ body: "Comment 2", createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  console.log(`  feedbackItems: 6`);
  const ratings = Array.from({ length: 8 }, (_, i) => ({ uid: `rater-${i}`, rating: 3 + rnd(3), comment: "" }));
  for (const r of ratings) await db.collection("experienceRatings").doc(r.uid).set({ rating: r.rating, comment: r.comment });
  console.log(`  experienceRatings: ${ratings.length}`);
}

async function seedUsersAndAuth(residents) {
  // Auth + users doc for an ADMIN and an ordinary RESIDENT. users doc id == auth uid.
  const people = [
    { uid: "admin-uid", email: OWNER_EMAIL, name: "Santhosh (Owner)", role: "super_admin", status: "active", flat: "", residentType: "Owner" },
    { uid: "resident-uid", email: RESIDENT_EMAIL, name: "Resident Tester", role: "resident", status: "active", flat: RESIDENT_FLAT, residentType: "Owner" }
  ];
  for (const p of people) {
    try { await auth.getUser(p.uid); await auth.updateUser(p.uid, { email: p.email, password: "test1234", displayName: p.name, emailVerified: true }); }
    catch { await auth.createUser({ uid: p.uid, email: p.email, password: "test1234", displayName: p.name, emailVerified: true }); }
    const { uid, ...data } = p;
    await db.collection("users").doc(uid).set({ ...data, uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  // A few extra users + invites so admin "list" reflects a realistic roster.
  const extraUsers = Array.from({ length: 10 }, (_, i) => ({ email: `member${i}@example.com`, name: `Member ${i}`, role: "resident", status: "active", flat: "" }));
  await commitInChunks(extraUsers, (u) => ({ ref: db.collection("users").doc(`member-${u.email}`), data: u }));
  const invites = Array.from({ length: 8 }, (_, i) => ({ email: `invite${i}@example.com`, name: `Invitee ${i}`, role: "resident", status: "pending", flat: "" }));
  await commitInChunks(invites, (v) => ({ ref: db.collection("accessInvites").doc(v.email.replace(/[^a-z0-9]/gi, "_")), data: v }));
  console.log(`  users: 2 primary + 10 extra; invites: 8`);
}

(async () => {
  console.log(`Seeding emulator project "${PROJECT_ID}" @ ${process.env.FIRESTORE_EMULATOR_HOST} ...`);
  const residents = await seedResidents();
  await seedEvents(residents);
  await seedSimpleCollections();
  await seedUsersAndAuth(residents);
  console.log("Seed complete.");
  process.exit(0);
})().catch((e) => { console.error("Seed failed:", e); process.exit(1); });
