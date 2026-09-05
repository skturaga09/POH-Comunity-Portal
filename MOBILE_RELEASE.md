# POH Community Portal — Mobile release runbook

Turning the web app into Android + iOS apps. **Android first, iOS later.**

Key facts:
- **Web app (source of truth):** https://poh-community-portal.web.app
- **Package / App ID:** `app.poh.community` (permanent once published — same for Android & iOS)
- **Privacy policy URL:** https://poh-community-portal.web.app/privacy
- **Approach:** Android = **TWA** (Trusted Web Activity — the app runs your live site in a Chrome shell). This is chosen because the app's only login is **Google Sign-In**, and Google **blocks** OAuth inside embedded WebViews (Capacitor/WKWebView) — a TWA uses real Chrome, so sign-in "just works." iOS (later) = a Capacitor/WKWebView wrapper with **native** Google Sign-In, or a WebView shell.
- **Play account type:** **Personal**. ⚠️ A personal account must run a **closed test with ≥20 testers for 14 continuous days** before it can request **production** access. **Internal testing (up to 100 testers) is available immediately** and is how your current testers get the app first.

---

## ✅ Phase 0 — PWA prep (DONE, live in prod)
- `manifest.webmanifest`, service worker, 192/512/maskable icons, `/privacy`, `/.well-known/assetlinks.json` (placeholder fingerprint), iOS meta tags. App is installable.

## ✅ Phase 1 — Google Play developer account (DONE)
- Account created ($25 one-time, personal). Identity verification may still be pending — complete any prompts in Play Console.

---

## Phase 2 — Build & internally test the Android app

### 2a. Before you build — fill the privacy contact
Edit `src/privacy.html`, replace `REPLACE_WITH_ASSOCIATION_EMAIL` with the Association's real contact email. (Ask Claude to do this + redeploy.)

### 2b. Generate the Android package (PWABuilder — easiest, no local Android SDK)
1. Go to **https://www.pwabuilder.com** and enter `https://poh-community-portal.web.app`.
2. It scores the PWA (manifest + service worker should pass). Click **Package for stores → Android**.
3. In options set:
   - **Package ID:** `app.poh.community`
   - **App name:** POH Community Portal · **Short name:** POH Portal
   - **Signing key:** choose **"Create new"** (PWABuilder generates a keystore). **⚠️ Download and safely back up the keystore + passwords** — you need the SAME key for every future update, and it cannot be recovered if lost.
   - Leave "Fallback behavior = Custom Tabs" and the defaults.
4. Download the zip. It contains:
   - `app-release-signed.aab` (upload this to Play)
   - `signing.keystore` + a readme with **the SHA-256 fingerprint** and `assetlinks.json`.

(Alternative CLI: `npm i -g @bubblewrap/cli` then `bubblewrap init --manifest https://poh-community-portal.web.app/manifest.webmanifest` → `bubblewrap build`. Uses the local JDK in `tools/jdk`.)

### 2c. Create the app in Play Console + upload
1. Play Console → **Create app** → name "POH Community Portal", **App**, **Free**, accept declarations.
2. Left nav → **Testing → Internal testing → Create new release**.
3. Upload the **`.aab`**. Play enrolls it in **Play App Signing** automatically.
4. Save → review → **Roll out to internal testing**.

### 2d. Wire Digital Asset Links (removes the browser URL bar in the app)
1. In Play Console → **Setup → App integrity → App signing** → copy the **"SHA-256 certificate fingerprint"** of the **App signing key** (and the **upload key** too).
2. Give those fingerprint(s) to Claude → they go into `src/.well-known/assetlinks.json` (package `app.poh.community`), and Claude redeploys hosting.
   - It's fine to list **both** the app-signing and upload fingerprints in the array.
3. Verify: `https://poh-community-portal.web.app/.well-known/assetlinks.json` returns them, and the installed app opens with **no URL bar**.

### 2e. Invite your testers
1. Internal testing → **Testers** → add their emails (or a Google Group).
2. Share the **"Join on the web"** opt-in link. Testers tap it, accept, then install from Play. (They must use the same Google account that's approved in the Portal.)

### 2f. Store listing (needed before any public track; can prep during testing)
- Short description, full description, **app icon 512×512** (have it), **feature graphic 1024×500**, **phone screenshots** (≥2), category, **contact email**, **privacy policy URL** (above).
- **Data safety** form: declare you collect name, email, phone, and app activity, used for app functionality / account management, not shared with third parties, not sold. Encrypted in transit; users can request deletion.
- **Content rating** questionnaire.

### 2g. Path to production (personal account)
- Move from internal → **Closed testing** with **≥20 testers**, keep it running **14 days**, then Play unlocks the **"Apply for production access"** flow. Plan for 20 testers to reach the public Play Store.

---

## Phase 3 — iOS (later)
- **Apple Developer Program:** $99/year; needs your Apple ID + identity verification.
- Build with **Capacitor** (you have a Mac + Xcode) pointing at the web app, with **native Google Sign-In** (`@capacitor-firebase/authentication`) because embedded WebViews can't use Google OAuth directly. Register an **iOS app in Firebase** (get `GoogleService-Info.plist`) and add the reversed-client-ID URL scheme.
- Distribute test builds via **TestFlight** (up to 100 internal / 10k external testers), then submit for App Store review.

---

## Things only you can do (I can't)
- Operate PWABuilder / Play Console / Apple portals and download the keystore.
- **Back up the signing keystore + passwords** (critical — losing it means you can never update the app under the same listing).
- Complete identity/data-safety/content-rating forms.

## Things Claude can do
- Fill the privacy contact email, and the assetlinks SHA-256 fingerprint(s) + redeploy.
- Any web-app tweaks needed for mobile (already: manifest, SW, icons, iOS meta, localhost-only emulator gating so the wrapper never hits emulators).
