import fs from "node:fs";
import path from "node:path";
import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { TextItem } from "pdfjs-dist/types/src/display/api.js";
import { createCanvas } from "@napi-rs/canvas";
import { CACHE_DIR } from "./config.js";

export type PageKind = "front" | "er" | "qp" | "ms" | "cont";

/** All y values are PDF user-space (origin bottom-left, y up). */
export interface PageInfo {
  index: number;
  kind: PageKind;
  /** First text line of the page. */
  head: string;
  /** Vertical runs of inked rows inside the useful region, top to bottom: [top, bottom]. */
  ink: [number, number][];
  xMin: number;
  xMax: number;
}

export interface Question {
  /** Position in the source book (1..541). */
  sourceNo: number;
  session: string;
  paper: number;
  variant: string;
  qnum: number;
  er: number[];
  qp: number[];
  ms: number[];
}

/**
 * Loads the book and blanks the "Coaching with Shuja" watermark. The watermark is a single
 * image drawn on every page through a small per-page Form XObject; we empty those forms.
 */
export async function loadClean(file: string): Promise<PDFDocument> {
  const doc = await PDFDocument.load(fs.readFileSync(file));
  const byImage = new Map<string, Set<PDFRef>>();
  for (const page of doc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    for (const [, ref] of xobjects?.entries() ?? []) {
      if (!(ref instanceof PDFRef)) continue;
      const form = doc.context.lookup(ref);
      if (!(form instanceof PDFStream) || form.dict.get(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
      const inner = form.dict
        .lookupMaybe(PDFName.of("Resources"), PDFDict)
        ?.lookupMaybe(PDFName.of("XObject"), PDFDict);
      for (const [, imgRef] of inner?.entries() ?? []) {
        const key = imgRef.toString();
        if (!byImage.has(key)) byImage.set(key, new Set());
        byImage.get(key)!.add(ref);
      }
    }
  }
  const [, forms] = [...byImage].sort((a, b) => b[1].size - a[1].size)[0] ?? [];
  if (!forms || forms.size < doc.getPageCount() / 2) throw new Error("Watermark XObject not found");
  for (const ref of forms) {
    doc.context.assign(ref, doc.context.stream("", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1] }));
  }
  return doc;
}

interface Line {
  text: string;
  y: number;
  size: number;
}

function textLines(items: TextItem[]): Line[] {
  const rows = new Map<number, TextItem[]>();
  for (const it of items) {
    if (!it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    const key = [...rows.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push(it);
  }
  return [...rows]
    .sort((a, b) => b[0] - a[0])
    .map(([y, its]) => ({
      y,
      size: Math.max(...its.map((i) => i.transform[3])),
      text: its
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    }));
}

/** A pixel counts as ink when it is darker than light-grey rules/badges. */
const INK = 200;

/** Bump when the analysis logic changes to invalidate the cache. */
const ANALYSIS_VERSION = 2;

/**
 * Classifies every page and measures where its real content is, by rendering it (without
 * the watermark) and scanning for inked rows between the page header and footer.
 */
export async function analyze(doc: PDFDocument, sourceFile: string): Promise<PageInfo[]> {
  const stat = fs.statSync(sourceFile);
  const cacheFile = path.join(CACHE_DIR, `analysis-v${ANALYSIS_VERSION}-${stat.size}-${Math.round(stat.mtimeMs)}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));

  const pdf = await getDocument({ data: await doc.save(), verbosity: 0 }).promise;
  const pages: PageInfo[] = [];
  let seenQuestion = false;
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const lines = textLines((await page.getTextContent()).items as TextItem[]);
    const head = lines[0]?.text ?? "";
    let kind: PageKind;
    if (/^Q \d+ \/ \d+/.test(head)) kind = "er";
    else if (head.startsWith("Question Paper")) kind = "qp";
    else if (head.startsWith("Mark Scheme")) kind = "ms";
    else kind = seenQuestion ? "cont" : "front";
    if (kind === "er") seenQuestion = true;

    const vp = page.getViewport({ scale: 1 });
    const footer = lines.find((l) => l.text.startsWith("CWS"));
    let top = vp.height;
    let bottom = footer ? footer.y + footer.size + 2 : 0;
    // skip the section title and the coloured accent bar that hangs below its baseline
    if (kind === "qp" || kind === "ms") top = lines[0].y - 9;
    if (kind === "er") {
      const title = lines.find((l) => l.text.startsWith("Examiner Report"));
      const source = lines.find((l) => l.text.startsWith("Source:"));
      if (title) top = title.y - 4;
      if (source) bottom = source.y + source.size + 1;
    }

    const info: PageInfo = { index: i, kind, head, ink: [], xMin: Infinity, xMax: -Infinity };
    if (kind !== "front") {
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      await page.render({ canvas: canvas as any, canvasContext: canvas.getContext("2d") as any, viewport: vp }).promise;
      const { data, width, height } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      let run: [number, number] | null = null;
      const firstRow = Math.max(0, Math.ceil(height - top));
      const lastRow = Math.min(height - 1, Math.floor(height - bottom));
      for (let r = firstRow; r <= lastRow; r++) {
        let inked = false;
        for (let c = 0; c < width; c++) {
          const o = (r * width + c) * 4;
          if (Math.min(data[o], data[o + 1], data[o + 2]) < INK && data[o + 3] > 0) {
            inked = true;
            info.xMin = Math.min(info.xMin, c);
            info.xMax = Math.max(info.xMax, c + 1);
          }
        }
        // pixel row r spans PDF y from height-r-1 up to height-r
        const y = height - r;
        if (inked) {
          if (run && run[1] === y) run[1] = y - 1;
          else info.ink.push((run = [y, y - 1]));
        }
      }
    }
    pages.push(info);
    page.cleanup();
    if ((i + 1) % 100 === 0) console.log(`  analyzed ${i + 1}/${pdf.numPages} pages`);
  }
  await pdf.cleanup();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(pages));
  return pages;
}

const HEADER_RE = /^Question Paper (.+?) • Paper (\d) \(variant (\d+)\) • Q(\d+)/;

export function groupQuestions(pages: PageInfo[]): Question[] {
  const questions: Question[] = [];
  let section: number[] | null = null;
  for (const p of pages) {
    const q = questions.at(-1);
    switch (p.kind) {
      case "front":
        break;
      case "er":
        questions.push({ sourceNo: Number(/^Q (\d+)/.exec(p.head)![1]), session: "", paper: 0, variant: "", qnum: 0, er: [], qp: [], ms: [] });
        section = questions.at(-1)!.er;
        section.push(p.index);
        break;
      case "qp": {
        const m = HEADER_RE.exec(p.head);
        if (!q || !m) throw new Error(`Unexpected question paper header on page ${p.index + 1}: ${p.head}`);
        Object.assign(q, { session: m[1], paper: Number(m[2]), variant: m[3], qnum: Number(m[4]) });
        (section = q.qp).push(p.index);
        break;
      }
      case "ms":
        (section = q!.ms).push(p.index);
        break;
      case "cont":
        section!.push(p.index);
        break;
    }
  }
  return questions;
}

/** Stable identifier used as the key in the labels file. */
export function questionKey(q: Question): string {
  return `${q.session} P${q.paper} v${q.variant} Q${q.qnum}`;
}
