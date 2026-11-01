/**
 * The one scene in this app that touches three.js, and it is reached by
 * `import()` so the library is a chunk of its own, fetched after the shell has
 * painted. Two callers share it — the 36px mark in the chrome and the hero on
 * the front door — because a second three.js setup would be a second renderer,
 * a second GLTFLoader config and a second set of GPU contexts to leak.
 *
 * THE HERO IS A LIVING CHARACTER. It is the owner's own mascot (`fiddy-baby.glb`),
 * which carries its authored 5s loop and a `HeadGroup` inside it: the head turns
 * toward the pointer and the whole figure hops when it is greeted. Nothing here
 * turns the model to face the camera — the camera is fixed on the model's own
 * bounds and the character's own rig does the performing. (The vinyl figure this
 * replaced had no rig and no clips, so it had to be orbited by the camera to look
 * alive at all.)
 *
 * Deliberately minimal, and deliberately the same rules for both callers:
 *   - matte outline shells render BackSide (the black-model lesson),
 *   - a clip loops seamlessly; a caller that sets `restAfterMs` lets it settle
 *     instead of looping forever on a page somebody is reading,
 *   - the frame loop STOPS when there is nothing left to draw — a landing page
 *     must not hold a rAF loop open to show a character standing still,
 *   - nothing renders while the tab is hidden,
 *   - everything is disposed with an explicit context loss, so a top bar that
 *     unmounts or a route that changes does not leak a GPU context,
 *   - the model is framed on its own bounds, so one shot is correct for any
 *     model without anyone hand-tuning a camera per asset.
 */

