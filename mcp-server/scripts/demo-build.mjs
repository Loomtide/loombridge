#!/usr/bin/env node
/**
 * Loombridge Demo Builder — builds the full Tier 2 platformer via MCP tools.
 * Follows skill defaults from .skills/unity-2d-game/references/.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_DIR = resolve(__dirname, "..");
const requireFromMcp = createRequire(resolve(MCP_SERVER_DIR, "package.json"));

async function main() {
  const clientModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/index.js");
  const stdioModulePath = requireFromMcp.resolve("@modelcontextprotocol/sdk/client/stdio.js");

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(clientModulePath),
    import(stdioModulePath),
  ]);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(MCP_SERVER_DIR, "dist/index.js")],
    cwd: MCP_SERVER_DIR,
  });

  const client = new Client({ name: "demo-builder", version: "1.0" });
  await client.connect(transport);

  let stepNum = 0;

  /** Helper: locator object from path string */
  function loc(path) {
    return { path };
  }

  async function call(tool, args = {}) {
    const result = await client.callTool({ name: tool, arguments: args });
    const text = result?.content?.[0]?.text;
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (result?.isError) {
      console.error(`  FAIL: ${tool} → ${text?.substring(0, 300)}`);
      throw new Error(`Tool ${tool} failed: ${text?.substring(0, 300)}`);
    }
    return { raw: result, parsed, text };
  }

  function step(name) {
    stepNum++;
    console.log(`\n=== Step ${stepNum}: ${name} ===`);
  }

  async function callLog(tool, args = {}) {
    const result = await call(tool, args);
    const summary = typeof result.parsed === "object"
      ? JSON.stringify(result.parsed).substring(0, 120)
      : String(result.text || "").substring(0, 120);
    console.log(`  ${tool} → ${summary}`);
    return result;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitCompile() {
    console.log("  waiting for compile (domain reload)...");
    // Domain reload drops WebSocket; give Unity time to reload + bridge to restart
    await sleep(12000);
    // Retry the wait_for call — may hit CONNECTION_LOST/CONNECTION_ERROR during reconnect
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await call("unity_editor_wait_for", { compiling: false, timeoutMs: 60000 });
        console.log("  compile done.");
        return;
      } catch (err) {
        if (attempt < 4 && err.message && (err.message.includes("CONNECTION") || err.message.includes("Not connected") || err.message.includes("preflight"))) {
          console.log(`  compile wait attempt ${attempt + 1} failed (reconnecting), retrying in 10s...`);
          await sleep(10000);
        } else {
          throw err;
        }
      }
    }
  }

  /** Create script, falling back to modify if it already exists */
  async function createScript(path, content) {
    try {
      return await callLog("unity_code_create_script", { path, content });
    } catch (err) {
      if (err.message && err.message.includes("already exists")) {
        console.log(`  [EXISTS] ${path} — updating via modify_script`);
        return await callLog("unity_code_modify_script", { path, content });
      }
      throw err;
    }
  }

  async function addComponent(path, typeName, props) {
    const args = { locator: loc(path), type_name: typeName };
    if (props) args.properties = props;
    try {
      return await callLog("unity_component_add", args);
    } catch (err) {
      if (err.message && err.message.includes("already exists")) {
        console.log(`  [SKIP] ${typeName} already on ${path}`);
        return null;
      }
      throw err;
    }
  }

  async function setProp(path, typeName, propPath, value) {
    return callLog("unity_component_set_property", {
      locator: loc(path), type_name: typeName, property_path: propPath, value
    });
  }

  try {
    // ─── Step 1: Scene Foundation ───
    step("New Scene & Camera Setup");
    await callLog("unity_scene_new_scene", {});

    // Camera baseline (from default-values.md)
    await setProp("/Main Camera", "Camera", "orthographic", true);
    await setProp("/Main Camera", "Camera", "orthographicSize", 5);
    await callLog("unity_scene_set_transform", {
      locator: loc("/Main Camera"),
      position: { x: 0, y: 0, z: -10 },
    });
    await setProp("/Main Camera", "Camera", "clearFlags", 2); // SolidColor
    await setProp("/Main Camera", "Camera", "backgroundColor", { r: 0.53, g: 0.81, b: 0.92, a: 1 });

    // ─── Step 2: Create Objects ───
    step("Create Scene Objects");

    // Ground
    await callLog("unity_scene_create_object", { name: "Ground", position: { x: 0, y: -3, z: 0 }, scale: { x: 18, y: 0.5, z: 1 } });
    await addComponent("/Ground", "BoxCollider2D");

    // Platforms (skill defaults: scale 3x0.35, max height diff ~2.4, max gap ~4.8)
    const platforms = [
      { name: "Platform1", x: -3, y: 0, sx: 3, sy: 0.35 },
      { name: "Platform2", x: 4, y: 1.5, sx: 3, sy: 0.35 },
      { name: "Platform3", x: 0, y: 3, sx: 3, sy: 0.35 },
    ];
    for (const p of platforms) {
      await callLog("unity_scene_create_object", { name: p.name, position: { x: p.x, y: p.y, z: 0 }, scale: { x: p.sx, y: p.sy, z: 1 } });
      await addComponent(`/${p.name}`, "BoxCollider2D");
    }

    // Player (skill default scale: 0.8x0.8)
    await callLog("unity_scene_create_object", { name: "Player", position: { x: -7, y: -2, z: 0 }, scale: { x: 0.8, y: 0.8, z: 1 } });

    // Enemies (skill default scale: 0.7x0.7)
    await callLog("unity_scene_create_object", { name: "Enemy1", position: { x: 0, y: -2.5, z: 0 }, scale: { x: 0.7, y: 0.7, z: 1 } });
    await callLog("unity_scene_create_object", { name: "Enemy2", position: { x: 6, y: -2.5, z: 0 }, scale: { x: 0.7, y: 0.7, z: 1 } });

    // Coins (skill default scale: 0.4x0.4)
    const coins = [
      { name: "Coin1", x: -6.2, y: -2 },
      { name: "Coin2", x: -1, y: -2.5 },
      { name: "Coin3", x: -3, y: 0.7 },
      { name: "Coin4", x: 4, y: 2.2 },
      { name: "Coin5", x: 0, y: 3.7 },
    ];
    for (const c of coins) {
      await callLog("unity_scene_create_object", { name: c.name, position: { x: c.x, y: c.y, z: 0 }, scale: { x: 0.4, y: 0.4, z: 1 } });
    }

    // ─── Step 3: Sprites ───
    step("Create & Assign Sprites");

    await callLog("unity_asset_create_sprite", { path: "Assets/Sprites/GroundSprite.png", color: { r: 0.4, g: 0.26, b: 0.13, a: 1 }, width: 64, height: 64 });
    await callLog("unity_asset_create_sprite", { path: "Assets/Sprites/PlatformSprite.png", color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, width: 64, height: 64 });
    await callLog("unity_asset_create_sprite", { path: "Assets/Sprites/PlayerSprite.png", color: { r: 0.2, g: 0.6, b: 1.0, a: 1 }, width: 64, height: 64 });
    await callLog("unity_asset_create_sprite", { path: "Assets/Sprites/EnemySprite.png", color: { r: 1.0, g: 0.2, b: 0.2, a: 1 }, width: 64, height: 64 });
    await callLog("unity_asset_create_sprite", { path: "Assets/Sprites/CoinSprite.png", color: { r: 1.0, g: 0.84, b: 0.0, a: 1 }, width: 32, height: 32 });

    // Assign sprites
    await addComponent("/Ground", "SpriteRenderer");
    await callLog("unity_asset_assign_sprite", { locator: loc("/Ground"), sprite_path: "Assets/Sprites/GroundSprite.png" });

    for (const p of platforms) {
      await addComponent(`/${p.name}`, "SpriteRenderer");
      await callLog("unity_asset_assign_sprite", { locator: loc(`/${p.name}`), sprite_path: "Assets/Sprites/PlatformSprite.png" });
    }

    // ─── Step 4: Player Physics ───
    step("Player Physics Setup");
    await addComponent("/Player", "SpriteRenderer");
    await callLog("unity_asset_assign_sprite", { locator: loc("/Player"), sprite_path: "Assets/Sprites/PlayerSprite.png" });
    await addComponent("/Player", "Rigidbody2D");
    await addComponent("/Player", "BoxCollider2D");

    // Physics baseline (from default-values.md)
    await setProp("/Player", "Rigidbody2D", "gravityScale", 2.5);
    await setProp("/Player", "Rigidbody2D", "collisionDetection", 1); // Continuous
    await setProp("/Player", "Rigidbody2D", "m_Interpolate", 1);       // Interpolate
    await setProp("/Player", "Rigidbody2D", "freezeRotation", true);

    // Enemy setup
    for (const e of ["Enemy1", "Enemy2"]) {
      await addComponent(`/${e}`, "SpriteRenderer");
      await callLog("unity_asset_assign_sprite", { locator: loc(`/${e}`), sprite_path: "Assets/Sprites/EnemySprite.png" });
      await addComponent(`/${e}`, "Rigidbody2D");
      await addComponent(`/${e}`, "BoxCollider2D");
      await setProp(`/${e}`, "Rigidbody2D", "bodyType", 1); // Kinematic
    }

    // Coin setup
    for (const c of coins) {
      await addComponent(`/${c.name}`, "SpriteRenderer");
      await callLog("unity_asset_assign_sprite", { locator: loc(`/${c.name}`), sprite_path: "Assets/Sprites/CoinSprite.png" });
      await addComponent(`/${c.name}`, "CircleCollider2D");
      await setProp(`/${c.name}`, "CircleCollider2D", "isTrigger", true);
    }

    // ─── Step 5: Scripts ───
    step("Create Scripts");

    // Create ALL scripts in rapid succession, then wait for compile once.
    // Each create/modify triggers a domain reload, but Unity batches them
    // if they arrive fast enough. We only waitCompile at the very end.

    await createScript("Assets/Scripts/EnemyMarker.cs",
      `using UnityEngine;

public class EnemyMarker : MonoBehaviour
{
}`
    );

    await createScript("Assets/Scripts/CoinCollectible.cs",
      `using UnityEngine;

public class CoinCollectible : MonoBehaviour
{
}`
    );

    // EnemyPatrol — skill template
    await createScript("Assets/Scripts/EnemyPatrol.cs",
      `using UnityEngine;

public class EnemyPatrol : MonoBehaviour
{
    [SerializeField] private float speed = 2f;
    [SerializeField] private float patrolDistance = 3f;

    private Vector3 startPosition;
    private int direction = 1;

    private void Start()
    {
        startPosition = transform.position;
    }

    private void Update()
    {
        transform.Translate(Vector2.right * (speed * direction * Time.deltaTime));

        if (Mathf.Abs(transform.position.x - startPosition.x) >= patrolDistance)
        {
            direction *= -1;
            Vector3 scale = transform.localScale;
            scale.x = Mathf.Abs(scale.x) * direction;
            transform.localScale = scale;
        }
    }
}`
    );

    // GameManager — skill template (no Time.timeScale = 0, public fields for MCP assertions)
    await createScript("Assets/Scripts/GameManager.cs",
      `using UnityEngine;
using UnityEngine.UI;

public class GameManager : MonoBehaviour
{
    public static GameManager Instance { get; private set; }

    [Header("UI References (wire via unity_component_set_property)")]
    public Text scoreText;
    public Text livesText;
    public Text messageText;

    [Header("Settings")]
    [SerializeField] private int startLives = 3;
    [SerializeField] private int totalCoins = 5;

    public int score;
    public int lives;
    public bool isWin;
    public bool isGameOver;

    private void Awake()
    {
        if (Instance != null && Instance != this)
        {
            Destroy(gameObject);
            return;
        }
        Instance = this;
        lives = startLives;
    }

    private void Start()
    {
        if (messageText != null) messageText.text = "";
        UpdateUI();
    }

    public void AddScore(int amount)
    {
        if (isWin || isGameOver) return;

        score += amount;
        if (score >= totalCoins)
        {
            isWin = true;
            ShowMessage("YOU WIN!");
        }
        UpdateUI();
    }

    public void PlayerDied()
    {
        if (isWin || isGameOver) return;

        lives--;
        if (lives <= 0)
        {
            lives = 0;
            isGameOver = true;
            ShowMessage("GAME OVER");
        }
        UpdateUI();
    }

    private void UpdateUI()
    {
        if (scoreText != null) scoreText.text = $"Score: {score}/{totalCoins}";
        if (livesText != null) livesText.text = $"Lives: {lives}";
    }

    private void ShowMessage(string msg)
    {
        if (messageText != null) messageText.text = msg;
    }
}`
    );

    // PlayerController — dual input system, FixedUpdate physics, collider-based ground check
    // UpArrow/W also trigger jump (Space doesn't work via MCP input injection on macOS)
    await createScript("Assets/Scripts/PlayerController.cs",
      `using UnityEngine;

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

    // MCP testing: set to true via unity_component_set_property to trigger jump
    public bool forceJump;

    private Rigidbody2D rb;
    private Collider2D col;
    private Vector3 spawnPoint;
    private float _horizontal;
    private bool _jumpQueued;
    private bool _prevJumpHeld;

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

        if (forceJump)
        {
            jumpPressed = true;
            forceJump = false;
        }

        if (jumpPressed)
            _jumpQueued = true;
    }

    private void FixedUpdate()
    {
        Vector2 velocity = ReadVelocity();
        velocity.x = _horizontal * moveSpeed;

        if (_jumpQueued && IsGrounded())
        {
            velocity.y = jumpSpeed;
        }
        _jumpQueued = false;

        WriteVelocity(velocity);
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
        // Use isPressed + manual edge detection (not wasPressedThisFrame)
        // because MCP input injection causes double InputSystem.Update()
        // which resets wasPressedThisFrame before game code reads it.
        bool held = false;
#if ENABLE_INPUT_SYSTEM
        Keyboard kb = Keyboard.current;
        if (kb != null)
        {
            held = kb.spaceKey.isPressed || kb.upArrowKey.isPressed || kb.wKey.isPressed;
        }
#endif
        if (!held)
            held = Input.GetButton("Jump");

        bool edge = held && !_prevJumpHeld;
        _prevJumpHeld = held;
        return edge;
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
}`
    );
    await waitCompile();

    // Check for compile errors
    const logs = await callLog("unity_editor_console_logs", {});
    console.log("  Console logs retrieved — check above for compile errors.");

    // ─── Step 6: Attach Scripts & Configure ───
    step("Attach Scripts & Configure Objects");

    // GameManager object
    await callLog("unity_scene_create_object", { name: "GameManager", position: { x: 0, y: 0, z: 0 } });
    await addComponent("/GameManager", "GameManager");

    // Attach to enemies
    for (const e of ["Enemy1", "Enemy2"]) {
      await addComponent(`/${e}`, "EnemyMarker");
      await addComponent(`/${e}`, "EnemyPatrol");
    }

    // Attach to coins
    for (const c of coins) {
      await addComponent(`/${c.name}`, "CoinCollectible");
    }

    // Attach PlayerController to Player
    await addComponent("/Player", "PlayerController");

    // ─── Step 7: UI ───
    step("Create UI with Proper Anchoring");

    // Create canvas
    await callLog("unity_ui_create_canvas", {});

    // CanvasScaler configuration (from default-values.md)
    await setProp("/Canvas", "CanvasScaler", "m_UiScaleMode", 1);
    await setProp("/Canvas", "CanvasScaler", "m_ReferenceResolution", { x: 1920, y: 1080 });
    await setProp("/Canvas", "CanvasScaler", "m_MatchWidthOrHeight", 0.5);

    // ScoreText — top-left, font size 28
    await callLog("unity_ui_add_text", {
      parent: loc("/Canvas"), name: "ScoreText",
      text: "Score: 0/5", text_backend: "legacy", font_size: 28,
    });
    await callLog("unity_ui_set_rect_transform", {
      locator: loc("/Canvas/ScoreText"),
      anchor_min: { x: 0, y: 1 },
      anchor_max: { x: 0, y: 1 },
      pivot: { x: 0, y: 1 },
      anchored_position: { x: 20, y: -20 },
      size_delta: { x: 300, y: 50 },
    });

    // LivesText — top-left below score, font size 28
    await callLog("unity_ui_add_text", {
      parent: loc("/Canvas"), name: "LivesText",
      text: "Lives: 3", text_backend: "legacy", font_size: 28,
    });
    await callLog("unity_ui_set_rect_transform", {
      locator: loc("/Canvas/LivesText"),
      anchor_min: { x: 0, y: 1 },
      anchor_max: { x: 0, y: 1 },
      pivot: { x: 0, y: 1 },
      anchored_position: { x: 20, y: -70 },
      size_delta: { x: 300, y: 50 },
    });

    // MessageText — center, font size 56
    await callLog("unity_ui_add_text", {
      parent: loc("/Canvas"), name: "MessageText",
      text: "", text_backend: "legacy", font_size: 56,
    });
    await callLog("unity_ui_set_rect_transform", {
      locator: loc("/Canvas/MessageText"),
      anchor_min: { x: 0.5, y: 0.5 },
      anchor_max: { x: 0.5, y: 0.5 },
      pivot: { x: 0.5, y: 0.5 },
      anchored_position: { x: 0, y: 0 },
      size_delta: { x: 600, y: 100 },
    });

    // Wire UI references into GameManager
    await setProp("/GameManager", "GameManager", "scoreText", { locator: { path: "/Canvas/ScoreText" } });
    await setProp("/GameManager", "GameManager", "livesText", { locator: { path: "/Canvas/LivesText" } });
    await setProp("/GameManager", "GameManager", "messageText", { locator: { path: "/Canvas/MessageText" } });

    // Wire PlayerController.gameManager
    await setProp("/Player", "PlayerController", "gameManager", { locator: { path: "/GameManager" } });

    // ─── Step 8: Scene screenshot & save ───
    step("Scene Screenshot & Save");
    const screenshot = await call("unity_editor_screenshot", { view: "scene" });
    if (screenshot.raw?.content?.[0]?.type === "image") {
      console.log(`  Scene screenshot captured: ${screenshot.raw.content[0].data?.length || 0} chars base64`);
    } else {
      console.log(`  Scene screenshot: ${screenshot.text?.substring(0, 100)}`);
    }

    await callLog("unity_scene_save_scene", { path: "Assets/DemoPlatformer.unity" });

    console.log("\n=== BUILD COMPLETE ===");
    console.log("Scene built with: Ground, 3 platforms, Player, 2 enemies, 5 coins, UI canvas");
    console.log("Camera: orthographic size 5, sky-blue background");
    console.log("Physics: gravityScale 2.5, continuous collision, interpolation");
    console.log("UI: CanvasScaler 1920x1080, Score/Lives top-left, Message center");
    console.log("Scripts: skill templates (velocity jump, name-prefix detection)");
    console.log("Ready for play mode verification.");

  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
