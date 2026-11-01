// Demo seed: realistic content for hands-on evaluation, on top of `db:seed`.
//
// Creates a `demo@docbridge.local` account, generates multi-page clinical
// trial documents (cover page, TOC, flowing sections — sizes in the
// 0.2-3 MB range of real submissions), writes them to demo-files/ for
// testers to upload, and seeds ~3 weeks of job history whose staged objects
// really exist in the staging bucket so job-detail downloads work.
// History includes a failed delivery (error drill-down in the UI) and a
// pending job the live dispatcher picks up and completes by itself.
// Re-running is safe: ids are deterministic and timestamps refresh so
// downloads stay inside the 32-day TTL.
//
// Requires `pnpm db:seed` (teams/folders/users). Locally LocalStack S3;
// on AWS the ECS SeedTask injects DB_* envs and the task role provides S3.

import { createClient as createAuthClient } from "@docbridge/db-auth";
import { createClient as createDocbridgeClient } from "@docbridge/db-docbridge";
import { createClient as createPlatformClient } from "@docbridge/db-platform";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { AwsCrc32c } from "@aws-crypto/crc32c";
import { dbUrl } from "./db-url";
import argon2 from "argon2";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const authUrl = dbUrl("AUTH");
const docbridgeUrl = dbUrl("DOCBRIDGE");
const platformUrl = dbUrl("PLATFORM");

// No endpoint means real AWS (credentials come from the ECS task role or the
// ambient AWS_* env vars). Locally .env sets AWS_ENDPOINT_URL to the compose
// network name, which the host-side seed rewrites to the published port.
const endpointEnv =
  process.env.DEMO_S3_ENDPOINT ?? process.env.AWS_ENDPOINT_URL;
const s3Endpoint = endpointEnv?.replace("localstack", "localhost");
const stagingBucket = process.env.STAGING_BUCKET ?? "docbridge-staging";
const platformBucket = process.env.PLATFORM_BUCKET ?? "docbridge-platform";
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "eu-central-1",
  ...(s3Endpoint && { endpoint: s3Endpoint, forcePathStyle: true }),
});

const DEMO_USER_ID = "00000000-0000-7000-8000-00000000d001";
const DEMO_PASSWORD = "password123";
const uuid = (n: number) =>
  `00000000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const fileId = (n: number) => uuid(0xd100 + n);
const jobId = (n: number) => uuid(0xd200 + n);
const taskId = (n: number) => uuid(0xd300 + n);
const docId = (n: number) => uuid(0xd500 + n);
const versionId = (n: number) => uuid(0xd600 + n);

// ---------------------------------------------------------------------------
// PDF document model + layout engine
// ---------------------------------------------------------------------------

type Block =
  | { h: 1 | 2 | 3; text: string } // section headings (h1 appears in the TOC)
  | { p: string } // wrapped paragraph
  | { li: string } // list item
  | { kv: string } // "Label: value" line
  | { fig: { kind: "bars" | "line"; caption: string } } // chart figure page
  | "gap"
  | "pb"; // explicit page break

interface DocSpec {
  n: number;
  fileName: string;
  title: string;
  meta: string[]; // cover-page lines
  blocks: Block[];
}

const esc = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

function wrap(text: string, width = 90): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && cur.length + w.length + 1 > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

// Procedurally drawn grayscale chart bitmap (like an embedded scan/figure).
function chartBitmap(kind: "bars" | "line", seed: number): Buffer {
  const w = 560;
  const h = 360;
  const px = Buffer.alloc(w * h, 255);
  const set = (x: number, y: number, v: number) => {
    if (x >= 0 && x < w && y >= 0 && y < h) px[y * w + x] = v;
  };
  const rnd = (i: number) => {
    const s = Math.sin(seed * 97 + i * 57) * 10000;
    return s - Math.floor(s);
  };
  // frame + axes
  for (let x = 50; x < w - 30; x++) set(x, h - 40, 0);
  for (let y = 20; y < h - 40; y++) set(50, y, 0);
  // gridlines
  for (let g = 1; g < 6; g++) {
    const gy = h - 40 - Math.round(((h - 70) * g) / 6);
    for (let x = 50; x < w - 30; x += 4) set(x, gy, 190);
  }
  const n = 12;
  const points: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const v = 0.1 + rnd(i) * 0.85;
    const y = h - 40 - Math.round(v * (h - 80));
    const x = 75 + i * 40;
    points.push([x, y]);
    if (kind === "bars") {
      for (let dx = 0; dx < 26; dx++) {
        for (let yy = h - 41; yy > y; yy--) set(x + dx, yy, 120);
      }
    }
  }
  if (kind === "line") {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(x0 + ((x1 - x0) * s) / steps);
        const y = Math.round(y0 + ((y1 - y0) * s) / steps);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) set(x + dx, y + dy, 0);
      }
    }
    for (const [x, y] of points) {
      for (let dx = -3; dx <= 3; dx++)
        for (let dy = -3; dy <= 3; dy++) set(x + dx, y + dy, 40);
    }
  }
  return px;
}

// Object numbering: 1=catalog, 2=pages, 3=/F1 regular, 4=/F2 bold,
// then one Page + one Contents object per page starting at 5; embedded
// chart images follow after the page objects.
function renderPdf(spec: {
  title: string;
  meta: string[];
  blocks: Block[];
}): Buffer {
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 800;
  const line = (
    text: string,
    opts: { f?: 1 | 2; s?: number; x?: number; lead?: number } = {},
  ) => {
    const { f = 1, s = 10, x = 60, lead } = opts;
    if (y < 60) flush();
    ops.push(`BT /F${f} ${s} Tf ${x} ${y} Td (${esc(text)}) Tj ET`);
    y -= lead ?? s + 3;
  };
  const flush = () => {
    if (ops.length) pages.push(ops);
    ops = [];
    y = 750;
  };

  // --- cover page ---
  y = 560;
  for (const m of spec.meta) line(m, { s: 11, x: 72, lead: 18 });
  y = 300;
  line("CONFIDENTIAL", { f: 2, s: 14, x: 72, lead: 20 });
  line("This document is property of DocBridge Clinical Research.", {
    s: 9,
    x: 72,
    lead: 13,
  });
  line("Reproduction or disclosure without authorisation is prohibited.", {
    s: 9,
    x: 72,
  });
  flush();

  // --- table of contents from h1 blocks ---
  const tocEntries = spec.blocks.filter(
    (b): b is { h: 1; text: string } => typeof b === "object" && "h" in b && b.h === 1,
  );
  line("CONTENTS", { f: 2, s: 14, lead: 26 });
  tocEntries.forEach((e, i) =>
    line(`${String(i + 1).padStart(3, " ")}  ${e.text}`, { s: 10, lead: 14 }),
  );
  flush();

  // --- body ---
  const figures: { name: string; bytes: Buffer }[] = [];
  const pageFigs = new Map<number, string[]>();
  for (const b of spec.blocks) {
    if (b === "gap") {
      y -= 8;
      continue;
    }
    if (b === "pb") {
      flush();
      continue;
    }
    if ("fig" in b) {
      flush(); // figures always get their own page
      const name = `Im${figures.length}`;
      figures.push({
        name,
        bytes: chartBitmap(b.fig.kind, figures.length + spec.title.length),
      });
      pageFigs.set(pages.length, [name]);
      ops.push(
        `BT /F2 11 Tf 60 750 Td (${esc(`Figure ${figures.length} - ${b.fig.caption}`)}) Tj ET`,
        `q 560 0 0 360 30 330 cm /${name} Do Q`,
      );
      flush();
      continue;
    }
    if ("h" in b) {
      if (y < 140) flush();
      y -= b.h === 1 ? 10 : 6;
      line(b.text, { f: 2, s: b.h === 1 ? 15 : b.h === 2 ? 12 : 11, lead: b.h === 1 ? 22 : 17 });
      y -= 2;
    } else if ("p" in b) {
      for (const l of wrap(b.p)) line(l, { s: 10, lead: 12.5 });
      y -= 7;
    } else if ("li" in b) {
      wrap(b.li, 84).forEach((l, i) =>
        line(i === 0 ? `- ${l}` : `  ${l}`, { s: 10, x: 68, lead: 12.5 }),
      );
      y -= 3;
    } else if ("kv" in b) {
      line(b.kv, { s: 10, x: 68, lead: 13 });
    }
  }
  flush();

  const total = pages.length;
  // Running header + footer on every page after the cover.
  const finalPages = pages.map((pageOps, i) => {
    const header =
      i === 0
        ? []
        : [
            `BT /F1 8 Tf 60 770 Td (${esc(spec.title)}) Tj ET`,
            `BT /F1 8 Tf 470 770 Td (Page ${i + 1} of ${total}) Tj ET`,
            `0.7 w 60 764 m 552 764 l S`,
          ];
    return [
      ...header,
      ...pageOps,
      `BT /F1 8 Tf 60 34 Td (DocBridge Clinical Research - CONFIDENTIAL) Tj ET`,
    ].join("\n");
  });

  const imgBase = 5 + total * 2;
  const objects: (string | Buffer)[] = new Array(
    4 + total * 2 + figures.length,
  );
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] =
    `<< /Type /Pages /Kids [${finalPages.map((_, i) => `${5 + i * 2} 0 R`).join(" ")}] /Count ${total} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>";
  finalPages.forEach((content, i) => {
    const pageObj = 5 + i * 2;
    const xobj = pageFigs
      .get(i)
      ?.map((name) => `${name} ${imgBase + Number(name.slice(2))} 0 R`)
      .join(" ");
    objects[pageObj - 1] =
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobj ? ` /XObject << ${xobj} >>` : ""} >> ` +
      `/Contents ${pageObj + 1} 0 R >>`;
    objects[pageObj] =
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  figures.forEach((fig, i) => {
    objects[imgBase - 1 + i] = Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 560 /Height 360 ` +
          `/BitsPerComponent 8 /ColorSpace /DeviceGray ` +
          `/Length ${fig.bytes.length} >>\nstream\n`,
        "latin1",
      ),
      fig.bytes,
      Buffer.from("\nendstream", "latin1"),
    ]);
  });

  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let pos = chunks[0].length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const head = Buffer.from(`${i + 1} 0 obj\n`, "latin1");
    const bodyBuf =
      typeof body === "string" ? Buffer.from(body, "latin1") : body;
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, bodyBuf, tail);
    pos += head.length + bodyBuf.length + tail.length;
  });
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    trailer += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  trailer +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${pos}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, "latin1"));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Clinical trial content builders — coherent, enumerated entities rather than
// shuffled filler, so sections read like the real artifacts.
// ---------------------------------------------------------------------------

const STUDY = "DBX-114";
const SPONSOR = "DocBridge Clinical Research";
const SITES = Array.from({ length: 12 }, (_, i) => `SITE-${101 + i}`);
const SITE_NAMES = [
  "Oncology Site A",
  "Cardiology Site B",
  "Central Regulatory",
  "University Hospital North",
  "Regional Medical Center East",
  "St. Anne Research Institute",
];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400_000));
// Deterministic pick so re-seeds generate identical prose.
const pick = <T>(arr: T[], i: number): T => arr[i % arr.length];

function protocolBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Amendment Summary" },
    {
      p: "This document describes Amendment 3 to the protocol for study " +
        `${STUDY}-ONC-014, a Phase II, randomized, open-label trial evaluating ` +
        `${STUDY} in combination with standard of care in subjects with ` +
        "advanced solid tumours. The amendment implements the dosing-schedule",
    },
    {
      p: "changes recommended by the Data Safety Monitoring Board (DSMB) at " +
        "its quarterly review on 15 September 2026, incorporates updated " +
        "stopping rules for hepatic adverse events, and corrects editorial " +
        "errors identified since Amendment 2.",
    },
    { h: 1, text: "2  Rationale for Amendment" },
    {
      p: "Following review of accumulating safety data from the first 64 " +
        "treated subjects, the DSMB noted a higher-than-anticipated incidence " +
        "of Grade 2 fatigue during cycles 1-3 in the every-14-day dosing arm. " +
        "A modified schedule with a 21-day cycle is expected to improve " +
        "tolerability without compromising exposure.",
    },
    {
      p: "In addition, four protocol deviations related to mis-timed PK " +
        "sampling prompted clarification of the sampling windows in the " +
        "Schedule of Assessments, and the laboratory manual has been aligned " +
        "with the revised collection times.",
    },
    { h: 1, text: "3  Summary of Changes" },
  ];
  const changeTopics = [
    "Dosing schedule changed from Q2W to Q3W",
    "PK sampling window widened from +/-15 to +/-30 minutes",
    "Criterion 9 added to the inclusion criteria",
    "Liver-function monitoring frequency increased to every cycle",
    "New stopping rule for ALT > 5x ULN",
    "Clarified contraception requirements for partners",
    "Updated prohibited-medication list",
    "Revised tumour assessment windows from +/-3 to +/-7 days",
  ];
  for (let i = 0; i < 90; i++) {
    b.push({
      h: 3,
      text: `3.${i + 1}  Section ${4 + Math.floor(i / 8)}.${(i % 8) + 1} - ${pick(changeTopics, i)}`,
    });
    b.push({
      p:
        `Previous text: ${pick(changeTopics, i + 3).toLowerCase()} as described ` +
        `in Amendment 2. Revised text: the requirement now reads that ` +
        `${pick(changeTopics, i).toLowerCase()}, effective for all subjects ` +
        `enrolled after the approval date of this amendment. Sites already ` +
        "treating subjects under the prior schedule may complete the current " +
        "cycle before transitioning.",
    });
  }
  b.push(
    { fig: { kind: "bars", caption: "Projected enrollment by quarter" } },
    { h: 1, text: "4  Revised Protocol Sections" },
  );
  const sectionThemes = [
    {
      name: "Study Objectives and Endpoints",
      ps: [
        "The primary objective is to compare progression-free survival " +
          `between subjects receiving ${STUDY} plus standard of care and ` +
          "those receiving standard of care alone, as assessed by blinded " +
          "independent central review per RECIST v1.1.",
        "Secondary objectives include evaluation of overall survival, " +
          "objective response rate, duration of response, safety and " +
          "tolerability, and pharmacokinetic parameters of the combination.",
      ],
    },
    {
      name: "Eligibility Criteria",
      ps: [
        "Subjects must be at least 18 years of age, have histologically or " +
          "cytologically confirmed advanced solid tumour, measurable disease " +
          "per RECIST v1.1, ECOG performance status 0-1, and adequate organ " +
          "function as defined in the laboratory requirements table.",
        "Subjects with untreated or symptomatic central nervous system " +
          "metastases, prior therapy with agents of the same class, or " +
          "clinically significant cardiac disease within 6 months are " +
          "excluded from participation.",
      ],
    },
    {
      name: "Treatment Regimen",
      ps: [
        `${STUDY} will be administered by intravenous infusion over 60 ` +
          "minutes on Day 1 of each 21-day cycle. Premedication with " +
          "antihistamine and corticosteroid is required at least 30 minutes " +
          "prior to infusion for the first four cycles.",
        "Dose reductions are permitted in two steps per the toxicity " +
          "management guidelines. Treatment continues until disease " +
          "progression, unacceptable toxicity, withdrawal of consent, or " +
          "completion of 24 cycles, whichever occurs first.",
      ],
    },
    {
      name: "Safety Assessments",
      ps: [
        "Treatment-emergent adverse events are collected from first dose " +
          "through 30 days after the last dose and graded per CTCAE v5.0. " +
          "Serious adverse events must be reported to the sponsor within 24 " +
          "hours of site awareness.",
        "Laboratory assessments including haematology, serum chemistry, " +
          "liver function and urinalysis are performed on Day 1 of each " +
          "cycle and as clinically indicated.",
      ],
    },
    {
      name: "Statistical Considerations",
      ps: [
        "The primary endpoint will be analysed using a stratified log-rank " +
          "test at a two-sided significance level of 0.05. The stratification " +
          "factors are region, prior lines of therapy and PD-L1 status.",
        "A total of approximately 220 subjects is planned to provide 90% " +
          "power to detect a hazard ratio of 0.70, assuming a median " +
          "progression-free survival of 6 months in the control arm.",
      ],
    },
  ];
  for (let i = 0; i < 480; i++) {
    const theme = pick(sectionThemes, i);
    b.push({ h: 2, text: `4.${i + 1}  ${theme.name}` });
    for (const p of theme.ps) b.push({ p });
  }
  b.push(
    { fig: { kind: "line", caption: "Predicted exposure profile by cycle" } },
    { h: 1, text: "5  Schedule of Assessments" },
  );
  const assessments = [
    "Informed consent", "Medical history", "Physical examination",
    "ECOG performance status", "Vital signs", "Haematology",
    "Serum chemistry", "Liver function tests", "Urinalysis",
    "Pregnancy test", "ECG (12-lead)", "Tumour imaging (CT/MRI)",
    "PK sampling", "Immunogenicity (ADA)", "Biomarker sample",
    "Concomitant medication review", "Adverse event review",
  ];
  const cycles = ["Screening (-28 to -1)", "Cycle 1 Day 1", "Cycle 1 Day 8", "Cycle 2+ Day 1", "End of Treatment", "Follow-up (30d)"];
  for (const c of cycles) {
    b.push({ h: 3, text: c });
    for (const a of assessments) {
      b.push({ li: `${a} - required ${pick(["at this visit", "within 3 days", "within 7 days", "if clinically indicated"], a.length + c.length)}` });
    }
  }
  b.push("pb", { h: 1, text: "6  Approval" });
  b.push(
    { kv: "Protocol:              DBX-114-ONC-014 Amendment 3" },
    { kv: "Sponsor signatory:     ______________________________" },
    { kv: "Date:                  ____ / ____ / ______" },
    "gap",
    { kv: "Lead investigator:     ______________________________" },
    { kv: "Date:                  ____ / ____ / ______" },
  );
  return b;
}

function icfBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Study Information" },
    { kv: "Protocol number:    DBX-114-ONC-014" },
    { kv: "Sponsor:            DocBridge Clinical Research" },
    { kv: "Principal investigator: site-specific" },
    { kv: "Document version:   2.1 (30 September 2026)" },
    "gap",
    { h: 1, text: "2  Invitation and Purpose" },
    {
      p: "You are being invited to take part in a research study. Before you " +
        "decide, it is important that you understand why the research is " +
        "being done and what it will involve. Please read this document " +
        "carefully and ask the study doctor or staff about anything that is " +
        "not clear.",
    },
    {
      p: "The purpose of this study is to find out whether the investigational " +
        "study drug DBX-114, given together with standard treatment, is safe " +
        "and works better than standard treatment alone in people with your " +
        "type of cancer.",
    },
    { h: 1, text: "3  What the Study Involves" },
  ];
  const procedures = [
    "A screening visit lasting up to 4 hours to confirm you are eligible, " +
      "including blood tests, a heart tracing (ECG), and imaging scans.",
    "Treatment visits once every 3 weeks. The study drug is given as an " +
      "infusion into a vein over about 60 minutes.",
    "Blood samples taken at each visit for safety testing and for study " +
      "research, up to a total of about 120 mL per cycle.",
    "Imaging scans (CT or MRI) every 6 weeks to measure your tumour.",
    "A safety follow-up visit about 30 days after your last dose, and " +
      "telephone follow-up approximately every 12 weeks thereafter.",
  ];
  procedures.forEach((p, i) =>
    b.push({ li: `(${i + 1}) ${p}` }),
  );
  b.push(
    { h: 1, text: "4  Possible Risks and Discomforts" },
    {
      p: "Like all medicines, the study drug may cause side effects. In " +
        "studies so far, the most common side effects observed were fatigue, " +
        "nausea, decreased appetite, diarrhoea, skin rash and infusion-related " +
        "reactions. Most were mild or moderate and reversible.",
    },
    {
      p: "There may also be risks that are not yet known. Blood draws may " +
        "cause brief pain, bruising or, rarely, infection. Imaging involves " +
        "a small amount of radiation. You should tell the study staff about " +
        "any new or worsening symptoms at once.",
    },
    { h: 1, text: "4.1  Reported Side Effects" },
    {
      p: "The following side effects have been observed in studies of the " +
        "study drug so far. Not all risks are known; new side effects may " +
        "be identified as more people are treated.",
    },
    { h: 3, text: "Very common (may affect more than 1 in 10 people)" },
    { li: "Fatigue - reported; usually manageable with supportive care or dose modification." },
    { li: "Nausea - reported; usually manageable with supportive care or dose modification." },
    { li: "Decreased appetite - reported; usually manageable with supportive care or dose modification." },
    { li: "Anaemia - reported; usually manageable with supportive care or dose modification." },
    { li: "Diarrhoea - reported; usually manageable with supportive care or dose modification." },
    { li: "Rash - reported; usually manageable with supportive care or dose modification." },
    { li: "Infusion-related reaction - reported; usually manageable with supportive care or dose modification." },
    { li: "Constipation - reported; usually manageable with supportive care or dose modification." },
    { li: "Alopecia - reported; usually manageable with supportive care or dose modification." },
    { li: "Peripheral neuropathy - reported; usually manageable with supportive care or dose modification." },
    { h: 3, text: "Common (may affect up to 1 in 10 people)" },
    { li: "Vomiting - reported; usually manageable with supportive care or dose modification." },
    { li: "Stomatitis - reported; usually manageable with supportive care or dose modification." },
    { li: "Increased liver enzymes - reported; usually manageable with supportive care or dose modification." },
    { li: "Hypothyroidism - reported; usually manageable with supportive care or dose modification." },
    { li: "Cough - reported; usually manageable with supportive care or dose modification." },
    { li: "Pyrexia - reported; usually manageable with supportive care or dose modification." },
    { li: "Oedema - reported; usually manageable with supportive care or dose modification." },
    { li: "Insomnia - reported; usually manageable with supportive care or dose modification." },
    { li: "Headache - reported; usually manageable with supportive care or dose modification." },
    { li: "Dizziness - reported; usually manageable with supportive care or dose modification." },
    { li: "Musculoskeletal pain - reported; usually manageable with supportive care or dose modification." },
    { li: "Dysgeusia - reported; usually manageable with supportive care or dose modification." },
    { h: 3, text: "Uncommon (may affect up to 1 in 100 people)" },
    { li: "Pneumonitis - reported; usually manageable with supportive care or dose modification." },
    { li: "Colitis - reported; usually manageable with supportive care or dose modification." },
    { li: "Hepatitis - reported; usually manageable with supportive care or dose modification." },
    { li: "Adrenal insufficiency - reported; usually manageable with supportive care or dose modification." },
    { li: "Infusion-related hypersensitivity - reported; usually manageable with supportive care or dose modification." },
    { li: "Cardiac arrhythmia - reported; usually manageable with supportive care or dose modification." },
    { li: "Severe skin reactions - reported; usually manageable with supportive care or dose modification." },
    { li: "Nephritis - reported; usually manageable with supportive care or dose modification." },
    { h: 1, text: "5  Possible Benefits" },
    {
      p: "Taking part also means your health will be followed very " +
        "closely by an experienced team, which some patients find " +
        "reassuring. Study-related tests and scans are provided at no " +
        "cost to you.",
    },
    {
      p: "We cannot promise that you will benefit from taking part. The " +
        "information from this study may help future patients and improve " +
        "understanding of this disease. Your condition will be monitored " +
        "closely throughout the study.",
    },
    { h: 1, text: "6  Alternatives to Participation" },
    {
      p: "If you choose not to join, or if you leave the study early, " +
        "your doctor will explain the standard treatments available " +
        "for your condition and help you decide on next steps.",
    },
    {
      p: "You do not have to take part in this study. You may instead receive " +
        "standard treatment, take part in a different study, or choose no " +
        "treatment. Please discuss these options with your doctor.",
    },
    { h: 1, text: "7  Confidentiality and Data Protection" },
    {
      p: "Your study records will be identified by a code number, not your " +
        "name. Authorised representatives of the sponsor, the ethics " +
        "committee and regulatory authorities may review your medical " +
        "records to verify the study data. Data will be handled in " +
        "accordance with applicable data-protection law.",
    },
    { h: 1, text: "7.1  Biological Samples and Biobank" },
    {
      p: "Blood and tissue samples collected for this study will be stored " +
        "in a secure biobank for up to 15 years and may be used for future " +
        "research related to this disease or the study drug, subject to " +
        "applicable law and ethics approvals. You may consent to the main " +
        "study and decline optional biobank research.",
    },
    { h: 1, text: "7.2  Optional Sub-Studies" },
    {
      p: "Separate optional consent choices cover (a) collection of an " +
        "additional blood sample for exploratory biomarker research, and " +
        "(b) use of leftover tumour tissue for genetic analysis. Declining " +
        "either does not affect your participation in the main study.",
    },
    { h: 1, text: "7.3  Who May Access Your Data" },
    {
      p: "Direct access to your medical records may be given to study " +
        "monitors and auditors working for the sponsor, the ethics " +
        "committee that approved this study, and regulatory authorities " +
        "such as the EMA or FDA. Publications will never contain your " +
        "name or any information that identifies you.",
    },
    { h: 1, text: "8  Costs, Compensation and Injury" },
    {
      p: "You will not be charged for the study drug or study-required " +
        "procedures. Reasonable travel expenses will be reimbursed. If you " +
        "are injured as a direct result of study procedures, medical care " +
        "will be provided and the sponsor will cover reasonable and " +
        "necessary treatment costs as required by law.",
    },
    { h: 1, text: "9  Voluntary Participation and Withdrawal" },
    {
      p: "If you withdraw, the study doctor may ask to keep using the " +
        "data already collected to protect the integrity of the " +
        "research, and may ask your permission for a final safety " +
        "visit or telephone call.",
    },
    {
      p: "Taking part is voluntary. You may stop at any time, for any " +
        "reason, without affecting your future medical care. If you " +
        "withdraw, the study doctor may ask your permission to continue " +
        "using data already collected and to contact you for safety " +
        "follow-up.",
    },
    { h: 1, text: "10  Contacts" },
    { kv: "Study doctor:            site-specific contact" },
    { kv: "24-hour emergency line:  +00 000 000 0000" },
    { kv: "Ethics committee:        regional EC office" },
    { fig: { kind: "bars", caption: "Overview of study visits by period" } },
    { h: 1, text: "9.1  Study Schedule Overview" },
    {
      p: "The table below gives an overview of the main study activities. " +
        "Your study team will give you exact dates and explain anything " +
        "that is unclear.",
    },
    { h: 3, text: "Screening (Day -28 to -1)" },
    { p: "Activities: consent, medical history, physical exam, blood tests, ECG, imaging, pregnancy test." },
    { h: 3, text: "Cycle 1, Day 1" },
    { p: "Activities: pre-dose checks, study drug infusion (about 60 min), observation, blood samples." },
    { h: 3, text: "Cycle 1, Day 8" },
    { p: "Activities: safety blood tests, adverse event review, concomitant medication review." },
    { h: 3, text: "Cycles 2-4, Day 1 each" },
    { p: "Activities: safety checks, study drug infusion, PK blood samples." },
    { h: 3, text: "Every 6 weeks" },
    { p: "Activities: imaging scan (CT or MRI) to measure your tumour." },
    { h: 3, text: "Cycles 5+, Day 1 each" },
    { p: "Activities: safety checks, study drug infusion, adverse event review." },
    { h: 3, text: "End of treatment" },
    { p: "Activities: final visit: physical exam, blood tests, ECG, imaging." },
    { h: 3, text: "Safety follow-up (+30 days)" },
    { p: "Activities: health check, blood tests, adverse event review." },
    { h: 3, text: "Survival follow-up" },
    { p: "Activities: telephone contact about every 12 weeks." },
    { h: 1, text: "10.1  Glossary of Terms" },
    { li: "adverse event - any unfavourable medical occurrence during the study." },
    { li: "blinded independent review - assessment by experts unaware of treatment assignment." },
    { li: "cohort - a group of subjects receiving the same study treatment." },
    { li: "cycle - one complete period of treatment (here, 21 days)." },
    { li: "eligibility criteria - the medical conditions required to join the study." },
    { li: "endpoint - the main result the study is designed to measure." },
    { li: "infusion - giving a medicine slowly through a vein." },
    { li: "investigational product - the study drug being tested (DBX-114)." },
    { li: "monoclonal antibody - a laboratory-made protein that targets specific cells." },
    { li: "placebo - an inactive substance that looks like the study drug." },
    { li: "protocol - the detailed plan describing how the study is conducted." },
    { li: "randomised - assigned to a treatment group by chance, like a coin toss." },
    { li: "RECIST - standard rules for measuring how tumours respond to treatment." },
    { li: "screening - tests done before enrolment to confirm eligibility." },
    { li: "serious adverse event - an event that is dangerous or requires hospitalisation." },
    { li: "sponsor - the organisation responsible for the study." },
    { li: "standard of care - the usual treatment given for your condition." },
    { li: "survival follow-up - contact after treatment ends to check your status." },
    { h: 1, text: "10.2  Frequently Asked Questions" },
    { h: 3, text: "Will I know which treatment I receive?" },
    { p: "You and your doctor will not be told which group you are in during the treatment period, except in a medical emergency." },
    { h: 3, text: "Can I keep taking my regular medicines?" },
    { p: "Most regular medicines are allowed. The study doctor will review your medicines and tell you about any that must be paused." },
    { h: 3, text: "What if I miss a visit?" },
    { p: "Contact the study team as soon as possible. Some visits have windows of a few days, and the team will help you reschedule." },
    { h: 3, text: "Will I be paid for taking part?" },
    { p: "You will not be paid, but reasonable travel expenses for study visits are reimbursed." },
    { h: 3, text: "How long will the study last?" },
    { p: "Your treatment may continue for up to about 2 years if you benefit and tolerate the drug, followed by periodic follow-up." },
    { h: 3, text: "Who reviews my safety during the study?" },
    { p: "An independent Data Safety Monitoring Board reviews all safety data regularly and can recommend changes or stopping the study." },
    { h: 3, text: "What happens when the study ends?" },
    { p: "Your doctor will discuss further treatment options. If the drug helps you, continued access may be offered where allowed." },
    { h: 3, text: "Whom do I call with a problem?" },
    { p: "Call the 24-hour study line in section 10 for anything urgent, or the study team during office hours for other questions." },
    "pb",
    { h: 1, text: "11  Consent" },
    {
      p: "I have read and understood this information sheet. I have had the " +
        "opportunity to ask questions and they have been answered to my " +
        "satisfaction. I voluntarily agree to take part in this study.",
    },
    "gap",
    { kv: "Subject name (print):    ______________________________" },
    { kv: "Signature:               ______________________________" },
    { kv: "Date / time:             ______________________________" },
    "gap",
    { kv: "Person obtaining consent: _____________________________" },
    { kv: "Signature:               ______________________________" },
    { kv: "Date / time:             ______________________________" },
  );
  return b;
}

function monitoringBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Report Summary" },
    {
      p: "This report summarises routine monitoring visits performed across " +
        `the ${STUDY}-ONC-014 programme during Q3 2026. Eight sites were ` +
        "visited on site and four were monitored remotely. Overall conduct " +
        "was satisfactory; findings are detailed per site below.",
    },
    { kv: "Reporting period:      01 July 2026 - 30 September 2026" },
    { kv: "Monitor:               Clinical Research Associate team" },
    { kv: "Sites on site:         8    remote: 4" },
    "gap",
  ];
  const findingPool = [
    "ICF version 2.0 used for two subjects after v2.1 effective date; " +
      "re-consent completed within 5 days.",
    "Temperature excursion in IP refrigerator (max 9.4 C for 40 min); " +
      "product quarantined and released after QA review.",
    "PK sample drawn 22 min outside protocol window; deviation reported.",
    "One screening ECG filed unsigned; signature obtained at this visit.",
    "Con-medication entry missing for subject; corrected during visit.",
    "Source-to-CRF discrepancies in lab dates; site retrained on entry rules.",
    "Expired tubes found in phlebotomy stock; discarded and restocked.",
    "Safety report acknowledgement not filed; filed during visit.",
  ];
  for (let s = 0; s < 12; s++) {
    const site = SITES[s];
    const name = pick(SITE_NAMES, s);
    b.push({ h: 1, text: `${s + 2}  Site Visit Report - ${site} (${name})` });
    b.push(
      { kv: `Visit date:            ${daysAgo(20 + s * 4)}` },
      { kv: `Visit type:            ${pick(["On-site routine monitoring visit", "On-site close-out preparation", "On-site initiation follow-up"], s)}` },
      { kv: `Screened / enrolled:   ${8 + s * 2} / ${4 + s}` },
      { kv: `Staff changes:         ${pick(["none", "sub-investigator added", "study coordinator replaced"], s + 1)}` },
      "gap",
      { h: 2, text: `${s + 2}.1  Visit Summary` },
      {
        p: `The site continues to enrol to target. The investigator site file ` +
          `was reviewed and is current. Source data verification covered ` +
          `${4 + (s % 3)} subjects including informed consent forms, ` +
          "eligibility, primary endpoint data and safety reporting.",
      },
      { h: 2, text: `${s + 2}.2  Findings and Deviations` },
    );
    const n = 4 + (s % 3);
    for (let i = 0; i < n; i++) {
      b.push({ li: pick(findingPool, s * 3 + i) });
    }
    if (s % 2 === 0) {
      b.push({
        fig: { kind: "bars", caption: `Enrollment by month - ${site}` },
      });
    }
    b.push(
      { h: 2, text: `${s + 2}.3  Investigational Product` },
      {
        p: "IP accountability was reconciled against IRT records. " +
          `${pick(["No discrepancies.", "One unit pending destruction documentation.", "Re-supply requested for next quarter."], s)} ` +
          "Storage conditions remain within specifications.",
      },
      { h: 2, text: `${s + 2}.4  Action Items` },
      { li: "Site to file updated delegation log (due within 7 days)." },
      { li: "CRA to verify deviation closure at next visit." },
      { li: `Next visit planned ${daysAgo(-(14 + s * 3))} (approximate).` },
      "gap",
    );
  }
  return b;
}

