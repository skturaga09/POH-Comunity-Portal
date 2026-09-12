const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const crypto = require("crypto");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

admin.initializeApp();
const db = admin.firestore();

// --- Read instrumentation (measurement only) --------------------------------
// When POH_COUNT_READS=1 (set ONLY by the emulator measurement harness, never
// in production), every server-side Firestore read is tallied by patching the
// SDK prototypes once. The tally lives in a Firestore doc (pohMeta/readStats)
// via an atomic increment, because the Functions emulator runs each callable in
// its OWN process — an in-memory counter is not shared across invocations, but
// a Firestore doc is. This block is a no-op unless the env var is present, so it
// adds zero overhead to the deployed functions. Read/reset via the pohReadStats
// debug callable below. See tools/measure-baseline.mjs.
const STATS_DOC_PATH = "pohMeta/readStats";
function isStatsDoc(ref) { try { return ref && ref.path === STATS_DOC_PATH; } catch (e) { return false; } }
// The Functions emulator injects POH_COUNT_READS at INVOCATION time, after the
// module has loaded, so we cannot install the patch at module top-level. Instead
// ensureReadPatch() is called at the start of each callable and installs the
// prototype patch once, gated on the runtime env var. In production the env var
// is never set, so this is a permanent no-op with zero overhead.
let READ_PATCH_DONE = false;
function ensureReadPatch() {
  if (READ_PATCH_DONE || process.env.POH_COUNT_READS !== "1") return;
  READ_PATCH_DONE = true;
  // admin.firestore.FieldValue is undefined in the emulator runtime (the class
  // statics live on a different copy than the live instances), so source it from
  // the modular subpath which shares the underlying @google-cloud/firestore.
  let FieldValueRef = admin.firestore && admin.firestore.FieldValue;
  try { if (!FieldValueRef || !FieldValueRef.increment) FieldValueRef = require("firebase-admin/firestore").FieldValue; } catch (e) {}
  const inc = (n) => db.doc(STATS_DOC_PATH).set({ total: FieldValueRef.increment(n) }, { merge: true });
  const wrapProto = (proto, isDoc, label) => {
    if (!proto || typeof proto.get !== "function" || proto.__pohPatched) return false;
    const original = proto.get;
    proto.get = async function (...args) {
      const result = await original.apply(this, args);
      if (process.env.POH_COUNT_READS === "1") {
        const n = (result && typeof result.size === "number") ? result.size : 1; // QuerySnapshot vs DocumentSnapshot
        if (!(isDoc && isStatsDoc(this))) { try { await inc(n); } catch (e) { logger.warn(`POH inc failed: ${e.message}`); } } // never count the stats doc itself
      }
      return result;
    };
    proto.__pohPatched = true;
    return true;
  };
  // Derive prototypes from LIVE instances — in the emulator runtime the class
  // statics on admin.firestore are not the same objects the instances use.
  try {
    const colRef = db.collection("__pohProbe__");
    const collectionProto = Object.getPrototypeOf(colRef);          // CollectionReference.prototype
    const queryProto = Object.getPrototypeOf(collectionProto);      // Query.prototype (owns get)
    const docProto = Object.getPrototypeOf(db.doc("__pohProbe__/x")); // DocumentReference.prototype
    wrapProto(queryProto, false, "Query");
    wrapProto(collectionProto, false, "Collection"); // no-op if get is inherited (skipped via __pohPatched)
    wrapProto(docProto, true, "Document");
  } catch (e) { logger.warn(`POH readPatch failed: ${e.message}`); }
}

// (Legacy MIGRATION_KEY removed with the importLegacySnapshot endpoint — the
// authenticated adminConsole "importSpreadsheet" action covers imports.)

// Robust FieldValue: admin.firestore.FieldValue is undefined in the emulator
// runtime (class statics live on a different copy than the live instances), so
// fall back to the modular subpath which shares the underlying firestore. Used
// for the directory-version counter; existing serverTimestamp() calls are left
// as-is (they run in production, where admin.firestore.FieldValue is defined).
const FIELD_VALUE = (admin.firestore.FieldValue && admin.firestore.FieldValue.increment)
  ? admin.firestore.FieldValue
  : require("firebase-admin/firestore").FieldValue;

