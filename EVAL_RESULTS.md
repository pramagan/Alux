# Alux Eval Summary

Aggregate accuracy results only — no video titles, URLs, channels, or any
other personal watch-history content. This is generated from a small,
hand-labeled set of well-known public videos (see `evals/dataset.json`,
itself not published — this repo's `evals/` folder is git-ignored), each
checked against a plain-language instruction (e.g. "alert me if I'm
watching food videos") using the exact same production classification
pipeline (`lib/watch.js`, `lib/openrouter.js`) that runs inside the
extension itself — not a reimplementation.

## Latest run

- **Date:** 2026-09-20
- **Cases:** 5 (5 scored, 0 errored)
- **Accuracy:** 100%
- **False positives:** 0
- **False negatives:** 0

## History

| Date | Cases scored | Accuracy | False positives | False negatives | Errors |
| --- | --- | --- | --- | --- | --- |
| 2026-09-20 | 5 | 100% | 0 | 0 | 0 |
| 2026-09-20 | 5 | 100% | 0 | 0 | 0 |

---
_Regenerate with `node evals/summarize.js` after adding more hand-labeled
cases to `evals/dataset.json` and re-running `npm run eval`. This file is
the only eval-related artifact meant to be committed — everything else under
`evals/` stays local (see `.gitignore`)._
