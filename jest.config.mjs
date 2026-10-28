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
      },
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
  ],
};
