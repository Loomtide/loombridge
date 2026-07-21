#!/usr/bin/env node
/**
 * Fix jump: push PlayerController via MCP bridge, wait for recompile, test jump.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "..");
const requireFromMcp = createRequire(resolve(MCP_SERVER_DIR, "package.json"));

const PLAYER_CONTROLLER = `using UnityEngine;

#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

public class PlayerController : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float moveSpeed = 6f;
    [SerializeField] private float jumpSpeed = 12f;

    [Header("Ground Check")]
    [SerializeField] private float groundCheckDistance = 0.15f;
    [SerializeField] private LayerMask groundLayers = ~0;

    [Header("Detection")]
    [SerializeField] private string enemyNamePrefix = "Enemy";
    [SerializeField] private string coinNamePrefix = "Coin";

    [Header("References")]
    public GameManager gameManager;

    // Set via unity_component_set_property to trigger jump without input
    public bool forceJump;

    private Rigidbody2D rb;
    private Collider2D col;
    private Vector3 spawnPoint;
    private float _horizontal;
    private bool _jumpQueued;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
        col = GetComponent<Collider2D>();
    }

    private void Start()
    {
        spawnPoint = transform.position;
        if (gameManager == null)
            gameManager = GameManager.Instance;

        if (UnityEngine.EventSystems.EventSystem.current != null)
            UnityEngine.EventSystems.EventSystem.current.SetSelectedGameObject(null);
    }

    private void Update()
    {
        _horizontal = ReadHorizontal();
        bool jumpPressed = ReadJumpPressed();

        // forceJump bypass for MCP testing
        if (forceJump)
        {
            jumpPressed = true;
            forceJump = false;
        }

        if (Mathf.Abs(_horizontal) > 0.01f || jumpPressed)
        {
            Debug.Log($"[Player] h={_horizontal:F2} jump={jumpPressed} grounded={IsGrounded()} vel={ReadVelocity()} pos={transform.position}");
        }

        if (jumpPressed)
        {
            _jumpQueued = true;
        }
    }

    private void FixedUpdate()
    {
        Vector2 velocity = ReadVelocity();
        velocity.x = _horizontal * moveSpeed;

        if (_jumpQueued)
        {
            bool grounded = IsGrounded();
            Debug.Log($"[Player] FixedUpdate jumpQueued grounded={grounded} vel={velocity}");
            if (grounded)
            {
                velocity.y = jumpSpeed;
            }
        }
        _jumpQueued = false;

        WriteVelocity(velocity);
    }

    // Catch editor events (MCP EditorEvent mirror sends gameView.SendEvent)
    private void OnGUI()
    {
        Event e = Event.current;
        if (e != null && e.type == EventType.KeyDown && e.keyCode == KeyCode.Space)
        {
            _jumpQueued = true;
            Debug.Log("[Player] OnGUI Space KeyDown");
        }
    }

    private float ReadHorizontal()
    {
#if ENABLE_INPUT_SYSTEM
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            float input = 0f;
            if (kb.leftArrowKey.isPressed || kb.aKey.isPressed) input -= 1f;
            if (kb.rightArrowKey.isPressed || kb.dKey.isPressed) input += 1f;
            if (Mathf.Abs(input) > 0f) return input;
        }
#endif
        return Input.GetAxisRaw("Horizontal");
    }

    private bool ReadJumpPressed()
    {
        if (Input.GetButtonDown("Jump")) return true;

#if ENABLE_INPUT_SYSTEM
        // Check all keyboards (virtual + real) for space
        foreach (var kb in Keyboard.all)
        {
            if (kb.spaceKey.wasPressedThisFrame)
            {
                Debug.Log($"[Player] Space wasPressedThisFrame on {kb.name}");
                return true;
            }
            if (kb.spaceKey.isPressed)
            {
                Debug.Log($"[Player] Space isPressed on {kb.name}");
                return true;
            }
        }
#endif
        return false;
    }

    private bool IsGrounded()
    {
        if (col == null) return false;
        Vector2 origin = new Vector2(col.bounds.center.x, col.bounds.min.y - 0.01f);
        RaycastHit2D hit = Physics2D.Raycast(origin, Vector2.down, groundCheckDistance, groundLayers);
        return hit.collider != null;
    }

    private void OnCollisionEnter2D(Collision2D collision)
    {
        if (collision.gameObject.name.StartsWith(enemyNamePrefix))
        {
            if (gameManager != null) gameManager.PlayerDied();
            Respawn();
        }
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (other.gameObject.name.StartsWith(coinNamePrefix))
        {
            if (gameManager != null) gameManager.AddScore(1);
            Destroy(other.gameObject);
        }
    }

    public void Respawn()
    {
        transform.position = spawnPoint;
        WriteVelocity(Vector2.zero);
    }

    private Vector2 ReadVelocity()
    {
#if UNITY_6000_0_OR_NEWER
        return rb.linearVelocity;
#else
        return rb.velocity;
#endif
    }

    private void WriteVelocity(Vector2 value)
    {
#if UNITY_6000_0_OR_NEWER
        rb.linearVelocity = value;
#else
        rb.velocity = value;
#endif
    }
}`;

async function main() {
  const clientModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(clientModulePath), import(stdioModulePath),
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(MCP_SERVER_DIR, "dist/index.js")],
    cwd: MCP_SERVER_DIR,
  });
  const client = new Client({ name: "demo-fix-jump", version: "1.0" });
  await client.connect(transport);

  const loc = (path) => ({ path });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function call(tool, args = {}) {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result?.content?.[0]?.text;
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { parsed = text; } }
    if (result?.isError) {
      console.error(`  FAIL: ${tool} → ${text?.substring(0, 300)}`);
      throw new Error(`Tool ${tool} failed`);
    }
    return { raw: result, parsed, text };
  }

  try {
    console.log("=== Step 1: Connect and stop play mode ===");
    const state = await call("unity_editor_get_state");
    console.log("  State:", JSON.stringify(state.parsed));

    if (state.parsed?.play_mode !== "stopped") {
      await call("unity_editor_stop");
      await sleep(3000);
    }

    console.log("\n=== Step 2: Push PlayerController via bridge ===");
    try {
      await call("unity_code_modify_script", {
        path: "Assets/Scripts/PlayerController.cs",
        content: PLAYER_CONTROLLER,
      });
      console.log("  Script pushed.");
    } catch (e) {
      console.log(`  Script push: ${e.message} (may be normal during domain reload)`);
    }

    // Domain reload drops WS. Sleep long enough for Unity to recompile.
    console.log("  Sleeping 20s for domain reload...");
    await sleep(20000);

    // Try to reconnect and verify compilation is done
    for (let i = 0; i < 8; i++) {
      try {
        const st = await call("unity_editor_get_state");
        if (!st.parsed?.compiling) {
          console.log("  Compilation done. State:", JSON.stringify(st.parsed));
          break;
        }
        console.log("  Still compiling...");
      } catch (e) {
        console.log(`  Reconnect attempt ${i+1}: ${e.message?.substring(0, 80)}`);
      }
      await sleep(5000);
    }

    console.log("\n=== Step 3: Enter play mode ===");
    await call("unity_editor_clear_console");
    await call("unity_editor_play");
    await sleep(5000);
    for (let i = 0; i < 3; i++) {
      try {
        await call("unity_editor_wait_for", { playMode: "playing", timeoutMs: 20000 });
        break;
      } catch { await sleep(5000); }
    }
    console.log("  Playing.");

    // Wait for player to settle
    await call("unity_editor_wait_for", { frames: 120, timeoutMs: 15000 });

    const snap0 = await call("unity_runtime_get_snapshot", { locator: loc("/Player") });
    const pos0 = snap0.parsed?.transform?.position;
    console.log("  Player settled at:", JSON.stringify(pos0));

    console.log("\n=== Step 4: Test forceJump ===");
    await call("unity_input_begin_session", {});

    await call("unity_component_set_property", {
      locator: loc("/Player"),
      type_name: "PlayerController",
      property_path: "forceJump",
      value: true,
    });
    await call("unity_editor_wait_for", { frames: 10, timeoutMs: 10000 });

    const snap1 = await call("unity_runtime_get_snapshot", { locator: loc("/Player") });
    const pos1 = snap1.parsed?.transform?.position;
    const dy1 = (pos1?.y || 0) - (pos0?.y || 0);
    console.log(`  After forceJump: ${JSON.stringify(pos1)}  dy=${dy1.toFixed(4)}`);
    console.log(`  ${dy1 > 0.1 ? "✓ JUMP WORKS" : "✗ JUMP FAILED"}`);

    // Wait for landing
    await call("unity_editor_wait_for", { frames: 120, timeoutMs: 15000 });

    console.log("\n=== Step 5: Test Space key_down ===");
    const snap2 = await call("unity_runtime_get_snapshot", { locator: loc("/Player") });
    const pos2 = snap2.parsed?.transform?.position;
    console.log("  Before Space:", JSON.stringify(pos2));

    await call("unity_input_key_down", { key: "Space" });
    await call("unity_editor_wait_for", { frames: 6, timeoutMs: 5000 });
    await call("unity_input_key_up", { key: "Space" });
    await call("unity_editor_wait_for", { frames: 10, timeoutMs: 10000 });

    const snap3 = await call("unity_runtime_get_snapshot", { locator: loc("/Player") });
    const pos3 = snap3.parsed?.transform?.position;
    const dy3 = (pos3?.y || 0) - (pos2?.y || 0);
    console.log(`  After Space: ${JSON.stringify(pos3)}  dy=${dy3.toFixed(4)}`);
    console.log(`  ${dy3 > 0.1 ? "✓ SPACE JUMP WORKS" : "✗ SPACE JUMP FAILED"}`);

    console.log("\n=== Console Logs ===");
    const logs = await call("unity_editor_console_logs");
    if (logs.parsed?.logs) {
      const playerLogs = logs.parsed.logs.filter(l => l.message?.includes("[Player]"));
      console.log(`  ${playerLogs.length} [Player] logs:`);
      for (const l of playerLogs.slice(0, 25)) {
        console.log(`    ${l.message}`);
      }
    }

    await call("unity_input_end_session", {});
    await call("unity_editor_stop", {});
    console.log("\n=== DONE ===");

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
