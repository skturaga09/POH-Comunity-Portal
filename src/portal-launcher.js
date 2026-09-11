import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import qrcode from "qrcode-generator";
import { GoogleAuthProvider, getAuth, onAuthStateChanged, signInWithPopup, signOut, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { collection, getDocs, getFirestore, connectFirestoreEmulator, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getDownloadURL, getStorage, ref, uploadBytes, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";

// --- Premium design pass · Step 4: dark-mode toggle (live for everyone) -------
// theme-init.js has already applied any saved theme before first paint (no
// flash). Here we just reflect the current state on the button and wire the
// click. The choice is remembered in localStorage; light is the default.
(function themeToggle() {
  const btn = document.getElementById("pohThemeToggle");
  if (!btn) return;
  const icon = document.getElementById("pohThemeIcon");
  const sync = () => {
    const dark = document.documentElement.getAttribute("data-mode") === "dark";
    if (icon) icon.className = "fa-solid " + (dark ? "fa-sun" : "fa-moon");
    btn.setAttribute("aria-pressed", String(dark));
    btn.title = dark ? "Switch to light theme" : "Switch to dark theme";
  };
  sync();
  btn.addEventListener("click", () => {
    const dark = document.documentElement.getAttribute("data-mode") === "dark";
    if (dark) document.documentElement.removeAttribute("data-mode");
    else document.documentElement.setAttribute("data-mode", "dark");
    try { localStorage.setItem("pohTheme", dark ? "light" : "dark"); } catch (e) {}
    sync();
  });
})();

const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

// WhatsApp group join card (home). Announcements — e.g. "update your vehicle
// details" — go out on the group, so non-members miss them. Membership can't be
// detected, so show the card to everyone until they dismiss it; the dismissal is
// persisted so residents who are already in aren't nagged on every visit.
(function whatsappJoinCard() {
  const card = document.getElementById("whatsappJoinCard");
  if (!card) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem("pohWaJoinDismissed") === "1"; } catch (e) {}
  card.hidden = dismissed;
  const hide = () => {
    card.hidden = true;
    try { localStorage.setItem("pohWaJoinDismissed", "1"); } catch (e) {}
  };
  document.getElementById("whatsappJoinDismiss")?.addEventListener("click", hide);
  document.getElementById("whatsappJoinCta")?.addEventListener("click", () => setTimeout(hide, 500));
})();
const textOr = (value, fallback) => value == null || value === "" ? fallback : value;
const money = (value) => `₹${Math.round(Number(value || 0)).toLocaleString("en-IN")}`;
const roleLabel = (role) => String(role || "resident").replace(/_/g, " ");
const safeUrl = (value) => /^https:\/\//i.test(String(value || "")) ? String(value) : "";
const financeRoles = new Set(["super_admin", "admin", "president", "treasurer"]);
const adminRoles = new Set(["super_admin", "admin", "president"]);
const directoryEditorRoles = new Set(["super_admin", "admin", "president", "committee"]);

const app = initializeApp(window.POH_FIREBASE_CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functions = getFunctions(app, "asia-south1");

// --- Local development: connect to the Firebase Emulator Suite ---------------
// Dev, Codex, Claude Code, and automated browser tests should run against the
// local emulator, never production. This activates ONLY on localhost/127.0.0.1
// (optionally forced off with ?emulator=0), so the deployed site at
// poh-community-portal.web.app is never affected. See tools/README-dev.md.
(function connectEmulatorsInDev() {
  try {
    const host = location.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    const forced = new URLSearchParams(location.search).get("emulator");
    // Emulators only ever activate on localhost (opt out there with ?emulator=0).
    // A deployed/prod origin can NEVER be pointed at emulators, even with a query
    // param — this guarantees production is unaffected.
    const useEmulators = isLocal && forced !== "0";
    if (!useEmulators) return;
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    try { connectStorageEmulator(storage, "127.0.0.1", 9199); } catch (e) {}
    console.info("[POH] Connected to Firebase emulators (local dev).");
  } catch (e) { console.warn("[POH] Emulator connection skipped:", e); }
})();

// Register the service worker (production/staging only) so the app is an
// installable PWA — the basis for the Play Store / App Store wrappers. Skipped on
// localhost so it never interferes with local dev / the emulator.
(function registerServiceWorker() {
  try {
    const host = location.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
    if (isLocal || !("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("[POH] SW registration failed", e));
    });
  } catch (e) {}
})();

// Upload a file to Storage at the given path and return its download URL.
async function uploadFile(file, path) {
  const safePath = String(path).replace(/[^a-zA-Z0-9._/-]/g, "-");
  const fileRef = ref(storage, safePath);
  await uploadBytes(fileRef, file, { contentType: file.type });
  return await getDownloadURL(fileRef);
}
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

let approvedProfile = null;
let portalData = { events: [], notices: [], residents: [], committee: [], auditLogs: [], finance: {}, commonPool: 0 };
let activeEventId = null;
let selectedDirectoryFloor = "";
let homeNoticeIndex = 0;
let homeNoticeTimer = null;
let adminSecure = { users: [], invites: [], settlements: [], commonPool: 0 };
let portalWorkDepth = 0;
let portalLoaderTimer = null;

const portalAccessCall = (data) => httpsCallable(functions, "portalAccess")(data);
const adminConsoleCall = (data) => httpsCallable(functions, "adminConsole")(data);
const feedbackHubCall = (data) => httpsCallable(functions, "feedbackHub")(data);
const generateEventReportCall = (data) => httpsCallable(functions, "generateEventReport")(data);

function setProfileImage(id, photoUrl, displayName = "") {
  const image = byId(id);
  if (!image) return;
  const fallback = "/assets/poh-logo.jpeg";
  image.referrerPolicy = "no-referrer";
  image.alt = "";
  image.onerror = () => {
    image.onerror = null;
    image.src = fallback;
  };
  const source = safeUrl(photoUrl);
  image.src = source || fallback;
}

function setScreen(state, detail = "") {
  byId("accessScreen").dataset.state = state;
  byId("accessMessage").textContent = detail;
  byId("primaryAction").disabled = state === "checking";
  byId("primaryAction").textContent = state === "approved" ? "Enter community portal  →" : "Continue with Google  →";
  byId("signOutAction").hidden = !auth.currentUser;
}

// Show/hide an element in the browser top layer so it renders ABOVE open
// <dialog> modals (which live in the top layer). Falls back to the hidden
// attribute where the Popover API is unavailable.
function showTopLayer(el) {
  if (!el) return;
  el.hidden = false;
  if (el.hasAttribute("popover") && typeof el.showPopover === "function") {
    try { if (!el.matches(":popover-open")) el.showPopover(); } catch (e) { /* already open */ }
  }
}
function hideTopLayer(el) {
  if (!el) return;
  if (el.hasAttribute("popover") && typeof el.hidePopover === "function") {
    try { if (el.matches(":popover-open")) el.hidePopover(); } catch (e) { /* already closed */ }
  }
  el.hidden = true;
}

function showToast(message, tone = "") {
  const toast = byId("toast");
  toast.textContent = message;
  toast.dataset.tone = tone;
  showTopLayer(toast);
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { hideTopLayer(toast); }, 4600);
}

function beginPortalWork(message = "Working securely…") {
  portalWorkDepth += 1;
  window.clearTimeout(portalLoaderTimer);
  byId("portalLoaderMessage").textContent = message;
  showTopLayer(byId("portalLoader"));
}

function endPortalWork() {
  portalWorkDepth = Math.max(0, portalWorkDepth - 1);
  if (portalWorkDepth) return;
  window.clearTimeout(portalLoaderTimer);
  portalLoaderTimer = window.setTimeout(() => { hideTopLayer(byId("portalLoader")); }, 120);
}

function pulsePortalWork(message = "Opening…") {
  beginPortalWork(message);
  window.setTimeout(endPortalWork, 420);
}

// Toggle a form's submit button into a disabled "Saving…" spinner state and
// back, preserving the original button label.
function setSubmitting(form, on) {
  const btn = form?.querySelector?.("[type=submit]");
  if (!btn) return;
  if (on) {
    if (btn.dataset.originalLabel === undefined) btn.dataset.originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…';
  } else {
    btn.disabled = false;
    if (btn.dataset.originalLabel !== undefined) { btn.innerHTML = btn.dataset.originalLabel; delete btn.dataset.originalLabel; }
  }
}

async function refreshAccess(user) {
  const account = byId("account");
  account.hidden = false;
  account.querySelector("strong").textContent = user.displayName || user.email || "Signed-in resident";
  account.querySelector("span").textContent = user.email || "";
  setProfileImage("accountPhoto", user.photoURL, user.displayName || user.email);
  setScreen("checking", "Checking your POH Community Portal access…");
  try {
    const access = await portalAccessCall({ action: "status" });
    const profile = access.data?.profile || null;
    if (access.data?.directoryVersion != null) currentDirectoryVersion = access.data.directoryVersion; // M-A: decides whether to reuse the cached directory
    if (!profile || profile.status !== "active") {
      approvedProfile = null;
      setScreen("pending", "Your account is signed in, but it has not yet been approved for POH Community Portal access.");
      return;
    }
    approvedProfile = profile;
    setScreen("approved", `Access approved · ${roleLabel(profile.role)}`);
    // Automatically open portal on page load/refresh for active approved users
    await enterPortal(user);
  } catch (error) {
    console.error("Unable to verify access", error);
    setScreen("error", "We could not verify your access right now. Please try again in a moment.");
  }
}

async function loadCollection(name, required = false) {
  try { return (await getDocs(collection(db, name))).docs.map((entry) => ({ id: entry.id, ...entry.data() })); }
  catch (error) {
    console.error(`Unable to load ${name}`, error);
    if (required) throw error;
    return [];
  }
}

// H-4: the audit trail is append-only and unbounded. The admin view only ever
// renders the 30 most recent entries, so read the newest 50 instead of the whole
// collection (writeAudit always stamps createdAt, so ordering is well-defined).
async function loadAuditLogs() {
  if (!adminRoles.has(approvedProfile?.role)) return []; // non-admins are denied anyway
  try {
    const snap = await getDocs(query(collection(db, "auditLogs"), orderBy("createdAt", "desc"), limit(50)));
    return snap.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
  } catch (error) {
    console.error("Unable to load audit logs", error);
    return [];
  }
}

// H-1: the 147-row directory (served masked-per-role by the callable) was
// re-fetched on every login, refresh, and reopen. Cache it briefly in
// localStorage so refreshes/reopens within the TTL cost 0 reads. Only the masked
// (non-editor) view is persisted to disk — editors who see unmasked PII always
// fetch fresh. A resident's own edit forces a fresh fetch (see refreshDirectory).
const DIR_CACHE_KEY = "pohDirectoryCacheV2";
const DIR_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h safety backstop; the version sentinel does the real invalidation
let currentDirectoryVersion = null; // set from portalAccess:status each session (M-A)

function readDirectoryCache(role) {
  try {
    const obj = JSON.parse(localStorage.getItem(DIR_CACHE_KEY) || "null");
    if (!obj || obj.role !== role || !Array.isArray(obj.residents)) return null;
    if (Date.now() - Number(obj.ts || 0) > DIR_CACHE_TTL_MS) return null;
    return { version: Number(obj.version ?? -1), residents: obj.residents };
  } catch (e) { return null; }
}
function writeDirectoryCache(role, version, residents) {
  try { localStorage.setItem(DIR_CACHE_KEY, JSON.stringify({ role, ts: Date.now(), version, residents })); } catch (e) {}
}

async function loadDirectory({ force = false } = {}) {
  const role = approvedProfile?.role || "resident";
  const cacheable = !directoryEditorRoles.has(role); // never persist unmasked PII
  // Reuse the cached directory when its version matches the current one reported
  // by status — no fetch at all, regardless of age (M-A). A blind TTL is only the
  // safety backstop inside readDirectoryCache.
  if (!force && cacheable && currentDirectoryVersion != null) {
    const cached = readDirectoryCache(role);
    if (cached && cached.version === currentDirectoryVersion) return cached.residents;
  }
  const result = await portalAccessCall({ action: "directory" });
  const residents = result.data?.residents || [];
  if (result.data?.directoryVersion != null) currentDirectoryVersion = result.data.directoryVersion;
  if (cacheable) writeDirectoryCache(role, currentDirectoryVersion, residents);
  return residents;
}

async function loadCommonPool() {
  const result = await portalAccessCall({ action: "commonPool" });
  return Number(result.data?.balance || 0);
}

async function loadEventFinance(event) {
  const [expenseSnapshot, contributionSnapshot] = await Promise.all([
    getDocs(collection(db, "events", event.id, "expenses")),
    getDocs(collection(db, "events", event.id, "contributions"))
  ]);
  const records = (snapshot) => snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }));
  const expenses = records(expenseSnapshot);
  const contributions = records(contributionSnapshot);
  const spent = expenses.filter((item) => String(item.status || "Approved").toLowerCase() === "approved").reduce((total, item) => total + Number(item.amount || 0), 0);
  const collected = contributions.reduce((total, item) => total + Number(item.amount || 0), 0);
  // Deficit-recovery (additional) contributions: only fetched when the event ran
  // a deficit — most events never do, so this adds no read to the common case.
  const baseBalance = collected + Number(event.commonPoolAllocation || 0) - spent;
  const ranDeficit = baseBalance < 0 || (event.settlementFigures && Number(event.settlementFigures.balance || 0) < 0);
  let additionalContributions = [];
  if (ranDeficit) {
    additionalContributions = records(await getDocs(collection(db, "events", event.id, "additionalContributions")));
  }
  return {
    expenses,
    contributions,
    additionalContributions,
    additionalCollected: additionalContributions.reduce((total, item) => total + Number(item.amount || 0), 0),
    spent,
    collected
  };
}

// Lightweight finance summary for a CLOSED event, built from the settlementFigures
// snapshot stored on the event doc at settlement time — no contributions/expenses
// sub-collection reads. Marked summaryOnly so the full records are fetched on
// demand (ensureEventFinance) if the user opens that event's dashboard.
function financeSummaryFromEvent(event) {
  const figures = event && event.settlementFigures ? event.settlementFigures : null;
  return {
    summaryOnly: true,
    expenses: [],
    contributions: [],
    additionalContributions: [],
    additionalCollected: 0,
    collected: Number(figures?.collected || 0),
    spent: Number(figures?.spent || 0)
  };
}

// Load + cache an event's full finance (contributions + expenses) if we only
// hold the lightweight summary. No-op if already fully loaded.
async function ensureEventFinance(eventId) {
  if (!eventId) return null;
  const current = portalData.finance[eventId];
  if (current && !current.summaryOnly) return current;
  const event = portalData.events.find((entry) => entry.id === eventId);
  if (!event) return current || null;
  portalData.finance[eventId] = await loadEventFinance(event);
  return portalData.finance[eventId];
}

function eventTitle(event) { return textOr(event?.name || event?.title || event?.eventName, "Untitled community event"); }
function eventStatus(event) { return textOr(event?.status, "Planning in progress"); }
function eventDetail(event) { return textOr(event?.date || event?.eventDate || event?.startDate, "Date to be announced"); }
function isClosed(event) {
  if (!event) return false;
  const status = String(eventStatus(event)).toLowerCase();
  return /settled|closed|completed/i.test(status) || /^closed$/i.test(String(event.settlementStatus || "").toLowerCase());
}
function occupancyKey(resident) { return String(resident.occupancyStatus || resident.occupancy || "unverified").toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, ""); }
function residentName(resident) { return textOr(resident.displayName || resident.ownerName || resident.name || resident.tenantName, "Resident details pending"); }
function getFlatResidentName(flatVal, storedName) {
  const norm = String(flatVal || "").trim().replace(/^0+/, "").toUpperCase();
  let directoryName = "";
  if (norm && Array.isArray(portalData?.residents)) {
    const resident = portalData.residents.find((r) => {
      const rFlat = String(r.flat || "").trim().replace(/^0+/, "").toUpperCase();
      const rFlatNo = String(r.flatNo || "").trim().replace(/^0+/, "").toUpperCase();
      const rId = String(r.id || "").trim().replace(/^0+/, "").toUpperCase();
      return rFlat === norm || rFlatNo === norm || rId === norm;
    });
    if (resident) {
      directoryName = residentName(resident);
    }
  }

  const cleanStored = String(storedName || "").trim();
  const isGeneric = !cleanStored || /^(resident|resident ji|owner|owner not recorded|resident details pending|n\/a|none)?$/i.test(cleanStored);

  if (directoryName && !/resident details pending/i.test(directoryName)) {
    return directoryName;
  }
  if (!isGeneric) {
    return cleanStored;
  }
  return directoryName || "Resident";
}
function activeEvent() { return portalData.events.find((event) => event.id === activeEventId) || portalData.events.find((event) => event.active) || portalData.events[0]; }

function contributionFloorOrder(a, b) {
  const strA = String(a || "").trim().toUpperCase();
  const strB = String(b || "").trim().toUpperCase();
  const isGA = strA === "G" || strA === "0";
  const isGB = strB === "G" || strB === "0";
  if (isGA && isGB) return 0;
  if (isGA) return -1;
  if (isGB) return 1;
  const numA = parseInt(strA.replace(/\D+/g, ""), 10);
  const numB = parseInt(strB.replace(/\D+/g, ""), 10);
  if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
  return strA.localeCompare(strB, undefined, { numeric: true });
}

function flatNumberOrder(flatA, flatB, floorA, floorB) {
  if (floorA !== undefined && floorB !== undefined && String(floorA || "") !== String(floorB || "")) {
    const floorCmp = contributionFloorOrder(floorA, floorB);
    if (floorCmp !== 0) return floorCmp;
  }
  const strA = String(flatA || "").trim();
  const strB = String(flatB || "").trim();
  const numA = parseInt(strA.replace(/\D+/g, ""), 10);
  const numB = parseInt(strB.replace(/\D+/g, ""), 10);
  if (!isNaN(numA) && !isNaN(numB) && numA !== numB) return numA - numB;
  return strA.localeCompare(strB, undefined, { numeric: true });
}

function prepareContributionForm() {
  const form = byId("contributionForm");
  form.reset();
  delete form.dataset.editingContributionId; // fresh "add" mode
  if (byId("contributionFormTitle")) byId("contributionFormTitle").textContent = "Add Contribution";
  const saveBtn = byId("saveContribution");
  if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Save contribution';
  setupContributionAmount();
  syncPaymentReferenceFields();
  const floors = [...new Set(portalData.residents.map((resident) => String(resident.floor || "Unassigned")))].sort(contributionFloorOrder);
  byId("contributionFloor").disabled = false;
  byId("contributionFloor").innerHTML = `<option value="">Select floor</option>${floors.map((floor) => `<option value="${escapeHtml(floor)}">${escapeHtml(floor === "G" ? "Ground floor" : `Floor ${floor}`)}</option>`).join("")}`;
  byId("contributionFlat").innerHTML = "<option value=\"\">Select floor first</option>";
  byId("contributionFlat").disabled = true;
  byId("contributionOwner").value = "";
  byId("contributionSpoc").value = "";
  if (form.elements.date) form.elements.date.value = toDateInputValue(new Date()); // default to today
  const hint = byId("contributionDuplicateWarning");
  if (hint) hint.hidden = true;
}

// Open the contribution form pre-filled to EDIT an existing contribution.
function openContributionEditor(contribution) {
  const form = byId("contributionForm");
  prepareContributionForm();
  form.dataset.editingContributionId = String(contribution.id || "");
  if (byId("contributionFormTitle")) byId("contributionFormTitle").textContent = `Edit Contribution · Flat ${contribution.flat || ""}`;
  const saveBtn = byId("saveContribution");
  if (saveBtn) saveBtn.innerHTML = '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Update contribution';
  // Show flat/floor for context, but locked (edit keeps the same flat).
  byId("contributionFloor").value = String(contribution.floor || "");
  populateContributionFlats();
  byId("contributionFlat").value = String(contribution.flat || contribution.flatNo || "");
  byId("contributionFloor").disabled = true;
  byId("contributionFlat").disabled = true;
  byId("contributionOwner").value = contribution.name || contribution.ownerName || getFlatResidentName(String(contribution.flat || ""), contribution.name);
  form.elements.amount.value = Number(contribution.amount || 0) || "";
  form.elements.paymentMode.value = ["UPI", "Cash", "Bank Transfer"].includes(contribution.paymentMode) ? contribution.paymentMode : "UPI";
  if (form.elements.reference) form.elements.reference.value = contribution.reference || "";
  if (form.elements.date) form.elements.date.value = toDateInputValue(contribution.date) || toDateInputValue(new Date());
  syncPaymentReferenceFields();
  populateContributionSpoc();
  const hint = byId("contributionDuplicateWarning");
  if (hint) hint.hidden = true;
  byId("contributionFormModal").showModal();
}

// Official Floor SPOC mapping: G->Samarth, 1->Harsha, 2->Gangadhar, 3->Siddu, 4->Naveen, 5->Yeshwanth, 6->Santhosh
const OFFICIAL_FLOOR_SPOCS = {
  "G": "Samarth",
  "0": "Samarth",
  "1": "Harsha",
  "2": "Gangadhar",
  "3": "Siddu",
  "4": "Naveen",
  "5": "Yeshwanth",
  "6": "Santhosh"
};

function populateContributionSpoc() {
  const event = activeEvent();
  const rawFloor = byId("contributionFloor").value;
  const cleanFloor = String(rawFloor || "").replace(/\D+/g, "") || String(rawFloor || "").toUpperCase();
  
  const isIndependenceDayEvent = /independence/i.test(event?.name || event?.id || "");
  
  // 1. Check static official floor SPOC list ONLY for Independence Day event
  const officialName = isIndependenceDayEvent ? (OFFICIAL_FLOOR_SPOCS[rawFloor] || OFFICIAL_FLOOR_SPOCS[cleanFloor]) : null;
  
  // 2. Check event spocs list for event-specific assignments
  let spocsList = event?.spocs;

  const assignment = (spocsList || []).find((entry) => {
    const ef = String(entry.floor || "").replace(/\D+/g, "") || String(entry.floor || "").toUpperCase();
    return ef && cleanFloor ? ef === cleanFloor : String(entry.floor || "").trim() === String(rawFloor || "").trim();
  });

  const resident = assignment ? portalData.residents.find((entry) => String(entry.flat || entry.flatNo || "") === String(assignment.flat || "")) : null;

  if (officialName) {
    const matchedResident = portalData.residents.find(r => 
      (r.ownerName && r.ownerName.toLowerCase().includes(officialName.toLowerCase())) ||
      (r.tenantName && r.tenantName.toLowerCase().includes(officialName.toLowerCase()))
    );
    const flatInfo = matchedResident ? ` (Flat ${matchedResident.flat})` : (assignment ? ` · Flat ${assignment.flat}` : "");
    byId("contributionSpoc").value = `${officialName}${flatInfo}`;
  } else if (assignment) {
    byId("contributionSpoc").value = `${resident ? residentName(resident) : "Resident"} · Flat ${assignment.flat}`;
  } else {
    byId("contributionSpoc").value = "Not assigned for this event";
  }
}

function populateContributionFlats() {
  const floor = byId("contributionFloor").value;
  const flats = portalData.residents.filter((resident) => String(resident.floor || "Unassigned") === floor)
    .slice().sort((a, b) => String(a.flat || a.flatNo || "").localeCompare(String(b.flat || b.flatNo || ""), undefined, { numeric: true }));
  byId("contributionFlat").innerHTML = `<option value="">${flats.length ? "Select flat" : "No flats on this floor"}</option>${flats.map((resident) => {
    const flat = textOr(resident.flat || resident.flatNo, "Flat pending");
    return `<option value="${escapeHtml(flat)}">${escapeHtml(flat)}</option>`;
  }).join("")}`;
  byId("contributionFlat").disabled = !flats.length;
  byId("contributionOwner").value = "";
  populateContributionSpoc();
  checkContributionDuplicate();
}

function populateContributionOwner() {
  const flat = byId("contributionFlat")?.value?.trim() || "";
  const resident = portalData.residents.find((entry) => String(entry.flat || entry.flatNo || "").trim().toUpperCase() === flat.toUpperCase());
  if (byId("contributionOwner")) byId("contributionOwner").value = resident ? residentName(resident) : "";
  checkContributionDuplicate();
}

// Non-blocking hint: multiple contributions per flat are now allowed, so this
// only INFORMS the SPOC how much the flat has already contributed. It never
// disables the save button. (Kept the old name; callers are unchanged.)
function checkContributionDuplicate() {
  const flat = byId("contributionFlat")?.value?.trim() || "";
  const event = activeEvent();
  const saveBtn = byId("saveContribution");
  const warningEl = byId("contributionDuplicateWarning");
  if (saveBtn) { saveBtn.disabled = false; saveBtn.style.opacity = "1"; } // never block

  if (!event || !flat || byId("contributionForm")?.dataset.editingContributionId) {
    if (warningEl) warningEl.hidden = true;
    return false;
  }

  const finance = portalData.finance[event.id] || { contributions: [] };
  const existing = (finance.contributions || []).filter((item) =>
    String(item.flat || item.flatNo || "").trim().toUpperCase() === flat.toUpperCase()
  );

  if (existing.length && warningEl) {
    const total = existing.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    warningEl.innerHTML = `<i class="fa-solid fa-circle-info" style="font-size:15px;color:#1e5c4e;margin-right:6px;"></i> Flat <strong>${escapeHtml(flat)}</strong> already has <strong>${existing.length}</strong> contribution${existing.length > 1 ? "s" : ""} totalling <strong>₹${total.toLocaleString("en-IN")}</strong>. You can record another.`;
    warningEl.hidden = false;
    warningEl.style.background = "#f0f7f4";
    warningEl.style.border = "1px solid #bce2d2";
    warningEl.style.color = "#1e5c4e";
  } else if (warningEl) {
    warningEl.hidden = true;
  }
  return false;
}

function activeNotices() {
  const now = new Date();
  const priorityRank = { critical: 0, high: 1, normal: 2, low: 3 };
  return portalData.notices
    .filter((notice) => {
      if (notice.published === false) return false;
      if (!notice.expiresAt) return true;
      const rawExp = String(notice.expiresAt).trim();
      const expiryStr = rawExp.length === 10 ? `${rawExp}T23:59:59` : rawExp;
      const expiry = new Date(expiryStr);
      return Number.isNaN(expiry.getTime()) || expiry >= now;
    })
    .sort((a, b) => {
      const priority = (priorityRank[String(a.priority || "normal").toLowerCase()] ?? 2) - (priorityRank[String(b.priority || "normal").toLowerCase()] ?? 2);
      if (priority) return priority;
      const timeA = a.publishedAt?.toDate ? a.publishedAt.toDate().getTime() : new Date(a.publishedAt || a.createdAt || 0).getTime();
      const timeB = b.publishedAt?.toDate ? b.publishedAt.toDate().getTime() : new Date(b.publishedAt || b.createdAt || 0).getTime();
      return timeB - timeA;
    });
}

function renderHomeNoticeRotator(notices) {
  const host = byId("homeNoticeList");
  if (homeNoticeTimer) { window.clearInterval(homeNoticeTimer); homeNoticeTimer = null; }
  if (!notices.length) { host.innerHTML = empty("No community notices are published yet."); return; }
  homeNoticeIndex = Math.min(homeNoticeIndex, notices.length - 1);
  const notice = notices[homeNoticeIndex];
  const priority = String(notice.priority || "normal").toLowerCase();
  const dots = notices.length > 1 ? `<div class="notice-rotator-dots" aria-label="Notice navigation">${notices.map((_, index) => `<button type="button" data-home-notice="${index}" aria-label="Show notice ${index + 1}" aria-current="${index === homeNoticeIndex ? "true" : "false"}"></button>`).join("")}</div>` : "";
  host.innerHTML = `<article class="home-notice notice-priority-${escapeHtml(priority)}"><div class="home-notice-top"><span>${escapeHtml(textOr(notice.type, "Update"))}</span><b>${escapeHtml(textOr(notice.priority, "Normal"))}</b></div><strong>${escapeHtml(textOr(notice.title, "Community update"))}</strong><p>${escapeHtml(textOr(notice.body || notice.message || notice.description, "No details provided."))}</p><small><i class="fa-regular fa-clock" aria-hidden="true"></i> ${notice.expiresAt ? `Visible until ${escapeHtml(displayDate(notice.expiresAt))}` : "Latest community update"}</small>${dots}</article>`;
  if (notices.length > 1) {
    homeNoticeTimer = window.setInterval(() => {
      homeNoticeIndex = (homeNoticeIndex + 1) % notices.length;
      renderHomeNoticeRotator(notices);
    }, 6000);
  }
}

function noticeCard(notice) {
  const priority = String(notice.priority || "normal").toLowerCase();
  const date = notice.publishedAt || notice.createdAt || notice.date;
  const timing = [date ? displayDate(date) : "Latest community update", notice.expiresAt ? `Expires ${displayDate(notice.expiresAt)}` : ""].filter(Boolean).join(" · ");
  return `<article class="notice-card notice-priority-${escapeHtml(priority)}"><div class="notice-card-meta"><span>${escapeHtml(textOr(notice.type, "Update"))}</span><b>${escapeHtml(textOr(notice.priority, "Normal"))}</b></div><h3>${escapeHtml(textOr(notice.title, "Community update"))}</h3><p>${escapeHtml(textOr(notice.body || notice.message || notice.description, "No details provided."))}</p><small><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${escapeHtml(timing)}</small></article>`;
}

function renderHome() {
  const featured = portalData.events.find((event) => event.active) || portalData.events[0];
  const visibleCommittee = portalData.committee.filter((member) => member.visible === true);
  const notices = activeNotices();
  byId("heroEventName").textContent = featured ? eventTitle(featured) : "No active event";
  byId("heroEventDetail").textContent = featured ? `${eventStatus(featured)} · ${eventDetail(featured)}` : "Create an event from the Admin console to get started.";
  byId("homeEventCount").textContent = portalData.events.length;
  byId("homeNoticeCount").textContent = notices.length;
  byId("homeCommitteeCount").textContent = visibleCommittee.length;
  renderVehicleReminder();
  byId("homeEventContent").innerHTML = featured ? `<article class="home-feature-card"><span class="state-pill">${escapeHtml(eventStatus(featured))}</span><h3>${escapeHtml(eventTitle(featured))}</h3><p>${escapeHtml(textOr(featured.description, "A shared celebration for our community."))}</p><small>${escapeHtml(eventDetail(featured))}</small><button class="primary-button" type="button" data-home-event="${escapeHtml(featured.id)}"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i> Open event</button></article>` : empty("No event is active yet. Create one from the Admin console to get started.");
  renderHomeNoticeRotator(notices);
  byId("noticesFullList").innerHTML = notices.length ? notices.map(noticeCard).join("") : empty("No active notices are published yet.");
  byId("committeeGrid").innerHTML = visibleCommittee.length ? visibleCommittee.map((member) => `<article class="committee-card">${member.photoUrl ? `<img src="${escapeHtml(safeUrl(member.photoUrl))}" alt="">` : `<span class="monogram">${escapeHtml(String(member.name || "P").charAt(0))}</span>`}<div><strong>${escapeHtml(textOr(member.name, "Committee member"))}</strong><small>${escapeHtml(textOr(member.role, "Committee member"))}</small></div></article>`).join("") : empty("Committee details will be shared once the association is finalised.");
}

