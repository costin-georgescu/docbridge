const tsTransform = [
  "ts-jest",
  { tsconfig: "<rootDir>/tsconfig.test.json", diagnostics: true },
];

/** @type {import("jest").Config} */
export default {
  projects: [
    {
      displayName: "contracts",
      rootDir: "packages/contracts",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
    },
    {
      displayName: "config",
      rootDir: "packages/config",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
    },
    {
      displayName: "auth-core",
      rootDir: "packages/auth-core",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
      moduleNameMapper: {
        "^@docbridge/contracts$":
          "<rootDir>/../../packages/contracts/src/index.ts",
      },
    },
    {
      displayName: "storage",
      rootDir: "packages/storage",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
    },
    {
      displayName: "infra",
      rootDir: "infra",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
    },
    {
      displayName: "api",
      rootDir: "apps/api",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
      moduleNameMapper: {
        "^@docbridge/contracts$":
          "<rootDir>/../../packages/contracts/src/index.ts",
        "^@docbridge/config$": "<rootDir>/../../packages/config/src/index.ts",
        "^@docbridge/auth-core$":
          "<rootDir>/../../packages/auth-core/src/index.ts",
        "^@docbridge/db-docbridge$":
          "<rootDir>/../../packages/db-docbridge/dist/index.js",
        "^@docbridge/storage$": "<rootDir>/../../packages/storage/src/index.ts",
      },
      setupFiles: ["<rootDir>/test/setup.ts"],
    },
    {
      displayName: "dispatcher",
      rootDir: "apps/dispatcher",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
      moduleNameMapper: {
        "^@docbridge/contracts$":
          "<rootDir>/../../packages/contracts/src/index.ts",
        "^@docbridge/config$": "<rootDir>/../../packages/config/src/index.ts",
        "^@docbridge/db-docbridge$":
          "<rootDir>/../../packages/db-docbridge/dist/index.js",
        "^@docbridge/storage$": "<rootDir>/../../packages/storage/src/index.ts",
      },
      setupFiles: ["<rootDir>/test/setup.ts"],
    },
    {
      displayName: "auth",
      rootDir: "apps/auth",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
      moduleNameMapper: {
        "^@docbridge/contracts$":
          "<rootDir>/../../packages/contracts/src/index.ts",
        "^@docbridge/config$": "<rootDir>/../../packages/config/src/index.ts",
        "^@docbridge/db-auth$":
          "<rootDir>/../../packages/db-auth/dist/index.js",
      },
      setupFiles: ["<rootDir>/test/setup.ts"],
    },
    {
      displayName: "web",
      rootDir: "apps/web",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts", "**/*.test.tsx"],
      transform: { "^.+\\.tsx?$": tsTransform },
      moduleNameMapper: {
        "^@docbridge/contracts$":
          "<rootDir>/../../packages/contracts/src/index.ts",
      },
      globals: { __API_BASE__: "" },
    },
    {
      displayName: "platform",
      rootDir: "apps/platform",
      testEnvironment: "node",
      testMatch: ["**/*.test.ts"],
      transform: { "^.+\\.tsx?$": tsTransform },
      moduleNameMapper: {
        "^@docbridge/contracts$":
          "<rootDir>/../../packages/contracts/src/index.ts",
        "^@docbridge/config$": "<rootDir>/../../packages/config/src/index.ts",
        "^@docbridge/auth-core$":
          "<rootDir>/../../packages/auth-core/src/index.ts",
        "^@docbridge/db-platform$":
          "<rootDir>/../../packages/db-platform/dist/index.js",
      },
      setupFiles: ["<rootDir>/test/setup.ts"],
    },
  ],
};
