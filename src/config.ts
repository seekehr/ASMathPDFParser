export const INPUT_PDF = "public/9709_hardest_questions_v2.pdf";
export const OUT_DIR = "out";
export const CACHE_DIR = ".cache";
/** Labels live in a markdown table so they can be read and hand-edited; it doubles as the label cache. */
export const LABELS_FILE = "out/labels.md";

/** Only questions from this paper are kept. */
export const PAPER = 3;

export const LABELS = [
  "Algebra",
  "Indices, Logarithms & Exponents",
  "Trigonometry",
  "Differentiation",
  "Integration",
  "Differential Equations",
  "Complex Numbers",
  "Numerical Solutions/Iteration",
] as const;
export type Label = (typeof LABELS)[number];

export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
/**
 * Questions sent to Gemini per request. Batches are large because the free tier allows few
 * requests per minute/day; at ~110 questions a request, all 326 take 3 requests.
 */
export const LABEL_BATCH_SIZE = Number(process.env.GEMINI_BATCH_SIZE) || 110;
/** Minimum gap between Gemini requests, to stay under free-tier requests-per-minute and tokens-per-minute. */
export const GEMINI_MIN_INTERVAL_S = Number(process.env.GEMINI_MIN_INTERVAL_S) || 30;