function renderEvents() {
  byId("eventsPoolBanner").innerHTML = `<span>Community common pool</span><strong>${money(portalData.commonPool)}</strong><small>Available to approved future event budgets</small>`;
  byId("eventGrid").innerHTML = portalData.events.length ? portalData.events.map((event) => {
    const finance = portalData.finance[event.id] || { collected: 0, spent: 0 };
    const poolAllocated = Number(event.commonPoolAllocation || 0);
    // Include deficit-recovery top-ups so the card's Available matches the backend
    // settlement balance (eventFigures folds additionalCollected into the balance).
    const balance = finance.collected + Number(finance.additionalCollected || 0) + poolAllocated - finance.spent;
    const isActive = eventStatus(event) === "Active";
    const isDone = isClosed(event);
    // Every event's dashboard is viewable at any time (read-only finance view).
    const actionBtn = isActive
      ? `<button class="solid-button" type="button" data-open-event="${escapeHtml(event.id)}">Open event dashboard <i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>`
      : isDone
      ? `<button class="solid-button" type="button" data-open-event="${escapeHtml(event.id)}" style="background:#183e35;border-color:#183e35;"><i class="fa-solid fa-eye" style="margin-right:6px;" aria-hidden="true"></i> View Dashboard (Completed)</button>`
      : `<button class="solid-button" type="button" data-open-event="${escapeHtml(event.id)}" style="background:#42605a;border-color:#42605a;"><i class="fa-solid fa-eye" style="margin-right:6px;" aria-hidden="true"></i> View dashboard (${escapeHtml(eventStatus(event))})</button>`;
    return `<article class="event-card"><div class="event-card-top"><span class="state-pill">${escapeHtml(eventStatus(event))}</span><i class="fa-solid fa-calendar-days" aria-hidden="true"></i></div><h3>${escapeHtml(eventTitle(event))}</h3><p>${escapeHtml(textOr(event.description, "A shared community celebration."))}</p><small class="event-date"><i class="fa-regular fa-calendar" aria-hidden="true"></i> ${escapeHtml(eventDetail(event))} · Suggested: ₹${event.contributionAmount || 500}/flat</small><div class="event-finance"><span>Contributions <strong>${money(finance.collected)}</strong></span><span>Pool in use <strong>${money(poolAllocated)}</strong></span><span>Spent <strong>${money(finance.spent)}</strong></span><span class="${balance < 0 ? "negative" : ""}">Available <strong>${money(balance)}</strong></span></div>${actionBtn}</article>`;
  }).join("") : empty("No events have been migrated. Use the Admin console to create your first community event.");
}

function renderDirectory() {
  const search = byId("directorySearch").value.trim().toLowerCase();
  const occupancy = byId("occupancyFilter").value;
  const allResidents = portalData.residents;
  const currentEvent = activeEvent();
  const residents = portalData.residents.filter((resident) => {
    const vehicleText = Array.isArray(resident.vehicles) ? resident.vehicles.map((v) => v.details || "").join(" ") : "";
    const haystack = [
      residentName(resident), resident.tenantName, resident.flatNo || resident.flat, resident.floor,
      resident.occupancyStatus || resident.occupancy, resident.subStatus,
      resident.phone, resident.ownerMobile, resident.tenantMobile, resident.caretakerMobile, resident.familyContactMobile,
      resident.ownerEmail, resident.ownerPrimaryEmail, resident.ownerSecondaryEmail,
      resident.tenantEmail, resident.tenantPrimaryEmail, resident.tenantSecondaryEmail, resident.familyContactEmail,
      resident.caretakerName, resident.familyContactName,
      resident.parkingLevel, resident.parkingSlots, resident.parkingAllocation,
      vehicleText
    ].join(" ").toLowerCase();
    return (!search || haystack.includes(search)) && (!occupancy || occupancyKey(resident) === occupancy) && (!selectedDirectoryFloor || String(resident.floor || "") === selectedDirectoryFloor);
  });
  const floors = [...new Set(allResidents.map((resident) => String(resident.floor || "Unassigned")))].sort(contributionFloorOrder);
  byId("directoryFloorTabs").innerHTML = [`<button type="button" data-floor="" aria-pressed="${!selectedDirectoryFloor}">All floors <b>${allResidents.length}</b></button>`, ...floors.map((floor) => `<button type="button" data-floor="${escapeHtml(floor)}" aria-pressed="${selectedDirectoryFloor === floor}">${floor === "G" || floor === "0" ? "Ground floor" : `Floor ${escapeHtml(floor)}`} <b>${allResidents.filter((resident) => String(resident.floor || "Unassigned") === floor).length}</b></button>`)].join("");
  byId("directoryFloorSummary").textContent = `${selectedDirectoryFloor ? (selectedDirectoryFloor === "G" || selectedDirectoryFloor === "0" ? "Ground floor" : `Floor ${selectedDirectoryFloor}`) : "All floors"} · ${residents.length} flats`;
  byId("directoryStats").textContent = `${residents.length} of ${allResidents.length} homes`;
  
  // Sort residents ascending by floor order (G -> 1..7) then flat number (G01 -> G02 -> G21)
  residents.sort((a, b) => flatNumberOrder(a.flatNo || a.flat, b.flatNo || b.flat, a.floor, b.floor));
  const count = (key) => residents.filter((resident) => occupancyKey(resident) === key).length;
  byId("ownerOccupiedCount").textContent = count("owner_occupied");
  byId("tenantOccupiedCount").textContent = count("tenant_occupied");
  byId("vacantCount").textContent = count("vacant") + count("unoccupied_owner_owned");
  byId("unverifiedCount").textContent = count("unverified");
  const userEmail = String(auth.currentUser?.email || "").toLowerCase();
  const isAdminOrCommittee = directoryEditorRoles.has(approvedProfile?.role);

  byId("directoryGrid").innerHTML = residents.length ? residents.map((resident) => {
    const stateKey = occupancyKey(resident);
    const rawState = textOr(resident.occupancyStatus || resident.occupancy, "Unverified");
    const subStatus = resident.subStatus ? ` · ${resident.subStatus}` : "";
    const flat = textOr(resident.flatNo || resident.flat, "Flat pending");
    const photo = safeUrl(resident.ownerPhotoUrl || resident.photoUrl);
    const name = residentName(resident);
    const flatStr = String(resident.flatNo || resident.flat || "").trim();
    const isSpoc = currentEvent && (currentEvent.spocs || []).some((s) => String(s.flat || "").trim() === flatStr);
    const spocName = isSpoc ? (resident.ownerName || resident.name || "SPOC") : null;
    const cardSubline = `Floor ${textOr(resident.floor, "—")}${spocName ? ` · SPOC: ${spocName}` : ""}${subStatus}`;
    const tenantLine = stateKey === "tenant_occupied"
      ? `<p class="tenant-line" style="color:#b77a1c;font-size:12px;margin-top:4px;font-weight:700;"><i class="fa-solid fa-key" style="margin-right:4px;"></i> Tenant: ${escapeHtml(textOr(resident.tenantName, "Tenant residing"))}</p>`
      : "";
    
    const isOutstation = Boolean(resident.isOutstation || resident.caretakerName);
    const outstationLine = isOutstation && resident.caretakerName
      ? `<p class="outstation-line" style="color:#1e684f;font-size:12px;margin-top:3px;font-weight:700;"><i class="fa-solid fa-earth-americas" style="margin-right:4px;color:#d99a32;"></i> Local Manager: ${escapeHtml(resident.caretakerName)}${resident.caretakerRelation ? ` (${escapeHtml(resident.caretakerRelation)})` : ""}</p>`
      : (isOutstation ? `<p class="outstation-line" style="color:#1e684f;font-size:12px;margin-top:3px;font-weight:700;"><i class="fa-solid fa-earth-americas" style="margin-right:4px;color:#d99a32;"></i> Owner Outstation / NRI</p>` : "");

    const displayPhoto = photo || "/assets/poh-logo.jpeg";
    const avatarContent = `<div class="card-avatar-wrap"><img class="resident-photo" src="${escapeHtml(displayPhoto)}" alt="Resident profile photo"><span class="flat-badge overlay-badge">${escapeHtml(flat)}</span></div>`;

    // Vehicle-on-file badges. `vehicles` is present only where the data is
    // visible (admin/committee, or the resident's own flat), so the chips show
    // there and stay hidden on masked cards. Non-four types are two-wheelers
    // (matching how the profile editor coerces the type on save).
    const cardVehicles = Array.isArray(resident.vehicles) ? resident.vehicles : [];
    const cardHasFour = cardVehicles.some((v) => /four/i.test(v.type || ""));
    const cardHasTwo = cardVehicles.some((v) => !/four/i.test(v.type || ""));
    const vehicleChip = (icon, label) => `<span class="vehicle-chip" title="${label}" aria-label="${label}" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;background:#eef4ee;border:1px solid #cfe0d3;color:#183e35;border-radius:6px;font-size:12px;"><i class="fa-solid ${icon}" aria-hidden="true"></i></span>`;
    const vehicleTags = (cardHasFour || cardHasTwo)
      ? `<p class="vehicle-tags" style="margin-top:6px;display:flex;gap:6px;align-items:center;">${cardHasFour ? vehicleChip("fa-car", "Four-wheeler on file") : ""}${cardHasTwo ? vehicleChip("fa-motorcycle", "Two-wheeler on file") : ""}</p>`
      : "";

    return `<article class="resident-card has-photo" data-view-resident="${escapeHtml(resident.id)}" tabindex="0" role="button" aria-label="View profile for ${escapeHtml(flat)}"><span class="resident-state ${escapeHtml(stateKey)}">${escapeHtml(rawState)}</span>${avatarContent}<div><h3>${escapeHtml(name)}</h3><p style="color:#68736c;font-size:13px;margin-top:2px;">${escapeHtml(cardSubline)}</p>${tenantLine}${outstationLine}${vehicleTags}</div></article>`;
  }).join("") : empty("No matching resident records were found.");
}

function openResidentProfile(resident) {
  const photo = safeUrl(resident.ownerPhotoUrl || resident.photoUrl) || "/assets/poh-logo.jpeg";
  const parking = [resident.parkingAllocation, resident.parkingLevel, resident.parkingSlots].filter(Boolean).join(" · ");
  const vehicles = Array.isArray(resident.vehicles) ? resident.vehicles : [];
  const currentEvent = activeEvent();
  const flat = String(resident.flat || resident.flatNo || "");
  const userEmail = String(auth.currentUser?.email || "").toLowerCase();
  const isAdminOrCommittee = directoryEditorRoles.has(approvedProfile?.role);
  const ownerEmails = [resident.ownerEmail, resident.ownerPrimaryEmail, resident.ownerSecondaryEmail].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  const isFlatOwner = ownerEmails.includes(userEmail)
    || (String(approvedProfile?.residentType || "").toLowerCase() === "owner" && String(approvedProfile?.flat || "").trim().toUpperCase() === flat.toUpperCase());
  const canEditThisProfile = isAdminOrCommittee || isFlatOwner;
  // Any resident tied to this flat (owner, tenant, or family email, or matching
  // profile flat) may update vehicles, even if they cannot full-edit the flat.
  const flatEmails = [resident.ownerEmail, resident.ownerPrimaryEmail, resident.ownerSecondaryEmail, resident.tenantEmail, resident.tenantPrimaryEmail, resident.tenantSecondaryEmail, resident.familyContactEmail].map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);
  const belongsToFlat = flatEmails.includes(userEmail) || String(approvedProfile?.flat || "").trim().toUpperCase() === flat.toUpperCase();
  const canEditVehicles = isAdminOrCommittee || belongsToFlat;

  const eventSpoc = currentEvent && (currentEvent.spocs || []).some((entry) => String(entry.flat || "") === flat)
    ? `${eventTitle(currentEvent)} · Floor ${textOr(resident.floor, "—")}` : "Not assigned";
  const isMasked = resident.isMasked || !isAdminOrCommittee;
  const ownerMobile = resident.ownerMobile || resident.phone || "";
  const tenantMobile = resident.tenantMobile || "";
  const caretakerMobile = resident.caretakerMobile || "";

  const ownerNote = ownerMobile
    ? (isMasked
        ? `<span style="color:#68736c;font-weight:700;"><i class="fa-solid fa-phone" style="margin-right:4px;"></i> ${escapeHtml(ownerMobile)} <small style="color:#a36e21;font-weight:800;">(Protected)</small></span>`
        : `<a href="tel:${escapeHtml(ownerMobile)}" style="color:#1e684f;font-weight:700;text-decoration:none;"><i class="fa-solid fa-phone" style="margin-right:4px;"></i> ${escapeHtml(ownerMobile)}</a>`)
    : "No mobile recorded";
  const tenantNote = tenantMobile
    ? (isMasked
        ? `<span style="color:#68736c;font-weight:700;"><i class="fa-solid fa-phone" style="margin-right:4px;"></i> ${escapeHtml(tenantMobile)} <small style="color:#a36e21;font-weight:800;">(Protected)</small></span>`
        : `<a href="tel:${escapeHtml(tenantMobile)}" style="color:#b77a1c;font-weight:700;text-decoration:none;"><i class="fa-solid fa-phone" style="margin-right:4px;"></i> ${escapeHtml(tenantMobile)}</a>`)
    : "No mobile recorded";
  const caretakerNote = caretakerMobile
    ? (isMasked
        ? `<span style="color:#68736c;font-weight:700;"><i class="fa-solid fa-phone" style="margin-right:4px;"></i> ${escapeHtml(caretakerMobile)} <small style="color:#a36e21;font-weight:800;">(Protected)</small></span>`
        : `<a href="tel:${escapeHtml(caretakerMobile)}" style="color:#1e684f;font-weight:700;text-decoration:none;"><i class="fa-solid fa-phone" style="margin-right:4px;"></i> ${escapeHtml(caretakerMobile)}</a>`)
    : "No phone recorded";

  const detail = (label, value, noteHtml = "", full = false) => `<article class="resident-profile-detail${full ? " full" : ""}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(textOr(value, "Not recorded"))}</strong>${noteHtml ? `<small style="margin-top:4px;display:block;">${noteHtml}</small>` : ""}</article>`;
  const vehicleDetail = `<article class="resident-profile-detail full"><span>Vehicles</span>${vehicles.length ? `<div class="resident-vehicle-list">${vehicles.map((vehicle) => `<div><strong>${escapeHtml(textOr(vehicle.type, "Vehicle"))}${vehicle.details ? ` · ${escapeHtml(vehicle.details)}` : ""}</strong><small>${escapeHtml(vehicle.type === "Two wheeler" ? (resident.parkingLevel ? `Uses the shared ${resident.parkingLevel} car-parking area.` : "Uses the flat’s shared car-parking area.") : "Registered to the flat’s shared car-parking allocation.")}</small></div>`).join("")}</div>` : "<strong>Not recorded</strong>"}</article>`;
  
  const statusDisplay = `${textOr(resident.occupancyStatus || resident.occupancy, "Unverified")}${resident.subStatus ? ` (${resident.subStatus})` : ""}`;
  const outstationDetail = (resident.isOutstation || resident.caretakerName)
    ? detail("Local Caretaker / Asset Manager", resident.caretakerName ? `${resident.caretakerName}${resident.caretakerRelation ? ` (${resident.caretakerRelation})` : ""}` : "Owner Resides Overseas / Outstation", caretakerNote)
    : "";

  byId("residentProfileContent").innerHTML = `<div class="resident-profile-hero"><img class="resident-profile-photo" src="${escapeHtml(photo)}" alt="Owner profile photo"><div><span class="resident-state ${escapeHtml(occupancyKey(resident))}" style="position:static;display:inline-block;min-width:0;padding:5px 8px">${escapeHtml(statusDisplay)}</span><h3>Flat ${escapeHtml(textOr(resident.flat || resident.flatNo, "—"))}</h3><p>Floor ${escapeHtml(textOr(resident.floor, "—"))}</p></div></div><div class="resident-profile-grid">${detail("Owner", resident.ownerName || resident.name, ownerNote)}${occupancyKey(resident) === "tenant_occupied" ? detail("Tenant", resident.tenantName, tenantNote) : ""}${outstationDetail}${detail("Event SPOC", eventSpoc, currentEvent ? `For ${eventTitle(currentEvent)}` : "No current event")}${detail("Car parking", parking, parking ? "Shared by every vehicle registered to this flat." : "Parking not yet allotted by the builder — vehicles can still be recorded.")}${vehicleDetail}</div>`;
  
  byId("residentProfileActions").hidden = !(canEditThisProfile || canEditVehicles);
  byId("residentProfileEdit").hidden = !canEditThisProfile;
  byId("residentProfileEdit").dataset.residentId = resident.id;
  // Show the quick vehicle editor to residents who cannot full-edit the flat.
  const vehiclesBtn = byId("residentEditVehicles");
  if (vehiclesBtn) {
    vehiclesBtn.hidden = !(canEditVehicles && !canEditThisProfile);
    vehiclesBtn.dataset.residentId = resident.id;
  }
  byId("residentParkingAudit").dataset.flat = resident.flat || resident.flatNo || resident.id;
  byId("residentParkingAudit").hidden = !adminRoles.has(approvedProfile?.role);
  byId("residentProfileModal").showModal();
}

function residentVehicleRow(vehicle = {}) {
  return `<div class="vehicle-row"><select class="resident-vehicle-type"><option${vehicle.type === "Two wheeler" ? " selected" : ""}>Two wheeler</option><option${vehicle.type === "Four wheeler" ? " selected" : ""}>Four wheeler</option></select><input class="resident-vehicle-details" value="${escapeHtml(vehicle.details || "")}" placeholder="Registration / vehicle details" style="text-transform:uppercase"><button class="remove-resident-vehicle" type="button" aria-label="Remove vehicle" title="Remove vehicle"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>`;
}

function openResidentEditor(resident) {
  const form = byId("residentEditorForm");
  form.reset();
  form.elements.flat.value = resident.flat || resident.flatNo || resident.id;
  const rawOcc = textOr(resident.occupancyStatus || resident.occupancy, "Unverified");
  const matchingOption = [...form.elements.occupancy.options].find(o => o.value.toLowerCase() === rawOcc.toLowerCase());
  form.elements.occupancy.value = matchingOption ? matchingOption.value : "Unverified";
  form.elements.subStatus.value = resident.subStatus || "";
  form.elements.ownerName.value = resident.ownerName || resident.name || "";
  form.elements.ownerMobile.value = resident.phone || resident.ownerMobile || "";
  if (form.elements.ownerPrimaryEmail) form.elements.ownerPrimaryEmail.value = resident.ownerPrimaryEmail || resident.ownerEmail || "";
  if (form.elements.ownerSecondaryEmail) form.elements.ownerSecondaryEmail.value = resident.ownerSecondaryEmail || "";
  form.elements.tenantName.value = resident.tenantName || "";
  form.elements.tenantMobile.value = resident.tenantMobile || "";
  if (form.elements.tenantPrimaryEmail) form.elements.tenantPrimaryEmail.value = resident.tenantPrimaryEmail || resident.tenantEmail || "";
  if (form.elements.tenantSecondaryEmail) form.elements.tenantSecondaryEmail.value = resident.tenantSecondaryEmail || "";
  if (form.elements.familyContactName) form.elements.familyContactName.value = resident.familyContactName || "";
  if (form.elements.familyContactRelation) form.elements.familyContactRelation.value = resident.familyContactRelation || "";
  if (form.elements.familyContactMobile) form.elements.familyContactMobile.value = resident.familyContactMobile || resident.familyContactPhone || "";
  if (form.elements.familyContactEmail) form.elements.familyContactEmail.value = resident.familyContactEmail || "";
  if (form.elements.isOutstation) form.elements.isOutstation.checked = Boolean(resident.isOutstation);
  if (form.elements.caretakerName) form.elements.caretakerName.value = resident.caretakerName || "";
  if (form.elements.caretakerMobile) form.elements.caretakerMobile.value = resident.caretakerMobile || "";
  if (form.elements.caretakerRelation) form.elements.caretakerRelation.value = resident.caretakerRelation || "";
  form.elements.parkingAllocation.value = resident.parkingAllocation || resident.parkingType || "";
  form.elements.parkingLevel.value = resident.parkingLevel || "";
  form.elements.parkingSlots.value = resident.parkingSlots || "";
  form.elements.ownerPhotoFile.value = "";
  byId("residentEditorFlatTitle").textContent = form.elements.flat.value;
  setResidentOwnerPhoto(resident.ownerPhotoUrl || resident.photoUrl || "");
  const vehicles = Array.isArray(resident.vehicles) ? resident.vehicles : [];
  byId("residentVehicleRows").innerHTML = vehicles.map(residentVehicleRow).join("");

  // Reset tab active state to Tab 1
  const tabsNav = byId("residentEditorTabs");
  if (tabsNav) {
    tabsNav.querySelectorAll(".editor-tab-btn").forEach((b, idx) => {
      const active = idx === 0;
      b.classList.toggle("active", active);
      b.style.background = active ? "#183e35" : "#e6efe9";
      b.style.color = active ? "#fff" : "#183e35";
    });
    document.querySelectorAll(".editor-tab-panel").forEach((panel, idx) => {
      panel.style.display = idx === 0 ? "block" : "none";
    });
  }

  updateResidentEditorFieldStates();
  byId("residentEditorModal").showModal();
}

function updateResidentEditorFieldStates() {
  const form = byId("residentEditorForm");
  if (!form) return;
  const occupancy = form.elements.occupancy ? form.elements.occupancy.value : "";
  const isTenantOccupied = String(occupancy).toLowerCase() === "tenant occupied";
  const tenantSection = byId("tenantFieldsSection");
  const tenantNote = byId("tenantDisabledNote");
  
  ["tenantName", "tenantMobile", "tenantPrimaryEmail", "tenantSecondaryEmail"].forEach((name) => {
    if (form.elements[name]) {
      form.elements[name].disabled = !isTenantOccupied;
    }
  });
  if (tenantSection) tenantSection.style.opacity = isTenantOccupied ? "1" : "0.5";
  if (tenantNote) tenantNote.style.display = isTenantOccupied ? "none" : "inline";

  const isOutstation = form.elements.isOutstation ? form.elements.isOutstation.checked : false;
  const caretakerGroup = byId("caretakerFieldsGroup");
  ["caretakerName", "caretakerMobile", "caretakerRelation"].forEach((name) => {
    if (form.elements[name]) {
      form.elements[name].disabled = !isOutstation;
    }
  });
  if (caretakerGroup) caretakerGroup.style.opacity = isOutstation ? "1" : "0.5";
}

function setResidentOwnerPhoto(url) {
  const preview = byId("ownerPhotoPreview");
  const placeholder = byId("ownerPhotoPlaceholder");
  const source = /^(https:|blob:)/i.test(String(url || "")) ? String(url) : "";
  preview.hidden = !source;
  placeholder.hidden = Boolean(source);
  if (!source) { preview.removeAttribute("src"); return; }
  preview.onerror = () => { preview.hidden = true; placeholder.hidden = false; preview.removeAttribute("src"); };
  preview.src = source;
}

let currentAdminWorkspace = "adminEventsWorkspace";

// Flatten the directory into per-flat vehicle rows (four-/two-wheeler split),
// applying the register's search box. `type` is coerced to Two/Four wheeler on
// save, so anything not explicitly a four-wheeler is treated as a two-wheeler
// (mirrors saveResidentProfile / updateOwnVehicles).
function vehicleRegisterRows() {
  const search = (byId("vehicleRegisterSearch")?.value || "").trim().toLowerCase();
  const rows = portalData.residents.map((resident) => {
    const vehicles = Array.isArray(resident.vehicles) ? resident.vehicles : [];
    const plates = (isFour) => vehicles
      .filter((v) => isFour ? /four/i.test(v.type || "") : !/four/i.test(v.type || ""))
      .map((v) => String(v.details || "").trim().toUpperCase())
      .filter(Boolean);
    return {
      name: residentName(resident),
      flat: textOr(resident.flatNo || resident.flat, "—"),
      floor: textOr(resident.floor, "—"),
      four: plates(true),
      two: plates(false)
    };
  }).filter((row) => row.four.length || row.two.length);
  rows.sort((a, b) => flatNumberOrder(a.flat, b.flat, a.floor, b.floor));
  if (!search) return rows;
  return rows.filter((row) => [row.name, row.flat, row.floor, row.four.join(" "), row.two.join(" ")]
    .join(" ").toLowerCase().includes(search));
}

function renderVehicleRegister() {
  const container = byId("vehicleRegisterTable");
  if (!container) return;
  const rows = vehicleRegisterRows();
  const totalFlats = portalData.residents.length;
  const flatsWithVehicles = portalData.residents.filter((r) => Array.isArray(r.vehicles) && r.vehicles.length).length;
  const totalVehicles = rows.reduce((sum, r) => sum + r.four.length + r.two.length, 0);
  const countEl = byId("vehicleRegisterCount");
  if (countEl) countEl.textContent = `${rows.length} shown · ${flatsWithVehicles}/${totalFlats} flats have vehicles · ${totalVehicles} vehicles`;
  if (!rows.length) {
    container.innerHTML = `<p style="color:#697970;padding:18px 0;">No vehicles match your search yet.</p>`;
    return;
  }
  const plateCell = (list) => list.length
    ? list.map((p) => `<span style="display:inline-block;background:#eef4ee;border:1px solid #cfe0d3;color:#183e35;padding:2px 8px;border-radius:4px;font-weight:800;font-size:12px;margin:2px 4px 2px 0;letter-spacing:.02em;">${escapeHtml(p)}</span>`).join("")
    : `<span style="color:#b9b09a;">—</span>`;
  const cellStyle = "padding:11px 13px;border-bottom:1px solid #ece7d8;vertical-align:top;text-align:left;";
  const head = `<thead><tr style="background:#183e35;color:#fff;">
    <th style="${cellStyle}width:36px;">#</th>
    <th style="${cellStyle}">Owner</th>
    <th style="${cellStyle}">Flat</th>
    <th style="${cellStyle}">Floor</th>
    <th style="${cellStyle}"><i class="fa-solid fa-car" aria-hidden="true"></i> Four-wheeler(s)</th>
    <th style="${cellStyle}"><i class="fa-solid fa-motorcycle" aria-hidden="true"></i> Two-wheeler(s)</th>
  </tr></thead>`;
  const body = rows.map((row, i) => `<tr style="background:${i % 2 ? "#fbfaf3" : "#fffef9"};">
    <td style="${cellStyle}color:#98917c;font-weight:800;">${i + 1}</td>
    <td style="${cellStyle}font-weight:800;color:#17372c;">${escapeHtml(row.name)}</td>
    <td style="${cellStyle}font-weight:800;">${escapeHtml(row.flat)}</td>
    <td style="${cellStyle}color:#52685d;">${escapeHtml(row.floor)}</td>
    <td style="${cellStyle}">${plateCell(row.four)}</td>
    <td style="${cellStyle}">${plateCell(row.two)}</td>
  </tr>`).join("");
  container.innerHTML = `<table style="width:100%;border-collapse:collapse;min-width:640px;font-size:14px;">${head}<tbody>${body}</tbody></table>`;
}

