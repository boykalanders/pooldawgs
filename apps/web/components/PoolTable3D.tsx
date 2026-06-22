"use client";

import { useEffect, useRef } from "react";
import { Engine } from "@babylonjs/core/Engines/engine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera.js";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight.js";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight.js";
import { Vector3, Color3, Color4 } from "@babylonjs/core/Maths/math.js";
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
const NUM_COLOR: Record<number, string> = {
  1: "#f0b90b", 2: "#1f4fd8", 3: "#d2122e", 4: "#6a2c91", 5: "#ef7d14",
  6: "#0f7a3d", 7: "#7a1f2b", 8: "#101014",
};

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
    m.position.set(wx(fb.x), R, wz(fb.y));
  }
}

const styled = new WeakSet<Mesh>();
function styleBall(mesh: Mesh, ball: BallLike, scene: Scene): void {
  if (styled.has(mesh)) return;
  styled.add(mesh);
  const id = ball.number;
  const style = ballStyle(ball);
  const mat = new StandardMaterial(`bm${id}`, scene);
  mat.specularColor = new Color3(0.9, 0.9, 0.9);
  mat.specularPower = 64;
  const base =
    style.number === null
      ? SOLID
      : style.kind === "stripe"
        ? SOLID
        : NUM_COLOR[style.number] ?? SOLID;
  mat.diffuseColor = Color3.FromHexString(base);
  mesh.material = mat;

  // Number / stripe decal on a top-facing disc so it reads from above.
  if (style.number !== null) {
    const disc = MeshBuilder.CreateDisc(`d${id}`, { radius: R * 0.95, tessellation: 24 }, scene);
    disc.parent = mesh;
    disc.rotation.x = Math.PI / 2; // face up
    disc.position.y = R * 0.96;
    const tex = new DynamicTexture(`t${id}`, { width: 128, height: 128 }, scene, false);
    const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
    const col = NUM_COLOR[style.number <= 8 ? style.number : style.number - 8] ?? "#888";
    ctx.fillStyle = style.kind === "stripe" ? "#f5efe0" : col;
    ctx.fillRect(0, 0, 128, 128);
    if (style.kind === "stripe") {
      ctx.fillStyle = col;
      ctx.fillRect(0, 36, 128, 56);
    }
    ctx.beginPath();
    ctx.arc(64, 64, 34, 0, Math.PI * 2);
    ctx.fillStyle = "#f5efe0";
    ctx.fill();
    ctx.fillStyle = "#16120e";
    ctx.font = "bold 52px Georgia";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(style.number), 64, 70);
    tex.update();
    const dmat = new StandardMaterial(`dm${id}`, scene);
    dmat.diffuseTexture = tex;
    dmat.emissiveColor = new Color3(0.25, 0.25, 0.25);
    dmat.specularColor = new Color3(0, 0, 0);
    disc.material = dmat;
  } else {
    // Cue ball: a small red spot on top.
    const spot = MeshBuilder.CreateDisc(`cs`, { radius: R * 0.22, tessellation: 16 }, scene);
    spot.parent = mesh;
    spot.rotation.x = Math.PI / 2;
    spot.position.y = R * 0.99;
    const sm = new StandardMaterial(`csm`, scene);
    sm.emissiveColor = new Color3(0.8, 0.1, 0.1);
    sm.disableLighting = true;
    spot.material = sm;
  }
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