const SAE_TERMS = [
  "Neutropenic sepsis", "Pneumonia", "Acute kidney injury",
  "Pulmonary embolism", "Febrile neutropenia", "Sepsis",
  "Intestinal obstruction", "Cardiac failure", "Cerebrovascular accident",
  "Hyponatraemia", "Pleural effusion", "Anaemia requiring transfusion",
];

function saeBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Serious Adverse Event Log" },
    {
      p: `This log summarises serious adverse events reported for study ` +
        `${STUDY}-ONC-014. Entries are listed in receipt order. Each entry ` +
        "records the event term, seriousness criteria, investigator " +
        "causality assessment, action taken with study drug, and outcome.",
    },
    "gap",
  ];
  b.push({ fig: { kind: "bars", caption: "SAEs by system organ class" } });
  const outcomes = ["resolved", "resolved with sequelae", "resolving", "ongoing", "fatal"];
  const causality = ["not related", "unlikely", "possibly related", "related"];
  const actions = ["none", "dose interrupted", "dose reduced", "drug withdrawn"];
  for (let i = 0; i < 90; i++) {
    const term = pick(SAE_TERMS, i);
    const site = pick(SITES, i * 3);
    const subj = `${site}-${String(200 + i * 7).padStart(4, "0")}`;
    const onset = daysAgo(120 - i * 3);
    b.push(
      { h: 2, text: `SAE-${String(i + 1).padStart(3, "0")}  ${term}` },
      { kv: `Subject:             ${subj}` },
      { kv: `Site:                ${site} (${pick(SITE_NAMES, i)})` },
      { kv: `Onset / report date: ${onset} / ${onset}` },
      { kv: `Seriousness:         ${pick(["hospitalisation", "life-threatening", "medically significant", "prolonged hospitalisation"], i)}` },
      { kv: `Causality:           ${pick(causality, i * 5)}` },
      { kv: `Action taken:        ${pick(actions, i * 7)}` },
      { kv: `Outcome:             ${pick(outcomes, i * 11)}` },
      {
        p: `Narrative: the subject developed ${term.toLowerCase()} on day ` +
          `${30 + i} of study treatment. ${pick([
            "The event was managed with supportive care and resolved without sequelae.",
            "Hospitalisation was required; the event improved with treatment.",
            "The event was assessed as possibly related and dosing was modified accordingly.",
            "Standard of care treatment was administered; follow-up continues.",
          ], i)}`,
      },
      "gap",
    );
  }
  return b;
}

function ibBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Summary" },
    {
      p: `${STUDY} is an investigational monoclonal antibody targeting a ` +
        "tumour-associated antigen overexpressed in a range of solid " +
        "tumours. This edition of the Investigator's Brochure consolidates " +
        "nonclinical and clinical data available as of the data cut-off " +
        "date and supersedes edition 8.0.",
    },
    { h: 1, text: "2  Introduction" },
    {
      p: `This brochure provides investigators and site staff with the ` +
        `scientific basis for the conduct of clinical trials with ${STUDY}. ` +
        "It should be read together with the protocol, the pharmacy manual " +
        "and current safety communications.",
    },
    { h: 1, text: "3  Physical, Chemical and Pharmaceutical Properties" },
    {
      p: `${STUDY} is supplied as a sterile, preservative-free solution for ` +
        "infusion at a concentration of 25 mg/mL. The drug product is a " +
        "humanised IgG1 monoclonal antibody with a molecular weight of " +
        "approximately 148 kDa, produced in a CHO cell line.",
    },
    { kv: "Appearance:            clear to slightly opalescent, colourless" },
    { kv: "Storage:               2-8 C, protected from light; do not freeze" },
    { kv: "Shelf life:            24 months at recommended conditions" },
    "gap",
    { h: 1, text: "4  Nonclinical Pharmacology" },
  ];
  const pharmTopics = [
    ["Primary pharmacodynamics",
      `In vitro, ${STUDY} binds its target with high affinity (Kd in the ` +
        "low nanomolar range) and induces antibody-dependent cellular " +
        "cytotoxicity in antigen-positive tumour cell lines. In xenograft " +
        "models, dose-dependent tumour growth inhibition was observed.",
    ],
    ["Secondary pharmacodynamics",
      "No clinically relevant off-target binding was identified in a panel " +
        "of human tissue cross-reactivity studies. Weak binding to a " +
        "related epitope on circulating lymphocytes is not expected to be " +
        "pharmacologically significant at clinical exposures.",
    ],
    ["Safety pharmacology",
      "Dedicated safety pharmacology studies (cardiovascular, respiratory " +
        "and central nervous system endpoints in cynomolgus monkey) showed " +
        "no adverse findings at exposures up to 15-fold the clinical Cmax.",
    ],
    ["Pharmacokinetics (nonclinical)",
      `${STUDY} demonstrates typical IgG1 pharmacokinetics: low clearance, ` +
        "limited volume of distribution, and a terminal half-life of " +
        "approximately 12 days in monkey. Exposure increased approximately " +
        "dose-proportionally over the studied range.",
    ],
  ] as const;
  pharmTopics.forEach(([name, text], i) => {
    b.push({ h: 2, text: `4.${i + 1}  ${name}` }, { p: text });
  });
  b.push({ h: 1, text: "5  Nonclinical Toxicology" });
  const species = ["Sprague-Dawley rat", "Cynomolgus monkey", "CD-1 mouse", "New Zealand rabbit", "Beagle dog"];
  for (let s = 0; s < species.length; s++) {
    for (let st = 0; st < 4; st++) {
      b.push({ h: 2, text: `5.${s * 3 + st + 1}  ${pick(["Single-dose", "Repeat-dose (4-week)", "Repeat-dose (13-week)", "Repeat-dose (26-week)"], st)} toxicity - ${species[s]}` });
      b.push({
        p: `${species[s]}s received ${STUDY} at dose levels of 0, ${10 + st * 20}, ` +
          `${50 + st * 50} and ${150 + st * 100} mg/kg. The principal finding ` +
          `was ${pick(["reversible decreases in lymphocyte counts", "dose-dependent splenic lymphoid depletion", "transient elevations in liver enzymes", "no test-article-related findings at the top dose"], s + st)}. ` +
          `The no-observed-adverse-effect level (NOAEL) was established at ` +
          `${50 + st * 50} mg/kg, providing a margin of approximately ` +
          `${8 + s * 3 + st}-fold over the intended clinical exposure.`,
      });
    }
  }
  b.push(
    { h: 1, text: "6  Effects in Humans - Clinical Pharmacology" },
    {
      p: `In the first-in-human study (${STUDY}-001), ${STUDY} showed ` +
        "approximately dose-proportional pharmacokinetics over the " +
        "0.3-10 mg/kg range. The geometric mean half-life at the intended " +
        "clinical dose was 11.2 days (CV 28%).",
    },
    {
      p: "Anti-drug antibodies were detected in 9 of 112 evaluable subjects " +
        "(8.0%); titres were low and no impact on exposure, efficacy or " +
        "safety was identified.",
    },
    { h: 1, text: "7  Summary of Clinical Experience" },
  );
  for (let i = 0; i < 140; i++) {
    const sid = `${STUDY}-${String(i + 1).padStart(3, "0")}`;
    b.push(
      { h: 2, text: `7.${i + 1}  Study ${sid}` },
      { kv: `Design:              ${pick(["Phase I, open-label dose escalation", "Phase Ib expansion cohort", "Phase II randomised", "Phase I pharmacology substudy"], i)}` },
      { kv: `Population:          ${pick(["advanced solid tumours", "NSCLC cohort", "CRC cohort", "HNSCC cohort", "healthy volunteers"], i * 2)}` },
      { kv: `N / dose range:      ${20 + i * 6} / ${pick(["0.3-10 mg/kg Q3W", "3-15 mg/kg Q2W", "fixed 600 mg Q3W"], i)}` },
      { kv: `Status:              ${pick(["completed", "ongoing", "enrolling", "analysis in progress"], i * 5)}` },
      {
        p: `Results: at the data cut-off, study ${sid} had treated ` +
          `${20 + i * 6} subjects. The most common treatment-emergent ` +
          `adverse events were ${pick(["fatigue, nausea and infusion-related reactions", "anaemia, decreased appetite and diarrhoea", "rash, pruritus and fatigue"], i)}. ` +
          `Preliminary antitumour activity included ` +
          `${pick(["confirmed partial responses in 4 subjects", "disease control rate of 61%", "median PFS of 5.4 months", "two confirmed complete responses"], i * 3)}.`,
      },
      { li: `Cmax (cycle 1): ${(2 + (i % 9)) * 1.7} ug/mL (CV ${18 + (i % 12)}%)` },
      { li: `AUC0-21d: ${(30 + i) * 4} day*ug/mL; t1/2 ${8 + (i % 6)} days` },
      { li: `ADA positive: ${(i * 3) % 11} of ${20 + i * 6} subjects` },
      ...(i % 15 === 0
        ? ([
            {
              fig: {
                kind: "line" as const,
                caption: `Mean concentration-time profile - study ${sid}`,
              },
            },
          ] satisfies Block[])
        : []),
      "gap",
    );
  }
  b.push({ h: 1, text: "8  Guidance for the Investigator" });
  b.push({
    p: "Infusion-related reactions should be managed by interruption or " +
      "discontinuation per the toxicity management guidelines. Subjects " +
      "should be observed for at least 60 minutes after the first two " +
      "infusions.",
  });
  b.push({ h: 1, text: "9  References" });
  for (let i = 0; i < 900; i++) {
    b.push({
      li: `${pick(["Author A", "Author B", "Author C", "Author D"], i)} et al. ` +
        `(${2015 + (i % 11)}). ${pick([
          "Antitumour activity of targeted antibodies in solid tumours.",
          "Clinical pharmacokinetics of monoclonal antibodies.",
          "Immune-related adverse events in early-phase trials.",
          "Dose optimisation strategies for oncology biologics.",
          "Biomarker development in antibody therapeutics.",
        ], i)} ${pick(["J Clin Oncol", "Clin Cancer Res", "Ann Oncol", "Lancet Oncol", "Eur J Cancer"], i * 7)} ` +
        `${30 + (i % 20)}(${1 + (i % 12)}): ${100 + i * 3}-${120 + i * 3}.`,
    });
  }
  return b;
}

function sapBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Introduction" },
    {
      p: `This Statistical Analysis Plan (SAP) describes the planned ` +
        `analyses for study ${STUDY}-ONC-014. It finalises the analysis ` +
        "specifications prior to database lock and unblinding of treatment " +
        "assignment.",
    },
    { h: 1, text: "2  Study Objectives and Endpoints" },
    {
      p: "The primary endpoint is progression-free survival (PFS) per " +
        "RECIST v1.1 by blinded independent central review. Key secondary " +
        "endpoints are overall survival, objective response rate and " +
        "duration of response.",
    },
    { h: 1, text: "3  Analysis Populations" },
    { li: "Intent-to-treat (ITT): all randomised subjects, analysed by assigned arm." },
    { li: "Safety population: all subjects receiving at least one dose." },
    { li: "PK population: all subjects with at least one evaluable concentration." },
    { li: "Per-protocol: ITT subjects without major protocol deviations." },
    { h: 1, text: "4  Sample Size and Power" },
    {
      p: "Approximately 220 subjects will be randomised 1:1 to provide 90% " +
        "power to detect a hazard ratio of 0.70 for PFS at a two-sided " +
        "alpha of 0.05, assuming a median PFS of 6 months on control and " +
        "one interim analysis using an O'Brien-Fleming boundary.",
    },
    { h: 1, text: "5  Statistical Methods" },
  ];
  const methods = [
    ["Primary analysis - PFS",
      "PFS will be compared between arms using a stratified log-rank test " +
        "with stratification factors region, prior lines of therapy and " +
        "PD-L1 status. The hazard ratio and 95% CI will be estimated from a " +
        "stratified Cox model. Kaplan-Meier estimates will be presented."],
    ["Overall survival",
      "OS will be analysed with the same stratified approach at the " +
        "final OS analysis when approximately 70% of deaths have occurred."],
    ["Objective response rate",
      "ORR will be compared using the Cochran-Mantel-Haenszel test " +
        "stratified as above; two-sided 95% CIs will be provided."],
    ["Handling of missing data",
      "Subjects without post-baseline tumour assessment will be censored " +
        "at randomisation for PFS. Sensitivity analyses will assess the " +
        "impact of informative censoring using a tipping-point approach."],
    ["Subgroup analyses",
      "Prespecified subgroups include age, sex, region, ECOG status, " +
        "PD-L1 status, tumour type and number of prior lines. Forest plots " +
        "will display unstratified hazard ratios."],
    ["Interim analysis",
      "One efficacy interim analysis is planned at approximately 60% " +
        "information fraction. Stopping for futility may be considered per " +
        "the DSMB charter."],
    ["Multiplicity",
      "A hierarchical testing procedure controls the familywise type I " +
        "error at 0.05: PFS is tested first, followed by OS and ORR only if " +
        "the preceding hypothesis is rejected."],
    ["Analysis software and validation",
      "Analyses use SAS v9.4 or later. Independent double-programming is " +
        "performed for the primary and key secondary endpoints. The " +
        "analysis dataset specifications follow CDISC ADaM standards."],
    ["Sensitivity and supplementary analyses",
      "Sensitivity analyses include unstratified tests, per-protocol " +
        "population analyses, assessment-time-window variation, and " +
        "analyses treating intercurrent events per the estimands framework " +
        "described in ICH E9(R1)."],
  ] as const;
  methods.forEach(([name, text], i) =>
    b.push({ h: 2, text: `5.${i + 1}  ${name}` }, { p: text }),
  );
  b.push(
    { fig: { kind: "line", caption: "Power curve by information fraction" } },
    { fig: { kind: "bars", caption: "Expected events by interim and final analysis" } },
    { h: 1, text: "6  Safety Analyses" },
  );
  b.push({
    p: "Adverse events will be coded to MedDRA v28.0 and summarised by " +
      "system organ class, preferred term, grade and relationship. " +
      "Laboratory parameters will be summarised by visit using shift " +
      "tables relative to baseline.",
  });
  b.push({ h: 1, text: "7  Tables, Listings and Figures" });
  const tflGroups = [
    ["Disposition and demography", 70],
    ["Efficacy", 120],
    ["Safety - adverse events", 100],
    ["Safety - laboratory", 80],
    ["Safety - other", 60],
    ["Pharmacokinetics", 50],
  ] as const;
  let tfl = 0;
  for (const [gi, [group, count]] of tflGroups.entries()) {
    b.push({ h: 2, text: `7.${gi + 1}  ${group}` });
    for (let i = 0; i < count; i++) {
      tfl++;
      b.push({
        li: `Table ${group[0]}.${i + 1} - ${pick([
          "Summary by treatment arm",
          "Summary by treatment arm and visit",
          "Shift from baseline to worst post-baseline",
          "Listing of individual subject data",
          "Kaplan-Meier estimates over time",
          "Incidence by system organ class and preferred term",
          "Incidence of grade >=3 events",
          "Exposure-adjusted incidence rates",
        ], tfl)}`,
      });
    }
  }
  return b;
}

function csrBlocks(): Block[] {
  return [
    { h: 1, text: "1  Synopsis" },
    { kv: "Study:                 DBX-114-012" },
    { kv: "Title:                 Phase Ib expansion cohort of DBX-114 in NSCLC" },
    { kv: "Design:                open-label, single-arm expansion" },
    { kv: `Report date:           ${daysAgo(45)}` },
    "gap",
    { h: 1, text: "2  Objectives" },
    {
      p: "To evaluate the antitumour activity, safety and pharmacokinetics " +
        "of DBX-114 at the recommended Phase II dose in subjects with " +
        "previously treated advanced NSCLC.",
    },
    { h: 1, text: "3  Study Design" },
    {
      p: "Single-arm expansion cohort enrolled following completion of " +
        "dose escalation. Subjects received DBX-114 600 mg IV every 3 " +
        "weeks until progression or unacceptable toxicity. The primary " +
        "endpoint was objective response rate per RECIST v1.1.",
    },
    { h: 1, text: "4  Results - Disposition and Demographics" },
    {
      p: "Forty-seven subjects were enrolled and treated. Median age was " +
        "64 years (range 41-79); 55% were male; median prior lines of " +
        "therapy was 2. At data cut-off, 12 subjects remained on " +
        "treatment.",
    },
    { h: 1, text: "5  Results - Efficacy" },
    {
      p: "The confirmed objective response rate was 27.7% (95% CI 15.6-" +
        "42.6), including one complete response. Median duration of " +
        "response was 7.2 months. The disease control rate was 61.7%.",
    },
    { fig: { kind: "line", caption: "Kaplan-Meier estimate of PFS" } },
    { fig: { kind: "bars", caption: "Best change in target lesion size" } },
    { h: 1, text: "6  Results - Safety" },
    {
      p: "Treatment-emergent adverse events occurred in 89% of subjects; " +
        "grade >=3 events in 23%. The most frequent events were fatigue " +
        "(38%), nausea (30%) and infusion-related reactions (17%). Four " +
        "serious adverse events were assessed as possibly related. No " +
        "treatment-related deaths occurred.",
    },
    { h: 1, text: "7  Results - Pharmacokinetics" },
    {
      p: "Steady-state exposure was reached by cycle 3 with minimal " +
        "accumulation. Population PK parameters were consistent with " +
        "estimates from the dose-escalation phase.",
    },
    { h: 1, text: "8  Conclusions" },
    {
      p: "DBX-114 at 600 mg Q3W demonstrated clinically meaningful " +
        "antitumour activity with a manageable safety profile in " +
        "previously treated advanced NSCLC, supporting continued " +
        "development in the Phase II programme.",
    },
    { h: 1, text: "8.1  Laboratory Abnormalities (worst grade)" },
    ...Array.from({ length: 60 }, (_, i) => ({
      li: `${pick(["Neutrophils decreased", "Lymphocytes decreased", "Haemoglobin decreased", "Platelets decreased", "ALT increased", "AST increased", "Creatinine increased", "Sodium decreased", "Potassium decreased", "Bilirubin increased"], i)}: ` +
        `grade 1-2 ${(i * 7) % 20}/${47}, grade >=3 ${(i * 3) % 5}/47`,
    })),
    { h: 1, text: "8.2  Concomitant Medications" },
    ...Array.from({ length: 35 }, (_, i) => ({
      li: `${pick(["Ondansetron", "Dexamethasone", "Omeprazole", "Paracetamol", "Metformin", "Amlodipine", "Atorvastatin", "Levothyroxine", "Loperamide", "Antihistamine (premedication)"], i)}: ` +
        `${(i * 5) % 30 + 8} subjects (${Math.round(((i * 5) % 30 + 8) / 0.47)}%)`,
    })),
    { h: 1, text: "9  Appendix - Subject Disposition Listing" },
    ...Array.from({ length: 47 }, (_, i) => ({
      li:
        `SUBJ-${String(101).padStart(3, "0")}-${String(1000 + i * 3)}: ` +
        `${pick(["completed treatment", "discontinued - progression", "discontinued - adverse event", "ongoing", "withdrew consent"], i * 7)}`,
    })),
  ];
}