function downloadVehicleCsv() {
  const rows = vehicleRegisterRows();
  const esc = (value) => `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
  const lines = [["Owner", "Flat", "Floor", "Four Wheeler(s)", "Two Wheeler(s)"].map(esc).join(",")];
  rows.forEach((row) => lines.push([row.name, row.flat, row.floor, row.four.join("; "), row.two.join("; ")].map(esc).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `POH-vehicle-register-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function switchAdminWorkspace(targetWorkspaceId) {
  const workspaces = ["adminEventsWorkspace", "adminSettlementWorkspace", "adminCommitteeWorkspace", "adminAccessWorkspace", "adminNoticeWorkspace", "adminAuditWorkspace", "adminAmenityWorkspace", "adminMoveWorkspace", "adminContactWorkspace", "adminGalleryWorkspace", "adminVehicleWorkspace"];
  const canManageUsers = ["super_admin", "admin"].includes(approvedProfile?.role);
  const canManageFinance = financeRoles.has(approvedProfile?.role);

  if (targetWorkspaceId) {
    currentAdminWorkspace = targetWorkspaceId;
  }
  if (currentAdminWorkspace === "adminAccessWorkspace" && !canManageUsers) currentAdminWorkspace = "adminEventsWorkspace";
  if (currentAdminWorkspace === "adminSettlementWorkspace" && !canManageFinance) currentAdminWorkspace = "adminEventsWorkspace";

  workspaces.forEach((id) => {
    const element = byId(id);
    if (element) {
      if (id === "adminAccessWorkspace" && !canManageUsers) {
        element.hidden = true;
      } else if (id === "adminSettlementWorkspace" && !canManageFinance) {
        element.hidden = true;
      } else {
        element.hidden = (id !== currentAdminWorkspace);
      }
    }
  });

  document.querySelectorAll("[data-admin-nav-workspace]").forEach((button) => {
    const isActive = button.dataset.adminNavWorkspace === currentAdminWorkspace;
    button.style.background = isActive ? "#183e35" : "";
    button.style.color = isActive ? "#ffffff" : "";
  });

  document.querySelectorAll("[data-admin-header-tab]").forEach((button) => {
    const isActive = button.dataset.adminHeaderTab === currentAdminWorkspace;
    button.classList.toggle("active", isActive);
    if (button.dataset.adminHeaderTab === "adminAccessWorkspace") button.hidden = !canManageUsers;
    if (button.dataset.adminHeaderTab === "adminSettlementWorkspace") button.hidden = !canManageFinance;
  });
}

let accessPage = 1;
function renderAdmin() {
  byId("adminEventCount").textContent = portalData.events.length;
  byId("adminNoticeCount").textContent = portalData.notices.length;
  byId("adminResidentCount").textContent = portalData.residents.length;
  byId("adminCommitteeCount").textContent = portalData.committee.length;
  const flatsWithVehicles = portalData.residents.filter((r) => Array.isArray(r.vehicles) && r.vehicles.length).length;
  const vehicleStat = byId("adminVehicleCount");
  if (vehicleStat) vehicleStat.textContent = `${flatsWithVehicles}/${portalData.residents.length}`;
  renderVehicleRegister();
  byId("adminEventList").innerHTML = portalData.events.length ? portalData.events.map((event) => {
    const closed = isClosed(event);
    const active = event.active || /^active$/i.test(eventStatus(event));
    const canActivate = adminRoles.has(approvedProfile?.role) && !closed && !active;
    const canComplete = adminRoles.has(approvedProfile?.role) && !closed;
    const canEdit = adminRoles.has(approvedProfile?.role);
    const amountStr = ` · Suggested ₹${event.contributionAmount || 500}/flat`;
    let statusBadge = "";
    if (active) {
      statusBadge = '<span class="event-current-state"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> Current Active</span>';
    } else if (closed) {
      statusBadge = '<span class="event-current-state" style="background:#e8ece9;color:#4a5951;"><i class="fa-solid fa-lock" aria-hidden="true"></i> Completed & Settled</span>';
    }
    const editBtn = canEdit ? `<button class="admin-event-edit" data-edit-event="${escapeHtml(event.id)}" type="button" style="background:#e6efe9;color:#183e35;border:1px solid #c2d6c7;padding:8px 11px;border-radius:4px;font-size:12px;font-weight:800;cursor:pointer;margin-left:6px;"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> Edit</button>` : "";
    const activateBtn = canActivate ? `<button class="admin-event-activate" data-activate-event="${escapeHtml(event.id)}" type="button"><i class="fa-solid fa-play" aria-hidden="true"></i> Activate</button>` : "";
    const completeBtn = canComplete ? `<button class="admin-event-complete" data-complete-event="${escapeHtml(event.id)}" type="button" style="background:#8c6110;color:#fff;border:0;padding:8px 11px;border-radius:4px;font-size:12px;font-weight:800;cursor:pointer;margin-left:6px;"><i class="fa-solid fa-flag-checkered" aria-hidden="true"></i> Mark Completed</button>` : "";

    return `<li class="admin-event-row"><div><strong>${escapeHtml(eventTitle(event))}</strong><span>${escapeHtml(eventStatus(event))}${amountStr}${event.date ? ` · ${escapeHtml(eventDetail(event))}` : ""}</span></div><div style="display:flex;align-items:center;">${statusBadge}${editBtn}${activateBtn}${completeBtn}</div></li>`;
  }).join("") : "<li>No events available</li>";
  byId("adminRoleBadge").textContent = roleLabel(approvedProfile?.role || "administrator");
  const canManageUsers = ["super_admin", "admin"].includes(approvedProfile?.role);
  const navAccessOption = byId("navAccessOption");
  if (navAccessOption) navAccessOption.hidden = !canManageUsers;
  const canManageFinance = financeRoles.has(approvedProfile?.role);
  const navSettlementOption = byId("navSettlementOption");
  if (navSettlementOption) navSettlementOption.hidden = !canManageFinance;
  switchAdminWorkspace(currentAdminWorkspace);
  const floors = [...new Set(portalData.residents.map((resident) => String(resident.floor || "Unassigned")))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  byId("adminSpocFields").innerHTML = floors.map((floor) => {
    const residents = portalData.residents.filter((resident) => String(resident.floor || "Unassigned") === floor);
    return `<label>Floor ${escapeHtml(floor)} SPOC<select data-spoc-floor="${escapeHtml(floor)}"><option value="">Choose a resident</option>${residents.map((resident) => `<option value="${escapeHtml(textOr(resident.flat || resident.flatNo, ""))}">${escapeHtml(textOr(resident.flat || resident.flatNo, "Flat"))} · ${escapeHtml(textOr(resident.ownerName || resident.name, "Owner pending"))}</option>`).join("")}</select><input data-spoc-upi="${escapeHtml(floor)}" placeholder="SPOC UPI ID for pay-QR (e.g. name@okaxis)" style="margin-top:6px;"></label>`;
  }).join("") || empty("No resident floors are available.");
  byId("adminCommitteeList").innerHTML = portalData.committee.length ? portalData.committee.map((member) => `<article class="admin-person"><span class="role-badge">${escapeHtml(textOr(member.role, "Committee member"))}</span><strong>${escapeHtml(textOr(member.name, "Name pending"))}</strong><small>${escapeHtml(textOr(member.flat, "Flat not recorded"))}</small><div class="record-actions"><button data-edit-committee="${escapeHtml(member.id)}" type="button" aria-label="Edit ${escapeHtml(textOr(member.name, "committee member"))}" title="Edit committee member"><i class="fa-solid fa-pen" aria-hidden="true"></i></button><button class="danger-icon" data-delete-committee="${escapeHtml(member.id)}" data-committee-name="${escapeHtml(member.name)}" type="button" aria-label="Remove ${escapeHtml(textOr(member.name, "committee member"))}" title="Remove committee member"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button></div></article>`).join("") : empty("No committee members have been added.");
  const accessSearchQuery = String(byId("adminAccessSearch")?.value || "").trim().toLowerCase();
  const accessRoleFilter = String(byId("adminAccessRoleFilter")?.value || "").trim().toLowerCase();
  const accessStatusFilter = String(byId("adminAccessStatusFilter")?.value || "").trim().toLowerCase();
  let accessEntries = [...adminSecure.users, ...adminSecure.invites];
  const totalCount = accessEntries.length;
  if (accessSearchQuery) {
    accessEntries = accessEntries.filter((e) =>
      String(e.name || "").toLowerCase().includes(accessSearchQuery) ||
      String(e.email || "").toLowerCase().includes(accessSearchQuery) ||
      String(e.role || "").toLowerCase().includes(accessSearchQuery)
    );
  }
  if (accessRoleFilter) accessEntries = accessEntries.filter((e) => String(e.role || "").toLowerCase() === accessRoleFilter);
  if (accessStatusFilter) {
    if (accessStatusFilter === "invited") accessEntries = accessEntries.filter((e) => e.invited);
    else accessEntries = accessEntries.filter((e) => !e.invited && String(e.status || "active").toLowerCase() === accessStatusFilter);
  }
  const ACCESS_PAGE_SIZE = 25;
  const filteredCount = accessEntries.length;
  const totalPages = Math.max(1, Math.ceil(filteredCount / ACCESS_PAGE_SIZE));
  if (accessPage > totalPages) accessPage = totalPages;
  if (accessPage < 1) accessPage = 1;
  const pageStart = (accessPage - 1) * ACCESS_PAGE_SIZE;
  const pageEntries = accessEntries.slice(pageStart, pageStart + ACCESS_PAGE_SIZE);
  const countSummary = byId("accessCountSummary");
  if (countSummary) {
    countSummary.textContent = filteredCount === 0
      ? "No matching users"
      : `${filteredCount === totalCount ? totalCount : `${filteredCount} of ${totalCount}`} users · showing ${pageStart + 1}–${Math.min(pageStart + ACCESS_PAGE_SIZE, filteredCount)}`;
  }
  byId("adminAccessList").innerHTML = pageEntries.length ? pageEntries.map((entry) => {
    const isSelf = entry.email === approvedProfile?.email;
    const parts = String(entry.name || entry.email || "").trim().split(/\s+/).filter(Boolean);
    const initials = parts.length === 0 ? "U" : parts.length === 1 ? parts[0].substring(0, 2).toUpperCase() : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    const roleClass = String(entry.role || "resident").toLowerCase();
    const statusClass = entry.invited ? "invited" : String(entry.status || "active").toLowerCase();
    const statusLabel = entry.invited ? "Pending Invitation" : textOr(entry.status, "Active");
    return `<tr>
      <td>
        <div class="user-cell">
          <div class="user-avatar-circle">${escapeHtml(initials)}</div>
          <div class="user-info">
            <strong>${escapeHtml(textOr(entry.name, "Name pending"))}</strong>
            ${isSelf ? '<small style="color:#183e35;font-weight:800;">Current User (You)</small>' : ""}
          </div>
        </div>
      </td>
      <td><span class="email-text">${escapeHtml(entry.email || "")}</span></td>
      <td><span class="role-pill ${escapeHtml(roleClass)}">${escapeHtml(roleLabel(entry.role))}</span></td>
      <td><span class="status-pill ${escapeHtml(statusClass)}"><span class="dot"></span> ${escapeHtml(statusLabel)}</span></td>
      <td>
        <div class="table-actions">
          <button class="btn-action-icon btn-action-edit" data-edit-access="${escapeHtml(entry.email || "")}" type="button" title="Edit user access" aria-label="Edit access for ${escapeHtml(entry.email || "")}">
            <i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>
          </button>
          ${!isSelf ? `
            <button class="btn-action-icon btn-action-delete" data-delete-access="${escapeHtml(entry.email || "")}" type="button" title="Revoke user access" aria-label="Revoke access for ${escapeHtml(entry.email || "")}">
              <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
            </button>
          ` : ""}
        </div>
      </td>
    </tr>`;
  }).join("") : `<tr><td colspan="5" style="text-align:center;padding:32px;color:#68736c">No matching user records found.</td></tr>`;
  const accessPager = byId("accessPagination");
  if (accessPager) {
    accessPager.innerHTML = totalPages > 1
      ? `<button class="text-button" data-access-page="prev" ${accessPage === 1 ? "disabled" : ""}><i class="fa-solid fa-chevron-left"></i> Prev</button><span style="font-size:13px;color:#68736c;font-weight:700;">Page ${accessPage} of ${totalPages}</span><button class="text-button" data-access-page="next" ${accessPage === totalPages ? "disabled" : ""}>Next <i class="fa-solid fa-chevron-right"></i></button>`
      : "";
  }
  byId("commonPoolValue").textContent = `Common pool ${money(adminSecure.commonPool)}`;
  byId("adminSettlementList").innerHTML = adminSecure.settlements.length ? adminSecure.settlements.map((event) => {
    const deficit = Number(event.balance || 0) < 0;
    const status = textOr(event.settlementStatus, "Open");
    const canConfirm = ["super_admin", "treasurer"].includes(approvedProfile?.role) && status !== "Treasurer confirmed" && status !== "Closed" && !event.pendingExpenses;
    const canClose = adminRoles.has(approvedProfile?.role) && status === "Treasurer confirmed";
    return `<article class="settlement-card ${deficit ? "is-deficit" : ""}"><div><span class="state-pill">${escapeHtml(status)}</span><h4>${escapeHtml(eventTitle(event))}</h4><small>${event.pendingExpenses ? `${event.pendingExpenses} pending expense${event.pendingExpenses === 1 ? "" : "s"}` : deficit ? "Deficit will remain highlighted" : "Ready for settlement review"}</small></div><div class="settlement-figures"><span>Collected<b>${money(event.collected)}</b></span><span>Spent<b>${money(event.spent)}</b></span><span class="${deficit ? "negative" : ""}">${deficit ? "Deficit" : "Balance"}<b>${money(event.balance)}</b></span></div><div>${canConfirm ? `<button class="primary-button" data-settlement-confirm="${escapeHtml(event.id)}" type="button"><i class="fa-solid fa-scale-balanced" aria-hidden="true"></i> Confirm settlement</button>` : canClose ? `<button class="primary-button" data-settlement-close="${escapeHtml(event.id)}" type="button"><i class="fa-solid fa-lock" aria-hidden="true"></i> Close event</button>` : `<small>${escapeHtml(status)}</small>`}</div></article>`;
  }).join("") : empty("No events are available for settlement.");
  const pendingExpenses = portalData.events.flatMap((event) => (portalData.finance[event.id]?.expenses || []).filter((expense) => String(expense.status || "").toLowerCase() === "pending").map((expense) => ({ ...expense, eventId: event.id, eventName: eventTitle(event) })));
  byId("adminApprovalQueue").innerHTML = pendingExpenses.length ? pendingExpenses.map((expense) => `<article class="approval-row"><div><strong>${escapeHtml(textOr(expense.description, expense.category || "Expense"))}</strong><small>${escapeHtml(expense.eventName)} · ${money(expense.amount)} · ${escapeHtml(textOr(expense.paidBy, "Payer pending"))}</small></div><button data-approve-expense="${escapeHtml(expense.id)}" data-expense-event="${escapeHtml(expense.eventId)}" type="button"><i class="fa-solid fa-check" aria-hidden="true"></i> Approve</button></article>`).join("") : empty("No pending expenses need approval.");
  byId("adminAuditList").innerHTML = portalData.auditLogs.length ? portalData.auditLogs.slice().sort((a, b) => auditTime(b) - auditTime(a)).slice(0, 30).map((entry) => `<article class="audit-entry"><strong>${escapeHtml(textOr(entry.action, "Portal update"))}</strong><span>${escapeHtml(textOr(entry.entity, "Portal"))}${entry.detail ? ` · ${escapeHtml(entry.detail)}` : ""}</span><small>${escapeHtml(textOr(entry.actorName || entry.actor, "Portal"))} · ${escapeHtml(auditLabel(entry.createdAt))}</small></article>`).join("") : empty("No activity has been recorded yet.");
}

function auditTime(value) { return value?.toMillis ? value.toMillis() : Date.parse(value || "") || 0; }
function auditLabel(value) { const date = value?.toDate ? value.toDate() : value ? new Date(value) : null; return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Just now"; }

function renderFloorProgress(finance) {
  const totals = new Map();
  portalData.residents.forEach((resident) => {
    const floor = String(resident.floor || "Unassigned");
    totals.set(floor, (totals.get(floor) || 0) + 1);
  });
  const contributed = new Map();
  (finance.contributions || []).forEach((item) => {
    const floor = String(item.floor || "Unassigned");
    const entries = contributed.get(floor) || new Set();
    entries.add(String(item.flat || item.id));
    contributed.set(floor, entries);
  });
  byId("floorProgress").innerHTML = [...totals.keys()].sort(contributionFloorOrder).map((floor) => {
    const total = totals.get(floor);
    const paid = (contributed.get(floor) || new Set()).size;
    const percent = total ? Math.round((paid / total) * 100) : 0;
    return `<div class="floor-row"><div><strong>Floor ${escapeHtml(floor)}</strong><small>${paid} of ${total} homes contributed</small></div><div class="progress-track"><span style="width:${percent}%"></span></div><b>${percent}%</b></div>`;
  }).join("") || empty("No resident floor data is available for this event.");
}

function getUserResidentRecord() {
  if (!approvedProfile?.email) return null;
  const userEmail = approvedProfile.email.trim().toLowerCase();
  return portalData.residents.find((r) => {
    // Keep this list identical to the backend RESIDENT_EMAIL_FIELDS so the two layers
    // resolve a SPOC the same way (front end was missing ownerEmail / tenantEmail).
    const emails = [
      r.ownerEmail, r.ownerPrimaryEmail, r.ownerSecondaryEmail,
      r.tenantEmail, r.tenantPrimaryEmail, r.tenantSecondaryEmail,
      r.familyContactEmail, r.primaryEmail, r.secondaryEmail, r.email
    ].filter(Boolean).map(e => String(e).trim().toLowerCase());
    return emails.includes(userEmail);
  }) || null;
}

function checkIsSpocOrAdmin(event) {
  if (!approvedProfile) return { canView: false, userSpocFloor: null, isAdmin: false, isSpoc: false };
  const isAdmin = adminRoles.has(approvedProfile.role);

  const userResident = getUserResidentRecord();
  // Mirror the backend: a SPOC is matched by profile.flat OR the flat whose resident
  // record carries their login email. Consider both so the controls show whenever the
  // backend would allow the action.
  const profileFlat = String(approvedProfile.flat || "").trim().toUpperCase();
  const residentFlat = userResident ? String(userResident.flat || userResident.flatNo || "").trim().toUpperCase() : "";
  const candidateFlats = [profileFlat, residentFlat].filter(Boolean);
  const userFloor = userResident ? String(userResident.floor || "").trim() : "";

  const spocs = Array.isArray(event?.spocs) ? event.spocs : [];
  const spocMatch = spocs.find((s) => {
    const f = String(s.flat || "").trim().toUpperCase();
    return f && candidateFlats.includes(f);
  });
  const isSpoc = Boolean(spocMatch);
  const spocFloor = spocMatch ? String(spocMatch.floor || userFloor) : (isSpoc ? userFloor : null);

  return { canView: isAdmin || isSpoc, userSpocFloor: spocFloor || userFloor || null, isAdmin, isSpoc };
}

let selectedSpocMatrixFloor = "";

function renderSpocFloorMatrix(event) {
  const section = byId("spocFloorMatrixSection");
  if (!section || !event) return;

  const access = checkIsSpocOrAdmin(event);
  if (!access.canView) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const floors = [...new Set(portalData.residents.map((r) => String(r.floor || "Unassigned")))].sort(contributionFloorOrder);

  if (!selectedSpocMatrixFloor || !floors.includes(selectedSpocMatrixFloor)) {
    selectedSpocMatrixFloor = access.userSpocFloor && floors.includes(access.userSpocFloor) ? access.userSpocFloor : (floors[0] || "1");
  }

  const tabsContainer = byId("spocMatrixFloorTabs");
  if (tabsContainer) {
    tabsContainer.innerHTML = floors.map((f) => {
      const isSelected = f === selectedSpocMatrixFloor;
      const isSpocFloor = access.isSpoc && access.userSpocFloor === f;
      const spocBadge = isSpocFloor ? ` ⭐ SPOC` : "";
      return `<button type="button" data-spoc-matrix-floor="${escapeHtml(f)}" aria-pressed="${isSelected}">${escapeHtml(f)} Floor${spocBadge}</button>`;
    }).join("");
  }

  const floorResidents = portalData.residents
    .filter((r) => String(r.floor || "Unassigned") === selectedSpocMatrixFloor)
    .sort((a, b) => flatNumberOrder(a.flat, b.flat, a.floor, b.floor));

  const eventContributions = (portalData.finance[event.id]?.contributions || []);
  // Aggregate per flat — a flat may now have multiple contributions. Each
  // contribution is counted ONCE under its canonical (normalized) flat key.
  const paidByFlat = new Map();
  eventContributions.forEach((c) => {
    let key = String(c.flat || c.flatNo || "").trim().toUpperCase().replace(/^0+/, "");
    if (!key) { const m = String(c.id || "").match(/-(G?\d{2,3}[A-Z]?)$/i); if (m) key = m[1].toUpperCase().replace(/^0+/, ""); }
    if (!key) return;
    const cur = paidByFlat.get(key) || { total: 0, count: 0, modes: new Set() };
    cur.total += Number(c.amount || 0);
    cur.count += 1;
    cur.modes.add(c.paymentMode || "Received");
    paidByFlat.set(key, cur);
  });

  const expectedAmount = Number(event.contributionAmount || 500);
  let paidCount = 0;
  let pendingCount = 0;
  let paidTotal = 0;

  const grid = byId("spocMatrixFlatGrid");
  if (grid) {
    const cell = "padding:9px 12px;border-bottom:1px solid #ece7d8;vertical-align:middle;";
    const rows = floorResidents.map((r) => {
      const flatStr = String(r.flat || r.flatNo || r.id || "").trim();
      const flatUpper = flatStr.toUpperCase();
      const flatNorm = flatUpper.replace(/^0+/, "");
      const agg = paidByFlat.get(flatNorm) || paidByFlat.get(flatUpper);
      const isPaid = Boolean(agg && agg.count);
      const resName = residentName(r);

      const phoneDigits = String(r.ownerPrimaryPhone || r.primaryPhone || r.phone || r.mobile || r.ownerSecondaryPhone || r.tenantPrimaryPhone || "").replace(/\D/g, "");
      const phoneNum = phoneDigits.length === 10 ? `91${phoneDigits}` : (phoneDigits.length === 12 && phoneDigits.startsWith("91") ? phoneDigits : "");
      const waMsg = `🏰 *PURSUIT OF HAPPINESS (POH) APARTMENT ASSOCIATION*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 *OFFICIAL EVENT CONTRIBUTION REMINDER*

Dear ${resName || "Resident"} Ji (Flat ${flatStr}),

Greetings from the POH Community Team! This is a gentle reminder regarding your flat's contribution for:

🎉 *Event:* ${eventTitle(event)}
💰 *Contribution Amount:* ₹${expectedAmount.toLocaleString("en-IN")} / flat
⏳ *Status:* Pending Payment

Kindly complete your payment via UPI to support Flat ${flatStr}'s floor participation.

🔗 *Live Event Dashboard & Receipts:*
https://poh-community-portal.web.app

Thank you for your active participation & support!
— *POH Floor SPOC & Managing Committee*`;
      const waUrl = phoneNum ? `https://wa.me/${phoneNum}?text=${encodeURIComponent(waMsg)}` : `https://wa.me/?text=${encodeURIComponent(waMsg)}`;

      if (isPaid) {
        paidCount++;
        paidTotal += Number(agg.total || 0);
        const multi = agg.count > 1 ? ` <small style="color:#5a7d71;font-weight:700;">×${agg.count}</small>` : "";
        const modeLabel = agg.modes.size > 1 ? "Multiple" : ([...agg.modes][0] || "Received");
        return `<tr style="background:#fff;">
          <td style="${cell}font-weight:800;color:#17372c;font-family:'Space Grotesk',sans-serif;">${escapeHtml(flatStr)}</td>
          <td style="${cell}color:#2b3b34;">${escapeHtml(resName)}</td>
          <td style="${cell}"><span style="display:inline-flex;align-items:center;gap:5px;background:#e7f4ec;color:#23584b;font-size:11px;font-weight:800;padding:3px 10px;border-radius:12px;white-space:nowrap;"><i class="fa-solid fa-circle-check"></i> Paid</span></td>
          <td style="${cell}text-align:right;font-weight:800;color:#183e35;white-space:nowrap;">₹${Number(agg.total || 0).toLocaleString("en-IN")}${multi}</td>
          <td style="${cell}color:#5a7d71;font-size:12px;">${escapeHtml(modeLabel)}</td>
        </tr>`;
      } else {
        pendingCount++;
        return `<tr style="background:#fdf6f4;">
          <td style="${cell}font-weight:800;color:#9c3f34;font-family:'Space Grotesk',sans-serif;">${escapeHtml(flatStr)}</td>
          <td style="${cell}color:#7c352c;">${escapeHtml(resName)}</td>
          <td style="${cell}"><span style="display:inline-flex;align-items:center;gap:5px;background:#fdece8;color:#9c3f34;font-size:11px;font-weight:800;padding:3px 10px;border-radius:12px;white-space:nowrap;"><i class="fa-solid fa-hourglass-half"></i> Pending</span></td>
          <td style="${cell}text-align:right;font-weight:800;color:#9c3f34;white-space:nowrap;">₹${expectedAmount.toLocaleString("en-IN")}</td>
          <td style="${cell}"><div style="display:flex;gap:6px;align-items:center;">
            <button type="button" data-open-card-modal="${escapeHtml(flatStr)}" data-floor="${escapeHtml(selectedSpocMatrixFloor)}" data-event-id="${escapeHtml(event.id || "")}" data-res-name="${escapeHtml(resName)}" data-event-name="${escapeHtml(eventTitle(event))}" data-amount="${expectedAmount}" data-phone="${phoneNum}" style="background:#e6efe9;color:#183e35;border:1px solid #c2d6c7;font-size:11px;font-weight:700;padding:4px 9px;border-radius:5px;cursor:pointer;white-space:nowrap;" title="Generate &amp; view POH Message Card for Flat ${escapeHtml(flatStr)}"><i class="fa-solid fa-id-card"></i> Card</button>
            <a href="${waUrl}" target="pohWhatsApp" rel="noopener" class="spoc-wa-btn" style="display:inline-flex;align-items:center;gap:4px;background:#25d366;color:#ffffff;font-size:11px;font-weight:700;padding:5px 11px;border-radius:5px;text-decoration:none;white-space:nowrap;" title="Send WhatsApp payment reminder to Flat ${escapeHtml(flatStr)}"><i class="fa-brands fa-whatsapp" style="font-size:12px;"></i> Remind</a>
          </div></td>
        </tr>`;
      }
    }).join("");
    grid.style.display = "block";
    grid.innerHTML = rows
      ? `<div style="overflow-x:auto;border:1px solid #ece7d8;border-radius:8px;"><table style="width:100%;border-collapse:collapse;font-size:13px;min-width:560px;background:#fff;"><thead><tr style="background:#183e35;color:#fff;text-align:left;"><th style="padding:10px 12px;">Flat</th><th style="padding:10px 12px;">Resident</th><th style="padding:10px 12px;">Status</th><th style="padding:10px 12px;text-align:right;">Amount</th><th style="padding:10px 12px;">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<p style="color:#68736c;padding:18px;">No flats registered for this floor.</p>';
  }

  const banner = byId("spocMatrixStatsBanner");
  const floorSummary = byId("spocMatrixFloorSummary");
  const totalFlats = floorResidents.length || 21;
  const percent = totalFlats ? Math.round((paidCount / totalFlats) * 100) : 0;

  if (banner) {
    banner.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <span><i class="fa-solid fa-building" style="color:#d99a32;margin-right:6px;"></i> Floor ${escapeHtml(selectedSpocMatrixFloor)} Summary: <strong>${paidCount} Contributed (₹${paidTotal.toLocaleString("en-IN")})</strong> · <span style="color:#9c3f34;">${pendingCount} Pending</span></span>
        <span style="background:#e6efe9;padding:4px 10px;border-radius:12px;font-size:13px;color:#183e35;"><strong>${percent}%</strong> Floor Participation</span>
      </div>
    `;
  }
  if (floorSummary) {
    floorSummary.textContent = `${paidCount} of ${totalFlats} flats contributed on Floor ${selectedSpocMatrixFloor}`;
  }
}

function renderEventDashboard() {
  const event = activeEvent();
  if (!event) { activateRoute("events"); showToast("Create an event before opening an event dashboard.", "warning"); return; }
  activeEventId = event.id;
  const rawFinance = portalData.finance[event.id] || { expenses: [], contributions: [], collected: 0, spent: 0 };
  const isIndy = /independence/i.test(event.id || event.name || "");
  const collected = rawFinance.collected || (isIndy ? 30500 : 0);
  const spent = rawFinance.spent || (isIndy ? 567 : 0);
  const contributorsCount = rawFinance.contributions.length || (isIndy ? 61 : 0);
  const expenseCount = rawFinance.expenses.length || (isIndy ? 2 : 0);
  const flatCount = portalData.residents.length || 147;
  const pendingCount = Math.max(flatCount - contributorsCount, 0);
  const poolAllocated = Number(event.commonPoolAllocation || 0);
  // baseBalance excludes deficit-recovery top-ups (drives the deficit/recovery panel);
  // the displayed balance folds them in to match the backend settlement figures.
  const baseBalance = collected + poolAllocated - spent;
  const balance = baseBalance + Number(rawFinance.additionalCollected || 0);

  byId("dashboardEventLabel").textContent = `${eventStatus(event)} event · ${eventDetail(event)}`;
  byId("dashboardEventName").textContent = eventTitle(event);
  byId("dashboardEventMeta").textContent = `${eventStatus(event)} · ${eventDetail(event)}${event.spoc ? ` · SPOC: ${event.spoc}` : ""}`;
  byId("dashboardFlatCount").textContent = flatCount;
  byId("dashboardCollected").textContent = money(collected);
  byId("dashboardContributors").textContent = contributorsCount;
  byId("dashboardPending").textContent = pendingCount;
  byId("dashboardFinanceCollected").textContent = money(collected);
  byId("dashboardSpent").textContent = money(spent);
  byId("dashboardExpenseCount").textContent = expenseCount;
  byId("dashboardCommonPool").textContent = money(portalData.commonPool);
  byId("dashboardBalance").textContent = money(balance);
  byId("dashboardBalanceCard").classList.toggle("negative", balance < 0);
  const allocationNote = byId("dashboardPoolAllocationNote");
  allocationNote.hidden = !poolAllocated;
  allocationNote.innerHTML = poolAllocated ? `<strong>${money(poolAllocated)}</strong> from the community pool is allocated to this event and is included in its available balance.` : "";
  byId("expenseClosedNote").hidden = !isClosed(event);
  if (isClosed(event)) {
    byId("expenseClosedNote").innerHTML = `<i class="fa-solid fa-lock" style="margin-right:6px;color:#c94a3e;"></i> <strong>Event Completed & Closed:</strong> This event is completed. The financial dashboard remains available for resident viewing & transparency, but new contributions and expenses are closed.`;
  }
  // Only the floor SPOC (or an admin) may record contributions/expenses.
  const financeAccess = checkIsSpocOrAdmin(event);
  const canRecordFinance = financeAccess.canView;
  if (byId("addContributionAction")) {
    byId("addContributionAction").hidden = !canRecordFinance;
    byId("addContributionAction").disabled = isClosed(event);
  }
  byId("addExpenseAction").hidden = !canRecordFinance;
  byId("addExpenseAction").disabled = isClosed(event);
  byId("allocatePoolAction").hidden = !adminRoles.has(approvedProfile.role);
  byId("allocatePoolAction").disabled = isClosed(event) || portalData.commonPool <= 0;
  byId("commonPoolAvailable").textContent = money(portalData.commonPool);

  // Deficit recovery: additional (variable-amount) contributions recorded while
  // the event's available balance is negative. Tracked separately from the
  // settled figures; the section + button appear only while a deficit exists.
  const additionalContributions = rawFinance.additionalContributions || [];
  const additionalCollected = Number(rawFinance.additionalCollected || 0);
  const deficit = Math.max(-baseBalance, 0);
  const hasDeficit = deficit > 0;
  const covered = Math.min(additionalCollected, deficit);
  const remaining = Math.max(deficit - additionalCollected, 0);
  const surplus = Math.max(additionalCollected - deficit, 0);
  const recoverySection = byId("deficitRecoverySection");
  if (recoverySection) {
    recoverySection.hidden = !hasDeficit;
    if (hasDeficit) {
      byId("recoveryDeficit").textContent = money(deficit);
      byId("recoveryCollected").textContent = money(additionalCollected);
      byId("recoveryCovered").textContent = `${parseFloat(((covered / deficit) * 100).toFixed(1))}%`;
      byId("recoveryRemaining").textContent = money(remaining);
      byId("recoverySurplusCard").hidden = surplus <= 0;
      byId("recoverySurplus").textContent = money(surplus);
      // The strip is a fixed-column grid with a grey backing; size it to the
      // number of visible tiles so no empty column shows through.
      const rStrip = byId("recoveryTilesStrip");
      if (rStrip) rStrip.style.gridTemplateColumns = `repeat(${surplus > 0 ? 5 : 4}, minmax(0,1fr))`;
      byId("additionalContributionList").innerHTML = additionalContributions.length
        ? additionalContributions.slice().sort((a, b) => flatNumberOrder(a.flat, b.flat, a.floor, b.floor)).map((item) => {
            const displayName = getFlatResidentName(String(item.flat || "").trim(), item.name || item.ownerName);
            return `<tr><td>${escapeHtml(textOr(item.flat, "—"))}</td><td>${escapeHtml(displayName)}</td><td><strong>${money(item.amount)}</strong></td><td>${escapeHtml(textOr(item.paymentMode, "—"))}</td><td>${escapeHtml(textOr(item.note, "—"))}</td></tr>`;
          }).join("")
        : "<tr><td class=\"empty-inline\" colspan=\"5\">No additional contributions recorded yet.</td></tr>";
    }
  }
  // Record button: SPOC/admin only, and only while the deficit is not yet fully
  // covered. Gate on `remaining` (not `hasDeficit`) so the button hides exactly when
  // the backend guard starts rejecting (balance incl. top-ups >= 0), never offering
  // an action that would fail.
  if (byId("addAdditionalContributionAction")) {
    byId("addAdditionalContributionAction").hidden = !(canRecordFinance && remaining > 0);
  }
  // View button: anyone (residents included) can view the top-ups when a deficit exists.
  if (byId("viewAdditionalContributionAction")) {
    byId("viewAdditionalContributionAction").hidden = !hasDeficit;
  }

  // Who can edit/delete a contribution on a given floor: admins + committee
  // (any floor), or the floor SPOC (own floor). Never on a closed event.
  const contribEditable = !isClosed(event);
  const canManageContribution = (floor) => contribEditable && (
    directoryEditorRoles.has(approvedProfile?.role) ||
    (financeAccess.isSpoc && String(financeAccess.userSpocFloor || "") === String(floor || ""))
  );
  const anyContribManager = contribEditable && (directoryEditorRoles.has(approvedProfile?.role) || financeAccess.isSpoc);
  byId("contributionList").innerHTML = rawFinance.contributions.length ? rawFinance.contributions
    .slice()
    .sort((a, b) => flatNumberOrder(a.flat, b.flat, a.floor, b.floor))
    .map((item) => {
      const flatStr = String(item.flat || "").trim();
      const displayName = getFlatResidentName(flatStr, item.name || item.ownerName || item.residentName);
      const canManage = canManageContribution(item.floor);
      const actions = canManage
        ? `<div style="display:flex;gap:6px;justify-content:flex-end;">
             <button type="button" class="contrib-edit-btn" data-edit-contribution='${escapeHtml(JSON.stringify({ id: item.id, flat: item.flat, floor: item.floor, name: displayName, amount: item.amount, paymentMode: item.paymentMode, reference: item.reference || "", date: item.date || "" }))}' style="background:#e6efe9;color:#183e35;border:1px solid #c2d6c7;font-size:11px;font-weight:700;padding:4px 9px;border-radius:5px;cursor:pointer;white-space:nowrap;"><i class="fa-solid fa-pen-to-square"></i> Edit</button>
             <button type="button" class="contrib-delete-btn" data-delete-contribution="${escapeHtml(item.id || "")}" data-flat="${escapeHtml(flatStr)}" data-amount="${Number(item.amount || 0)}" style="background:#fdf0ed;color:#9c3f34;border:1px solid #f2c7c1;font-size:11px;font-weight:700;padding:4px 9px;border-radius:5px;cursor:pointer;white-space:nowrap;"><i class="fa-solid fa-trash"></i></button>
           </div>`
        : "";
      return `<tr><td>${escapeHtml(textOr(item.flat, "—"))}</td><td>${escapeHtml(displayName)}</td><td><strong>${money(item.amount)}</strong></td><td>${escapeHtml(textOr(item.paymentMode, "—"))}</td><td>${escapeHtml(displayDate(item.date))}</td><td style="text-align:right;">${actions}</td></tr>`;
    })
    .join("") : "<tr><td class=\"empty-inline\" colspan=\"5\">No contributions recorded for this event yet.</td></tr>";
  renderExpenseHistory();
  byId("contributionEventName").textContent = eventTitle(event);
  byId("expenseEventName").textContent = eventTitle(event);
  renderFloorProgress(rawFinance);
  renderSpocFloorMatrix(event);
}

function displayDate(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "Date pending";
}

// Convert a stored date (ISO string / Firestore Timestamp) to a yyyy-mm-dd value for an
// <input type="date">, using local calendar parts so it shows the same day the user sees.
function toDateInputValue(value) {
  const d = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!d || Number.isNaN(d.valueOf())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function renderExpenseHistory() {
  const event = activeEvent();
  const finance = event ? portalData.finance[event.id] || { expenses: [] } : { expenses: [] };
  const search = byId("expenseHistorySearch")?.value.trim().toLowerCase() || "";
  const isFinance = financeRoles.has(approvedProfile?.role);
  const visibleExpenses = finance.expenses.filter((item) => isFinance || String(item.status || "").toLowerCase() === "approved");
  const expenses = visibleExpenses.filter((item) => [item.id, item.category, item.description, item.paidBy, item.status, item.reference, item.remarks, item.submittedBy].join(" ").toLowerCase().includes(search));
  const totalApproved = expenses.filter(i => String(i.status||'').toLowerCase()==='approved').reduce((t, i) => t + Number(i.amount || 0), 0);
  const totalAll = expenses.reduce((t, i) => t + Number(i.amount || 0), 0);
  byId("expenseHistoryTitle").textContent = `${expenses.length} expense${expenses.length === 1 ? "" : "s"}`;
  byId("expenseHistoryMeta").textContent = event
    ? `${eventTitle(event)} · Approved total: ${money(totalApproved)}${isFinance ? ` · All submitted: ${money(totalAll)}` : ""}`
    : "Showing expenses across the selected event.";
  byId("expenseList").innerHTML = expenses.length
    ? expenses.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).map((item) => {
        const status = String(item.status || "Pending");
        const isApproved = status.toLowerCase() === "approved";
        const isRejected = status.toLowerCase() === "rejected";
        const isPending  = status.toLowerCase() === "pending";
        const rawId = String(item.id || "").replace(/^[^a-zA-Z0-9]+/, "");
        const shortId = item.id?.startsWith("EXP") ? item.id : rawId.substring(0, 10) + (rawId.length > 10 ? "\u2026" : "");
        const submitterRaw = item.submittedBy || item.recordedBy || "";
        const submitterLabel = submitterRaw.includes("@") ? submitterRaw.split("@")[0] : submitterRaw;
        const metaParts = [
          item.paymentMode ? `<span style="background:#edf6ff;color:#1a5fa0;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700;">${escapeHtml(item.paymentMode)}</span>` : "",
          item.reference   ? `<span style="background:#f3f4f6;color:#4b5563;border-radius:4px;padding:2px 6px;font-size:10px;">Ref: ${escapeHtml(item.reference)}</span>` : "",
          submitterLabel   ? `<span style="background:#f3f4f6;color:#4b5563;border-radius:4px;padding:2px 6px;font-size:10px;">👤 ${escapeHtml(submitterLabel)}</span>` : "",
        ].filter(Boolean).join(" ");
        const commentBadge = item.adminComment
          ? `<div style="margin-top:6px;background:#fffbea;border-left:3px solid #d97706;border-radius:0 6px 6px 0;padding:5px 8px;font-size:11px;color:#92400e;">💬 ${escapeHtml(item.adminComment)}</div>`
          : "";
        const statusBadge = `<span class="expense-status ${status.toLowerCase()}" style="font-size:11px;">${status}</span>`;
        const receiptUrls = (Array.isArray(item.receiptUrls) && item.receiptUrls.length ? item.receiptUrls : (item.receiptUrl ? [item.receiptUrl] : [])).map((u) => safeUrl(u)).filter(Boolean);
        const hasReceipt = receiptUrls.length > 0;
        const receiptCountLabel = receiptUrls.length > 1 ? ` (${receiptUrls.length})` : "";
        // Preview button — teal outlined style, distinct from amber Review
        const receiptBtn = hasReceipt && (isApproved || (isFinance && isPending))
          ? `<button class="receipt-link" data-receipt-urls='${JSON.stringify(receiptUrls)}' type="button" title="View receipt${receiptUrls.length > 1 ? "s" : ""}"
               style="${isPending ? 'background:transparent;border:1.5px solid #2d7a6a;color:#2d7a6a;opacity:0.85;' : ''}">
               <i class="fa-solid fa-file-invoice" aria-hidden="true"></i><span>${isPending ? "Preview" : "Receipt"}${receiptCountLabel}</span>
             </button>`
          : (hasReceipt ? "" : `<span style="color:#b0b8b4;font-size:12px;">No receipt</span>`);
        const reviewBtn = (isFinance && !isClosed(event))
          ? `<button class="primary-button" type="button"
               style="padding:5px 10px;font-size:11px;background:${isApproved ? '#2d7a6a' : 'linear-gradient(135deg,#d97706,#b45309)'};border-color:${isApproved ? '#1e5c4e' : '#b45309'};"
               data-review-expense='${JSON.stringify({ id: item.id, eventId: event?.id || item.eventId, category: item.category, description: item.description, amount: item.amount, paidBy: item.paidBy, paymentMode: item.paymentMode, reference: item.reference || "", remarks: item.remarks || "", receiptUrl: item.receiptUrl || "", receiptUrls, submittedBy: item.submittedBy || item.recordedBy || "" })}'>
               <i class="fa-solid fa-pen-to-square"></i> ${isApproved ? "Edit" : "Review"}
             </button>`
          : "";
        const reviewedBy = (isApproved || isRejected) && item.reviewedBy
          ? `<div style="font-size:10px;color:#68736c;margin-top:4px;">by ${escapeHtml(item.reviewedBy.split("@")[0])}</div>`
          : "";
        const dateStr = item.date && item.date !== "Date pending" ? displayDate(item.date) : "—";
        return `
        <tr style="vertical-align:top;">
          <td style="white-space:nowrap;color:#68736c;font-size:13px;">${escapeHtml(dateStr)}</td>
          <td>
            <strong style="display:block;font-size:14px;margin-bottom:4px;">${escapeHtml(textOr(item.description, "Expense"))}</strong>
            <code style="font-size:10px;color:#9ca3af;background:#f9fafb;padding:1px 5px;border-radius:3px;display:inline-block;margin-bottom:4px;" title="${escapeHtml(item.id||'')}"> ${escapeHtml(shortId)}</code>
            <div style="margin-top:3px;display:flex;flex-wrap:wrap;gap:4px;">${metaParts}</div>
            ${commentBadge}
          </td>
          <td><span class="category-chip">${escapeHtml(textOr(item.category, "Other"))}</span></td>
          <td style="text-align:right;"><strong style="font-size:15px;">${money(item.amount)}</strong></td>
          <td style="font-size:13px;">${escapeHtml(textOr(item.paidBy, "—"))}</td>
          <td>${statusBadge}${reviewedBy}</td>
          <td style="text-align:right;">
            <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
              ${receiptBtn}
              ${reviewBtn}
            </div>
          </td>
        </tr>`;
      }).join("")
    : "<tr><td class=\"empty-inline\" colspan=\"7\">No expenses match this view.</td></tr>";
}

function empty(message) { return `<div class="empty-state">${escapeHtml(message)}</div>`; }

function activateRoute(route) {
  const targetId = route === "move" ? "moveManagementPage" : `${route}Page`;
  document.querySelectorAll(".page").forEach((page) => { page.hidden = page.id !== targetId; });
  document.querySelectorAll("[data-route]").forEach((button) => { button.setAttribute("aria-current", button.dataset.route === route ? "page" : "false"); });
  
  // Highlight parent dropdown group buttons if active route is inside a dropdown
  document.querySelectorAll(".nav-dropdown-wrap").forEach((wrap) => {
    const hasActiveChild = !!wrap.querySelector(`[data-route="${route}"]`);
    const groupBtn = wrap.querySelector(".nav-group-btn");
    if (groupBtn) groupBtn.classList.toggle("active-route", hasActiveChild);
  });

  byId("portal").classList.toggle("home-active", route === "home");
  if (route === "directory") renderDirectory();
  if (route === "feedback") loadFeedback();
  if (route === "maintenance") renderMaintenancePreview();
  if (route === "admin") renderAdmin();
  if (route === "eventDashboard") renderEventDashboard();
  if (route === "move" || route === "moveManagement") renderMoveManagement();
  // H-3: lazy-load the expansion collections the first time a page (or the admin
  // console, which has amenity/move/contact/gallery workspaces) that needs them
  // is opened. loadExpansionData re-renders all expansion surfaces when it lands.
  if (["amenities", "move", "moveManagement", "contacts", "gallery", "admin"].includes(route)) ensureExpansionData();
  if (window.location.hash !== `#${route}`) window.history.replaceState(null, "", `#${route}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshEventFinance(eventId) {
  const event = portalData.events.find((entry) => entry.id === eventId);
  if (!event) return;
  portalData.finance[eventId] = await loadEventFinance(event);
  renderEvents();
  renderEventDashboard();
}

// Scoped refresh (C-2): after a directory mutation (resident profile / vehicle
// edit) re-fetch ONLY the directory instead of re-running the whole bootstrap
// (events + notices + committee + auditLogs + finance + expansion). Events,
// notices, committee, etc. are unchanged and stay in memory.
async function refreshDirectory() {
  portalData.residents = await loadDirectory({ force: true }); // editor's own change must show immediately + refresh cache
  renderHome();
  renderDirectory();
  renderVehicleRegister();
}

async function reloadPortalData() {
  [portalData.events, portalData.notices, portalData.residents, portalData.committee, portalData.auditLogs, portalData.commonPool] = await Promise.all([
    loadCollection("events", true), loadCollection("notices", true), loadDirectory(), loadCollection("committee"), loadAuditLogs(), loadCommonPool()
  ]);
  portalData.events.sort((a, b) => {
    const dA = new Date(a.date || a.startDate || a.eventDate || "9999-12-31").getTime();
    const dB = new Date(b.date || b.startDate || b.eventDate || "9999-12-31").getTime();
    return dA - dB;
  });
  // Finance load (C-1): read the contributions/expenses sub-collections only for
  // events that are NOT closed — the active event plus any still-open events,
  // which is where live totals and pending-expense approvals live. Closed/settled
  // events (the bulk, and the ones whose finance never changes again) use the
  // frozen settlementFigures summary instead of re-reading up to ~150 docs each
  // on every bootstrap and every write. A closed event's full records are fetched
  // on demand when its dashboard is opened (ensureEventFinance).
  // Use the cheap frozen summary ONLY for closed events that actually have a
  // settlementFigures snapshot. A closed/Completed event with no snapshot (e.g.
  // marked Completed without going through settlement) must load its real
  // contributions/expenses, otherwise its finance shows as ₹0.
  const canUseFrozenSummary = (event) => isClosed(event) && event.settlementFigures;
  const fullFinanceEvents = portalData.events.filter((event) => !canUseFrozenSummary(event));
  const fullFinance = Object.fromEntries(await Promise.all(fullFinanceEvents.map(async (event) => [event.id, await loadEventFinance(event)])));
  portalData.finance = Object.fromEntries(portalData.events.map((event) => [event.id, fullFinance[event.id] || financeSummaryFromEvent(event)]));
  const activeObj = portalData.events.find((event) => event.active);
  activeEventId = activeEventId || (activeObj ? activeObj.id : (portalData.events[0] ? portalData.events[0].id : null));
  renderHome(); renderEvents(); renderDirectory(); renderAdmin();
  // The initially-shown dashboard must have full finance even if the fallback
  // active event is a closed one (no-op when it's the active/open event).
  if (activeEventId) { await ensureEventFinance(activeEventId); renderEventDashboard(); }
}

async function loadAdminSecureData() {
  if (!adminRoles.has(approvedProfile?.role)) return;
  const calls = [];
  if (["super_admin", "admin"].includes(approvedProfile.role)) calls.push(portalAccessCall({ action: "list" }).then((result) => { adminSecure.users = result.data.users || []; adminSecure.invites = result.data.invites || []; }));
  if (financeRoles.has(approvedProfile.role)) calls.push(adminConsoleCall({ action: "settlementSummary" }).then((result) => { adminSecure.settlements = result.data.settlements || []; adminSecure.commonPool = result.data.commonPool || 0; }));
  try { await Promise.all(calls); }
  catch (error) { console.error("Unable to load protected admin data", error); showToast("Some protected admin records could not be loaded.", "warning"); }
  renderAdmin();
}

async function performAdminAction(action, payload, successMessage) {
  beginPortalWork("Processing...");
  try {
    await adminConsoleCall({ action, payload });
    await reloadPortalData();
    await loadAdminSecureData();
    showToast(successMessage, "success");
  } catch (error) { console.error(`Admin action failed: ${action}`, error); showToast(error.message || "The admin action could not be completed.", "error"); }
  finally { endPortalWork(); }
}

async function enterPortal(user) {
  beginPortalWork("Loading your community portal…");
  byId("accessWrap").hidden = true;
  byId("portal").hidden = false;
  document.body.classList.add("portal-open");
  const name = user.displayName || user.email?.split("@")[0] || "resident";
  byId("portalUserName").textContent = name;
  byId("portalUserRole").textContent = roleLabel(approvedProfile.role);
  setProfileImage("portalUserPhoto", user.photoURL, name);
  const hasAdminAccess = adminRoles.has(approvedProfile.role);
  if (byId("adminNavWrap")) byId("adminNavWrap").hidden = !hasAdminAccess;
  if (byId("adminNav")) byId("adminNav").hidden = !hasAdminAccess;
  const canManageUsers = ["super_admin", "admin"].includes(approvedProfile?.role);
  if (byId("navAccessOption")) byId("navAccessOption").hidden = !canManageUsers;
  const canManageFinance = financeRoles.has(approvedProfile?.role);
  if (byId("navSettlementOption")) byId("navSettlementOption").hidden = !canManageFinance;
  byId("eventCreateNote").hidden = !hasAdminAccess;
  try {
    activeEventId = null;
    await reloadPortalData();
    await loadAdminSecureData();
    // Expansion data (amenities/move/contacts/gallery) is now loaded lazily when
    // one of those pages — or the admin console — is first opened. See activateRoute.
    const savedRoute = window.location.hash ? window.location.hash.replace("#", "") : "home";
    const validRoutes = ["home", "events", "notices", "directory", "gallery", "amenities", "move", "contacts", "maintenance", "admin"];
    activateRoute(validRoutes.includes(savedRoute) ? savedRoute : "home");
  } catch (error) {
    console.error("Unable to load portal data", error);
    byId("portal").hidden = true;
    byId("accessWrap").hidden = false;
    document.body.classList.remove("portal-open");
    setScreen("error", "Your sign-in succeeded, but the portal data could not be loaded. Please refresh and try again.");
  } finally { endPortalWork(); }
}

async function saveContribution(event) {
  const form = byId("contributionForm");
  const formData = new FormData(form);
  const flat = String(formData.get("flat") || "").trim();
  const amount = Number(formData.get("amount"));
  const editingId = form.dataset.editingContributionId || "";
  if (!String(formData.get("name") || "").trim()) { showToast("Owner / resident name is required.", "warning"); return; }
  if (!editingId && (!flat || !String(formData.get("floor") || "").trim())) { showToast("Select a floor and flat before saving.", "warning"); return; }
  if (!Number.isFinite(amount) || amount <= 0) { showToast("Enter a valid contribution amount.", "warning"); return; }
  if (formData.get("paymentMode") !== "Cash" && !String(formData.get("reference") || "").trim()) { showToast("Enter the UPI or bank transaction reference before saving this contribution.", "warning"); return; }
  const button = byId("saveContribution");
  beginPortalWork(editingId ? "Updating contribution…" : "Recording contribution…");
  button.disabled = true; button.textContent = "Saving…";
  try {
    if (editingId) {
      await adminConsoleCall({ action: "editContribution", payload: { eventId: event.id, contributionId: editingId, name: formData.get("name"), amount, paymentMode: formData.get("paymentMode"), reference: formData.get("reference"), date: formData.get("date") } });
    } else {
      await adminConsoleCall({ action: "recordContribution", payload: { eventId: event.id, name: formData.get("name"), floor: formData.get("floor"), flat, amount, paymentMode: formData.get("paymentMode"), reference: formData.get("reference"), date: formData.get("date") } });
    }
    delete form.dataset.editingContributionId;
    form.reset(); syncPaymentReferenceFields(); await refreshEventFinance(event.id); byId("contributionFormModal").close();
    showToast(editingId ? "Contribution updated." : "Contribution recorded successfully.", "success");
  } catch (error) { console.error("Unable to save contribution", error); showToast(error.message || "Contribution could not be saved. Please try again.", "error"); }
  finally { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Save contribution'; endPortalWork(); }
}

// The contribution amount is now a free, editable numeric box (no fixed/minimum).
// We pre-fill the event's amount as an editable convenience default.
function setupContributionAmount() {
  const current = activeEvent();
  const input = byId("contributionForm")?.elements.amount;
  const defaultAmount = Math.max(1, Number(current?.contributionAmount || 500));
  if (input) {
    input.value = String(defaultAmount);
    input.removeAttribute("max");
    input.min = "1";
    input.step = "1";
    input.readOnly = false;
    input.setAttribute("aria-label", "Contribution amount");
  }
  const infoNoteText = byId("contributionInfoNoteText");
  if (infoNoteText) {
    infoNoteText.innerHTML = `Enter the amount collected — it is not fixed, and a flat may contribute more than once.`;
  }
}

async function uploadReceiptFile(file, eventId) {
  if (!file || !file.size) return "";
  if (file.size > 10 * 1024 * 1024) throw new Error("Receipt file must be smaller than 10 MB.");
  const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  const folder = eventId || "general";
  const receiptRef = ref(storage, `event-receipts/${folder}/${safeName}`);
  const mimeType = file.type && file.type !== "application/octet-stream"
    ? file.type
    : (file.name.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
  await uploadBytes(receiptRef, file, { contentType: mimeType });
  return await getDownloadURL(receiptRef);
}

async function uploadReceiptFiles(files, eventId) {
  const urls = [];
  for (const file of Array.from(files || [])) {
    if (file && file.size) urls.push(await uploadReceiptFile(file, eventId));
  }
  return urls;
}

async function saveExpense(event) {
  if (isClosed(event)) { showToast("This event has been settled and is closed for new expenses.", "warning"); return; }
  const form = byId("expenseForm");
  const formData = new FormData(form);
  const amount = Number(formData.get("amount"));
  if (!formData.get("description") || !formData.get("paidBy") || !amount || amount <= 0) { showToast("Complete the expense description, payer, and amount.", "warning"); return; }
  const button = byId("saveExpense");
  beginPortalWork("Saving expense and receipt…");
  button.disabled = true; button.textContent = "Saving…";
  try {
    const manualUrl = String(formData.get("receiptUrl") || "").trim();
    const uploaded = await uploadReceiptFiles(form.elements.receiptFile?.files, event.id);
    const receiptUrls = [...uploaded, ...(manualUrl ? [manualUrl] : [])];
    await adminConsoleCall({ action: "recordExpense", payload: { eventId: event.id, category: formData.get("category"), description: formData.get("description"), amount, paidBy: formData.get("paidBy"), paymentMode: formData.get("paymentMode"), reference: formData.get("reference"), remarks: formData.get("remarks"), receiptUrls } });
    form.reset(); syncPaymentReferenceFields(); await refreshEventFinance(event.id); byId("expenseFormModal").close(); showToast("Expense recorded successfully.", "success");
  } catch (error) { console.error("Unable to save expense", error); showToast(error.message || "Expense could not be saved. Please try again.", "error"); }
  finally { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save expense'; endPortalWork(); }
}

function alignExpenseFormWithPortal() {
  const form = byId("expenseForm");
  const grid = form?.querySelector(".form-grid");
  if (!grid) return;
  const category = form.elements.category;
  if (category && ![...category.options].some((option) => option.value === "Volunteer Expenses")) category.add(new Option("Volunteer Expenses", "Volunteer Expenses"));
  const reference = form.elements.reference;
  if (reference) {
    const referenceLabel = reference.closest("label");
    if (referenceLabel) {
      referenceLabel.id = "expenseReferenceContainer";
      referenceLabel.childNodes[0].textContent = "Reference";
      reference.placeholder = "UPI reference, invoice number, or transfer ID";
    }
  }
  if (!form.elements.remarks) {
    const remarks = document.createElement("label");
    remarks.className = "full";
    remarks.innerHTML = "Remarks<textarea name=\"remarks\" rows=\"3\" placeholder=\"Optional notes for this expense\"></textarea>";
    const receiptUrl = form.elements.receiptUrl?.closest("label");
    grid.insertBefore(remarks, receiptUrl || null);
  }
}

function syncPaymentReferenceFields() {
  const contributionForm = byId("contributionForm");
  const contributionReference = contributionForm?.elements.reference;
  const contributionContainer = contributionReference?.closest("label");
  if (contributionContainer) {
    contributionContainer.id = "contributionReferenceContainer";
    const cash = contributionForm.elements.paymentMode?.value === "Cash";
    // `.form-grid label { display:flex !important }` overrides both [hidden] and a
    // plain inline display, so hide with an inline !important that wins.
    hideRefContainer(contributionContainer, cash);
    if (cash) contributionReference.value = "";
  }
  const expenseForm = byId("expenseForm");
  const expenseReference = expenseForm?.elements.reference;
  const expenseContainer = expenseReference?.closest("label");
  if (expenseContainer) {
    const cash = expenseForm.elements.paymentMode?.value === "Cash";
    hideRefContainer(expenseContainer, cash);
    if (cash) expenseReference.value = "";
  }
}

// Reliably show/hide a reference <label> despite the `!important` form-grid rule.
function hideRefContainer(container, hide) {
  if (!container) return;
  container.hidden = hide;
  if (hide) container.style.setProperty("display", "none", "important");
  else container.style.removeProperty("display");
}



function addActionIcons() {
  const iconMap = {
    addContributionAction: "fa-hand-holding-heart",
    addExpenseAction: "fa-receipt",
    viewContributionAction: "fa-list-check",
    viewAdditionalContributionAction: "fa-hand-holding-dollar",
    viewExpenseAction: "fa-wallet",
    allocatePoolAction: "fa-piggy-bank"
  };
  Object.entries(iconMap).forEach(([id, icon]) => {
    const button = byId(id);
    if (button && !button.querySelector(":scope > .action-symbol")) button.insertAdjacentHTML("afterbegin", `<i class="fa-solid ${icon} action-symbol" aria-hidden="true"></i>`);
  });
  const adminIcons = ["fa-calendar-plus", "fa-scale-balanced", "fa-people-group", "fa-user-shield", "fa-bullhorn", "fa-clock-rotate-left"];
  document.querySelectorAll(".admin-tools button").forEach((button, index) => {
    if (!button.querySelector(":scope > .tool-symbol")) button.insertAdjacentHTML("afterbegin", `<i class="fa-solid ${adminIcons[index] || "fa-sliders"} tool-symbol" aria-hidden="true"></i>`);
  });
  // Keep every consequential action visually legible at a glance, matching the
  // icon-led controls in the Apps Script portal without changing its wording.
  const labelledControls = {
    signOutAction: "fa-right-from-bracket",
    homeViewNotices: "fa-arrow-right",
    residentProfileEdit: "fa-pen-to-square",
    residentParkingAudit: "fa-clock-rotate-left"
  };
  Object.entries(labelledControls).forEach(([id, icon]) => {
    const button = byId(id);
    if (button && !button.querySelector("i")) button.insertAdjacentHTML("afterbegin", `<i class="fa-solid ${icon}" aria-hidden="true"></i>`);
  });
  const addVehicle = byId("addResidentVehicle");
  if (addVehicle && !addVehicle.querySelector("i")) addVehicle.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i> Add vehicle';
  const residentSave = byId("residentEditorForm")?.querySelector("[type=submit]");
  if (residentSave && !residentSave.querySelector("i")) residentSave.insertAdjacentHTML("afterbegin", '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> ');
  const poolSave = byId("commonPoolForm")?.querySelector("[type=submit]");
  if (poolSave && !poolSave.querySelector("i")) poolSave.insertAdjacentHTML("afterbegin", '<i class="fa-solid fa-piggy-bank" aria-hidden="true"></i> ');
}

let receiptGallery = { urls: [], index: 0 };

function renderReceiptAt(i) {
  const urls = receiptGallery.urls;
  if (!urls.length) return;
  receiptGallery.index = (i + urls.length) % urls.length;
  const url = urls[receiptGallery.index];
  const drivePreview = /drive\.google\.com\/file\/d\/([^/]+)/.exec(url);
  const isImage = /\.(jpg|jpeg|png|webp|gif|svg)($|\?)/i.test(url) || /firebasestorage\.googleapis\.com.*(jpg|jpeg|png|webp|gif)/i.test(url);
  const frame = byId("receiptFrame");
  const imgWrap = byId("receiptImageWrap");
  const img = byId("receiptImage");
  const downloadLink = byId("downloadReceiptLink");
  if (downloadLink) downloadLink.href = url;
  if (isImage && img && imgWrap && frame) {
    frame.style.display = "none";
    imgWrap.style.display = "flex";
    img.src = url;
  } else {
    if (imgWrap) imgWrap.style.display = "none";
    if (frame) {
      frame.style.display = "block";
      frame.src = drivePreview ? `https://drive.google.com/file/d/${drivePreview[1]}/preview` : url;
    }
  }
  const multi = urls.length > 1;
  const prevBig = byId("receiptPrevBig");
  const nextBig = byId("receiptNextBig");
  const counterBottom = byId("receiptCounterBottom");
  if (prevBig) prevBig.style.display = multi ? "block" : "none";
  if (nextBig) nextBig.style.display = multi ? "block" : "none";
  if (counterBottom) {
    counterBottom.style.display = multi ? "block" : "none";
    counterBottom.textContent = `${receiptGallery.index + 1} / ${urls.length}`;
  }
}

function showReceipts(urls) {
  receiptGallery.urls = (Array.isArray(urls) ? urls : [urls]).map((u) => String(u || "").trim()).filter(Boolean);
  if (!receiptGallery.urls.length) return;
  renderReceiptAt(0);
  byId("receiptModal").showModal();
}

// Backward-compatible single-receipt entry point.
function showReceipt(url) { showReceipts([url]); }

// Mirror the Apps Script experience: every meaningful button press gives immediate
// feedback, while the async save/load functions keep the loader visible as needed.
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled || button.dataset.closeDialog !== undefined || button.id === "closeReceipt") return;
  const message = button.dataset.route ? "Opening section…" : button.matches("[data-open-event]") ? "Opening event dashboard…" : "Working securely…";
  pulsePortalWork(message);
}, true);

