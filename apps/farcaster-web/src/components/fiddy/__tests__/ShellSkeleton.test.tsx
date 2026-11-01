// @vitest-environment jsdom
/**
 * The shell is painted twice, and the two must be one shape.
 *
 * The document paints it before any JavaScript runs (`index.html`), and the app
 * paints it when something above the shell suspends (`ShellSkeleton`). A reader
 * moving between the two should not be able to tell: same top bar, same rail,
 * same column, same phone tab bar, same sizes. These tests hold the copy in
 * step by reading both files, and they keep the second copy from ever becoming
 * nothing again — a blank fallback above the shell is the bug this exists for.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import { ShellSkeleton } from '~/components/fiddy/ShellSkeleton';

const webRoot = path.resolve(__dirname, '../../../..');
const documentHtml = readFileSync(path.join(webRoot, 'index.html'), 'utf8');

const START = '<!-- shell-skeleton:start';
const END = '<!-- shell-skeleton:end';

const documentSkeleton = () => {
  const from = documentHtml.indexOf(START);
  const to = documentHtml.indexOf(END);
  return from >= 0 && to > from ? documentHtml.slice(from, to) : '';
};

/** Every class token in a piece of markup, order-insensitive. */
const classNames = (html: string) =>
  (html.match(/class="[^"]*"/g) ?? [])
    .flatMap((attribute) => attribute.slice('class="'.length, -1).split(/\s+/))
    .filter(Boolean)
    .sort();

/** The words, with the markup and the comments taken off. */
const text = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The same words, with the whitespace of two different sources taken off. */
const letters = (value: string) => value.replace(/\s+/g, '');

const source = (file: string) => readFileSync(path.join(webRoot, file), 'utf8');

describe('the shell the document paints', () => {
  it('is in the document, inside its own markers', () => {
    const skeleton = documentSkeleton();
    expect(skeleton.length).toBeGreaterThan(400);
    expect(skeleton).toContain('data-fiddy="shell-skeleton"');
  });

  it('has the same classes, and the same words, as the app’s fallback', () => {
    const skeleton = documentSkeleton();
    const { container } = render(<ShellSkeleton />);

    expect(classNames(container.innerHTML)).toEqual(classNames(skeleton));
    expect(letters(container.textContent ?? '')).toBe(letters(text(skeleton)));
  });

  it('styles every part of it without any stylesheet the bundle carries', () => {
    // A document's skeleton paints before the bundle's CSS exists, so the
    // rules have to be in the document: one `<style>` block, its own classes.
    const styles = (documentHtml.match(/<style>[\s\S]*?<\/style>/g) ?? []).join(
      '\n',
    );
    const classes = [...new Set(classNames(documentSkeleton()))];
    expect(classes.length).toBeGreaterThan(5);
    for (const className of classes) {
      expect(styles).toContain(`.${className}`);
    }
  });

  it('is the brand and shapes only — nothing that claims a fact', () => {
    // No avatar, no node pill, no cast, no name: a skeleton that says "you are
    // dwr" or "fiddy serves it" before either is known would be a lie that
    // paints first.
    const skeleton = documentSkeleton();
    expect(skeleton).not.toMatch(/data-fiddy="(topbar|node-choice|cast)"/);
    expect(text(skeleton)).toContain('Loading Fiddy');
    expect(text(skeleton)).toContain('fiddy');
  });

  it('is what the app falls back to above the shell, never nothing', () => {
    for (const file of [
      'src/components/App.tsx',
      'src/layouts/AuthedLayout.tsx',
    ]) {
      const code = source(file);
      expect(code).not.toContain('fallback={null}');
      expect(code).toContain('ShellSkeleton');
    }
  });

  it('sits outside the container React clears, and is the app’s to take away', () => {
    // React clears its own container before its first paint, so a skeleton
    // inside #root would be cleared with it and leave a blank page (measured:
    // the root stayed empty for over a second on a cold load). It is a sibling,
    // and the app is what removes it, after its first painted frame.
    const rootAt = documentHtml.indexOf('<div id="root"></div>');
    expect(rootAt).toBeGreaterThan(-1);
    expect(documentHtml.indexOf('id="shell-skeleton"')).toBeGreaterThan(rootAt);
    expect(source('src/components/App.tsx')).toContain("'shell-skeleton'");

    // The app's own copy is an element in its tree, never a second document id.
    const { container } = render(<ShellSkeleton />);
    expect(container.querySelector('[id="shell-skeleton"]')).toBeNull();
  });
});
