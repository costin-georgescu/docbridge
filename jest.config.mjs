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
  ],
};
