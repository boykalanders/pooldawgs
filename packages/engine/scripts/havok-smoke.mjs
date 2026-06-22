// De-risk: does Havok's WASM init + step physics headless in Node here?
// A sphere dropped onto a static ground should fall and come to rest near y=r.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import HavokPhysics from "@babylonjs/havok";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Scene } from "@babylonjs/core/scene.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { CreateGround } from "@babylonjs/core/Meshes/Builders/groundBuilder.js";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder.js";
import { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
import { PhysicsShapeType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";

const t0 = Date.now();
// Node's fetch can't load file:// — hand Havok the wasm bytes directly.
const require = createRequire(import.meta.url);
const wasmPath = join(dirname(require.resolve("@babylonjs/havok")), "HavokPhysics.wasm");
const havok = await HavokPhysics({ wasmBinary: readFileSync(wasmPath) });
console.log(`Havok WASM loaded in ${Date.now() - t0}ms`);

const engine = new NullEngine();
const scene = new Scene(engine);
const plugin = new HavokPlugin(true, havok);
console.log("plugin.isSupported:", plugin.isSupported?.());
const enabled = scene.enablePhysics(new Vector3(0, -9.81, 0), plugin);
console.log("enablePhysics returned:", enabled, "engine:", !!scene.getPhysicsEngine());

const ground = CreateGround("g", { width: 10, height: 10 }, scene);
new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

const ball = CreateSphere("b", { diameter: 0.1 }, scene);
ball.position = new Vector3(0, 2, 0);
const agg = new PhysicsAggregate(ball, PhysicsShapeType.SPHERE, { mass: 0.17, restitution: 0.5 }, scene);

const dt = 1 / 120;
const physicsEngine = scene.getPhysicsEngine();
for (let i = 0; i < 600; i++) physicsEngine._step(dt);

const y = ball.position.y;
console.log(`ball rest y=${y.toFixed(4)} (expect ~0.05)`);
const ok = y > 0.02 && y < 0.12;
console.log(ok ? "\n✓ HAVOK HEADLESS WORKS IN NODE" : "\n✗ unexpected rest position");
process.exit(ok ? 0 : 1);
