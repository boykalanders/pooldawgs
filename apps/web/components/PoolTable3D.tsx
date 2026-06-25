"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { Camera } from "@babylonjs/core/Cameras/camera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { PointLight } from "@babylonjs/core/Lights/pointLight.js";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator.js";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent.js";
import { Vector3, Color3, Color4, Quaternion, Matrix } from "@babylonjs/core/Maths/math.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
// Side-effect: registers Scene.pick / Scene.createPickingRay. Without it the
// tree-shaken build leaves them undefined and every cloth raycast throws, which
// silently broke aim and ball-in-hand placement.
import "@babylonjs/core/Culling/ray.js";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { RawCubeTexture } from "@babylonjs/core/Materials/Textures/rawCubeTexture.js";
import { Constants } from "@babylonjs/core/Engines/constants.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";

import {
  PX_PER_M,
  MAX_POWER,
  STEP_MS,
  cloneState,
  cueBallId,
  geomFor,
  isInsideHole,
  isOutsideBorder,
  simulateShot,
  type Frame,
  type ShotEvent,
  type ShotInput,
  type TableGeometry,
  type TableState,
} from "@pooldawgs/engine";
import { ballStyle, type BallLike } from "@/lib/balls";

// ── px (engine) ↔ metres (world), origin at table centre, Y up ─────────────
// Geometry is per-variant (snooker's table is bigger and its balls smaller),
// so these are set from the active variant at mount via setRenderGeom(). The
// component is re-keyed on gameType in GameShell, so a fresh scene is built
// with the correct geometry whenever the variant changes.
const S = 1 / PX_PER_M;
// Render balls a hair smaller than the physics collision radius (BALL_RADIUS)
// so two balls resting one diameter apart show a clean gap instead of visually
// touching/overlapping at the camera angle.
const BALL_VIS = 0.94;
let RG: TableGeometry = geomFor("8ball");
let R = RG.BALL_RADIUS * S * BALL_VIS; // ball radius (world metres, visual)
function setRenderGeom(gameType: TableState["gameType"]): void {
  RG = geomFor(gameType);
  R = RG.BALL_RADIUS * S * BALL_VIS;
}
const wx = (px: number) => (px - RG.TABLE_WIDTH / 2) * S;
const wz = (py: number) => (RG.TABLE_HEIGHT / 2 - py) * S;
const pxX = (worldX: number) => worldX / S + RG.TABLE_WIDTH / 2;
const pxY = (worldZ: number) => RG.TABLE_HEIGHT / 2 - worldZ / S;

const FRAME_STRIDE = 2;
const FRAME_MS = STEP_MS * FRAME_STRIDE;
const CHARGE_PER_MS = MAX_POWER / 1600;
const KEY_POWER_PER_MS = MAX_POWER / 1200;
const SOLID = "#f5efe0";

// Camera/Layout Golden Spec v1.0. NOTE: the spec's "beta 72°" reads as 72° of
// ELEVATION (Miniclip-style steep top-down); Babylon's beta is measured from
// the +Y up-axis, so a literal 72° points nearly edge-on and squashes the
// table. We use ~32° from vertical (≈58° elevation) for the intended premium
// 3/4 look, and frame the table at ~75% occupancy. Centralised here for easy
// tuning when the exact preferred angle is dialled in.
const CAM_ALPHA = -Math.PI / 2; // -90°
const CAM_BETA = 0.56; // ≈32° from vertical (≈58° elevation)
const CAM_RADIUS = 5.0;
// Framing margin over the table's world size (the bigger snooker table is
// auto-fit because the bounds derive from RG at render time). Tightened a touch
// so the balls read bigger by default (client: "balls zoomed in a bit").
const FRAME_MARGIN_W = 1.05;
const FRAME_MARGIN_H = 1.18;

// Re-export so callers (GameShell) can share one ShotAnimation type.
export interface ShotAnimation {
  fromState: TableState;
  shot: ShotInput;
  key: string;
  /** Pre-simulated replay from the SAME simulation that produced the applied
   *  end state, so the replay can't diverge from where the balls settle (Havok
   *  isn't bit-identical run-to-run). When omitted the renderer simulates. */
  frames?: Frame[];
  events?: ShotEvent[];
}
export interface PoolTable3DHandle {
  shootNow(power: number): boolean;
}
interface PoolTable3DProps {
  state: TableState;
  interactive: boolean;
  power: number;
  onPowerChange?: (power: number) => void;
  spin?: { x: number; y: number };
  muted?: boolean;
  showGuide: boolean;
  animation?: ShotAnimation | null;
  onShoot?: (shot: ShotInput) => void;
  onPlaceCueBall?: (x: number, y: number) => void;
  onAnimationEnd?: () => void;
  /** Imperative handle passed as a normal prop (next/dynamic doesn't forward
   *  refs), so GameShell can call shootNow() the same way it does for 2D. */
  apiRef?: MutableRefObject<PoolTable3DHandle | null>;
  /** Visual-quality gates. The component is re-keyed on these in GameShell, so
   *  a fresh scene is built when they change. Defaults to everything on. */
  graphics?: { reflections: boolean; shadows: boolean; highRes: boolean };
}

// ── sounds (cloned per play, like the fork) ────────────────────────────────
const audioCache = new Map<string, HTMLAudioElement>();
function playSound(src: string, volume: number, muted?: boolean): void {
  if (muted || typeof window === "undefined") return;
  let base = audioCache.get(src);
  if (!base) {
    base = new Audio(src);
    base.preload = "auto";
    audioCache.set(src, base);
  }
  const node = base.cloneNode(true) as HTMLAudioElement;
  node.volume = Math.max(0, Math.min(1, volume));
  void node.play().catch(() => {});
}

