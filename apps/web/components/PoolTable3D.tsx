"use client";

import { useEffect, useRef } from "react";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math.js";
import { Quaternion } from "@babylonjs/core/Maths/math.vector.js";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder.js";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial.js";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture.js";
import { PointerEventTypes } from "@babylonjs/core/Events/pointerEvents.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import "@babylonjs/core/Rendering/edgesRenderer.js";
import {
  TABLE_WIDTH,
  TABLE_HEIGHT,
  BORDER_SIZE,
  HOLES,
  PX_PER_M,
  BALL_RADIUS,
  STEP_MS,
  type Frame,
  type TableState,
} from "@pooldawgs/engine";
import { ballStyle, type BallLike } from "@/lib/balls";

// px → metres, world origin at table centre (X length, Z width, Y up).
const S = 1 / PX_PER_M;
const wx = (px: number) => (px - TABLE_WIDTH / 2) * S;
const wz = (py: number) => (TABLE_HEIGHT / 2 - py) * S;
const R = BALL_RADIUS * S;

const SOLID = "#f5efe0";

export interface ShotPlayback {
  frames: Frame[];
  /** sim steps between recorded frames (frame dt = stride × STEP_MS). */
  stride: number;
  key: string;
}

interface PoolTable3DProps {
  state: TableState;
  playback?: ShotPlayback | null;
  /** Aim direction preview (radians, table plane) and charge 0..1. */
  aimAngle: number;
  power01: number;
  showAim: boolean;
  onPlaybackEnd?: () => void;
  /** Reports the aim angle (engine px convention) as the pointer moves. */
  onAim?: (angle: number) => void;
}

/** world (x,z) → engine px (x,y). */
const pxX = (worldX: number) => worldX / S + TABLE_WIDTH / 2;
const pxY = (worldZ: number) => TABLE_HEIGHT / 2 - worldZ / S;

/** 3D pool table rendered with Babylon. It does NOT simulate — it replays the
 *  authoritative shot frames the engine (Havok) produced, so the visuals and
 *  the wagered outcome always agree. */
