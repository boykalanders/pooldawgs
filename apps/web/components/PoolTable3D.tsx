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
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";

import {
  TABLE_WIDTH,
  TABLE_HEIGHT,
  BORDER_SIZE,
  HOLES,
  PX_PER_M,
  BALL_RADIUS,
  BALL_SIZE,
  MAX_POWER,
  STEP_MS,
  cloneState,
  cueBallId,
  isInsideHole,
  isOutsideBorder,
  simulateShot,
  type Frame,
  type ShotEvent,
  type ShotInput,
  type TableState,
} from "@pooldawgs/engine";
import { ballStyle, type BallLike } from "@/lib/balls";

// ── px (engine) ↔ metres (world), origin at table centre, Y up ─────────────
const S = 1 / PX_PER_M;
const wx = (px: number) => (px - TABLE_WIDTH / 2) * S;
const wz = (py: number) => (TABLE_HEIGHT / 2 - py) * S;
const pxX = (worldX: number) => worldX / S + TABLE_WIDTH / 2;
const pxY = (worldZ: number) => TABLE_HEIGHT / 2 - worldZ / S;
const R = BALL_RADIUS * S;

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
// Half-extents of the framed region (metres). Aspect-fit keeps the table fully
// visible at ~75% occupancy on both desktop and mobile-landscape.
const ORTHO_HALF_W = 1.62;
const ORTHO_HALF_H = 0.86;