export default function PoolTable3D({
  state,
  interactive,
  power,
  onPowerChange,
  spin,
  muted,
  showGuide,
  animation,
  onShoot,
  onPlaceCueBall,
  onAnimationEnd,
  apiRef,
  graphics,
}: PoolTable3DProps) {
  const gfx = graphics ?? { reflections: true, shadows: true, highRes: true };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Aim target in engine px (where the cue is pointed). */
  const aimTarget = useRef({
    x: geomFor(state.gameType).TABLE_WIDTH * 0.7,
    y: geomFor(state.gameType).TABLE_HEIGHT / 2,
  });
  const charging = useRef(false);
  const placingBall = useRef(false);
  const keysDown = useRef(new Set<string>());
  const lastTick = useRef(0);
  const playing = useRef<{
    frames: Frame[];
    events: ShotEvent[];
    eventIdx: number;
    startedAt: number;
    key: string;
  } | null>(null);

  const propsRef = useRef({ state, interactive, power, onPowerChange, spin, muted, showGuide, onShoot, onPlaceCueBall, onAnimationEnd });
  propsRef.current = { state, interactive, power, onPowerChange, spin, muted, showGuide, onShoot, onPlaceCueBall, onAnimationEnd };

  // Fire at the current aim. Stable ref so the keyboard handler can call it.
  const shootAtAim = useRef<(p: number) => boolean>(() => false);
  shootAtAim.current = (shotPower) => {
    const p = propsRef.current;
    if (!p.interactive || playing.current || !p.onShoot) return false;
    if (p.state.gameOver || p.state.ballInHand) return false;
    const cue = p.state.balls[cueBallId(p.state)];
    if (cue.inHole || shotPower <= 1) return false;
    const angle = Math.atan2(aimTarget.current.y - cue.y, aimTarget.current.x - cue.x);
    charging.current = false;
    keysDown.current.clear();
    playSound("/assets/sounds/strike.wav", shotPower / 10, p.muted);
    p.onShoot({ angle, power: shotPower, spinX: p.spin?.x ?? 0, spinY: -(p.spin?.y ?? 0) });
    p.onPowerChange?.(0);
    return true;
  };
  // Expose the imperative handle via the apiRef prop (see note on the prop).
  useEffect(() => {
    if (apiRef) apiRef.current = { shootNow: (pw) => shootAtAim.current(pw) };
    return () => {
      if (apiRef) apiRef.current = null;
    };
  }, [apiRef]);

  // Keyboard: W/S adjust power, Space/Enter fire (desktop parity with 2D).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (k === "w" || k === "s") {
        keysDown.current.add(k);
        e.preventDefault();
      } else if (k === " " || k === "enter") {
        if (shootAtAim.current(propsRef.current.power)) e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => keysDown.current.delete(e.key.toLowerCase());
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Start replay when a new animation arrives. Prefer the frames carried with
  // the animation (the SAME simulation that produced the applied end state) so
  // the replay can't diverge from it; only simulate here if none were supplied.
  useEffect(() => {
    if (!animation) return;
    if (playing.current?.key === animation.key) return;
    try {
      let frames = animation.frames;
      let events = animation.events;
      if (!frames) {
        const r = simulateShot(cloneState(animation.fromState), animation.shot, {
          recordFrames: true,
          frameStride: FRAME_STRIDE,
        });
        frames = r.frames ?? [];
        events = r.events;
      }
      playing.current = {
        frames: frames ?? [],
        events: events ?? [],
        eventIdx: 0,
        startedAt: performance.now(),
        key: animation.key,
      };
    } catch {
      playing.current = null;
      propsRef.current.onAnimationEnd?.();
    }
  }, [animation]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRenderGeom(state.gameType); // select this variant's table/ball size
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
    // Render at the device's pixel ratio (capped at 2×) for a crisper picture —
    // by default Babylon renders at 1× CSS pixels, which looks soft on phones.
    // Capping keeps high-DPR phones (3×) performant; the High-resolution setting
    // can drop it back to 1× on weaker hardware.
    const dpr = gfx.highRes && typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    engine.setHardwareScalingLevel(1 / dpr);
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.04, 0.035, 1);
    scene.ambientColor = new Color3(0.3, 0.34, 0.3);

    // ── Camera: orthographic, fixed (Golden Spec) ──
    const cam = new ArcRotateCamera("cam", CAM_ALPHA, CAM_BETA, CAM_RADIUS, new Vector3(0, 0, 0), scene);
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    cam.minZ = 0.1;
    cam.maxZ = 100;
    // Fixed during gameplay — no orbit (premium feel). (No attachControl.)
    // Aiming-camera ease (Golden Spec): 0 = idle main camera, 1 = "leaned in"
    // while the player charges a shot (subtle zoom + steeper tilt, ~250ms).
    let camAim = 0;
    const applyOrtho = () => {
      const aspect = (canvas.clientWidth || 16) / (canvas.clientHeight || 9);
      // Frame the actual (per-variant) table: its world half-width, and its
      // half-depth foreshortened by the camera tilt, each with a margin.
      const needW = ((RG.TABLE_WIDTH * S) / 2) * FRAME_MARGIN_W;
      const needH = ((RG.TABLE_HEIGHT * S) / 2) * Math.cos(CAM_BETA) * FRAME_MARGIN_H;
      let halfW = needW;
      let halfH = needH;
      if (needW / needH < aspect) halfW = needH * aspect;
      else halfH = needW / aspect;
      const zoom = 1 - 0.11 * camAim; // ease ~11% closer while aiming (lean-in)
      cam.orthoLeft = -halfW * zoom;
      cam.orthoRight = halfW * zoom;
      cam.orthoTop = halfH * zoom;
      cam.orthoBottom = -halfH * zoom;
    };
    applyOrtho();

    // ── Lighting (Golden Spec) ──
    const dir = new DirectionalLight("key", new Vector3(-0.35, -1, 0.35), scene);
    dir.position = new Vector3(1.2, 3.2, -1.2);
    dir.intensity = 1.3;
    const fill = new HemisphericLight("fill", new Vector3(0, 1, 0), scene);
    fill.intensity = 0.85;
    fill.groundColor = new Color3(0.14, 0.18, 0.15);
    const accent = new PointLight("accent", new Vector3(0, 1.6, 0), scene);
    accent.diffuse = Color3.FromHexString("#FFD27A");
    accent.intensity = 0.2;
    accent.range = 8;

    // Ball shadows on the cloth — toggleable (a meaningful perf lever on phones).
    const shadow = gfx.shadows ? new ShadowGenerator(1024, dir) : null;
    if (shadow) {
      shadow.usePercentageCloserFiltering = true;
      shadow.blurScale = 2;
    }

    // Dark-studio image-based environment (Golden Spec HDRI), generated in code
    // so no .hdr asset ships. Gives the gold trim and the clearcoat balls real
    // reflections (a bright overhead "softbox", dark walls, warm accent band).
    buildStudioEnv(scene);
    // Reflections toggle: buildStudioEnv sets environmentIntensity to 0.55 (the
    // glossy clearcoat look on balls / gold / rails). Dropping it near-matte is
    // the "reflections off" state — cheaper shading and a flatter, plainer table.
    scene.environmentIntensity = gfx.reflections ? 0.55 : 0.1;

    buildTable(scene);

    // ── Balls ──
    const balls: Mesh[] = [];
    for (let i = 0; i < 22; i++) {
      const b = MeshBuilder.CreateSphere(`ball${i}`, { diameter: R * 2, segments: 32 }, scene);
      b.position.y = R;
      b.isVisible = false;
      b.receiveShadows = false;
      shadow?.addShadowCaster(b);
      balls.push(b);
    }

    // Pocket-drop tweens: ballId → state. When a ball is potted we sink its
    // mesh into the pocket well (toward the hole centre, down, shrinking)
    // instead of snapping it invisible — the "ball goes into the hole" look.
    const drops = new Map<
      number,
      { x0: number; z0: number; hx: number; hz: number; startedAt: number }
    >();
    // ── Cue stick ──
    const cueRig = new TransformNode("cueRig", scene);
    const stickLen = 1.45;
    const stick = MeshBuilder.CreateCylinder(
      "stick",
      { height: stickLen, diameterTop: 0.028, diameterBottom: 0.011, tessellation: 16 },
      scene
    );
    stick.rotation.z = Math.PI / 2; // lay along the rig's X axis
    stick.parent = cueRig;
    stick.renderingGroupId = 1; // always drawn on top of the rails/balls
    shadow?.addShadowCaster(stick);
    // Premium two-tone cue: polished maple shaft → dark walnut butt with a gold
    // joint band, baked along the length so it reads like a real cue.
    const cueTex = new DynamicTexture("cueTex", { width: 16, height: 256 }, scene, true);
    const cctx = cueTex.getContext() as unknown as CanvasRenderingContext2D;
    const cueGrad = cctx.createLinearGradient(0, 0, 0, 256);
    cueGrad.addColorStop(0.0, "#e9d6ab"); // tip end — pale maple
    cueGrad.addColorStop(0.6, "#d8b984"); // maple shaft
    cueGrad.addColorStop(0.7, "#d6af3a"); // gold joint band
    cueGrad.addColorStop(0.74, "#2c1a10"); // butt
    cueGrad.addColorStop(1.0, "#1c100a"); // butt cap
    cctx.fillStyle = cueGrad;
    cctx.fillRect(0, 0, 16, 256);
    cueTex.update();
    const stickMat = new PBRMaterial("stickMat", scene);
    stickMat.albedoTexture = cueTex;
    stickMat.metallic = 0.1;
    stickMat.roughness = 0.3;
    stickMat.clearCoat.isEnabled = true;
    stickMat.clearCoat.intensity = 0.5;
    stick.material = stickMat;
    const tipMat = new PBRMaterial("tipMat", scene);
    tipMat.albedoColor = Color3.FromHexString("#c9a227");
    tipMat.metallic = 1;
    tipMat.roughness = 0.25;
    tipMat.emissiveColor = Color3.FromHexString("#3a2c10");
    const ferrule = MeshBuilder.CreateCylinder("ferrule", { height: 0.04, diameter: 0.013, tessellation: 16 }, scene);
    ferrule.rotation.z = Math.PI / 2;
    ferrule.parent = cueRig;
    ferrule.material = tipMat;
    ferrule.renderingGroupId = 1; // on top with the stick
    cueRig.setEnabled(false);

    // ── Aim guide line on the cloth ──
    const aimLine = MeshBuilder.CreateBox("aim", { width: 1, height: 0.001, depth: 0.006 }, scene);
    const aimMat = new StandardMaterial("aimMat", scene);
    aimMat.emissiveColor = new Color3(0.95, 0.97, 0.85);
    aimMat.disableLighting = true;
    aimLine.material = aimMat;
    aimLine.isVisible = false;

    function setBallPositions(s: TableState) {
      const cueIdx = s.balls.length - 1;
      // Drive EVERY mesh from the current state: meshes past the variant's ball
      // count (e.g. snooker's 22 → 8-ball's 16) must be hidden, or stale balls
      // from the previous rack linger on the table ("fake balls").
      for (let i = 0; i < balls.length; i++) {
        const m = balls[i];
        if (drops.has(i)) continue; // a pocket-drop tween owns this mesh
        const ball = s.balls[i];
        if (!ball) {
          m.isVisible = false;
          continue;
        }
        styleBall(m, ball, scene); // re-skins when the variant changes
        if (ball.inHole || (i === cueIdx && s.ballInHand)) {
          m.isVisible = false;
        } else {
          m.isVisible = true;
          m.position.set(wx(ball.x), R, wz(ball.y));
        }
      }
    }
    setBallPositions(state);

    // ── Pointer → aim / ball-in-hand placement (raycast the cloth) ──
    // We deliberately don't camera.attachControl (fixed Golden-Spec camera),
    // which means Babylon's scene.onPointerObservable never receives events and
    // scene.pointerX/Y stay stale. So wire DOM pointer listeners directly (like
    // the 2D canvas) and raycast the cloth from the event's canvas coordinates.
    let dragging = false;
    // Map a screen point to a table coordinate by intersecting the camera ray
    // with the cloth plane (y = 0). This is robust for the orthographic camera
    // (mesh-picking the cloth proved unreliable) and still works when the
    // pointer is just off the cloth, so aim never "sticks".
    const pickTable = (clientX: number, clientY: number): { px: number; py: number } | null => {
      const rect = canvas.getBoundingClientRect();
      const ray = scene.createPickingRay(clientX - rect.left, clientY - rect.top, Matrix.Identity(), cam);
      if (Math.abs(ray.direction.y) < 1e-6) return null;
      const t = -ray.origin.y / ray.direction.y;
      if (t < 0) return null;
      const worldX = ray.origin.x + t * ray.direction.x;
      const worldZ = ray.origin.z + t * ray.direction.z;
      return { px: pxX(worldX), py: pxY(worldZ) };
    };
    const onPointerDown = (e: PointerEvent) => {
      const p = propsRef.current;
      if (playing.current || !p.interactive) return;
      dragging = true;
      const t = pickTable(e.clientX, e.clientY);
      if (t) aimTarget.current = { x: t.px, y: t.py };
      if (p.state.ballInHand && p.onPlaceCueBall) {
        placingBall.current = true; // drag the ghost, drop on release
        canvas.setPointerCapture?.(e.pointerId);
        return;
      }
      const cue = p.state.balls[cueBallId(p.state)];
      if (!cue || cue.inHole || p.state.gameOver) return;
      // Mouse: click fires if power preset, else hold to charge. Touch: aim only
      // here (the power slider is the shoot trigger), matching the 2D feel.
      if (e.pointerType !== "touch") {
        if (p.power > 1) shootAtAim.current(p.power);
        else {
          charging.current = true;
          canvas.setPointerCapture?.(e.pointerId);
        }
      }
    };
    const updateAim = (clientX: number, clientY: number, isTouch: boolean) => {
      const p = propsRef.current;
      if (playing.current || !p.interactive) return;
      // Mouse hover always aims; touch only steers while a finger is down.
      if (!placingBall.current && isTouch && !dragging) return;
      const t = pickTable(clientX, clientY);
      if (t) aimTarget.current = { x: t.px, y: t.py };
    };
    const onPointerMove = (e: PointerEvent) => updateAim(e.clientX, e.clientY, e.pointerType === "touch");
    // Some environments (and headless Chrome) deliver hover as `mousemove`
    // only, not `pointermove`, which left the aim frozen — handle both.
    const onMouseMove = (e: MouseEvent) => updateAim(e.clientX, e.clientY, false);
    const onPointerUp = (e: PointerEvent) => {
      const p = propsRef.current;
      dragging = false;
      if (placingBall.current) {
        placingBall.current = false;
        const t = pickTable(e.clientX, e.clientY);
        if (t) aimTarget.current = { x: t.px, y: t.py };
        const s = p.state;
        const { x, y } = aimTarget.current;
        if (s.ballInHand && p.onPlaceCueBall && !isOutsideBorder(x, y) && !isInsideHole(x, y) && !overlapsBall(s, x, y)) {
          p.onPlaceCueBall(x, y);
        }
        return;
      }
      if (charging.current) {
        charging.current = false;
        if (p.power > 1) shootAtAim.current(p.power);
        else p.onPowerChange?.(0);
      }
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("mousemove", onMouseMove);
    window.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    // Pocket centres in world space (per-variant), for the drop tween target.
    const holeWorlds = RG.HOLES.map((h) => ({ x: wx(h.x), z: wz(h.y) }));
    const nearestHole = (x: number, z: number) => {
      let best = { x: 0, z: 0, d: Infinity };
      for (const h of holeWorlds) {
        const d = (h.x - x) ** 2 + (h.z - z) ** 2;
        if (d < best.d) best = { x: h.x, z: h.z, d };
      }
      return best;
    };
    // Pocket-drop phases (real-world feel): the ball drops into the pocket
    // mouth, RATTLES around the jaws for ~0.6 s (decaying jitter), then sinks
    // out of sight and vanishes.
    const DROP_IN_MS = 150; // fall into the pocket mouth
    const RATTLE_MS = 180; // a couple of quick jaw rattles (~0.18s, 2–3 shakes)
    const SINK_MS = 150; // drop out of sight
    const DROP_TOTAL = DROP_IN_MS + RATTLE_MS + SINK_MS;
    const REST_Y = R * 0.4; // nestled in the pocket but still visible
    const advanceDrops = (now: number) => {
      for (const [id, d] of drops) {
        const m = balls[id];
        if (!m) {
          drops.delete(id);
          continue;
        }
        const age = now - d.startedAt;
        if (age >= DROP_TOTAL) {
          m.isVisible = false;
          m.scaling.set(1, 1, 1);
          m.position.y = R;
          drops.delete(id);
          continue;
        }
        m.isVisible = true;
        if (age < DROP_IN_MS) {
          // 1) roll/fall into the pocket mouth.
          const t = age / DROP_IN_MS;
          const e = t * t;
          m.position.x = d.x0 + (d.hx - d.x0) * e;
          m.position.z = d.z0 + (d.hz - d.z0) * e;
          m.position.y = R + (REST_Y - R) * e;
          m.scaling.set(1, 1, 1);
        } else if (age < DROP_IN_MS + RATTLE_MS) {
          // 2) a couple of quick jaw rattles — ~2–3 shakes, decaying fast.
          const rt = (age - DROP_IN_MS) / RATTLE_MS; // 0..1
          const decay = 1 - rt;
          const ph = (age - DROP_IN_MS) * 0.09; // ~2.6 oscillations over 0.18s
          const amp = R * 0.32 * decay;
          m.position.x = d.hx + Math.cos(ph) * amp;
          m.position.z = d.hz + Math.sin(ph) * amp * 0.7;
          m.position.y = REST_Y + Math.abs(Math.sin(ph)) * R * 0.12 * decay;
          m.scaling.set(1, 1, 1);
        } else {
          // 3) sink out of sight and shrink away.
          const st = (age - DROP_IN_MS - RATTLE_MS) / SINK_MS;
          m.position.x = d.hx;
          m.position.z = d.hz;
          m.position.y = REST_Y + (-R * 1.6 - REST_Y) * st;
          const sc = 1 - 0.85 * st;
          m.scaling.set(sc, sc, sc);
        }
      }
    };

    let raf = 0;
    engine.runRenderLoop(() => {
      const p = propsRef.current;
      const now = performance.now();
      // Aiming camera: lean in while charging a shot, ease back when idle.
      const aiming01 =
        !playing.current &&
        p.interactive &&
        !p.state.gameOver &&
        !p.state.ballInHand &&
        (charging.current || keysDown.current.has("w") || p.power > 1)
          ? 1
          : 0;
      camAim += (aiming01 - camAim) * 0.16; // ~250ms ease at 60fps
      cam.beta = CAM_BETA - 0.05 * camAim; // a touch more top-down when aiming
      applyOrtho(); // keep the table framed even before ResizeObserver settles

      // Power charging (hold-click + W/S), mirrors the 2D canvas.
      const dt = lastTick.current ? Math.min(now - lastTick.current, 100) : 16;
      lastTick.current = now;
      if (p.onPowerChange && p.interactive && !p.state.gameOver && !p.state.ballInHand && !playing.current) {
        let next = p.power;
        if (charging.current) next += dt * CHARGE_PER_MS;
        if (keysDown.current.has("w")) next += dt * KEY_POWER_PER_MS;
        if (keysDown.current.has("s")) next -= dt * KEY_POWER_PER_MS;
        next = Math.max(0, Math.min(MAX_POWER, next));
        if (next !== p.power) p.onPowerChange(next);
      } else {
        charging.current = false;
      }

      const anim = playing.current;
      if (anim) {
        const idx = Math.min(anim.frames.length - 1, Math.floor((now - anim.startedAt) / FRAME_MS));
        const simStep = idx * FRAME_STRIDE;
        while (anim.eventIdx < anim.events.length && anim.events[anim.eventIdx].step <= simStep) {
          const e = anim.events[anim.eventIdx++];
          if (e.type === "ballsCollide") playSound("/assets/sounds/balls-collide.wav", 0.35, p.muted);
          else if (e.type === "pocket") {
            playSound("/assets/sounds/hole.wav", 0.5, p.muted);
            const m = balls[e.ballId];
            if (m && !drops.has(e.ballId)) {
              const hole = nearestHole(m.position.x, m.position.z);
              drops.set(e.ballId, {
                x0: m.position.x,
                z0: m.position.z,
                hx: hole.x,
                hz: hole.z,
                startedAt: now,
              });
            }
          } else if (e.type === "cushion") playSound("/assets/sounds/side.wav", 0.15, p.muted);
        }
        cueRig.setEnabled(false);
        aimLine.isVisible = false;
        applyFrame(balls, anim.frames[idx], scene, p.state.balls);
        if (idx >= anim.frames.length - 1) {
          playing.current = null;
          p.onAnimationEnd?.();
        }
      } else {
        const s = p.state;
        setBallPositions(s);
        const cb = s.balls[s.balls.length - 1];
        const aiming = p.interactive && !s.gameOver && !s.ballInHand && cb && !cb.inHole;
        if (aiming) {
          const angle = Math.atan2(aimTarget.current.y - cb.y, aimTarget.current.x - cb.x);
          const cwx = wx(cb.x);
          const cwz = wz(cb.y);
          // Cue stick: behind the ball along the aim, pulled back with power.
          cueRig.setEnabled(true);
          cueRig.position.set(cwx, R, cwz);
          cueRig.rotation.y = angle;
          const pull = 0.06 + (p.power / MAX_POWER) * 0.32;
          stick.position.x = -(pull + stickLen / 2 + R);
          ferrule.position.x = -(pull + R + 0.02);
          // Aim guide line.
          if (p.showGuide) {
            aimLine.isVisible = true;
            const len = 0.45 + (p.power / MAX_POWER) * 1.1;
            aimLine.scaling.x = len;
            aimLine.position.set(cwx + Math.cos(angle) * len * 0.5, R * 0.7, cwz - Math.sin(angle) * len * 0.5);
            aimLine.rotation.y = angle;
          } else {
            aimLine.isVisible = false;
          }
        } else {
          cueRig.setEnabled(false);
          aimLine.isVisible = false;
        }
        // Ball-in-hand ghost: show the cue ball following the pointer.
        if (p.interactive && s.ballInHand && !s.gameOver && cb) {
          const m = balls[cb.id];
          const { x, y } = aimTarget.current;
          const legal = !isOutsideBorder(x, y) && !isInsideHole(x, y) && !overlapsBall(s, x, y);
          m.isVisible = true;
          m.position.set(wx(x), R, wz(y));
          m.visibility = legal ? 0.9 : 0.5;
        } else {
          const m = balls[s.balls.length - 1];
          if (m) m.visibility = 1;
        }
      }
      advanceDrops(now); // run pocket-drop tweens in both branches
      scene.render();
    });

    const onResize = () => {
      engine.resize();
      applyOrtho();
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      ro.disconnect();
      engine.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full rounded-xl"
      style={{ display: "block", outline: "none", touchAction: "none" }}
    />
  );
}

// ───────────────────────────── helpers ─────────────────────────────

function overlapsBall(state: TableState, x: number, y: number): boolean {
  const cue = cueBallId(state);
  for (const ball of state.balls) {
    if (ball.id === cue || ball.inHole) continue;
    if (Math.hypot(x - ball.x, y - ball.y) < RG.BALL_SIZE) return true;
  }
  return false;
}

function applyFrame(balls: Mesh[], frame: Frame, scene: Scene, ids: BallLike[]): void {
  for (const fb of frame.balls) {
    const m = balls[fb.id];
    if (!m) continue;
    if (!fb.visible) {
      m.isVisible = false;
      continue;
    }
    if (ids[fb.id]) styleBall(m, ids[fb.id], scene);
    m.isVisible = true;
    m.visibility = 1;
    rollBall(m, wx(fb.x), wz(fb.y));
    m.position.set(wx(fb.x), R, wz(fb.y));
  }
}

/** Roll like a real ball: rotate about the axis perpendicular to motion by
 *  distance / radius. Composes in world space. */
function rollBall(mesh: Mesh, nx: number, nz: number): void {
  const dx = nx - mesh.position.x;
  const dz = nz - mesh.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-5 || dist > R * 6) return;
  const axis = new Vector3(dz / dist, 0, -dx / dist);
  const q = Quaternion.RotationAxis(axis, dist / R);
  mesh.rotationQuaternion = q.multiply(mesh.rotationQuaternion ?? Quaternion.Identity());
}

