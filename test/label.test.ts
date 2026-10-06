import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { IMAGES_PER_REQUEST } from "../src/config.js";
import { loadLabels, parseReply, planRequests, saveLabels, type LabelJob, type LabelMap } from "../src/label.js";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "labels-")), "labels.md");

test("labels survive a save/load round trip", () => {
  const file = tmpFile();
  const labels: LabelMap = {
    "Feb/Mar 2025 P3 v32 Q1": ["Indices, Logarithms & Exponents", "Algebra"],
    "Feb/Mar 2025 P3 v32 Q2": [],
  };
  saveLabels(labels, ["Feb/Mar 2025 P3 v32 Q1", "Feb/Mar 2025 P3 v32 Q2", "Feb/Mar 2025 P3 v32 Q3"], file);
  assert.deepEqual(loadLabels(file), labels);
});

test("labels file lists unlabelled questions with an empty cell and builds the topic index", () => {
  const file = tmpFile();
  saveLabels({ a: ["Integration"], b: [] }, ["a", "b", "c"], file);
  const md = fs.readFileSync(file, "utf8");
  assert.match(md, /^\| 1 \| a \| Integration \|$/m);
  assert.match(md, /^\| 2 \| b \| - \|$/m);
  assert.match(md, /^\| 3 \| c \|  \|$/m);
  assert.match(md, /### Integration \(1\)\n\nQ1\n/);
  assert.match(md, /### Algebra \(0\)\n\nNone\n/);
});

test("hand-edited labels are read back, and typos are rejected", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "| # | Question | Topics |\n|---|---|---|\n| 1 | x | Trigonometry ;  Integration |\n");
  assert.deepEqual(loadLabels(file), { x: ["Trigonometry", "Integration"] });
  fs.writeFileSync(file, "| 1 | x | Trig |\n");
  assert.throws(() => loadLabels(file), /unknown topic\(s\) Trig/);
});

test("a missing labels file means nothing is labelled", () => {
  assert.deepEqual(loadLabels(path.join(os.tmpdir(), "does-not-exist.md")), {});
});

test("parseReply extracts JSON wrapped in fences or prose", () => {
  assert.deepEqual(parseReply('```json\n{"1": [2, 5], "2": []}\n```'), { "1": [2, 5], "2": [] });
  assert.deepEqual(parseReply('Here you go: {"7": [1]} Hope that helps.'), { "7": [1] });
  assert.deepEqual(parseReply("no json here"), {});
});

test("planRequests respects the image limit and never splits a question", () => {
  // 30 questions over 12 images; question 10 spans two images
  const jobs: LabelJob[] = Array.from({ length: 30 }, (_, i) => ({
    key: `q${i}`,
    id: i + 1,
    images: i === 9 ? [3, 4] : [Math.floor((i * 12) / 30)],
  }));
  const requests = planRequests(jobs);
  assert.deepEqual(requests.flatMap((r) => r.jobs).map((j) => j.id), jobs.map((j) => j.id));
  for (const r of requests) {
    assert.ok(r.images.length <= IMAGES_PER_REQUEST);
    for (const j of r.jobs) for (const img of j.images) assert.ok(r.images.includes(img));
  }
  assert.equal(requests.length, Math.ceil(12 / IMAGES_PER_REQUEST));
});
