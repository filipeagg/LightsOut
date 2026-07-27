/**
 * Exact-string edits to a document (MC-13, DESIGN §9.2b).
 *
 * Resending a 1500-line STATE.md to change one line is how the whole file becomes a thing that can
 * be lost. `patch_doc` edits it in place, and it is deliberately literal: no regular expressions,
 * no fuzzy matching, no "closest line". A `find` that matches nothing is a caller who is looking at
 * a different version of the file; a `find` that matches three times when the caller expected one
 * is a caller about to change the wrong one. Both are refused, with the count, rather than guessed
 * at — the same rule the policy engine applies to a script body it cannot read.
 *
 * All or nothing: the edits are applied to a string in memory and the file is written once, so a
 * patch that fails halfway leaves nothing behind.
 */

export type DocEdit = {
  find: string;
  replace: string;
  /** How many occurrences the caller expects; defaults to exactly one. */
  expectCount?: number;
};

export type PatchResult = { content: string; applied: number };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

function replaceAll(haystack: string, needle: string, value: string): string {
  return haystack.split(needle).join(value);
}

/**
 * Apply every edit in order, or throw naming the first one that could not be resolved. The message
 * is written for the caller that has to fix it: which edit, how many matches, what was expected.
 */
export function applyEdits(content: string, edits: DocEdit[]): PatchResult {
  if (edits.length === 0) throw new Error("no edits given");

  let current = content;
  let applied = 0;

  for (const [index, edit] of edits.entries()) {
    const where = `edit ${index + 1}`;
    if (edit.find.length === 0) throw new Error(`${where}: find is empty`);

    const expected = edit.expectCount ?? 1;
    if (expected < 1) throw new Error(`${where}: expectCount must be at least 1`);

    const found = countOccurrences(current, edit.find);
    if (found === 0) {
      throw new Error(
        `${where}: found no occurrence of ${JSON.stringify(truncate(edit.find))}. ` +
          "Read the document again: it is not what you think it is.",
      );
    }
    if (found !== expected) {
      throw new Error(
        `${where}: found ${found} occurrences of ${JSON.stringify(truncate(edit.find))}, ` +
          `expected ${expected}. Make the find unique, or pass expectCount: ${found} to mean all of them.`,
      );
    }

    current = replaceAll(current, edit.find, edit.replace);
    applied += found;
  }

  return { content: current, applied };
}

function truncate(value: string, max = 60): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}
