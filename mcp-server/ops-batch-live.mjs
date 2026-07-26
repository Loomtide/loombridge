// Live ops.batch test using the real UnityClient (auto-discovers the working IPC transport).
import { UnityClient } from "./dist/bridge/unity-client.js";

const client = new UnityClient();
const T = 30000;
const show = (label, resp) => {
  console.log(`\n=== ${label} ===`);
  console.log("status:", resp.status, resp.error ? `error=${JSON.stringify(resp.error)}` : "");
  console.log(JSON.stringify(resp.data, null, 2));
};

async function main() {
  const hs = await client.connect();
  console.log("CONNECTED sessionId=", hs.sessionId);

  // 1) One batch creates 3 objects (one round-trip).
  show("BATCH create x3", await client.send("ops.batch", {
    undoGroupName: "Batch Create",
    operations: [
      { command: "scene.create_object", params: { name: "BatchA" } },
      { command: "scene.create_object", params: { name: "BatchB" } },
      { command: "scene.create_object", params: { name: "BatchC" } },
    ],
  }, T));

  // 2) One batch sets transforms on all three.
  show("BATCH set_transform x3", await client.send("ops.batch", {
    undoGroupName: "Batch Transforms",
    operations: [
      { command: "scene.set_transform", params: { locator: { path: "/BatchA" }, position: { x: -2, y: 0, z: 0 } } },
      { command: "scene.set_transform", params: { locator: { path: "/BatchB" }, position: { x: 0, y: 1, z: 0 } } },
      { command: "scene.set_transform", params: { locator: { path: "/BatchC" }, position: { x: 2, y: 0, z: 0 } } },
    ],
  }, T));

  // 3) Bad batch with stopOnError:false — proves per-op error reporting + continuation.
  show("BATCH with errors (stopOnError:false)", await client.send("ops.batch", {
    stopOnError: false,
    operations: [
      { command: "scene.create_object", params: { name: "BatchGood" } },
      { command: "scene.bogus_op", params: {} },
      { command: "totally.unknown_category", params: {} },
      { command: "scene.create_object", params: { name: "BatchGood2" } },
    ],
  }, T));

  // 4) Confirm the objects actually exist in the scene.
  show("HIERARCHY (depth 1)", await client.send("scene.get_hierarchy", { depth: 1 }, T));

  process.exit(0);
}
main().catch((e) => { console.error("HARNESS FAIL:", e?.message ?? e); process.exit(1); });
