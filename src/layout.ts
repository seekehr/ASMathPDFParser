import {
  PDFArray,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFPage,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  clip,
  concatTransformationMatrix,
  decodePDFRawStream,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
} from "pdf-lib";
import type { PageInfo } from "./source.js";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const DEFAULT_MARGIN = 42;
/** Vertical whitespace (in source units) that may be used as a split point. */
const MIN_SPLIT_GAP = 3;

/** A horizontal band of a source page, in source PDF coordinates (top > bottom). */
export interface Strip {
  page: number;
  top: number;
  bottom: number;
}

/** Trims a page to its inked rows. */
export function pageStrip(info: PageInfo): Strip | null {
  if (!info.ink.length) return null;
  return { page: info.index, top: info.ink[0][0] + 2, bottom: info.ink.at(-1)![1] - 2 };
}

/**
 * Flows cropped source-page strips and plain text onto clean A4 pages. Source content is
 * drawn as vector Form XObjects, so the maths stays sharp and selectable.
 */
export class Composer {
  readonly doc: PDFDocument;
  private forms = new Map<number, PDFRef>();
  private page!: PDFPage;
  private y = 0;
  private scale: number;
  private regular!: PDFFont;
  private bold!: PDFFont;

  private constructor(
    doc: PDFDocument,
    private src: PDFDocument,
    private pages: PageInfo[],
    private xLeft: number,
    xRight: number,
    private margin: number,
    private pageH: number,
  ) {
    this.doc = doc;
    this.scale = this.contentWidth / (xRight - xLeft);
  }

  private get contentWidth() {
    return PAGE_W - 2 * this.margin;
  }

  /** Pages are A4 unless `page` overrides the margin or the page height (in points). */
  static async create(
    src: PDFDocument,
    pages: PageInfo[],
    usedPages: number[],
    page: { margin?: number; height?: number } = {},
  ): Promise<Composer> {
    const used = usedPages.map((i) => pages[i]).filter((p) => p.ink.length);
    const xLeft = Math.min(...used.map((p) => p.xMin)) - 2;
    const xRight = Math.max(...used.map((p) => p.xMax)) + 2;
    const c = new Composer(await PDFDocument.create(), src, pages, xLeft, xRight, page.margin ?? DEFAULT_MARGIN, page.height ?? PAGE_H);
    c.regular = await c.doc.embedFont(StandardFonts.Helvetica);
    c.bold = await c.doc.embedFont(StandardFonts.HelveticaBold);
    await c.importForms([...new Set(usedPages)]);
    c.newPage();
    return c;
  }

