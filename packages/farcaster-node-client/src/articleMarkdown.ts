/**
 * The subset of article Markdown a reader shows, as plain data.
 *
 * Article text is Markdown (`format_version` 1), but the reader deliberately does
 * not drag a Markdown library into the mobile bundle. This module turns a
 * part's text into blocks and inlines that a renderer can draw with its own
 * primitives, and it is framework-free so the same parse is testable in Node:
 *
 *   - headings, paragraphs, quotes, rules;
 *   - `-`/`*`/`+` and `1.`/`1)` lists;
 *   - fenced code, kept literal (never re-interpreted as Markdown);
 *   - `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strike~~`, `` `code` ``;
 *   - `[label](url)` links and bare URLs;
 *   - a line that is only a link becomes a preview, and a line that is only
 *     `[$N]` places that part's Nth embed;
 *   - a backslash escapes the character after it, so `\*` reads as `*`.
 *
 * Tables are not laid out: their lines stay text, pipes and all, rather than
 * being silently dropped. The fiddly cases (fences, escapes, tables, LaTeX) are
 * ported in shape from backmeupplz/quilcast's `segments()` and `unmarkdown()`
 * (`src/article.ts`, `src/shared.ts`, MIT); the parsers here are written for
 * this renderer, not copied.
 */

import type { NodeEmbed } from './types';

export interface MarkdownStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

export type MarkdownInline =
  | ({ kind: 'text'; text: string } & MarkdownStyle)
  | ({ kind: 'link'; text: string; url: string } & MarkdownStyle);

export type MarkdownBlock =
  | { kind: 'heading'; level: number; inlines: MarkdownInline[] }
  | { kind: 'paragraph'; inlines: MarkdownInline[] }
  | {
      kind: 'list';
      ordered: boolean;
      start: number;
      items: MarkdownInline[][];
    }
  | { kind: 'quote'; inlines: MarkdownInline[] }
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  /** A line that is only a link: a preview, not prose. */
  | { kind: 'link'; url: string }
  /** A `[$N]` line, or an embed no placeholder placed. */
  | { kind: 'embed'; embed: NodeEmbed };

/** Characters a backslash escapes in this subset. */
const ESCAPABLE = new Set('\\`*_{}[]()#+-.!|~<>$'.split(''));

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const LONE_LINK = /^https?:\/\/\S+$/;
const PLACE = /^\[\$(\d{1,2})\]$/;
const BARE_LINK = /^https?:\/\/[^\s<>()]+/;

/** Only these schemes are ever offered as a link. */
export const safeUrl = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : undefined;
};

const merge = (out: MarkdownInline[]): MarkdownInline[] => {
  const merged: MarkdownInline[] = [];
  for (const node of out) {
    const last = merged[merged.length - 1];
    if (
      node.kind === 'text' &&
      last?.kind === 'text' &&
      last.bold === node.bold &&
      last.italic === node.italic &&
      last.strike === node.strike &&
      last.code === node.code
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + node.text };
      continue;
    }
    merged.push(node);
  }
  return merged;
};

/**
 * One line (or run of lines) as inlines.
 *
 * Emphasis is not nested: `**bold and *italic***` renders the inner asterisks
 * as text. That is the deliberate limit of the subset — the alternative is a
 * CommonMark implementation, which is a dependency the app does not take.
 */
export const parseInline = (
  text: string,
  style: MarkdownStyle = {},
): MarkdownInline[] => {
  const out: MarkdownInline[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer) {
      out.push({ kind: 'text', text: buffer, ...style });
      buffer = '';
    }
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];

    // An escape is the character itself, and never starts anything.
    if (ch === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    // `code` — literal inside, no emphasis or links.
    if (ch === '`') {
      const match = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);
      if (match) {
        flush();
        out.push({ kind: 'text', text: match[2], ...style, code: true });
        i += match[0].length;
        continue;
      }
    }

    // ![alt](url): the alt text is what a reader without images gets.
    if (ch === '!' && rest.startsWith('![')) {
      const match = /^!\[([^\]\n]*)\]\(([^\s()]+)\)/.exec(rest);
      if (match) {
        flush();
        out.push({ kind: 'text', text: match[1], ...style, italic: true });
        i += match[0].length;
        continue;
      }
    }

    // [label](url)
    if (ch === '[') {
      const match = /^\[([^\]\n]+)\]\(([^\s()]+)\)/.exec(rest);
      if (match) {
        flush();
        const url = safeUrl(match[2]);
        out.push(
          url
            ? { kind: 'link', text: match[1], url, ...style }
            : { kind: 'text', text: match[1], ...style },
        );
        i += match[0].length;
        continue;
      }
    }

    // **bold** / __bold__ / ~~strike~~ / *italic* / _italic_
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = ch === '~' ? '~~' : ch + ch;
      const double = rest.startsWith(run);
      const opener = double ? run : ch;
      if (ch === '~' && !double) {
        buffer += ch;
        i += 1;
        continue;
      }
      const after = text[i + opener.length];
      // An opener must be followed by something other than a space, and `_`
      // must not be inside a word (`snake_case` stays a word).
      const insideWord =
        ch === '_' && i > 0 && /[\p{Alphabetic}\p{N}]/u.test(text[i - 1]);
      if (after && !/\s/.test(after) && !insideWord) {
        const closing = text.indexOf(opener, i + opener.length);
        if (closing > i + opener.length) {
          const inner = text.slice(i + opener.length, closing);
          const lastChar = inner[inner.length - 1];
          const endsInsideWord =
            ch === '_' &&
            /\p{Alphabetic}/u.test(text[closing + opener.length] ?? '');
          if (!/\s/.test(lastChar) && !endsInsideWord) {
            flush();
            const nested = parseInline(inner, {
              ...style,
              ...(double
                ? ch === '~'
                  ? { strike: true }
                  : { bold: true }
                : { italic: true }),
            });
            out.push(...nested);
            i = closing + opener.length;
            continue;
          }
        }
      }
    }

    // A bare URL is a link; trailing punctuation is text.
    if (/^https?:\/\//i.test(rest)) {
      const match = BARE_LINK.exec(rest);
      if (match) {
        let url = match[0];
        let tail = '';
        while (url.length > 0 && /[.,;:!?)\]'"]$/.test(url)) {
          tail = url.slice(-1) + tail;
          url = url.slice(0, -1);
        }
        const safe = safeUrl(url);
        if (safe) {
          flush();
          out.push({ kind: 'link', text: url, url: safe, ...style });
          buffer += tail;
          i += match[0].length;
          continue;
        }
      }
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return merge(out);
};

