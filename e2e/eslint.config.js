// @ts-check
import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    name: "e2e/ignores",
    ignores: ["node_modules/**", "playwright-report/**", "test-results/**", "blob-report/**", "coverage/**", "tmp/**"],
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  {
    name: "e2e/typescript",
    files: ["**/*.ts"],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...tseslint.configs.stylistic,
    ],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // A page the fixtures in fixtures.ts never saw is missing from the coverage report, and
    // nothing else would notice.
    name: "e2e/specs-use-fixtures",
    files: ["tests/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@playwright/test",
              importNames: ["test", "expect"],
              message: "Import test and expect from '../fixtures.ts', which collects coverage.",
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        ...["newContext", "newPage"].map((property) => ({
          object: "browser",
          property,
          message: "Use the newSession fixture from '../fixtures.ts', which collects coverage.",
        })),
      ],
    },
  },
]);
