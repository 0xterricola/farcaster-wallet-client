// The still the hero Fiddy paints before its model arrives.
//
//   node scripts/render-hero-poster.mjs         # -> public/fiddy-hero-poster.png
//   node scripts/render-hero-poster.mjs --check # measure only, write nothing
//
// Why this exists, and why it is a script rather than a checked-in drawing:
//
//   `FiddyHeroStage` paints `public/fiddy-hero-poster.png` first, always — it is
//   what a visitor sees before the model is fetched, what a reader who asked for
//   reduced motion gets forever, and what any browser without WebGL gets. So it
//   has to be a real picture of this model, or the fallback is a lie. It is the
//   pose `public/fiddy-baby.glb` ships in, drawn with the same lights, the same
//   lens and the same shot the live canvas opens on — which is what makes the
//   swap from still to moving invisible rather than a jump. The recipe it mirrors
//   is in `src/components/fiddy/fiddyModelScene.ts` and the preset the hero
//   passes it is in `src/components/fiddy/fiddyHero.ts`; `verify-fiddy-hero.mjs`
//   measures the two against each other on the live page, so this cannot drift
//   in silence.
//
//   There is no turntable to check against any more: the hero is a rigged
//   character whose own loop and whose own head do the moving, and the camera is
//   fixed on it. So the sweep below is one azimuth, and it is the only one the
//   canvas will ever draw.
//
// It uses the app's own `three` and the Playwright Chromium the repo already
// installs for its probes, and it needs no network: the three.js modules are
// turned into blob: URLs behind an import map, the GLB is pushed in as bytes,
// and the page stays on about:blank.
//
// It also refuses to write a poster that would mislead, twice:
//   * the drawing must not touch the frame the model is framed inside — a shot
//     that fits here but clips the ears would be a model that grows horns;
//   * the picture must be transparent where the model is not, because it is
//     composited over the page's own ground.
//
// Prints one JSON line.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { decodePng, minAlpha, visibleBox } from './lib/png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const MODEL = path.join(APP, 'public', 'fiddy-baby.glb');
const OUT = path.join(APP, 'public', 'fiddy-hero-poster.png');

/** The box the live canvas draws into on a desktop (232px at up to 2x dpr). */
const SIZE = 512;

/** The three.js the app itself renders with — never a second copy. */
const THREE_ENTRY = fileURLToPath(import.meta.resolve('three'));
const THREE_DIR = path.resolve(path.dirname(THREE_ENTRY), '..');

/** The page's ground, which the still has to be transparent against. */
const GROUND = { r: 0x16, g: 0x17, b: 0x15 };

const die = (error, extra = {}) => {
  console.log(JSON.stringify({ ok: false, error, ...extra }));
  process.exit(1);
};

/** Progress goes to stderr, and only when asked for: stdout is one JSON line. */
const dbg = (...message) => {
  if (process.env.FIDDY_HERO_DEBUG) console.error('[hero-poster]', ...message);
};

/**
 * The hero's shot, in the scene module's own terms. Every number here has a
 * counterpart in `fiddyModelScene.ts` (`fov`, the two lights, the bounds
 * framing) or in `fiddyHero.ts` (`FIDDY_HERO_VIEW`, `FIDDY_HERO_PADDING`);
 * `turnDeg` is the azimuth, and the hero's camera is fixed, so it is always 0.
 */
const RECIPE = {
  fov: 34,
  view: [0.22, 0.16, 1],
  padding: 0.78,
  near: 0.1,
  far: 50,
  hemisphere: { sky: 0xfff6e8, ground: 0x22231f, intensity: 1.1 },
  sun: { colour: 0xfff2dd, intensity: 1.6, at: [2, 4, 3] },
};