export default function PoolTable3D({
  state,
  playback,
  aimAngle,
  power01,
  showAim,
  onPlaybackEnd,
  onAim,
}: PoolTable3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const apiRef = useRef<{
    balls: Mesh[];
    cue: Mesh;
    aimLine: Mesh;
    setBallPositions: (s: TableState) => void;
  } | null>(null);
  const propsRef = useRef({ state, playback, aimAngle, power01, showAim, onPlaybackEnd, onAim });
  propsRef.current = { state, playback, aimAngle, power01, showAim, onPlaybackEnd, onAim };
  const playing = useRef<{ key: string; startedAt: number; frameMs: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene = new Scene(engine);
    scene.clearColor = new Color4(0.04, 0.03, 0.02, 1);

    // Camera: steep 3/4 top-down (design CAMERA_ANGLE ~85°), centred on the table.
    const cam = new ArcRotateCamera("cam", -Math.PI / 2, 0.42, M(2.4), Vector3.Zero(), scene);
    cam.lowerBetaLimit = 0.05;
    cam.upperBetaLimit = 1.1;
    cam.lowerRadiusLimit = M(1.6);
    cam.upperRadiusLimit = M(4);
    cam.attachControl(canvas, true);
    cam.wheelPrecision = 40;

    const hemi = new HemisphericLight("h", new Vector3(0, 1, 0), scene);
    hemi.intensity = 1.05;
    hemi.groundColor = new Color3(0.12, 0.18, 0.14);
    const dir = new DirectionalLight("d", new Vector3(-0.4, -1, 0.3), scene);
    dir.position = new Vector3(0.5, 2, -0.5);
    dir.intensity = 1.0;

    buildTable(scene);

    // Balls (max 22 across variants); shown/hidden per state.
    const balls: Mesh[] = [];
    for (let i = 0; i < 22; i++) {
      const b = MeshBuilder.CreateSphere(`ball${i}`, { diameter: R * 2, segments: 24 }, scene);
      b.position.y = R;
      b.isVisible = false;
      balls.push(b);
    }
    const cue = balls[balls.length - 1];

    // Aim line (thin emerald guide from the cue ball).
    const aimLine = MeshBuilder.CreateBox("aim", { width: M(1.6), height: 0.002, depth: 0.006 }, scene);
    const aimMat = new StandardMaterial("aimMat", scene);
    aimMat.emissiveColor = new Color3(0.9, 0.95, 0.85);
    aimMat.disableLighting = true;
    aimLine.material = aimMat;
    aimLine.isVisible = false;

    const ballMeshFor = (id: number) => balls[id];

    function setBallPositions(s: TableState) {
      for (const ball of s.balls) {
        const m = ballMeshFor(ball.id);
        if (!m) continue;
        styleBall(m, ball, scene);
        if (ball.inHole) {
          m.isVisible = false;
        } else {
          m.isVisible = true;
          m.position.set(wx(ball.x), R, wz(ball.y));
        }
      }
    }

    apiRef.current = { balls, cue, aimLine, setBallPositions };
    setBallPositions(state);

    // Aim by pointing at the cloth: raycast to the cloth, report the angle
    // from the cue ball to the picked point (engine px convention).
    scene.onPointerObservable.add((pi) => {
      if (pi.type !== PointerEventTypes.POINTERMOVE || playing.current) return;
      const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.name === "cloth");
      if (!pick?.hit || !pick.pickedPoint) return;
      const s = propsRef.current.state;
      const cb = s.balls[s.balls.length - 1];
      if (!cb || cb.inHole) return;
      const px = pxX(pick.pickedPoint.x);
      const py = pxY(pick.pickedPoint.z);
      propsRef.current.onAim?.(Math.atan2(py - cb.y, px - cb.x));
    });

    engine.runRenderLoop(() => {
      const { state: s, playback: pb, aimAngle: aim, power01: pw, showAim: sa, onPlaybackEnd: end } =
        propsRef.current;

      // Start / advance shot playback.
      if (pb && playing.current?.key !== pb.key) {
        playing.current = { key: pb.key, startedAt: performance.now(), frameMs: pb.stride * STEP_MS };
        aimLine.isVisible = false;
      }
      if (playing.current && pb) {
        const idx = Math.floor((performance.now() - playing.current.startedAt) / playing.current.frameMs);
        if (idx >= pb.frames.length - 1) {
          // Land on the authoritative final state and finish.
          applyFrame(balls, pb.frames[pb.frames.length - 1], scene, s.balls);
          playing.current = null;
          end?.();
        } else {
          applyFrame(balls, pb.frames[idx], scene, s.balls);
        }
      } else {
        // Idle: show the resting state + the aim guide.
        setBallPositions(s);
        const cb = s.balls[s.balls.length - 1];
        if (sa && cb && !cb.inHole && !s.gameOver) {
          aimLine.isVisible = true;
          const len = M(0.5 + pw * 1.2);
          aimLine.scaling.x = len / M(1.6);
          const cx = wx(cb.x);
          const cz = wz(cb.y);
          aimLine.position.set(cx + Math.cos(aim) * len * 0.5, R, cz - Math.sin(aim) * len * 0.5);
          aimLine.rotation.y = aim;
        } else {
          aimLine.isVisible = false;
        }
      }
      scene.render();
    });

    const onResize = () => engine.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      engine.dispose();
      apiRef.current = null;
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

// metres helper for inside-module literals
function M(px: number): number {
  // here px is already in metres for camera literals — identity passthrough
  return px;
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
    const nx = wx(fb.x);
    const nz = wz(fb.y);
    rollBall(m, nx, nz); // rotate by the distance travelled BEFORE moving
    m.position.set(nx, R, nz);
  }
}

/**
 * Roll the ball like a real one: rotate about the horizontal axis
 * perpendicular to its motion by angle = distance / radius (rolling without
 * slipping). Composes in world space so successive frames accumulate.
 */
function rollBall(mesh: Mesh, nx: number, nz: number): void {
  const dx = nx - mesh.position.x;
  const dz = nz - mesh.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-5 || dist > R * 6) return; // ignore teleports (re-rack/placement)
  // axis = up × dir = (0,1,0) × (dx,0,dz) = (dz, 0, -dx)
  const axis = new Vector3(dz / dist, 0, -dx / dist);
  const q = Quaternion.RotationAxis(axis, dist / R);
  mesh.rotationQuaternion = q.multiply(mesh.rotationQuaternion ?? Quaternion.Identity());
}

