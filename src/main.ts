import fs from "node:fs";
import path from "node:path";
import { INPUT_PDF, LABELS, LABELS_FILE, OUT_DIR, PAPER } from "./config.js";
import { Composer, pageStrip } from "./layout.js";
import { labelQuestions, loadLabels, saveLabels, type LabelMap } from "./label.js";
import { analyze, groupQuestions, loadClean, questionKey, type PageInfo, type Question } from "./source.js";

const skipLabels = process.argv.includes("--no-label");

async function main() {
  console.log(`Loading ${INPUT_PDF}`);
  const src = await loadClean(INPUT_PDF);
  console.log("Analyzing pages (cached after the first run)");
  const pages = await analyze(src, INPUT_PDF);
  const all = groupQuestions(pages);
  const questions = all.filter((q) => q.paper === PAPER);
  console.log(`Found ${all.length} questions, keeping ${questions.length} from Paper ${PAPER}`);

  const keys = questions.map(questionKey);
  let labels = loadLabels();
  const unlabelled = questions.filter((q) => !labels[questionKey(q)]);
  if (unlabelled.length && !skipLabels) {
    console.log(`Labelling ${unlabelled.length} questions with Gemini`);
    labels = await labelQuestions(
      unlabelled.map((q) => ({ key: questionKey(q), id: questions.indexOf(q) + 1 })),
      keys,
      async (batch) => {
        const qs = batch.map((j) => questions[j.id - 1]);
        // pack questions several to a page: Gemini bills PDFs per page, so fewer pages = fewer tokens
        const c = await Composer.create(src, pages, qs.flatMap((q) => q.qp));
        qs.forEach((q, i) => {
          const qpHeight = q.qp.reduce((h, p) => h + (pageStrip(pages[p]) ? c.stripHeight(pageStrip(pages[p])!) : 0), 0);
          c.ensure(c.textHeight(12) + 4 + qpHeight);
          c.text(`ID ${batch[i].id}`, { size: 12, bold: true });
          c.space(4);
          for (const p of q.qp) strip(c, pages[p], true);
          c.space(16);
        });
        return c.doc.save();
      },
    );
  }

  saveLabels(labels, keys);
  console.log(`Wrote ${LABELS_FILE}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await write(path.join(OUT_DIR, "P3_hardest_questions.pdf"), await byQuestion(src, pages, questions, labels));
  await write(path.join(OUT_DIR, "P3_questions_then_answers.pdf"), await questionsThenAnswers(src, pages, questions, labels));
}

async function write(file: string, c: Composer) {
  fs.writeFileSync(file, await c.doc.save());
  console.log(`Wrote ${file} (${c.doc.getPageCount()} pages)`);
}

function strip(c: Composer, info: PageInfo, keepWhole = false) {
  const s = pageStrip(info);
  if (s) c.strip(s, keepWhole);
}

function title(q: Question, n: number) {
  return `Q${n}   ${q.session}  |  Paper ${q.paper} (variant ${q.variant})  |  Question ${q.qnum}`;
}

function topics(q: Question, labels: LabelMap) {
  const ls = labels[questionKey(q)];
  return `Topics: ${ls ? (ls.length ? ls.join(", ") : "none of the listed topics") : "not labelled yet"}`;
}

function topicIndex(c: Composer, questions: Question[], labels: LabelMap) {
  c.text("Topic index", { size: 14, bold: true });
  c.space(6);
  for (const label of LABELS) {
    const nums = questions.flatMap((q, i) => (labels[questionKey(q)]?.includes(label) ? [`Q${i + 1}`] : []));
    c.ensure(c.textHeight(10) * 2);
    c.text(`${label} (${nums.length})`, { bold: true });
    c.text(nums.join(", ") || "-", { size: 9, grey: true });
    c.space(6);
  }
  c.newPage();
}

function sectionHeading(c: Composer, text: string, info: PageInfo | undefined) {
  const first = info && pageStrip(info);
  c.ensure(c.textHeight(9) + Math.min(first ? c.stripHeight(first) : 0, 60));
  c.text(text, { size: 9, bold: true, grey: true });
  c.space(2);
}

function questionBlock(c: Composer, pages: PageInfo[], q: Question, n: number, labels: LabelMap) {
  const qpHeight = q.qp.reduce((h, p) => h + (pageStrip(pages[p]) ? c.stripHeight(pageStrip(pages[p])!) : 0), 0);
  c.ensure(c.textHeight(11) + c.textHeight(9) + 6 + qpHeight);
  c.text(title(q, n), { size: 11, bold: true });
  c.text(topics(q, labels), { size: 9, grey: true });
  c.space(6);
  for (const p of q.qp) strip(c, pages[p], true);
}

function answerBlock(c: Composer, pages: PageInfo[], q: Question) {
  c.space(10);
  sectionHeading(c, "Examiner comment", pages[q.er[0]]);
  for (const p of q.er) strip(c, pages[p]);
  c.space(10);
  sectionHeading(c, "Mark scheme", pages[q.ms[0]]);
  for (const p of q.ms) strip(c, pages[p]);
}

function separator(c: Composer) {
  c.space(14);
  if (c.remaining > 40) {
    c.rule();
    c.space(14);
  } else c.newPage();
}

const allPages = (qs: Question[]) => qs.flatMap((q) => [...q.qp, ...q.er, ...q.ms]);

/** Each question followed by its examiner comment and mark scheme. */
async function byQuestion(src: Awaited<ReturnType<typeof loadClean>>, pages: PageInfo[], questions: Question[], labels: LabelMap) {
  const c = await Composer.create(src, pages, allPages(questions));
  topicIndex(c, questions, labels);
  questions.forEach((q, i) => {
    questionBlock(c, pages, q, i + 1, labels);
    answerBlock(c, pages, q);
    separator(c);
  });
  return c;
}

/** All questions first, then all examiner comments and mark schemes. */
async function questionsThenAnswers(src: Awaited<ReturnType<typeof loadClean>>, pages: PageInfo[], questions: Question[], labels: LabelMap) {
  const c = await Composer.create(src, pages, allPages(questions));
  topicIndex(c, questions, labels);
  c.text("Questions", { size: 16, bold: true });
  c.space(10);
  questions.forEach((q, i) => {
    questionBlock(c, pages, q, i + 1, labels);
    separator(c);
  });
  c.newPage();
  c.text("Examiner comments and mark schemes", { size: 16, bold: true });
  c.space(10);
  questions.forEach((q, i) => {
    c.ensure(60);
    c.text(title(q, i + 1), { size: 11, bold: true });
    answerBlock(c, pages, q);
    separator(c);
  });
  return c;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
