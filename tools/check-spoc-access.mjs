/**
 * check-spoc-access.mjs — read-only diagnostic.
 *
 * For a given event (default: the one whose name contains "ganesh"), report, per
 * SPOC flat, whether an ACTIVE user account maps to that flat — i.e. whether that
 * SPOC can update contributions. Mirrors the backend logic in functions/index.js:
 *   - callerSpocAssignment(): a caller is that event's SPOC for a flat when the flat
 *     is in event.spocs[] AND either their profile.flat matches it or their login
 *     email is on that flat's resident record (RESIDENT_EMAIL_FIELDS).
 *   - assertCanManageContribution(): DIRECTORY_EDITOR_ROLES get any floor; a SPOC
 *     gets only their own floor.
 * It writes NOTHING. Safe to run against production.
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
 *   node tools/check-spoc-access.mjs                 # defaults to the Ganesha event
 *   node tools/check-spoc-access.mjs --event "Ganesh Chaturthi 2026"
 *   node tools/check-spoc-access.mjs --event <eventDocId>
 *   node tools/check-spoc-access.mjs --project poh-community-portal
 *
 * Auth: uses Application Default Credentials. Either set
 * GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account key (Firebase
 * console -> Project settings -> Service accounts -> Generate new private key), or
 * run `gcloud auth application-default login`. To test against the local emulator
 * instead, set FIRESTORE_EMULATOR_HOST=localhost:8080 (no key needed).
 *
 * Run it from the functions/ directory (which has firebase-admin installed), e.g.
 *   (cd functions && node ../tools/check-spoc-access.mjs)
 * or install firebase-admin where you run it.
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const EVENT_SELECTOR = arg("event", "ganesh");
const PROJECT_ID = arg("project", process.env.GOOGLE_CLOUD_PROJECT || "poh-community-portal");

// ---- mirror of the backend constants/helpers -----------------------------
const DIRECTORY_EDITOR_ROLES = ["super_admin", "admin", "president", "committee"];
const EMAIL_FIELDS = [
  "ownerEmail", "ownerPrimaryEmail", "ownerSecondaryEmail",
  "tenantEmail", "tenantPrimaryEmail", "tenantSecondaryEmail",
  "familyContactEmail", "primaryEmail", "secondaryEmail", "email",
];
const norm = (v) => String(v || "").trim().toUpperCase();
const lower = (v) => String(v || "").trim().toLowerCase();

// isClosedEventData() mirror — contributions are frozen when this is true.
function isClosedEventData(d) {
  const status = lower(d?.status);
  return /settled|closed|completed/.test(status) || lower(d?.settlementStatus) === "closed";
}

// callerSpocAssignment() mirror: every flat a user could be a SPOC for — their
// profile.flat, plus the flat of any residents record carrying their login email.
function creditedFlatsForUser(user, residents) {
  const out = [];
  const profileFlat = norm(user.flat);
  if (profileFlat) out.push({ flat: profileFlat, via: "profile.flat" });
  const email = lower(user.email);
  if (email) {
    for (const r of residents) {
      if (EMAIL_FIELDS.map((f) => lower(r[f])).includes(email)) {
        out.push({ flat: norm(r.flat || r.id), via: `residents email (${r.id})` });
      }
    }
  }
  return out;
}

// ---- main ----------------------------------------------------------------
async function main() {
  initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
  const db = getFirestore();

  const [eventsSnap, usersSnap, residentsSnap] = await Promise.all([
    db.collection("events").get(),
    db.collection("users").get(),
    db.collection("residents").get(),
  ]);

  const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const residents = residentsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Select the event: exact id first, else case-insensitive name/title substring.
  const sel = EVENT_SELECTOR.toLowerCase();
  const byId = eventsSnap.docs.find((d) => d.id === EVENT_SELECTOR);
  const eventDoc = byId || eventsSnap.docs.find((d) => {
    const e = d.data();
    return [e.name, e.title, e.eventName].some((n) => String(n || "").toLowerCase().includes(sel));
  });
  if (!eventDoc) {
    console.error(`No event matched "${EVENT_SELECTOR}". Events present:`);
    eventsSnap.docs.forEach((d) => console.error(`  - ${d.id}: ${d.data().name || d.data().title || "(unnamed)"}`));
    process.exit(1);
  }
  const event = { id: eventDoc.id, ...eventDoc.data() };

  console.log("=".repeat(72));
  console.log(`Event   : ${event.name || event.title || "(unnamed)"}  [${event.id}]`);
  console.log(`Status  : ${event.status || "(none)"}   settlementStatus: ${event.settlementStatus || "(none)"}`);
  if (isClosedEventData(event)) {
    console.log("⚠️  Contributions are FROZEN for this event (Completed/settled/closed).");
    console.log("    Even a correctly-matched SPOC cannot add/edit contributions here.");
  }
  console.log(`Users   : ${users.length} accounts   Residents: ${residents.length} records`);
  console.log("=".repeat(72));

  // Precompute each active user's resolved flat.
  const activeUsers = users.filter((u) => lower(u.status) === "active");
  const resolvedByFlat = new Map(); // FLAT -> [{email, role, via}]
  for (const u of activeUsers) {
    for (const { flat, via } of creditedFlatsForUser(u, residents)) {
      if (!flat) continue;
      if (!resolvedByFlat.has(flat)) resolvedByFlat.set(flat, []);
      resolvedByFlat.get(flat).push({ email: u.email || u.id, role: lower(u.role), via });
    }
  }

  // Blanket-access users (admins/committee) — access to ANY floor regardless of flat.
  const blanket = activeUsers
    .filter((u) => DIRECTORY_EDITOR_ROLES.includes(lower(u.role)))
    .map((u) => `${u.email || u.id} (${lower(u.role)})`);
  console.log(`\nBlanket contribution access (any floor) — ${blanket.length} account(s):`);
  blanket.forEach((b) => console.log(`  ✅ ${b}`));
  if (!blanket.length) console.log("  (none — no active admin/president/committee accounts)");

  const spocs = Array.isArray(event.spocs) ? event.spocs : [];
  console.log(`\nSPOCs configured on this event: ${spocs.length}`);
  if (!spocs.length) {
    console.log("  ❌ No spocs[] on the event — no floor-SPOC has access. Save SPOCs on the event.");
    return;
  }

  let ok = 0;
  const problems = [];
  console.log("");
  for (const s of spocs) {
    const flat = norm(s.flat);
    const floor = String(s.floor || "").trim();
    const label = `Floor ${floor || "?"} · Flat ${flat || "?"}`;
    if (!flat || !floor) {
      console.log(`  ❌ ${label} — spoc entry missing ${!flat ? "flat" : "floor"}; will not grant access.`);
      problems.push(`${label}: incomplete spoc entry`);
      continue;
    }
    const matches = resolvedByFlat.get(flat) || [];
    if (matches.length) {
      ok++;
      console.log(`  ✅ ${label} — access via: ${matches.map((m) => `${m.email} [${m.via}]`).join(", ")}`);
    } else {
      // Diagnose why not.
      const residentsForFlat = residents.filter((r) => norm(r.flat || r.id) === flat);
      let reason;
      if (!residentsForFlat.length) {
        reason = "no residents record for this flat";
      } else {
        const emails = [...new Set(residentsForFlat.flatMap((r) => EMAIL_FIELDS.map((f) => lower(r[f])).filter(Boolean)))];
        if (!emails.length) {
          reason = "residents record has no email on file for this flat";
        } else {
          const accounts = emails.filter((e) => users.some((u) => lower(u.email) === e));
          if (!accounts.length) {
            reason = `no user has logged in with this flat's email(s): ${emails.join(", ")}`;
          } else {
            const inactive = accounts.filter((e) => users.some((u) => lower(u.email) === e && lower(u.status) !== "active"));
            if (inactive.length) reason = `account(s) exist but are not active yet: ${inactive.join(", ")}`;
            else reason = `account(s) exist (${accounts.join(", ")}) but did not match — re-check the flat/email on the residents record`;
          }
        }
      }
      console.log(`  ❌ ${label} — NO access. Reason: ${reason}`);
      problems.push(`${label}: ${reason}`);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(`SUMMARY: ${ok}/${spocs.length} SPOC flats have an active user with update access.`);
  if (problems.length) {
    console.log("Problems to fix:");
    problems.forEach((p) => console.log(`  - ${p}`));
  } else {
    console.log("All configured SPOCs resolve to an active user. 🎉");
  }
  if (isClosedEventData(event)) {
    console.log("NOTE: contributions are frozen on this event regardless of the above.");
  }
}

main().catch((err) => { console.error("check failed:", err); process.exit(1); });
