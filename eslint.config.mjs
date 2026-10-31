import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/",
      "**/coverage/",
      "**/generated/",
      "**/cdk.out/",
      "docs/",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, __API_BASE__: "readonly" },
    },
  },
  {
    files: ["tests/perf/**/*.js"],
    languageOptions: {
      globals: { open: "readonly", __ENV: "readonly" },
    },
  },
  prettier,
);