function pharmacyBlocks(): Block[] {
  const b: Block[] = [
    { h: 1, text: "1  Scope and Responsibilities" },
    {
      p: "This manual describes the handling of investigational product " +
        `${STUDY} at investigator sites. The site pharmacist or designee ` +
        "is responsible for receipt, storage, preparation, dispensing, " +
        "accountability and disposition of IP.",
    },
    { h: 1, text: "2  Product Description" },
    { kv: "Product:               DBX-114 concentrate for infusion" },
    { kv: "Strength:              25 mg/mL, 10 mL vial" },
    { kv: "Dosage form:           sterile solution for IV infusion" },
    { kv: "Storage:               2-8 C; protect from light; do not freeze" },
    "gap",
    { h: 1, text: "3  Receipt and Inspection" },
    {
      p: "IP shipments are sent under validated temperature-controlled " +
        "conditions with a continuous temperature logger. On receipt, " +
        "inspect packaging, reconcile contents against the shipping " +
        "manifest, review the temperature record and acknowledge receipt " +
        "in the IRT system within 24 hours.",
    },
    { h: 1, text: "4  Storage and Temperature Monitoring" },
    {
      p: "Store IP in a monitored refrigerator at 2-8 C in the original " +
        "carton. Record minimum/maximum temperatures daily on the " +
        "temperature log. In case of excursion outside 2-8 C, quarantine " +
        "the affected stock and contact the sponsor before further use.",
    },
    { h: 1, text: "5  Preparation and Dose Calculation" },
    {
      p: "Withdraw the calculated dose volume using aseptic technique and " +
        "add to a 0.9% sodium chloride infusion bag. Gently invert to mix; " +
        "do not shake. The diluted solution must be administered within " +
        "4 hours at room temperature or 24 hours refrigerated.",
    },
    { h: 1, text: "6  Accountability" },
  ];
  for (let i = 0; i < 90; i++) {
    b.push({
      li: `Accountability entry ${String(i + 1).padStart(2, "0")} - batch ` +
        `DBX${2600 + i}: received ${10 + (i % 6)} vials, dispensed ` +
        `${2 + (i % 4)} vials to SUBJ-${pick(SITES, i)}-${String(2000 + i * 5)}, ` +
        `balance ${5 + (i % 3)} vials on hand.`,
    });
  }
  b.push(
    { h: 1, text: "7  Returns and Destruction" },
    {
      p: "Unused and expired IP must not be destroyed on site unless local " +
        "procedures and the sponsor's written authorisation permit it. " +
        "Otherwise return stock quarterly using the provided return " +
        "shipping kit and retain certificates of destruction in the ISF.",
    },
    { fig: { kind: "line", caption: "Refrigerator temperature log - last 30 days" } },
    { h: 1, text: "8  Preparation Quick Reference" },
    ...Array.from({ length: 24 }, (_, i) => ({
      li: `Dose ${[150, 300, 450, 600][i % 4]} mg: withdraw ` +
        `${(6 + (i % 4) * 6)} mL concentrate into ` +
        `${pick([100, 250], i)} mL 0.9% NaCl bag; infuse over ` +
        `${pick([30, 60], i * 2)} minutes via 0.22 um in-line filter.`,
    })),
    "pb",
    { h: 1, text: "9  Temperature Excursion Form" },
    { kv: "Site:                  ______________________________" },
    { kv: "Date of excursion:     ______________________________" },
    { kv: "Duration / max temp:   ______________________________" },
    { kv: "Units affected:        ______________________________" },
    { kv: "Sponsor disposition:   ______________________________" },
    "pb",
    { h: 1, text: "10  IP Dispensing Log (blank)" },
    ...Array.from({ length: 18 }, () => ({
      kv: "Subject ID _________  Date ______  Vials ______  Initials ______",
    })),
    "pb",
    { h: 1, text: "11  Destruction / Return Certificate (blank)" },
    { kv: "Site:                  ______________________________" },
    { kv: "Carrier / date:        ______________________________" },
    { kv: "Units returned:        ______________________________" },
    { kv: "Pharmacist signature:  ______________________________" },
    { kv: "Sponsor acknowledgement: ____________________________" },
  );
  return b;
}

function safetyBlocks(): Block[] {
  return [
    { h: 1, text: "1  Purpose" },
    {
      p: "This Safety Management Plan defines the processes for " +
        `collecting, assessing and reporting safety data for ${STUDY} ` +
        "clinical trials, including expedited reporting timelines and " +
        "roles and responsibilities.",
    },
    { h: 1, text: "2  Definitions" },
    { li: "AE: any untoward medical occurrence whether or not related." },
    { li: "SAE: an event that is fatal, life-threatening, requires or prolongs hospitalisation, results in disability, is a congenital anomaly, or is otherwise medically significant." },
    { li: "SUSAR: a suspected unexpected serious adverse reaction subject to expedited reporting." },
    { h: 1, text: "3  Collection and Recording" },
    {
      p: "Adverse events are recorded from the time of first study drug " +
        "administration through 30 days after last dose, and graded per " +
        "CTCAE v5.0. Events are coded using MedDRA.",
    },
    { h: 1, text: "4  Expedited Reporting" },
    {
      p: "The investigator reports SAEs to the sponsor within 24 hours of " +
        "awareness. The sponsor reports SUSARs to regulatory authorities " +
        "within 7 days (fatal/life-threatening) or 15 days (other).",
    },
    { h: 1, text: "5  Safety Oversight" },
    {
      p: "An independent DSMB reviews unblinded safety data quarterly and " +
        "ad hoc as required. A medical monitor is available 24/7 for " +
        "urgent safety questions.",
    },
    { h: 1, text: "6  Reference Safety Information" },
    {
      p: "Expectedness is assessed against the current Investigator's " +
        "Brochure reference safety information section. The RSI is " +
        "reviewed and updated at each IB edition.",
    },
    { h: 1, text: "7  Urgent Safety Measures" },
    {
      p: "If urgent measures are needed to protect subjects, the sponsor " +
        "may implement changes before formal amendment, with notification " +
        "to authorities and ethics committees within required timelines.",
    },
    { h: 1, text: "8  Pregnancy Reporting" },
    {
      p: "Pregnancies in subjects or partners are followed to outcome. " +
        "Pregnancy itself is not an AE but is reported on the pregnancy " +
        "report form within 24 hours of awareness.",
    },
    { h: 1, text: "9  Case Processing Workflow" },
    {
      p: "Safety cases are entered into the global safety database within " +
        "one business day of receipt, triaged for seriousness and " +
        "expectedness, and assigned a medical reviewer. Follow-up queries " +
        "are issued to the site when minimum reporting criteria are not " +
        "met.",
    },
    {
      p: "Causality is assessed by the reporting investigator and reviewed " +
        "by the sponsor physician. Expectedness is assessed against the " +
        "reference safety information in the current Investigator's " +
        "Brochure.",
    },
    { h: 1, text: "10  Periodic Reporting" },
    {
      p: "Development Safety Update Reports are produced annually per " +
        "ICH E2F. Line listings of SUSARs accompany each DSUR. Regional " +
        "periodic reporting obligations are tracked in the regulatory " +
        "compliance calendar.",
    },
    { h: 1, text: "11  Reconciliation and Quality" },
    {
      p: "SAE data in the clinical database is reconciled against the " +
        "safety database monthly and before each database lock. " +
        "Discrepancies are queried and resolved before lock approval. " +
        "Case processing metrics are reviewed at quarterly quality " +
        "meetings.",
    },
    { fig: { kind: "bars", caption: "Median days to expedited submission by case type" } },
    { h: 1, text: "11.1  Signal Detection" },
    {
      p: "Aggregate safety data is reviewed at least monthly for " +
        "potential signals using disproportionality analyses and " +
        "clinical review of event patterns. Identified signals are " +
        "documented in the signal tracking log and escalated to the " +
        "safety governance committee.",
    },
    { h: 1, text: "11.2  Special Situations" },
    {
      p: "Medication errors, overdose, misuse, abuse, occupational " +
        "exposure and off-label use are collected as events of special " +
        "interest even when no adverse event is associated, and are " +
        "processed with the same timelines as non-serious cases.",
    },
    { h: 1, text: "11.3  Laboratory and ECG Safety Review" },
    {
      p: "The medical monitor reviews laboratory and ECG listings " +
        "weekly during active enrolment. Potential Hy's law cases and " +
        "QTc increases above protocol thresholds trigger immediate " +
        "site queries and, where required, unblinded review.",
    },
    { fig: { kind: "line", caption: "Cumulative SUSAR reports by quarter" } },
    { h: 1, text: "12  Safety Communication to Sites" },
    {
      p: "Significant new safety information is distributed to all sites " +
        "as a safety letter within 15 days, and reflected in the next IB " +
        "edition and, where required, protocol/ICF amendment.",
    },
    { h: 1, text: "12.1  Roles and Responsibilities" },
    ...Array.from({ length: 22 }, (_, i) => ({
      kv: `${pick(["Investigator", "Site coordinator", "Sponsor safety physician", "Global safety operations", "Medical monitor", "DSMB coordinator", "Regulatory affairs", "CRQ data management"], i)}: ` +
        `${pick(["first assessment within 24h of awareness", "case intake and data entry", "causality review and sign-off", "expedited submission preparation", "24/7 on-call medical consultation", "quarterly report compilation", "authority notification tracking", "database reconciliation"], i * 3)}.`,
    })),
    { h: 1, text: "13  Appendix - Reporting Timelines Reference" },
    ...Array.from({ length: 80 }, (_, i) => ({
      li: `${pick(["SAE initial report", "SAE follow-up report", "SUSAR (fatal/life-threatening)", "SUSAR (other)", "Pregnancy report", "Protocol deviation with safety impact", "Urgent safety measure notice", "IB significant change notice"], i)}: ` +
        `${pick(["within 24 hours", "within 7 calendar days", "within 15 calendar days", "at next quarterly report"], i * 3)}.`,
    })),
  ];
}

function dsmbBlocks(): Block[] {
  return [
    { h: 1, text: "1  Charter Purpose" },
    {
      p: "This charter defines the composition, responsibilities and " +
        "procedures of the independent Data Safety Monitoring Board " +
        `(DSMB) for the ${STUDY} clinical development programme.`,
    },
    { h: 1, text: "2  Membership" },
    {
      p: "The DSMB comprises three clinicians with oncology expertise, " +
        "one biostatistician and one pharmacologist. Members are " +
        "independent of the sponsor and investigators and declare " +
        "conflicts of interest before each meeting.",
    },
    { h: 1, text: "3  Responsibilities" },
    { li: "Review accumulating unblinded safety data at each scheduled meeting." },
    { li: "Assess benefit-risk and recommend continuation, modification or termination." },
    { li: "Review interim efficacy analyses per the SAP stopping rules." },
    { li: "Provide written recommendations to the sponsor within 7 days of each meeting." },
    { h: 1, text: "4  Meeting Schedule and Format" },
    {
      p: "The DSMB meets quarterly by videoconference and ad hoc at the " +
        "sponsor's or chair's request. Open sessions include sponsor " +
        "representatives; closed sessions are limited to members and the " +
        "unblinded statistician.",
    },
    { h: 1, text: "5  Data Flow and Reports" },
    {
      p: "The unblinded statistical centre prepares the closed report ten " +
        "business days before each meeting. Open reports contain enrolment " +
        "and conduct summaries; closed reports contain unblinded safety " +
        "and efficacy data by arm.",
    },
    { h: 1, text: "6  Decision Rules" },
    {
      p: "Recommendations require a majority of voting members. Stopping " +
        "guidelines for safety and efficacy are defined in the SAP. The " +
        "sponsor's senior management reviews recommendations within 5 " +
        "business days.",
    },
    { h: 1, text: "7  Confidentiality and Documentation" },
    {
      p: "Closed materials are confidential to the DSMB. Minutes are " +
        "maintained by the DSMB coordinator; open minutes are filed to " +
        "the trial master file.",
    },
    { h: 1, text: "7.1  Member Roster" },
    ...Array.from({ length: 10 }, (_, i) => ({
      kv: `${pick(["Chair (oncology)", "Voting member (oncology)", "Voting member (haematology)", "Biostatistician", "Pharmacologist", "Ad hoc member (cardiology)"], i)}: ` +
        `${pick(["Dr. A. Novak", "Dr. R. Chen", "Prof. M. Okafor", "Dr. S. Lindqvist", "Dr. J. Marsh", "Dr. E. Fontaine"], i)} - ` +
        `${pick(["appointed 2024", "appointed 2025", "appointed 2026"], i * 2)}`,
    })),
    { h: 1, text: "7.2  Standing Recommendation Log" },
    ...Array.from({ length: 24 }, (_, i) => ({
      li: `${daysAgo(20 + i * 50)} - ${pick(["continue as planned", "continue; monitor hepatic events", "continue; no concerns", "request enrolment update at next meeting", "clarification on stopping-rule application"], i)}.`,
    })),
    { fig: { kind: "line", caption: "Enrollment reviewed by the board over time" } },
    { h: 1, text: "8  Appendix - Meeting Minutes" },
    ...Array.from({ length: 30 }, (_, i) => [
      { h: 2, text: `8.${i + 1}  Meeting of ${daysAgo(30 + i * 42)}` },
      { kv: `Attendance:          ${3 + (i % 3)} of 5 voting members (quorum met)` },
      { kv: `Format:              ${pick(["videoconference", "in-person", "hybrid"], i)}` },
      { kv: `Data cutoff:         ${daysAgo(40 + i * 42)}` },
      {
        p: `The board reviewed enrolment status, exposure, adverse events ` +
          `by treatment group, and the prespecified ${pick(["safety monitoring plan", "interim analysis output", "protocol deviation summary", "benefit-risk assessment"], i)}. ` +
          `Recommendation: ${pick(["continue the study as planned", "continue with increased hepatic monitoring", "continue; no safety concerns identified", "sponsor to provide additional analyses of cardiac events"], i)}.`,
      },
      "gap",
    ] as Block[]).flat(),
  ];
}

