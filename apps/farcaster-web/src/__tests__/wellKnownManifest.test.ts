/**
 * The fiddy.fun listing and a shared fiddy.fun link describe ONE product.
 *
 * `/.well-known/farcaster.json` is Fiddy's app-list identity: the signed
 * per-domain manifest a Farcaster client reads to list, search and notify this
 * app. It is served from the VPS (`/var/www/fiddy-well-known/farcaster.json`,
 * aliased by the vhost in both the port-80 and the port-443 block), and the
 * copy here is the source of truth the release installs — see
 * `scripts/release-client.sh` step 7 and docs/CLIENT-RELEASE.md.
 *
 * Why a test at all: the manifest is a second front door to the same app, and
 * it drifted. Measured 2026-10-22 (card t_8654d91e): it asked for a 512x512
 * splash where the spec asks 200x200, painted the splash in upstream Warpcast
 * purple (#6200EA) while the app's own ground is #161715, and described
 * "deploy always on agents with onchain identities" — a different product than
 * the one `index.html` unfurls as. Nothing in the repo held the two surfaces
 * together, so nothing noticed.
 *
 * These tests hold four things:
 *
 *   1. the association is present and signed (an unsigned manifest cannot be
 *      listed, and the release refuses to install one);
 *   2. the schema's own constraints hold (version "1", a 32-character name, a
 *      170-character description with no emoji or special characters, 30-char
 *      subtitle/tagline, at most five lowercase tags);
 *   3. the manifest and the shell's `fc:miniapp` embed agree — name, splash
 *      image, splash colour, and the sentence that describes the product —
 *      because the listing and the link are the same app or they are broken;
 *   4. the splash the transition paints is an asset THIS repo owns and it is
 *      the size the spec asks (200x200), read from the PNG's own header.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '../..');
const shell = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
const manifest = JSON.parse(
  readFileSync(
    path.join(webRoot, 'public', '.well-known', 'farcaster.json'),
    'utf8',
  ),
) as {
  accountAssociation: { header: string; payload: string; signature: string };
  miniapp: {
    version: string;
    name: string;
    homeUrl: string;
    iconUrl: string;
    imageUrl: string;
    splashImageUrl?: string;
    splashBackgroundColor?: string;
    subtitle?: string;
    description?: string;
    tagline?: string;
    primaryCategory?: string;
    tags?: string[];
  };
};
const app = manifest.miniapp;

/** What the app's own ground is (BRAND.md: neutrals.dark.black = #161715). */
const BRAND_GROUND = '#161715';

/** The categories the manifest spec allows. */
const CATEGORIES = [
  'games',
  'social',
  'finance',
  'utility',
  'productivity',
  'health-fitness',
  'news-media',
  'music',
  'shopping',
  'education',
  'developer-tools',
  'entertainment',
  'art-creativity',
];

/** The `content` of a meta tag in the shell, by property or name. */
const metaContent = (attribute: 'property' | 'name', key: string) => {
  const tag = new RegExp(
    `<meta\\s+${attribute}="${key}"\\s+content=(?:"([^"]*)"|'([^']*)')`,
  ).exec(shell);
  return tag?.[1] ?? tag?.[2];
};

const embed = JSON.parse(metaContent('name', 'fc:miniapp') as string) as {
  imageUrl: string;
  button: {
    action: {
      name: string;
      splashImageUrl?: string;
      splashBackgroundColor?: string;
    };
  };
};

/** The syntax a manifest field the spec calls "no emojis or special
 * characters" may use: printable ASCII, nothing else. */
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

/** A width/height read from a PNG's own IHDR, so a mis-sized asset cannot pass
 * on its filename or its URL. */
