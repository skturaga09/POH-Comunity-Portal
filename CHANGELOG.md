# POH Community Portal — Change Log

A running summary of features and fixes. Newest work at the top.

---

## Recent updates

### Access & directory
- **Auto-provision portal access from the directory.** Owner/tenant/family emails on a flat automatically get a resident `accessInvites` record — on every directory save (ongoing) and via a one-time backfill. New helper: `syncDirectoryAccess()` in `functions/index.js`; admin action `backfillDirectoryAccess`.
- **Email privacy in the directory.** `directoryRecord()` now hides other flats' email addresses from non-admin/committee residents; a resident still sees their own flat's emails; admins/committee see all. Phones remain masked as before.
- **Users & Permissions pagination.** The 150+ user list is paginated (25/page, Prev/Next + "showing X–Y of N"); search and the role/status filters reset to page 1.
- **Full-profile edit is locked to Homeowners + admin/committee.** Owner match is by owner emails / `residentType === "Owner"` (closed a hole where a tenant with a matching profile flat could edit the whole flat).

### Vehicles
- **Vehicle numbers stored in uppercase** (e.g. `KA52 DA1234`) on save, in the UI as you type, and via a one-time `normalizeVehicleNumbers` backfill for existing data.
- **Residents can self-update their own vehicles.** New `updateOwnVehicles` action + a lightweight "Update my vehicles" modal for any resident tied to a flat (owner, tenant, or family email). It only touches the vehicle list — no other flat fields.
- **Parking allocation no longer blocks vehicle entry** (parking is not yet allotted by the builder).
- **Expanded admin directory search** — matches phone, email, vehicle number, parking level/slot, caretaker/family names (previously only name/flat/floor/occupancy).
- **Residents can see their own flat's vehicles & parking.** `directoryRecord()` now reveals a resident's own-flat vehicles/parking (previously stripped for all non-admins), fixing "Not recorded" showing on their own profile and enabling the reminder below.
- **Home-page reminder for residents with no vehicles on file.** An amber card with a one-click "Add my vehicle" (opens the editor pre-set to their flat); dismissible per session; disappears once a vehicle is added; never shown to residents without a matched flat or who already have vehicles.
- **Admin "Vehicle details on file: N/147" stat** on the admin metrics row — computed live from the directory data, so it climbs automatically as adoption grows. (As of writing: only ~5/147 flats had vehicles, 0 via self-service — hence the reminder.)

### Finance (events)
- **Contributions & expenses are restricted to the floor SPOC or an admin** at both layers (backend `recordContribution`/`recordExpense` + the frontend Add buttons). Ordinary residents can view the finance dashboard but not add entries.
- **Multiple receipts per expense entry.** Split payments (advance + balance across UPI/Cash/Bank) can attach several receipts to one expense. Stored as a `receiptUrls[]` array (backward compatible with the old single `receiptUrl`). The form accepts multiple files; the viewer is a carousel with large on-image ‹ / › arrows, a bottom "1 / 3" counter, and ← / → keyboard support. The review modal lists existing receipts and lets you add more.
- **Event Summary Report** now includes an **Uploaded Receipts** section (image thumbnails + inline PDF previews per expense), a receipt count in the WhatsApp summary, and a fixed **Print / PDF** that opens a clean printable window with the receipts enlarged for legibility.
- **Download full PDF (with receipts)** — a new `generateEventReport` Cloud Function (pdf-lib) builds a single PDF: a redrawn summary (KPIs + itemized approved-expense ledger) with **every approved receipt merged in as real pages** — images embedded, PDF receipts' pages copied in, unfetchable/Drive links added as a labelled link page. Finance/admin-gated; saved to `event-reports/` in Storage and returned as a download URL. Guardrails: 60 receipts / 25 MB cap.

