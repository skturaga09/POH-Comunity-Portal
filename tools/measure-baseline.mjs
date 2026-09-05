// Baseline Firestore-read measurement against the emulator suite.
//
// Faithfully replays the app's read sequences (derived from portal-launcher.js)
// and reports reads per scenario, split into:
//   - server:   reads INSIDE the callables (measured exactly via pohReadStats,
//               the prototype-patch counter in functions/index.js).
//   - client:   direct getDocs the browser issues (measured via snapshot.size).
//   - rules:    security-rule get()/exists() reads — one per guarded direct
//               client query (analytic; the emulator does not report these).
//
// Emulator-only. Run via: npm run measure:baseline (see package.json).
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, collection, getDocs, query, orderBy, limit } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";

const PROJECT_ID = "poh-community-portal";
const REGION = "asia-south1";
const OWNER_EMAIL = "iamsanthoshkumar@gmail.com";
const RESIDENT_EMAIL = "resident.tester@example.com";
const PASSWORD = "test1234";

const app = initializeApp({ apiKey: "emulator", projectId: PROJECT_ID, authDomain: `${PROJECT_ID}.firebaseapp.com` });
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, REGION);
connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
connectFirestoreEmulator(db, "127.0.0.1", 8080);
connectFunctionsEmulator(functions, "127.0.0.1", 5001);

const call = (name, data) => httpsCallable(functions, name)(data).then((r) => r.data);
const readStats = (reset) => call("pohReadStats", { reset: !!reset }).then((d) => d.total);

// Client-side read accounting: wrap getDocs so every direct query is tallied.
let clientReads = 0;
let clientQueries = 0; // number of guarded queries → one rule read each
async function cGetDocs(ref, guarded = true) {
  clientQueries += guarded ? 1 : 0;
  try {
    const snap = await getDocs(ref);
    clientReads += snap.size;
    return snap;
  } catch (e) {
    // e.g. resident hitting auditLogs → permission denied. Rule still evaluated.
    return { size: 0, docs: [], _denied: true };
  }
}

// --- Faithful replay of the client bootstrap (reloadPortalData + secure) -----
// Mirrors portal-launcher.js:1345 reloadPortalData / loadAdminSecureData /
// loadExpansionData and refreshAccess:status.
async function bootstrap({ admin, warmDir = false }) {
  clientReads = 0; clientQueries = 0;
  await readStats(true); // zero the server counter

  // refreshAccess -> portalAccess:status
  await call("portalAccess", { action: "status" });

  // reloadPortalData: parallel loads
  //   direct client: events, notices, committee
  await cGetDocs(collection(db, "events"));
  await cGetDocs(collection(db, "notices"));
  await cGetDocs(collection(db, "committee"));
  //   auditLogs (H-4): admins read newest 50; non-admins skip entirely (no read).
  if (admin) {
    clientQueries += 1;
    const aud = await getDocs(query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(50)));
    clientReads += aud.size;
  }
  //   directory (H-1): residents cache the masked view for 5 min; a warm
  //   refresh/reopen skips the call. Editors (admins) never cache.
  if (!(warmDir && !admin)) await call("portalAccess", { action: "directory" });
  await call("portalAccess", { action: "commonPool" });
  //   finance: C-1 loads sub-collections only for NON-CLOSED events; closed
  //   events use the stored settlementFigures summary (no sub-reads).
  const evSnap = await getDocs(collection(db, "events")); // app reuses portalData.events; not double-counted
  for (const ev of evSnap.docs) {
    const d = ev.data();
    const status = String(d.status || "").toLowerCase();
    const closed = /settled|closed|completed/.test(status) || String(d.settlementStatus || "").toLowerCase() === "closed";
    if (closed) continue;
    await cGetDocs(collection(db, "events", ev.id, "contributions"));
    await cGetDocs(collection(db, "events", ev.id, "expenses"));
  }

  // Expansion data (H-3) is no longer loaded here — it is lazy-loaded when an
  // Amenities/Move/Contacts/Gallery page or the admin console is first opened.

  // loadAdminSecureData (admins only)
  if (admin) {
    await call("portalAccess", { action: "list" });
    await call("adminConsole", { action: "settlementSummary" });
  }

  const server = await readStats(true);
  const rules = clientQueries; // one get(users) per guarded direct query
  return { server, client: clientReads, rules, total: server + clientReads + rules };
}

