/**
 * A shared fiddy.fun link unfurls as Fiddy, and says so in the shell.
 *
 * fiddy.fun is an SPA: a crawler never runs the client's JavaScript, so the
 * only metadata any unfurler sees is what `index.html` ships. Until this was
 * added the shell carried no `og:` tag at all, and the single 1200x630 image on
 * the host was `opengraph.png` — upstream Farcaster's purple brand card, a
 * different product's art.
 *
 * These tests read the document the build ships and hold four things:
 *
 *   1. the shared-link tags exist, and the picture they point at is Fiddy's own
 *      (rendered from the repo's mascot by `scripts/render-share-card.mjs`), not
 *      the upstream one;
 *   2. the card is the size an unfurl expects (1200x630), stated in the tags;
 *   3. there is no static `og:url` — this one document answers for every route,
 *      so a static front-door URL would tell a platform that a shared cast link
 *      is really the front door;
 *   4. the `fc:miniapp` tag is valid JSON and the schema's own constraints hold
 *      (version "1", a 32-character button title, an action name, absolute
 *      URLs), because the same URL is a launchable mini app card.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');

/** The `content` of a meta tag, by property or name. */
const metaContent = (attribute: 'property' | 'name', key: string) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content=(?:"([^"]*)"|'([^']*)')`,
  ).exec(shell);
  return tag?.[1] ?? tag?.[2];
};

const SHARE_CARD = 'https://fiddy.fun/fiddy-share-card.png';

describe('the shell a shared link unfurls as', () => {
  it('declares the shared-link tags, pointing at our own card', () => {
    expect(metaContent('property', 'og:type')).toBe('website');
    expect(metaContent('property', 'og:site_name')).toBe('fiddy');
    expect(metaContent('property', 'og:title')).toContain('fiddy');
    expect(metaContent('property', 'og:description')).toBeTruthy();
    expect(metaContent('property', 'og:image')).toBe(SHARE_CARD);
    expect(metaContent('name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent('name', 'twitter:image')).toBe(SHARE_CARD);
    expect(metaContent('name', 'description')).toBeTruthy();
    // Upstream Farcaster's brand card must never be the card for this app.
    expect(shell).not.toContain('opengraph.png');
  });

  it('states the card size a platform needs to lay its own preview out', () => {
    expect(metaContent('property', 'og:image:width')).toBe('1200');
    expect(metaContent('property', 'og:image:height')).toBe('630');
    // The asset the tags name is in this repo, and the script that draws it is
    // too, so the card can be redrawn rather than only replaced by hand.
    expect(
      existsSync(path.join(webRoot, 'public', 'fiddy-share-card.png')),
    ).toBe(true);
    expect(
      existsSync(path.join(webRoot, 'scripts', 'render-share-card.mjs')),
    ).toBe(true);
    // The embed card the `fc:miniapp` tag names is drawn by the same script, at
    // the 3:2 the mini app spec asks of an embed, and the file is in the repo.
    const embedCard = readFileSync(
      path.join(webRoot, 'public', 'fiddy-embed.png'),
    );
    expect([...embedCard.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect([embedCard.readUInt32BE(16), embedCard.readUInt32BE(20)]).toEqual([
      1200, 800,
    ]);
  });

  it('carries no static og:url, because this document answers for every route', () => {
    expect(metaContent('property', 'og:url')).toBeUndefined();
  });

  it('carries an fc:miniapp embed that satisfies the schema', () => {
    const raw = metaContent('name', 'fc:miniapp');
    expect(raw).toBeTruthy();

    const embed = JSON.parse(raw as string) as {
      version: string;
      imageUrl: string;
      button: {
        title: string;
        action: {
          type: string;
          name: string;
          url: string;
          splashImageUrl?: string;
          splashBackgroundColor?: string;
        };
      };
    };

    expect(embed.version).toBe('1');
    // 3:2 is what the spec asks of an embed image; /fiddy-embed.png is the
    // manifest's own image, rendered from the repo's mascot by
    // scripts/render-share-card.mjs — and both surfaces name the same file.
    expect(embed.imageUrl).toBe('https://fiddy.fun/fiddy-embed.png');
    expect(embed.button.title.length).toBeLessThanOrEqual(32);
    expect(embed.button.action.type).toBe('launch_miniapp');
    expect(embed.button.action.name).toBe('fiddy');
    expect(embed.button.action.url).toBe('https://fiddy.fun/');
    // The splash the transition paints is the app's own ground. The manifest
    // that lists this app says the same, and both are held to it by
    // wellKnownManifest.test.ts and the release's check-manifest.mjs.
    expect(embed.button.action.splashBackgroundColor).toBe('#161715');
    expect(embed.button.action.splashImageUrl).toMatch(/^https:\/\//);
  });
});