const MAIN = `
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
const R = window.__R
const S = window.__S

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
renderer.setPixelRatio(1)
renderer.setSize(S, S)
renderer.setClearAlpha(0)
document.body.appendChild(renderer.domElement)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(R.fov, 1, R.near, R.far)
scene.add(new THREE.HemisphereLight(R.hemisphere.sky, R.hemisphere.ground, R.hemisphere.intensity))
const sun = new THREE.DirectionalLight(R.sun.colour, R.sun.intensity)
sun.position.set(...R.sun.at)
scene.add(sun)

const gltf = await new GLTFLoader().parseAsync(window.__glb.buffer, '')
const model = gltf.scene
scene.add(model)

// The same material treatment the live scene applies, and for the same reason:
// every outline shell in these files is an inflated copy of a part (all of them
// are scaled up in the file), so with their front faces on they are a lid over
// the figure and the character arrives as a dark silhouette. Drawn
// back-faces-only, they are the rim the artist drew. The two revisions of the
// mascot spell the material differently ('ToonOutline' in the 148 KB mark,
// 'OutlineMat' in the full figure), so the rule matches the name, not one
// spelling — and the ink that draws eyes and brows ('DarkInk'/'DarkInkMat') is
// not a shell and keeps its faces.
model.traverse((child) => {
  const name = child.material?.name
  if (name && /outline/i.test(name)) child.material.side = THREE.BackSide
})

// The same one shot the live scene takes: framed on the model's own bounds, on
// the azimuth and height FIDDY_HERO_VIEW names.
const bounds = new THREE.Box3().setFromObject(model)
const centre = bounds.getCenter(new THREE.Vector3())
const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius
const fov = (camera.fov * Math.PI) / 180
const distance = radius / Math.sin(fov / 2) * R.padding
const view = R.view
const viewLength = Math.hypot(...view)
const orbitRadius = distance * Math.hypot(view[0], view[2]) / viewLength
const orbitHeight = centre.y + distance * view[1] / viewLength
const viewAzimuth = Math.atan2(view[0], view[2])

window.__render = (turnDeg) => {
  const azimuth = viewAzimuth + turnDeg * Math.PI / 180
  camera.position.set(
    centre.x + Math.sin(azimuth) * orbitRadius,
    orbitHeight,
    centre.z + Math.cos(azimuth) * orbitRadius,
  )
  camera.lookAt(centre)
  renderer.render(scene, camera)
  return true
}
window.__info = { clips: gltf.animations.map((c) => c.name), triangles: 0 }
let tris = 0
model.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 })
window.__info.triangles = Math.round(tris)
window.__ready = true
`;

function moduleSources(threeDir) {
  const read = (file) => fs.readFileSync(path.join(threeDir, file), 'utf8');
  const addon = (file) =>
    read(file).replace(
      /from '\.\.\/utils\/([A-Za-z]+)\.js'/g,
      "from 'three/addons/utils/$1.js'",
    );
  return {
    core: read('build/three.core.js'),
    three: read('build/three.module.js'),
    gltf: addon('examples/jsm/loaders/GLTFLoader.js'),
    bufferGeometryUtils: read('examples/jsm/utils/BufferGeometryUtils.js'),
    skeletonUtils: read('examples/jsm/utils/SkeletonUtils.js'),
  };
}

const BOOT = ({ sources, recipe, size }) => {
  const url = (source) =>
    URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  const core = url(sources.core);
  const imports = {
    three: url(sources.three.split("'./three.core.js'").join(JSON.stringify(core))),
    'three/addons/utils/BufferGeometryUtils.js': url(sources.bufferGeometryUtils),
    'three/addons/utils/SkeletonUtils.js': url(sources.skeletonUtils),
    'three/addons/loaders/GLTFLoader.js': url(sources.gltf),
  };
  const map = document.createElement('script');
  map.type = 'importmap';
  map.textContent = JSON.stringify({ imports });
  document.head.appendChild(map);
  window.__R = recipe;
  window.__S = size;
};