const styled = new WeakSet<Mesh>();
function styleBall(mesh: Mesh, ball: BallLike, scene: Scene): void {
  if (styled.has(mesh)) return;
  styled.add(mesh);
  if (!mesh.rotationQuaternion) mesh.rotationQuaternion = Quaternion.Identity();
  const id = ball.number;
  const style = ballStyle(ball);

  // Bake the ball's look INTO the sphere texture so the number/stripe rolls
  // with the ball (real tumbling) instead of sitting on a fixed top decal.
  // u = longitude (around), v = latitude (pole→pole).
  const tex = new DynamicTexture(`bt${id}_${Math.round(mesh.uniqueId)}`, { width: 256, height: 256 }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  const hue = style.color;

  if (style.kind === "cue") {
    ctx.fillStyle = SOLID;
    ctx.fillRect(0, 0, 256, 256);
    ctx.beginPath();
    ctx.arc(128, 128, 13, 0, Math.PI * 2);
    ctx.fillStyle = "#c0272d"; // the cue ball's red spot
    ctx.fill();
  } else if (style.kind === "stripe") {
    ctx.fillStyle = SOLID;
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = hue; // colour band around the middle latitudes
    ctx.fillRect(0, 86, 256, 84);
  } else {
    ctx.fillStyle = hue; // solid / eight / snooker colour
    ctx.fillRect(0, 0, 256, 256);
  }

  // Numbered balls: a white circle with the printed number near the top so
  // it's readable at rest and revolves as the ball rolls.
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

  const mat = new StandardMaterial(`bm${id}_${Math.round(mesh.uniqueId)}`, scene);
  mat.diffuseTexture = tex;
  mat.specularColor = new Color3(0.85, 0.85, 0.85);
  mat.specularPower = 80;
  mesh.material = mat;
}

function buildTable(scene: Scene): void {
  const playW = (TABLE_WIDTH - 2 * BORDER_SIZE) * S;
  const playH = (TABLE_HEIGHT - 2 * BORDER_SIZE) * S;
  const fullW = TABLE_WIDTH * S;
  const fullH = TABLE_HEIGHT * S;

  // Cloth.
  const cloth = MeshBuilder.CreateGround("cloth", { width: playW, height: playH }, scene);
  const clothMat = new StandardMaterial("clothMat", scene);
  clothMat.diffuseColor = Color3.FromHexString("#15795a");
  clothMat.emissiveColor = Color3.FromHexString("#062c1f"); // keeps it green in shadow
  clothMat.specularColor = new Color3(0.04, 0.08, 0.06);
  cloth.material = clothMat;
  cloth.position.y = 0;

  // Wooden frame — kept BELOW the cloth plane (top at -0.015) so it doesn't
  // z-fight with the green cloth at y=0 (which made the cloth read brown).
  const frame = MeshBuilder.CreateBox("frame", { width: fullW + 0.06, height: 0.09, depth: fullH + 0.06 }, scene);
  frame.position.y = -0.06;
  const woodMat = new StandardMaterial("woodMat", scene);
  woodMat.diffuseColor = Color3.FromHexString("#2a160c");
  woodMat.specularColor = new Color3(0.2, 0.15, 0.1);
  frame.material = woodMat;

  // Gold rails along the four sides (thin raised boxes).
  const railMat = new StandardMaterial("railMat", scene);
  railMat.diffuseColor = Color3.FromHexString("#3b2417");
  railMat.emissiveColor = Color3.FromHexString("#3a2c10");
  railMat.specularColor = Color3.FromHexString("#c9a227");
  railMat.specularPower = 32;
  const rt = BORDER_SIZE * S * 0.8;
  const rails: Array<[number, number, number, number]> = [
    [0, fullH / 2 - rt / 2, fullW, rt],
    [0, -fullH / 2 + rt / 2, fullW, rt],
    [fullW / 2 - rt / 2, 0, rt, fullH],
    [-fullW / 2 + rt / 2, 0, rt, fullH],
  ];
  for (const [x, z, w, d] of rails) {
    const rail = MeshBuilder.CreateBox("rail", { width: w, height: 0.05, depth: d }, scene);
    rail.position.set(x, 0.018, z);
    rail.material = railMat;
  }

  // Pockets (dark sunken cylinders) + gold rims.
  const holeMat = new StandardMaterial("holeMat", scene);
  holeMat.diffuseColor = new Color3(0.02, 0.02, 0.03);
  holeMat.specularColor = new Color3(0, 0, 0);
  const rimMat = new StandardMaterial("rimMat", scene);
  rimMat.emissiveColor = Color3.FromHexString("#7a5e16");
  for (const hole of HOLES) {
    const r = hole.radius * S * 0.9;
    const cyl = MeshBuilder.CreateCylinder("hole", { diameter: r * 2, height: 0.04, tessellation: 24 }, scene);
    cyl.position.set(wx(hole.x), 0.001, wz(hole.y));
    cyl.material = holeMat;
    const rim = MeshBuilder.CreateTorus("rim", { diameter: r * 2.1, thickness: r * 0.18, tessellation: 24 }, scene);
    rim.position.set(wx(hole.x), 0.012, wz(hole.y));
    rim.material = rimMat;
  }
}