/** Whether a line ends in an odd number of backslashes (a hard break). */
const hardBreak = (line: string): boolean =>
  (line.match(/\\+$/)?.[0].length ?? 0) % 2 === 1;

/**
 * The blocks of one part, with that part's embeds placed where the text puts
 * them: `[$N]` on a line of its own is the part's Nth embed (1-based), and a
 * line that is only a link is a preview. Embeds the text never mentions go at
 * the end, in order, as upstream's `segments()` does.
 */
export const parseArticleMarkdown = (
  text: string,
  embeds: readonly NodeEmbed[] = [],
): MarkdownBlock[] => {
  const blocks: MarkdownBlock[] = [];
  const used = new Set<number>();
  const lines = text ? text.replace(/\r\n?/g, '\n').split('\n') : [];

  const pushParagraph = (buffer: string[]) => {
    if (buffer.length === 0) {
      return;
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(buffer.join('\n')) });
  };
  let paragraph: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim() === '') {
      pushParagraph(paragraph);
      paragraph = [];
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      pushParagraph(paragraph);
      paragraph = [];
      const body: string[] = [];
      let closed = false;
      for (i += 1; i < lines.length; i += 1) {
        const candidate = lines[i];
        if (
          candidate.trim().startsWith(fence[1]) &&
          candidate.trim().slice(fence[1].length).trim() === ''
        ) {
          closed = true;
          break;
        }
        body.push(candidate);
      }
      // An unclosed fence still ends where the text ends: what follows cannot
      // be read as Markdown, and an empty block is not worth a row.
      if (body.length > 0) {
        blocks.push({ kind: 'code', text: body.join('\n') });
      }
      if (!closed) {
        break;
      }
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      pushParagraph(paragraph);
      paragraph = [];
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        inlines: parseInline(heading[2]),
      });
      continue;
    }

    if (RULE.test(line)) {
      pushParagraph(paragraph);
      paragraph = [];
      blocks.push({ kind: 'rule' });
      continue;
    }

    if (QUOTE.test(line)) {
      pushParagraph(paragraph);
      paragraph = [];
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ''));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'quote', inlines: parseInline(quoted.join('\n')) });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      pushParagraph(paragraph);
      paragraph = [];
      const ordered = /\d/.test(item[2]);
      const start = ordered ? Number.parseInt(item[2], 10) : 1;
      const items: MarkdownInline[][] = [parseInline(item[3])];
      while (i + 1 < lines.length) {
        const next = ITEM.exec(lines[i + 1]);
        if (!next || /\d/.test(next[2]) !== ordered) {
          break;
        }
        items.push(parseInline(next[3]));
        i += 1;
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const place = PLACE.exec(line.trim());
    if (place) {
      const index = Number.parseInt(place[1], 10);
      if (index >= 1 && index <= embeds.length && !used.has(index - 1)) {
        pushParagraph(paragraph);
        paragraph = [];
        used.add(index - 1);
        blocks.push({ kind: 'embed', embed: embeds[index - 1] });
        continue;
      }
    }

    if (LONE_LINK.test(line.trim()) && safeUrl(line.trim())) {
      pushParagraph(paragraph);
      paragraph = [];
      blocks.push({ kind: 'link', url: line.trim() });
      continue;
    }

    // A trailing backslash is a hard break: drop it, keep the line break.
    paragraph.push(hardBreak(line) ? line.slice(0, -1) : line);
  }

  pushParagraph(paragraph);

  embeds.forEach((embed, index) => {
    if (!used.has(index)) {
      blocks.push({ kind: 'embed', embed });
    }
  });

  return blocks;
};

/** Inlines as the words a reader would say out loud, for alt text and previews. */
const inlinesText = (inlines: readonly MarkdownInline[]): string =>
  inlines.map((inline) => inline.text).join('');

/**
 * The text of a part without its Markdown: what a feed card or a share preview
 * shows. Lists keep their bullets, links keep their label, embed placeholders
 * and fences' backticks go.
 */
export const unmarkdown = (text: string): string => {
  const lines: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const fence = FENCE.exec(line);
    if (fence) {
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      lines.push(inlinesText(parseInline(heading[2])));
      continue;
    }
    if (RULE.test(line)) {
      continue;
    }
    const quoted = QUOTE.test(line) ? line.replace(QUOTE, '') : line;
    const item = ITEM.exec(quoted);
    if (item) {
      lines.push(
        `${/\d/.test(item[2]) ? item[2] : '•'} ${inlinesText(parseInline(item[3]))}`,
      );
      continue;
    }
    if (PLACE.test(quoted.trim())) {
      continue;
    }
    lines.push(
      inlinesText(
        parseInline(hardBreak(quoted) ? quoted.slice(0, -1) : quoted),
      ),
    );
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};
