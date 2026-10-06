import assert from "node:assert/strict";
import { test } from "node:test";
import { groupQuestions, questionKey, type PageInfo, type PageKind } from "../src/source.js";

const page = (index: number, kind: PageKind, head = ""): PageInfo => ({ index, kind, head, ink: [], xMin: 0, xMax: 0 });

test("groupQuestions splits the book into questions with their pages", () => {
  const pages = [
    page(0, "front", "Cambridge International A Level"),
    page(1, "front", "Preface"),
    page(2, "er", "Q 1 / 541"),
    page(3, "qp", "Question Paper Feb/Mar 2025 • Paper 1 (variant 12) • Q3"),
    page(4, "ms", "Mark Scheme Feb/Mar 2025 • Paper 1 (variant 12) • Q3"),
    page(5, "er", "Q 2 / 541"),
    page(6, "qp", "Question Paper Oct/Nov 2016 • Paper 3 (variant 32) • Q10"),
    page(7, "cont"),
    page(8, "ms", "Mark Scheme Oct/Nov 2016 • Paper 3 (variant 32) • Q10"),
    page(9, "cont"),
    page(10, "cont"),
  ];
  const [p1, p3] = groupQuestions(pages);
  assert.deepEqual(p1, { sourceNo: 1, session: "Feb/Mar 2025", paper: 1, variant: "12", qnum: 3, er: [2], qp: [3], ms: [4] });
  // continuation pages belong to the section before them
  assert.deepEqual(p3, { sourceNo: 2, session: "Oct/Nov 2016", paper: 3, variant: "32", qnum: 10, er: [5], qp: [6, 7], ms: [8, 9, 10] });
  assert.equal(questionKey(p3), "Oct/Nov 2016 P3 v32 Q10");
});

test("groupQuestions rejects a question paper page with an unexpected header", () => {
  assert.throws(() => groupQuestions([page(0, "er", "Q 1 / 5"), page(1, "qp", "Question Paper something else")]), /Unexpected question paper header on page 2/);
});