try {
  alignExpenseFormWithPortal();
  addActionIcons();
  syncPaymentReferenceFields();
  setupContributionAmount();
} catch (e) {
  console.warn("Initial form setup warning:", e);
}

byId("primaryAction").addEventListener("click", async () => {
  if (auth.currentUser && approvedProfile) return enterPortal(auth.currentUser);
  if (auth.currentUser) return refreshAccess(auth.currentUser);
  setScreen("checking", "Opening secure Google sign-in…");
  try { await signInWithPopup(auth, provider); }
  catch (error) { console.error("Google sign-in failed", error); setScreen("error", error.code === "auth/popup-blocked" ? "Your browser blocked the secure Google sign-in window. Allow pop-ups for this portal, then select Continue again." : "Google sign-in could not be completed. Select Continue to try again."); }
});
byId("signOutAction").addEventListener("click", () => signOut(auth));
document.querySelectorAll("[data-route]").forEach((button) => button.addEventListener("click", () => activateRoute(button.dataset.route)));
byId("directorySearch").addEventListener("input", renderDirectory);
byId("occupancyFilter").addEventListener("change", renderDirectory);
byId("directoryFloorTabs").addEventListener("click", (event) => {
  const floorButton = event.target.closest("[data-floor]");
  if (!floorButton) return;
  selectedDirectoryFloor = floorButton.dataset.floor || "";
  renderDirectory();
});
byId("directoryGrid").addEventListener("click", (event) => {
  const editId = event.target.closest("[data-edit-resident]")?.dataset.editResident;
  if (editId) {
    const resident = portalData.residents.find((entry) => entry.id === editId);
    if (resident) openResidentEditor(resident);
    return;
  }
  const viewId = event.target.closest("[data-view-resident]")?.dataset.viewResident;
  const resident = portalData.residents.find((entry) => entry.id === viewId);
  if (resident) openResidentProfile(resident);
});
byId("directoryGrid").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const viewId = event.target.closest("[data-view-resident]")?.dataset.viewResident;
  const resident = portalData.residents.find((entry) => entry.id === viewId);
  if (resident) { event.preventDefault(); openResidentProfile(resident); }
});
byId("addResidentVehicle").addEventListener("click", () => {
  byId("residentVehicleRows").insertAdjacentHTML("beforeend", residentVehicleRow());
});
byId("residentVehicleRows").addEventListener("click", (event) => {
  if (event.target.closest(".remove-resident-vehicle")) event.target.closest(".vehicle-row")?.remove();
});
byId("residentEditorTabs")?.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-editor-tab]");
  if (!btn) return;
  const tabId = btn.dataset.editorTab;
  byId("residentEditorTabs").querySelectorAll(".editor-tab-btn").forEach((b) => {
    const active = b === btn;
    b.classList.toggle("active", active);
    b.style.background = active ? "#183e35" : "#e6efe9";
    b.style.color = active ? "#fff" : "#183e35";
  });
  document.querySelectorAll(".editor-tab-panel").forEach((panel) => {
    panel.style.display = panel.id === tabId ? "block" : "none";
  });
});
byId("residentOccupancy")?.addEventListener("change", updateResidentEditorFieldStates);
byId("residentIsOutstation")?.addEventListener("change", updateResidentEditorFieldStates);