// Re-export so callers (GameShell) can share one ShotAnimation type.
export interface ShotAnimation {
  fromState: TableState;
  shot: ShotInput;
  key: string;
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
}: PoolTable3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Aim target in engine px (where the cue is pointed). */
  const aimTarget = useRef({ x: TABLE_WIDTH * 0.7, y: TABLE_HEIGHT / 2 });
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

  // Start replay when a new animation arrives — simulate to frames once.
  useEffect(() => {
    if (!animation) return;
    if (playing.current?.key === animation.key) return;
    try {
      const r = simulateShot(cloneState(animation.fromState), animation.shot, {
        recordFrames: true,
        frameStride: FRAME_STRIDE,
      });
      playing.current = {
        frames: r.frames ?? [],
        events: r.events,
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
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.03, 0.04, 0.035, 1);
    scene.ambientColor = new Color3(0.3, 0.34, 0.3);

    // ── Camera: orthographic, fixed (Golden Spec) ──
    const cam = new ArcRotateCamera("cam", CAM_ALPHA, CAM_BETA, CAM_RADIUS, new Vector3(0, 0, 0), scene);
    cam.mode = Camera.ORTHOGRAPHIC_CAMERA;
    cam.minZ = 0.1;
    cam.maxZ = 100;
    // Fixed during gameplay — no orbit (premium feel). (No attachControl.)
    const applyOrtho = () => {
      const aspect = (canvas.clientWidth || 16) / (canvas.clientHeight || 9);
      let halfW = ORTHO_HALF_W;
      let halfH = ORTHO_HALF_H;
      if (aspect > ORTHO_HALF_W / ORTHO_HALF_H) halfW = halfH * aspect;
      else halfH = halfW / aspect;
      cam.orthoLeft = -halfW;
      cam.orthoRight = halfW;
      cam.orthoTop = halfH;
      cam.orthoBottom = -halfH;
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

    const shadow = new ShadowGenerator(1024, dir);
    shadow.usePercentageCloserFiltering = true;
    shadow.blurScale = 2;

    buildTable(scene);

    // ── Balls ──
    const balls: Mesh[] = [];
    for (let i = 0; i < 22; i++) {
      const b = MeshBuilder.CreateSphere(`ball${i}`, { diameter: R * 2, segments: 32 }, scene);
      b.position.y = R;
      b.isVisible = false;
      b.receiveShadows = false;
      shadow.addShadowCaster(b);
      balls.push(b);
    }
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
    shadow.addShadowCaster(stick);
    const stickMat = new PBRMaterial("stickMat", scene);
    stickMat.albedoColor = Color3.FromHexString("#1a120b");
    stickMat.metallic = 0.2;
    stickMat.roughness = 0.4;
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

    let raf = 0;
    engine.runRenderLoop(() => {
      applyOrtho(); // keep the table framed even before ResizeObserver settles
      const p = propsRef.current;
      const now = performance.now();

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
          else if (e.type === "pocket") playSound("/assets/sounds/hole.wav", 0.5, p.muted);
          else if (e.type === "cushion") playSound("/assets/sounds/side.wav", 0.15, p.muted);
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
    if (Math.hypot(x - ball.x, y - ball.y) < BALL_SIZE) return true;
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

function buildTable(scene: Scene): void {
  const playW = (TABLE_WIDTH - 2 * BORDER_SIZE) * S;
  const playH = (TABLE_HEIGHT - 2 * BORDER_SIZE) * S;
  const fullW = TABLE_WIDTH * S;
  const fullH = TABLE_HEIGHT * S;

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
    fctx.fillStyle = "#1a9d68";
    fctx.fillRect(0, 0, 1024, 512);
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

  // Wood frame (metallic 0.10, roughness 0.35), kept below the cloth.
  const frame = MeshBuilder.CreateBox("frame", { width: fullW + 0.08, height: 0.12, depth: fullH + 0.08 }, scene);
  frame.position.y = -0.07;
  const woodMat = new PBRMaterial("woodMat", scene);
  woodMat.albedoColor = Color3.FromHexString("#2a160c");
  woodMat.metallic = 0.1;
  woodMat.roughness = 0.35;
  frame.material = woodMat;
  frame.receiveShadows = true;

  // Wood rails (raised) + gold trim caps.
  const railMat = new PBRMaterial("railMat", scene);
  railMat.albedoColor = Color3.FromHexString("#3a2412");
  railMat.metallic = 0.1;
  railMat.roughness = 0.35;
  const goldMat = new PBRMaterial("goldMat", scene);
  goldMat.albedoColor = Color3.FromHexString("#d6af3a");
  goldMat.metallic = 1;
  goldMat.roughness = 0.2;
  goldMat.emissiveColor = Color3.FromHexString("#2e2208"); // reads gold without an HDRI

  const rt = BORDER_SIZE * S * 0.8;
  const rails: Array<[number, number, number, number]> = [
    [0, fullH / 2 - rt / 2, fullW, rt],
    [0, -fullH / 2 + rt / 2, fullW, rt],
    [fullW / 2 - rt / 2, 0, rt, fullH],
    [-fullW / 2 + rt / 2, 0, rt, fullH],
  ];
  for (const [x, z, w, d] of rails) {
    const rail = MeshBuilder.CreateBox("rail", { width: w, height: 0.06, depth: d }, scene);
    rail.position.set(x, 0.022, z);
    rail.material = railMat;
    rail.receiveShadows = true;
    // Thin gold inner lip.
    const lip = MeshBuilder.CreateBox("lip", { width: w * 0.99, height: 0.012, depth: d * 0.99 }, scene);
    lip.position.set(x, 0.05, z);
    lip.material = goldMat;
  }

  // Pockets: dark wells + gold rims.
  const holeMat = new PBRMaterial("holeMat", scene);
  holeMat.albedoColor = new Color3(0.02, 0.02, 0.03);
  holeMat.metallic = 0;
  holeMat.roughness = 0.9;
  for (const hole of HOLES) {
    const r = hole.radius * S * 0.92;
    const cyl = MeshBuilder.CreateCylinder("hole", { diameter: r * 2, height: 0.05, tessellation: 28 }, scene);
    cyl.position.set(wx(hole.x), 0.002, wz(hole.y));
    cyl.material = holeMat;
    const rim = MeshBuilder.CreateTorus("rim", { diameter: r * 2.05, thickness: r * 0.16, tessellation: 28 }, scene);
    rim.position.set(wx(hole.x), 0.03, wz(hole.y));
    rim.material = goldMat;
  }
}
