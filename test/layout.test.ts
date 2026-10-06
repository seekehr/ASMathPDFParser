import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { Composer, pageStrip } from "../src/layout.js";
import type { PageInfo } from "../src/source.js";

/** A one-page source PDF plus page info whose ink runs are 10pt lines with 4pt gaps from y=800 down to y=60. */
async function source() {
  const src = await PDFDocument.create();
  src.addPage([595, 842]).drawText("hello", { x: 30, y: 790 });
  const ink: [number, number][] = [];
  for (let top = 800; top - 10 >= 60; top -= 14) ink.push([top, top - 10]);
  const info: PageInfo = { index: 0, kind: "qp", head: "", ink, xMin: 25, xMax: 380 };
  // reload so the page content is a plain stream, as it is in the real book
  return { src: await PDFDocument.load(await src.save()), info };
}

test("pageStrip trims a page to its ink with a little padding", async () => {
  const { info } = await source();
  const s = pageStrip(info)!;
  assert.equal(s.top, 802);
  assert.equal(s.bottom, info.ink.at(-1)![1] - 2);
  assert.equal(pageStrip({ ...info, ink: [] }), null);
});

test("a strip taller than a page is split across pages at blank gaps", async () => {
  const { src, info } = await source();
  const c = await Composer.create(src, [info], [0]);
  const strip = pageStrip(info)!;
  assert.ok(c.stripHeight(strip) > c.pageHeight, "strip should not fit on one page");
  c.strip(strip);
  assert.equal(c.doc.getPageCount(), 2);
  // the output is a valid PDF that can be reloaded
  const reloaded = await PDFDocument.load(await c.doc.save());
  assert.equal(reloaded.getPageCount(), 2);
});

test("keepWhole moves a strip to a fresh page instead of splitting it", async () => {
  const { src, info } = await source();
  const c = await Composer.create(src, [info], [0]);
  // three of these fit on a page, a fourth doesn't
  const small = { page: 0, top: 802, bottom: 650 };
  c.strip(small);
  c.strip(small);
  c.strip(small);
  assert.equal(c.doc.getPageCount(), 1, "three small strips share a page");
  assert.ok(c.remaining < c.stripHeight(small));
  c.strip(small, true);
  assert.equal(c.doc.getPageCount(), 2);
  assert.ok(c.remaining > 0);
});

test("ensure starts a new page only when space runs out", async () => {
  const { src, info } = await source();
  const c = await Composer.create(src, [info], [0]);
  c.ensure(100);
  assert.equal(c.doc.getPageCount(), 1, "nothing is drawn yet, so no new page");
  c.text("line");
  c.ensure(c.remaining + 1);
  assert.equal(c.doc.getPageCount(), 2);
});
