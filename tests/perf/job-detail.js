// Job detail poll load: 200 viewers polling a 2,000-task job every ~3 s.
// Each iteration mirrors the web client — one summary poll plus one page of
// tasks. Before the counts/pagination split this same poll returned all
// 2,000 task rows per viewer.
//
// Run: pnpm perf:job-detail  (inside the docbridge docker network; api:3000)
// Requires `pnpm perf:seed` first — manifest.json carries the seeded jobId.

import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";
import { API_URL, authHeaders, login, meta } from "./lib.js";

const detailDuration = new Trend("job_detail_duration", true);
const tasksDuration = new Trend("job_tasks_duration", true);

export const options = {
  scenarios: {
    poll: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 200),
      duration: __ENV.DURATION || "1m",
    },
  },
  thresholds: {
    job_detail_duration: ["p(95)<500"],
    job_tasks_duration: ["p(95)<500"],
    checks: ["rate==1.0"],
  },
};

export function setup() {
  return login();
}

export default function (data) {
  const detail = http.get(`${API_URL}/api/jobs/${meta.jobId}`, {
    ...authHeaders(data.token),
    tags: { name: "GET /api/jobs/:id" },
  });
  detailDuration.add(detail.timings.duration);
  check(detail, {
    "status 200": (r) => r.status === 200,
    "summary only": (r) =>
      r.json("tasks") === undefined && r.json("counts") !== undefined,
  });

  const tasks = http.get(`${API_URL}/api/jobs/${meta.jobId}/tasks?limit=50`, {
    ...authHeaders(data.token),
    tags: { name: "GET /api/jobs/:id/tasks" },
  });
  tasksDuration.add(tasks.timings.duration);
  check(tasks, {
    "status 200": (r) => r.status === 200,
    "page of 50": (r) => r.json("items").length === 50,
  });

  sleep(3);
}
