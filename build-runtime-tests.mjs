// build-runtime-tests.mjs — bundles the two test entries for Node execution,
// aliasing 'obsidian' to the local CJS stub (the real module is types-only on
// npm and is injected by the Obsidian app at runtime).
//
//   test-runtime-fixes.ts → test-runtime-bundle.cjs  (queue/atomic-write fixes)
//   test-extraction.ts    → test-e2e-bundle.cjs      (pdf.js extraction E2E)
//
// The bundles are CommonJS output and package.json declares "type": "module",
// so they use the .cjs extension (same as test-obsidian-stub.cjs).
//
// NOTE: the pdfjs compliance patches are applied to node_modules by
// scripts/patch-pdfjs.mjs (postinstall + npm run build/dev/test), so the
// test bundles pick them up automatically — no patching here.
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const common = {
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "node18",
  alias: { obsidian: path.join(ROOT, "test-obsidian-stub.cjs") },
  // Node built-ins used by the test harness itself — kept external so the
  // CJS bundle requires them at runtime (the bundles run in plain Node).
  external: ["fs", "path", "url"],
  logLevel: "warning",
};

const results = await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, "test-runtime-fixes.ts")],
    outfile: path.join(ROOT, "test-runtime-bundle.cjs"),
  }),
  esbuild.build({
    ...common,
    entryPoints: [path.join(ROOT, "test-extraction.ts")],
    outfile: path.join(ROOT, "test-e2e-bundle.cjs"),
  }),
]);

if (results.some((r) => r.errors.length > 0)) process.exit(1);
console.log("test bundles built: test-runtime-bundle.cjs, test-e2e-bundle.cjs");