### Emergency contacts & daily helpers
- **Fixed a render bug** where the contacts page hung on "Loading…" (the render function was never called).
- **Edit provision added** — each saved contact now has an Edit button that opens the editor pre-filled (the backend already supported edits; the UI didn't wire it).
- **Bigger, square photos** (rounded corners) with details beside them.
- **New "Daily Helpers" section** (housekeeping, gardeners, security, milkman/newspaper) — a `contactType` field distinguishes them from emergency services; phone is optional for daily helpers.

### Community feedback
- **Feedback & Ideas board** (`feedbackHub` callable): residents submit feature requests / bugs / improvements, support-vote (one per resident), and comment in threads; optional anonymous posting (author hidden from residents, visible to moderators); a 1–5 experience rating with community average; admin/committee moderation (status + official response) and an analytics overview.

### Complaints & Helpdesk (PREVIEW ONLY)
- Repurposed the Maintenance page into an **interactive preview** of the future complaints/ticketing system — residents can explore the form and see sample tickets, but **nothing is submitted and no workflow runs**.
- The resident's **flat auto-loads read-only** from their profile.
- **Agreed ticket-ID format for the real backend: `POH-<FLAT>-NNNN`** (common-area = `POH-COMMON-NNNN`). The preview already uses this.
- Deferred backend plan: `ticketHub` callable, category→Emergency-Contact auto-routing, lifecycle Open→Assigned→In progress→Resolved→Closed (+Reopen/Cancel), admin/committee-managed first (technician logins later), resident tracking + resolution rating, admin/committee dashboard. Server must derive the flat from the authenticated user.

### Admin console & navigation
- **Top-nav "Admin console" dropdown collapsed to a single link.** The 10-item dropdown was taller than every other menu; now "Admin console" just opens the admin page.
- **All 10 workspaces are tabs on the admin page**, wrapping onto two rows (`flex-wrap`). Added the 4 that were previously dropdown-only (Manage Contacts, Amenity Approvals, Move NOCs, Upload Gallery) to the tab bar.
- **Fixed always-visible workspaces** — those 4 sections used to render stacked and always-on (they weren't in `switchAdminWorkspace`'s show/hide list); now every workspace is properly tab-switched (one visible at a time). Finance / Users tabs keep their role-gating.

### Platform / reliability
- **Fixed "Page Not Found" for deep links / refreshes** by adding a single-page-app catch-all rewrite (`** → /index.html`) in `firebase.json`, plus no-cache on HTML so users always get the latest shell. (Firebase deploys are atomic — this was a missing rewrite, not downtime.)
- **Fixed broken photo upload** — the contact & gallery forms called an undefined `uploadFile()`; added the helper and the missing Storage rules for `contact-photos/` and `gallery-photos/`.
- **Errors and the processing loader now render above modals** (Popover API top layer) instead of behind them, and admin forms show a disabled **"Saving…"** spinner while working.

---

## Architecture notes
- **Frontend:** `public/index.html` (markup + inline CSS) and `public/portal-launcher.js` (ES module; Firebase Auth/Firestore/Storage/Functions SDKs).
- **Backend:** `functions/index.js` — callables `portalAccess`, `adminConsole`, `feedbackHub`, `generateEventReport` (pdf-lib; builds the merged event PDF into `event-reports/`), plus the `importLegacySnapshot` HTTP endpoint. Region `asia-south1`. Dependency added: `pdf-lib`.
- **Security model:** Firestore/Storage rules deny direct browser access to sensitive collections; all reads/writes flow through callables that enforce role/ownership. Role sets are shared constants (`ADMIN_ROLES`, `FINANCE_ROLES`, `MODERATOR_ROLES`, `DIRECTORY_EDITOR_ROLES`) and mirrored on the frontend to avoid drift.
- **Deploy:** `firebase deploy --only functions,hosting,firestore:rules,storage` (use only the targets you changed). Deploys are atomic/zero-downtime. For risky changes, preview first with `firebase hosting:channel:deploy preview`.