const DOCS: { spec: () => DocSpec }[] = [
  {
    spec: () => ({
      n: 1,
      fileName: "Protocol_Amendment_3_DBX-114.pdf",
      title: "Protocol Amendment 3 - DBX-114-ONC-014",
      meta: [
        "PROTOCOL AMENDMENT 3",
        "",
        "Study DBX-114-ONC-014",
        "A Phase II Randomized Trial of DBX-114 plus Standard of Care",
        `Sponsor: ${SPONSOR}`,
        `Amendment date: ${daysAgo(20)}`,
        "Version: 3.0 (final)",
      ],
      blocks: protocolBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 2,
      fileName: "Informed_Consent_Form_v2.1_DBX-114.pdf",
      title: "Informed Consent Form v2.1",
      meta: [
        "INFORMED CONSENT FORM",
        "",
        "Study DBX-114-ONC-014",
        `Sponsor: ${SPONSOR}`,
        "Version: 2.1",
        `Approved by Central IRB: ${daysAgo(32)}`,
      ],
      blocks: icfBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 3,
      fileName: "Site_Monitoring_Report_2026-Q3.pdf",
      title: "Site Monitoring Report - Q3 2026",
      meta: [
        "SITE MONITORING REPORT",
        "",
        "Study DBX-114-ONC-014",
        "Reporting period: Q3 2026",
        `Sponsor: ${SPONSOR}`,
        `Report date: ${daysAgo(10)}`,
      ],
      blocks: monitoringBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 4,
      fileName: "Serious_Adverse_Event_Log_SAE-004.pdf",
      title: "Serious Adverse Event Log",
      meta: [
        "SERIOUS ADVERSE EVENT LOG",
        "",
        "Study DBX-114-ONC-014",
        `Sponsor: ${SPONSOR}`,
        `Log extract date: ${daysAgo(5)}`,
        "MedDRA v28.0 coded",
      ],
      blocks: saeBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 5,
      fileName: "Investigator_Brochure_v9.0_DBX-114.pdf",
      title: "Investigator's Brochure v9.0 - DBX-114",
      meta: [
        "INVESTIGATOR'S BROCHURE",
        "",
        "Compound: DBX-114",
        "Edition: 9.0 (annual update)",
        `Sponsor: ${SPONSOR}`,
        `Data cut-off: ${daysAgo(60)}`,
        "Confidential - for investigator use only",
      ],
      blocks: ibBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 6,
      fileName: "Statistical_Analysis_Plan_v3.0.pdf",
      title: "Statistical Analysis Plan v3.0",
      meta: [
        "STATISTICAL ANALYSIS PLAN",
        "",
        "Study DBX-114-ONC-014",
        `Sponsor: ${SPONSOR}`,
        "Version: 3.0 (final, pre-database-lock)",
        `Date: ${daysAgo(15)}`,
      ],
      blocks: sapBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 7,
      fileName: "CSR_Synopsis_DBX-114-012.pdf",
      title: "Clinical Study Report Synopsis - DBX-114-012",
      meta: [
        "CLINICAL STUDY REPORT - SYNOPSIS",
        "",
        "Study DBX-114-012",
        `Sponsor: ${SPONSOR}`,
        `Report date: ${daysAgo(45)}`,
      ],
      blocks: csrBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 8,
      fileName: "Pharmacy_Manual_IP_Handling_v1.4.pdf",
      title: "Pharmacy Manual - IP Handling v1.4",
      meta: [
        "PHARMACY MANUAL",
        "",
        "Investigational Product: DBX-114",
        `Sponsor: ${SPONSOR}`,
        "Version: 1.4",
        `Effective date: ${daysAgo(25)}`,
      ],
      blocks: pharmacyBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 9,
      fileName: "Safety_Management_Plan_v1.2.pdf",
      title: "Safety Management Plan v1.2",
      meta: [
        "SAFETY MANAGEMENT PLAN",
        "",
        "Programme: DBX-114 clinical development",
        `Sponsor: ${SPONSOR}`,
        "Version: 1.2",
        `Effective date: ${daysAgo(40)}`,
      ],
      blocks: safetyBlocks(),
    }),
  },
  {
    spec: () => ({
      n: 10,
      fileName: "DSMB_Charter_v2.0.pdf",
      title: "DSMB Charter v2.0",
      meta: [
        "DATA SAFETY MONITORING BOARD CHARTER",
        "",
        "Programme: DBX-114 clinical development",
        `Sponsor: ${SPONSOR}`,
        "Version: 2.0",
        `Effective date: ${daysAgo(90)}`,
      ],
      blocks: dsmbBlocks(),
    }),
  },
];

// ---------------------------------------------------------------------------
// Job history: ~3 weeks of deliveries. `pending` jobs go live by themselves
// when the dispatcher is running; `failFirstTask` leaves one task failed so
// the UI's error drill-down has content.
// ---------------------------------------------------------------------------

interface DemoJob {
  n: number;
  submitterEmail: string;
  fileNs: number[];
  destinations: { team: string; binder: string; folder: string[] }[];
  daysAgo: number; // fractional ok
  pending?: boolean;
  failFirstTask?: boolean;
}

const JOBS: DemoJob[] = [
  {
    n: 1,
    submitterEmail: "demo@docbridge.local",
    fileNs: [1, 2, 3],
    daysAgo: 21,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Cardiology Site B", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Central Regulatory", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Central Regulatory", binder: "Binder 2", folder: ["Reports"] },
    ],
  },
  {
    n: 2,
    submitterEmail: "anna@docbridge.local",
    fileNs: [4, 5],
    daysAgo: 19,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 1", folder: ["Inbox", "Archive"] },
      { team: "Central Regulatory", binder: "Binder 1", folder: ["Reports"] },
    ],
  },
  {
    n: 3,
    submitterEmail: "admin@docbridge.local",
    fileNs: [6, 9],
    daysAgo: 16,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 2", folder: ["Inbox"] },
      { team: "Cardiology Site B", binder: "Binder 2", folder: ["Inbox"] },
      { team: "Central Regulatory", binder: "Binder 2", folder: ["Inbox"] },
    ],
  },
  {
    n: 4,
    submitterEmail: "ben@docbridge.local",
    fileNs: [10],
    daysAgo: 13,
    destinations: [
      { team: "Cardiology Site B", binder: "Binder 1", folder: ["Reports"] },
    ],
  },
  {
    n: 5,
    submitterEmail: "anna@docbridge.local",
    fileNs: [2, 7],
    daysAgo: 10,
    destinations: [
      { team: "Central Regulatory", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Central Regulatory", binder: "Binder 2", folder: ["Inbox"] },
    ],
  },
  {
    n: 6,
    submitterEmail: "demo@docbridge.local",
    fileNs: [5],
    daysAgo: 8,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 1", folder: ["Reports"] },
      { team: "Central Regulatory", binder: "Binder 2", folder: ["Reports"] },
    ],
  },
  {
    n: 7,
    submitterEmail: "admin@docbridge.local",
    fileNs: [1, 6],
    daysAgo: 5,
    destinations: [
      { team: "Cardiology Site B", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Cardiology Site B", binder: "Binder 2", folder: ["Reports"] },
    ],
  },
  {
    n: 8,
    submitterEmail: "anna@docbridge.local",
    fileNs: [3, 8],
    daysAgo: 3,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Oncology Site A", binder: "Binder 2", folder: ["Inbox"] },
    ],
  },
  {
    n: 9,
    submitterEmail: "anna@docbridge.local",
    fileNs: [9, 10],
    daysAgo: 1,
    failFirstTask: true,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 1", folder: ["Reports"] },
      { team: "Central Regulatory", binder: "Binder 1", folder: ["Inbox"] },
    ],
  },
  {
    n: 10,
    submitterEmail: "demo@docbridge.local",
    fileNs: [2, 4],
    daysAgo: 0.5,
    destinations: [
      { team: "Central Regulatory", binder: "Binder 1", folder: ["Inbox"] },
    ],
  },
  {
    n: 11,
    submitterEmail: "demo@docbridge.local",
    fileNs: [3, 8],
    daysAgo: 0,
    pending: true,
    destinations: [
      { team: "Oncology Site A", binder: "Binder 1", folder: ["Inbox"] },
      { team: "Cardiology Site B", binder: "Binder 1", folder: ["Inbox"] },
    ],
  },
];