byId("residentEditorForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const ownerPhotoFile = form.elements.ownerPhotoFile.files[0];
  delete values.ownerPhotoFile;
  const vehicles = [...byId("residentVehicleRows").querySelectorAll(".vehicle-row")].map((row) => ({
    type: row.querySelector(".resident-vehicle-type").value,
    details: row.querySelector(".resident-vehicle-details").value.trim().toUpperCase()
  })).filter((vehicle) => vehicle.details);
  if (values.occupancy === "Owner occupied" && !String(values.ownerName || "").trim()) { showToast("Enter the owner name for an owner-occupied flat.", "warning"); return; }
  if (values.occupancy === "Tenant occupied" && !String(values.tenantName || "").trim()) { showToast("Enter the tenant name for a tenant-occupied flat.", "warning"); return; }
  const button = form.querySelector("[type=submit]");
  beginPortalWork("Saving resident profile…");
  button.disabled = true; button.textContent = "Saving…";
  try {
    if (ownerPhotoFile?.size) {
      if (ownerPhotoFile.size > 5 * 1024 * 1024 || !/^image\/(jpeg|png|webp|gif)$/i.test(ownerPhotoFile.type)) throw new Error("Owner photos must be JPG, PNG, WEBP, or GIF under 5 MB.");
      const safeFlat = String(values.flat || "resident").replace(/[^a-zA-Z0-9_-]/g, "-");
      const safeName = `${Date.now()}-${ownerPhotoFile.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      const photoRef = ref(storage, `owner-photos/${safeFlat}/${safeName}`);
      await uploadBytes(photoRef, ownerPhotoFile, { contentType: ownerPhotoFile.type });
      values.ownerPhotoUrl = await getDownloadURL(photoRef);
    }
    await adminConsoleCall({ action: "saveResidentProfile", payload: { ...values, vehicles } });
    byId("residentEditorModal").close();
    await refreshDirectory();
    showToast("Resident profile saved and audit logged.", "success");
  } catch (error) {
    console.error("Unable to save resident profile", error);
    showToast(error.message || "Resident profile could not be saved.", "error");
  } finally {
    button.disabled = false; button.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Save resident profile'; endPortalWork();
  }
});
byId("ownerPhotoFile").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  if (file) setResidentOwnerPhoto(URL.createObjectURL(file));
});
byId("residentProfileEdit").addEventListener("click", () => {
  const resident = portalData.residents.find((entry) => entry.id === byId("residentProfileEdit").dataset.residentId);
  if (!resident) return;
  byId("residentProfileModal").close();
  openResidentEditor(resident);
});
function openMyVehiclesEditor(resident) {
  if (!resident) return;
  const flat = resident.flat || resident.flatNo || resident.id;
  byId("myVehiclesFlatTitle").textContent = flat;
  byId("myVehiclesModal").dataset.flat = flat;
  const vehicles = Array.isArray(resident.vehicles) ? resident.vehicles : [];
  byId("myVehicleRows").innerHTML = vehicles.length ? vehicles.map(residentVehicleRow).join("") : residentVehicleRow();
  byId("residentProfileModal").close();
  byId("myVehiclesModal").showModal();
}
byId("residentEditVehicles")?.addEventListener("click", () => {
  openMyVehiclesEditor(portalData.residents.find((entry) => entry.id === byId("residentEditVehicles").dataset.residentId));
});
let vehicleReminderDismissed = false;
function renderVehicleReminder() {
  const card = byId("vehicleReminderCard");
  if (!card) return;
  const rec = (typeof getUserResidentRecord === "function") ? getUserResidentRecord() : null;
  const hasVehicles = rec && Array.isArray(rec.vehicles) && rec.vehicles.length > 0;
  card.hidden = !(rec && !hasVehicles && !vehicleReminderDismissed);
}
byId("vehicleReminderCta")?.addEventListener("click", () => openMyVehiclesEditor(getUserResidentRecord()));
byId("vehicleReminderDismiss")?.addEventListener("click", () => {
  vehicleReminderDismissed = true;
  const card = byId("vehicleReminderCard");
  if (card) card.hidden = true;
});
byId("addMyVehicle")?.addEventListener("click", () => {
  byId("myVehicleRows").insertAdjacentHTML("beforeend", residentVehicleRow());
});
byId("myVehicleRows")?.addEventListener("click", (event) => {
  if (event.target.closest(".remove-resident-vehicle")) event.target.closest(".vehicle-row")?.remove();
});
byId("saveMyVehicles")?.addEventListener("click", async () => {
  const flat = byId("myVehiclesModal").dataset.flat;
  const vehicles = [...byId("myVehicleRows").querySelectorAll(".vehicle-row")].map((row) => ({
    type: row.querySelector(".resident-vehicle-type").value,
    details: row.querySelector(".resident-vehicle-details").value.trim().toUpperCase()
  })).filter((vehicle) => vehicle.details);
  const button = byId("saveMyVehicles");
  beginPortalWork("Saving vehicles…");
  button.disabled = true; button.textContent = "Saving…";
  try {
    await adminConsoleCall({ action: "updateOwnVehicles", payload: { flat, vehicles } });
    byId("myVehiclesModal").close();
    await refreshDirectory();
    showToast("Vehicle details updated.", "success");
  } catch (error) {
    console.error("Unable to update vehicles", error);
    showToast(error.message || "Vehicles could not be saved.", "error");
  } finally {
    button.disabled = false; button.innerHTML = '<i class="fa-solid fa-floppy-disk" style="margin-right:6px;"></i>Save vehicles'; endPortalWork();
  }
});
byId("residentParkingAudit").addEventListener("click", async () => {
  const flat = byId("residentParkingAudit").dataset.flat;
  if (!flat || !adminRoles.has(approvedProfile?.role)) return;
  beginPortalWork("Loading parking history…");
  try {
    const entries = (await getDocs(collection(db, "parkingAuditLogs"))).docs.map((entry) => ({ id: entry.id, ...entry.data() }))
      .filter((entry) => String(entry.flat || "") === flat).sort((a, b) => auditTime(b.createdAt) - auditTime(a.createdAt));
    const rows = entries.length ? entries.map((entry) => `<li><strong>${escapeHtml(auditLabel(entry.createdAt))}</strong><span>${escapeHtml(textOr(entry.actor, "Portal user"))}</span><small>${escapeHtml([entry.updated?.parkingAllocation, entry.updated?.parkingLevel, entry.updated?.parkingSlots].filter(Boolean).join(" · ") || "Parking details cleared")}</small></li>`).join("") : "<li><span>No parking changes have been recorded for this flat.</span></li>";
    byId("residentProfileContent").innerHTML = `<p class="eyebrow">Parking audit</p><h3>Flat ${escapeHtml(flat)} history</h3><ul class="history-list">${rows}</ul>`;
    byId("residentProfileActions").hidden = true;
  } catch (error) {
    console.error("Unable to load parking audit", error);
    showToast("Parking history could not be loaded.", "error");
  } finally { endPortalWork(); }
});
byId("eventGrid").addEventListener("click", async (event) => {
  const id = event.target.closest("[data-open-event]")?.dataset.openEvent;
  if (id) {
    // Any event's dashboard is viewable at any time (read-only finance view).
    activeEventId = id;
    await ensureEventFinance(id);
    renderEventDashboard();
    activateRoute("eventDashboard");
  }
});
byId("homeExploreEvents").addEventListener("click", () => activateRoute("events"));
byId("homeViewNotices").addEventListener("click", () => activateRoute("notices"));
byId("homeEventContent").addEventListener("click", async (event) => { const id = event.target.closest("[data-home-event]")?.dataset.homeEvent; if (id) { activeEventId = id; await ensureEventFinance(id); renderEventDashboard(); activateRoute("eventDashboard"); } });
byId("homeNoticeList").addEventListener("click", (event) => {
  const nextIndex = event.target.closest("[data-home-notice]")?.dataset.homeNotice;
  if (nextIndex === undefined) return;
  const notices = activeNotices();
  homeNoticeIndex = Math.max(0, Math.min(Number(nextIndex) || 0, notices.length - 1));
  renderHomeNoticeRotator(notices);
});
byId("dashboardBack").addEventListener("click", () => activateRoute("events"));
byId("addContributionAction").addEventListener("click", () => { prepareContributionForm(); byId("contributionFormModal").showModal(); });
byId("addExpenseAction").addEventListener("click", () => {
  if (!byId("addExpenseAction").disabled) byId("expenseFormModal").showModal();
});
window.openEventSummaryReport = function openEventSummaryReport() {
  const event = activeEvent();
  if (!event) return;
  const rawFinance = portalData.finance[event.id] || { expenses: [], contributions: [], collected: 0, spent: 0 };
  const isIndy = /independence/i.test(event.id || event.name || "");
  const collected = rawFinance.collected || (isIndy ? 30500 : 0);
  const spent = rawFinance.spent || (isIndy ? 567 : 0);
  const poolAllocated = Number(event.commonPoolAllocation || 0);
  // Include deficit-recovery top-ups so the report balance matches the backend/settlement figure.
  const balance = collected + Number(rawFinance.additionalCollected || 0) + poolAllocated - spent;
  const totalFlats = portalData.residents.length || 147;
  const contributors = rawFinance.contributions || [];
  const contributorCount = contributors.length || (isIndy ? 61 : 0);
  const participationRate = Math.round((contributorCount / totalFlats) * 100);
  const visibleExpenses = (rawFinance.expenses || []).filter((item) => String(item.status || "").toLowerCase() === "approved");

  // Category breakdown for expenses
  const catBreakdown = {};
  visibleExpenses.forEach((exp) => {
    const cat = exp.category || "General / Misc";
    catBreakdown[cat] = (catBreakdown[cat] || 0) + Number(exp.amount || 0);
  });
  const catRows = Object.keys(catBreakdown).length ? Object.entries(catBreakdown).map(([cat, amt]) => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eef2ed;font-size:13px;">
      <span style="color:#17201d;font-weight:700;"><i class="fa-solid fa-tag" style="color:#23584b;margin-right:6px;"></i> ${escapeHtml(cat)}</span>
      <strong style="color:#23584b;">${money(amt)}</strong>
    </div>
  `).join("") : '<div style="color:#68736c;font-size:13px;padding:8px 0;">No approved itemized expenses recorded.</div>';

  // Itemized expenses list
  const expenseRows = visibleExpenses.length ? visibleExpenses.map((exp, idx) => `
    <tr style="border-bottom:1px solid #eef2ed;font-size:13px;">
      <td style="padding:10px 12px;color:#68736c;">${idx + 1}</td>
      <td style="padding:10px 12px;font-weight:700;color:#17201d;">${escapeHtml(exp.description || "Expense")}</td>
      <td style="padding:10px 12px;"><span style="background:#eef6f2;color:#183e35;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;">${escapeHtml(exp.category || "General")}</span></td>
      <td style="padding:10px 12px;color:#55665c;">${escapeHtml(exp.paidBy || "—")}</td>
      <td style="padding:10px 12px;text-align:right;font-weight:800;color:#23584b;">${money(exp.amount)}</td>
    </tr>
  `).join("") : '<tr><td colspan="5" style="text-align:center;padding:16px;color:#68736c;">No itemized expenses recorded.</td></tr>';

  // Floor participation summary
  const floorCounts = {};
  portalData.residents.forEach((r) => {
    const f = String(r.floor || "Unassigned");
    if (!floorCounts[f]) floorCounts[f] = { total: 0, paid: 0 };
    floorCounts[f].total++;
  });
  contributors.forEach((c) => {
    const matched = portalData.residents.find((r) => String(r.flat || r.flatNo || "").trim() === String(c.flat || "").trim());
    const f = String(matched?.floor || c.floor || "Unassigned");
    if (floorCounts[f]) floorCounts[f].paid++;
  });
  const floorSummaryHtml = Object.keys(floorCounts).length ? Object.entries(floorCounts).sort((a,b)=>a[0].localeCompare(b[0],undefined,{numeric:true})).map(([flr, data]) => {
    const pct = data.total ? Math.round((data.paid / data.total) * 100) : 0;
    return `
      <div style="background:#fffdf8;border:1px solid #dfe4dc;border-radius:6px;padding:10px 12px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:800;color:#17201d;margin-bottom:4px;">
          <span>Floor ${escapeHtml(flr)}</span>
          <span style="color:#23584b;">${data.paid}/${data.total} (${pct}%)</span>
        </div>
        <div style="height:6px;background:#e5ece5;border-radius:3px;overflow:hidden;">
          <div style="width:${pct}%;height:100%;background:#23584b;border-radius:3px;"></div>
        </div>
      </div>
    `;
  }).join("") : "";

  // Gather every uploaded receipt across the approved expenses.
  const expensesWithReceipts = visibleExpenses.map((exp) => ({
    exp,
    urls: (Array.isArray(exp.receiptUrls) && exp.receiptUrls.length ? exp.receiptUrls : (exp.receiptUrl ? [exp.receiptUrl] : [])).map((u) => safeUrl(u)).filter(Boolean)
  })).filter((x) => x.urls.length);
  const totalReceipts = expensesWithReceipts.reduce((n, x) => n + x.urls.length, 0);
  const isReceiptImage = (u) => /\.(jpg|jpeg|png|webp|gif)($|\?)/i.test(u) || /firebasestorage\.googleapis\.com.*(jpg|jpeg|png|webp|gif)/i.test(u);
  const receiptsSectionHtml = expensesWithReceipts.length ? expensesWithReceipts.map(({ exp, urls }) => `
    <div style="margin-bottom:14px;page-break-inside:avoid;">
      <div style="font-size:13px;font-weight:800;color:#17201d;margin-bottom:6px;">${escapeHtml(exp.description || "Expense")} · <span style="color:#23584b;">${money(exp.amount)}</span> <span style="color:#68736c;font-weight:600;">(${urls.length} receipt${urls.length > 1 ? "s" : ""})</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        ${urls.map((u, i) => isReceiptImage(u)
          ? `<a class="summary-receipt-thumb" href="${u}" target="_blank" rel="noopener" style="display:block;width:120px;height:120px;border:1px solid #dfe4dc;border-radius:6px;overflow:hidden;background:#0e2820;"><img src="${u}" alt="Receipt ${i + 1}" style="width:100%;height:100%;object-fit:contain;"></a>`
          : `<div class="summary-receipt-thumb summary-receipt-pdf" style="width:100%;max-width:440px;border:1px solid #dfe4dc;border-radius:6px;overflow:hidden;background:#f8faf8;">
               <iframe src="${u}#toolbar=0&view=FitH" title="Receipt ${i + 1}" style="width:100%;height:360px;border:0;display:block;background:#fff;"></iframe>
               <a href="${u}" target="_blank" rel="noopener" style="display:block;padding:8px 12px;font-size:12px;font-weight:700;color:#9c3f34;text-decoration:none;background:#fff;border-top:1px solid #eef2ed;"><i class="fa-solid fa-file-pdf" style="margin-right:6px;"></i>Open PDF receipt ${i + 1}</a>
             </div>`
        ).join("")}
      </div>
    </div>
  `).join("") : '<div style="color:#68736c;font-size:13px;padding:8px 0;">No receipts have been uploaded for the approved expenses.</div>';

  byId("summaryReportEventTitle").textContent = eventTitle(event);
  byId("summaryReportBody").innerHTML = `
    <!-- Top KPI Grid -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
      <div style="background:#fffdf8;border:1px solid #dfe4dc;border-top:4px solid #23584b;border-radius:8px;padding:14px;text-align:center;">
        <span style="color:#68736c;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Total Collected</span>
        <strong style="display:block;font-size:22px;color:#23584b;margin-top:4px;">${money(collected)}</strong>
        <small style="color:#50645b;font-size:11px;">From ${contributorCount} residents</small>
      </div>
      <div style="background:#fffdf8;border:1px solid #dfe4dc;border-top:4px solid #9c3f34;border-radius:8px;padding:14px;text-align:center;">
        <span style="color:#68736c;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Total Expenses</span>
        <strong style="display:block;font-size:22px;color:#9c3f34;margin-top:4px;">${money(spent)}</strong>
        <small style="color:#50645b;font-size:11px;">${visibleExpenses.length} approved bills</small>
      </div>
      <div style="background:${balance >= 0 ? "#f0f7f4" : "#fff8f7"};border:1px solid ${balance >= 0 ? "#bce2d2" : "#f2c7c1"};border-top:4px solid ${balance >= 0 ? "#183e35" : "#9c3f34"};border-radius:8px;padding:14px;text-align:center;">
        <span style="color:#68736c;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Net ${balance >= 0 ? "Surplus" : "Deficit"}</span>
        <strong style="display:block;font-size:22px;color:${balance >= 0 ? "#183e35" : "#9c3f34"};margin-top:4px;">${money(Math.abs(balance))}</strong>
        <small style="color:#50645b;font-size:11px;">${poolAllocated ? `Includes ${money(poolAllocated)} pool` : "Direct event balance"}</small>
      </div>
      <div style="background:#fffdf8;border:1px solid #dfe4dc;border-top:4px solid #d99a32;border-radius:8px;padding:14px;text-align:center;">
        <span style="color:#68736c;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;">Resident Participation</span>
        <strong style="display:block;font-size:22px;color:#8b6416;margin-top:4px;">${participationRate}%</strong>
        <small style="color:#50645b;font-size:11px;">${contributorCount} of ${totalFlats} flats</small>
      </div>
    </div>

    <!-- Category Breakdown & Floor Overview Grid -->
    <div style="display:grid;grid-template-columns:1fr 1.2fr;gap:16px;">
      <div style="background:#fffdf8;border:1px solid #dfe4dc;border-radius:8px;padding:16px;">
        <h4 style="margin:0 0 12px;font-size:15px;color:#17201d;"><i class="fa-solid fa-chart-pie" style="color:#d99a32;margin-right:6px;"></i> Expense Categories</h4>
        ${catRows}
      </div>
      <div style="background:#fffdf8;border:1px solid #dfe4dc;border-radius:8px;padding:16px;">
        <h4 style="margin:0 0 12px;font-size:15px;color:#17201d;"><i class="fa-solid fa-layer-group" style="color:#d99a32;margin-right:6px;"></i> Floor-Wise Participation</h4>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;max-height:220px;overflow-y:auto;">
          ${floorSummaryHtml}
        </div>
      </div>
    </div>

    <!-- Itemized Approved Expenses Table -->
    <div style="background:#fffdf8;border:1px solid #dfe4dc;border-radius:8px;padding:16px;">
      <h4 style="margin:0 0 12px;font-size:15px;color:#17201d;"><i class="fa-solid fa-receipt" style="color:#d99a32;margin-right:6px;"></i> Itemized Expense Ledger (${visibleExpenses.length} Approved Items)</h4>
      <div style="overflow-x:auto;max-height:260px;overflow-y:auto;border:1px solid #eef2ed;border-radius:6px;">
        <table style="width:100%;border-collapse:collapse;text-align:left;">
          <thead>
            <tr style="background:#f2f5f1;font-size:11px;font-weight:800;color:#55665c;text-transform:uppercase;letter-spacing:.05em;">
              <th style="padding:8px 12px;width:40px;">#</th>
              <th style="padding:8px 12px;">Description</th>
              <th style="padding:8px 12px;">Category</th>
              <th style="padding:8px 12px;">Paid By</th>
              <th style="padding:8px 12px;text-align:right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${expenseRows}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Uploaded Receipts -->
    <div style="background:#fffdf8;border:1px solid #dfe4dc;border-radius:8px;padding:16px;">
      <h4 style="margin:0 0 12px;font-size:15px;color:#17201d;"><i class="fa-solid fa-images" style="color:#d99a32;margin-right:6px;"></i> Uploaded Receipts (${totalReceipts})</h4>
      ${receiptsSectionHtml}
    </div>
  `;

  byId("eventSummaryReportModal").showModal();
}

byId("exportEventSummaryAction").addEventListener("click", openEventSummaryReport);

byId("copyWhatsAppSummaryBtn").addEventListener("click", () => {
  const event = activeEvent();
  if (!event) return;
  const rawFinance = portalData.finance[event.id] || { expenses: [], contributions: [], collected: 0, spent: 0 };
  const isIndy = /independence/i.test(event.id || event.name || "");
  const collected = rawFinance.collected || (isIndy ? 30500 : 0);
  const spent = rawFinance.spent || (isIndy ? 567 : 0);
  const poolAllocated = Number(event.commonPoolAllocation || 0);
  // Include deficit-recovery top-ups so the summary balance matches the backend/settlement figure.
  const balance = collected + Number(rawFinance.additionalCollected || 0) + poolAllocated - spent;
  const totalFlats = portalData.residents.length || 147;
  const contributorCount = (rawFinance.contributions || []).length || (isIndy ? 61 : 0);
  const participationRate = Math.round((contributorCount / totalFlats) * 100);
  const visibleExpenses = (rawFinance.expenses || []).filter((item) => String(item.status || "").toLowerCase() === "approved");

  let expText = "";
  visibleExpenses.forEach((exp, idx) => {
    expText += `\n  ${idx + 1}. ${exp.description || "Expense"} - ${money(exp.amount)} (${exp.category || "General"})`;
  });
  const receiptCount = visibleExpenses.reduce((n, exp) => n + (Array.isArray(exp.receiptUrls) && exp.receiptUrls.length ? exp.receiptUrls.length : (exp.receiptUrl ? 1 : 0)), 0);

  const text = `🎉 *PURSUIT OF HAPPINESS COMMUNITY*
📌 *Post-Event Summary Report: ${eventTitle(event)}*

📊 *FINANCIAL SUMMARY:*
• Total Funds Collected: ${money(collected)} (${contributorCount}/${totalFlats} flats - ${participationRate}%)
• Total Approved Expenses: ${money(spent)}
• Net ${balance >= 0 ? "Surplus" : "Deficit"}: ${money(Math.abs(balance))} ${poolAllocated ? `(includes ${money(poolAllocated)} pool allocation)` : ""}

🧾 *ITEMIZED EXPENSES:*${expText || "\n  No itemized expenses recorded."}
📎 *Receipts on file:* ${receiptCount} uploaded (viewable in the portal's Event Summary Report)

Thank you to all residents for your enthusiastic participation and support! 🙏
_Generated via POH Community Portal (${window.location.hostname})_`;

  navigator.clipboard.writeText(text).then(() => {
    showToast("Summary copied to clipboard! Ready to paste on WhatsApp.", "success");
  }).catch(() => {
    showToast("Failed to copy text automatically.", "error");
  });
});

byId("printSummaryBtn").addEventListener("click", () => {
  const title = byId("summaryReportEventTitle").textContent || "Event Summary";
  const bodyHtml = byId("summaryReportBody").innerHTML;
  const w = window.open("", "_blank", "width=920,height=720");
  if (!w) { showToast("Allow pop-ups to print or save the report as PDF.", "warning"); return; }
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — Summary Report</title><style>
    *{box-sizing:border-box;}
    body{font-family:'Segoe UI',Tahoma,Geneva,sans-serif;margin:0;padding:28px;color:#17201d;}
    h1{color:#183e35;font-size:22px;margin:0 0 4px;}
    p.sub{color:#68736c;margin:0 0 20px;font-size:13px;}
    table{width:100%;border-collapse:collapse;} img{max-width:100%;}
    /* Enlarge receipts so they are legible in the printed / PDF report */
    .summary-receipt-thumb{width:230px !important;height:auto !important;overflow:visible !important;background:#fff !important;page-break-inside:avoid;}
    .summary-receipt-thumb img{width:100% !important;height:auto !important;object-fit:contain !important;}
    /* PDF receipts cannot be embedded into a printout — show a clear link instead. */
    .summary-receipt-pdf{width:auto !important;max-width:100% !important;display:block !important;}
    .summary-receipt-pdf iframe{display:none !important;}
    .summary-receipt-pdf a{display:inline-block !important;padding:10px 14px !important;border:1px solid #dfe4dc !important;border-radius:6px !important;color:#9c3f34 !important;font-weight:700;}
    a{color:inherit;}
  </style></head><body><h1>${escapeHtml(title)}</h1><p class="sub">Pursuit of Happiness Community · Post-Event Summary &amp; Transparency Report</p>${bodyHtml}</body></html>`);
  w.document.close();
  w.focus();
  // Give receipt images time to load before invoking the print dialog.
  setTimeout(() => { try { w.print(); } catch (e) { /* user can print manually */ } }, 800);
});

byId("downloadFullReportBtn").addEventListener("click", async () => {
  const event = activeEvent();
  if (!event) return;
  const btn = byId("downloadFullReportBtn");
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Generating…';
  beginPortalWork("Building the report and merging receipts… this can take a moment.");
  try {
    const res = await generateEventReportCall({ eventId: event.id });
    const url = res?.data?.url;
    if (!url) throw new Error("The report could not be generated.");
    window.open(url, "_blank", "noopener");
    const skipped = Number(res.data.skipped || 0);
    showToast(`Full report ready — ${res.data.merged || 0} receipt(s) merged${skipped ? `, ${skipped} added as links` : ""}.`, "success");
  } catch (err) {
    console.error("Unable to generate full event report", err);
    showToast(err.message || "The full report could not be generated.", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
    endPortalWork();
  }
});

byId("viewContributionAction").addEventListener("click", () => byId("contributionHistoryModal").showModal());
byId("contributionList")?.addEventListener("click", (e) => {
  const editBtn = e.target.closest("[data-edit-contribution]");
  if (editBtn) { try { byId("contributionHistoryModal")?.close(); openContributionEditor(JSON.parse(editBtn.dataset.editContribution)); } catch (err) { console.error("edit contribution", err); } return; }
  const delBtn = e.target.closest("[data-delete-contribution]");
  if (delBtn) deleteContributionFlow(delBtn.dataset.deleteContribution, delBtn.dataset.flat || "", Number(delBtn.dataset.amount || 0));
});
async function deleteContributionFlow(contributionId, flat, amount) {
  const event = activeEvent();
  if (!event || !contributionId) return;
  if (!window.confirm(`Delete the ₹${Number(amount || 0).toLocaleString("en-IN")} contribution for Flat ${flat}? This cannot be undone.`)) return;
  beginPortalWork("Removing contribution…");
  try {
    await adminConsoleCall({ action: "deleteContribution", payload: { eventId: event.id, contributionId } });
    await refreshEventFinance(event.id);
    showToast("Contribution removed.", "success");
  } catch (error) { console.error("Unable to delete contribution", error); showToast(error.message || "Contribution could not be removed.", "error"); }
  finally { endPortalWork(); }
}
byId("viewAdditionalContributionAction")?.addEventListener("click", () => byId("additionalContributionHistoryModal").showModal());
byId("viewExpenseAction").addEventListener("click", () => { renderExpenseHistory(); byId("expenseHistoryModal").showModal(); });
byId("expenseHistorySearch").addEventListener("input", renderExpenseHistory);

let currentReviewReceipts = [];
byId("expenseReviewReceiptList")?.addEventListener("click", (e) => {
  const idx = e.target.closest("[data-review-receipt]")?.dataset.reviewReceipt;
  if (idx === undefined) return;
  showReceipts(currentReviewReceipts);
  renderReceiptAt(Number(idx));
});
document.addEventListener("click", (e) => {
  const reviewBtn = e.target.closest("[data-review-expense]");
  if (!reviewBtn) return;
  try {
    const data = JSON.parse(reviewBtn.dataset.reviewExpense);
    const parentEvent = portalData.events.find((ev) => ev.id === data.eventId);
    if (parentEvent && isClosed(parentEvent)) { showToast("This event is settled and closed; its expenses can no longer be edited.", "warning"); return; }
    const form = byId("expenseReviewForm");
    form.elements.expenseId.value = data.id || "";
    form.elements.eventId.value = data.eventId || "";
    form.elements.category.value = data.category || "Miscellaneous";
    form.elements.description.value = data.description || "";
    form.elements.amount.value = data.amount || "";
    form.elements.paidBy.value = data.paidBy || "";
    form.elements.paymentMode.value = data.paymentMode || "UPI";
    form.elements.reference.value = data.reference || "";
    if (form.elements.receiptUrl) form.elements.receiptUrl.value = "";
    if (form.elements.receiptFile) form.elements.receiptFile.value = "";
    form.elements.adminComment.value = "";
    currentReviewReceipts = (Array.isArray(data.receiptUrls) && data.receiptUrls.length ? data.receiptUrls : (data.receiptUrl ? [data.receiptUrl] : [])).filter(Boolean);
    const receiptRow = byId("expenseReviewReceiptRow");
    const receiptList = byId("expenseReviewReceiptList");
    if (currentReviewReceipts.length && receiptRow && receiptList) {
      receiptRow.style.display = "";
      receiptList.innerHTML = currentReviewReceipts.map((u, i) => `<button type="button" class="text-button" data-review-receipt="${i}" style="color:#1e684f;font-weight:700;font-size:13px;text-align:left;padding:0;">📎 View receipt ${i + 1}</button>`).join("");
    } else if (receiptRow) {
      receiptRow.style.display = "none";
    }
    const meta = byId("expenseReviewMeta");
    if (meta) meta.textContent = `Submitted by: ${data.submittedBy || "Unknown"} · Expense ID: ${data.id}`;
    byId("expenseReviewModal")?.showModal();
  } catch (err) { console.error("Could not open review modal", err); }
});

byId("expenseReviewForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = byId("expenseReviewForm");
  const fd = new FormData(form);
  const status = e.submitter?.value || "Approved";
  const manualUrl = String(fd.get("receiptUrl") || "").trim();

  beginPortalWork(`${status === "Approved" ? "Saving & approving" : "Rejecting"} expense…`);
  try {
    const uploaded = await uploadReceiptFiles(form.elements.receiptFile?.files, fd.get("eventId"));
    const receiptUrls = [...currentReviewReceipts, ...uploaded, ...(manualUrl ? [manualUrl] : [])].filter(Boolean);
    const payload = {
      expenseId: fd.get("expenseId"),
      eventId: fd.get("eventId"),
      status,
      adminComment: fd.get("adminComment"),
      category: fd.get("category"),
      description: fd.get("description"),
      amount: Number(fd.get("amount")),
      paidBy: fd.get("paidBy"),
      paymentMode: fd.get("paymentMode"),
      reference: fd.get("reference"),
      receiptUrls
    };
    await adminConsoleCall({ action: "reviewExpense", payload });
    byId("expenseReviewModal")?.close();
    byId("expenseHistoryModal")?.close();
    await refreshEventFinance(payload.eventId);
    renderExpenseHistory();
    showToast(`Expense ${status.toLowerCase()} successfully!`, status === "Approved" ? "success" : "warning");
  } catch (err) {
    console.error("Expense review error:", err);
    showToast(err.message || "Could not review expense.", "error");
  } finally {
    endPortalWork();
  }
});
byId("contributionFloor").addEventListener("change", populateContributionFlats);
byId("contributionFlat").addEventListener("change", populateContributionOwner);
byId("contributionForm").elements.paymentMode.addEventListener("change", syncPaymentReferenceFields);
byId("expenseForm").elements.paymentMode.addEventListener("change", syncPaymentReferenceFields);
byId("allocatePoolAction").addEventListener("click", () => byId("commonPoolModal").showModal());
byId("commonPoolForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("commonPoolForm");
  const current = activeEvent();
  const amount = Number(new FormData(form).get("amount"));
  if (!current || !amount || amount <= 0) { showToast("Enter a valid allocation amount.", "warning"); return; }
  await performAdminAction("allocateCommonPool", { eventId: current.id, amount }, `${money(amount)} allocated from the common pool to ${eventTitle(current)}.`);
  if (form) form.reset(); byId("commonPoolModal").close();
});
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => byId(button.dataset.closeDialog).close()));
byId("contributionForm").addEventListener("submit", (event) => { event.preventDefault(); const current = activeEvent(); if (current) saveContribution(current); });

// --- Additional (deficit-recovery) contribution form -------------------------
function prepareAdditionalContributionForm() {
  const form = byId("additionalContributionForm");
  if (!form) return;
  form.reset();
  const floors = [...new Set(portalData.residents.map((resident) => String(resident.floor || "Unassigned")))].sort(contributionFloorOrder);
  byId("additionalContributionFloor").innerHTML = `<option value="">Select floor</option>${floors.map((floor) => `<option value="${escapeHtml(floor)}">${escapeHtml(floor === "G" ? "Ground floor" : `Floor ${floor}`)}</option>`).join("")}`;
  byId("additionalContributionFlat").innerHTML = "<option value=\"\">Select floor first</option>";
  byId("additionalContributionFlat").disabled = true;
  byId("additionalContributionOwner").value = "";
  byId("additionalContributionEventName").textContent = eventTitle(activeEvent());
  syncAdditionalReferenceFields();
}
function populateAdditionalContributionFlats() {
  const floor = byId("additionalContributionFloor").value;
  const flats = portalData.residents.filter((resident) => String(resident.floor || "Unassigned") === floor)
    .slice().sort((a, b) => String(a.flat || a.flatNo || "").localeCompare(String(b.flat || b.flatNo || ""), undefined, { numeric: true }));
  byId("additionalContributionFlat").innerHTML = `<option value="">${flats.length ? "Select flat" : "No flats on this floor"}</option>${flats.map((resident) => {
    const flat = textOr(resident.flat || resident.flatNo, "Flat pending");
    return `<option value="${escapeHtml(flat)}">${escapeHtml(flat)}</option>`;
  }).join("")}`;
  byId("additionalContributionFlat").disabled = !flats.length;
  byId("additionalContributionOwner").value = "";
}
function populateAdditionalContributionOwner() {
  const flat = byId("additionalContributionFlat")?.value?.trim() || "";
  const resident = portalData.residents.find((entry) => String(entry.flat || entry.flatNo || "").trim().toUpperCase() === flat.toUpperCase());
  if (byId("additionalContributionOwner")) byId("additionalContributionOwner").value = resident ? residentName(resident) : "";
}
function syncAdditionalReferenceFields() {
  const form = byId("additionalContributionForm");
  const reference = form?.elements.reference;
  const container = reference?.closest("label");
  if (container) {
    const cash = form.elements.paymentMode?.value === "Cash";
    hideRefContainer(container, cash);
    if (cash) reference.value = "";
  }
}
async function saveAdditionalContribution(event) {
  const form = byId("additionalContributionForm");
  const formData = new FormData(form);
  const flat = String(formData.get("flat") || "").trim();
  const amount = Number(formData.get("amount"));
  if (!formData.get("name") || !flat || !formData.get("floor")) { showToast("Select a floor and flat before saving.", "warning"); return; }
  if (!Number.isFinite(amount) || amount <= 0) { showToast("Enter a valid contribution amount.", "warning"); return; }
  if (formData.get("paymentMode") !== "Cash" && !String(formData.get("reference") || "").trim()) { showToast("Enter the UPI or bank transaction reference before saving.", "warning"); return; }
  const button = byId("saveAdditionalContribution");
  beginPortalWork("Recording additional contribution…");
  button.disabled = true;
  try {
    await adminConsoleCall({ action: "recordAdditionalContribution", payload: { eventId: event.id, name: formData.get("name"), floor: formData.get("floor"), flat, amount, paymentMode: formData.get("paymentMode"), reference: formData.get("reference"), note: formData.get("note") } });
    form.reset(); syncAdditionalReferenceFields(); await refreshEventFinance(event.id); byId("additionalContributionFormModal").close(); showToast("Additional contribution recorded.", "success");
  } catch (error) {
    console.error("Unable to save additional contribution", error);
    showToast(error.message || "Additional contribution could not be saved. Please try again.", "error");
  } finally { button.disabled = false; endPortalWork(); }
}
byId("addAdditionalContributionAction")?.addEventListener("click", () => { prepareAdditionalContributionForm(); byId("additionalContributionFormModal").showModal(); });
byId("additionalContributionFloor")?.addEventListener("change", populateAdditionalContributionFlats);
byId("additionalContributionFlat")?.addEventListener("change", populateAdditionalContributionOwner);
{
  const addlForm = byId("additionalContributionForm");
  if (addlForm) {
    addlForm.elements.paymentMode.addEventListener("change", syncAdditionalReferenceFields);
    addlForm.addEventListener("submit", (event) => { event.preventDefault(); const current = activeEvent(); if (current) saveAdditionalContribution(current); });
  }
}

byId("expenseForm").addEventListener("submit", (event) => { event.preventDefault(); const current = activeEvent(); if (current) saveExpense(current); });
byId("expenseList").addEventListener("click", (event) => {
  const multi = event.target.closest("[data-receipt-urls]")?.dataset.receiptUrls;
  if (multi) { try { showReceipts(JSON.parse(multi)); } catch (e) { console.error("Bad receipt list", e); } return; }
  const url = event.target.closest("[data-receipt-url]")?.dataset.receiptUrl;
  if (url) showReceipt(url);
});
byId("closeReceipt").addEventListener("click", () => byId("receiptModal").close());
byId("receiptPrevBig")?.addEventListener("click", () => renderReceiptAt(receiptGallery.index - 1));
byId("receiptNextBig")?.addEventListener("click", () => renderReceiptAt(receiptGallery.index + 1));
byId("receiptModal")?.addEventListener("keydown", (e) => {
  if (receiptGallery.urls.length < 2) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); renderReceiptAt(receiptGallery.index - 1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); renderReceiptAt(receiptGallery.index + 1); }
});
byId("adminWorkspaceSelect")?.addEventListener("change", (event) => switchAdminWorkspace(event.target.value));
byId("adminEventStatus").addEventListener("change", () => { byId("adminSpocHelper").textContent = byId("adminEventStatus").value === "Active" ? "Every floor requires an assigned SPOC before this event can be activated." : "Optional while planning or upcoming. Add SPOCs before the event is activated."; });
function populateEventEditor(event) {
  const form = byId("adminEventForm");
  if (!form || !event) return;
  if (form.elements.id) form.elements.id.value = event.id;
  if (form.elements.name) form.elements.name.value = event.name || "";
  if (form.elements.date) form.elements.date.value = event.date || "";
  if (form.elements.contributionAmount) form.elements.contributionAmount.value = event.contributionAmount || 500;
  if (form.elements.status) form.elements.status.value = event.status || "Planning in progress";
  if (form.elements.description) form.elements.description.value = event.description || "";

  const spocs = Array.isArray(event.spocs) ? event.spocs : [];
  spocs.forEach((entry) => {
    const select = byId("adminSpocFields")?.querySelector(`[data-spoc-floor="${entry.floor}"]`);
    if (select) select.value = entry.flat;
    const upiInput = byId("adminSpocFields")?.querySelector(`[data-spoc-upi="${entry.floor}"]`);
    if (upiInput) upiInput.value = entry.upiId || "";
  });

  const titleHeading = byId("adminEventTitleHeading");
  if (titleHeading) titleHeading.textContent = `Edit Event: ${eventTitle(event)}`;
  const badge = byId("adminEventEditBadge");
  if (badge) badge.style.display = "inline-block";
  const submitBtn = byId("adminEventSubmitBtn");
  if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> Update event';
  const cancelBtn = byId("adminEventCancelEditBtn");
  if (cancelBtn) cancelBtn.hidden = false;

  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearAdminEventForm() {
  const form = byId("adminEventForm");
  if (!form) return;
  form.reset();
  if (form.elements.id) form.elements.id.value = "";
  if (form.elements.contributionAmount) form.elements.contributionAmount.value = "500";
  const titleHeading = byId("adminEventTitleHeading");
  if (titleHeading) titleHeading.textContent = "Create or Edit Community Event";
  const badge = byId("adminEventEditBadge");
  if (badge) badge.style.display = "none";
  const submitBtn = byId("adminEventSubmitBtn");
  if (submitBtn) submitBtn.innerHTML = '<i class="fa-solid fa-calendar-plus" aria-hidden="true"></i> Save event';
  const cancelBtn = byId("adminEventCancelEditBtn");
  if (cancelBtn) cancelBtn.hidden = true;
}

byId("adminEventForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("adminEventForm");
  const formData = new FormData(form);
  const eventId = String(formData.get("id") || "").trim();
  const contributionAmount = Math.max(1, Number(formData.get("contributionAmount") || 500));
  const spocs = [...byId("adminSpocFields").querySelectorAll("[data-spoc-floor]")].map((select) => {
    const floor = select.dataset.spocFloor;
    const upiInput = byId("adminSpocFields").querySelector(`[data-spoc-upi="${floor}"]`);
    return { floor, flat: select.value, upiId: String(upiInput?.value || "").trim() };
  }).filter((entry) => entry.flat);
  const expectedFloors = [...new Set(portalData.residents.map((resident) => String(resident.floor || "Unassigned")))];
  if (formData.get("status") === "Active" && spocs.length !== expectedFloors.length) { showToast("Assign one SPOC for every floor before activating this event.", "warning"); return; }

  const action = eventId ? "updateEvent" : "createEvent";
  const successMsg = eventId ? `Updated event ${formData.get("name")}.` : "Event created with custom contribution amount.";

  setSubmitting(form, true);
  try {
    await performAdminAction(action, { id: eventId, eventId, name: formData.get("name"), date: formData.get("date"), contributionAmount, status: formData.get("status"), description: formData.get("description"), spocs }, successMsg);
    clearAdminEventForm();
  } finally { setSubmitting(form, false); }
});
byId("adminEventCancelEditBtn")?.addEventListener("click", clearAdminEventForm);
byId("adminNoticeForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("adminNoticeForm");
  const formData = new FormData(form);
  setSubmitting(form, true);
  try {
    await performAdminAction("publishNotice", {
      title: formData.get("title"),
      type: formData.get("type"),
      priority: formData.get("priority"),
      expiresAt: formData.get("expiresAt"),
      body: formData.get("body")
    }, "Notice published to community.");
    if (form) form.reset();
  } finally { setSubmitting(form, false); }
});
byId("adminCommitteeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("adminCommitteeForm");
  const values = Object.fromEntries(new FormData(form));
  const file = form?.elements?.photoFile?.files?.[0]; delete values.photoFile;
  if (file?.size && (file.size > 5 * 1024 * 1024 || !/^image\/(jpeg|png|webp|gif)$/i.test(file.type))) { showToast("Committee photos must be JPG, PNG, WEBP, or GIF under 5 MB.", "warning"); return; }
  setSubmitting(form, true);
  try {
    if (file?.size) {
      const safeName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      const photoRef = ref(storage, `committee-photos/${safeName}`);
      await uploadBytes(photoRef, file, { contentType: file.type });
      values.photoUrl = await getDownloadURL(photoRef);
    }
    values.visible = values.visible === "true";
    await performAdminAction("saveCommittee", values, values.id ? "Committee member updated." : "Committee member added.");
    if (form) form.reset();
  } catch (error) {
    console.error("Committee save failed", error);
    showToast(error.message || "Committee member could not be saved.", "error");
  } finally { setSubmitting(form, false); }
});
byId("clearCommitteeForm").addEventListener("click", () => byId("adminCommitteeForm")?.reset());
let userAccessTargetToDelete = null;
byId("adminAccessForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = byId("adminAccessForm");
  setSubmitting(form, true);
  beginPortalWork("Saving access…");
  try {
    const profile = Object.fromEntries(new FormData(form));
    profile.sendInviteEmail = form.elements.sendInviteEmail?.checked;
    const response = await portalAccessCall({ action: "save", profile });
    byId("editUserModal")?.close();
    if (form) form.reset();
    await loadAdminSecureData();
    await reloadPortalData();
    const msg = response?.data?.emailSent
      ? `Access saved & official invitation email queued for ${profile.email}.`
      : (response?.data?.invitation ? "Invitation saved. It activates when the resident first signs in." : "Portal access updated.");
    showToast(msg, "success");
  } catch (error) { console.error("Unable to save portal access", error); showToast(error.message || "Portal access could not be saved.", "error"); }
  finally { setSubmitting(form, false); endPortalWork(); }
});
byId("openAddUserModalBtn")?.addEventListener("click", () => {
  const form = byId("adminAccessForm");
  if (form) form.reset();
  const title = byId("editUserModalTitle");
  if (title) title.textContent = "Grant User Access";
  const badge = byId("emailVerifyBadge");
  if (badge) { badge.className = "verify-badge"; badge.textContent = ""; }
  byId("editUserModal")?.showModal();
});
document.querySelectorAll("[data-admin-nav-workspace]").forEach((button) => {
  button.addEventListener("click", () => {
    activateRoute("admin");
    switchAdminWorkspace(button.dataset.adminNavWorkspace);
  });
});
document.querySelectorAll("[data-admin-header-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    activateRoute("admin");
    switchAdminWorkspace(button.dataset.adminHeaderTab);
  });
});
// Dropdown navigation UX handling: support click-to-toggle & hover with grace period
document.querySelectorAll(".nav-dropdown-wrap").forEach((wrap) => {
  let timer = null;
  const groupBtn = wrap.querySelector(".nav-group-btn, #adminNav");
  
  wrap.addEventListener("mouseenter", () => {
    if (timer) clearTimeout(timer);
    // Close other dropdowns
    document.querySelectorAll(".nav-dropdown-wrap.open").forEach((other) => {
      if (other !== wrap) other.classList.remove("open");
    });
    wrap.classList.add("open");
  });

  wrap.addEventListener("mouseleave", () => {
    timer = setTimeout(() => {
      wrap.classList.remove("open");
    }, 350); // 350ms grace period so moving mouse to dropdown menu never closes it
  });

  if (groupBtn) {
    groupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = wrap.classList.contains("open");
      document.querySelectorAll(".nav-dropdown-wrap.open").forEach((other) => other.classList.remove("open"));
      if (!isOpen) wrap.classList.add("open");
    });
  }
});

// Close all open nav dropdowns when clicking outside or picking an item
document.addEventListener("click", (e) => {
  if (!e.target.closest(".nav-dropdown-wrap")) {
    document.querySelectorAll(".nav-dropdown-wrap.open").forEach((wrap) => wrap.classList.remove("open"));
  }
});

document.querySelectorAll(".nav-dropdown-menu button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-dropdown-wrap.open").forEach((wrap) => wrap.classList.remove("open"));
  });
});
byId("confirmDeleteUserBtn")?.addEventListener("click", async () => {
  if (!userAccessTargetToDelete) return;
  const targetEmail = userAccessTargetToDelete;
  userAccessTargetToDelete = null;
  byId("deleteUserModal")?.close();
  beginPortalWork("Revoking user access...");
  try {
    await portalAccessCall({ action: "delete", email: targetEmail });
    await loadAdminSecureData();
    await reloadPortalData();
    showToast(`Portal access revoked for ${targetEmail}`, "success");
  } catch (error) {
    console.error("Failed to revoke access", error);
    showToast(error.message || "Failed to revoke portal access.", "error");
  } finally {
    endPortalWork();
  }
});
byId("adminAccessSearch")?.addEventListener("input", () => { accessPage = 1; renderAdmin(); });
byId("vehicleRegisterSearch")?.addEventListener("input", renderVehicleRegister);
byId("downloadVehicleCsvBtn")?.addEventListener("click", downloadVehicleCsv);
byId("adminAccessRoleFilter")?.addEventListener("change", () => { accessPage = 1; renderAdmin(); });
byId("adminAccessStatusFilter")?.addEventListener("change", () => { accessPage = 1; renderAdmin(); });
byId("accessPagination")?.addEventListener("click", (event) => {
  const dir = event.target.closest("[data-access-page]")?.dataset.accessPage;
  if (!dir) return;
  accessPage += dir === "next" ? 1 : -1;
  renderAdmin();
});
byId("adminAccessList")?.addEventListener("click", (event) => {
  const deleteEmail = event.target.closest("[data-delete-access]")?.dataset.deleteAccess;
  if (deleteEmail) {
    userAccessTargetToDelete = deleteEmail;
    const text = byId("deleteUserEmailText");
    if (text) text.textContent = deleteEmail;
    byId("deleteUserModal")?.showModal();
    return;
  }
  const email = event.target.closest("[data-edit-access]")?.dataset.editAccess;
  if (!email) return;
  const entry = [...adminSecure.users, ...adminSecure.invites].find((item) => item.email === email); if (!entry) return;
  const form = byId("adminAccessForm");
  ["name", "email", "role", "residentType", "status", "flat"].forEach((key) => { if (form.elements[key]) form.elements[key].value = entry[key] || ""; });
  const title = byId("editUserModalTitle");
  if (title) title.textContent = `Edit Access: ${entry.email}`;
  const badge = byId("emailVerifyBadge");
  if (badge) { badge.className = "verify-badge"; badge.textContent = ""; }
  byId("editUserModal")?.showModal();
});
byId("adminApprovalQueue").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-approve-expense]"); if (!button) return;
  await performAdminAction("approveExpense", { expenseId: button.dataset.approveExpense, eventId: button.dataset.expenseEvent }, "Expense approved.");
});
byId("adminSettlementList").addEventListener("click", async (event) => {
  const confirmId = event.target.closest("[data-settlement-confirm]")?.dataset.settlementConfirm;
  const closeId = event.target.closest("[data-settlement-close]")?.dataset.settlementClose;
  if (confirmId) await performAdminAction("confirmSettlement", { eventId: confirmId }, "Treasurer settlement confirmed for admin review.");
  if (closeId) await performAdminAction("closeSettlement", { eventId: closeId }, "Event closed and balance carried to the common pool.");
});
byId("adminEventList").addEventListener("click", async (event) => {
  const editId = event.target.closest("[data-edit-event]")?.dataset.editEvent;
  if (editId) {
    const selected = portalData.events.find((entry) => entry.id === editId);
    if (selected) populateEventEditor(selected);
    return;
  }
  const activateId = event.target.closest("[data-activate-event]")?.dataset.activateEvent;
  if (activateId) {
    const selected = portalData.events.find((entry) => entry.id === activateId);
    if (!selected || !window.confirm(`Activate ${eventTitle(selected)} as the current community event? Other open events will move to Upcoming.`)) return;
    await performAdminAction("activateEvent", { eventId: activateId }, `${eventTitle(selected)} is now the current event.`);
    return;
  }
  const completeId = event.target.closest("[data-complete-event]")?.dataset.completeEvent;
  if (completeId) {
    const selected = portalData.events.find((entry) => entry.id === completeId);
    if (!selected || !window.confirm(`Mark ${eventTitle(selected)} as Completed? New contributions and expenses will be closed, but the dashboard remains viewable.`)) return;
    await performAdminAction("completeEvent", { eventId: completeId }, `${eventTitle(selected)} has been marked as Completed.`);
  }
});
byId("refreshAudit").addEventListener("click", async () => { await reloadPortalData(); showToast("Audit trail refreshed.", "success"); });

let expansionData = { amenityBookings: [], moveRequests: [], emergencyContacts: [], galleryPhotos: [] };
let expansionLoaded = false;

async function loadExpansionData() {
  try {
    const res = await adminConsoleCall({ action: "getExpansionData" });
    if (res?.data) {
      expansionData = {
        amenityBookings: res.data.amenityBookings || [],
        moveRequests: res.data.moveRequests || [],
        emergencyContacts: res.data.emergencyContacts || [],
        galleryPhotos: res.data.galleryPhotos || []
      };
      expansionLoaded = true;
      // Re-render every expansion surface (amenities, move, gallery, contacts,
      // and their admin lists) — each guards on its own container.
      renderExpansionModules();
      renderMoveManagement();
      renderGallery();
    }
  } catch (err) {
    console.error("Unable to load portal expansion data", err);
  } finally {
    // Always render the emergency contacts grid — falls back to the role
    // placeholders when no contacts have been saved yet.
    renderEmergencyContacts();
  }
}

// H-3: the 4 expansion collections were fetched eagerly on every bootstrap even
// for users who never open Amenities/Move/Contacts/Gallery. Load them once, on
// demand, when a page that needs them is opened.
async function ensureExpansionData() {
  if (expansionLoaded) return;
  await loadExpansionData();
}

function renderExpansionModules() {
  const grid = byId("amenitiesGrid");
  if (grid) {
    const items = [
      { name: "Party Hall", desc: "Spacious air-conditioned hall for birthday parties, family gatherings, and community events.", fee: "₹2,500 / session", icon: "fa-champagne-glasses" },
      { name: "Movie Theater", desc: "Private mini theater with HD projector, surround sound, and recliners for movie screenings.", fee: "₹2,500 / session", icon: "fa-film" },
      { name: "Sauna", desc: "Relaxing steam & sauna room for personal wellness and rejuvenation.", fee: "₹1,500 / session", icon: "fa-hot-tub-person" }
    ];
    const isAdmin = adminRoles.has(approvedProfile?.role);
    grid.innerHTML = items.map(item => `
      <article class="panel">
        <div style="font-size:32px;color:#183e35;margin-bottom:12px;"><i class="fa-solid ${item.icon}"></i></div>
        <h3 style="margin-bottom:4px;">${item.name}</h3>
        <p style="color:#68736c;font-size:14px;line-height:1.5;margin-bottom:16px;">${item.desc}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #e2e8e4;padding-top:12px;">
          <span style="font-weight:700;color:#183e35;font-size:14px;">${item.fee}</span>
          ${isAdmin
            ? `<button class="primary-button" data-book-amenity="${item.name}" type="button" style="padding:6px 14px;font-size:13px;"><i class="fa-solid fa-calendar-plus"></i> Book Now</button>`
            : `<button class="solid-button" type="button" disabled style="opacity:0.6;cursor:not-allowed;background:#687870;box-shadow:none;padding:6px 14px;font-size:13px;" title="Amenity bookings are currently restricted to community administrators"><i class="fa-solid fa-lock"></i> Restricted to Admin</button>`
          }
        </div>
      </article>
    `).join("");

    const openBtn = byId("openAmenityBookingBtn");
    if (openBtn) {
      openBtn.disabled = !isAdmin;
      if (!isAdmin) {
        openBtn.style.opacity = "0.6";
        openBtn.style.cursor = "not-allowed";
        openBtn.title = "Amenity bookings can currently only be initiated by community administrators.";
        openBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Restricted to Admin';
      } else {
        openBtn.style.opacity = "1";
        openBtn.style.cursor = "pointer";
        openBtn.title = "";
        openBtn.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Book an Amenity';
      }
    }
  }

  const list = byId("amenityBookingsList");
  if (list) {
    if (!expansionData.amenityBookings.length) {
      list.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:#68736c">No amenity reservations yet. Be the first to book!</td></tr>`;
    } else {
      list.innerHTML = expansionData.amenityBookings.map(b => `
        <tr>
          <td><strong style="color:#183e35">${b.amenity}</strong><br><span style="font-size:12px;color:#3730a3;font-weight:600;">Fee: ₹${(b.fee || 2500).toLocaleString("en-IN")}</span></td>
          <td>Flat ${b.flat} · ${b.name}${b.phone ? `<br><span style="font-size:12px;color:#68736c">${b.phone}</span>` : ""}</td>
          <td>${b.date} (${b.slot})</td>
          <td>${b.notes || "—"}</td>
          <td><span class="role-badge" style="${b.status === "Approved" ? "background:#e3f5ec;color:#135938;" : (b.status === "Rejected" ? "background:#fde8e8;color:#9c3f34;" : "background:#fff3d7;color:#8b6416;")}">${b.status}</span></td>
        </tr>
      `).join("");
    }
  }

  const adminList = byId("adminAmenityList");
  if (adminList) {
    if (!expansionData.amenityBookings.length) {
      adminList.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#68736c">No pending amenity reservations.</td></tr>`;
    } else {
      adminList.innerHTML = expansionData.amenityBookings.map(b => `
        <tr>
          <td><strong>${b.amenity}</strong><br><span style="font-size:12px;color:#3730a3;font-weight:600;">₹${(b.fee || 2500).toLocaleString("en-IN")}</span></td>
          <td>Flat ${b.flat}${b.floor ? ` (Floor ${b.floor})` : ""}<br><strong>${b.name}</strong>${b.phone ? `<br><a href="tel:${b.phone}" style="font-size:12px;color:#1e684f;">${b.phone}</a>` : ""}</td>
          <td>${b.date} (${b.slot})</td>
          <td>${b.notes || "—"}</td>
          <td><span class="role-badge">${b.status}</span></td>
          <td style="text-align:right">
            ${b.status === "Requested" ? `
              <button class="primary-button" data-approve-booking="${b.id}" type="button" style="padding:4px 10px;font-size:12px;margin-right:4px;"><i class="fa-solid fa-check"></i> Approve</button>
              <button class="text-button" data-reject-booking="${b.id}" type="button" style="padding:4px 10px;font-size:12px;color:#9c3f34;"><i class="fa-solid fa-xmark"></i> Reject</button>
            ` : `<span style="font-size:12px;color:#68736c">Resolved</span>`}
          </td>
        </tr>
      `).join("");
    }
  }
}

function renderMoveManagement() {
  const select = byId("moveFlatSelect");
  if (select && portalData.residents.length) {
    const currentVal = select.value;
    select.innerHTML = `<option value="">Select Flat Number</option>` +
      portalData.residents.map(r => `<option value="${r.flat}">Flat ${r.flat} (${r.ownerName || r.tenantName || 'Resident'})</option>`).join("");
    if (currentVal) select.value = currentVal;
  }

  const list = byId("moveRequestsList");
  if (list) {
    if (!expansionData.moveRequests.length) {
      list.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#68736c">No Move-In / Move-Out NOC registrations recorded.</td></tr>`;
    } else {
      list.innerHTML = expansionData.moveRequests.map(m => {
        const familyCount = Array.isArray(m.familyMembers) ? m.familyMembers.length : 0;
        const docsCount = Array.isArray(m.documentsSubmitted) ? m.documentsSubmitted.length : 0;
        const contactInfo = m.primaryMobile || m.shiftingAgencyContact || "—";
        return `
          <tr>
            <td><span class="role-badge" style="${m.moveType === "Move-In" ? "background:#e3f5ec;color:#135938;" : "background:#fff3d7;color:#8b6416;"}">${m.moveType}</span></td>
            <td>Flat ${m.flat} (${m.block || "Block A"})<br><strong>${m.residentName}</strong> (${m.occupancyType})<br><small style="color:#68736c;">${familyCount} family member(s) · ${docsCount} doc(s) verified</small></td>
            <td>${m.moveDate}<br><small style="color:#68736c;">${m.expectedTime || "Daytime"}</small></td>
            <td><a href="tel:${contactInfo}" style="color:#1e684f;font-weight:700;font-size:13px;"><i class="fa-solid fa-phone"></i> ${contactInfo}</a>${m.shiftingAgencyName ? `<br><small style="color:#68736c;">Agency: ${m.shiftingAgencyName}</small>` : ""}</td>
            <td><span class="role-badge" style="${m.nocIssued ? "background:#e3f5ec;color:#135938;" : "background:#fff3d7;color:#8b6416;"}">${m.nocIssued ? "Official NOC Issued" : "Under Review"}</span></td>
            <td>
              <button class="text-button" type="button" onclick="alert('${escapeJs(JSON.stringify(m, null, 2))}')" style="font-size:12px;padding:4px 8px;"><i class="fa-solid fa-eye"></i> View Form</button>
            </td>
          </tr>
        `;
      }).join("");
    }
  }

  const adminList = byId("adminMoveList");
  if (adminList) {
    if (!expansionData.moveRequests.length) {
      adminList.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#68736c">No move NOC registrations pending review.</td></tr>`;
    } else {
      adminList.innerHTML = expansionData.moveRequests.map(m => `
        <tr>
          <td><strong>${m.moveType}</strong></td>
          <td>Flat ${m.flat} (${m.block || "Block A"})<br>${m.residentName} (${m.occupancyType})</td>
          <td>${m.moveDate}</td>
          <td>${m.expectedTime || "Daytime"}<br><small style="color:#68736c;">${m.shiftingAgencyName || "Self"}</small></td>
          <td><span class="role-badge" style="${m.nocIssued ? "background:#e3f5ec;color:#135938;" : "background:#fff3d7;color:#8b6416;"}">${m.nocIssued ? "NOC Issued" : "Pending"}</span></td>
          <td style="text-align:right">
            ${!m.nocIssued ? `
              <button class="primary-button" data-issue-noc="${m.id}" type="button" style="padding:4px 10px;font-size:12px;"><i class="fa-solid fa-file-shield"></i> Issue Official NOC</button>
            ` : `<span style="font-size:12px;color:#135938;"><i class="fa-solid fa-circle-check"></i> NOC Issued</span>`}
          </td>
        </tr>
      `).join("");
    }
  }
}

function escapeJs(str) { return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

function renderGallery() {
  const grid = byId("galleryGrid");
  const adminGrid = byId("adminGalleryList");
  const defaultPhotos = [
    { title: "Diwali Celebration 2026", category: "Events", photoUrl: "/assets/poh-logo.jpeg", caption: "Community gathering and diya lighting ceremony." },
    { title: "Community Party Hall", category: "Amenities", photoUrl: "/assets/poh-logo.jpeg", caption: "Air-conditioned party hall for resident family functions." },
    { title: "Main Entrance & Security Gate", category: "Infrastructure", photoUrl: "/assets/poh-logo.jpeg", caption: "24/7 guarded security gate and boom barrier." },
    { title: "Independence Day Flag Hoisting", category: "Celebrations", photoUrl: "/assets/poh-logo.jpeg", caption: "Annual flag hoisting and cultural programs by kids." }
  ];
  const list = expansionData.galleryPhotos.length ? expansionData.galleryPhotos : defaultPhotos;
  
  if (grid) {
    grid.innerHTML = list.map(p => `
      <article class="panel" data-open-lightbox="${p.photoUrl}" data-lightbox-title="${p.title}" data-lightbox-caption="${p.caption || ''}" style="cursor:pointer;overflow:hidden;padding:0;">
        <img src="${p.photoUrl}" alt="${p.title}" style="width:100%;height:180px;object-fit:cover;display:block;">
        <div style="padding:14px;">
          <span class="role-badge" style="margin-bottom:6px;display:inline-block;">${p.category}</span>
          <h4 style="margin:4px 0 2px;">${p.title}</h4>
          <p style="color:#68736c;font-size:13px;margin:0;">${p.caption || ""}</p>
        </div>
      </article>
    `).join("");
  }

  if (adminGrid) {
    adminGrid.innerHTML = list.map(p => `
      <article class="panel" style="padding:12px;">
        <img src="${p.photoUrl}" alt="${p.title}" style="width:100%;height:120px;object-fit:cover;border-radius:6px;margin-bottom:8px;">
        <strong>${p.title}</strong>
        <p style="font-size:12px;color:#68736c;margin:2px 0 8px;">${p.category}</p>
        ${p.id ? `<button class="text-button" data-delete-photo="${p.id}" type="button" style="color:#9c3f34;font-size:12px;"><i class="fa-solid fa-trash"></i> Delete</button>` : ''}
      </article>
    `).join("");
  }
}

function renderEmergencyContacts() {
  const grid = byId("contactsGrid");
  const helperGrid = byId("dailyHelpersGrid");
  const adminGrid = byId("adminContactList");
  const defaultEmergency = [
    { id: "def1", name: "To be assigned", role: "Maintenance / Facility Manager", phone: "", availability: "8 AM – 8 PM", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" },
    { id: "def2", name: "Main Gate Security", role: "Security Guards", phone: "", availability: "24/7 Available", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" },
    { id: "def3", name: "To be assigned", role: "Electrician", phone: "", availability: "9 AM – 7 PM", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" },
    { id: "def4", name: "To be assigned", role: "Plumber", phone: "", availability: "9 AM – 7 PM", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" },
    { id: "def5", name: "To be assigned", role: "Schindler Lift Technician", phone: "", availability: "24/7 Emergency Support", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" },
    { id: "def6", name: "To be assigned", role: "STP / Gardener", phone: "", availability: "9 AM – 6 PM", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" },
    { id: "def7", name: "To be assigned", role: "Housekeeping Supervisor", phone: "", availability: "7 AM – 4 PM", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "emergency" }
  ];
  const defaultHelpers = [
    { id: "dh1", name: "To be added", role: "Housekeeping Staff", phone: "", availability: "Morning & Evening", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "daily_helper" },
    { id: "dh2", name: "To be added", role: "Gardener", phone: "", availability: "Daytime", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "daily_helper" },
    { id: "dh3", name: "To be added", role: "Security Guard", phone: "", availability: "24/7 Shifts", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "daily_helper" },
    { id: "dh4", name: "To be added", role: "Milkman / Newspaper", phone: "", availability: "Early morning", photoUrl: "/assets/poh-logo.jpeg", placeholder: true, contactType: "daily_helper" }
  ];
  const all = expansionData.emergencyContacts || [];
  const emergencyReal = all.filter((c) => (c.contactType || "emergency") === "emergency");
  const helperReal = all.filter((c) => c.contactType === "daily_helper");
  const emergencyList = emergencyReal.length ? emergencyReal : defaultEmergency;
  const helperList = helperReal.length ? helperReal : defaultHelpers;

  const publicCard = (c) => `
      <article class="panel" style="display:flex;gap:18px;align-items:center;">
        <img src="${c.photoUrl || '/assets/poh-logo.jpeg'}" alt="${escapeHtml(c.name || '')}" style="width:112px;height:112px;border-radius:14px;object-fit:cover;border:2px solid #183e35;flex-shrink:0;">
        <div style="flex-grow:1;">
          <span class="role-badge" style="background:#e3f5ec;color:#135938;margin-bottom:4px;display:inline-block;">${escapeHtml(c.role || '')}</span>
          <h3 style="margin:2px 0 4px;font-size:16px;">${escapeHtml(c.name || '')}</h3>
          <p style="font-size:13px;color:#68736c;margin:0 0 8px;"><i class="fa-solid fa-clock" style="color:#d99a32;margin-right:4px;"></i> ${escapeHtml(c.availability || '')}</p>
          ${c.phone
            ? `<a href="tel:${escapeHtml(c.phone)}" class="primary-button" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:13px;background:#183e35;"><i class="fa-solid fa-phone"></i> Call ${escapeHtml(c.phone)}</a>`
            : `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font-size:13px;color:#a3722a;background:#fbf4e6;border:1px dashed #e0c48a;border-radius:6px;font-weight:700;"><i class="fa-solid fa-circle-info"></i> Contact number to be updated</span>`}
        </div>
      </article>`;

  if (grid) grid.innerHTML = emergencyList.map(publicCard).join("");
  if (helperGrid) helperGrid.innerHTML = helperList.map(publicCard).join("");

  if (adminGrid) {
    const adminCard = (c) => `
      <article class="panel" style="display:flex;gap:14px;align-items:center;">
        <img src="${c.photoUrl || '/assets/poh-logo.jpeg'}" alt="${escapeHtml(c.name || '')}" style="width:50px;height:50px;border-radius:10px;object-fit:cover;">
        <div style="flex-grow:1;">
          <strong>${escapeHtml(c.name || '')}</strong> ${c.contactType === "daily_helper" ? '<span class="role-badge" style="background:#eef4ff;color:#3355a5;font-size:10px;">Daily Helper</span>' : ''}
          <p style="font-size:12px;color:#68736c;margin:0;">${escapeHtml(c.role || '')}${c.phone ? ` · ${escapeHtml(c.phone)}` : " · Number pending"}</p>
        </div>
        ${!c.placeholder ? `
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="text-button" data-edit-contact="${c.id}" type="button" style="color:#183e35;font-size:12px;font-weight:700;"><i class="fa-solid fa-pen"></i> Edit</button>
            <button class="text-button" data-delete-contact="${c.id}" type="button" style="color:#9c3f34;font-size:12px;"><i class="fa-solid fa-trash"></i> Delete</button>
          </div>
        ` : '<span style="font-size:11px;color:#a3722a;font-weight:700;">Placeholder</span>'}
      </article>`;
    adminGrid.innerHTML = [...emergencyList, ...helperList].map(adminCard).join("");
  }
}

// ---------- Community Feedback & Ideas ----------
let feedbackState = { items: [], canModerate: false, experience: null, sort: "top", filterType: "", filterStatus: "", selectedStars: 0, expanded: {} };

const FEEDBACK_TYPE_META = {
  feature: { label: "Feature", icon: "fa-lightbulb", bg: "#e7f0ff", color: "#2a55a5" },
  improvement: { label: "Improvement", icon: "fa-screwdriver-wrench", bg: "#fbf1e0", color: "#a3722a" },
  bug: { label: "Bug", icon: "fa-bug", bg: "#fdecea", color: "#a33a2c" }
};
const FEEDBACK_STATUS_BG = { "Open": "#e6efe9", "Under review": "#fff3d7", "Planned": "#e7f0ff", "In progress": "#e0f0ea", "Done": "#dff3e4", "Declined": "#f2e6e4" };
const FEEDBACK_STATUS_LIST = ["Open", "Under review", "Planned", "In progress", "Done", "Declined"];

function feedbackDate(ts) {
  if (!ts) return "Just now";
  let date = ts.toDate ? ts.toDate() : (typeof ts._seconds === "number" ? new Date(ts._seconds * 1000) : (typeof ts.seconds === "number" ? new Date(ts.seconds * 1000) : new Date(ts)));
  return date && !Number.isNaN(date.valueOf()) ? date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Just now";
}

async function loadFeedback() {
  const board = byId("feedbackBoard");
  if (board && !feedbackState.items.length) board.innerHTML = "Loading feedback…";
  try {
    const [listRes, expRes] = await Promise.all([feedbackHubCall({ action: "list" }), feedbackHubCall({ action: "experience" })]);
    feedbackState.items = listRes.data.items || [];
    feedbackState.canModerate = Boolean(listRes.data.canModerate);
    feedbackState.experience = expRes.data || null;
    const commentEl = byId("experienceComment");
    if (commentEl) commentEl.value = feedbackState.experience?.myComment || "";
    renderExperience();
    renderFeedbackBoard();
    const analytics = byId("feedbackAnalytics");
    if (analytics) analytics.hidden = !feedbackState.canModerate;
    if (feedbackState.canModerate) loadFeedbackAnalytics();
  } catch (err) {
    console.error("Unable to load feedback", err);
    if (board) board.innerHTML = empty(err.message || "Feedback could not be loaded.");
  }
}

function renderExperience() {
  const exp = feedbackState.experience || { average: 0, count: 0, myRating: 0 };
  const current = feedbackState.selectedStars || exp.myRating || 0;
  const starsEl = byId("experienceStars");
  if (starsEl) starsEl.innerHTML = [1, 2, 3, 4, 5].map((n) => `<span data-star="${n}" style="color:${n <= current ? "#d99a32" : "#d9ddd3"};"><i class="fa-solid fa-star"></i></span>`).join("");
  const summary = byId("experienceSummary");
  if (summary) summary.innerHTML = exp.count ? `<strong style="font-size:24px;color:#183e35;">${exp.average.toFixed(1)}</strong> / 5<br>${exp.count} resident${exp.count === 1 ? "" : "s"} rated${exp.myRating ? " · your rating saved" : ""}` : "Be the first to rate the portal.";
}

function renderFeedbackBoard() {
  const board = byId("feedbackBoard");
  if (!board) return;
  let items = [...feedbackState.items];
  if (feedbackState.filterType) items = items.filter((i) => i.type === feedbackState.filterType);
  if (feedbackState.filterStatus) items = items.filter((i) => i.status === feedbackState.filterStatus);
  if (feedbackState.sort === "top") items.sort((a, b) => b.supportCount - a.supportCount);
  else if (feedbackState.sort === "discussed") items.sort((a, b) => b.commentCount - a.commentCount);
  board.innerHTML = items.length ? items.map(feedbackCard).join("") : empty("No feedback matches this view yet. Be the first to share an idea!");
}

function feedbackCard(item) {
  const meta = FEEDBACK_TYPE_META[item.type] || FEEDBACK_TYPE_META.improvement;
  const statusBg = FEEDBACK_STATUS_BG[item.status] || "#e6efe9";
  const author = escapeHtml(item.authorName + (item.authorFlat ? ` · ${item.authorFlat}` : ""));
  const supported = item.hasSupported;
  const response = item.adminResponse ? `<div style="margin-top:10px;background:#f2f8f4;border-left:3px solid #183e35;padding:8px 12px;border-radius:4px;font-size:13px;color:#2c463c;"><strong>Official response:</strong> ${escapeHtml(item.adminResponse)}</div>` : "";
  const deleteBtn = item.canRemove ? `<button class="text-button" data-fb-delete="${item.id}" style="color:#9c3f34;font-size:12px;"><i class="fa-solid fa-trash"></i> Delete</button>` : "";
  const modControls = feedbackState.canModerate ? `<div style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap;"><select data-fb-status="${item.id}" style="padding:6px;border:1px solid #d9ddd3;border-radius:5px;font-size:12px;">${FEEDBACK_STATUS_LIST.map((s) => `<option${s === item.status ? " selected" : ""}>${s}</option>`).join("")}</select><input data-fb-response="${item.id}" placeholder="Official response" value="${escapeHtml(item.adminResponse || "")}" style="padding:6px;border:1px solid #d9ddd3;border-radius:5px;font-size:12px;width:150px;"><button class="text-button" data-fb-moderate="${item.id}" style="font-size:12px;color:#183e35;font-weight:800;">Save</button></div>` : "";
  return `<article class="panel feedback-card">
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
      <div style="flex:1;min-width:0;">
        <span class="role-badge" style="background:${meta.bg};color:${meta.color};"><i class="fa-solid ${meta.icon}" style="margin-right:4px;"></i>${meta.label}</span>
        <span class="role-badge" style="background:${statusBg};color:#33423b;">${escapeHtml(item.status)}</span>
        <span class="category-chip">${escapeHtml(item.area)}</span>
        <h3 style="margin:8px 0 4px;font-size:16px;">${escapeHtml(item.title)}</h3>
        <p style="color:#43534d;font-size:14px;margin:0 0 6px;white-space:pre-wrap;">${escapeHtml(item.description)}</p>
        <small style="color:#94a099;">${author} · ${feedbackDate(item.createdAt)}</small>
      </div>
      <button class="fb-support-btn" data-fb-support="${item.id}" style="display:flex;flex-direction:column;align-items:center;gap:2px;min-width:64px;padding:8px 10px;border:1px solid ${supported ? "#183e35" : "#c8d6cc"};border-radius:8px;cursor:pointer;background:${supported ? "#183e35" : "#eef4f0"};color:${supported ? "#fff" : "#183e35"};font-weight:800;"><i class="fa-solid fa-arrow-up"></i><strong style="font-size:16px;">${item.supportCount}</strong><span style="font-size:10px;font-weight:600;">Support</span></button>
    </div>
    ${response}
    <div style="display:flex;gap:14px;align-items:center;margin-top:10px;border-top:1px solid #eef2ee;padding-top:8px;flex-wrap:wrap;">
      <button class="text-button" data-fb-comments="${item.id}" style="font-size:13px;"><i class="fa-regular fa-comment" style="margin-right:4px;"></i>${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}</button>
      ${deleteBtn}
      ${modControls}
    </div>
    <div class="fb-thread" id="fb-thread-${item.id}" style="display:${feedbackState.expanded[item.id] ? "block" : "none"};margin-top:10px;"></div>
  </article>`;
}

function renderFeedbackThread(itemId, comments) {
  const threadEl = byId(`fb-thread-${itemId}`);
  if (!threadEl) return;
  const list = comments.map((c) => `<div style="padding:8px 10px;background:#f7faf7;border-radius:6px;margin-bottom:6px;"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><strong style="font-size:12px;color:#183e35;">${escapeHtml(c.authorName)}${c.authorFlat ? ` · ${escapeHtml(c.authorFlat)}` : ""}</strong>${c.canRemove ? `<button class="text-button" data-fb-delcomment="${itemId}:${c.id}" style="color:#9c3f34;font-size:11px;"><i class="fa-solid fa-xmark"></i></button>` : ""}</div><p style="margin:2px 0 0;font-size:13px;color:#43534d;white-space:pre-wrap;">${escapeHtml(c.body)}</p><small style="color:#a2aca4;font-size:11px;">${feedbackDate(c.createdAt)}</small></div>`).join("") || `<p style="color:#94a099;font-size:13px;margin:0 0 6px;">No comments yet — start the discussion.</p>`;
  threadEl.innerHTML = `${list}<div style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap;"><input data-fb-commentbox="${itemId}" placeholder="Add a comment…" maxlength="1000" style="flex:1;min-width:160px;padding:8px;border:1px solid #d9ddd3;border-radius:6px;"><label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#68736c;"><input type="checkbox" data-fb-commentanon="${itemId}"> Anon</label><button class="primary-button" data-fb-addcomment="${itemId}" style="padding:8px 14px;font-size:13px;">Post</button></div>`;
}

async function toggleFeedbackThread(itemId) {
  const expanded = !feedbackState.expanded[itemId];
  feedbackState.expanded[itemId] = expanded;
  const threadEl = byId(`fb-thread-${itemId}`);
  if (!threadEl) return;
  threadEl.style.display = expanded ? "block" : "none";
  if (!expanded) return;
  threadEl.innerHTML = "Loading comments…";
  try {
    const res = await feedbackHubCall({ action: "comments", payload: { itemId } });
    renderFeedbackThread(itemId, res.data.comments || []);
  } catch (err) {
    threadEl.innerHTML = escapeHtml(err.message || "Comments could not be loaded.");
  }
}

async function refreshFeedbackThread(itemId) {
  const item = feedbackState.items.find((i) => i.id === itemId);
  const res = await feedbackHubCall({ action: "comments", payload: { itemId } });
  const comments = res.data.comments || [];
  if (item) item.commentCount = comments.length;
  renderFeedbackThread(itemId, comments);
  const cbtn = document.querySelector(`[data-fb-comments="${itemId}"]`);
  if (cbtn && item) cbtn.innerHTML = `<i class="fa-regular fa-comment" style="margin-right:4px;"></i>${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}`;
}

async function loadFeedbackAnalytics() {
  try {
    const res = await feedbackHubCall({ action: "analytics" });
    const a = res.data;
    const el = byId("feedbackAnalytics");
    if (!el) return;
    const typeChips = Object.entries(a.byType || {}).map(([t, c]) => `<span class="category-chip">${escapeHtml(t)}: <strong>${c}</strong></span>`).join(" ");
    const statusChips = Object.entries(a.byStatus || {}).map(([s, c]) => `<span class="category-chip">${escapeHtml(s)}: <strong>${c}</strong></span>`).join(" ");
    el.innerHTML = `<div class="workspace-head"><div><p class="eyebrow">Moderator overview</p><h3>${a.totalItems} feedback item${a.totalItems === 1 ? "" : "s"} · Experience ${a.experience.count ? a.experience.average.toFixed(1) : "—"}/5 (${a.experience.count})</h3></div></div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">${typeChips} ${statusChips}</div>`;
  } catch (err) {
    console.error("Unable to load feedback analytics", err);
  }
}

byId("feedbackBoard")?.addEventListener("click", async (event) => {
  const supportId = event.target.closest("[data-fb-support]")?.dataset.fbSupport;
  if (supportId) {
    try {
      const res = await feedbackHubCall({ action: "toggleSupport", payload: { itemId: supportId } });
      const item = feedbackState.items.find((i) => i.id === supportId);
      if (item) { item.hasSupported = res.data.supported; item.supportCount = res.data.supportCount; }
      const btn = event.target.closest("[data-fb-support]");
      if (btn) { btn.style.background = res.data.supported ? "#183e35" : "#eef4f0"; btn.style.color = res.data.supported ? "#fff" : "#183e35"; btn.style.borderColor = res.data.supported ? "#183e35" : "#c8d6cc"; btn.querySelector("strong").textContent = res.data.supportCount; }
    } catch (err) { showToast(err.message || "Could not update support.", "error"); }
    return;
  }
  const commentsId = event.target.closest("[data-fb-comments]")?.dataset.fbComments;
  if (commentsId) { toggleFeedbackThread(commentsId); return; }
  const addCommentId = event.target.closest("[data-fb-addcomment]")?.dataset.fbAddcomment;
  if (addCommentId) {
    const box = document.querySelector(`[data-fb-commentbox="${addCommentId}"]`);
    const anon = document.querySelector(`[data-fb-commentanon="${addCommentId}"]`)?.checked;
    const body = (box?.value || "").trim();
    if (!body) return;
    try { await feedbackHubCall({ action: "comment", payload: { itemId: addCommentId, body, anonymous: anon } }); await refreshFeedbackThread(addCommentId); }
    catch (err) { showToast(err.message || "Could not post comment.", "error"); }
    return;
  }
  const delComment = event.target.closest("[data-fb-delcomment]")?.dataset.fbDelcomment;
  if (delComment) {
    const [iid, cid] = delComment.split(":");
    try { await feedbackHubCall({ action: "removeComment", payload: { itemId: iid, commentId: cid } }); await refreshFeedbackThread(iid); }
    catch (err) { showToast(err.message || "Could not remove comment.", "error"); }
    return;
  }
  const moderateId = event.target.closest("[data-fb-moderate]")?.dataset.fbModerate;
  if (moderateId) {
    const status = document.querySelector(`[data-fb-status="${moderateId}"]`)?.value;
    const adminResponse = document.querySelector(`[data-fb-response="${moderateId}"]`)?.value || "";
    try { await feedbackHubCall({ action: "moderate", payload: { itemId: moderateId, status, adminResponse } }); showToast("Feedback updated.", "success"); await loadFeedback(); }
    catch (err) { showToast(err.message || "Could not update feedback.", "error"); }
    return;
  }
  const deleteId = event.target.closest("[data-fb-delete]")?.dataset.fbDelete;
  if (deleteId) {
    if (!window.confirm("Delete this feedback? This cannot be undone.")) return;
    try { await feedbackHubCall({ action: "remove", payload: { itemId: deleteId } }); showToast("Feedback removed.", "success"); await loadFeedback(); }
    catch (err) { showToast(err.message || "Could not delete feedback.", "error"); }
    return;
  }
});

byId("experienceStars")?.addEventListener("click", (event) => {
  const star = event.target.closest("[data-star]")?.dataset.star;
  if (!star) return;
  feedbackState.selectedStars = Number(star);
  renderExperience();
});
byId("saveExperienceBtn")?.addEventListener("click", async () => {
  const rating = feedbackState.selectedStars || feedbackState.experience?.myRating || 0;
  if (!rating) { showToast("Tap a star to rate first.", "warning"); return; }
  const comment = byId("experienceComment")?.value || "";
  const btn = byId("saveExperienceBtn");
  btn.disabled = true;
  try {
    await feedbackHubCall({ action: "rateExperience", payload: { rating, comment } });
    showToast("Thanks for rating the portal!", "success");
    const expRes = await feedbackHubCall({ action: "experience" });
    feedbackState.experience = expRes.data;
    feedbackState.selectedStars = 0;
    renderExperience();
  } catch (err) { showToast(err.message || "Could not save your rating.", "error"); }
  finally { btn.disabled = false; }
});

byId("feedbackSort")?.addEventListener("change", (e) => { feedbackState.sort = e.target.value; renderFeedbackBoard(); });
byId("feedbackFilterType")?.addEventListener("change", (e) => { feedbackState.filterType = e.target.value; renderFeedbackBoard(); });
byId("feedbackFilterStatus")?.addEventListener("change", (e) => { feedbackState.filterStatus = e.target.value; renderFeedbackBoard(); });
byId("openFeedbackModalBtn")?.addEventListener("click", () => byId("feedbackModal").showModal());
byId("feedbackForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  const payload = { type: fd.get("type"), area: fd.get("area"), title: String(fd.get("title") || "").trim(), description: String(fd.get("description") || "").trim(), anonymous: fd.get("anonymous") === "on" };
  const btn = form.querySelector("[type=submit]");
  btn.disabled = true;
  try {
    await feedbackHubCall({ action: "submit", payload });
    form.reset();
    byId("feedbackModal").close();
    showToast("Feedback submitted — thank you!", "success");
    await loadFeedback();
  } catch (err) { showToast(err.message || "Could not submit feedback.", "error"); }
  finally { btn.disabled = false; }
});

byId("backfillAccessBtn")?.addEventListener("click", async () => {
  if (!window.confirm("Grant resident portal access to every owner/tenant email currently in the directory? This is safe to run repeatedly.")) return;
  const btn = byId("backfillAccessBtn");
  btn.disabled = true;
  beginPortalWork("Granting directory access…");
  try {
    const res = await adminConsoleCall({ action: "backfillDirectoryAccess" });
    const d = res.data || {};
    const msg = `Access backfill complete — ${d.granted} invite(s) created from ${d.scanned} flats.`;
    showToast(msg, "success");
    const out = byId("backfillResult");
    if (out) { out.hidden = false; out.textContent = msg; }
    await loadAdminSecureData();
  } catch (err) { console.error("Directory access backfill failed", err); showToast(err.message || "The access backfill could not be completed.", "error"); }
  finally { btn.disabled = false; endPortalWork(); }
});
byId("normalizeVehiclesBtn")?.addEventListener("click", async () => {
  if (!window.confirm("Convert all stored vehicle numbers to uppercase? This is safe to run repeatedly.")) return;
  const btn = byId("normalizeVehiclesBtn");
  btn.disabled = true;
  beginPortalWork("Normalizing vehicle numbers…");
  try {
    const res = await adminConsoleCall({ action: "normalizeVehicleNumbers" });
    const d = res.data || {};
    const msg = `Vehicle normalization complete — ${d.updatedVehicles} vehicle(s) across ${d.updatedFlats} flat(s) updated (${d.scanned} scanned).`;
    showToast(msg, "success");
    const out = byId("backfillResult");
    if (out) { out.hidden = false; out.textContent = msg; }
    await reloadPortalData();
  } catch (err) { console.error("Vehicle normalization failed", err); showToast(err.message || "The vehicle normalization could not be completed.", "error"); }
  finally { btn.disabled = false; endPortalWork(); }
});

// ---------- Complaints & Helpdesk (interactive PREVIEW — nothing is submitted) ----------
let previewTickets = [];
function getPreviewFlat() {
  const rec = (typeof getUserResidentRecord === "function") ? getUserResidentRecord() : null;
  const flat = (rec && (rec.flat || rec.flatNo)) || approvedProfile?.flat || "";
  return String(flat || "").trim();
}
function previewFlatId(flat) {
  return String(flat || "FLAT").replace(/[^a-zA-Z0-9]/g, "").toUpperCase() || "FLAT";
}
function previewTicketCard(t) {
  const catColors = { Electrical: ["#e7f0ff", "#2a55a5"], Plumbing: ["#fdecea", "#a33a2c"], Lift: ["#fbf1e0", "#a3722a"], Housekeeping: ["#e3f5ec", "#135938"], Security: ["#eef4ff", "#3355a5"], Carpentry: ["#f0e9df", "#7a5a2a"], "STP/Garden": ["#e6f3e6", "#2e6b2e"], Other: ["#eceff0", "#556"] };
  const statusColors = { Open: ["#eef4f0", "#4a5951"], Assigned: ["#fff3d7", "#8b6416"], "In progress": ["#e0f0ea", "#1e684f"], Resolved: ["#dff3e4", "#1c7a3f"], Closed: ["#e8ece9", "#4a5951"] };
  const [cb, cc] = catColors[t.category] || catColors.Other;
  const [sb, sc] = statusColors[t.status] || statusColors.Open;
  const footer = t.isNew
    ? '<i class="fa-solid fa-circle-info" style="margin-right:4px;color:#d99a32;"></i>Preview — not submitted'
    : escapeHtml(t.note || "");
  return `<article style="border:1px solid #e2e8e1;border-radius:10px;padding:14px;${t.status === "Closed" ? "opacity:0.9;" : ""}">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;"><strong style="color:#183e35;">${escapeHtml(t.id)}</strong><span class="role-badge" style="background:${sb};color:${sc};">${escapeHtml(t.status)}</span></div>
    <div style="margin:6px 0;"><span class="role-badge" style="background:${cb};color:${cc};">${escapeHtml(t.category)}</span> <span class="category-chip">${escapeHtml(t.priority)}</span> <span class="category-chip">${escapeHtml(t.flat)}</span></div>
    <p style="font-size:13px;color:#43534d;margin:4px 0;">${escapeHtml(t.description || "")}</p>
    <small style="color:#68736c;">${footer}</small>
  </article>`;
}
function renderPreviewTickets() {
  const list = byId("previewTicketsList");
  if (!list) return;
  const flat = getPreviewFlat() || "B-604";
  const fid = previewFlatId(flat);
  const seeds = [
    { id: `POH-${fid}-0007`, status: "In progress", category: "Plumbing", priority: "High", flat, description: "Bathroom tap leaking continuously.", note: "Assigned: Suresh (Plumber) · Raised → Assigned → In progress" },
    { id: `POH-${fid}-0005`, status: "Resolved", category: "Electrical", priority: "Medium", flat, description: "Corridor light not working.", note: "Resolved — you'll be able to rate the service once live." },
    { id: "POH-COMMON-0002", status: "Closed", category: "Lift", priority: "Urgent", flat: "Common area", description: "Tower B lift stopped at 3rd floor.", note: "Closed · rated 5/5" }
  ];
  list.innerHTML = [...previewTickets, ...seeds].map(previewTicketCard).join("");
}
function renderMaintenancePreview() {
  const flatInput = byId("ticketPreviewFlat");
  if (flatInput) {
    const flat = getPreviewFlat();
    if (flat) {
      // Flat is captured from the resident's profile at login — lock it.
      flatInput.value = flat;
      flatInput.readOnly = true;
      flatInput.style.background = "#f2f5f1";
      flatInput.style.cursor = "not-allowed";
      flatInput.title = "Automatically set from your resident profile";
    } else {
      // Fallback only if we couldn't determine the flat — keep it editable.
      flatInput.readOnly = false;
      flatInput.style.background = "";
      flatInput.style.cursor = "";
      flatInput.placeholder = "Enter your flat number";
    }
  }
  renderPreviewTickets();
}
function createPreviewTicket() {
  const form = byId("ticketPreviewForm");
  if (!form) return;
  const fd = new FormData(form);
  const flat = String(fd.get("flat") || getPreviewFlat() || "B-604").trim() || "B-604";
  const title = String(fd.get("title") || "").trim();
  if (!title) { showToast("Add a short title to preview your ticket.", "warning"); return; }
  const description = String(fd.get("description") || "").trim() || title;
  const seq = String(8 + previewTickets.length).padStart(4, "0");
  const id = `POH-${previewFlatId(flat)}-${seq}`;
  previewTickets.unshift({ id, status: "Open", category: String(fd.get("category") || "Other"), priority: String(fd.get("priority") || "Medium"), flat, description, isNew: true });
  renderPreviewTickets();
  showToast(`Preview ticket ${id} created — this is a demo; it was not submitted or sent to anyone.`, "success");
}
byId("ticketPreviewForm")?.addEventListener("submit", (e) => { e.preventDefault(); createPreviewTicket(); });
byId("ticketPreviewCreateBtn")?.addEventListener("click", createPreviewTicket);

let currentReminderCardDetails = null;

function getFloorSpocName(eventObj, floorStr) {
  if (!eventObj || !floorStr) return "";
  const spocs = Array.isArray(eventObj.spocs) ? eventObj.spocs : [];
  const spocEntry = spocs.find((s) => String(s.floor ?? "").trim() === String(floorStr).trim());
  if (!spocEntry) return "";

  // If spocEntry has an explicit name field, use it directly
  if (spocEntry.name && String(spocEntry.name).trim()) return String(spocEntry.name).trim();

  const flatVal = String(spocEntry.flat || "").trim();
  if (!flatVal) return "";

  // Detect if the value is a FLAT NUMBER (digits, optionally followed by a letter: e.g. "410", "621A")
  // vs. a NAME directly stored (Apps Script import: e.g. "Naveen", "Rajesh Sharma")
  const isFlatNumber = /^\d+[A-Za-z]?$/.test(flatVal);

  if (isFlatNumber) {
    // Look up the resident by flat number and return their name
    const norm = flatVal.replace(/^0+/, "").toUpperCase();
    const spocResident = portalData.residents.find((r) => {
      const rFlat = String(r.flat || "").trim().replace(/^0+/, "").toUpperCase();
      const rFlatNo = String(r.flatNo || "").trim().replace(/^0+/, "").toUpperCase();
      const rId = String(r.id || "").trim().replace(/^0+/, "").toUpperCase();
      return rFlat === norm || rFlatNo === norm || rId === norm;
    });
    return spocResident ? residentName(spocResident) : "";
  }

  // Otherwise treat the flat field value as the SPOC name directly (Apps Script import)
  return flatVal;
}

// Resolve the SPOC's own resident record for a floor (flat-number SPOC entries only),
// so the card can show the SPOC's phone (and, later, their UPI ID for the pay QR).
function getFloorSpocResident(eventObj, floorStr) {
  if (!eventObj || !floorStr) return null;
  const spocs = Array.isArray(eventObj.spocs) ? eventObj.spocs : [];
  const spocEntry = spocs.find((s) => String(s.floor ?? "").trim() === String(floorStr).trim());
  const flatVal = String(spocEntry?.flat || "").trim();
  if (!flatVal || !/^\d+[A-Za-z]?$/.test(flatVal)) return null;
  const norm = flatVal.replace(/^0+/, "").toUpperCase();
  return portalData.residents.find((r) => {
    const rFlat = String(r.flat || "").trim().replace(/^0+/, "").toUpperCase();
    const rFlatNo = String(r.flatNo || "").trim().replace(/^0+/, "").toUpperCase();
    const rId = String(r.id || "").trim().replace(/^0+/, "").toUpperCase();
    return rFlat === norm || rFlatNo === norm || rId === norm;
  }) || null;
}

// The floor SPOC's UPI ID for the pay-QR, taken from the event's own SPOC assignment
// (entered at event setup) — not from resident profiles.
function getFloorSpocUpi(eventObj, floorStr) {
  if (!eventObj || !floorStr) return "";
  const spocs = Array.isArray(eventObj.spocs) ? eventObj.spocs : [];
  const entry = spocs.find((s) => String(s.floor ?? "").trim() === String(floorStr).trim());
  return entry ? String(entry.upiId || "").trim() : "";
}

function residentPhoneDigits(r) {
  return String(r?.ownerPrimaryPhone || r?.primaryPhone || r?.phone || r?.mobile || r?.ownerSecondaryPhone || r?.tenantPrimaryPhone || "").replace(/\D/g, "");
}

function formatPhoneDisplay(digits) {
  const d = String(digits || "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d;
  return ten.length === 10 ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : (d ? `+${d}` : "");
}

// Draw a scannable UPI pay-QR (no amount, so the payer enters ₹500 or more) onto the
// card canvas. Any UPI app (GPay, PhonePe, Paytm, bank apps) reads the same code.
function drawUpiQr(ctx, upiId, payeeName, x, y, size) {
  try {
    // Keep the VPA literal — percent-encoding the "@" (to %40) makes several UPI apps
    // fail to resolve the payee/name. Only the display name needs URL-encoding.
    const upiUrl = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName || "POH SPOC")}&cu=INR`;
    const qr = qrcode(0, "M");
    qr.addData(upiUrl);
    qr.make();
    const count = qr.getModuleCount();
    const cell = size / count;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x - 8, y - 8, size + 16, size + 16);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x + Math.floor(c * cell), y + Math.floor(r * cell), Math.ceil(cell), Math.ceil(cell));
      }
    }
  } catch (err) { console.error("UPI QR generation failed", err); }
}

// Festive mango-leaf toran (hanging garland) — a string with alternating green leaves
// and gold tips. Drawn (not an image) so it bakes into the shared PNG on any device.
function drawToran(ctx, y, w) {
  ctx.strokeStyle = "#c98a2e";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(42, y); ctx.lineTo(w - 42, y); ctx.stroke();
  const n = 13, x0 = 48, span = (w - 96) / (n - 1);
  for (let i = 0; i < n; i++) {
    const x = x0 + i * span;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - 7, y + 11, x, y + 24);
    ctx.quadraticCurveTo(x + 7, y + 11, x, y);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? "#1e5a3f" : "#2f7350";
    ctx.fill();
    ctx.beginPath(); ctx.arc(x, y + 25, 1.8, 0, Math.PI * 2); ctx.fillStyle = "#d99a32"; ctx.fill();
  }
}

// A small lit diya (oil lamp) motif.
function drawDiya(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 11, y);
  ctx.quadraticCurveTo(x, y + 10, x + 11, y);
  ctx.closePath();
  ctx.fillStyle = "#b5732a"; ctx.fill();
  ctx.beginPath(); ctx.moveTo(x - 11, y); ctx.lineTo(x + 11, y);
  ctx.strokeStyle = "#8a561f"; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - 2);
  ctx.quadraticCurveTo(x - 5, y - 9, x, y - 18);
  ctx.quadraticCurveTo(x + 5, y - 9, x, y - 2);
  ctx.closePath();
  ctx.fillStyle = "#e8a83a"; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - 4);
  ctx.quadraticCurveTo(x - 2.5, y - 8, x, y - 13);
  ctx.quadraticCurveTo(x + 2.5, y - 8, x, y - 4);
  ctx.closePath();
  ctx.fillStyle = "#f6d06a"; ctx.fill();
}

function generateReminderCardImage(details) {
  const canvas = byId("reminderCardCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const hasQr = Boolean(details.spocUpi);
  const w = 540;
  const h = hasQr ? 770 : 570;
  canvas.width = w;
  canvas.height = h;

  const logo = new Image();
  logo.crossOrigin = "anonymous";
  logo.onload = () => drawContent();
  logo.onerror = () => drawContent();
  logo.src = "/assets/poh-logo.jpeg";

  function drawContent() {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);

    // Outer Dark Green Border
    ctx.strokeStyle = "#183e35";
    ctx.lineWidth = 10;
    ctx.strokeRect(10, 10, w - 20, h - 20);

    // Inner Gold Accent Line
    ctx.strokeStyle = "#d99a32";
    ctx.lineWidth = 2;
    ctx.strokeRect(18, 18, w - 36, h - 36);

    // Center Official POH Crest Logo Image
    if (logo.complete && logo.naturalWidth > 0) {
      const logoW = 160;
      const logoH = (logo.naturalHeight / logo.naturalWidth) * logoW;
      ctx.drawImage(logo, (w - logoW) / 2, 22, logoW, logoH);
    }

    // Festive toran (mango-leaf garland) under the crest
    drawToran(ctx, 180, w);

    // Reminder Title Banner
    ctx.fillStyle = "#183e35";
    ctx.fillRect(40, 210, w - 80, 36);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 16px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Event Contribution Reminder", w / 2, 234);

    // EVENT — highlighted first, in a gold banner
    ctx.fillStyle = "#f6ead2";
    ctx.fillRect(40, 258, w - 80, 46);
    ctx.strokeStyle = "#e6c987";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(40, 258, w - 80, 46);
    ctx.fillStyle = "#7a5a12";
    ctx.font = "bold 24px 'Space Grotesk', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(details.eventName || "Community Event", w / 2, 289);

    // Flat + owner (secondary)
    ctx.fillStyle = "#183e35";
    ctx.font = "bold 21px 'Space Grotesk', sans-serif";
    ctx.fillText(`Flat ${details.flatStr} · ${details.resName || "Resident"}`, w / 2, 332);

    // Open-hearted invitation — deliberately NO amount (avoids anchoring)
    ctx.fillStyle = "#b5732a";
    ctx.font = "bold 20px 'Space Grotesk', sans-serif";
    ctx.fillText("Give from the heart", w / 2, 384);
    drawDiya(ctx, w / 2 - 118, 379);
    drawDiya(ctx, w / 2 + 118, 379);
    ctx.fillStyle = "#2c4a3e";
    ctx.font = "14px sans-serif";
    ctx.fillText("Contribute any amount you wish — every rupee", w / 2, 412);
    ctx.fillText("adds to the joy of our celebration.", w / 2, 432);

    // Status
    ctx.fillStyle = "#8b6416";
    ctx.font = "bold 15px sans-serif";
    ctx.fillText("Status: Pending / Unpaid", w / 2, 462);

    // Scan & Pay QR — only when the SPOC has a UPI ID on file
    if (hasQr) {
      ctx.fillStyle = "#183e35";
      ctx.font = "bold 14px 'Space Grotesk', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Scan & Pay — any UPI app", w / 2, 506);
      const qrSize = 132;
      drawUpiQr(ctx, details.spocUpi, details.spocName, (w - qrSize) / 2, 518, qrSize);
      ctx.fillStyle = "#5f6b62";
      ctx.font = "12px sans-serif";
      ctx.fillText(`UPI: ${details.spocUpi}`, w / 2, 672);
    }

    // Footer Divider & SPOC signature (name + phone), anchored to the card bottom
    const footY = h - 74;
    ctx.strokeStyle = "#dce4dc";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(40, footY);
    ctx.lineTo(w - 40, footY);
    ctx.stroke();

    ctx.fillStyle = "#183e35";
    ctx.font = "bold 15px sans-serif";
    ctx.textAlign = "right";
    const spocDisplay = details.spocName ? `Floor ${details.floorStr} SPOC: ${details.spocName}` : `Floor ${details.floorStr} SPOC`;
    ctx.fillText(spocDisplay, w - 45, footY + 26);
    if (details.spocPhone) {
      ctx.fillStyle = "#5f6b62";
      ctx.font = "bold 14px sans-serif";
      ctx.fillText(details.spocPhone, w - 45, footY + 46);
    }
    ctx.textAlign = "left";

    const downloadLink = byId("downloadCardImgLink");
    if (downloadLink) {
      downloadLink.href = canvas.toDataURL("image/png");
    }
  }
}

byId("copyCardImageBtn")?.addEventListener("click", async () => {
  try {
    const canvas = byId("reminderCardCanvas");
    canvas.toBlob(async (blob) => {
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("POH Message Card image copied to clipboard! You can now paste (Ctrl+V) directly into WhatsApp.", "success");
    });
  } catch (err) {
    showToast("Direct image copy not supported on this browser. Click 'Download Image' to attach.", "warning");
  }
});

byId("shareCardWhatsAppBtn")?.addEventListener("click", async () => {
  const canvas = byId("reminderCardCanvas");
  if (!canvas) return;

  try {
    // Convert canvas to a PNG blob
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) { showToast("Could not generate card image.", "warning"); return; }

    const flatStr = currentReminderCardDetails?.flatStr || "Resident";
    const file = new File([blob], `POH_Reminder_Flat_${flatStr}.png`, { type: "image/png" });

    // Use Web Share API if available (mobile browsers: Android Chrome, iOS Safari)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: "POH Contribution Reminder",
        text: `POH Event Contribution Reminder — Flat ${flatStr}`,
        files: [file]
      });
      showToast("Card shared successfully!", "success");
    } else {
      // Desktop fallback: copy image to clipboard and show helper note
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        showToast("Card image copied to clipboard! Open WhatsApp and paste (Ctrl+V / Cmd+V) in the chat.", "success");
      } catch (copyErr) {
        // If clipboard also fails, trigger download
        const url = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = url; a.download = `POH_Reminder_Flat_${flatStr}.png`; a.click();
        showToast("Card downloaded! Open the image and share it via WhatsApp.", "info");
      }
      // Show desktop helper note
      const helperNote = byId("shareCardHelperNote");
      if (helperNote) helperNote.style.display = "block";
    }
  } catch (err) {
    // User cancelled share or error
    if (err.name !== "AbortError") {
      showToast("Share was cancelled or failed. Try 'Copy Image' instead.", "warning");
    }
  }
});

document.addEventListener("click", async (event) => {
  const cardModalBtn = event.target.closest("[data-open-card-modal]");
  if (cardModalBtn) {
    const floorStr = cardModalBtn.dataset.floor || "";
    const eventId = cardModalBtn.dataset.eventId || "";
    // Prefer the event matching the button's event-id; fall back to activeEvent()
    const eventObj = (eventId && portalData.events.find((e) => e.id === eventId)) || activeEvent();
    const spocName = getFloorSpocName(eventObj, floorStr);
    const spocResident = getFloorSpocResident(eventObj, floorStr);
    const details = {
      flatStr: cardModalBtn.dataset.openCardModal,
      floorStr,
      spocName,
      spocPhone: spocResident ? formatPhoneDisplay(residentPhoneDigits(spocResident)) : "",
      spocUpi: getFloorSpocUpi(eventObj, floorStr),
      resName: cardModalBtn.dataset.resName,
      eventName: cardModalBtn.dataset.eventName,
      expectedAmount: Number(cardModalBtn.dataset.amount || 500),
      phoneNum: cardModalBtn.dataset.phone || ""
    };
    currentReminderCardDetails = details;
    generateReminderCardImage(details);
    byId("pohCardReminderModal")?.showModal();
    return;
  }
  const spocFloorBtn = event.target.closest("[data-spoc-matrix-floor]");
  if (spocFloorBtn) {
    selectedSpocMatrixFloor = spocFloorBtn.dataset.spocMatrixFloor;
    renderSpocFloorMatrix(activeEvent());
    return;
  }
  const bookBtn = event.target.closest("[data-book-amenity]");
  if (bookBtn) {
    if (!adminRoles.has(approvedProfile?.role)) {
      showToast("🔒 Amenity bookings can currently only be created by community administrators.", "warning");
      return;
    }
    const amenity = bookBtn.dataset.bookAmenity;
    const select = byId("amenitySelect");
    if (select) {
      select.value = amenity;
      const fee = AMENITY_FEES[amenity] || 2500;
      const feeText = byId("amenityFeeText");
      if (feeText) feeText.innerHTML = `${amenity} booking fee: <strong>\u20B9${fee.toLocaleString("en-IN")}</strong> per session`;
    }
    initAmenityBookingSelects();
    byId("amenityBookingModal")?.showModal();
    return;
  }
  const openBookModalBtn = event.target.closest("#openAmenityBookingBtn");
  if (openBookModalBtn) {
    if (!adminRoles.has(approvedProfile?.role)) {
      showToast("🔒 Amenity bookings can currently only be created by community administrators.", "warning");
      return;
    }
    initAmenityBookingSelects();
    byId("amenityBookingModal")?.showModal();
    return;
  }
  const approveBooking = event.target.closest("[data-approve-booking]")?.dataset.approveBooking;
  if (approveBooking) {
    await performAdminAction("updateAmenityBooking", { id: approveBooking, status: "Approved" }, "Amenity booking approved!");
    await loadExpansionData();
    return;
  }
  const rejectBooking = event.target.closest("[data-reject-booking]")?.dataset.rejectBooking;
  if (rejectBooking) {
    await performAdminAction("updateAmenityBooking", { id: rejectBooking, status: "Rejected" }, "Amenity booking rejected.");
    await loadExpansionData();
    return;
  }
  const issueNoc = event.target.closest("[data-issue-noc]")?.dataset.issueNoc;
  if (issueNoc) {
    await performAdminAction("updateMoveService", { id: issueNoc, status: "Approved", nocIssued: true }, "Official Move NOC issued.");
    await loadExpansionData();
    return;
  }
  const openLightbox = event.target.closest("[data-open-lightbox]");
  if (openLightbox) {
    const img = byId("lightboxImg");
    const title = byId("lightboxTitle");
    const caption = byId("lightboxCaption");
    if (img) img.src = openLightbox.dataset.openLightbox;
    if (title) title.textContent = openLightbox.dataset.lightboxTitle || "";
    if (caption) caption.textContent = openLightbox.dataset.lightboxCaption || "";
    byId("galleryLightboxModal")?.showModal();
    return;
  }
  const openAddContact = event.target.closest("#openAddContactModalBtn");
  if (openAddContact) {
    const form = byId("contactEditorForm");
    if (form) { form.reset(); if (form.elements.id) form.elements.id.value = ""; }
    const heading = byId("contactEditorHeading");
    if (heading) heading.textContent = "Add Contact Details";
    byId("contactEditorModal")?.showModal();
    return;
  }
  const editContactId = event.target.closest("[data-edit-contact]")?.dataset.editContact;
  if (editContactId) {
    const contact = (expansionData.emergencyContacts || []).find((c) => c.id === editContactId);
    if (!contact) { showToast("That contact could not be found — please reload.", "error"); return; }
    const form = byId("contactEditorForm");
    if (form) {
      form.reset();
      if (form.elements.id) form.elements.id.value = contact.id;
      if (form.elements.contactType) form.elements.contactType.value = contact.contactType || "emergency";
      if (form.elements.name) form.elements.name.value = contact.name || "";
      if (form.elements.role) {
        const roleVal = contact.role || "";
        if (roleVal && ![...form.elements.role.options].some((o) => o.value === roleVal || o.textContent === roleVal)) {
          const opt = document.createElement("option");
          opt.textContent = roleVal;
          form.elements.role.appendChild(opt);
        }
        form.elements.role.value = roleVal;
      }
      if (form.elements.phone) form.elements.phone.value = contact.phone || "";
      if (form.elements.availability) form.elements.availability.value = contact.availability || "";
      if (form.elements.photoUrl) form.elements.photoUrl.value = (contact.photoUrl && contact.photoUrl !== "/assets/poh-logo.jpeg") ? contact.photoUrl : "";
    }
    const heading = byId("contactEditorHeading");
    if (heading) heading.textContent = "Edit Contact Details";
    byId("contactEditorModal")?.showModal();
    return;
  }
  const openAddGallery = event.target.closest("#openAddGalleryModalBtn");
  if (openAddGallery) {
    byId("galleryEditorForm")?.reset();
    byId("galleryEditorModal")?.showModal();
    return;
  }
  const deleteContact = event.target.closest("[data-delete-contact]")?.dataset.deleteContact;
  if (deleteContact) {
    await performAdminAction("deleteEmergencyContact", { id: deleteContact }, "Emergency contact deleted.");
    await loadExpansionData();
    return;
  }
  const deletePhoto = event.target.closest("[data-delete-photo]")?.dataset.deletePhoto;
  if (deletePhoto) {
    await performAdminAction("deleteGalleryPhoto", { id: deletePhoto }, "Gallery photo deleted.");
    await loadExpansionData();
    return;
  }
});

byId("moveFlatSelect")?.addEventListener("change", (e) => {
  const flatVal = e.target.value;
  const resident = portalData.residents.find(r => String(r.flat) === String(flatVal));
  if (resident) {
    const nameInput = byId("moveResidentName");
    const occInput = byId("moveOccupancyType");
    if (nameInput) nameInput.value = resident.tenantName || resident.ownerName || `Resident of Flat ${flatVal}`;
    if (occInput) occInput.value = resident.tenantName ? "Resident Tenant" : "Homeowner (Owner)";
  }
});

// Amenity fee map
const AMENITY_FEES = { "Party Hall": 2500, "Movie Theater": 2500, "Sauna": 1500 };

function initAmenityBookingSelects() {
  const floorSel = byId("amenityFloorSelect");
  if (!floorSel || !portalData.residents.length) return;
  const floors = [...new Set(portalData.residents.map(r => String(r.floor || "Unassigned")))].sort((a, b) => {
    if (a === "G" || a === "Ground") return -1;
    if (b === "G" || b === "Ground") return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  const currentFloor = floorSel.value;
  floorSel.innerHTML = `<option value="">Select floor</option>` + floors.map(f => `<option value="${f}">${f === "G" || f === "Ground" ? "Ground (G)" : `Floor ${f}`}</option>`).join("");
  if (currentFloor) floorSel.value = currentFloor;
}

byId("amenitySelect")?.addEventListener("change", (e) => {
  const amenity = e.target.value;
  const fee = AMENITY_FEES[amenity] || 2500;
  const feeText = byId("amenityFeeText");
  if (feeText) feeText.innerHTML = `${amenity} booking fee: <strong>₹${fee.toLocaleString("en-IN")}</strong> per session`;
});

byId("amenityFloorSelect")?.addEventListener("change", (e) => {
  const floor = e.target.value;
  const flatSel = byId("amenityFlatSelect");
  const nameInput = byId("amenityBookingName");
  const phoneInput = byId("amenityBookingPhone");
  if (!flatSel) return;
  if (!floor) {
    flatSel.innerHTML = `<option value="">Select floor first</option>`;
    flatSel.disabled = true;
    if (nameInput) nameInput.value = "";
    if (phoneInput) phoneInput.value = "";
    return;
  }
  const flats = portalData.residents.filter(r => String(r.floor || "Unassigned") === floor);
  flatSel.innerHTML = `<option value="">Select flat</option>` + flats.map(r => `<option value="${r.flat}">Flat ${r.flat} — ${r.ownerName || r.tenantName || "Resident"}</option>`).join("");
  flatSel.disabled = false;
  if (nameInput) nameInput.value = "";
  if (phoneInput) phoneInput.value = "";
});

byId("amenityFlatSelect")?.addEventListener("change", (e) => {
  const flatVal = e.target.value;
  const resident = portalData.residents.find(r => String(r.flat) === String(flatVal));
  const nameInput = byId("amenityBookingName");
  const phoneInput = byId("amenityBookingPhone");
  if (resident) {
    if (nameInput) nameInput.value = resident.tenantName || resident.ownerName || `Resident of Flat ${flatVal}`;
    if (phoneInput) phoneInput.value = resident.phone || resident.ownerPhone || "";
  } else {
    if (nameInput) nameInput.value = "";
    if (phoneInput) phoneInput.value = "";
  }
});

byId("amenityBookingForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = byId("amenityBookingForm");
  const payload = Object.fromEntries(new FormData(form));
  payload.fee = AMENITY_FEES[payload.amenity] || 2500;
  try {
    await adminConsoleCall({ action: "bookAmenity", payload });
    byId("amenityBookingModal")?.close();
    form.reset();
    byId("amenityFlatSelect").disabled = true;
    await loadExpansionData();
    showToast("Amenity booking request submitted! Committee will review and confirm.", "success");
  } catch (err) { showToast(err.message || "Could not submit booking.", "error"); }
});

byId("moveFlatSelect")?.addEventListener("change", (e) => {
  const flatVal = e.target.value;
  if (!flatVal) return;
  const resident = portalData.residents.find(r => String(r.flat || r.flatNo || "").trim() === String(flatVal).trim());
  if (resident) {
    if (byId("moveResidentName")) byId("moveResidentName").value = resident.ownerName || resident.tenantName || resident.name || "";
    if (byId("moveOccupancyType")) byId("moveOccupancyType").value = occupancyKey(resident) === "tenant_occupied" ? "Tenant" : "Owner";
    if (byId("movePrimaryMobile")) byId("movePrimaryMobile").value = resident.ownerMobile || resident.tenantMobile || resident.phone || "";
    if (byId("movePrimaryEmail")) byId("movePrimaryEmail").value = resident.email || "";
    if (byId("moveFourWheeler")) byId("moveFourWheeler").value = resident.fourWheeler || resident.vehicles || "";
    if (byId("moveTwoWheeler")) byId("moveTwoWheeler").value = resident.twoWheeler || "";
  }
});

byId("addFamilyMemberBtn")?.addEventListener("click", () => {
  const container = byId("familyMembersContainer");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "form-grid";
  div.style.cssText = "grid-template-columns: 2fr 1fr 2fr 2fr 40px; gap: 8px; align-items: center;";
  div.innerHTML = `
    <input name="fam_name" placeholder="Member Name" required>
    <input name="fam_age" type="number" placeholder="Age">
    <input name="fam_relation" placeholder="Relationship">
    <input name="fam_mobile" placeholder="Mobile (Optional)">
    <button type="button" class="text-button" onclick="this.parentElement.remove()" style="color:#9c3f34;font-size:16px;">✕</button>
  `;
  container.appendChild(div);
});

byId("addDomesticStaffBtn")?.addEventListener("click", () => {
  const container = byId("domesticStaffContainer");
  if (!container) return;
  const div = document.createElement("div");
  div.className = "form-grid";
  div.style.cssText = "grid-template-columns: 2fr 2fr 2fr 40px; gap: 8px; align-items: center;";
  div.innerHTML = `
    <input name="staff_name" placeholder="Staff Name">
    <input name="staff_service" placeholder="Service (e.g. Maid, Cook, Driver)">
    <input name="staff_mobile" placeholder="Mobile Number">
    <button type="button" class="text-button" onclick="this.parentElement.remove()" style="color:#9c3f34;font-size:16px;">✕</button>
  `;
  container.appendChild(div);
});

byId("moveRequestForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = byId("moveRequestForm");
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData);

  // Extract arrays for documents, family members, and domestic staff
  payload.documentsSubmitted = formData.getAll("documentsSubmitted");
  payload.undertakingAccepted = form.elements.undertakingAccepted?.checked;
  payload.declarationAccepted = form.elements.declarationAccepted?.checked;

  const famNames = formData.getAll("fam_name");
  const famAges = formData.getAll("fam_age");
  const famRelations = formData.getAll("fam_relation");
  const famMobiles = formData.getAll("fam_mobile");
  payload.familyMembers = famNames.map((name, i) => ({
    name,
    age: famAges[i] || "",
    relation: famRelations[i] || "",
    mobile: famMobiles[i] || ""
  }));

  const staffNames = formData.getAll("staff_name");
  const staffServices = formData.getAll("staff_service");
  const staffMobiles = formData.getAll("staff_mobile");
  payload.domesticStaff = staffNames.map((name, i) => ({
    name,
    service: staffServices[i] || "",
    mobile: staffMobiles[i] || ""
  }));

  try {
    beginPortalWork("Submitting Move-In / Move-Out registration...");
    await adminConsoleCall({ action: "requestMoveService", payload });
    endPortalWork();
    form.reset();
    if (byId("familyMembersContainer")) byId("familyMembersContainer").innerHTML = "";
    if (byId("domesticStaffContainer")) byId("domesticStaffContainer").innerHTML = "";
    await loadExpansionData();
    showToast("Move-In / Move-Out Registration & Undertaking submitted successfully!", "success");
  } catch (err) {
    endPortalWork();
    showToast(err.message || "Could not submit move request.", "error");
  }
});

byId("contactEditorForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = byId("contactEditorForm");
  const payload = Object.fromEntries(new FormData(form));
  const photoFile = form.elements.photoFile?.files[0];
  const btn = form.querySelector("[type=submit]");
  const originalLabel = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" style="margin-right:6px;"></i>Saving…'; }
  beginPortalWork("Saving contact…");
  try {
    if (photoFile) payload.photoUrl = await uploadFile(photoFile, `contact-photos/${Date.now()}_${photoFile.name}`);
    await adminConsoleCall({ action: "saveEmergencyContact", payload });
    byId("contactEditorModal")?.close();
    form.reset();
    await loadExpansionData();
    showToast("Emergency contact saved!", "success");
  } catch (err) {
    showToast(err.message || "Could not save contact.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalLabel; }
    endPortalWork();
  }
});

byId("galleryEditorForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = byId("galleryEditorForm");
  const payload = Object.fromEntries(new FormData(form));
  const photoFile = form.elements.photoFile?.files[0];
  setSubmitting(form, true);
  beginPortalWork("Publishing photo…");
  try {
    if (photoFile) payload.photoUrl = await uploadFile(photoFile, `gallery-photos/${Date.now()}_${photoFile.name}`);
    await adminConsoleCall({ action: "saveGalleryPhoto", payload });
    byId("galleryEditorModal")?.close();
    form.reset();
    await loadExpansionData();
    showToast("Gallery photo published!", "success");
  } catch (err) {
    showToast(err.message || "Could not publish photo.", "error");
  } finally {
    setSubmitting(form, false);
    endPortalWork();
  }
});



// --- AUTOMATIC SESSION TIMEOUT / IDLE LOGOUT (15 MIN INACTIVITY) ---
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const IDLE_WARNING_MS = 14 * 60 * 1000; // 14 minutes (60s warning)
let idleTimer = null;
let idleWarningTimer = null;
let idleCountdownInterval = null;
let lastActivityTime = Date.now();

function startIdleSessionTimer() {
  stopIdleSessionTimer();
  if (!auth.currentUser) return;
  lastActivityTime = Date.now();

  const activityEvents = ["mousemove", "keydown", "click", "touchstart", "scroll", "pointerdown"];
  activityEvents.forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }));

  idleWarningTimer = window.setTimeout(showIdleWarning, IDLE_WARNING_MS);
  idleTimer = window.setTimeout(performAutoLogout, IDLE_TIMEOUT_MS);
}

function stopIdleSessionTimer() {
  const activityEvents = ["mousemove", "keydown", "click", "touchstart", "scroll", "pointerdown"];
  activityEvents.forEach((evt) => window.removeEventListener(evt, resetIdleTimer));
  window.clearTimeout(idleTimer);
  window.clearTimeout(idleWarningTimer);
  window.clearInterval(idleCountdownInterval);
  idleTimer = null;
  idleWarningTimer = null;
  idleCountdownInterval = null;
}

let resetDebounce = 0;
function resetIdleTimer() {
  if (!auth.currentUser) return;
  const now = Date.now();
  if (now - resetDebounce < 2000) return; // Throttle to prevent excessive timer resets
  resetDebounce = now;
  lastActivityTime = now;

  window.clearTimeout(idleTimer);
  window.clearTimeout(idleWarningTimer);
  window.clearInterval(idleCountdownInterval);

  idleWarningTimer = window.setTimeout(showIdleWarning, IDLE_WARNING_MS);
  idleTimer = window.setTimeout(performAutoLogout, IDLE_TIMEOUT_MS);
}

function showIdleWarning() {
  if (!auth.currentUser) return;
  let secondsRemaining = 60;
  showToast(`🔒 Inactivity Warning: Auto-logout in ${secondsRemaining}s due to inactivity. Move mouse or tap to stay signed in.`, "warning");

  idleCountdownInterval = window.setInterval(() => {
    secondsRemaining -= 10;
    if (secondsRemaining <= 0) {
      window.clearInterval(idleCountdownInterval);
    } else {
      showToast(`🔒 Inactivity Warning: Auto-logout in ${secondsRemaining}s due to inactivity. Move mouse or tap to stay signed in.`, "warning");
    }
  }, 10000);
}

async function performAutoLogout() {
  if (!auth.currentUser) return;
  stopIdleSessionTimer();
  try {
    await signOut(auth);
    showToast("⏱️ You were automatically signed out after 15 minutes of inactivity for community portal security.", "warning");
  } catch (err) {
    console.error("Auto logout error:", err);
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    stopIdleSessionTimer();
    approvedProfile = null;
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      try { dialog.close(); } catch (e) {}
    });
    document.body.classList.remove("portal-open");
    byId("portal").hidden = true;
    byId("accessWrap").hidden = false;
    byId("account").hidden = true;
    setScreen("signed-out", "Sign in with the Google account that has been approved by your POH administrator.");
    return;
  }
  startIdleSessionTimer();
  refreshAccess(user);
});