  /** Copies source pages once and turns each into a reusable Form XObject. */
  private async importForms(indices: number[]) {
    const copied = await this.doc.copyPages(this.src, indices);
    const ctx = this.doc.context;
    copied.forEach((page, i) => {
      const contents = page.node.Contents();
      const streams = (contents instanceof PDFArray ? contents.asArray() : [contents]).map((r) =>
        r instanceof PDFRef ? ctx.lookup(r) : r,
      ) as PDFRawStream[];
      const bytes = Buffer.concat(streams.flatMap((s) => [Buffer.from(decodePDFRawStream(s).decode()), Buffer.from("\n")]));
      const { width, height } = page.getSize();
      const form = ctx.flateStream(bytes, {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, width, height],
        Resources: page.node.get(PDFName.of("Resources")),
      });
      this.forms.set(indices[i], ctx.register(form));
      // drop the orphaned page objects so they are not written twice
      if (contents instanceof PDFArray) contents.asArray().forEach((r) => r instanceof PDFRef && ctx.delete(r));
      else {
        const ref = page.node.get(PDFName.of("Contents"));
        if (ref instanceof PDFRef) ctx.delete(ref);
      }
      ctx.delete(page.ref);
    });
  }

  get remaining() {
    return this.y - this.margin;
  }

  get pageHeight() {
    return this.pageH - 2 * this.margin;
  }

  get atPageTop() {
    return this.y === this.pageH - this.margin;
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, this.pageH]);
    this.y = this.pageH - this.margin;
  }

  /** Starts a new page unless `h` points of space are left. */
  ensure(h: number) {
    if (!this.atPageTop && this.remaining < Math.min(h, this.pageHeight)) this.newPage();
  }

  space(h: number) {
    if (!this.atPageTop) this.y -= Math.min(h, this.remaining);
  }

  rule() {
    this.page.drawLine({
      start: { x: this.margin, y: this.y },
      end: { x: PAGE_W - this.margin, y: this.y },
      thickness: 0.5,
      color: rgb(0.6, 0.6, 0.6),
    });
  }

  textHeight(size: number) {
    return size * 1.35;
  }

  /** Draws wrapped text and returns nothing; caller should `ensure` space for the first line. */
  text(text: string, opts: { size?: number; bold?: boolean; grey?: boolean } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    for (const line of wrap(text, font, size, this.contentWidth)) {
      this.ensure(this.textHeight(size));
      this.y -= this.textHeight(size);
      this.page.drawText(line, {
        x: this.margin,
        y: this.y + size * 0.3,
        size,
        font,
        color: opts.grey ? rgb(0.35, 0.35, 0.35) : rgb(0, 0, 0),
      });
    }
  }

  stripHeight(s: Strip) {
    return (s.top - s.bottom) * this.scale;
  }

  /**
   * Draws a strip at the cursor. If it does not fit, it is split at a blank band so the top part
   * fills the current page, unless `keepWhole` is set and it would fit on a fresh page.
   */
  strip(s: Strip, keepWhole = false) {
    let rest: Strip | null = s;
    while (rest) {
      const h = this.stripHeight(rest);
      if (h <= this.remaining) {
        this.drawStrip(rest);
        return;
      }
      const freshPageHelps = h <= this.pageHeight;
      if (!this.atPageTop && (keepWhole && freshPageHelps)) {
        this.newPage();
        continue;
      }
      const cut = this.findCut(rest, this.remaining / this.scale);
      if (cut === null) {
        if (!this.atPageTop) this.newPage();
        else {
          // nothing blank to cut at: hard cut at the page bottom
          const hard: number = rest.top - this.remaining / this.scale;
          this.drawStrip({ ...rest, bottom: hard });
          rest = { ...rest, top: hard };
          this.newPage();
        }
        continue;
      }
      this.drawStrip({ ...rest, bottom: cut });
      rest = { ...rest, top: cut };
      this.newPage();
    }
  }

  /** Lowest blank band in the strip whose centre is within `maxHeight` of the strip top. */
  private findCut(s: Strip, maxHeight: number): number | null {
    const ink = this.pages[s.page].ink.filter(([t, b]) => t > s.bottom && b < s.top);
    let best: number | null = null;
    for (let i = 0; i + 1 < ink.length; i++) {
      const gapTop = ink[i][1];
      const gapBottom = ink[i + 1][0];
      if (gapTop - gapBottom < MIN_SPLIT_GAP) continue;
      const mid = (gapTop + gapBottom) / 2;
      if (mid < s.top && s.top - mid <= maxHeight && mid > s.bottom) best = mid;
    }
    return best;
  }

  private drawStrip(s: Strip) {
    const h = this.stripHeight(s);
    const name = this.page.node.newXObject("Src", this.forms.get(s.page)!);
    const bottom = this.y - h;
    this.page.pushOperators(
      pushGraphicsState(),
      rectangle(this.margin, bottom, this.contentWidth, h),
      clip(),
      endPath(),
      concatTransformationMatrix(this.scale, 0, 0, this.scale, this.margin - this.xLeft * this.scale, bottom - s.bottom * this.scale),
      drawObject(name),
      popGraphicsState(),
    );
    this.y = bottom;
  }
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