async function main() {
  const auth = createAuthClient(authUrl);
  const docbridge = createDocbridgeClient(docbridgeUrl);
  const platform = createPlatformClient(platformUrl);

  const teamCount = await platform.team.count();
  const users = await auth.user.findMany({
    where: {
      email: {
        in: [
          "anna@docbridge.local",
          "ben@docbridge.local",
          "admin@docbridge.local",
        ],
      },
    },
  });
  if (teamCount === 0 || users.length < 3) {
    throw new Error("Base data missing — run `pnpm db:seed` first");
  }
  const byEmail = new Map(users.map((u) => [u.email, u]));

  // Demo user: member of all teams so one login can drive every flow.
  const teams = await platform.team.findMany({ select: { id: true } });
  const passwordHash = await argon2.hash(DEMO_PASSWORD);
  await auth.user.upsert({
    where: { id: DEMO_USER_ID },
    update: {},
    create: {
      id: DEMO_USER_ID,
      email: "demo@docbridge.local",
      passwordHash,
      displayName: "Demo Grader",
      isAdmin: false,
    },
  });
  const demoUser = await auth.user.findUniqueOrThrow({
    where: { email: "demo@docbridge.local" },
  });
  for (const team of teams) {
    await auth.teamMembership.upsert({
      where: { userId_teamId: { userId: demoUser.id, teamId: team.id } },
      update: {},
      create: { userId: demoUser.id, teamId: team.id },
    });
  }
  byEmail.set(demoUser.email, demoUser);

  // Resolve destination folder ids and build "Team / Binder / ..." paths
  // exactly like the platform's folderPath() does.
  const folderRows = await platform.folder.findMany({
    include: { binder: { include: { team: true } } },
  });
  const foldersById = new Map(folderRows.map((f) => [f.id, f]));
  const findFolder = (team: string, binder: string, chain: string[]) => {
    let parentId: string | null = null;
    let folder = undefined as (typeof folderRows)[number] | undefined;
    for (const name of chain) {
      folder = folderRows.find(
        (f) =>
          f.binder.team.name === team &&
          f.binder.name === binder &&
          f.name === name &&
          f.parentFolderId === parentId,
      );
      if (!folder) {
        throw new Error(
          `seeded folder not found: ${team}/${binder}/${chain.join("/")}`,
        );
      }
      parentId = folder.id;
    }
    const names: string[] = [];
    let cur = folder;
    while (cur) {
      names.unshift(cur.name);
      cur = cur.parentFolderId ? foldersById.get(cur.parentFolderId) : undefined;
    }
    return {
      folderId: folder!.id,
      teamId: folder!.binder.team.id,
      path: [team, binder, ...names].join(" / "),
    };
  };

  // Generate all documents once; bytes are reused across jobs. Fixtures go
  // to demo-files/ so local testers have realistic uploads on hand.
  const fixtureDir = join(process.cwd(), "demo-files");
  mkdirSync(fixtureDir, { recursive: true });
  const pdfs = new Map<number, Buffer>();
  const specByN = new Map<number, DocSpec>();
  for (const { spec } of DOCS) {
    const s = spec();
    specByN.set(s.n, s);
    const pdf = renderPdf(s);
    pdfs.set(s.n, pdf);
    writeFileSync(join(fixtureDir, s.fileName), pdf);
  }

  const put = (bucket: string, key: string, body: Buffer, checksum: string) =>
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/pdf",
        ChecksumCRC32C: checksum,
      }),
    );

  // Each (job, file) pair is its own staged file row — deterministic ids.
  let fileCounter = 0;
  const stagedFileId = new Map<string, number>();
  let taskCounter = 0;
  const checksumCache = new Map<number, string>();
  const crc32cBase64 = async (data: Buffer): Promise<string> => {
    const crc = new AwsCrc32c();
    crc.update(data);
    return Buffer.from(await crc.digest()).toString("base64");
  };
  const checksumOf = async (n: number) => {
    let c = checksumCache.get(n);
    if (!c) {
      c = await crc32cBase64(pdfs.get(n)!);
      checksumCache.set(n, c);
    }
    return c;
  };

  for (const job of JOBS) {
    const submittedAt = new Date(Date.now() - job.daysAgo * 86400_000);
    const stagedAt = new Date(submittedAt.getTime() - 30 * 60_000);
    const completedAt = job.pending
      ? null
      : new Date(submittedAt.getTime() + 15 * 60_000);
    const submitter = byEmail.get(job.submitterEmail)!;
    const destinations = job.destinations.map((d) =>
      findFolder(d.team, d.binder, d.folder),
    );
    const teamIds = [...new Set(destinations.map((d) => d.teamId))];
    const jobFileNs = job.fileNs;
    const tasksCount = jobFileNs.length * destinations.length;

    await docbridge.job.upsert({
      where: { id: jobId(job.n) },
      update: {
        submittedAt,
        completedAt,
        filesCount: jobFileNs.length,
        tasksCount,
      },
      create: {
        id: jobId(job.n),
        submitterUserId: submitter.id,
        submitterDisplayName: submitter.displayName,
        submittedAt,
        completedAt,
        filesCount: jobFileNs.length,
        tasksCount,
      },
    });
    for (const teamId of teamIds) {
      await docbridge.jobTeam.upsert({
        where: { jobId_teamId: { jobId: jobId(job.n), teamId } },
        update: {},
        create: { jobId: jobId(job.n), teamId },
      });
    }

    for (const fn of jobFileNs) {
      fileCounter++;
      const fN = fileCounter;
      stagedFileId.set(`${job.n}:${fn}`, fN);
      const spec = specByN.get(fn)!;
      const pdf = pdfs.get(fn)!;
      const checksum = await checksumOf(fn);
      const storageKey = `staged/${submitter.id}/${fileId(fN)}`;
      await put(stagingBucket, storageKey, pdf, checksum);
      await docbridge.stagedFile.upsert({
        where: { id: fileId(fN) },
        update: {
          stagedAt,
          checksumCrc32c: checksum,
          sizeBytes: pdf.length,
          ownerUserId: submitter.id,
          jobId: jobId(job.n),
          storageKey,
        },
        create: {
          id: fileId(fN),
          ownerUserId: submitter.id,
          jobId: jobId(job.n),
          fileName: spec.fileName,
          contentType: "application/pdf",
          sizeBytes: pdf.length,
          checksumCrc32c: checksum,
          storageKey,
          status: "staged",
          stagedAt,
        },
      });
    }

    let firstTask = true;
    for (const fn of jobFileNs) {
      const pdf = pdfs.get(fn)!;
      const spec = specByN.get(fn)!;
      const checksum = await checksumOf(fn);
      for (const dest of destinations) {
        taskCounter++;
        const fN = stagedFileId.get(`${job.n}:${fn}`)!;
        const failed = Boolean(job.failFirstTask && firstTask);
        firstTask = false;

        const startedAt = new Date(submittedAt.getTime() + 60_000);
        const finishedAt = new Date(
          startedAt.getTime() + (failed ? 3 : 1.5) * 60_000,
        );

        // Upsert on the (job, file, folder) unique triple so re-runs reuse
        // the existing task row (and its real id) instead of colliding.
        const taskWhere = {
          jobId_stagedFileId_destinationFolderId: {
            jobId: jobId(job.n),
            stagedFileId: fileId(fN),
            destinationFolderId: dest.folderId,
          },
        } as const;
        const base = {
          jobId: jobId(job.n),
          stagedFileId: fileId(fN),
          destinationFolderId: dest.folderId,
          destinationTeamId: dest.teamId,
          destinationPath: dest.path,
        };
        const task = job.pending
          ? // Pending tasks may already be claimed by the live dispatcher
            // — create if absent but never downgrade an in-flight row.
            await docbridge.task.upsert({
              where: taskWhere,
              update: {},
              create: {
                ...base,
                id: taskId(taskCounter),
                status: "pending",
              },
            })
          : failed
            ? await docbridge.task.upsert({
                where: taskWhere,
                update: {
                  status: "failed",
                  dispatchedAt: submittedAt,
                  attemptCount: 3,
                  startedAt,
                  finishedAt,
                  lastErrorCode: "platform_unavailable",
                  lastErrorMessage:
                    "destination platform returned HTTP 503",
                  platformDocumentId: null,
                  platformVersionNo: null,
                },
                create: {
                  ...base,
                  id: taskId(taskCounter),
                  status: "failed",
                  dispatchedAt: submittedAt,
                  attemptCount: 3,
                  startedAt,
                  finishedAt,
                  lastErrorCode: "platform_unavailable",
                  lastErrorMessage:
                    "destination platform returned HTTP 503",
                },
              })
            : await docbridge.task.upsert({
                where: taskWhere,
                update: {
                  status: "completed",
                  dispatchedAt: submittedAt,
                  attemptCount: 1,
                  startedAt,
                  finishedAt,
                  lastErrorCode: null,
                  lastErrorMessage: null,
                },
                create: {
                  ...base,
                  id: taskId(taskCounter),
                  status: "completed",
                  dispatchedAt: submittedAt,
                  attemptCount: 1,
                  startedAt,
                  finishedAt,
                },
              });
        const id = task.id;

        if (job.pending) continue;
        await docbridge.taskAttempt.deleteMany({ where: { taskId: id } });

        if (failed) {
          // 3-attempt failure: 2 retryable, then permanent (platform 503).
          for (const [attemptNo, outcome] of [
            [1, "failed_retryable"],
            [2, "failed_retryable"],
            [3, "failed_permanent"],
          ] as const) {
            const aStart = new Date(
              startedAt.getTime() + (attemptNo - 1) * 60_000,
            );
            await docbridge.taskAttempt.create({
              data: {
                taskId: id,
                attemptNo,
                startedAt: aStart,
                finishedAt: new Date(aStart.getTime() + 30_000),
                outcome,
                errorCode: "platform_unavailable",
                errorMessage: "destination platform returned HTTP 503",
                workerId: `worker-${attemptNo}`,
              },
            });
          }
          continue;
        }

        const storageKey = `versions/${id}`;
        const document = await platform.document.upsert({
          where: {
            folderId_name: {
              folderId: dest.folderId,
              name: spec.fileName,
            },
          },
          update: {},
          create: {
            id: docId(0x100 + taskCounter),
            folderId: dest.folderId,
            name: spec.fileName,
          },
        });
        const existingVersions = await platform.documentVersion.count({
          where: { documentId: document.id },
        });
        const version = await platform.documentVersion.upsert({
          where: { deliveryTaskId: id },
          update: {
            storageKey,
            sizeBytes: pdf.length,
            checksumCrc32c: checksum,
          },
          create: {
            id: versionId(0x100 + taskCounter),
            documentId: document.id,
            versionNo: existingVersions + 1,
            storageKey,
            sizeBytes: pdf.length,
            checksumCrc32c: checksum,
            contentType: "application/pdf",
            submittedByUserId: submitter.id,
            deliveryTaskId: id,
          },
        });
        await put(platformBucket, storageKey, pdf, checksum);
        await docbridge.task.update({
          where: { id },
          data: {
            platformDocumentId: document.id,
            platformVersionNo: version.versionNo,
          },
        });
        await docbridge.taskAttempt.create({
          data: {
            taskId: id,
            attemptNo: 1,
            startedAt,
            finishedAt,
            outcome: "succeeded",
            workerId: "demo-seed",
          },
        });
      }
    }
  }

  const [jobs, tasks, staged, docs, versions] = await Promise.all([
    docbridge.job.count(),
    docbridge.task.count({ where: { status: "completed" } }),
    docbridge.stagedFile.count(),
    platform.document.count(),
    platform.documentVersion.count(),
  ]);
  console.log(
    `demo seed done: jobs=${jobs} completedTasks=${tasks} stagedFiles=${staged} ` +
      `platformDocs=${docs} versions=${versions}`,
  );
  console.log(`fixture PDFs written to ${fixtureDir}`);

  const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
  console.log(`
--- grader handout ---------------------------------------------------
  URL:       ${webOrigin}
  Accounts:  demo@docbridge.local   (all teams)
             anna@docbridge.local   (Oncology Site A, Central Regulatory)
             ben@docbridge.local    (Cardiology Site B)
             admin@docbridge.local  (admin: users & teams)
  Password:  ${DEMO_PASSWORD}  (all accounts)

  Try: log in -> Jobs (~3 weeks of delivered distributions, files
       downloadable; one job has a failed delivery to drill into, the
       newest completes on its own) -> Upload -> map destinations ->
       submit -> watch the job detail go live.
----------------------------------------------------------------------`);

  await auth.$disconnect();
  await docbridge.$disconnect();
  await platform.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