const pngSize = (file: string) => {
  const bytes = readFileSync(file);
  expect([...bytes.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

describe('the fiddy.fun app-list manifest', () => {
  it('carries the domain association, signed', () => {
    expect(manifest.accountAssociation.header).toBeTruthy();
    expect(manifest.accountAssociation.payload).toBeTruthy();
    // A signature is 64 bytes of base64url; anything short of that is a stub,
    // and a stub means the app cannot be listed or searched.
    expect(manifest.accountAssociation.signature.length).toBeGreaterThanOrEqual(
      64,
    );
    const payload = JSON.parse(
      Buffer.from(
        manifest.accountAssociation.payload
          .replace(/-/g, '+')
          .replace(/_/g, '/'),
        'base64',
      ).toString('utf8'),
    ) as { domain: string };
    expect(payload.domain).toBe('fiddy.fun');
  });

  it('satisfies the manifest schema', () => {
    expect(app.version).toBe('1');
    expect(app.name).toBe('fiddy');
    expect(app.name.length).toBeLessThanOrEqual(32);
    expect(app.homeUrl).toBe('https://fiddy.fun');
    expect(app.iconUrl).toMatch(/^https:\/\//);
    expect(app.imageUrl).toMatch(/^https:\/\//);
    expect(CATEGORIES).toContain(app.primaryCategory);

    expect(app.description!.length).toBeLessThanOrEqual(170);
    expect(app.description).toMatch(PRINTABLE_ASCII);
    expect(app.subtitle!.length).toBeLessThanOrEqual(30);
    expect(app.subtitle).toMatch(PRINTABLE_ASCII);
    expect(app.tagline!.length).toBeLessThanOrEqual(30);
    expect(app.tagline).toMatch(PRINTABLE_ASCII);

    expect(app.tags!.length).toBeLessThanOrEqual(5);
    for (const tag of app.tags!) {
      expect(tag.length).toBeLessThanOrEqual(20);
      expect(tag).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('describes the same product the shell links to', () => {
    // One sentence, both surfaces: a listing that sells something the link does
    // not open is how the manifest came to advertise a different product.
    expect(app.description).toBe(metaContent('property', 'og:description'));
    expect(app.name).toBe(metaContent('property', 'og:site_name'));
    expect(app.name).toBe(embed.button.action.name);
  });

  it('paints the transition in the app’s own ground, not Warpcast purple', () => {
    expect(app.splashBackgroundColor).toBe(BRAND_GROUND);
    // The embed and the manifest are the same splash; they disagreeing is the
    // regression this test exists to catch.
    expect(embed.button.action.splashBackgroundColor).toBe(
      app.splashBackgroundColor,
    );
  });

  it('names its pictures in this repo, at the sizes the spec asks for', () => {
    // A URL the host aliases into another app's asset directory is another
    // product's art waiting to happen — measured 2026-10-22 (card t_90a2eee2),
    // /icon.png and /image.png were exactly that, both served out of the
    // sibling FSSC app's assets. Every picture the listing names is a file in
    // `public/`, measured from its own PNG header.
    const pictures: [string, string | undefined, [number, number]][] = [
      ['splash', app.splashImageUrl, [200, 200]],
      ['icon', app.iconUrl, [1024, 1024]],
      ['embed image', app.imageUrl, [1200, 800]],
    ];
    for (const [label, url, size] of pictures) {
      expect(url, `${label} is missing from the manifest`).toBeTruthy();
      const parsed = new URL(url as string);
      expect(parsed.origin, label).toBe('https://fiddy.fun');
      expect(
        pngSize(path.join(webRoot, 'public', parsed.pathname)),
        label,
      ).toEqual(size);
    }
    // One splash and one embed card, both surfaces: the transition the shell
    // paints and the picture the listing shows are the manifest's own.
    expect(app.splashImageUrl).toBe(embed.button.action.splashImageUrl);
    expect(app.imageUrl).toBe(embed.imageUrl);
  });

  it('keeps the front door free of the plumbing’s jargon', () => {
    const copy =
      `${app.subtitle} ${app.description} ${app.tagline}`.toLowerCase();
    for (const word of [
      'node',
      'signer',
      'scope',
      'ttl',
      'gasless',
      'api key',
      'snapchain',
      'hermes',
    ]) {
      // Word-boundary, not substring: "little" carries "ttl" and "onchain" is
      // not the same word as a node.
      expect(copy).not.toMatch(new RegExp(`\\b${word}\\b`));
    }
  });
});
