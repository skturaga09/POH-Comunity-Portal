// POH Community Portal — build step (esbuild)
//
// Sources live in `src/`; the deployable site is generated into `public/`.
//   - Bundles + minifies src/portal-launcher.js  -> public/portal-launcher.js
//   - Keeps the Firebase CDN imports (https://...) as runtime ESM imports so
//     the strict CSP (`script-src 'self' https://www.gstatic.com`) still holds.
//   - Copies the static files (portal-config.js, assets/) across unchanged.
//   - Stamps a content hash onto the launcher <script> in index.html, so a new
//     build automatically busts the cache (replaces the manual ?v=YYYYMMDD).
//
// Usage:  node build.mjs          (one-shot)
//         node build.mjs --watch  (rebuild on change, for local dev)

import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, "src");
const OUT = path.join(ROOT, "public");
const WATCH = process.argv.includes("--watch");

// Leave https:// (Firebase CDN) imports untouched — do not try to bundle them.
const externalHttps = {
  name: "external-https",
  setup(build) {
    build.onResolve({ filter: /^https?:\/\// }, (args) => ({ path: args.path, external: true }));
  },
};

// After each successful JS build, hash the output and regenerate index.html.
const finalize = {
  name: "finalize",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length) return;
      const js = await readFile(path.join(OUT, "portal-launcher.js"));
      const hash = createHash("sha256").update(js).digest("hex").slice(0, 8);
      const html = await readFile(path.join(SRC, "index.html"), "utf8");
      const stamped = html.replace(/portal-launcher\.js(?:\?v=[^"']*)?/g, `portal-launcher.js?v=${hash}`);
      await writeFile(path.join(OUT, "index.html"), stamped);
      console.log(`✓ built  public/portal-launcher.js  (${(js.length / 1024).toFixed(0)} KB, ?v=${hash})`);
    });
  },
};

async function copyStatic() {
  await cp(path.join(SRC, "portal-config.js"), path.join(OUT, "portal-config.js"));
  await cp(path.join(SRC, "theme-init.js"), path.join(OUT, "theme-init.js"));
  await cp(path.join(SRC, "assets"), path.join(OUT, "assets"), { recursive: true });
  // PWA / mobile-wrapper assets.
  await cp(path.join(SRC, "manifest.webmanifest"), path.join(OUT, "manifest.webmanifest"));
  await cp(path.join(SRC, "sw.js"), path.join(OUT, "sw.js"));
  await cp(path.join(SRC, "privacy.html"), path.join(OUT, "privacy.html"));
  await cp(path.join(SRC, ".well-known"), path.join(OUT, ".well-known"), { recursive: true });
}

const options = {
  entryPoints: [path.join(SRC, "portal-launcher.js")],
  outfile: path.join(OUT, "portal-launcher.js"),
  bundle: true,
  format: "esm",
  target: ["es2020"],
  minify: true,
  charset: "utf8",
  legalComments: "none",
  sourcemap: true,
  plugins: [externalHttps, finalize],
};

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await copyStatic();

if (WATCH) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching src/ for changes… (Ctrl+C to stop)");
} else {
  await esbuild.build(options);
}
