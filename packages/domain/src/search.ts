// How a search compares text (Activity's search): without case, without accents on Latin letters, and with curly
// apostrophes as straight ones. "cafe" and "café" find "CAFÉ". SQLite's lower() folds only A–Z, so the server's SQL
// (`foldSql`) and the app (`foldSearch`) use this one table: both sides fold a text the same way.

/** Each letter's folded form: a base letter (or two, for ß, æ, œ), an apostrophe, or '' for a combining mark. */
const GROUPS: Record<string, string> = {
  a: 'ÀÁÂÃÄÅàáâãäåĀāĂăĄą',
  c: 'ÇçĆćĈĉĊċČč',
  d: 'ĎďĐđ',
  e: 'ÈÉÊËèéêëĒēĔĕĖėĘęĚě',
  g: 'ĜĝĞğĠġĢģ',
  i: 'ÌÍÎÏìíîïĨĩĪīĮįİı',
  l: 'ĹĺĻļĽľŁł',
  n: 'ÑñŃńŅņŇň',
  o: 'ÒÓÔÕÖØòóôõöøŌōŐő',
  r: 'ŔŕŘř',
  s: 'ŚśŜŝŞşŠš',
  t: 'ŢţŤť',
  u: 'ÙÚÛÜùúûüŨũŪūŬŭŮůŰűŲų',
  y: 'ÝýÿŸ',
  z: 'ŹźŻżŽž',
  ss: 'ß',
  ae: 'Ææ',
  oe: 'Œœ',
  "'": '’‘',
  // Combining accents, for text written as a letter and then its accent.
  '': '̧̨̀́̂̃̄̆̇̈̊̋̌',
};

/** [character, folded] pairs. */
export const SEARCH_FOLDS: readonly (readonly [string, string])[] = Object.entries(GROUPS).flatMap(
  ([to, from]) => [...from].map((ch) => [ch, to] as const),
);

const FOLD = new Map(SEARCH_FOLDS);

/** Text as a search compares it: A–Z in lower case, then each character of the table folded. */
export function foldSearch(t: string): string {
  let out = '';
  for (const ch of t) {
    const f = FOLD.get(ch);
    out += f ?? (ch >= 'A' && ch <= 'Z' ? ch.toLowerCase() : ch);
  }
  return out;
}

/**
 * The same fold as SQL over the column `col`. Text with only printable ASCII (most payees) skips the table, so a
 * search over every row stays cheap.
 */
export function foldSql(col: string): string {
  let e = `lower(${col})`;
  for (const [ch, to] of SEARCH_FOLDS) e = `replace(${e}, '${sqlChar(ch)}', '${to.replace(/'/g, "''")}')`;
  return `(CASE WHEN ${col} GLOB '*[^ -~]*' THEN ${e} ELSE lower(${col}) END)`;
}

function sqlChar(ch: string): string {
  return ch === "'" ? "''" : ch;
}
