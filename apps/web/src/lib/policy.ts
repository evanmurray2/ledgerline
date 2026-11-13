// The privacy policy page reads docs/privacy-policy.md itself, so the app shows exactly the text in the repository
// (tools/ci/scope.mjs counts that file as code: a change to it is built and deployed). This reads the small part of
// Markdown the policy uses: headings, paragraphs, lists with wrapped lines, tables, bold, code and bare https links.
// What comes before the first `---` line is the draft's notes for the owner, and the review mark
// "**(owner reads)**" is dropped: neither is part of the policy. A paragraph or list item marked "**(later)**" is
// not true yet, so it is left out.

export type Inline = { kind: 'text' | 'bold' | 'code' | 'link'; text: string };
export type Block =
  | { kind: 'h2' | 'h3'; text: string }
  | { kind: 'p'; parts: Inline[] }
  | { kind: 'ul'; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] };

export interface Policy {
  /** The title without "(draft)". */
  title: string;
  draft: boolean;
  blocks: Block[];
}

const MARK = /\*\*\(owner reads\)\*\*\s*/g;
const LATER = '**(later)**';

/** Bold, code and https links in one line of text. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*(.+?)\*\*|`([^`]+)`|(https:\/\/[^\s)]+[^\s).,;])/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'code', text: m[2] });
    else out.push({ kind: 'link', text: m[3]! });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => inline(c.trim()));

export function parsePolicy(md: string): Policy {
  const all = md.replace(/\r\n/g, '\n').split('\n');
  const titleLine = all.find((l) => l.startsWith('# ')) ?? '# Privacy policy';
  const draft = /\(draft\)/i.test(titleLine);
  const title = titleLine
    .slice(2)
    .replace(/\s*\(draft\)\s*/i, '')
    .trim();
  const rule = all.findIndex((l) => l.trim() === '---');
  const lines = all.slice(rule + 1).map((l) => l.replace(MARK, ''));
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
    } else if (line.startsWith('### ')) {
      blocks.push({ kind: 'h3', text: line.slice(4).trim() });
      i++;
    } else if (line.startsWith('## ')) {
      blocks.push({ kind: 'h2', text: line.slice(3).trim() });
      i++;
    } else if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(lines[i++]!);
      const body = rows.slice(1).filter((r) => !/^\|[\s:|-]+\|$/.test(r.trim()));
      blocks.push({ kind: 'table', head: cells(rows[0]!), rows: body.map(cells) });
    } else if (line.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && (lines[i]!.startsWith('- ') || /^ {2}\S/.test(lines[i]!))) {
        const l = lines[i++]!;
        if (l.startsWith('- ')) items.push(l.slice(2).trim());
        else items[items.length - 1] += ' ' + l.trim();
      }
      const shown = items.filter((t) => !t.startsWith(LATER));
      if (shown.length) blocks.push({ kind: 'ul', items: shown.map(inline) });
    } else {
      const text: string[] = [];
      while (i < lines.length && lines[i]!.trim() && !/^(#|\||- )/.test(lines[i]!))
        text.push(lines[i++]!.trim());
      const joined = text.join(' ');
      if (!joined.startsWith(LATER)) blocks.push({ kind: 'p', parts: inline(joined) });
    }
  }
  return { title, draft, blocks };
}
