/**
 * The article Markdown subset, as data a renderer can draw.
 *
 * Two of these assertions are the ones the card promises a reader: a code fence
 * stays literal, `**bold**` does not print its asterisks, and an escaped `\*`
 * prints as `*`. The rest pin the parts of the subset that would silently lose
 * a reader's text if they regressed (a table's lines, a link's label, an
 * embed's place).
 */

import { describe, expect, it } from 'vitest';

import {
  type MarkdownBlock,
  type MarkdownInline,
  parseArticleMarkdown,
  parseInline,
  safeUrl,
  unmarkdown,
} from '../articleMarkdown';

const text = (inlines: MarkdownInline[]): string =>
  inlines.map((inline) => inline.text).join('');

const first = (blocks: MarkdownBlock[]): MarkdownBlock => {
  const block = blocks[0];
  if (!block) {
    throw new Error('no blocks');
  }
  return block;
};

describe('inline Markdown', () => {
  it('drops the asterisks around bold and italic', () => {
    const inlines = parseInline('**Bold** and *italic* and ~~struck~~');

    expect(text(inlines)).toBe('Bold and italic and struck');
    expect(inlines[0]).toMatchObject({ text: 'Bold', bold: true });
    expect(inlines[2]).toMatchObject({ text: 'italic', italic: true });
    expect(inlines[4]).toMatchObject({ text: 'struck', strike: true });
  });

  it('prints an escaped asterisk as an asterisk', () => {
    expect(text(parseInline('a \\*literal\\* star'))).toBe('a *literal* star');
  });

  it('keeps a code span literal', () => {
    const inlines = parseInline('run `pnpm --filter x **nope**` now');

    expect(text(inlines)).toBe('run pnpm --filter x **nope** now');
    expect(inlines[1]).toMatchObject({ code: true });
  });

  it('turns a link into its label plus a safe URL', () => {
    const inlines = parseInline(
      'see [the FIP](https://example.com/fip) and https://example.org/x.',
    );

    expect(inlines[1]).toMatchObject({
      kind: 'link',
      text: 'the FIP',
      url: 'https://example.com/fip',
    });
    // A bare URL is a link too; its trailing full stop is punctuation, not URL.
    expect(inlines[3]).toMatchObject({
      kind: 'link',
      url: 'https://example.org/x',
    });
    expect(text(inlines)).toContain('.');
  });

  it('refuses a javascript: URL and keeps the label as text', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(text(parseInline('[click](javascript:alert)'))).toBe('click');
  });

  it('does not italicise an underscore inside a word', () => {
    expect(text(parseInline('snake_case_name'))).toBe('snake_case_name');
  });
});

describe('blocks', () => {
  it('reads a heading as a heading of its level', () => {
    const block = first(parseArticleMarkdown('## Subheadings\n\nBody.'));

    expect(block).toMatchObject({ kind: 'heading', level: 2 });
    expect(parseArticleMarkdown('## Subheadings\n\nBody.')[1]).toMatchObject({
      kind: 'paragraph',
    });
  });

  it('leaves a fenced block literal', () => {
    const blocks = parseArticleMarkdown(
      '```\n## not a heading\n**not bold**\n```',
    );
    const block = first(blocks);

    expect(block).toMatchObject({ kind: 'code' });
    expect(block.kind === 'code' && block.text).toBe(
      '## not a heading\n**not bold**',
    );
  });

  it('reads a list, ordered or not, with its items', () => {
    const bull = first(parseArticleMarkdown('- one\n- two'));
    expect(bull).toMatchObject({ kind: 'list', ordered: false });
    expect(bull.kind === 'list' && bull.items.map(text)).toEqual([
      'one',
      'two',
    ]);

    const numbered = first(parseArticleMarkdown('1. first\n2. second'));
    expect(numbered).toMatchObject({ kind: 'list', ordered: true, start: 1 });
  });

  it('places [$N] where the text puts it, and appends embeds it never mentions', () => {
    const embeds = [
      { url: 'https://example.com/one.png' },
      { castId: { fid: 533, hash: '0x' + 'a'.repeat(40) } },
    ];
    const blocks = parseArticleMarkdown('before\n\n[$2]\n\nafter', embeds);

    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'embed',
      'paragraph',
      'embed',
    ]);
    expect(blocks[1]).toMatchObject({ kind: 'embed', embed: embeds[1] });
    // The image the text never mentioned still shows, after the text.
    expect(blocks[3]).toMatchObject({ kind: 'embed', embed: embeds[0] });
  });

  it('treats a line that is only a link as a preview, not prose', () => {
    const block = first(parseArticleMarkdown('https://example.com/article'));

    expect(block).toEqual({ kind: 'link', url: 'https://example.com/article' });
  });

  it('keeps a table’s lines as text rather than dropping them', () => {
    const blocks = parseArticleMarkdown('|a|b|\n|-|-|\n|1|2|');
    const flat = blocks
      .map((block) =>
        block.kind === 'paragraph' ? text(block.inlines) : block.kind,
      )
      .join('\n');

    expect(flat).toContain('|a|b|');
    expect(flat).toContain('|1|2|');
  });

  it('drops a trailing backslash hard break and keeps the line break', () => {
    const block = first(parseArticleMarkdown('a line\\\nafter a break'));

    expect(block.kind === 'paragraph' && text(block.inlines)).toBe(
      'a line\nafter a break',
    );
  });

  it('reads a real article’s part without printing its markup', () => {
    const body = [
      '- **A public page.** Every article opens on web and mobile.',
      '- **On the protocol.** A chain of casts.',
      '',
      '---',
      '## Formatting',
      '# Headings',
    ].join('\n');
    const blocks = parseArticleMarkdown(body);
    const rendered = blocks
      .map((block) => {
        if (block.kind === 'paragraph' || block.kind === 'quote') {
          return text(block.inlines);
        }
        if (block.kind === 'list') {
          return block.items.map(text).join(' / ');
        }
        if (block.kind === 'heading') {
          return text(block.inlines);
        }
        return block.kind;
      })
      .join('\n');

    expect(rendered).not.toContain('**');
    expect(rendered).not.toContain('##');
    expect(rendered).toContain(
      'A public page. Every article opens on web and mobile.',
    );
  });
});

describe('unmarkdown', () => {
  it('gives a feed card plain words', () => {
    const plain = unmarkdown(
      '## The Basics\n- **Title and cover image.** They show. [Read more](https://example.com)',
    );

    expect(plain).not.toContain('##');
    expect(plain).not.toContain('**');
    expect(plain).toContain('• Title and cover image. They show. Read more');
    expect(plain).toContain('The Basics');
  });

  it('keeps an escaped character and drops a fence’s backticks', () => {
    expect(unmarkdown('a \\* b')).toBe('a * b');
    // A fence's backticks go; the code inside it is still words to read.
    expect(unmarkdown('```\ncode\n```')).toBe('code');
  });
});