// H-3: first open of Amenities/Move/Contacts/Gallery (or the admin console)
// triggers the one-time expansion fetch.
async function openExpansionPage() {
  clientReads = 0; clientQueries = 0;
  await readStats(true);
  await call("adminConsole", { action: "getExpansionData" });
  const server = await readStats(true);
  return { server, client: 0, rules: 0, total: server };
}

// Admin mutations still go through performAdminAction -> reloadPortalData +
// loadAdminSecureData (now cheaper thanks to C-1). Resident profile/vehicle
// edits now do a SCOPED directory refresh (C-2) instead of a full bootstrap.
async function writeReload({ admin }) {
  const b = await bootstrap({ admin });
  return b;
}
async function residentDirectoryWrite() {
  clientReads = 0; clientQueries = 0;
  await readStats(true);
  await call("portalAccess", { action: "directory" }); // refreshDirectory(): directory only
  const server = await readStats(true);
  return { server, client: 0, rules: 0, total: server };
}

async function feedbackTab() {
  clientReads = 0; clientQueries = 0;
  await readStats(true);
  await call("feedbackHub", { action: "list" });
  await call("feedbackHub", { action: "experience" });
  const server = await readStats(true);
  return { server, client: 0, rules: 0, total: server };
}

function row(label, r) {
  const p = (n) => String(n).padStart(7);
  return `${label.padEnd(46)} ${p(r.server)} ${p(r.client)} ${p(r.rules)} ${p(r.total)}`;
}

(async () => {
  // sanity: confirm harness can talk to the counter
  try { await readStats(true); } catch (e) {
    console.error("Cannot reach pohReadStats. Is the emulator running with POH_COUNT_READS=1?\n", e.message); process.exit(1);
  }

  console.log("\n=== POH Firestore reads per scenario (emulator baseline) ===");
  console.log(`${"scenario".padEnd(46)} ${"server".padStart(7)} ${"client".padStart(7)} ${"rules".padStart(7)} ${"TOTAL".padStart(7)}`);
  console.log("-".repeat(78));

  await signInWithEmailAndPassword(auth, RESIDENT_EMAIL, PASSWORD);
  const A = await bootstrap({ admin: false });
  console.log(row("A. Resident login -> dashboard (cold, first load)", A));
  console.log(row("B. Open Resident Directory (cached in-memory)", { server: 0, client: 0, rules: 0, total: 0 }));
  console.log(row("C. Open own flat details (cached in-memory)", { server: 0, client: 0, rules: 0, total: 0 }));
  console.log(row("D. Parking & Vehicles (cached in-memory)", { server: 0, client: 0, rules: 0, total: 0 }));
  const G = await bootstrap({ admin: false, warmDir: true });
  console.log(row("G/H. Refresh / reopen (dir version unchanged, M-A)", G));
  const ex = await openExpansionPage();
  console.log(row("   First open Amenities/Move/etc (H-3 lazy)", ex));
  const Fw = await residentDirectoryWrite();
  console.log(row("F. Per in-session WRITE (resident) -> scoped dir (C-2)", Fw));
  const fb = await feedbackTab();
  console.log(row("   Feedback tab (resident)", fb));
  await signOut(auth);

  await signInWithEmailAndPassword(auth, OWNER_EMAIL, PASSWORD);
  const E = await bootstrap({ admin: true });
  console.log(row("E. Admin login -> admin dashboard (cold)", E));
  const Ew = await writeReload({ admin: true });
  console.log(row("   Per in-session WRITE (admin) -> reload", Ew));
  await signOut(auth);

  console.log("-".repeat(78));
  console.log("A = cold login (directory changed since last visit / first ever).");
  console.log("G/H = any resident session where the directory version is unchanged — i.e. MOST");
  console.log("sessions, since the directory changes rarely. Admins never cache (unmasked PII).");
  console.log("\nNotes: server=measured inside callables; client=measured getDocs .size;");
  console.log("rules=analytic (1 users read per guarded direct query). B/C/D reuse in-memory data.\n");
  process.exit(0);
})().catch((e) => { console.error("Measurement failed:", e); process.exit(1); });
