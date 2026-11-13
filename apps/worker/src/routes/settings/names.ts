// Names people type (categories, groups): what is kept of them.

/** The zero-width non-joiner and joiner. */
const KEEP = new Set([String.fromCodePoint(0x200c), String.fromCodePoint(0x200d)]);

/**
 * A name as it is stored: control and format characters taken out (a right-to-left override would make a name read
 * backwards, others hide in it unseen), runs of spaces made one, and the ends trimmed. The zero-width joiner and
 * non-joiner stay: emoji and some scripts need them. Empty when nothing visible was typed.
 */
export function cleanName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => (KEEP.has(ch) ? ch : ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two names that read as the same name: case and the kind of apostrophe aside. */
export function sameName(a: string, b: string): boolean {
  const key = (s: string) => cleanName(s).replace(/[‘’`]/g, "'").toLocaleLowerCase('en-US');
  return key(a) === key(b);
}