const main = async () => {
  const write = !process.argv.includes('--check');
  if (!fs.existsSync(MODEL)) {
    die(`no model at ${MODEL}`);
  }
  if (!fs.existsSync(THREE_ENTRY)) {
    die(`three not installed (looked for ${THREE_ENTRY})`);
  }

  const bytes = fs.readFileSync(MODEL);
  // The system Chrome, the same browser the repo's other render script uses:
  // the bundled headless shell refuses these flags on this Playwright build, and
  // software WebGL (SwiftShader) is what makes a GPU-less render possible.
  dbg('launching chrome');
  const browser = await chromium.launch({
    channel: 'chrome',
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--hide-scrollbars',
      '--default-background-color=00000000',
    ],
  });
  try {
    dbg('launched');
    const page = await browser.newPage({
      viewport: { width: SIZE, height: SIZE },
      deviceScaleFactor: 1,
    });
    const problems = [];
    page.on('pageerror', (error) => problems.push(String(error)));
    dbg('goto about:blank');
    await page.goto('about:blank');
    dbg('boot import map');
    await page.evaluate(BOOT, {
      sources: moduleSources(THREE_DIR),
      recipe: RECIPE,
      size: SIZE,
    });
    await page.evaluate((base64) => {
      const binary = atob(base64);
      const buffer = new ArrayBuffer(binary.length);
      const view = new Uint8Array(buffer);
      for (let at = 0; at < binary.length; at++) view[at] = binary.charCodeAt(at);
      window.__glb = new Uint8Array(buffer);
    }, bytes.toString('base64'));

    dbg('load render module');
    const module = await page.evaluate(
      (source) =>
        new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.type = 'module';
          script.src = URL.createObjectURL(
            new Blob([source], { type: 'text/javascript' }),
          );
          script.onerror = () => reject(new Error('the render module did not load'));
          document.body.appendChild(script);
          const timer = setInterval(() => {
            if (window.__ready) {
              clearInterval(timer);
              resolve(true);
            }
          }, 25);
          setTimeout(() => {
            clearInterval(timer);
            reject(new Error('the render module never became ready'));
          }, 30000);
        }),
      MAIN,
    );
    void module;

    dbg('ready');
    const info = await page.evaluate(() => window.__info);
    dbg('info', JSON.stringify(info));

    // One azimuth, because that is the only one the live canvas draws: the
    // camera is fixed on the model, and the character's own rig is what moves.
    const turns = [0];
    const boxes = {};
    let poster = null;
    for (const turn of turns) {
      dbg('render at', turn);
      await page.evaluate((degrees) => window.__render(degrees), turn);
      dbg('screenshot at', turn);
      const shot = await page.locator('canvas').screenshot({
        omitBackground: true,
        type: 'png',
      });
      const image = decodePng(shot);
      const box = visibleBox(image, { ground: GROUND, threshold: 30 });
      if (!box) {
        die(`nothing is drawn at ${turn} degrees — the model did not render`, {
          page_errors: problems,
        });
      }
      boxes[turn] = { x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
      if (box.x0 <= 0 || box.y0 <= 0 || box.x1 >= SIZE - 1 || box.y1 >= SIZE - 1) {
        die(
          `the model touches the frame at ${turn} degrees (box ${JSON.stringify(boxes[turn])} in ${SIZE}px): ` +
            'the shot clips it, so no poster is written',
          { boxes },
        );
      }
      if (turn === 0) poster = shot;
    }

    const posterImage = decodePng(poster);
    if (minAlpha(posterImage) !== 0) {
      die('the poster carries no transparency — it would paint a box over the page');
    }

    if (write) {
      fs.writeFileSync(OUT, poster);
    }

    console.log(
      JSON.stringify({
        ok: true,
        wrote: write ? path.relative(APP, OUT) : null,
        model: path.relative(APP, MODEL),
        model_bytes: bytes.length,
        three: path.relative(APP, THREE_ENTRY),
        size: SIZE,
        triangles: info.triangles,
        clips: info.clips,
        boxes,
        fills: {
          width: (boxes[0].x1 - boxes[0].x0 + 1) / SIZE,
          height: (boxes[0].y1 - boxes[0].y0 + 1) / SIZE,
        },
        page_errors: problems,
      }),
    );
  } finally {
    await browser.close();
  }
};

main().catch((error) => die(String(error?.stack ?? error)));