function styleBall(mesh: Mesh, ball: BallLike, scene: Scene): void {
  const style = ballStyle(ball);
  // Re-skin only when the look actually changes (variant switch, cue↔object,
  // etc.). Keying on the visual signature is what fixes snooker balls showing
  // the previous rack's pool numbers after a mode change.
  const key = `${style.kind}|${style.color}|${style.number}`;
  const md = mesh.metadata as { styleKey?: string } | null;
  if (md && md.styleKey === key) return;
  const prev = mesh.material as PBRMaterial | null;
  if (prev) {
    (prev.albedoTexture as DynamicTexture | null)?.dispose();
    prev.dispose();
  }
  mesh.metadata = { styleKey: key };
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
  const hue = style.color;

  // Bake the look into the sphere texture so the number tumbles as it rolls.
  const tex = new DynamicTexture(`bt${Math.round(mesh.uniqueId)}`, { width: 256, height: 256 }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  if (style.kind === "cue") {
    ctx.fillStyle = SOLID;
    ctx.fillRect(0, 0, 256, 256);
    ctx.beginPath();
    ctx.arc(128, 128, 13, 0, Math.PI * 2);
    ctx.fillStyle = "#c0272d";
    ctx.fill();
  } else if (style.kind === "stripe") {
    ctx.fillStyle = SOLID;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = hue;
    ctx.fillRect(0, 86, 256, 84);
  } else {
    ctx.fillStyle = hue;
    ctx.fillRect(0, 0, 256, 256);
  }
  if (style.number !== null) {
    ctx.beginPath();
    ctx.arc(128, 80, 34, 0, Math.PI * 2);
    ctx.fillStyle = "#f5efe0";
    ctx.fill();
    ctx.fillStyle = "#16120e";
    ctx.font = "bold 40px Georgia";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(style.number), 128, 82);
  }
  tex.update();

  // Spec balls: roughness 0.18, clearcoat 0.85.
  const mat = new PBRMaterial(`bm${Math.round(mesh.uniqueId)}`, scene);
  mat.albedoTexture = tex;
  mat.metallic = 0;
  mat.roughness = 0.18;
  mat.clearCoat.isEnabled = true;
  mat.clearCoat.intensity = 0.85;
  mat.clearCoat.roughness = 0.1;
  mesh.material = mat;
}

