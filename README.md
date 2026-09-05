# POH Community Portal — Firebase

This folder is now the Firebase migration workspace. The existing Apps Script
portal remains live while the Firebase application is built and validated.

The target architecture is intentionally separate from Apps Script so the
Google Apps Script banner disappears and access can be enforced before any
portal data is shown:

```
Firebase Hosting → Firebase Authentication (Google) → Firestore user access record
                                                    ↘ Cloud Functions (roles, audits)
                                                     ↘ Cloud Storage (photos, receipts)
```

Only a `users/{uid}` record with `status: "active"` will be able to use the
new portal. Roles are enforced by Firestore and Storage rules; browsers cannot
grant their own role or mark themselves approved.

## One-time console action required now

The Firestore API needs to be enabled for this Firebase project before the
database can be created. Open this link while signed in as the project owner,
select **Enable**, and then reply `done`:

https://console.developers.google.com/apis/api/firestore.googleapis.com/overview?project=poh-community-portal

Once enabled, the database will be created in **Mumbai (`asia-south1`)** with
deletion protection enabled.

## Next console settings (after the database is created)

1. Firebase Console → **Authentication** → **Sign-in method** → enable
   **Google** and select the project support email.
2. Firebase Console → **Storage** → **Get started**. Keep the default bucket
   private; the checked-in `storage.rules` prevent public photos and receipts.
3. Firebase Console → Authentication → Settings → Authorized domains: verify
   `poh-community-portal.web.app` is present (it normally is by default).

Do not remove or change the existing Apps Script deployment until the Firebase
portal has been migrated and tested with a Super Admin account.

## Firebase resources and access model

- `firestore.rules`: deny-by-default access, approved users only.
- `storage.rules`: private resident-photo uploads and server-only receipts.
- `firestore.indexes.json`: place for composite indexes as the app is built.
- `functions/`: Cloud Functions (region `asia-south1`) — all sensitive reads
  and writes flow through callables that enforce role/ownership server-side.

## Project layout

Sources live in `src/`; the deployable site is **generated** into `public/` by
the build step. Never hand-edit `public/` — it is overwritten on every build
and is git-ignored.

```
src/                     hand-edited sources
  index.html             markup + inline CSS (the app shell)
  portal-launcher.js     the app (ES module; Firebase Auth/Firestore/Storage/Functions)
  portal-config.js       runtime config
  assets/                logo, hero image
build.mjs                esbuild build (bundle · minify · hash · stamp HTML)
public/                  GENERATED output that Firebase Hosting deploys (git-ignored)
functions/               Cloud Functions backend
firebase.json            hosting/rules config + predeploy build hook
```

## Build

Requires **Node 18+** and the Firebase CLI (`npm i -g firebase-tools`).

```bash
npm install        # first time only (installs esbuild)
npm run build      # one-shot build into public/
npm run watch      # rebuild on every save (local development)
```

The build (`build.mjs`) does four things:

1. **Bundles + minifies** `src/portal-launcher.js` into `public/portal-launcher.js`
   (~213 KB → ~142 KB).
2. Keeps the **Firebase CDN imports** (`https://www.gstatic.com/...`) external, so
   the strict Content-Security-Policy (`script-src 'self' https://www.gstatic.com`)
   is unchanged.
3. Copies the static files (`portal-config.js`, `assets/`) across unchanged.
4. **Content-hashes** the bundle and stamps it onto the launcher `<script>` in
   `index.html` (e.g. `portal-launcher.js?v=72c967d6`), so a new build busts the
   cache automatically — no more manual `?v=` bumping.

Source maps are generated for debugging but excluded from deploys (`**/*.map`).

## Deploy

First-time setup (creates the local `.firebaserc` project mapping):

```bash
firebase login
firebase use --add        # choose the poh-community-portal project
```

Then deploy hosting. **You do not need to build first** — a `predeploy` hook in
`firebase.json` runs `npm run build` automatically before every hosting deploy.

```bash
npm run deploy:staging    # build + push to a temporary staging preview URL
npm run deploy:prod       # build + release to production (poh-community-portal.web.app)
```

`npm run deploy:staging` is the safe place to run a full regression test — sign-in,
directory, finance, admin actions — before promoting to production. Firebase
hosting deploys are atomic and zero-downtime.

Backend and rules deploy separately (only when you change them):

```bash
npm run deploy:functions                          # Cloud Functions
firebase deploy --only firestore:rules,storage    # security rules
```

## Notes for the next maintainer

- **Edit in `src/`, never in `public/`.** `public/` is regenerated on every build.
- A fresh checkout needs `npm install` then `npm run build` before `public/` exists.
- Role sets (`ADMIN_ROLES`, `FINANCE_ROLES`, …) are currently mirrored in both the
  frontend and `functions/index.js` — change them in **both** places to avoid drift.
- See `CHANGELOG.md` for the running history of features and fixes.
