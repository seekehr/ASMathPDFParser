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

/**
 * Free OpenRouter vision models. Requests start with the first; when a model errors (free models are
 * often rate-limited upstream) the next one is tried. Questions are sent as page images because the
 * maths isn't in the PDF text layer.
 */
export const OPENROUTER_MODELS = (
  process.env.OPENROUTER_MODELS || "google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free,thinkingmachines/inkling:free"
)
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);
/**
 * Page images per request. Free models allow only 50 requests a day (20 a minute) but don't cap
 * tokens, so each request carries several pages: all 326 questions take about 17 requests.
 */
export const IMAGES_PER_REQUEST = Number(process.env.IMAGES_PER_REQUEST) || 6;
/** Labelling pages: A4 packed edge to edge, rendered at this width (px) so the maths stays legible. */
export const LABEL_PAGE = { margin: 12 };
export const LABEL_IMAGE_WIDTH = 1240;