/** Procedural "dark studio" cube environment for PBR reflections — a bright
 *  soft overhead light, a dark floor, and dark walls with a warm accent band.
 *  Built from raw pixels so no external HDR asset is required. */
function buildStudioEnv(scene: Scene): void {
  const N = 128;
  const faces: ArrayBufferView[] = [];
  for (let f = 0; f < 6; f++) {
    const buf = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        let r: number, g: number, b: number;
        if (f === 2) {
          // +Y top: soft circular key light (the "softbox").
          const dx = (x - N / 2) / (N / 2);
          const dy = (y - N / 2) / (N / 2);
          const k = Math.max(0, 1 - (dx * dx + dy * dy));
          r = 58 + 180 * k;
          g = 60 + 178 * k;
          b = 64 + 170 * k;
        } else if (f === 3) {
          r = 11; // -Y floor: dark
          g = 13;
          b = 15;
        } else {
          // Walls: lighter at the top, with a faint warm accent band.
          const v = y / (N - 1);
          const base = 56 + (16 - 56) * v;
          const warm = Math.max(0, 1 - Math.abs(v - 0.16) * 6) * 16;
          r = base + warm;
          g = base + warm * 0.78;
          b = base + warm * 0.4;
        }
        buf[i] = Math.min(255, Math.round(r));
        buf[i + 1] = Math.min(255, Math.round(g));
        buf[i + 2] = Math.min(255, Math.round(b));
        buf[i + 3] = 255;
      }
    }
    faces.push(buf);
  }
  const env = new RawCubeTexture(
    scene,
    faces,
    N,
    Constants.TEXTUREFORMAT_RGBA,
    Constants.TEXTURETYPE_UNSIGNED_INT,
    true // generate mipmaps for smoother reflections on glossy surfaces
  );
  scene.environmentTexture = env;
  scene.environmentIntensity = 0.55;
}