import {
  AnimationMixer,
  BackSide,
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  LoopRepeat,
  MathUtils,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Sphere,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { FIDDY_MARK_CLIP, FIDDY_MARK_MODEL } from './fiddyMark';

/** A live model on screen. Call `dispose` to take it down for good. */
export interface MountedModel {
  dispose(): void;
  /** Greet the visitor: a hop, and the clip runs again for a while. */
  react(): void;
}

export interface ModelSceneOptions {
  /** The GLB, from the site root. */
  model: string;
  /**
   * The clip to play, looped. Named rather than "first one" so a model that
   * grows a second clip does not silently start playing a different one.
   * Absent means the file is a still and only the camera may move.
   */
  clip?: string;
  /**
   * Turn this node toward the pointer, by this many radians at full deflection.
   *
   * What the head follows is the pointer over the WINDOW, never its position
   * inside this box: a character that only looks at you while the cursor is
   * inside its own square is not looking at you. `yaw` is radians to the right
   * at full rightward deflection, `pitch` radians up at full upward deflection.
   * A model whose rig has no such node simply does not turn its head.
   */
  look?: { node: string; yaw: number; pitch: number };
  /**
   * Let the clip settle this long after the last thing that asked it to move
   * (mounting counts, and so does a greeting). Absent means loop forever, which
   * is what the 36px mark in the chrome wants and what a hero on a page
   * somebody is reading does not: a character that never stops is noise.
   */
  restAfterMs?: number;
  /** A pointer move keeps a resting model awake this long. */
  awakeForMs?: number;
  /** A greeting keeps it awake this long. */
  reactForMs?: number;
  /** Vertical field of view, in degrees. */
  fov?: number;
  /**
   * Where the camera sits, as a direction in the model's own frame — the model
   * is not rotated to face it, the camera moves. One shot per asset: the hero
   * looks up at the face a little, the mark is seen straight on.
   */
  view?: [number, number, number];
  /** Multiplies the framing distance. 1 is tight to the model's bounds. */
  padding?: number;
}

/**
 * The mark's shot, unchanged: same camera direction, same fov, same clip.
 *
 * It lives here rather than in the caller so that the still the chrome paints
 * first (`fiddy-mark-poster.png`, one frame of this GLB) and the model that
 * replaces it are framed by the same numbers — which is why the swap does not
 * jump.
 */
export const FIDDY_MARK_PRESET: ModelSceneOptions = {
  model: FIDDY_MARK_MODEL,
  clip: FIDDY_MARK_CLIP,
  fov: 34,
  view: [0.5, 0.32, 1],
  padding: 1,
};

const DEFAULT_FOV = 34;
const DEFAULT_VIEW: [number, number, number] = [0.5, 0.32, 1];

/** How long a pointer keeps a resting model awake, and how long a greeting does. */
const DEFAULT_AWAKE_MS = 900;
const DEFAULT_REACT_MS = 5000;

/** Seconds for the head to get most of the way to where the pointer is. */
const LOOK_DAMPING = 8;

/** A greeting lasts a second: the figure rises and settles back in one breath. */
const HOP_SECONDS = 1;
/** The hop's height, as a share of the model's own radius. */
const HOP_HEIGHT = 0.07;
/** Radians of roll at the peak of the hop — a lean into it, not a spin. */
const HOP_ROLL = 0.035;

/**
 * Draw `options.model` into `host` and keep drawing it until `signal` aborts.
 *
 * Throws if the model cannot be fetched, parsed or drawn — the caller keeps its
 * still in that case, because a model that cannot move is still the model.
 */
export const mountFiddyModel = async (
  host: HTMLElement,
  signal: AbortSignal,
  options: ModelSceneOptions,
): Promise<MountedModel | undefined> => {
  if (signal.aborted || !host.clientWidth) {
    return undefined;
  }

  const size = host.clientWidth;
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size);
  renderer.setClearAlpha(0);
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new PerspectiveCamera(options.fov ?? DEFAULT_FOV, 1, 0.1, 50);
  scene.add(new HemisphereLight(0xfff6e8, 0x22231f, 1.1));
  const sun = new DirectionalLight(0xfff2dd, 1.6);
  sun.position.set(2, 4, 3);
  scene.add(sun);

  let mixer: AnimationMixer | null = null;
  let frame = 0;
  let disposed = false;
  /** Seconds of clip drawn so far. Frozen while the model is resting. */
  let elapsed = 0;
  /** Wall-clock ms the clip may keep running until. */
  let awakeUntil = 0;
  /** Wall-clock ms the last greeting started. */
  let reactAt = -Infinity;
  /** Last frame's timestamp, or 0 when the loop has just (re)started. */
  let lastFrameAt = 0;
  /** Where the pointer is pointing, -1..1 on each axis. */
  let targetX = 0;
  let targetY = 0;
  /** Where the head is actually pointing, damped toward the target. */
  let lookX = 0;
  let lookY = 0;
  let loaded = false;
  /** The loaded figure and the parts of it the pointer and a greeting need. */
  let figure: Group | null = null;
  let headNode: Group | null = null;
  /** The figure's own resting height, and how high its greeting carries it. */
  let restY = 0;
  let hopHeight = 0;
  /** Scratch rotations, rebuilt every frame rather than allocated per frame. */
  const yawAxis = new Vector3(0, 1, 0);
  const pitchAxis = new Vector3(1, 0, 0);
  const yaw = new Quaternion();
  const pitch = new Quaternion();

  const restAfterMs = options.restAfterMs;
  const awakeForMs = options.awakeForMs ?? DEFAULT_AWAKE_MS;
  const reactForMs = options.reactForMs ?? DEFAULT_REACT_MS;

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelAnimationFrame(frame);
    mixer?.stopAllAction();
    window.removeEventListener('pointermove', onLook);
    document.removeEventListener('visibilitychange', onVisibility);
    renderer.dispose();
    // An explicit context loss: a browser keeps only a handful of live WebGL
    // contexts, and these live in chrome that mounts on every route.
    renderer.forceContextLoss?.();
    renderer.domElement.remove();
  };
  signal.addEventListener('abort', dispose);

  /**
   * A pointer move aims the head and wakes the clip. Touch is ignored on
   * purpose: a finger has no hover position, and the last place a thumb rested
   * is not somewhere the character should stare.
   */
  function onLook(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      return;
    }
    targetX = MathUtils.clamp(
      (event.clientX / window.innerWidth - 0.5) * 2,
      -1,
      1,
    );
    targetY = MathUtils.clamp(
      (0.5 - event.clientY / window.innerHeight) * 2,
      -1,
      1,
    );
    if (restAfterMs !== undefined) {
      awakeUntil = Math.max(awakeUntil, performance.now() + awakeForMs);
    }
    requestFrame();
  }

  function onVisibility() {
    // A tab coming back has no frame timestamp to compare against, and a tab
    // going away has nothing left to draw.
    lastFrameAt = 0;
    if (!document.hidden) {
      requestFrame();
    }
  }

  /**
   * One frame, and the decision about whether there is another one.
   *
   * This is not a loop that runs for the lifetime of the page: a landing page
   * showing a settled character must not hold a rAF callback open, so a frame is
   * only requested while something is still changing — the clip, the head on its
   * way to the pointer, or a greeting.
   */
  function render(now: number) {
    frame = 0;
    if (disposed) {
      return;
    }
    const delta = lastFrameAt ? Math.min((now - lastFrameAt) / 1000, 0.05) : 0;
    lastFrameAt = now;

    const awake = restAfterMs === undefined || now < awakeUntil;
    if (awake) {
      elapsed += delta;
    }
    // The mixer writes the head's own rotation from the clip every time it is
    // asked for a pose, which is what makes the pointer's rotation an addition
    // to the authored loop rather than a rotation that accumulates: if the pose
    // were not rewritten first, the head would spin away on its own.
    mixer?.setTime(elapsed);

    const damping = delta || 0.016;
    lookX = MathUtils.damp(lookX, targetX, LOOK_DAMPING, damping);
    lookY = MathUtils.damp(lookY, targetY, LOOK_DAMPING, damping);
    if (headNode && options.look) {
      yaw.setFromAxisAngle(yawAxis, lookX * options.look.yaw);
      pitch.setFromAxisAngle(pitchAxis, -lookY * options.look.pitch);
      headNode.quaternion.multiply(yaw).multiply(pitch);
    }

    const sinceGreeting = (now - reactAt) / 1000;
    const greeting = sinceGreeting >= 0 && sinceGreeting < HOP_SECONDS;
    if (figure) {
      if (greeting) {
        figure.position.y =
          restY + Math.sin(sinceGreeting * Math.PI) * hopHeight;
        figure.rotation.z = Math.sin(sinceGreeting * Math.PI * 2) * HOP_ROLL;
      } else if (figure.position.y !== restY || figure.rotation.z !== 0) {
        figure.position.y = restY;
        figure.rotation.z = 0;
      }
    }

    renderer.render(scene, camera);

    // What the character is doing, on the element a probe can read: pixels
    // alone cannot tell "resting" from "a very small hop", and the head's own
    // angle is what says whether it is following the pointer.
    const state = greeting ? 'reacting' : awake ? 'playing' : 'resting';
    if (host.dataset.motion !== state) {
      host.dataset.motion = state;
    }
    // The exact authored lift, 0 at rest and 1 at the top of the hop. This is
    // the same value that moves the figure, so a probe need not infer a small
    // hop from a changing silhouette (the clip moves the silhouette too).
    const hop = greeting ? Math.sin(sinceGreeting * Math.PI).toFixed(3) : '0';
    if (host.dataset.hop !== hop) {
      host.dataset.hop = hop;
    }
    if (options.look && headNode) {
      // Reported as the DEFLECTION in degrees — yaw positive to the right,
      // pitch positive upward — not as the rotation about the head's own axes.
      // The two disagree in sign (looking up is a negative rotation about the
      // head's X axis) and a probe reading this should have to know the
      // character's direction, not three.js's.
      const degrees = `${MathUtils.radToDeg(lookX * options.look.yaw).toFixed(1)},${MathUtils.radToDeg(lookY * options.look.pitch).toFixed(1)}`;
      if (host.dataset.look !== degrees) {
        host.dataset.look = degrees;
      }
    }

    const settled =
      Math.abs(lookX - targetX) + Math.abs(lookY - targetY) < 0.002;
    if (awake || greeting || !settled) {
      requestFrame();
    }
  }

  function requestFrame() {
    if (!disposed && !frame && loaded && !document.hidden) {
      frame = requestAnimationFrame(render);
    }
  }

  try {
    const response = await fetch(options.model, { signal });
    if (!response.ok) {
      throw new Error(`model missing: ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    if (signal.aborted) {
      dispose();
      return undefined;
    }

    const model = gltf.scene as Group;
    scene.add(model);

    model.traverse((child) => {
      const mesh = child as { material?: { name?: string; side?: number } };
      // Every outline shell in these files is an inflated copy of a part (all of
      // them are scaled up in the file), so with their FRONT faces on they are a
      // lid over the figure and the character arrives as a dark silhouette.
      // Drawn back-faces-only, they are the rim the artist drew. The two
      // revisions of the mascot spell the material differently — `ToonOutline`
      // in the 148 KB mark, `OutlineMat` in the full figure — so the rule
      // matches the name rather than one spelling; the ink that draws eyes and
      // brows (`DarkInk`/`DarkInkMat`) is not a shell and keeps its faces.
      if (mesh.material?.name && /outline/i.test(mesh.material.name)) {
        mesh.material.side = BackSide;
      }
    });

    // Frame the model's own bounds — the same shot its still was captured from,
    // so the swap from still to moving does not jump. Measured on the pose the
    // file ships (the bind pose), which is the pose
    // `scripts/render-hero-poster.mjs` draws the still in: the clip is applied
    // afterwards, so the two framings stay the same arithmetic.
    const bounds = new Box3().setFromObject(model);
    const center = bounds.getCenter(new Vector3());
    const sphere = bounds.getBoundingSphere(new Sphere());
    const fov = (camera.fov * Math.PI) / 180;
    const view = options.view ?? DEFAULT_VIEW;
    const distance =
      (sphere.radius / Math.sin(fov / 2)) * (options.padding ?? 1);
    const viewLength = Math.hypot(...view);
    // The camera sits off the model's own vertical axis, at the direction
    // `view` names. The model is not rotated to meet it: this is one fixed shot,
    // and it is the shot every still of this model was rendered from.
    camera.position.set(
      center.x + (distance * view[0]) / viewLength,
      center.y + (distance * view[1]) / viewLength,
      center.z + (distance * view[2]) / viewLength,
    );
    camera.lookAt(center);

    const clip = options.clip
      ? (gltf.animations.find((entry) => entry.name === options.clip) ??
        gltf.animations[0])
      : undefined;
    mixer = new AnimationMixer(model);
    if (clip) {
      mixer.clipAction(clip).setLoop(LoopRepeat, Infinity).play();
    }

    figure = model;
    restY = model.position.y;
    hopHeight = sphere.radius * HOP_HEIGHT;
    headNode = options.look
      ? ((model.getObjectByName(options.look.node) as Group | null) ?? null)
      : null;

    // The clip runs for `restAfterMs` from the moment it is mounted, then
    // settles wherever the loop left it.
    if (restAfterMs !== undefined) {
      awakeUntil = performance.now() + restAfterMs;
    }

    loaded = true;
    if (options.look) {
      window.addEventListener('pointermove', onLook, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    requestFrame();

    return {
      dispose,
      react() {
        if (disposed) {
          return;
        }
        reactAt = performance.now();
        if (restAfterMs !== undefined) {
          awakeUntil = reactAt + reactForMs;
        }
        requestFrame();
      },
    };
  } catch (error) {
    dispose();
    if (signal.aborted) {
      return undefined;
    }
    throw error;
  }
};

/** The chrome mark: the preset above, and nothing else. */
export const mountFiddyMark = (
  host: HTMLElement,
  signal: AbortSignal,
): Promise<MountedModel | undefined> =>
  mountFiddyModel(host, signal, FIDDY_MARK_PRESET);
