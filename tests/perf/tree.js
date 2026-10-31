// TDD 5.3: GET /tree at 50 teams must hold p95 < 1 s.
//
// Run: pnpm perf:tree  (inside the docbridge docker network; platform:3002)
// Requires `pnpm perf:seed` first — the perf user is a member of 50 teams.

import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";
import { PLATFORM_URL, authHeaders, login } from "./lib.js";

const treeDuration = new Trend("tree_duration", true);

export const options = {
  scenarios: {
    tree: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || "1m",
    },
  },
  thresholds: {
    tree_duration: ["p(95)<1000"],
    checks: ["rate==1.0"],
  },
};

export function setup() {
  return login();
}

export default function (data) {
  const res = http.get(`${PLATFORM_URL}/tree`, {
    ...authHeaders(data.token),
    tags: { name: "GET /tree" },
  });
  treeDuration.add(res.timings.duration);
  check(res, {
    "status 200": (r) => r.status === 200,
    "50 teams": (r) => {
      const teams = r.json("teams");
      return Array.isArray(teams) && teams.length === 50;
    },
  });
}
