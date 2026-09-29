// The table in docs/PROOF.md, and the counts other documents state about it.
//
// THE TABLE IS THE RECORD. Everything else that mentions a number of mainnet transactions is a
// description of the table, and a description can fall behind. On 2026-09-29 the table held
// nineteen rows while the sentence above it said seventeen, docs/CLAIMS.md said fifteen and eight,
// docs/ROADMAP.md said twelve and eight, and the proof screen of the app listed eight.
//
// Two readers need the same two rules, which is why they live here and not in either of them:
//
//   scripts/verify-proof.mjs     checks every row against public explorers, then warns when a
//                                document states a different count. It is the command someone runs
//                                just before quoting the number.
//   ui/src/proof-record.test.ts  runs in CI on every pull request, with no network. It holds the
//                                proof screen and the documents to the table.
//
// One parser and one pattern, read by both. A second copy of either is how this drifts again.
//
// No dependencies, and nothing here touches the network or the file system: both functions take
// text and return data, so a test can call them on a string.

/**
 * The rows of the proof table, in order.
 *
 * A row is `| what it proved | `<64 hex>` | block |`. The block cell is kept as written, because
 * the first row says "mined" where the others give a height.
 */
export function proofRows(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    // What counts as a row is the pattern the verifier has always used, unchanged. The block cell
    // is read from what follows the match, so reading it cannot change which lines are rows.
    const m = /^\|\s*(.+?)\s*\|\s*`([0-9a-f]{64})`\s*\|/.exec(line);
    if (!m) continue;
    rows.push({
      txid: m[2],
      label: m[1].replace(/\*\*/g, "").replace(/\s+/g, " ").trim(),
      block: (line.slice(m[0].length).split("|")[0] ?? "").trim(),
    });
  }
  return rows;
}

/**
 * The current documents that state how many transactions there are, as paths from the repository
 * root. Historical ones are left out on purpose: docs/HISTORY.md, docs/archive/, docs/incidents/
 * and the dated sections of a changelog describe a moment, and a moment does not get corrected.
 */
export const COUNT_DOCS = [
  "README.md",
  "CLAUDE.md",
  "docs/ARCHITECTURE.md",
  "docs/PROOF.md",
  "docs/CLAIMS.md",
  "docs/ROADMAP.md",
];

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
];
const NUM = `(\\d+|${WORDS.join("|")})`;

/**
 * Every count of the proof set a text states, as `{ said, n }`.
 *
 * It reads a number written in digits or spelled out, because two of the stale counts found on
 * 2026-09-29 were words ("fifteen", "eight") and a pattern for digits walked past them. Markdown
 * emphasis may sit between the number and the noun, as in "**eight** verifiable mainnet txids".
 *
 * It is narrow on purpose. "The first seven mainnet sends were signed on one machine" is a true
 * sentence about seven of the rows, not a count of the set, and it must not match.
 */
export function statedCounts(text) {
  const stated = new RegExp(
    `\\b${NUM}\\b\\**\\s+(?:independently\\s+)?verifiable\\s+(?:mainnet\\s+)?(?:txids|transactions)` +
      `|\\bclaims\\s+${NUM}\\s+real\\b`,
    "gi",
  );
  return [...text.matchAll(stated)].map((m) => {
    const said = (m[1] ?? m[2]).toLowerCase();
    return { said, n: /^\d+$/.test(said) ? Number(said) : WORDS.indexOf(said) };
  });
}
