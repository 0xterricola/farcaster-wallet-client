// @vitest-environment node
/**
 * The hero's two files, held to the contract the code that loads them assumes.
 *
 * These are the things that fail silently and only on somebody else's phone:
 *
 *   * `fiddy-baby.glb` is the interactive hero, so three of its properties are
 *     load-bearing: it ships the clip the stage asks for BY NAME
 *     (`CuteBaby5sLoop`), it ships a `HeadGroup` for the pointer to turn, and it
 *     requires no extension at all. The hero that replaced it named
 *     `EXT_texture_webp` in `extensionsRequired`, which is a hard requirement a
 *     loader is entitled to refuse the whole file over; this mascot embeds no
 *     textures and needs nothing. The day someone swaps in a Draco- or
 *     KTX2-compressed export this test is what says so — instead of a poster
 *     that never moves on Safari.
 *
 *   * every outline shell in the file is an INFLATED copy (all of them are
 *     scaled up), which is the premise the scene module's side-flip rests on:
 *     with the shells' front faces on they are a lid over the figure and the
 *     character arrives as a dark silhouette. If that ever stops being true, the
 *     flip in `fiddyModelScene.ts` is drawing the wrong faces.
 *
 *   * `fiddy-hero-poster.png` is the whole hero on a browser with no WebGL and
 *     the whole hero under reduced motion. A hero whose fallback is missing is a
 *     hole in the page, so its existence, its transparency and its size are part
 *     of the contract, not a detail of the render.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** `apps/farcaster-web`, from `src/components/fiddy/__tests__`. */
const APP = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const GLB = path.join(APP, 'public', 'fiddy-baby.glb');
const POSTER = path.join(APP, 'public', 'fiddy-hero-poster.png');

/** The JSON chunk of a GLB, which is where a glTF keeps its promises. */
const gltfJson = (file: string) => {
  const buffer = fs.readFileSync(file);
  expect(buffer.subarray(0, 4).toString('latin1')).toBe('glTF');
  const length = buffer.readUInt32LE(12);
  const type = buffer.subarray(16, 20).toString('latin1');
  expect(type).toBe('JSON');
  return JSON.parse(buffer.subarray(20, 20 + length).toString('utf8'));
};

const threeVersion = () =>
  JSON.parse(
    fs.readFileSync(
      path.join(APP, 'node_modules', 'three', 'package.json'),
      'utf8',
    ),
  ).version as string;

describe('fiddy-baby.glb', () => {
  it('is a binary glTF the app can actually parse, with a head to turn', () => {
    const json = gltfJson(GLB);
    expect(json.asset.version).toBe('2.0');
    expect(json.meshes.length).toBeGreaterThan(1);
    expect(
      json.nodes.some((node: { name?: string }) => node.name === 'HeadGroup'),
    ).toBe(true);
  });

  it('ships the one clip the hero asks for, by name', () => {
    // The stage names its clip rather than taking `animations[0]`, precisely so
    // that a model which grows a second clip cannot silently start playing a
    // different one — which means the name has to actually be in the file.
    const names = gltfJson(GLB).animations.map(
      (clip: { name?: string }) => clip.name,
    );
    expect(names).toEqual(['CuteBaby5sLoop']);
  });

  it('requires no extension and embeds no texture, so nothing can refuse it', () => {
    const json = gltfJson(GLB);
    expect(json.extensionsRequired ?? []).toEqual([]);
    expect(json.images ?? []).toEqual([]);

    // What it does USE is core three.js support, and this is the cheap guard
    // against a downgrade that would silently drop the material treatment.
    const [major, minor] = threeVersion().split('.').map(Number);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(150);
    expect(
      fs.readFileSync(
        path.join(
          APP,
          'node_modules',
          'three',
          'examples',
          'jsm',
          'loaders',
          'GLTFLoader.js',
        ),
        'utf8',
      ),
    ).toContain('KHR_materials_unlit');
  });

  it('makes every outline shell an inflated copy, which is what the flip assumes', () => {
    const json = gltfJson(GLB);
    const materialNames: string[] = json.materials.map(
      (material: { name?: string }) => material.name,
    );
    const shells: { name?: string; scale?: number[] }[] = [];
    for (const node of json.nodes) {
      if (node.mesh === undefined) {
        continue;
      }
      for (const primitive of json.meshes[node.mesh].primitives) {
        if (/outline/i.test(materialNames[primitive.material])) {
          shells.push({ name: node.name, scale: node.scale });
        }
      }
    }
    expect(shells.length).toBeGreaterThan(0);
    for (const shell of shells) {
      expect(shell.scale, `${shell.name} carries no scale`).toBeTruthy();
      for (const axis of shell.scale ?? []) {
        expect(
          axis,
          `${shell.name} is not inflated on every axis`,
        ).toBeGreaterThan(1);
      }
      expect(shell.scale).toHaveLength(3);
    }
  });
});

describe('fiddy-hero-poster.png', () => {
  it('is a real picture with transparency, big enough for a 232px stage at 2x', () => {
    const buffer = fs.readFileSync(POSTER);
    expect(buffer.subarray(1, 4).toString('latin1')).toBe('PNG');
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    const colourType = buffer[25];
    // 4 = greyscale+alpha, 6 = truecolour+alpha: a poster with no alpha channel
    // would paint a rectangle over the page instead of a Fiddy on it.
    expect([4, 6]).toContain(colourType);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(232 * 2);
  });

  it('is not merely an empty box', () => {
    // A 232px square of nothing compresses to a few hundred bytes; the poster
    // has a figure in it.
    expect(fs.statSync(POSTER).size).toBeGreaterThan(20_000);
  });
});
