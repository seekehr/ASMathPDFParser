# ASMathPDFParser

Turns `public/9709_hardest_questions_v2.pdf` (541 questions, 1636 pages) into a plain, topic-labelled
Paper 3 booklet:

- Paper 1 questions are dropped (326 Paper 3 questions remain).
- The watermark, badges, coloured headers, footers and cover/preface are removed, and the content
  is repacked onto A4 pages, so it's around 316 pages instead of 1636. Maths stays vector (sharp, selectable).
- Each question comes first, then the examiner comment, then the mark scheme.
- A free vision model on OpenRouter tags each question with one or more of: Algebra; Indices, Logarithms & Exponents;
  Trigonometry; Differentiation; Integration; Differential Equations; Complex Numbers;
  Numerical Solutions/Iteration. A topic index is on page 1.

## Usage

```bash
npm install
cp .example.env .env   # then put your OpenRouter API key in .env
npm run build
```

Outputs, in `out/`:

- `P3_hardest_questions.pdf`: question, then comment, then mark scheme, for each question
- `P3_questions_then_answers.pdf`: all questions first, then all comments and mark schemes
- `labels.md`: every question with its topics, plus an index by topic

`out/labels.md` is also the label cache, so the model is only called for questions with an empty Topics cell.
To relabel, clear a cell (or delete the file). You can also fix labels there by hand and rerun.

Labelling uses free (`:free`) vision models on OpenRouter, so it costs nothing. The maths is drawn as
shapes, not text, so the model reads page images. Free models allow 20 requests/min and 50/day, so the
questions are packed several per page image and sent 6 images per request: all 326 take about 17 requests.
OpenRouter falls back to the next model in `OPENROUTER_MODELS` when one is overloaded; other errors are
retried. If the daily limit is hit, the run stops with progress saved in `out/labels.md`; rerun later to finish.

`npm run build:no-label` builds without calling OpenRouter. See `.example.env` for optional settings.

## Testing without AI

- `npm test` runs unit tests for the parts that don't need a model: grouping pages into questions,
  cropping and page layout, reading and writing `out/labels.md`, request batching, and reply parsing.
- `npm run build:no-label` runs the whole pipeline except labelling and writes the PDFs to `out/`, with
  any labels already in `out/labels.md`.
- `npm run typecheck` checks types.

The first run renders every page to find where the content is (around 3 minutes). The result is cached in `.cache/`.
