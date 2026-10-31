// TDD 5.3: POST /api/jobs at 100 files x 20 folders under 200 virtual
// users must hold p99 < 500 ms.
//
// Run: pnpm perf:jobs  (inside the docbridge docker network; api:3000)
// Requires `pnpm perf:seed` first — each iteration consumes 100 staged
// file rows, so `iterations` is bounded by the seeded pool.

import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import exec from "k6/execution";
import { Trend } from "k6/metrics";
import { API_URL, authHeaders, login, meta } from "./lib.js";

// One comma-separated line of 100 staged file ids per iteration.
const chunks = new SharedArray("chunks", () =>
  open("/perf/chunks.txt").trim().split("\n"),
);

const submitDuration = new Trend("submit_job_duration", true);

// Default: saturating shared-iterations at VUS virtual users (the TDD
// wording). RATE=<n> switches to constant-arrival-rate instead, to measure
// the request rate the budget still holds at on this hardware.
const rate = Number(__ENV.RATE || 0);
const scenario = rate
  ? {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration: __ENV.DURATION || "50s",
      preAllocatedVUs: 50,
      maxVUs: 400,
    }
  : {
      executor: "shared-iterations",
      vus: Number(__ENV.VUS || 200),
      iterations: Math.min(Number(__ENV.ITERATIONS || meta.iterations), chunks.length),
      maxDuration: "20m",
    };

export const options = {
  scenarios: { submit: scenario },
  thresholds: {
    submit_job_duration: ["p(99)<500"],
    checks: ["rate==1.0"],
  },
};

export function setup() {
  return login();
}

export default function (data) {
  const idx = exec.scenario.iterationInTest;
  if (idx >= chunks.length) return; // arrival-rate can overrun the pool
  const fileIds = chunks[idx].split(",");
  const body = JSON.stringify({
    mappings: fileIds.map((fileId) => ({ fileId, folderIds: meta.folderIds })),
  });
  const res = http.post(`${API_URL}/api/jobs`, body, {
    ...authHeaders(data.token),
    tags: { name: "POST /api/jobs" },
  });
  submitDuration.add(res.timings.duration);
  check(res, {
    "status 202": (r) => r.status === 202,
  });
}