// M-A (directory version sentinel): a single small doc whose counter is bumped
// whenever the residents directory changes. Clients cache the (masked) directory
// keyed by this version and skip the ~148-doc directory fetch on any session
// where the version is unchanged — which is most sessions, since the directory
// changes rarely.
const DIRECTORY_VERSION_PATH = "pohMeta/directoryVersion";
async function bumpDirectoryVersion() {
  try { await db.doc(DIRECTORY_VERSION_PATH).set({ v: FIELD_VALUE.increment(1), at: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); }
  catch (e) { logger.warn(`directory version bump failed: ${e.message}`); }
}
async function readDirectoryVersion() {
  try { const s = await db.doc(DIRECTORY_VERSION_PATH).get(); return s.exists ? Number(s.data().v || 0) : 0; }
  catch (e) { return 0; }
}

// Mirror of the client isClosed(): closed/settled events have frozen finance.
function isClosedEventData(d) {
  const status = String((d && d.status) || "").toLowerCase();
  return /settled|closed|completed/.test(status) || String((d && d.settlementStatus) || "").toLowerCase() === "closed";
}

// Narrower than isClosedEventData: only events whose finances are frozen by settlement
// (settled/closed status, or a treasurer-confirmed/closed settlementStatus). A plain
// "Completed" event is NOT included, so a mistaken completion can still be undone by
// re-activating it.
function isSettledEventData(d) {
  const status = String((d && d.status) || "").toLowerCase();
  const settlement = String((d && d.settlementStatus) || "").toLowerCase();
  return /settled|closed/.test(status) || settlement === "treasurer confirmed" || settlement === "closed";
}

function key(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function pick(row, names) {
  const source = row || {};
  const target = names.map(key);
  for (const [column, value] of Object.entries(source)) {
    if (target.includes(key(column)) && value !== "" && value !== null && value !== undefined) return value;
  }
  return "";
}

function clean(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function bool(value) {
  return /^(true|yes|y|1|active|published)$/i.test(String(value || ""));
}

function safeId(value, fallback) {
  const candidate = String(value || fallback || "").trim().replace(/[\\/#?\[\]]/g, "-");
  return candidate.slice(0, 120) || fallback;
}

function valueAt(row, index) {
  return Object.values(row || {})[index] ?? "";
}

async function writeAll(items) {
  for (let offset = 0; offset < items.length; offset += 400) {
    const batch = db.batch();
    items.slice(offset, offset + 400).forEach(({ ref, data }) => batch.set(ref, data, { merge: true }));
    await batch.commit();
  }
}

async function processSnapshotData(snapshot) {
  const sheets = snapshot.sheets || snapshot || {};
  const findSheet = (name) => {
    if (Array.isArray(sheets[name])) return sheets[name];
    const k = Object.keys(sheets).find((key) => key.trim().toLowerCase() === name.toLowerCase());
    return k && Array.isArray(sheets[k]) ? sheets[k] : [];
  };

  const now = admin.firestore.FieldValue.serverTimestamp();
  const writes = [];
  const events = findSheet("Events");
  const notices = findSheet("Notices");
  const residents = findSheet("Master");
  const committee = findSheet("Committee");
  const expenses = findSheet("Expenses");
  const contributions = findSheet("Contributions");
  const responses = findSheet("Responses");
  const spocSheet = findSheet("SPOC") || findSheet("SPOCs") || findSheet("Spoc");

  const eventIdBySourceValue = new Map();
  events.forEach((row, index) => {
    const id = safeId(pick(row, ["Event ID", "EventId", "ID", "Event Code"]) || pick(row, ["Event Name", "Name", "Event"]), `event-${index + 1}`);
    let name = pick(row, ["Event Name", "Name", "Event", "Title"]);
    if (name && /79th/i.test(name)) name = name.replace(/79th/i, "80th");
    [id, name, pick(row, ["Event ID", "EventId", "ID", "Event Code"])]
      .filter(Boolean).forEach((value) => eventIdBySourceValue.set(key(value), id));
  });

  // Collect floor SPOC mappings from SPOC sheet, Responses, and Contributions sheets
  const spocMapByEvent = new Map(); // eventId -> Map(floor -> flat)
  const extractSpoc = (eventId, row) => {
    if (!row || typeof row !== "object") return;
    const floor = pick(row, ["Floor", "Floor No", "Level"]) || valueAt(row, 1);
    const spocVal = pick(row, ["SPOC", "Floor SPOC", "Spoc", "Point of Contact", "Name", "Flat", "Flat No"]) || valueAt(row, 5);
    if (!floor || !spocVal) return;
    const cleanFloor = String(floor).replace(/\D+/g, "") || String(floor).trim();
    // Try to extract 3-digit flat number (e.g. 604 from 'Flat 604' or 'Uma (604)')
    const match = String(spocVal).match(/\b(\d{3})\b/) || String(JSON.stringify(row)).match(/\b([1-7]\d{2})\b/);
    const flat = match ? match[1] : String(spocVal).trim();
    if (!flat) return;
    const targetEventId = eventId || "INDEPENDENCE-2026";
    if (!spocMapByEvent.has(targetEventId)) spocMapByEvent.set(targetEventId, new Map());
    const floorMap = spocMapByEvent.get(targetEventId);
    if (!floorMap.has(cleanFloor)) floorMap.set(cleanFloor, flat);
  };

  spocSheet.forEach((row) => {
    const sourceEvent = pick(row, ["Event ID", "EventId", "Event", "Event Name"]);
    const eventId = sourceEvent ? (eventIdBySourceValue.get(key(sourceEvent)) || safeId(sourceEvent)) : "INDEPENDENCE-2026";
    extractSpoc(eventId, row);
  });

  responses.forEach((row) => {
    const eventId = safeId(pick(row, ["Event ID", "EventId"]) || valueAt(row, 9), "INDEPENDENCE-2026");
    extractSpoc(eventId, row);
  });

  contributions.forEach((row) => {
    const sourceEvent = pick(row, ["Event ID", "EventId", "Event", "Event Name"]);
    const eventId = sourceEvent ? (eventIdBySourceValue.get(key(sourceEvent)) || safeId(sourceEvent)) : "INDEPENDENCE-2026";
    extractSpoc(eventId, row);
  });

  // If events sheet is empty, create standard Independence Day 2026 event doc
  if (events.length === 0) {
    events.push({
      "Event ID": "INDEPENDENCE-2026",
      "Event Name": "80th Independence Day Celebrations",
      "Status": "Active",
      "Date": "2026-08-15",
      "Description": "80th Independence Day Celebration & Flag Hoisting at POH Main Lawn.",
      "Active": true
    });
  }

  events.forEach((row, index) => {
    const id = safeId(pick(row, ["Event ID", "EventId", "ID", "Event Code"]) || pick(row, ["Event Name", "Name", "Event"]), `event-${index + 1}`);
    let name = pick(row, ["Event Name", "Name", "Event", "Title"]);
    if (!name || /79th/i.test(name) || /independence/i.test(name)) name = "80th Independence Day Celebrations";
    const isIndy = /independence/i.test(name || id);
    
    // Aggregate all SPOC mappings found across spocSheet, responses, and contributions
    const combinedFloorMap = new Map();
    [spocMapByEvent.get(id), spocMapByEvent.get("INDEPENDENCE-2026"), ...spocMapByEvent.values()].forEach(map => {
      if (map) map.forEach((flat, floor) => { if (!combinedFloorMap.has(floor)) combinedFloorMap.set(floor, flat); });
    });

    const spocs = Array.from(combinedFloorMap.entries()).map(([floor, flat]) => ({ floor, flat }));
    writes.push({ ref: db.collection("events").doc(id), data: clean({
      id,
      name,
      status: pick(row, ["Status", "Event Status"]) || "Active",
      date: pick(row, ["Date", "Event Date", "Start Date"]) || (isIndy ? "2026-08-15" : ""),
      description: pick(row, ["Description", "Details", "About"]) || (isIndy ? "80th Independence Day Celebration & Flag Hoisting at POH Main Lawn." : ""),
      spoc: pick(row, ["SPOC", "Spoc", "Point of Contact"]),
      spocs: spocs.length ? spocs : undefined,
      commonPoolAllocation: Number(pick(row, ["Common Pool Allocation", "Common Pool", "Pool Allocation"]) || 0),
      active: bool(pick(row, ["Active", "Is Active"])) || isIndy || index === 0,
      importedAt: now,
      source: "apps-script"
    }) });
  });

  notices.forEach((row, index) => {
    const id = safeId(pick(row, ["Notice ID", "ID", "Title"]), `notice-${index + 1}`);
    writes.push({ ref: db.collection("notices").doc(id), data: clean({
      id,
      title: pick(row, ["Title", "Notice Title", "Subject"]),
      body: pick(row, ["Message", "Content", "Details", "Description"]),
      type: pick(row, ["Type", "Notice Type", "Category"]) || "Update",
      priority: pick(row, ["Priority"]) || "Normal",
      publishedAt: pick(row, ["Published At", "Date", "Published Date"]),
      expiresAt: pick(row, ["Expiry", "Expires At", "Expiry Date"]),
      published: !/^(false|no|draft)$/i.test(String(pick(row, ["Published", "Status"]) || "")),
      importedAt: now,
      source: "apps-script"
    }) });
  });

  residents.forEach((row, index) => {
    const flat = safeId(pick(row, ["Flat No", "Flat", "Apartment", "Unit"]), `resident-${index + 1}`);
    const owner = pick(row, ["Owner Name", "Owner", "Name"]);
    const tenant = pick(row, ["Tenant Name", "Tenent Name", "Tenant"]);
    const occupancyRaw = pick(row, ["Occupancy", "Occupancy Type", "Status"]);
    const occupancy = occupancyRaw || (tenant ? "Tenant occupied" : owner ? "Owner occupied" : "Unverified");
    const mobile = pick(row, ["Mobile", "Phone", "Phone Number", "Owner Mobile", "Mobile Number", "Contact"]);
    const tenantMobile = pick(row, ["Tenant Mobile", "Tenant Phone", "Tenant Contact"]);
    const email = pick(row, ["Email", "Email ID"]);
    const photoUrl = pick(row, ["Photo URL", "Photo", "Profile Photo", "Owner Photo"]);

    if (email) {
      writes.push({ ref: db.collection("accessInvites").doc(emailKey(email)), data: clean({
        email: String(email).toLowerCase().trim(),
        name: owner || tenant || `Resident ${flat}`,
        role: "resident",
        status: "active",
        importedAt: now,
        source: "apps-script-resident"
      }) });
    }

    const residentData = clean({
      flat,
      floor: pick(row, ["Floor"]),
      ownerName: owner,
      tenantName: tenant,
      occupancy,
      occupancyStatus: occupancy,
      phone: mobile,
      ownerMobile: mobile,
      tenantMobile: tenantMobile,
      email,
      parkingLevel: pick(row, ["Parking Level", "Parking", "Car Parking", "Level"]),
      parkingType: pick(row, ["Parking Type", "Car Parking Type", "Parking Allocation", "Allocation"]),
      parkingSlots: pick(row, ["Parking Slots", "Slots", "Slot"]),
      parkingAllocation: pick(row, ["Parking Allocation", "Parking Type", "Allocation"]),
      twoWheeler: pick(row, ["Two Wheeler", "2 Wheeler"]),
      fourWheeler: pick(row, ["Four Wheeler", "4 Wheeler", "Car"]),
      vehicles: pick(row, ["Vehicles"]),
      importedAt: now,
      source: "apps-script"
    });

    if (photoUrl) {
      residentData.ownerPhotoUrl = photoUrl;
      residentData.photoUrl = photoUrl;
    }

    writes.push({ ref: db.collection("residents").doc(flat), data: residentData });
  });

  committee.forEach((row, index) => {
    const name = pick(row, ["Name", "Member Name"]);
    const id = safeId(pick(row, ["ID", "Member ID"]) || name, `committee-${index + 1}`);
    writes.push({ ref: db.collection("committee").doc(id), data: clean({
      id,
      name,
      role: pick(row, ["Role", "Designation"]) || "Committee member",
      phone: pick(row, ["Phone", "Mobile"]),
      email: pick(row, ["Email", "Email ID"]),
      photoUrl: pick(row, ["Photo URL", "Photo"]),
      importedAt: now,
      source: "apps-script"
    }) });
  });

  const eventForRow = (row) => {
    const sourceEvent = pick(row, ["Event ID", "EventId", "Event", "Event Name"]);
    return eventIdBySourceValue.get(key(sourceEvent)) || safeId(sourceEvent, "unassigned");
  };
  expenses.forEach((row, index) => {
    const eventId = eventForRow(row);
    const id = safeId(pick(row, ["Expense ID", "ID"]), `expense-${index + 1}`);
    writes.push({ ref: db.collection("events").doc(eventId).collection("expenses").doc(id), data: clean({
      id,
      eventId,
      date: pick(row, ["Date", "Expense Date"]),
      category: pick(row, ["Category"]),
      description: pick(row, ["Description", "Details"]),
      amount: Number(pick(row, ["Amount"]) || 0),
      paidBy: pick(row, ["Paid By", "Payer"]),
      paymentMode: pick(row, ["Payment Mode", "Payment"]),
      reference: pick(row, ["Reference", "Transaction Reference"]),
      remarks: pick(row, ["Remarks", "Notes"]),
      receiptUrl: pick(row, ["Receipt URL", "Receipt", "Receipt Link"]),
      status: pick(row, ["Status"]) || "Approved",
      importedAt: now,
      source: "apps-script"
    }) });
  });

  contributions.forEach((row, index) => {
    const eventId = eventForRow(row);
    const id = safeId(pick(row, ["Contribution ID", "ID"]), `contribution-${index + 1}`);
    writes.push({ ref: db.collection("events").doc(eventId).collection("contributions").doc(id), data: clean({
      id,
      eventId,
      date: pick(row, ["Date", "Contribution Date"]),
      name: pick(row, ["Name", "Contributor Name", "Paid By"]),
      floor: pick(row, ["Floor"]),
      flat: pick(row, ["Flat", "Flat No"]),
      phone: pick(row, ["Phone", "Mobile", "Phone Number"]),
      amount: Number(pick(row, ["Amount"]) || 0),
      paymentMode: pick(row, ["Payment Mode", "Payment"]),
      reference: pick(row, ["Reference", "Transaction Reference"]),
      status: pick(row, ["Status"]) || "Received",
      importedAt: now,
      source: "apps-script"
    }) });
  });

  responses.forEach((row, index) => {
    const eventId = safeId(pick(row, ["Event ID", "EventId"]) || valueAt(row, 9), "INDEPENDENCE-2026");
    const flat = pick(row, ["Flat", "Flat No", "Flat Number"]) || valueAt(row, 2);
    const id = safeId(`${eventId}-${flat || `response-${index + 1}`}`, `response-${index + 1}`);
    writes.push({ ref: db.collection("events").doc(eventId).collection("contributions").doc(id), data: clean({
      id,
      eventId,
      date: pick(row, ["Timestamp", "Date", "Contribution Date"]) || valueAt(row, 0),
      floor: pick(row, ["Floor"]) || valueAt(row, 1),
      flat,
      name: pick(row, ["Owner", "Owner Name", "Name", "Contributor Name"]) || valueAt(row, 3),
      phone: pick(row, ["Mobile", "Phone", "Phone Number"]) || valueAt(row, 4),
      spoc: pick(row, ["SPOC", "Floor SPOC"]) || valueAt(row, 5),
      amount: Number(pick(row, ["Amount", "Contribution Amount"]) || valueAt(row, 6) || 0),
      paymentMode: pick(row, ["Payment", "Payment Mode"]) || valueAt(row, 7),
      reference: pick(row, ["Reference", "Transaction Reference"]) || valueAt(row, 8),
      status: "Received",
      importedAt: now,
      source: "apps-script-responses"
    }) });
  });

  const usersSheet = findSheet("Users");
  usersSheet.forEach((row) => {
    const email = pick(row, ["Email", "Email ID", "Google Email"]);
    if (email) {
      const keyStr = emailKey(email);
      writes.push({ ref: db.collection("accessInvites").doc(keyStr), data: clean({
        email: email.toLowerCase().trim(),
        name: pick(row, ["Name", "Full Name", "User Name"]),
        role: (pick(row, ["Role", "Access Level"]) || "resident").toLowerCase().replace(/\s+/g, "_"),
        status: (pick(row, ["Status"]) || "active").toLowerCase(),
        importedAt: now,
        source: "apps-script"
      }) });
    }
  });

  // Ensure default super_admin and committee emails have active invites & user records
  const defaultAdmins = [
    { email: "iamsanthoshkumar@gmail.com", name: "Santhosh kumar Turaga", role: "super_admin", status: "active" },
    { email: "poh.association@gmail.com", name: "POH Admin", role: "admin", status: "active" }
  ];
  defaultAdmins.forEach(adm => {
    writes.push({ ref: db.collection("accessInvites").doc(emailKey(adm.email)), data: adm });
  });

  writes.push({ ref: db.collection("system").doc("migration"), data: {
    completedAt: now,
    exportedAt: snapshot.exportedAt || new Date().toISOString(),
    counts: { events: events.length, notices: notices.length, residents: residents.length, committee: committee.length, expenses: expenses.length, contributions: contributions.length + responses.length },
    source: "apps-script"
  } });

  await writeAll(writes);
  if (residents.length) await bumpDirectoryVersion();
  return { ok: true, writes: writes.length, counts: { events: events.length, notices: notices.length, residents: residents.length, committee: committee.length, expenses: expenses.length, contributions: contributions.length + responses.length } };
}

// The legacy importLegacySnapshot HTTP endpoint (key-gated, unauthenticated) has
// been removed. It was a one-time Apps Script -> Firebase migration importer and
// duplicated the authenticated adminConsole "importSpreadsheet" action, which is
// the supported path for admins to import data.

const ADMIN_ROLES = ["super_admin", "admin", "president"];
const FINANCE_ROLES = [...ADMIN_ROLES, "treasurer", "committee"];
const DIRECTORY_EDITOR_ROLES = [...ADMIN_ROLES, "committee"];
const MODERATOR_ROLES = [...ADMIN_ROLES, "committee"];
const USER_ROLES = ["resident", "committee", "treasurer", "president", "admin", "super_admin", "manager"];
const FEEDBACK_TYPES = ["feature", "bug", "improvement"];

// Complaints & Helpdesk ticketing. Managers (+ admins) triage; residents raise & track.
const MANAGER_ROLES = [...ADMIN_ROLES, "manager"];
const TICKET_CATEGORIES = ["Electrical", "Plumbing", "Housekeeping", "Carpentry", "Lift", "Security", "STP/Garden", "Common Area", "Other"];
const TICKET_TEAMS = ["Electrician", "Plumber", "Housekeeping", "Carpenter", "Lift Technician", "Security", "Gardener/STP", "Civil", "Other"];
const TICKET_PRIORITIES = ["Low", "Normal", "High", "Urgent"];
const TICKET_STATUSES = ["Open", "Assigned", "In Progress", "Resolved", "Closed", "Reopened", "Cancelled"];
const TICKET_OPEN_STATES = ["Open", "Assigned", "In Progress", "Reopened"];
const FEEDBACK_AREAS = ["Directory", "Events", "Finance", "Parking", "Emergency", "Amenities", "Notices", "General"];
const FEEDBACK_STATUSES = ["Open", "Under review", "Planned", "In progress", "Done", "Declined"];

function emailKey(email) { return String(email || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"); }
function displayRole(role) { return String(role || "resident").replace(/_/g, " "); }

// Grant resident portal access from directory emails. Upserts an accessInvites
// record per email (keyed by email) so the person is admitted on first sign-in.
// This is grant-only: it never revokes, and it never downgrades an email that
// already carries an elevated role (admin/president/treasurer/committee/etc.).
async function syncDirectoryAccess(entries) {
  const granted = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const email = String(entry.email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    const inviteRef = db.collection("accessInvites").doc(emailKey(email));
    const existing = await inviteRef.get();
    const existingRole = String(existing.data()?.role || "").toLowerCase();
    // Preserve any non-resident role already assigned to this email.
    if (existing.exists && existingRole && existingRole !== "resident") continue;
    const data = {
      email,
      name: String(entry.name || existing.data()?.name || email.split("@")[0]).trim(),
      role: "resident",
      status: "active",
      residentType: entry.residentType || "Owner",
      flat: entry.flat || "",
      source: "directory-sync",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (!existing.exists) data.invitedAt = admin.firestore.FieldValue.serverTimestamp();
    await inviteRef.set(data, { merge: true });
    granted.push(email);
  }
  return granted;
}

function maskPhone(phone) {
  const p = String(phone || "").trim();
  if (!p) return "";
  if (p.length < 7) return "*****";
  if (p.startsWith("+91")) {
    return `+91 ${p.replace("+91", "").trim().slice(0, 2)}***** ${p.slice(-3)}`;
  }
  return `${p.slice(0, 3)}***** ${p.slice(-3)}`;
}

function directoryRecord(entry, revealPrivate, callerEmail = "") {
  const resident = entry.data() || {};
  const ownerName = resident.ownerName || resident.name || "Resident";
  const tenantName = resident.tenantName || "";
  const ownerMobile = resident.ownerMobile || resident.phone || "";
  const tenantMobile = resident.tenantMobile || "";

  const caretakerName = resident.caretakerName || "";
  const caretakerMobile = resident.caretakerMobile || "";
  const caretakerRelation = resident.caretakerRelation || "";
  const isOutstation = Boolean(resident.isOutstation);

  // Email addresses are private. Reveal them to directory editors (admins /
  // committee), or to the resident viewing their own flat, and mask them from
  // every other resident so the directory can't be used to harvest emails.
  const ownerEmail = resident.ownerEmail || resident.ownerPrimaryEmail || "";
  const ownerPrimaryEmail = resident.ownerPrimaryEmail || resident.ownerEmail || "";
  const ownerSecondaryEmail = resident.ownerSecondaryEmail || "";
  const tenantEmail = resident.tenantEmail || resident.tenantPrimaryEmail || "";
  const tenantPrimaryEmail = resident.tenantPrimaryEmail || resident.tenantEmail || "";
  const tenantSecondaryEmail = resident.tenantSecondaryEmail || "";
  const familyContactEmail = resident.familyContactEmail || "";
  const normalizedCaller = String(callerEmail || "").trim().toLowerCase();
  const ownFlat = Boolean(normalizedCaller) && [ownerEmail, ownerPrimaryEmail, ownerSecondaryEmail, tenantEmail, tenantPrimaryEmail, tenantSecondaryEmail, familyContactEmail]
    .some((e) => String(e || "").trim().toLowerCase() === normalizedCaller);
  const showEmails = revealPrivate || ownFlat;
  const email = (value) => (showEmails ? value : "");

  const base = {
    id: entry.id,
    flat: resident.flat || entry.id,
    flatNo: resident.flatNo || resident.flat || entry.id,
    floor: resident.floor || "",
    ownerName,
    tenantName,
    caretakerName,
    caretakerRelation,
    isOutstation,
    subStatus: resident.subStatus || "",
    ownerEmail: email(ownerEmail),
    ownerPrimaryEmail: email(ownerPrimaryEmail),
    ownerSecondaryEmail: email(ownerSecondaryEmail),
    tenantEmail: email(tenantEmail),
    tenantPrimaryEmail: email(tenantPrimaryEmail),
    tenantSecondaryEmail: email(tenantSecondaryEmail),
    familyContactName: resident.familyContactName || "",
    familyContactMobile: resident.familyContactMobile || resident.familyContactPhone || "",
    familyContactEmail: email(familyContactEmail),
    familyContactRelation: resident.familyContactRelation || "",
    occupancy: resident.occupancy || resident.occupancyStatus || "Unverified",
    occupancyStatus: resident.occupancyStatus || resident.occupancy || "Unverified",
    photoUrl: resident.ownerPhotoUrl || resident.photoUrl || "",
    ownerPhotoUrl: resident.ownerPhotoUrl || resident.photoUrl || ""
  };

  if (!revealPrivate) {
    return {
      ...base,
      phone: maskPhone(ownerMobile),
      ownerMobile: maskPhone(ownerMobile),
      tenantMobile: maskPhone(tenantMobile),
      caretakerMobile: maskPhone(caretakerMobile),
      isMasked: true,
      // A resident may see (and self-service) their own flat's vehicles & parking.
      ...(ownFlat ? {
        vehicles: Array.isArray(resident.vehicles) ? resident.vehicles : [],
        parkingAllocation: resident.parkingAllocation || resident.parkingType || "",
        parkingLevel: resident.parkingLevel || "",
        parkingSlots: resident.parkingSlots || ""
      } : {})
    };
  }

  return {
    ...base,
    name: ownerName,
    phone: ownerMobile,
    ownerMobile,
    tenantMobile,
    caretakerMobile,
    parkingAllocation: resident.parkingAllocation || resident.parkingType || "",
    parkingLevel: resident.parkingLevel || "",
    parkingSlots: resident.parkingSlots || "",
    vehicles: Array.isArray(resident.vehicles) ? resident.vehicles : [],
    isMasked: false
  };
}

async function callerProfile(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to use the POH Community Portal.");
  const profile = await db.collection("users").doc(request.auth.uid).get();
  return { uid: request.auth.uid, email: request.auth.token.email || "", profile: profile.exists ? profile.data() : null };
}

function ensureActive(profile) {
  if (!profile || profile.status !== "active") throw new HttpsError("permission-denied", "Your portal access is not active.");
}

function ensureRole(profile, roles) {
  ensureActive(profile);
  if (!roles.includes(profile.role)) throw new HttpsError("permission-denied", "You do not have permission for this portal action.");
}

// Resolve the caller's flat, preferring their profile, then matching their
// email against any owner/tenant/family email in the directory.
// Every resident email field a SPOC's login could be recorded under. Kept identical to
// the client (getUserResidentRecord) so front end and back end resolve a SPOC the same
// way — a mismatched list previously let one layer grant access while the other denied.
const RESIDENT_EMAIL_FIELDS = [
  "ownerEmail", "ownerPrimaryEmail", "ownerSecondaryEmail",
  "tenantEmail", "tenantPrimaryEmail", "tenantSecondaryEmail",
  "familyContactEmail", "primaryEmail", "secondaryEmail", "email",
];
function residentEmails(r) {
  return RESIDENT_EMAIL_FIELDS.map((f) => String((r && r[f]) || "").trim().toLowerCase()).filter(Boolean);
}

// Normalize a contribution date from the client (a yyyy-mm-dd or ISO string) to an ISO
// timestamp. Empty -> now. Rejects unparseable or clearly-future (>1 day skew) dates.
function normalizeContributionDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  if (Number.isNaN(d.valueOf())) throw new HttpsError("invalid-argument", "Enter a valid contribution date.");
  if (d.getTime() > Date.now() + 24 * 60 * 60 * 1000) throw new HttpsError("invalid-argument", "Contribution date cannot be in the future.");
  return d.toISOString();
}

async function resolveCallerFlat(caller) {
  const fromProfile = String(caller.profile?.flat || "").trim().toUpperCase();
  if (fromProfile) return fromProfile;
  const email = String(caller.email || "").trim().toLowerCase();
  if (!email) return "";
  const snap = await db.collection("residents").get();
  const match = snap.docs.find((doc) => residentEmails(doc.data()).includes(email));
  return match ? String(match.data().flat || match.id).trim().toUpperCase() : "";
}

// The caller's SPOC assignment ({floor, flat}) for a SPECIFIC event, or null.
// Email-based and event-scoped: the caller is that event's SPOC for a flat when the
// flat is in THIS event's spocs[] AND either their profile.flat matches it or their
// login email is on that flat's resident record. Because spocs[] is per event, the
// assignment applies only to this event and ends when it closes (contributions are
// then frozen for everyone) — access never carries to other/future events.
async function callerSpocAssignment(caller, eventData) {
  const spocs = Array.isArray(eventData?.spocs) ? eventData.spocs : [];
  if (!spocs.length) return null;
  const spocByFlat = (flat) => spocs.find((s) => String(s.flat || "").trim().toUpperCase() === flat) || null;
  const profileFlat = String(caller.profile?.flat || "").trim().toUpperCase();
  if (profileFlat) {
    const viaProfile = spocByFlat(profileFlat);
    if (viaProfile) return viaProfile;
  }
  const email = String(caller.email || "").trim().toLowerCase();
  if (!email) return null;
  const spocFlats = new Set(spocs.map((s) => String(s.flat || "").trim().toUpperCase()).filter(Boolean));
  const snap = await db.collection("residents").get();
  for (const doc of snap.docs) {
    const r = doc.data();
    const flat = String(r.flat || doc.id).trim().toUpperCase();
    if (spocFlats.has(flat) && residentEmails(r).includes(email)) return spocByFlat(flat);
  }
  return null;
}

// Contribution management access: admins + committee (DIRECTORY_EDITOR_ROLES) have
// full access to any floor; an event SPOC may manage only their own floor. Throws
// HttpsError if the caller isn't permitted for `floor`.
async function assertCanManageContribution(caller, eventData, floor) {
  if (DIRECTORY_EDITOR_ROLES.includes(caller.profile.role)) return;
  const spocMatch = await callerSpocAssignment(caller, eventData);
  if (!spocMatch) throw new HttpsError("permission-denied", "Only the floor SPOC, an administrator, or a committee member can manage contributions for this event.");
  const spocFloor = String(spocMatch.floor || "").trim();
  if (spocFloor && floor && spocFloor !== floor) throw new HttpsError("permission-denied", `As the Floor ${spocFloor} SPOC you can manage contributions only for your own floor.`);
}

async function writeAudit(action, entity, detail, actor) {
  await db.collection("auditLogs").add({ action, entity, detail, actor: actor.email || actor.uid, actorName: actor.profile?.name || actor.email || "Portal user", createdAt: admin.firestore.FieldValue.serverTimestamp() });
}

async function eventFigures(eventId) {
  const eventRef = db.collection("events").doc(eventId);
  const [event, contributions, expenses] = await Promise.all([
    eventRef.get(),
    eventRef.collection("contributions").get(),
    eventRef.collection("expenses").get()
  ]);
  const standardCollected = contributions.docs.reduce((total, entry) => total + Number(entry.data().amount || 0), 0);
  const spent = expenses.docs
    .filter((entry) => String(entry.data().status || "Approved").toLowerCase() === "approved")
    .reduce((total, entry) => total + Number(entry.data().amount || 0), 0);
  const poolAllocated = Number(event.data()?.commonPoolAllocation || 0);
  const pendingExpenses = expenses.docs.filter((entry) => String(entry.data().status || "").toLowerCase() === "pending").length;
  // Deficit-recovery (ad-hoc) top-ups only exist once an event ran a deficit, so read
  // that sub-collection only when the base balance is negative (mirrors the client and
  // avoids an always-empty read per event). They count toward collected, so any
  // resulting surplus is carried to the common pool at settlement/close.
  let additionalCollected = 0;
  if (standardCollected + poolAllocated - spent < 0) {
    const additional = await eventRef.collection("additionalContributions").get();
    additionalCollected = additional.docs.reduce((total, entry) => total + Number(entry.data().amount || 0), 0);
  }
  const collected = standardCollected + additionalCollected;
  return { collected, poolAllocated, spent, balance: collected + poolAllocated - spent, pendingExpenses };
}

exports.portalAccess = onCall({ region: "asia-south1" }, async (request) => {
  ensureReadPatch();
  const action = String(request.data?.action || "status");
  const caller = await callerProfile(request);
  if (action === "status") {
    let prof = caller.profile;
    if (!prof) {
      const invite = await db.collection("accessInvites").doc(emailKey(caller.email)).get();
      if (!invite.exists) return { profile: null };
      const invitation = invite.data();
      prof = { uid: caller.uid, email: caller.email, name: invitation.name || request.auth.token.name || caller.email, role: invitation.role || "resident", status: invitation.status || "pending", flat: invitation.flat || "", residentType: invitation.residentType || "", createdAt: admin.firestore.FieldValue.serverTimestamp() };
      await db.collection("users").doc(caller.uid).set(prof, { merge: true });
      if (prof.status === "active") await writeAudit("Activated invited portal access", "User access", caller.email, { ...caller, profile: prof });
    }
    const isOwner = String(caller.email || "").toLowerCase() === "iamsanthoshkumar@gmail.com";
    const publicProfile = { ...prof, role: (!isOwner && prof.role === "super_admin") ? "admin" : prof.role, createdAt: null };
    // Return the directory version so the client can reuse its cached directory
    // without re-fetching it when the directory hasn't changed (M-A).
    return { profile: publicProfile, directoryVersion: await readDirectoryVersion() };
  }
  if (action === "directory") {
    ensureActive(caller.profile);
    const revealPrivate = DIRECTORY_EDITOR_ROLES.includes(caller.profile.role);
    const residents = await db.collection("residents").get();
    return {
      residents: residents.docs.map((entry) => directoryRecord(entry, revealPrivate, caller.email)),
      directoryVersion: await readDirectoryVersion()
    };
  }
  if (action === "commonPool") {
    ensureActive(caller.profile);
    const fund = await db.collection("system").doc("communityFund").get();
    return { balance: Number(fund.data()?.balance || 0), lastEventId: fund.data()?.lastEventId || "" };
  }
  ensureRole(caller.profile, ["super_admin", "admin"]);
  if (action === "list") {
    const isOwner = String(caller.email || "").toLowerCase() === "iamsanthoshkumar@gmail.com";
    const [usersSnap, invitesSnap] = await Promise.all([db.collection("users").get(), db.collection("accessInvites").get()]);
    
    const sanitizeRole = (item) => {
      const data = { ...item };
      if (!isOwner && data.role === "super_admin") {
        data.role = "admin";
      }
      return data;
    };

    return {
      users: usersSnap.docs.map((entry) => sanitizeRole({ id: entry.id, ...entry.data() })),
      invites: invitesSnap.docs.map((entry) => sanitizeRole({ id: entry.id, ...entry.data(), invited: true }))
    };
  }
  if (action === "checkUser") {
    ensureRole(caller.profile, ["super_admin", "admin"]);
    const email = String(request.data?.email || "").trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email address.");
    try {
      const user = await admin.auth().getUserByEmail(email);
      return { exists: true, name: user.displayName || user.email.split("@")[0] };
    } catch (error) {
      if (error.code === "auth/user-not-found") return { exists: false };
      throw error;
    }
  }
  if (action === "save") {
    const payload = request.data?.profile || {};
    const email = String(payload.email || "").trim().toLowerCase();
    const role = String(payload.role || "resident").toLowerCase();
    const residentType = String(payload.residentType || "Owner").trim();
    const flat = String(payload.flat || "").trim().toUpperCase();
    const sendInviteEmail = payload.sendInviteEmail !== false && payload.sendInviteEmail !== "false";
    const status = String(payload.status || "active").toLowerCase() === "active" ? "active" : "inactive";
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpsError("invalid-argument", "Enter a valid email address.");
    if (!USER_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Choose a valid portal role.");
    if (role === "super_admin" && email !== caller.email) throw new HttpsError("permission-denied", "The protected super-admin role cannot be reassigned here.");
    let targetUid = "";
    try { targetUid = (await admin.auth().getUserByEmail(email)).uid; } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    const target = { email, name: String(payload.name || "").trim() || email.split("@")[0], role, residentType, status, flat, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (targetUid) await db.collection("users").doc(targetUid).set({ ...target, uid: targetUid }, { merge: true });
    else await db.collection("accessInvites").doc(emailKey(email)).set({ ...target, invitedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

    // If flat is specified and user is Owner, auto-link ownerEmail in directory
    if (flat && residentType === "Owner") {
      const resRef = db.collection("residents").doc(flat);
      const resSnap = await resRef.get();
      if (resSnap.exists) {
        await resRef.set({ ownerEmail: email }, { merge: true });
        await bumpDirectoryVersion();
      }
    }

    let emailSent = false;
    if (sendInviteEmail) {
      const emailSubject = `Welcome to Pursuit of Happiness Portal – Invitation for ${residentType}`;
      const emailHtml = `
        <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #dfe4dc; border-radius: 8px; overflow: hidden; background-color: #ffffff;">
          <div style="background-color: #183e35; padding: 24px; text-align: center; color: #ffffff;">
            <h1 style="margin: 0; font-size: 24px; letter-spacing: -0.03em;">Pursuit of Happiness</h1>
            <p style="margin: 4px 0 0; color: #f0b758; font-size: 13px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em;">Apartment Owners Association</p>
          </div>
          <div style="padding: 32px 28px; color: #17201d; line-height: 1.6;">
            <h2 style="color: #183e35; margin-top: 0;">Community Portal Access Invitation</h2>
            <p>Dear <strong>${target.name}</strong>,</p>
            <p>You have been granted access to the official <strong>Pursuit of Happiness (POH) Community Portal</strong> as a <strong>${residentType === "Tenant" ? "Resident Tenant" : "Homeowner"}</strong> (${displayRole(role)}).${flat ? ` Flat: <strong>${flat}</strong>` : ""}</p>
            <p>Whether you are a Homeowner or a Resident Tenant, our community portal is your official platform for community announcements, event celebrations, directory services, and association updates.</p>
            <ul style="color: #43534d; padding-left: 20px;">
              <li>📢 Community Notices & Maintenance Updates</li>
              <li>🎉 Event Celebrations, Schedules & SPOC Contacts</li>
              <li>📚 Resident Directory & Vehicle Allocation Records</li>
              <li>⚖️ Association Governance & Committee Contacts</li>
            </ul>
            <div style="margin: 32px 0; text-align: center;">
              <a href="https://poh-community-portal.web.app" style="background-color: #183e35; color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-weight: bold; display: inline-block; font-size: 15px; box-shadow: 0 4px 12px rgba(24,62,53,0.2);">Accept Invitation & Sign In →</a>
            </div>
            <p style="font-size: 13px; color: #68736c;">Please sign in using your registered Google email: <code style="background-color: #f2f5f1; padding: 2px 6px; border-radius: 4px; color: #183e35;">${email}</code></p>
          </div>
          <div style="background-color: #f8fcf9; padding: 16px 28px; text-align: center; border-top: 1px solid #dfe4dc; font-size: 12px; color: #68736c;">
            Pursuit of Happiness Apartment Owners Association (POH AOA)
          </div>
        </div>
      `;
      await db.collection("mail").add({
        to: [email],
        message: {
          subject: emailSubject,
          html: emailHtml
        },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        residentType: residentType,
        recipient: email
      });
      emailSent = true;
    }

    await writeAudit("Updated user access", "Access", `${email} · ${role} · ${status}${flat ? ` · Flat ${flat}` : ""}`, caller);
    return { ok: true, emailSent };
  }
  if (action === "delete") {
    const email = String(request.data?.email || "").trim().toLowerCase();
    if (!email) throw new HttpsError("invalid-argument", "Email is required.");
    if (email === caller.email) throw new HttpsError("permission-denied", "You cannot delete your own super-admin access.");
    let targetUid = "";
    try { targetUid = (await admin.auth().getUserByEmail(email)).uid; } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    if (targetUid) await db.collection("users").doc(targetUid).delete();
    await db.collection("accessInvites").doc(emailKey(email)).delete();
    await writeAudit("Revoked portal access", "User access", email, caller);
    return { ok: true, deleted: true };
  }
  throw new HttpsError("invalid-argument", "Unknown portal-access action.");
});

exports.adminConsole = onCall({ region: "asia-south1" }, async (request) => {
  ensureReadPatch();
  const action = String(request.data?.action || "");
  const caller = await callerProfile(request);
  const payload = request.data?.payload || {};

  if (action === "saveResidentProfile") {
    const flat = String(payload.flat || "").trim();
    if (!flat) throw new HttpsError("invalid-argument", "Flat number is required.");
    const residentRef = db.collection("residents").doc(flat);
    const existing = await residentRef.get();
    const before = existing.data() || {};
    
    // Permission check: Admins/Committee can edit any flat. Only a verified
    // Homeowner can edit their own flat's full profile. Tenants and other
    // residents cannot full-edit (they get vehicle-only access elsewhere).
    const isAdmin = [...ADMIN_ROLES, "committee"].includes(caller.profile.role);
    const callerEmail = String(caller.email || "").trim().toLowerCase();
    const ownerEmails = [before.ownerEmail, before.ownerPrimaryEmail, before.ownerSecondaryEmail].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
    const isOwner = ownerEmails.includes(callerEmail)
      || (String(caller.profile.residentType || "").toLowerCase() === "owner" && String(caller.profile.flat || "").trim().toUpperCase() === flat.toUpperCase());

    if (!isAdmin && !isOwner) {
      throw new HttpsError("permission-denied", "Only the verified Homeowner of this flat or an Administrator can update flat details.");
    }

    const rawOccupancy = String(payload.occupancy || "").trim();
    const validOccupancies = ["Owner occupied", "Tenant occupied", "Unoccupied (Owner Owned)", "Vacant", "Unverified"];
    const occupancy = validOccupancies.find(o => o.toLowerCase() === rawOccupancy.toLowerCase()) || "Unverified";
    
    const subStatus = String(payload.subStatus || "").trim();
    const ownerPrimaryEmail = payload.ownerPrimaryEmail !== undefined ? String(payload.ownerPrimaryEmail || "").trim().toLowerCase() : (payload.ownerEmail !== undefined ? String(payload.ownerEmail || "").trim().toLowerCase() : (before.ownerPrimaryEmail || before.ownerEmail || ""));
    const ownerSecondaryEmail = payload.ownerSecondaryEmail !== undefined ? String(payload.ownerSecondaryEmail || "").trim().toLowerCase() : (before.ownerSecondaryEmail || "");
    const tenantPrimaryEmail = payload.tenantPrimaryEmail !== undefined ? String(payload.tenantPrimaryEmail || "").trim().toLowerCase() : (payload.tenantEmail !== undefined ? String(payload.tenantEmail || "").trim().toLowerCase() : (before.tenantPrimaryEmail || before.tenantEmail || ""));
    const tenantSecondaryEmail = payload.tenantSecondaryEmail !== undefined ? String(payload.tenantSecondaryEmail || "").trim().toLowerCase() : (before.tenantSecondaryEmail || "");
    const ownerEmail = ownerPrimaryEmail;
    const tenantEmail = tenantPrimaryEmail;

    if (occupancy === "Owner occupied" && !String(payload.ownerName || "").trim()) throw new HttpsError("invalid-argument", "Enter the owner name for an owner-occupied flat.");
    if (occupancy === "Tenant occupied" && !String(payload.tenantName || "").trim()) throw new HttpsError("invalid-argument", "Enter the tenant name for a tenant-occupied flat.");
    
    const parkingAllocation = ["", "Single car parking", "Double car parking"].includes(String(payload.parkingAllocation || "")) ? String(payload.parkingAllocation || "") : (before.parkingAllocation || "");
    const parkingLevel = ["", "B1", "B2"].includes(String(payload.parkingLevel || "").toUpperCase()) ? String(payload.parkingLevel || "").toUpperCase() : (before.parkingLevel || "");
    const parkingSlots = payload.parkingSlots !== undefined ? String(payload.parkingSlots || "").trim() : (before.parkingSlots || "");
    const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles.map((item) => ({ type: ["Two wheeler", "Four wheeler"].includes(item.type) ? item.type : "Two wheeler", details: String(item.details || "").trim().toUpperCase() })).filter((item) => item.details) : (before.vehicles || []);
    // Parking is not yet allotted by the builder, so residents can record vehicle
    // details without a parking allocation. Slot data stays optional.

    const ownerPhotoUrl = String(payload.ownerPhotoUrl || "").trim();
    if (ownerPhotoUrl && !/^https:\/\//i.test(ownerPhotoUrl)) throw new HttpsError("invalid-argument", "The owner photo link is not valid.");

    const next = {
      flat,
      flatNo: flat,
      floor: before.floor || String(flat.slice(0, 1)).toUpperCase(),
      occupancy,
      occupancyStatus: occupancy,
      subStatus,
      ownerEmail,
      ownerPrimaryEmail,
      ownerSecondaryEmail,
      tenantEmail,
      tenantPrimaryEmail,
      tenantSecondaryEmail,
      familyContactName: String(payload.familyContactName || "").trim(),
      familyContactMobile: String(payload.familyContactMobile || payload.familyContactPhone || "").trim(),
      familyContactPhone: String(payload.familyContactMobile || payload.familyContactPhone || "").trim(),
      familyContactEmail: String(payload.familyContactEmail || "").trim().toLowerCase(),
      familyContactRelation: String(payload.familyContactRelation || "").trim(),
      ownerName: String(payload.ownerName || before.ownerName || before.name || "").trim(),
      phone: String(payload.ownerMobile || payload.phone || before.phone || before.ownerMobile || "").trim(),
      ownerMobile: String(payload.ownerMobile || payload.phone || before.ownerMobile || before.phone || "").trim(),
      tenantName: String(payload.tenantName || "").trim(),
      tenantMobile: String(payload.tenantMobile || "").trim(),
      isOutstation: Boolean(payload.isOutstation),
      caretakerName: String(payload.caretakerName || "").trim(),
      caretakerMobile: String(payload.caretakerMobile || "").trim(),
      caretakerRelation: String(payload.caretakerRelation || "").trim(),
      parkingAllocation,
      parkingLevel,
      parkingSlots,
      vehicles,
      updatedBy: caller.email,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (ownerPhotoUrl) { next.ownerPhotoUrl = ownerPhotoUrl; next.photoUrl = ownerPhotoUrl; }
    
    await residentRef.set(next, { merge: true });
    
    const parkingChanged = ["parkingAllocation", "parkingLevel", "parkingSlots", "vehicles"].some((key) => JSON.stringify(before[key] || "") !== JSON.stringify(next[key] || ""));
    if (parkingChanged) await db.collection("parkingAuditLogs").add({ flat, actor: caller.email, previous: { parkingAllocation: before.parkingAllocation || "", parkingLevel: before.parkingLevel || "", parkingSlots: before.parkingSlots || "", vehicles: before.vehicles || [] }, updated: { parkingAllocation, parkingLevel, parkingSlots, vehicles }, createdAt: admin.firestore.FieldValue.serverTimestamp() });

    // Auto-grant resident portal access for every owner/tenant email on this flat.
    const grantedAccess = await syncDirectoryAccess([
      { email: ownerPrimaryEmail, name: next.ownerName, residentType: "Owner", flat },
      { email: ownerSecondaryEmail, name: next.ownerName, residentType: "Owner", flat },
      { email: tenantPrimaryEmail, name: next.tenantName, residentType: "Tenant", flat },
      { email: tenantSecondaryEmail, name: next.tenantName, residentType: "Tenant", flat }
    ]);

    await bumpDirectoryVersion();
    await writeAudit("Updated resident profile", "Resident", `${flat} · ${occupancy}${subStatus ? ` (${subStatus})` : ""}${grantedAccess.length ? ` · access: ${grantedAccess.length}` : ""}`, caller);
    return { ok: true, accessGranted: grantedAccess.length };
  }

  if (action === "updateOwnVehicles") {
    // Vehicle-only self-service: any active resident tied to the flat (owner,
    // tenant, or family email, or a matching profile flat) may update the
    // vehicle list. No other flat fields can be changed through this path.
    ensureActive(caller.profile);
    const flat = String(payload.flat || "").trim();
    if (!flat) throw new HttpsError("invalid-argument", "Flat number is required.");
    const residentRef = db.collection("residents").doc(flat);
    const snap = await residentRef.get();
    if (!snap.exists) throw new HttpsError("not-found", "Flat not found.");
    const before = snap.data() || {};
    const callerEmail = String(caller.email || "").trim().toLowerCase();
    const flatEmails = [before.ownerEmail, before.ownerPrimaryEmail, before.ownerSecondaryEmail, before.tenantEmail, before.tenantPrimaryEmail, before.tenantSecondaryEmail, before.familyContactEmail].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
    const isStaff = [...ADMIN_ROLES, "committee"].includes(caller.profile.role);
    const belongsToFlat = flatEmails.includes(callerEmail) || String(caller.profile.flat || "").trim().toUpperCase() === flat.toUpperCase();
    if (!isStaff && !belongsToFlat) throw new HttpsError("permission-denied", "You can only update the vehicles for your own flat.");
    const vehicles = Array.isArray(payload.vehicles) ? payload.vehicles.map((item) => ({ type: ["Two wheeler", "Four wheeler"].includes(item.type) ? item.type : "Two wheeler", details: String(item.details || "").trim().toUpperCase() })).filter((item) => item.details) : [];
    await residentRef.set({ vehicles, updatedBy: caller.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (JSON.stringify(before.vehicles || []) !== JSON.stringify(vehicles)) {
      await db.collection("parkingAuditLogs").add({ flat, actor: caller.email, previous: { vehicles: before.vehicles || [] }, updated: { vehicles }, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }
    await bumpDirectoryVersion();
    await writeAudit("Updated own vehicle details", "Directory", `${flat} · ${vehicles.length} vehicle(s)`, caller);
    return { ok: true, vehicles };
  }

  if (action === "recordContribution") {
    ensureActive(caller.profile);
    const eventId = String(payload.eventId || "");
    const flat = String(payload.flat || "").trim();
    const floor = String(payload.floor || "").trim();
    const name = String(payload.name || "").trim();
    const paymentMode = String(payload.paymentMode || "").trim();
    const reference = String(payload.reference || "").trim();
    const amount = Number(payload.amount || 0);

    const eventSnap = await db.collection("events").doc(eventId).get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const eventData = eventSnap.data();

    if (!eventId || !flat || !floor || !name) throw new HttpsError("invalid-argument", "Select a floor and flat before saving this contribution.");
    // Amount is now free-form (variable) — the SPOC enters what was collected.
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpsError("invalid-argument", "Enter a valid contribution amount.");
    if (!["UPI", "Cash", "Bank Transfer"].includes(paymentMode)) throw new HttpsError("invalid-argument", "Choose a valid payment mode.");
    if (paymentMode !== "Cash" && !reference) throw new HttpsError("invalid-argument", "Enter the UPI or bank transaction reference.");
    if (isClosedEventData(eventData)) throw new HttpsError("failed-precondition", "This event is settled and closed; contributions can no longer be added.");

    // Access: floor SPOC (own floor) or admin/committee (any floor). Multiple
    // contributions per flat are allowed — no duplicate block.
    await assertCanManageContribution(caller, eventData, floor);

    const contributionRef = db.collection("events").doc(eventId).collection("contributions").doc();
    await contributionRef.set({ id: contributionRef.id, eventId, floor, flat, name, amount, paymentMode, reference, status: "Received", date: normalizeContributionDate(payload.date), createdAt: FIELD_VALUE.serverTimestamp(), recordedBy: caller.email });
    await writeAudit("Recorded contribution", "Contribution", `${flat} · ${String(eventData.name || eventId)} · ₹${Math.round(amount)}`, caller);
    return { id: contributionRef.id, amount };
  }
  if (action === "editContribution") {
    ensureActive(caller.profile);
    const eventId = String(payload.eventId || "");
    const contributionId = String(payload.contributionId || "");
    if (!eventId || !contributionId) throw new HttpsError("invalid-argument", "Event ID and contribution ID are required.");
    const eventSnap = await db.collection("events").doc(eventId).get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const eventData = eventSnap.data();
    if (isClosedEventData(eventData)) throw new HttpsError("failed-precondition", "This event is settled and closed; its contributions can no longer be edited.");
    const ref = db.collection("events").doc(eventId).collection("contributions").doc(contributionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Contribution not found.");
    const before = snap.data();
    await assertCanManageContribution(caller, eventData, String(before.floor || "").trim());
    const updates = { updatedBy: caller.email, updatedAt: FIELD_VALUE.serverTimestamp() };
    if (payload.amount !== undefined) {
      const amt = Number(payload.amount);
      if (!Number.isFinite(amt) || amt <= 0) throw new HttpsError("invalid-argument", "Enter a valid contribution amount.");
      updates.amount = amt;
    }
    if (payload.name !== undefined) updates.name = String(payload.name || "").trim();
    if (payload.paymentMode !== undefined) {
      if (!["UPI", "Cash", "Bank Transfer"].includes(payload.paymentMode)) throw new HttpsError("invalid-argument", "Choose a valid payment mode.");
      updates.paymentMode = payload.paymentMode;
    }
    if (payload.reference !== undefined) updates.reference = String(payload.reference || "").trim();
    if (payload.date !== undefined && String(payload.date).trim()) updates.date = normalizeContributionDate(payload.date);
    await ref.set(updates, { merge: true });
    await writeAudit("Edited contribution", "Contribution", `${before.flat} · ${String(eventData.name || eventId)} · ₹${Math.round(updates.amount ?? before.amount ?? 0)}`, caller);
    return { ok: true };
  }
  if (action === "deleteContribution") {
    ensureActive(caller.profile);
    const eventId = String(payload.eventId || "");
    const contributionId = String(payload.contributionId || "");
    if (!eventId || !contributionId) throw new HttpsError("invalid-argument", "Event ID and contribution ID are required.");
    const eventSnap = await db.collection("events").doc(eventId).get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const eventData = eventSnap.data();
    if (isClosedEventData(eventData)) throw new HttpsError("failed-precondition", "This event is settled and closed; its contributions can no longer be removed.");
    const ref = db.collection("events").doc(eventId).collection("contributions").doc(contributionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Contribution not found.");
    const before = snap.data();
    await assertCanManageContribution(caller, eventData, String(before.floor || "").trim());
    await ref.delete();
    await writeAudit("Deleted contribution", "Contribution", `${before.flat} · ${String(eventData.name || eventId)} · ₹${Math.round(before.amount || 0)}`, caller);
    return { ok: true };
  }
  if (action === "recordAdditionalContribution") {
    // Post-settlement "deficit recovery": SPOCs/admins record additional,
    // VARIABLE-amount top-ups from owners when an event's available balance is
    // negative. Kept in a separate sub-collection so the fixed-amount /
    // one-per-flat rules and the frozen settlementFigures are untouched. Repeats
    // and over-coverage (surplus) are allowed; the common fund is NOT auto-moved
    // (the treasurer reconciles it).
    ensureActive(caller.profile);
    const eventId = String(payload.eventId || "");
    const flat = String(payload.flat || "").trim();
    const floor = String(payload.floor || "").trim();
    const name = String(payload.name || "").trim();
    const paymentMode = String(payload.paymentMode || "").trim();
    const reference = String(payload.reference || "").trim();
    const note = String(payload.note || "").trim();
    const amount = Number(payload.amount || 0);

    const eventSnap = await db.collection("events").doc(eventId).get();
    if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
    const eventData = eventSnap.data();

    if (!eventId || !flat || !floor || !name) throw new HttpsError("invalid-argument", "Select a floor and flat before saving this contribution.");
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpsError("invalid-argument", "Enter a valid contribution amount.");
    if (!["UPI", "Cash", "Bank Transfer"].includes(paymentMode)) throw new HttpsError("invalid-argument", "Choose a valid payment mode.");
    if (paymentMode !== "Cash" && !reference) throw new HttpsError("invalid-argument", "Enter the UPI or bank transaction reference.");

    // Permitted only while the event ran a deficit: available balance (frozen
    // figures for a closed event, else live) is negative.
    const figures = (isClosedEventData(eventData) && eventData.settlementFigures) ? eventData.settlementFigures : await eventFigures(eventId);
    if (Number(figures.balance || 0) >= 0) throw new HttpsError("failed-precondition", "Additional contributions can be recorded only while this event's available balance is negative.");

    // Same access as normal contributions: admin (any floor) or the floor SPOC.
    const isAdmin = ADMIN_ROLES.includes(caller.profile.role);
    if (!isAdmin) {
      const spocMatch = await callerSpocAssignment(caller, eventData);
      if (!spocMatch) throw new HttpsError("permission-denied", "Only the floor SPOC or an administrator can record contributions for this event.");
      const spocFloor = String(spocMatch.floor || "").trim();
      if (spocFloor && floor && spocFloor !== floor) throw new HttpsError("permission-denied", `As the Floor ${spocFloor} SPOC you can record contributions only for your own floor.`);
    }

    const ref = db.collection("events").doc(eventId).collection("additionalContributions").doc();
    await ref.set({ id: ref.id, eventId, floor, flat, name, amount, paymentMode, reference, note, status: "Received", kind: "additional", date: new Date().toISOString(), createdAt: FIELD_VALUE.serverTimestamp(), recordedBy: caller.email });
    await writeAudit("Recorded additional contribution", "Contribution", `${flat} · ${String(eventData.name || eventId)} · ₹${Math.round(amount)} (deficit recovery)`, caller);
    return { id: ref.id, amount };
  }
  if (action === "recordExpense") {
    ensureActive(caller.profile);
    const eventId = String(payload.eventId || "");
    const category = String(payload.category || "").trim();
    const description = String(payload.description || "").trim();
    const paidBy = String(payload.paidBy || "").trim();
    const paymentMode = String(payload.paymentMode || "").trim();
    const amount = Number(payload.amount || 0);
    const reference = String(payload.reference || "").trim();
    const remarks = String(payload.remarks || "").trim();
    // Support multiple receipts per expense (e.g. an advance plus the balance
    // paid via different modes). Accepts receiptUrls[] and/or a single receiptUrl.
    const receiptUrls = [
      ...(Array.isArray(payload.receiptUrls) ? payload.receiptUrls : []),
      ...(payload.receiptUrl ? [payload.receiptUrl] : [])
    ].map((u) => String(u || "").trim()).filter(Boolean);
    if (!eventId || !category || !description || !paidBy || !amount || amount <= 0) throw new HttpsError("invalid-argument", "Complete the event, category, description, payer, and amount.");
    if (!["UPI", "Cash", "Bank Transfer"].includes(paymentMode)) throw new HttpsError("invalid-argument", "Choose a valid payment mode.");
    for (const u of receiptUrls) { if (!/^https:\/\//i.test(u)) throw new HttpsError("invalid-argument", "A receipt link is not valid."); }
    const receiptUrl = receiptUrls[0] || "";
    const event = await db.collection("events").doc(eventId).get();
    if (!event.exists) throw new HttpsError("not-found", "Event not found.");
    if (isClosedEventData(event.data())) throw new HttpsError("failed-precondition", "This event is settled and closed for new expenses.");

    // Only the floor SPOC or an administrator may submit expenses.
    const expenseIsAdmin = ADMIN_ROLES.includes(caller.profile.role);
    if (!expenseIsAdmin) {
      if (!(await callerSpocAssignment(caller, event.data()))) throw new HttpsError("permission-denied", "Only the floor SPOC or an administrator can submit expenses for this event.");
    }

    const expenseRef = db.collection("events").doc(eventId).collection("expenses").doc();
    await expenseRef.set({ id: expenseRef.id, eventId, category, description, amount, paidBy, paymentMode, reference, remarks, receiptUrl, receiptUrls, status: "Pending", date: new Date().toISOString(), createdAt: admin.firestore.FieldValue.serverTimestamp(), recordedBy: caller.email, submittedBy: caller.profile.name || caller.email });
    await writeAudit("Submitted expense", "Expense", `${expenseRef.id} · ${String(event.data().name || eventId)} · ₹${Math.round(amount)}`, caller);
    return { id: expenseRef.id };
  }
  if (action === "reviewExpense") {
    ensureRole(caller.profile, FINANCE_ROLES);
    const { eventId, expenseId, status, adminComment, category, description, amount, paidBy, paymentMode, reference, remarks } = payload;
    if (!eventId || !expenseId) throw new HttpsError("invalid-argument", "Event ID and Expense ID are required.");
    if (!["Approved", "Rejected"].includes(status)) throw new HttpsError("invalid-argument", "Status must be Approved or Rejected.");
    // A settled/closed event's finance is frozen — its expenses can no longer be
    // edited, approved, or rejected (mirrors the recordExpense closure guard).
    const eventDoc = await db.collection("events").doc(String(eventId)).get();
    if (!eventDoc.exists) throw new HttpsError("not-found", "Event not found.");
    if (isClosedEventData(eventDoc.data())) throw new HttpsError("failed-precondition", "This event is settled and closed; its expenses can no longer be edited.");
    const expenseRef = db.collection("events").doc(String(eventId)).collection("expenses").doc(String(expenseId));
    const expenseSnap = await expenseRef.get();
    if (!expenseSnap.exists) throw new HttpsError("not-found", "Expense not found.");
    const updates = {
      status,
      adminComment: String(adminComment || "").trim(),
      reviewedBy: caller.email,
      reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (category) updates.category = String(category).trim();
    if (description) updates.description = String(description).trim();
    if (amount && Number(amount) > 0) updates.amount = Number(amount);
    if (paidBy) updates.paidBy = String(paidBy).trim();
    if (paymentMode && ["UPI", "Cash", "Bank Transfer"].includes(paymentMode)) updates.paymentMode = String(paymentMode);
    if (reference !== undefined) updates.reference = String(reference || "").trim();
    if (remarks !== undefined) updates.remarks = String(remarks || "").trim();
    if (payload.receiptUrls !== undefined) {
      const urls = (Array.isArray(payload.receiptUrls) ? payload.receiptUrls : []).map((u) => String(u || "").trim()).filter(Boolean);
      for (const u of urls) { if (!/^https:\/\//i.test(u)) throw new HttpsError("invalid-argument", "A receipt link is not valid."); }
      updates.receiptUrls = urls;
      updates.receiptUrl = urls[0] || "";
    } else if (payload.receiptUrl !== undefined) {
      updates.receiptUrl = String(payload.receiptUrl || "").trim();
    }
    await expenseRef.set(updates, { merge: true });
    await writeAudit(`${status} expense`, "Expense", `${expenseId} · ${status} · ${adminComment || "No comment"}`, caller);
    return { ok: true };
  }
  if (action === "createEvent" || action === "updateEvent") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const eventId = String(payload.id || payload.eventId || "").trim();
    const name = String(payload.name || "").trim();
    if (!name) throw new HttpsError("invalid-argument", "Event name is required.");
    const status = String(payload.status || "Planning in progress");
    const contributionAmount = Math.max(1, Number(payload.contributionAmount || 500));
    const spocs = Array.isArray(payload.spocs) ? payload.spocs.filter((item) => item && item.floor && item.flat).map((item) => {
      const upiId = String(item.upiId || "").trim();
      if (upiId && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-_]{1,64}$/.test(upiId)) throw new HttpsError("invalid-argument", `Enter a valid UPI ID for the Floor ${item.floor} SPOC, e.g. name@okaxis.`);
      return { floor: String(item.floor).trim(), flat: String(item.flat).trim(), ...(upiId ? { upiId } : {}) };
    }) : [];
    if (/^active$/i.test(status)) {
      const residentFloors = new Set((await db.collection("residents").get()).docs.map((entry) => String(entry.data().floor || "Unassigned")));
      const spocFloors = new Set(spocs.map((entry) => String(entry.floor)));
      if (!residentFloors.size || [...residentFloors].some((floor) => !spocFloors.has(floor))) throw new HttpsError("failed-precondition", "Assign one SPOC for every floor before activating an event.");
    }

    const eventRef = eventId ? db.collection("events").doc(eventId) : db.collection("events").doc();
    const isNew = !eventId;
    const eventData = {
      id: eventRef.id,
      name,
      date: String(payload.date || ""),
      description: String(payload.description || ""),
      status,
      active: /^active$/i.test(status),
      contributionAmount,
      spocs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (isNew) {
      eventData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      eventData.createdBy = caller.email;
      eventData.settlementStatus = "Open";
      eventData.commonPoolCarryForward = 0;
    }

    if (/^active$/i.test(status)) {
      const existingEvents = await db.collection("events").get();
      const batch = db.batch();
      existingEvents.docs.forEach((entry) => {
        // Never demote a completed/closed/settled (past) event back to "Upcoming".
        if (entry.id === eventRef.id || isClosedEventData(entry.data())) return;
        batch.set(entry.ref, { active: false, status: "Upcoming", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      });
      batch.set(eventRef, eventData, { merge: true });
      await batch.commit();
    } else {
      await eventRef.set(eventData, { merge: true });
    }
    const auditText = isNew ? "Created event" : "Updated event";
    await writeAudit(auditText, "Event", `${name} (₹${contributionAmount}/flat)`, caller);
    return { id: eventRef.id, isNew };
  }
  if (action === "activateEvent") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const eventId = String(payload.eventId || "");
    const eventRef = db.collection("events").doc(eventId);
    const event = await eventRef.get();
    if (!event.exists) throw new HttpsError("not-found", "Event not found.");
    if (isSettledEventData(event.data())) throw new HttpsError("failed-precondition", "A settled or closed event cannot be re-activated.");
    const residentFloors = new Set((await db.collection("residents").get()).docs.map((entry) => String(entry.data().floor || "Unassigned")));
    const spocFloors = new Set((Array.isArray(event.data().spocs) ? event.data().spocs : []).filter((entry) => entry?.floor && entry?.flat).map((entry) => String(entry.floor)));
    if (!residentFloors.size || [...residentFloors].some((floor) => !spocFloors.has(floor))) throw new HttpsError("failed-precondition", "Assign one SPOC for every floor before activating this event.");
    const events = await db.collection("events").get();
    const batch = db.batch();
    events.docs.forEach((entry) => {
      // Never demote a completed/closed/settled (past) event back to "Upcoming".
      if (entry.id === eventId || isClosedEventData(entry.data())) return;
      batch.set(entry.ref, { active: false, status: "Upcoming", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    batch.set(eventRef, { active: true, status: "Active", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    await writeAudit("Activated event", "Event", String(event.data().name || eventId), caller);
    return { ok: true };
  }
  if (action === "completeEvent") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const eventId = String(payload.eventId || "");
    const eventRef = db.collection("events").doc(eventId);
    const event = await eventRef.get();
    if (!event.exists) throw new HttpsError("not-found", "Event not found.");
    await eventRef.set({ status: "Completed", active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit("Marked event as completed", "Event", String(event.data().name || eventId), caller);
    return { ok: true };
  }
  if (action === "saveCommittee") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const name = String(payload.name || "").trim();
    if (!name) throw new HttpsError("invalid-argument", "Committee member name is required.");
    const memberRef = payload.id ? db.collection("committee").doc(String(payload.id)) : db.collection("committee").doc();
    await memberRef.set({ id: memberRef.id, name, role: String(payload.role || "Committee member"), flat: String(payload.flat || ""), phone: String(payload.phone || ""), email: String(payload.email || ""), photoUrl: String(payload.photoUrl || ""), visible: payload.visible !== false, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit(payload.id ? "Updated committee member" : "Added committee member", "Committee", name, caller);
    return { id: memberRef.id };
  }
  if (action === "deleteCommittee") {
    ensureRole(caller.profile, ADMIN_ROLES);
    await db.collection("committee").doc(String(payload.id)).delete();
    await writeAudit("Removed committee member", "Committee", String(payload.name || payload.id), caller);
    return { ok: true };
  }
  if (action === "publishNotice") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const title = String(payload.title || "").trim();
    if (!title) throw new HttpsError("invalid-argument", "Notice title is required.");
    const noticeRef = db.collection("notices").doc();
    await noticeRef.set({ id: noticeRef.id, title, body: String(payload.body || ""), type: String(payload.type || "Update"), priority: String(payload.priority || "Normal"), expiresAt: String(payload.expiresAt || ""), published: true, publishedAt: admin.firestore.FieldValue.serverTimestamp(), publishedBy: caller.email });
    await writeAudit("Published notice", "Notice", `${title} · ${payload.priority || "Normal"}`, caller);
    return { id: noticeRef.id };
  }
  if (action === "approveExpense") {
    ensureRole(caller.profile, FINANCE_ROLES);
    const eventId = String(payload.eventId || ""); const expenseId = String(payload.expenseId || "");
    await db.collection("events").doc(eventId).collection("expenses").doc(expenseId).set({ status: "Approved", approvedBy: caller.email, approvedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit("Approved expense", "Expense", `${expenseId} · ${eventId}`, caller);
    return { ok: true };
  }
  if (action === "settlementSummary") {
    ensureRole(caller.profile, FINANCE_ROLES);
    const events = await db.collection("events").get();
    // M-3: for a CLOSED event whose figures were frozen at settlement, reuse the
    // stored settlementFigures instead of re-reading its contributions/expenses
    // sub-collections (which never change again). Only open events — and closed
    // events missing the snapshot — read live figures.
    const settlements = await Promise.all(events.docs.map(async (entry) => {
      const data = entry.data();
      if (isClosedEventData(data) && data.settlementFigures) {
        return { id: entry.id, ...data, ...data.settlementFigures };
      }
      return { id: entry.id, ...data, ...(await eventFigures(entry.id)) };
    }));
    const fund = await db.collection("system").doc("communityFund").get();
    return { settlements, commonPool: Number(fund.data()?.balance || 0) };
  }
  if (action === "confirmSettlement") {
    ensureRole(caller.profile, ["super_admin", "treasurer"]);
    const eventId = String(payload.eventId || ""); const figures = await eventFigures(eventId);
    if (figures.pendingExpenses) throw new HttpsError("failed-precondition", "Approve pending expenses before confirming settlement.");
    await db.collection("events").doc(eventId).set({ settlementStatus: "Treasurer confirmed", settlementConfirmedBy: caller.email, settlementConfirmedAt: admin.firestore.FieldValue.serverTimestamp(), settlementFigures: figures }, { merge: true });
    await writeAudit("Treasurer confirmed settlement", "Event", `${eventId} · ${figures.balance}`, caller);
    return figures;
  }
  if (action === "allocateCommonPool") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const eventId = String(payload.eventId || "");
    const amount = Number(payload.amount || 0);
    if (!eventId || !Number.isFinite(amount) || amount <= 0) throw new HttpsError("invalid-argument", "Enter a valid common-pool allocation amount.");
    const eventRef = db.collection("events").doc(eventId);
    const fundRef = db.collection("system").doc("communityFund");
    let remainingPool = 0;
    await db.runTransaction(async (transaction) => {
      const [event, fund] = await Promise.all([transaction.get(eventRef), transaction.get(fundRef)]);
      if (!event.exists) throw new HttpsError("not-found", "Event not found.");
      if (/closed|settled/i.test(String(event.data().status || ""))) throw new HttpsError("failed-precondition", "A closed event cannot receive common-pool funds.");
      const currentPool = Number(fund.data()?.balance || 0);
      if (amount > currentPool) throw new HttpsError("failed-precondition", `Only ₹${Math.round(currentPool).toLocaleString("en-IN")} is currently available in the common pool.`);
      remainingPool = currentPool - amount;
      transaction.set(fundRef, { balance: remainingPool, updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastAllocationEventId: eventId }, { merge: true });
      transaction.set(eventRef, { commonPoolAllocation: Number(event.data().commonPoolAllocation || 0) + amount, commonPoolAllocatedAt: admin.firestore.FieldValue.serverTimestamp(), commonPoolAllocatedBy: caller.email }, { merge: true });
    });
    await writeAudit("Allocated common-pool funds", "Event", `${eventId} · ₹${amount}`, caller);
    return { amount, commonPoolBalance: remainingPool };
  }
  if (action === "closeSettlement") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const eventId = String(payload.eventId || ""); const eventRef = db.collection("events").doc(eventId); const event = await eventRef.get();
    if (!event.exists) throw new HttpsError("not-found", "Event not found.");
    if (event.data().settlementStatus !== "Treasurer confirmed" && caller.profile.role !== "super_admin") throw new HttpsError("failed-precondition", "Treasurer confirmation is required before closure.");
    const figures = await eventFigures(eventId); const fundRef = db.collection("system").doc("communityFund");
    // Read the fund balance INSIDE the transaction (mirrors allocateCommonPool) so a
    // concurrent allocation/closure can't be clobbered by a stale read-modify-write.
    let nextPool = 0;
    await db.runTransaction(async (transaction) => { const fund = await transaction.get(fundRef); nextPool = Number(fund.data()?.balance || 0) + figures.balance; transaction.set(eventRef, { status: "Closed", active: false, settlementStatus: "Closed", closedBy: caller.email, closedAt: admin.firestore.FieldValue.serverTimestamp(), settlementFigures: figures, commonPoolCarryForward: figures.balance }, { merge: true }); transaction.set(fundRef, { balance: nextPool, updatedAt: admin.firestore.FieldValue.serverTimestamp(), lastEventId: eventId }, { merge: true }); });
    await writeAudit("Closed event settlement", "Event", `${eventId} · carry forward ${figures.balance}`, caller);
    return { ...figures, commonPoolBalance: nextPool };
  }
  if (action === "bookAmenity") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const amenity = String(payload.amenity || "").trim();
    const date = String(payload.date || "").trim();
    const slot = String(payload.slot || "Full Day").trim();
    const flat = String(payload.flat || "").trim();
    const floor = String(payload.floor || "").trim();
    const name = String(payload.name || caller.profile.name || "").trim();
    const phone = String(payload.phone || "").trim();
    const notes = String(payload.notes || "").trim();
    const AMENITY_FEES = { "Party Hall": 2500, "Movie Theater": 2500, "Sauna": 1500 };
    const fee = AMENITY_FEES[amenity] || Number(payload.fee) || 2500;
    if (!amenity || !date || !flat) throw new HttpsError("invalid-argument", "Amenity, date, and flat number are required.");
    const ref = db.collection("amenityBookings").doc();
    const booking = { id: ref.id, amenity, date, slot, flat, floor, name, phone, notes, fee, status: "Requested", requestedBy: caller.email, createdAt: admin.firestore.FieldValue.serverTimestamp() };
    await ref.set(booking);
    await writeAudit("Requested amenity booking", "Amenity", `${amenity} · ${date} · Flat ${flat} · ₹${fee}`, caller);
    return { id: ref.id };
  }
  if (action === "updateAmenityBooking") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const id = String(payload.id || "").trim();
    const status = String(payload.status || "Approved").trim();
    if (!id) throw new HttpsError("invalid-argument", "Booking ID is required.");
    await db.collection("amenityBookings").doc(id).set({ status, updatedBy: caller.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit(`${status} amenity booking`, "Amenity", `${id} · ${status}`, caller);
    return { ok: true };
  }
  if (action === "requestMoveService") {
    ensureActive(caller.profile);
    const moveType = String(payload.moveType || "Move-In").trim();
    const flat = String(payload.flat || "").trim();
    const block = String(payload.block || "Block A").trim();
    const residentName = String(payload.residentName || "").trim();
    const occupancyType = String(payload.occupancyType || "Owner").trim();
    const moveDate = String(payload.moveDate || "").trim();
    const leasePeriod = String(payload.leasePeriod || "").trim();
    const primaryMobile = String(payload.primaryMobile || "").trim();
    const primaryEmail = String(payload.primaryEmail || "").trim();
    const emergencyName = String(payload.emergencyName || "").trim();
    const emergencyRelation = String(payload.emergencyRelation || "").trim();
    const emergencyMobile = String(payload.emergencyMobile || "").trim();
    const fourWheelerNo = String(payload.fourWheelerNo || "").trim();
    const twoWheelerNo = String(payload.twoWheelerNo || "").trim();
    const expectedTime = String(payload.expectedTime || "").trim();
    const shiftingAgencyName = String(payload.shiftingAgencyName || "").trim();
    const shiftingAgencyContact = String(payload.shiftingAgencyContact || "").trim();
    const familyMembers = Array.isArray(payload.familyMembers) ? payload.familyMembers : [];
    const domesticStaff = Array.isArray(payload.domesticStaff) ? payload.domesticStaff : [];
    const documentsSubmitted = Array.isArray(payload.documentsSubmitted) ? payload.documentsSubmitted : [];
    const undertakingAccepted = payload.undertakingAccepted === true;
    const declarationAccepted = payload.declarationAccepted === true;

    if (!flat || !moveDate || !residentName) throw new HttpsError("invalid-argument", "Select flat, resident name, and move date.");
    if (!undertakingAccepted || !declarationAccepted) throw new HttpsError("invalid-argument", "You must accept the Community Guidelines & Undertaking to submit.");

    const ref = db.collection("moveRequests").doc();
    const requestData = {
      id: ref.id,
      moveType,
      flat,
      block,
      residentName,
      occupancyType,
      moveDate,
      leasePeriod,
      primaryMobile,
      primaryEmail,
      emergencyName,
      emergencyRelation,
      emergencyMobile,
      fourWheelerNo,
      twoWheelerNo,
      expectedTime,
      shiftingAgencyName,
      shiftingAgencyContact,
      familyMembers,
      domesticStaff,
      documentsSubmitted,
      undertakingAccepted,
      declarationAccepted,
      status: "Requested",
      nocIssued: false,
      requestedBy: caller.email,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await ref.set(requestData);
    await writeAudit(`Submitted ${moveType} Registration & Undertaking`, "Move Management", `Flat ${flat} · ${residentName} · ${moveDate}`, caller);
    return { id: ref.id };
  }
  if (action === "updateMoveService") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const id = String(payload.id || "").trim();
    const status = String(payload.status || "Approved").trim();
    const nocIssued = payload.nocIssued === true;
    if (!id) throw new HttpsError("invalid-argument", "Move request ID is required.");
    await db.collection("moveRequests").doc(id).set({ status, nocIssued, updatedBy: caller.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit(`Updated ${status} NOC request`, "Move Management", `${id} · NOC: ${nocIssued ? "Issued" : "Pending"}`, caller);
    return { ok: true };
  }
  if (action === "saveEmergencyContact") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const name = String(payload.name || "").trim();
    const role = String(payload.role || "Emergency Contact").trim();
    const phone = String(payload.phone || "").trim();
    const photoUrl = String(payload.photoUrl || "").trim();
    const availability = String(payload.availability || "24/7 Available").trim();
    const contactType = ["emergency", "daily_helper"].includes(String(payload.contactType || "").trim()) ? String(payload.contactType).trim() : "emergency";
    if (!name) throw new HttpsError("invalid-argument", "Contact name is required.");
    if (contactType === "emergency" && !phone) throw new HttpsError("invalid-argument", "A mobile number is required for emergency contacts.");
    const ref = payload.id ? db.collection("emergencyContacts").doc(String(payload.id)) : db.collection("emergencyContacts").doc();
    await ref.set({ id: ref.id, name, role, phone, photoUrl, availability, contactType, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit(payload.id ? "Updated emergency contact" : "Added emergency contact", "Contacts", `${name} · ${role} · ${contactType}`, caller);
    return { id: ref.id };
  }
  if (action === "deleteEmergencyContact") {
    ensureRole(caller.profile, ADMIN_ROLES);
    await db.collection("emergencyContacts").doc(String(payload.id)).delete();
    await writeAudit("Removed emergency contact", "Contacts", String(payload.name || payload.id), caller);
    return { ok: true };
  }
  if (action === "saveGalleryPhoto") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const title = String(payload.title || "").trim();
    const category = String(payload.category || "Events").trim();
    const photoUrl = String(payload.photoUrl || "").trim();
    const caption = String(payload.caption || "").trim();
    if (!title || !photoUrl) throw new HttpsError("invalid-argument", "Photo title and image URL are required.");
    const ref = payload.id ? db.collection("galleryPhotos").doc(String(payload.id)) : db.collection("galleryPhotos").doc();
    await ref.set({ id: ref.id, title, category, photoUrl, caption, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit(payload.id ? "Updated gallery photo" : "Uploaded gallery photo", "Gallery", `${title} · ${category}`, caller);
    return { id: ref.id };
  }
  if (action === "deleteGalleryPhoto") {
    ensureRole(caller.profile, ADMIN_ROLES);
    await db.collection("galleryPhotos").doc(String(payload.id)).delete();
    await writeAudit("Deleted gallery photo", "Gallery", String(payload.title || payload.id), caller);
    return { ok: true };
  }
  if (action === "getExpansionData") {
    ensureActive(caller.profile);
    const [bookings, moves, contacts, photos] = await Promise.all([
      db.collection("amenityBookings").get(),
      db.collection("moveRequests").get(),
      db.collection("emergencyContacts").get(),
      db.collection("galleryPhotos").get()
    ]);
    return {
      amenityBookings: bookings.docs.map((d) => ({ id: d.id, ...d.data() })),
      moveRequests: moves.docs.map((d) => ({ id: d.id, ...d.data() })),
      emergencyContacts: contacts.docs.map((d) => ({ id: d.id, ...d.data() })),
      galleryPhotos: photos.docs.map((d) => ({ id: d.id, ...d.data() }))
    };
  }
  if (action === "verifyDataSync") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const [eventsSnap, noticesSnap, residentsSnap, committeeSnap, usersSnap, invitesSnap, migrationSnap] = await Promise.all([
      db.collection("events").get(),
      db.collection("notices").get(),
      db.collection("residents").get(),
      db.collection("committee").get(),
      db.collection("users").get(),
      db.collection("accessInvites").get(),
      db.collection("system").doc("migration").get()
    ]);
    let totalExpenses = 0;
    let totalContributions = 0;
    const duplicatesReport = [];

    for (const eventDoc of eventsSnap.docs) {
      const eventData = eventDoc.data();
      const [exp, con] = await Promise.all([
        db.collection("events").doc(eventDoc.id).collection("expenses").get(),
        db.collection("events").doc(eventDoc.id).collection("contributions").get()
      ]);
      totalExpenses += exp.size;
      totalContributions += con.size;

      const flatMap = new Map();
      con.docs.forEach((doc) => {
        const d = doc.data();
        const flat = String(d.flat || d.flatNo || "").trim().toUpperCase();
        if (!flat) return;
        if (!flatMap.has(flat)) flatMap.set(flat, []);
        flatMap.get(flat).push({
          id: doc.id,
          flat,
          amount: d.amount || 0,
          ownerName: d.ownerName || d.name || d.residentName || "N/A",
          paymentMode: d.paymentMode || d.mode || "N/A",
          reference: d.reference || d.ref || d.transactionRef || "N/A",
          date: d.date || d.createdAt || "N/A"
        });
      });

      const eventDuplicates = [];
      flatMap.forEach((records, flat) => {
        if (records.length > 1) {
          eventDuplicates.push({ flat, count: records.length, records });
        }
      });

      if (eventDuplicates.length > 0) {
        duplicatesReport.push({
          eventId: eventDoc.id,
          eventName: eventData.name || eventData.title || eventDoc.id,
          active: Boolean(eventData.active),
          duplicateCount: eventDuplicates.length,
          flats: eventDuplicates
        });
      }
    }

    const residents = residentsSnap.docs.map(d => d.data());
    const occupancyCounts = {
      owner_occupied: residents.filter(r => String(r.occupancy || r.occupancyStatus || "").toLowerCase().includes("owner")).length,
      tenant_occupied: residents.filter(r => String(r.occupancy || r.occupancyStatus || "").toLowerCase().includes("tenant")).length,
      vacant: residents.filter(r => String(r.occupancy || r.occupancyStatus || "").toLowerCase().includes("vacant")).length,
      unverified: residents.filter(r => String(r.occupancy || r.occupancyStatus || "").toLowerCase().includes("unverified")).length
    };
    return {
      synced: true,
      lastMigration: migrationSnap.exists ? migrationSnap.data() : null,
      counts: {
        events: eventsSnap.size,
        notices: noticesSnap.size,
        residents: residentsSnap.size,
        committee: committeeSnap.size,
        expenses: totalExpenses,
        contributions: totalContributions,
        users: usersSnap.size + invitesSnap.size
      },
      duplicatesReport,
      occupancyBreakdown: occupancyCounts,
      eventList: eventsSnap.docs.map(d => ({ id: d.id, name: d.data().name || d.data().title, date: d.data().date || d.data().startDate, active: d.data().active }))
    };
  }
  if (action === "importSpreadsheet") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const result = await processSnapshotData(payload || {});
    await writeAudit("Imported spreadsheet data", "System", `Processed ${result.writes} records`, caller);
    return result;
  }
  if (action === "backfillDirectoryAccess") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const residents = await db.collection("residents").get();
    const entries = [];
    residents.docs.forEach((doc) => {
      const r = doc.data();
      const flat = r.flat || doc.id;
      const ownerName = r.ownerName || r.name || "";
      const tenantName = r.tenantName || "";
      [r.ownerPrimaryEmail, r.ownerEmail, r.ownerSecondaryEmail].forEach((email) => { if (email) entries.push({ email, name: ownerName, residentType: "Owner", flat }); });
      [r.tenantPrimaryEmail, r.tenantEmail, r.tenantSecondaryEmail].forEach((email) => { if (email) entries.push({ email, name: tenantName, residentType: "Tenant", flat }); });
    });
    const granted = await syncDirectoryAccess(entries);
    await writeAudit("Backfilled directory access", "Access", `${granted.length} resident invites from directory (${residents.size} flats scanned)`, caller);
    return { ok: true, granted: granted.length, scanned: residents.size, emails: granted };
  }
  if (action === "normalizeVehicleNumbers") {
    ensureRole(caller.profile, ADMIN_ROLES);
    const residents = await db.collection("residents").get();
    let updatedFlats = 0;
    let updatedVehicles = 0;
    for (const doc of residents.docs) {
      const vehicles = doc.data().vehicles;
      if (!Array.isArray(vehicles) || !vehicles.length) continue;
      let changed = false;
      const normalized = vehicles.map((v) => {
        const details = String(v.details || "").trim();
        const upper = details.toUpperCase();
        if (upper !== details) { changed = true; updatedVehicles += 1; }
        return { ...v, details: upper };
      });
      if (changed) {
        await doc.ref.set({ vehicles: normalized, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        updatedFlats += 1;
      }
    }
    if (updatedFlats) await bumpDirectoryVersion();
    await writeAudit("Normalized vehicle numbers to uppercase", "Directory", `${updatedVehicles} vehicles across ${updatedFlats} flats`, caller);
    return { ok: true, updatedFlats, updatedVehicles, scanned: residents.size };
  }
  throw new HttpsError("invalid-argument", "Unknown admin-console action.");
});

// Community Feedback & Ideas board: residents submit feature requests, bugs, and
// improvements; everyone can support (upvote) and comment; moderators triage.
// Anonymity is optional per post/comment — the author is hidden from the public
// view but always stored server-side and visible to moderators for accountability.
exports.feedbackHub = onCall({ region: "asia-south1" }, async (request) => {
  ensureReadPatch();
  const action = String(request.data?.action || "list");
  const caller = await callerProfile(request);
  ensureActive(caller.profile);
  const isModerator = MODERATOR_ROLES.includes(caller.profile.role);
  const payload = request.data?.payload || {};
  const callerEmailLower = String(caller.email || "").trim().toLowerCase();

  if (action === "list") {
    const snap = await db.collection("feedbackItems").orderBy("createdAt", "desc").get();
    const items = await Promise.all(snap.docs.map(async (doc) => {
      const d = doc.data();
      const supporter = await doc.ref.collection("supporters").doc(caller.uid).get();
      const isMine = String(d.createdByEmail || "").trim().toLowerCase() === callerEmailLower;
      const reveal = isModerator || isMine || !d.anonymous;
      return {
        id: doc.id,
        type: d.type || "improvement",
        title: d.title || "",
        description: d.description || "",
        area: d.area || "General",
        status: d.status || "Open",
        adminResponse: d.adminResponse || "",
        supportCount: Number(d.supportCount || 0),
        commentCount: Number(d.commentCount || 0),
        anonymous: Boolean(d.anonymous),
        authorName: reveal ? (d.createdByName || "Resident") : "Anonymous",
        authorFlat: reveal ? (d.createdByFlat || "") : "",
        createdAt: d.createdAt || null,
        updatedAt: d.updatedAt || null,
        hasSupported: supporter.exists,
        isMine,
        canRemove: isModerator || isMine
      };
    }));
    return { items, canModerate: isModerator };
  }

  if (action === "experience") {
    const snap = await db.collection("experienceRatings").get();
    const ratings = snap.docs.map((d) => Number(d.data().rating || 0)).filter((r) => r >= 1 && r <= 5);
    const count = ratings.length;
    const average = count ? ratings.reduce((a, b) => a + b, 0) / count : 0;
    const distribution = [1, 2, 3, 4, 5].reduce((acc, star) => { acc[star] = ratings.filter((r) => r === star).length; return acc; }, {});
    const mine = await db.collection("experienceRatings").doc(caller.uid).get();
    return { average, count, distribution, myRating: mine.exists ? Number(mine.data().rating || 0) : 0, myComment: mine.exists ? (mine.data().comment || "") : "" };
  }

  if (action === "submit") {
    const type = String(payload.type || "").toLowerCase();
    const title = String(payload.title || "").trim();
    const description = String(payload.description || "").trim();
    const areaRaw = String(payload.area || "General").trim();
    const anonymous = payload.anonymous === true || payload.anonymous === "true";
    if (!FEEDBACK_TYPES.includes(type)) throw new HttpsError("invalid-argument", "Choose a valid feedback type.");
    if (title.length < 4 || title.length > 120) throw new HttpsError("invalid-argument", "The title must be between 4 and 120 characters.");
    if (description.length < 5 || description.length > 2000) throw new HttpsError("invalid-argument", "The description must be between 5 and 2000 characters.");
    const area = FEEDBACK_AREAS.includes(areaRaw) ? areaRaw : "General";
    const callerFlat = await resolveCallerFlat(caller);
    const ref = db.collection("feedbackItems").doc();
    await ref.set({
      id: ref.id, type, title, description, area,
      status: "Open", adminResponse: "",
      supportCount: 0, commentCount: 0, anonymous,
      createdByEmail: caller.email, createdByName: caller.profile.name || caller.email, createdByFlat: callerFlat,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await writeAudit("Submitted feedback", "Feedback", `${type} · ${title}`, caller);
    return { id: ref.id };
  }

  if (action === "toggleSupport") {
    const itemRef = db.collection("feedbackItems").doc(String(payload.itemId || ""));
    const supporterRef = itemRef.collection("supporters").doc(caller.uid);
    let supported = false;
    let supportCount = 0;
    await db.runTransaction(async (tx) => {
      const [item, supporter] = await Promise.all([tx.get(itemRef), tx.get(supporterRef)]);
      if (!item.exists) throw new HttpsError("not-found", "This feedback item no longer exists.");
      const current = Number(item.data().supportCount || 0);
      if (supporter.exists) {
        tx.delete(supporterRef);
        supportCount = Math.max(0, current - 1);
        supported = false;
      } else {
        tx.set(supporterRef, { uid: caller.uid, email: caller.email, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        supportCount = current + 1;
        supported = true;
      }
      tx.update(itemRef, { supportCount });
    });
    return { ok: true, supported, supportCount };
  }

  if (action === "rateExperience") {
    const rating = Number(payload.rating || 0);
    const comment = String(payload.comment || "").trim().slice(0, 500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpsError("invalid-argument", "Choose a rating between 1 and 5 stars.");
    const callerFlat = await resolveCallerFlat(caller);
    await db.collection("experienceRatings").doc(caller.uid).set({
      uid: caller.uid, email: caller.email, name: caller.profile.name || caller.email, flat: callerFlat,
      rating, comment, updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { ok: true, rating };
  }

  if (action === "comments") {
    const snap = await db.collection("feedbackItems").doc(String(payload.itemId || "")).collection("comments").orderBy("createdAt", "asc").get();
    const comments = snap.docs.map((doc) => {
      const d = doc.data();
      const isMine = String(d.authorEmail || "").trim().toLowerCase() === callerEmailLower;
      const reveal = isModerator || isMine || !d.anonymous;
      return {
        id: doc.id,
        body: d.body || "",
        authorName: reveal ? (d.authorName || "Resident") : "Anonymous",
        authorFlat: reveal ? (d.authorFlat || "") : "",
        createdAt: d.createdAt || null,
        canRemove: isModerator || isMine
      };
    });
    return { comments };
  }

  if (action === "comment") {
    const itemRef = db.collection("feedbackItems").doc(String(payload.itemId || ""));
    const body = String(payload.body || "").trim();
    const anonymous = payload.anonymous === true || payload.anonymous === "true";
    if (body.length < 1 || body.length > 1000) throw new HttpsError("invalid-argument", "A comment must be between 1 and 1000 characters.");
    const item = await itemRef.get();
    if (!item.exists) throw new HttpsError("not-found", "This feedback item no longer exists.");
    const callerFlat = await resolveCallerFlat(caller);
    const commentRef = itemRef.collection("comments").doc();
    await commentRef.set({
      id: commentRef.id, body, anonymous,
      authorEmail: caller.email, authorName: caller.profile.name || caller.email, authorFlat: callerFlat,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await itemRef.update({ commentCount: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { id: commentRef.id };
  }

  if (action === "removeComment") {
    const itemRef = db.collection("feedbackItems").doc(String(payload.itemId || ""));
    const commentRef = itemRef.collection("comments").doc(String(payload.commentId || ""));
    const comment = await commentRef.get();
    if (!comment.exists) throw new HttpsError("not-found", "This comment no longer exists.");
    const isMine = String(comment.data().authorEmail || "").trim().toLowerCase() === callerEmailLower;
    if (!isModerator && !isMine) throw new HttpsError("permission-denied", "You can only remove your own comment.");
    await commentRef.delete();
    await itemRef.update({ commentCount: admin.firestore.FieldValue.increment(-1) });
    return { ok: true };
  }

  if (action === "moderate") {
    if (!isModerator) throw new HttpsError("permission-denied", "Only moderators can update feedback status.");
    const itemRef = db.collection("feedbackItems").doc(String(payload.itemId || ""));
    const status = String(payload.status || "").trim();
    const adminResponse = String(payload.adminResponse || "").trim().slice(0, 1000);
    if (!FEEDBACK_STATUSES.includes(status)) throw new HttpsError("invalid-argument", "Choose a valid status.");
    const item = await itemRef.get();
    if (!item.exists) throw new HttpsError("not-found", "This feedback item no longer exists.");
    await itemRef.set({ status, adminResponse, moderatedBy: caller.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit("Updated feedback status", "Feedback", `${item.data().title || itemRef.id} · ${status}`, caller);
    return { ok: true };
  }

  if (action === "remove") {
    const itemRef = db.collection("feedbackItems").doc(String(payload.itemId || ""));
    const item = await itemRef.get();
    if (!item.exists) throw new HttpsError("not-found", "This feedback item no longer exists.");
    const isMine = String(item.data().createdByEmail || "").trim().toLowerCase() === callerEmailLower;
    if (!isModerator && !isMine) throw new HttpsError("permission-denied", "You can only remove your own feedback.");
    const [supporters, comments] = await Promise.all([
      itemRef.collection("supporters").get(),
      itemRef.collection("comments").get()
    ]);
    const batch = db.batch();
    supporters.docs.forEach((d) => batch.delete(d.ref));
    comments.docs.forEach((d) => batch.delete(d.ref));
    batch.delete(itemRef);
    await batch.commit();
    await writeAudit("Removed feedback", "Feedback", String(item.data().title || itemRef.id), caller);
    return { ok: true };
  }

  if (action === "analytics") {
    if (!isModerator) throw new HttpsError("permission-denied", "Only moderators can view feedback analytics.");
    const [items, ratingsSnap] = await Promise.all([
      db.collection("feedbackItems").get(),
      db.collection("experienceRatings").get()
    ]);
    const byStatus = {}; const byType = {};
    items.docs.forEach((doc) => {
      const d = doc.data();
      const s = d.status || "Open"; const t = d.type || "improvement";
      byStatus[s] = (byStatus[s] || 0) + 1;
      byType[t] = (byType[t] || 0) + 1;
    });
    const ratings = ratingsSnap.docs.map((d) => Number(d.data().rating || 0)).filter((r) => r >= 1 && r <= 5);
    const count = ratings.length;
    const average = count ? ratings.reduce((a, b) => a + b, 0) / count : 0;
    return { totalItems: items.size, byStatus, byType, experience: { average, count } };
  }

  throw new HttpsError("invalid-argument", "Unknown feedback-hub action.");
});

// ---------- Event Summary Report PDF (summary + merged receipts) ----------
const A4 = [595.28, 841.89];
const RS = (n) => "Rs. " + Number(n || 0).toLocaleString("en-IN");
// Standard Helvetica is WinAnsi-encoded, so strip anything outside printable ASCII.
const ascii = (s) => String(s == null ? "" : s).replace(/[^\x20-\x7E]/g, " ").replace(/\s+/g, " ").trim();

function fitText(str, maxW, size, font) {
  let s = ascii(str);
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  while (s.length && font.widthOfTextAtSize(s + "…".replace(/[^\x20-\x7E]/g, "."), size) > maxW) s = s.slice(0, -1);
  return s.trim() + "...";
}

async function fetchReceiptBytes(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) return null; // e.g. Google Drive viewer pages
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  }
}

function detectReceiptKind(buf) {
  if (!buf || buf.length < 4) return "other";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return "pdf"; // %PDF
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return "other";
}

function addReceiptImagePage(pdf, font, img, caption) {
  const page = pdf.addPage(A4);
  const margin = 36;
  page.drawText(fitText(caption, A4[0] - margin * 2, 10, font), { x: margin, y: A4[1] - margin, size: 10, font, color: rgb(0.09, 0.13, 0.11) });
  const top = A4[1] - margin - 20;
  const maxW = A4[0] - margin * 2;
  const maxH = top - margin;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (A4[0] - w) / 2, y: margin + (maxH - h) / 2, width: w, height: h });
}

function addReceiptLinkPage(pdf, font, bold, caption, url) {
  const page = pdf.addPage(A4);
  const margin = 40;
  page.drawText("Receipt attachment", { x: margin, y: A4[1] - margin, size: 14, font: bold, color: rgb(0.094, 0.243, 0.208) });
  page.drawText(fitText(caption, A4[0] - margin * 2, 11, font), { x: margin, y: A4[1] - margin - 22, size: 11, font });
  page.drawText("This receipt could not be embedded. Open it directly at:", { x: margin, y: A4[1] - margin - 46, size: 10, font, color: rgb(0.4, 0.45, 0.42) });
  const u = ascii(url);
  for (let i = 0, line = 0; i < u.length; i += 95, line++) {
    page.drawText(u.slice(i, i + 95), { x: margin, y: A4[1] - margin - 64 - line * 12, size: 8, font, color: rgb(0.2, 0.32, 0.6) });
  }
}

exports.generateEventReport = onCall({ region: "asia-south1", memory: "1GiB", timeoutSeconds: 120 }, async (request) => {
  const caller = await callerProfile(request);
  ensureRole(caller.profile, FINANCE_ROLES);
  const eventId = String(request.data?.eventId || "");
  const eventRef = db.collection("events").doc(eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) throw new HttpsError("not-found", "Event not found.");
  const event = eventSnap.data();

  const [contribSnap, expSnap, residentsSnap] = await Promise.all([
    eventRef.collection("contributions").get(),
    eventRef.collection("expenses").get(),
    db.collection("residents").get()
  ]);
  const contributions = contribSnap.docs.map((d) => d.data());
  const approved = expSnap.docs.map((d) => d.data()).filter((e) => String(e.status || "Approved").toLowerCase() === "approved");
  const collected = contributions.reduce((s, c) => s + Number(c.amount || 0), 0);
  const spent = approved.reduce((s, e) => s + Number(e.amount || 0), 0);
  const poolAllocated = Number(event.commonPoolAllocation || 0);
  const balance = collected + poolAllocated - spent;
  const totalFlats = residentsSnap.size || 0;

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.094, 0.243, 0.208);
  const gray = rgb(0.4, 0.45, 0.42);
  const ink = rgb(0.09, 0.13, 0.11);
  const margin = 40;

  let page = pdf.addPage(A4);
  let y = A4[1] - 70;
  const ensure = (space) => { if (y - space < margin) { page = pdf.addPage(A4); y = A4[1] - margin; } };
  const rightX = (str, size, f) => A4[0] - margin - f.widthOfTextAtSize(ascii(str), size);

  page.drawRectangle({ x: 0, y: A4[1] - 70, width: A4[0], height: 70, color: green });
  page.drawText("Pursuit of Happiness Community", { x: margin, y: A4[1] - 34, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Post-Event Summary & Transparency Report", { x: margin, y: A4[1] - 52, size: 10, font, color: rgb(0.85, 0.9, 0.87) });
  y = A4[1] - 96;
  page.drawText(fitText(event.name || "Event", A4[0] - margin * 2, 18, bold), { x: margin, y, size: 18, font: bold, color: green });
  y -= 20;
  if (event.date) { page.drawText("Date: " + ascii(event.date), { x: margin, y, size: 10, font, color: gray }); y -= 18; }
  y -= 8;

  const kpiRow = (label, value) => {
    ensure(20);
    page.drawText(ascii(label), { x: margin, y, size: 11, font, color: ink });
    page.drawText(ascii(value), { x: rightX(value, 11, bold), y, size: 11, font: bold, color: green });
    y -= 18;
  };
  kpiRow("Total Collected", RS(collected));
  kpiRow("Total Approved Expenses", RS(spent));
  if (poolAllocated) kpiRow("Common Pool Allocated", RS(poolAllocated));
  kpiRow(balance >= 0 ? "Net Surplus" : "Net Deficit", RS(Math.abs(balance)));
  kpiRow("Contributions Received", `${contributions.length} of ${totalFlats} flats`);
  kpiRow("Approved Expense Items", String(approved.length));

  y -= 12;
  ensure(24);
  page.drawText("Itemized Approved Expenses", { x: margin, y, size: 13, font: bold, color: green });
  y -= 18;
  const xNum = margin, xDesc = 68, xCat = 320, xPaid = 410;
  const drawHeaderRow = () => {
    ensure(20);
    page.drawText("#", { x: xNum, y, size: 9, font: bold, color: gray });
    page.drawText("DESCRIPTION", { x: xDesc, y, size: 9, font: bold, color: gray });
    page.drawText("CATEGORY", { x: xCat, y, size: 9, font: bold, color: gray });
    page.drawText("PAID BY", { x: xPaid, y, size: 9, font: bold, color: gray });
    page.drawText("AMOUNT", { x: rightX("AMOUNT", 9, bold), y, size: 9, font: bold, color: gray });
    y -= 6;
    page.drawLine({ start: { x: margin, y }, end: { x: A4[0] - margin, y }, thickness: 0.5, color: rgb(0.8, 0.85, 0.82) });
    y -= 13;
  };
  drawHeaderRow();
  approved.forEach((exp, idx) => {
    if (y - 14 < margin) { page = pdf.addPage(A4); y = A4[1] - margin; drawHeaderRow(); }
    page.drawText(String(idx + 1), { x: xNum, y, size: 9, font, color: ink });
    page.drawText(fitText(exp.description || "Expense", xCat - xDesc - 8, 9, font), { x: xDesc, y, size: 9, font, color: ink });
    page.drawText(fitText(exp.category || "General", xPaid - xCat - 8, 9, font), { x: xCat, y, size: 9, font, color: ink });
    page.drawText(fitText(exp.paidBy || "-", (A4[0] - margin - 70) - xPaid, 9, font), { x: xPaid, y, size: 9, font, color: ink });
    page.drawText(RS(exp.amount), { x: rightX(RS(exp.amount), 9, bold), y, size: 9, font: bold, color: green });
    y -= 14;
  });
  ensure(24);
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: A4[0] - margin, y }, thickness: 0.5, color: rgb(0.8, 0.85, 0.82) });
  y -= 14;
  page.drawText("TOTAL", { x: xPaid, y, size: 10, font: bold, color: ink });
  page.drawText(RS(spent), { x: rightX(RS(spent), 10, bold), y, size: 10, font: bold, color: green });

  // Merge receipts from approved expenses.
  const MAX_RECEIPTS = 60;
  const MAX_BYTES = 25 * 1024 * 1024;
  let merged = 0, bytesUsed = 0, skipped = 0;
  const receiptDivider = () => {
    const p = pdf.addPage(A4);
    p.drawRectangle({ x: 0, y: A4[1] / 2 - 20, width: A4[0], height: 40, color: green });
    p.drawText("ATTACHED RECEIPTS", { x: margin, y: A4[1] / 2 - 6, size: 16, font: bold, color: rgb(1, 1, 1) });
  };
  let dividerAdded = false;
  for (const exp of approved) {
    const urls = Array.isArray(exp.receiptUrls) && exp.receiptUrls.length ? exp.receiptUrls : (exp.receiptUrl ? [exp.receiptUrl] : []);
    for (const url of urls) {
      if (merged >= MAX_RECEIPTS || bytesUsed >= MAX_BYTES) { skipped++; continue; }
      if (!dividerAdded) { receiptDivider(); dividerAdded = true; }
      const caption = `${ascii(exp.description || "Expense")}  |  ${RS(exp.amount)}  |  ${ascii(exp.category || "General")}`;
      const buf = await fetchReceiptBytes(String(url));
      if (!buf) { addReceiptLinkPage(pdf, font, bold, caption, url); skipped++; continue; }
      bytesUsed += buf.length;
      const kind = detectReceiptKind(buf);
      try {
        if (kind === "pdf") {
          const src = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages = await pdf.copyPages(src, src.getPageIndices());
          pages.forEach((p) => pdf.addPage(p));
        } else if (kind === "jpg") {
          addReceiptImagePage(pdf, font, await pdf.embedJpg(buf), caption);
        } else if (kind === "png") {
          addReceiptImagePage(pdf, font, await pdf.embedPng(buf), caption);
        } else {
          addReceiptLinkPage(pdf, font, bold, caption, url);
        }
        merged++;
      } catch (e) {
        addReceiptLinkPage(pdf, font, bold, caption, url);
        skipped++;
      }
    }
  }

  const pdfBytes = await pdf.save();
  const bucket = admin.storage().bucket();
  const path = `event-reports/${eventId}/summary-${Date.now()}.pdf`;
  const token = crypto.randomUUID();
  await bucket.file(path).save(Buffer.from(pdfBytes), {
    metadata: { contentType: "application/pdf", metadata: { firebaseStorageDownloadTokens: token } }
  });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  await writeAudit("Generated event summary PDF", "Event", `${event.name || eventId} · ${merged} receipts merged${skipped ? `, ${skipped} linked` : ""}`, caller);
  return { url, merged, skipped };
});

// --- Read-stats debug endpoint (measurement harness only) -------------------
// Enabled only when POH_COUNT_READS=1 (emulator). Unauthenticated on purpose so
// the local harness can call it without minting a token; it is never deployed
// with the env var set, and returns an error otherwise.
exports.pohReadStats = onCall({ region: "asia-south1" }, async (request) => {
  if (process.env.POH_COUNT_READS !== "1") {
    throw new HttpsError("failed-precondition", "Read stats are only available in the measurement emulator.");
  }
  ensureReadPatch();
  const ref = db.doc(STATS_DOC_PATH); // reads of this doc are excluded from counting (isStatsDoc)
  const snap = await ref.get();
  const total = snap.exists ? Number(snap.data().total || 0) : 0;
  if (request.data && request.data.reset) {
    await ref.set({ total: 0 }, { merge: true });
  }
  return { total };
});

// ============================================================================
// Complaints & Helpdesk ticketing (ticketHub)
// Residents raise complaints; they auto-land in the manager queue; the manager
// assigns a team, updates status/comments, and closes; the resident rates it.
// Ticket ids are POH-<FLAT>-NNNN (per-flat sequence); flat is derived from the
// authed user, never trusted from the client. All state changes append to the
// ticket timeline and fan out in-app notifications.
// ============================================================================
function ticketFlatKey(flat) {
  const s = String(flat || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return s || "COMMON";
}

async function nextTicketId(flatKey) {
  const counterRef = db.collection("ticketCounters").doc(flatKey);
  let seq = 1;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    seq = Number(snap.data() && snap.data().seq || 0) + 1;
    tx.set(counterRef, { seq, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
  return `POH-${flatKey}-${String(seq).padStart(4, "0")}`;
}

async function ticketManagerEmails() {
  const active = (docs) => docs.filter((d) => String(d.data().status || "").toLowerCase() === "active")
    .map((d) => String(d.data().email || "").trim().toLowerCase()).filter(Boolean);
  const managers = active((await db.collection("users").where("role", "==", "manager").get()).docs);
  if (managers.length) return managers;
  // No manager onboarded yet — fall back to admins so nothing is missed.
  return active((await db.collection("users").where("role", "in", ADMIN_ROLES).get()).docs);
}

async function notifyRecipients(emails, note) {
  const uniq = [...new Set((emails || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  if (!uniq.length) return;
  const batch = db.batch();
  uniq.forEach((email) => {
    const ref = db.collection("notifications").doc();
    batch.set(ref, { id: ref.id, recipientEmail: email, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp(), ...note });
  });
  await batch.commit();
}

function ticketTimelineEntry(caller, action, detail) {
  return { at: new Date().toISOString(), by: caller.email, byName: caller.profile.name || caller.email, byRole: caller.profile.role || "resident", action, detail: detail || "" };
}

function publicTicket(id, d, opts) {
  return {
    id,
    flat: d.flat || "", floor: d.floor || "",
    category: d.category || "Other", priority: d.priority || "Normal",
    title: d.title || "", description: d.description || "",
    status: d.status || "Open", team: d.team || "", assignee: d.assignee || "",
    photoUrl: d.photoUrl || "",
    raisedByName: d.raisedByName || "Resident", raisedByEmail: (opts && opts.reveal) ? (d.raisedByEmail || "") : "",
    commentCount: Number(d.commentCount || 0),
    feedback: d.feedback || null,
    createdAt: d.createdAt || null, updatedAt: d.updatedAt || null,
    assignedAt: d.assignedAt || null, resolvedAt: d.resolvedAt || null, closedAt: d.closedAt || null,
    timeline: Array.isArray(d.timeline) ? d.timeline : []
  };
}

exports.ticketHub = onCall({ region: "asia-south1" }, async (request) => {
  ensureReadPatch();
  const action = String(request.data?.action || "list");
  const caller = await callerProfile(request);
  ensureActive(caller.profile);
  const payload = request.data?.payload || {};
  const isManager = MANAGER_ROLES.includes(caller.profile.role);
  const callerEmailLower = String(caller.email || "").trim().toLowerCase();

  // ---- Resident: raise a complaint -----------------------------------------
  if (action === "create") {
    const category = String(payload.category || "").trim();
    const priority = String(payload.priority || "Normal").trim();
    const title = String(payload.title || "").trim();
    const description = String(payload.description || "").trim();
    const photoUrl = String(payload.photoUrl || "").trim();
    const scopeCommon = payload.scope === "common";
    if (!TICKET_CATEGORIES.includes(category)) throw new HttpsError("invalid-argument", "Choose a valid category.");
    if (!TICKET_PRIORITIES.includes(priority)) throw new HttpsError("invalid-argument", "Choose a valid priority.");
    if (title.length < 4 || title.length > 120) throw new HttpsError("invalid-argument", "The title must be between 4 and 120 characters.");
    if (description.length < 5 || description.length > 2000) throw new HttpsError("invalid-argument", "Describe the issue in 5 to 2000 characters.");
    if (photoUrl && !/^https:\/\//i.test(photoUrl)) throw new HttpsError("invalid-argument", "The photo link is not valid.");
    const callerFlat = await resolveCallerFlat(caller);
    const flat = scopeCommon ? "COMMON" : callerFlat;
    if (!flat) throw new HttpsError("failed-precondition", "Your flat isn't linked to your profile yet — contact an administrator, or raise this as a common-area complaint.");
    const flatKey = ticketFlatKey(flat);
    const floor = flat === "COMMON" ? "Common" : String(flat).replace(/^0+/, "").charAt(0).toUpperCase();
    const id = await nextTicketId(flatKey);
    const now = admin.firestore.FieldValue.serverTimestamp();
    const ticket = {
      id, flat: flat.toUpperCase(), floor, flatKey,
      category, priority, title, description, photoUrl,
      status: "Open", team: "", assignee: "",
      raisedByEmail: caller.email, raisedByName: caller.profile.name || caller.email, raisedByUid: caller.uid,
      commentCount: 0, feedback: null,
      timeline: [ticketTimelineEntry(caller, "Raised", `${category} · ${priority}`)],
      createdAt: now, updatedAt: now
    };
    await db.collection("tickets").doc(id).set(ticket);
    await writeAudit("Raised complaint", "Ticket", `${id} · ${category} · ${title}`, caller);
    await notifyRecipients(await ticketManagerEmails(), { type: "ticket_new", ticketId: id, title: `New complaint ${id}`, body: `${category} (${priority}) from ${ticket.flat}: ${title}` });
    await notifyRecipients([caller.email], { type: "ticket_ack", ticketId: id, title: `Complaint ${id} raised`, body: `We've logged your ${category.toLowerCase()} complaint. You'll be notified as it progresses.` });
    return { id };
  }

  // ---- List tickets (resident: own flat; manager/admin: all + filters) ------
  if (action === "list") {
    let query = db.collection("tickets");
    if (isManager) {
      if (payload.status && TICKET_STATUSES.includes(payload.status)) query = query.where("status", "==", payload.status);
    } else {
      const flat = ticketFlatKey(await resolveCallerFlat(caller));
      query = query.where("flatKey", "==", flat);
    }
    const snap = await query.get();
    const items = snap.docs
      .map((doc) => publicTicket(doc.id, doc.data(), { reveal: isManager }))
      .sort((a, b) => String(b.id).localeCompare(String(a.id)));
    return { items, isManager, canManage: isManager };
  }

  // ---- Ticket detail + comments --------------------------------------------
  if (action === "get") {
    const id = String(payload.ticketId || "");
    const snap = await db.collection("tickets").doc(id).get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    const ownFlat = ticketFlatKey(await resolveCallerFlat(caller));
    const isOwner = String(d.raisedByEmail || "").trim().toLowerCase() === callerEmailLower || d.flatKey === ownFlat;
    if (!isManager && !isOwner) throw new HttpsError("permission-denied", "You can only view your own complaints.");
    const commentsSnap = await db.collection("tickets").doc(id).collection("comments").orderBy("createdAt", "asc").get();
    const comments = commentsSnap.docs
      .map((c) => c.data())
      .filter((c) => isManager || !c.internal)
      .map((c) => ({ author: c.authorName || "User", role: c.authorRole || "", text: c.text || "", internal: Boolean(c.internal), createdAt: c.createdAt || null }));
    return { ticket: publicTicket(id, d, { reveal: isManager }), comments, isManager, isOwner };
  }

  // ---- Manager: assign to a team -------------------------------------------
  if (action === "assign") {
    if (!isManager) throw new HttpsError("permission-denied", "Only the manager or an administrator can assign complaints.");
    const id = String(payload.ticketId || "");
    const team = String(payload.team || "").trim();
    const assignee = String(payload.assignee || "").trim();
    if (!TICKET_TEAMS.includes(team)) throw new HttpsError("invalid-argument", "Choose a valid team.");
    const ref = db.collection("tickets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    await ref.set({
      status: "Assigned", team, assignee,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      timeline: admin.firestore.FieldValue.arrayUnion(ticketTimelineEntry(caller, "Assigned", `${team}${assignee ? " · " + assignee : ""}`))
    }, { merge: true });
    await writeAudit("Assigned complaint", "Ticket", `${id} · ${team}`, caller);
    await notifyRecipients([d.raisedByEmail], { type: "ticket_update", ticketId: id, title: `${id} assigned`, body: `Your complaint has been assigned to ${team}. We'll update you as work progresses.` });
    return { ok: true };
  }

  // ---- Manager: update status (In Progress / Resolved / Cancelled) ----------
  if (action === "updateStatus") {
    if (!isManager) throw new HttpsError("permission-denied", "Only the manager or an administrator can update complaints.");
    const id = String(payload.ticketId || "");
    const status = String(payload.status || "").trim();
    if (!["In Progress", "Resolved", "Cancelled", "Assigned"].includes(status)) throw new HttpsError("invalid-argument", "Choose a valid status.");
    const ref = db.collection("tickets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    const patch = { status, updatedAt: admin.firestore.FieldValue.serverTimestamp(), timeline: admin.firestore.FieldValue.arrayUnion(ticketTimelineEntry(caller, status, String(payload.note || ""))) };
    if (status === "Resolved") patch.resolvedAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(patch, { merge: true });
    await writeAudit("Updated complaint", "Ticket", `${id} · ${status}`, caller);
    await notifyRecipients([d.raisedByEmail], { type: "ticket_update", ticketId: id, title: `${id} · ${status}`, body: `Your complaint status is now "${status}".` });
    return { ok: true };
  }

  // ---- Comment (resident on own; manager anywhere, may be internal) ---------
  if (action === "comment") {
    const id = String(payload.ticketId || "");
    const text = String(payload.text || "").trim();
    const internal = isManager && (payload.internal === true || payload.internal === "true");
    if (text.length < 1 || text.length > 2000) throw new HttpsError("invalid-argument", "Enter a comment (up to 2000 characters).");
    const ref = db.collection("tickets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    const ownFlat = ticketFlatKey(await resolveCallerFlat(caller));
    const isOwner = String(d.raisedByEmail || "").trim().toLowerCase() === callerEmailLower || d.flatKey === ownFlat;
    if (!isManager && !isOwner) throw new HttpsError("permission-denied", "You can only comment on your own complaints.");
    await ref.collection("comments").add({ authorEmail: caller.email, authorName: caller.profile.name || caller.email, authorRole: caller.profile.role || "resident", text, internal, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    await ref.set({ commentCount: admin.firestore.FieldValue.increment(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeAudit("Commented on complaint", "Ticket", `${id}${internal ? " (internal)" : ""}`, caller);
    if (isManager && !internal) await notifyRecipients([d.raisedByEmail], { type: "ticket_comment", ticketId: id, title: `New reply on ${id}`, body: text.slice(0, 140) });
    else if (!isManager) await notifyRecipients(await ticketManagerEmails(), { type: "ticket_comment", ticketId: id, title: `New comment on ${id}`, body: `${d.flat}: ${text.slice(0, 140)}` });
    return { ok: true };
  }

  // ---- Manager: close a resolved complaint ---------------------------------
  if (action === "close") {
    if (!isManager) throw new HttpsError("permission-denied", "Only the manager or an administrator can close complaints.");
    const id = String(payload.ticketId || "");
    const ref = db.collection("tickets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    await ref.set({ status: "Closed", closedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(), timeline: admin.firestore.FieldValue.arrayUnion(ticketTimelineEntry(caller, "Closed", String(payload.note || ""))) }, { merge: true });
    await writeAudit("Closed complaint", "Ticket", id, caller);
    await notifyRecipients([d.raisedByEmail], { type: "ticket_closed", ticketId: id, title: `${id} closed`, body: "Your complaint has been closed. Please share feedback on the service." });
    return { ok: true };
  }

  // ---- Resident: reopen a closed complaint ---------------------------------
  if (action === "reopen") {
    const id = String(payload.ticketId || "");
    const ref = db.collection("tickets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    const ownFlat = ticketFlatKey(await resolveCallerFlat(caller));
    const isOwner = String(d.raisedByEmail || "").trim().toLowerCase() === callerEmailLower || d.flatKey === ownFlat;
    if (!isManager && !isOwner) throw new HttpsError("permission-denied", "You can only reopen your own complaints.");
    if (!["Closed", "Resolved", "Cancelled"].includes(String(d.status))) throw new HttpsError("failed-precondition", "This complaint is still active.");
    await ref.set({ status: "Reopened", updatedAt: admin.firestore.FieldValue.serverTimestamp(), timeline: admin.firestore.FieldValue.arrayUnion(ticketTimelineEntry(caller, "Reopened", String(payload.reason || ""))) }, { merge: true });
    await writeAudit("Reopened complaint", "Ticket", id, caller);
    await notifyRecipients(await ticketManagerEmails(), { type: "ticket_update", ticketId: id, title: `${id} reopened`, body: `${d.flat} reopened this complaint.` });
    return { ok: true };
  }

  // ---- Resident: feedback on a closed complaint ----------------------------
  if (action === "feedback") {
    const id = String(payload.ticketId || "");
    const rating = Number(payload.rating || 0);
    const comment = String(payload.comment || "").trim().slice(0, 1000);
    if (!(rating >= 1 && rating <= 5)) throw new HttpsError("invalid-argument", "Rate the service from 1 to 5 stars.");
    const ref = db.collection("tickets").doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError("not-found", "Ticket not found.");
    const d = snap.data();
    const ownFlat = ticketFlatKey(await resolveCallerFlat(caller));
    const isOwner = String(d.raisedByEmail || "").trim().toLowerCase() === callerEmailLower || d.flatKey === ownFlat;
    if (!isOwner) throw new HttpsError("permission-denied", "Only the resident who raised the complaint can rate it.");
    if (String(d.status) !== "Closed") throw new HttpsError("failed-precondition", "You can rate a complaint once it is closed.");
    await ref.set({ feedback: { rating, comment, byName: caller.profile.name || caller.email, submittedAt: admin.firestore.FieldValue.serverTimestamp() }, updatedAt: admin.firestore.FieldValue.serverTimestamp(), timeline: admin.firestore.FieldValue.arrayUnion(ticketTimelineEntry(caller, "Rated", `${rating}/5`)) }, { merge: true });
    await writeAudit("Rated complaint", "Ticket", `${id} · ${rating}/5`, caller);
    await notifyRecipients(await ticketManagerEmails(), { type: "ticket_feedback", ticketId: id, title: `Feedback on ${id}`, body: `${rating}/5${comment ? " — " + comment.slice(0, 120) : ""}` });
    return { ok: true };
  }

  // ---- Dashboard stats (manager/admin/committee) ---------------------------
  if (action === "stats") {
    if (!isManager && !DIRECTORY_EDITOR_ROLES.includes(caller.profile.role)) throw new HttpsError("permission-denied", "Not permitted.");
    const snap = await db.collection("tickets").get();
    const byStatus = {}; const byCategory = {}; const byTeam = {};
    let ratingSum = 0, ratingCount = 0, resolvedDurationSum = 0, resolvedDurationCount = 0;
    const recentFeedback = [];
    snap.docs.forEach((doc) => {
      const d = doc.data();
      byStatus[d.status || "Open"] = (byStatus[d.status || "Open"] || 0) + 1;
      byCategory[d.category || "Other"] = (byCategory[d.category || "Other"] || 0) + 1;
      if (d.team) byTeam[d.team] = (byTeam[d.team] || 0) + 1;
      if (d.feedback && Number(d.feedback.rating)) { ratingSum += Number(d.feedback.rating); ratingCount++; if (recentFeedback.length < 10) recentFeedback.push({ id: doc.id, rating: Number(d.feedback.rating), comment: d.feedback.comment || "", byName: d.feedback.byName || "" }); }
      if (d.createdAt && d.closedAt && d.createdAt.toMillis && d.closedAt.toMillis) { resolvedDurationSum += (d.closedAt.toMillis() - d.createdAt.toMillis()); resolvedDurationCount++; }
    });
    const total = snap.size;
    const open = (byStatus["Open"] || 0) + (byStatus["Assigned"] || 0) + (byStatus["In Progress"] || 0) + (byStatus["Reopened"] || 0);
    return {
      total, open, resolved: byStatus["Resolved"] || 0, closed: byStatus["Closed"] || 0, cancelled: byStatus["Cancelled"] || 0,
      byStatus, byCategory, byTeam,
      avgRating: ratingCount ? ratingSum / ratingCount : 0, ratingCount,
      avgResolutionHours: resolvedDurationCount ? (resolvedDurationSum / resolvedDurationCount) / 3600000 : 0,
      recentFeedback
    };
  }

  throw new HttpsError("invalid-argument", "Unknown ticket action.");
});

// ---- Notifications feed (in-app) -------------------------------------------
exports.notificationHub = onCall({ region: "asia-south1" }, async (request) => {
  ensureReadPatch();
  const action = String(request.data?.action || "list");
  const caller = await callerProfile(request);
  ensureActive(caller.profile);
  const email = String(caller.email || "").trim().toLowerCase();
  if (action === "list") {
    const snap = await db.collection("notifications").where("recipientEmail", "==", email).orderBy("createdAt", "desc").limit(40).get();
    const items = snap.docs.map((d) => ({ id: d.id, type: d.data().type || "", ticketId: d.data().ticketId || "", title: d.data().title || "", body: d.data().body || "", read: Boolean(d.data().read), createdAt: d.data().createdAt || null }));
    return { items, unread: items.filter((i) => !i.read).length };
  }
  if (action === "markRead") {
    const ids = Array.isArray(request.data?.payload?.ids) ? request.data.payload.ids.map(String).slice(0, 50) : [];
    const batch = db.batch();
    for (const id of ids) {
      const ref = db.collection("notifications").doc(id);
      const snap = await ref.get();
      if (snap.exists && String(snap.data().recipientEmail || "").toLowerCase() === email) batch.set(ref, { read: true }, { merge: true });
    }
    await batch.commit();
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown notification action.");
});