function buildTable(scene: Scene): void {
  const playW = (RG.TABLE_WIDTH - 2 * RG.BORDER_SIZE) * S;
  const playH = (RG.TABLE_HEIGHT - 2 * RG.BORDER_SIZE) * S;
  const fullW = RG.TABLE_WIDTH * S;
  const fullH = RG.TABLE_HEIGHT * S;

  // Felt (roughness 0.85, metallic 0). The cloth uses a baked texture so the
  // Pool Dawgs dawg-head watermark shows like a real table stencil — the same
  // /assets/watermark.svg the 2D canvas inks onto its cloth.
  const cloth = MeshBuilder.CreateGround("cloth", { width: playW, height: playH }, scene);
  const feltMat = new PBRMaterial("feltMat", scene);
  feltMat.metallic = 0;
  feltMat.roughness = 0.85;
  const feltTex = new DynamicTexture("feltTex", { width: 1024, height: 512 }, scene, true);
  const fctx = feltTex.getContext() as unknown as CanvasRenderingContext2D;
  const paintFelt = () => {
    // Tournament cloth: a vivid green with a soft radial vignette (brighter
    // under the lights, deeper at the cushions) plus a faint woven nap so it
    // reads as real felt rather than a flat fill.
    const g = fctx.createRadialGradient(512, 256, 110, 512, 256, 660);
    g.addColorStop(0, "#23c184");
    g.addColorStop(0.65, "#159f6a");
    g.addColorStop(1, "#0a6442");
    fctx.fillStyle = g;
    fctx.fillRect(0, 0, 1024, 512);
    // Woven nap — fine threads in both directions, very faint.
    fctx.save();
    fctx.globalAlpha = 0.05;
    fctx.strokeStyle = "#063e29";
    for (let y = 0; y < 512; y += 3) {
      fctx.beginPath();
      fctx.moveTo(0, y);
      fctx.lineTo(1024, y);
      fctx.stroke();
    }
    fctx.globalAlpha = 0.03;
    for (let x = 0; x < 1024; x += 3) {
      fctx.beginPath();
      fctx.moveTo(x, 0);
      fctx.lineTo(x, 512);
      fctx.stroke();
    }
    fctx.restore();
  };
  paintFelt();
  feltTex.update();
  feltMat.albedoTexture = feltTex;
  cloth.material = feltMat;
  cloth.receiveShadows = true;
  cloth.position.y = 0;
  if (typeof window !== "undefined") {
    const img = new Image();
    img.onload = () => {
      paintFelt();
      fctx.save();
      fctx.globalAlpha = 0.16; // faint, like a stencilled crest
      const w = 380;
      const h = w * (img.naturalHeight / img.naturalWidth || 0.6);
      fctx.drawImage(img, (1024 - w) / 2, (512 - h) / 2, w, h);
      fctx.restore();
      feltTex.update();
    };
    img.src = "/assets/watermark.svg";
  }

  // Polished mahogany frame (lacquered: clearcoat over a deep red-brown), below
  // the cloth and apron of the table.
  const frame = MeshBuilder.CreateBox("frame", { width: fullW + 0.1, height: 0.14, depth: fullH + 0.1 }, scene);
  frame.position.y = -0.08;
  const woodMat = new PBRMaterial("woodMat", scene);
  woodMat.albedoColor = Color3.FromHexString("#3a1c10");
  woodMat.metallic = 0.12;
  woodMat.roughness = 0.32;
  woodMat.clearCoat.isEnabled = true;
  woodMat.clearCoat.intensity = 0.5;
  woodMat.clearCoat.roughness = 0.25;
  frame.material = woodMat;
  frame.receiveShadows = true;

  // Lacquered mahogany rails + gold trim caps.
  const railMat = new PBRMaterial("railMat", scene);
  railMat.albedoColor = Color3.FromHexString("#4a2415");
  railMat.metallic = 0.12;
  railMat.roughness = 0.28;
  railMat.clearCoat.isEnabled = true;
  railMat.clearCoat.intensity = 0.6;
  railMat.clearCoat.roughness = 0.2;
  const goldMat = new PBRMaterial("goldMat", scene);
  goldMat.albedoColor = Color3.FromHexString("#e3c14e");
  goldMat.metallic = 1;
  goldMat.roughness = 0.18;
  goldMat.emissiveColor = Color3.FromHexString("#2e2208"); // reads gold without an HDRI

  const rt = RG.BORDER_SIZE * S * 0.8;
  // Cushion segments leave real openings at the pockets (cut at the corners and
  // split at the centre pockets), like an actual table — not one continuous box.
  const cr = RG.HOLE_RADIUS * S; // corner pocket radius (world)
  const mr = (RG.HOLES[4]?.radius ?? RG.HOLE_RADIUS) * S; // centre pocket radius
  const cg = cr * 1.5; // gap cut from each rail end (corner pocket)
  const mg = mr * 1.4; // half-gap at the centre pocket
  const halfW = fullW / 2;
  const halfH = fullH / 2;
  const makeRail = (cx: number, cz: number, w: number, d: number) => {
    const rail = MeshBuilder.CreateBox("rail", { width: w, height: 0.06, depth: d }, scene);
    rail.position.set(cx, 0.022, cz);
    rail.material = railMat;
    rail.receiveShadows = true;
    const lip = MeshBuilder.CreateBox("lip", { width: w * 0.99, height: 0.012, depth: d * 0.99 }, scene);
    lip.position.set(cx, 0.05, cz);
    lip.material = goldMat;
  };
  // Top & bottom long rails: two segments each (corner gaps + centre gap).
  const longSegLen = halfW - cg - mg; // length of each half-rail segment
  for (const z of [halfH - rt / 2, -halfH + rt / 2]) {
    makeRail(-(mg + longSegLen / 2), z, longSegLen, rt); // left half
    makeRail(mg + longSegLen / 2, z, longSegLen, rt); // right half
  }
  // Left & right short rails: single segment, cut at both corners.
  const shortLen = fullH - 2 * cg;
  for (const x of [halfW - rt / 2, -halfW + rt / 2]) {
    makeRail(x, 0, rt, shortLen);
  }

  // Diamond sights — the classic mother-of-pearl inlays on the rail caps that
  // signal a premium table. 6 along each long rail (3 either side of the centre
  // pocket), 3 along each short rail.
  const sightMat = new PBRMaterial("sightMat", scene);
  sightMat.albedoColor = Color3.FromHexString("#efe6cf");
  sightMat.metallic = 0.15;
  sightMat.roughness = 0.3;
  sightMat.clearCoat.isEnabled = true;
  sightMat.clearCoat.intensity = 0.7;
  const ds = Math.min(fullW, fullH) * 0.014;
  const placeDiamond = (px: number, pz: number) => {
    const dia = MeshBuilder.CreateBox("sight", { width: ds, height: 0.004, depth: ds }, scene);
    dia.position.set(px, 0.058, pz);
    dia.rotation.y = Math.PI / 4;
    dia.material = sightMat;
  };
  const longInsetZ = fullH / 2 - rt * 0.62;
  const shortInsetX = fullW / 2 - rt * 0.62;
  for (const fx of [-3 / 8, -2 / 8, -1 / 8, 1 / 8, 2 / 8, 3 / 8]) {
    placeDiamond(fullW * fx, longInsetZ);
    placeDiamond(fullW * fx, -longInsetZ);
  }
  for (const fz of [-1 / 4, 0, 1 / 4]) {
    placeDiamond(shortInsetX, fullH * fz);
    placeDiamond(-shortInsetX, fullH * fz);
  }

  // Pockets: a recessed dark throat with a leather liner and a gold trim ring —
  // a real cut opening in the cloth (now framed by the rail gaps), not a disc.
  const wellMat = new PBRMaterial("wellMat", scene);
  wellMat.albedoColor = new Color3(0.012, 0.012, 0.016);
  wellMat.metallic = 0;
  wellMat.roughness = 0.95;
  const leatherMat = new PBRMaterial("leatherMat", scene);
  leatherMat.albedoColor = Color3.FromHexString("#1c1208");
  leatherMat.metallic = 0;
  leatherMat.roughness = 0.6;
  leatherMat.clearCoat.isEnabled = true;
  leatherMat.clearCoat.intensity = 0.3;
  for (const hole of RG.HOLES) {
    const r = hole.radius * S;
    const hx = wx(hole.x);
    const hz = wz(hole.y);
    // Deep throat the ball drops into (well below the cloth).
    const well = MeshBuilder.CreateCylinder("well", { diameter: r * 1.9, height: 0.16, tessellation: 32 }, scene);
    well.position.set(hx, -0.07, hz);
    well.material = wellMat;
    // Dark mouth flush with the cloth so the opening reads as cut into the felt.
    const mouth = MeshBuilder.CreateCylinder("mouth", { diameter: r * 2, height: 0.008, tessellation: 32 }, scene);
    mouth.position.set(hx, 0.005, hz);
    mouth.material = wellMat;
    // Leather pocket liner around the mouth.
    const liner = MeshBuilder.CreateTorus("liner", { diameter: r * 2.16, thickness: r * 0.42, tessellation: 32 }, scene);
    liner.position.set(hx, 0.016, hz);
    liner.material = leatherMat;
    // Thin gold trim ring (luxury accent).
    const ring = MeshBuilder.CreateTorus("ring", { diameter: r * 2.4, thickness: r * 0.12, tessellation: 32 }, scene);
    ring.position.set(hx, 0.024, hz);
    ring.material = goldMat;
  }
}
