import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig(
  {
    // Mirrors .gitignore + build artifacts and BUILD TOOLING (not plugin
    // source, not part of the reviewable plugin code):
    ignores: [
      "node_modules/",
      "main.js",
      "main.js.map",
      "test.pdf",
      "test-runtime-bundle.cjs",
      "test-e2e-bundle.cjs",
      "*.log",
      ".DS_Store",
      // build/test tooling — not plugin source:
      "esbuild.mjs",
      "build-runtime-tests.mjs",
      "version-bump.mjs",
      "test-obsidian-stub.cjs",
      "scripts/",
    ],
  },
  // Official Obsidian plugin lint rules (obsidianmd/eslint-plugin):
  // core ESLint + typescript-eslint type-checked + Obsidian guidelines.
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"],
        },
      },
    },
  },
  {
    // Calibration for this codebase (~27k lines, predates the strict lint
    // setup): type-safety findings stay VISIBLE as warnings but do not
    // fail `npm run lint`. Obsidian-guideline rules remain errors and are
    // fixed in the source (static styles -> setCssStyles, no style-element
    // injection, no unsanitized innerHTML, Setting().setHeading(), ...).
    files: ["**/*.{ts,cts,mts,tsx}"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      "@typescript-eslint/prefer-promise-reject-errors": "warn",
    },
  },
);
