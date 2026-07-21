# Level Interactables (reusable source templates)

Reusable C# templates for common 2D platformer interactables: hazards, launchers, score pickups,
optional goal triggers, and score/lives state. Author them in a clean room with
`unity_code_create_script`; do not copy files from a reference project. The game brief/acceptance
contract decides whether the primary win is score-threshold, goal reach, survival, defeat-all-enemies,
or a combination.

Companion juice/helper scripts referenced below (`HitStop`, `CameraShake`, `DustPuff`,
`OneShotSpriteBurst`, `PlayerController`, `HudController`) live in the same `Scripts/` folder;
this doc covers only the **interactables** (hazard, trampoline, collectibles, goal) and the
**GameManager** glue. Use the juice scripts from `game-polish-2d` if you need optional polish.

> **One-way / jump-through platforms are NOT a script.** Use Unity's built-in
> `PlatformEffector2D` (plus `BoxCollider2D.usedByEffector = true`) for jump-through platforms.
> There is no `OneWayPlatform.cs` — do not invent one. See `SKILL.md` §1 for the recipe.

---

## Gameplay flow (how the pieces connect)

1. **Pickup collect -> score/inventory.** Each pickup is a `Collectible` (trigger). On overlap it
   calls `GameManager.Instance.AddScore(value)`, plays a pop, and destroys itself.
2. **Score-threshold win is optional.** `GameManager.AddScore` can set `isWin = true` when
   `score >= totalCoins`. Use this only when the game contract says collection is the win condition.
3. **Goal trigger win is optional.** `LevelGoal` is a checkpoint/flag/exit trigger. Touching it calls
   `GameManager.WinLevel()`. Use it as the primary win trigger only when the game contract says so;
   otherwise it can be a visual goal or secondary trigger.
4. **Hazard hit → respawn.** A `Hazard` (saw/spikes/kill-zone, trigger or solid) freezes the game
   briefly (hit-stop), flashes the player, fires a screen shake, calls `GameManager.PlayerDied()`
   (decrements lives; `"GAME OVER"` at 0), then `PlayerController.Respawn()` snaps the player back
   to its last spawn/checkpoint.
5. **Trampoline → launch.** A `Trampoline` (trigger) calls `PlayerController.LaunchUp(bounceSpeed)`
   when the player overlaps, popping them upward.

`GameManager` owns `score`, `lives`, `isWin`, `isGameOver`, `runTime`, and pushes all of it to the
`HudController` (`hud` field). It is a singleton (`GameManager.Instance`) found by the
interactables at runtime — so the interactables need no direct reference to it.

---

## Hazard.cs

Damaging hazard (saw / spikes / kill-zone). On overlap with the player it runs the hit beat
(hit-stop + flash → screen shake → `GameManager.PlayerDied()` → `PlayerController.Respawn()`).
Works as a trigger (`isTrigger = true`) or as solid collision.

```csharp
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

/// <summary>
/// A damaging hazard (saw / spikes). On overlap with the player it costs a life and
/// snaps the player back to its last spawn/checkpoint via PlayerController.Respawn.
/// Works as either a trigger (isTrigger=true) or solid collision.
/// </summary>
[RequireComponent(typeof(Collider2D))]
public class Hazard : MonoBehaviour
{
    [Tooltip("Hit-stop freeze on contact (seconds, real time).")]
    public float hitStopSeconds = 0.09f;
    // Mock cue: a small, snappy hit-only shake (~4px @ ppu100). NOT fired on landing.
    public float shakeAmplitude = 0.04f;
    public float shakeDuration = 0.18f;

    [Header("Juice (optional)")]
    [Tooltip("Impact puff sprite asset path (loaded in editor).")]
    public string impactSheet;
    public Sprite impactSprite;

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(impactSheet)) return;
        EditorApplication.delayCall += () =>
        {
            if (this == null || string.IsNullOrEmpty(impactSheet)) return;
            foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(impactSheet))
            {
                if (obj is Sprite s) { impactSprite = s; break; }
            }
        };
    }
#endif

    private bool _dead; // ignore repeat contacts during the freeze/respawn beat

    private void Hit(GameObject other)
    {
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null || _dead) return;
        _dead = true;

        // Impact FX (reads on contact): a puff at the player's contact point, fired
        // alongside the hit-stop so it lands the moment the spike connects.
        SpawnImpact(pc);

        // Juice (mock cues G+H): freeze + flash the player white for a beat, THEN the
        // screen shake fires and the player respawns.
        SpriteRenderer sr = pc.GetComponent<SpriteRenderer>();
        GameManager gm = GameManager.Instance;
        HitStop.Do(hitStopSeconds, sr, () =>
        {
            CameraShake.Shake(shakeAmplitude, shakeDuration);
            if (gm != null) gm.PlayerDied();
            pc.Respawn();
            _dead = false;
        });
    }

    private void SpawnImpact(PlayerController pc)
    {
        if (impactSprite == null) return;
        Vector3 pos = pc.transform.position;
        Collider2D pcol = pc.GetComponent<Collider2D>();
        if (pcol != null) pos.y = pcol.bounds.min.y + 0.05f;
        DustPuff.Spawn(impactSprite, pos);
    }

    private void OnTriggerEnter2D(Collider2D other) => Hit(other.gameObject);
    private void OnCollisionEnter2D(Collision2D collision) => Hit(collision.gameObject);
}
```

**Wire over MCP**
- `unity_component_add` → `Hazard` on the hazard GameObject (saw/spike/kill-zone sprite, or an
  invisible kill-zone box below the level).
- Requires a `Collider2D` (`RequireComponent`). For a saw/spike, an overlap trigger reads best
  (`isTrigger = true`); a kill-zone can be a wide trigger box under the playfield.
- `unity_component_set_property` (all optional juice tuning):
  `hitStopSeconds` (default `0.09`), `shakeAmplitude` (`0.04`), `shakeDuration` (`0.18`).
  Optional impact FX: `impactSheet` (puff sprite asset path; the editor auto-loads
  `impactSprite`). When set, a `DustPuff` burst fires at the player's contact point (feet,
  clamped to the player collider) the instant the hazard kills — unset = no burst, never throws.
- **Connects to GameManager** via the singleton at runtime (`GameManager.Instance.PlayerDied()`),
  plus `HitStop`/`CameraShake` helpers and the player's `PlayerController.Respawn()`. No inspector
  reference to wire — the player just needs a `PlayerController` and a spawn/checkpoint set.

---

## Trampoline.cs

Bounce pad. When the player overlaps it (trigger-based so it never walls the player horizontally),
it launches them straight up at `bounceSpeed` via `PlayerController.LaunchUp`, with a short re-arm
so it doesn't re-fire every physics frame.

```csharp
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
#endif

/// <summary>
/// Bounce pad. When the player lands on top (moving downward) it launches them upward
/// at bounceSpeed, overriding vertical velocity for a satisfying pop. Detects the
/// player via PlayerController and only fires when contact comes from above.
/// </summary>
[RequireComponent(typeof(Collider2D))]
public class Trampoline : MonoBehaviour
{
    [Tooltip("Upward launch velocity (u/s). Higher than the normal jump for a clear boost.")]
    public float bounceSpeed = 18f;

    [Header("Juice (optional)")]
    [Tooltip("Dust sprite asset path (loaded in editor).")]
    public string dustSheet;
    public Sprite dustSprite;

#if UNITY_EDITOR
    private void OnValidate()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(dustSheet)) return;
        EditorApplication.delayCall += () =>
        {
            if (this == null || string.IsNullOrEmpty(dustSheet)) return;
            foreach (var obj in AssetDatabase.LoadAllAssetsAtPath(dustSheet))
            {
                if (obj is Sprite s) { dustSprite = s; break; }
            }
        };
    }
#endif

    // Trigger-based so the pad never walls the player horizontally — running into it
    // (or landing on it) launches them straight up. A short re-arm prevents the
    // launch from re-firing every physics frame while still overlapping.
    private float _readyAt;

    private void OnTriggerEnter2D(Collider2D other) => TryBounce(other.gameObject);
    private void OnTriggerStay2D(Collider2D other) => TryBounce(other.gameObject);

    private void TryBounce(GameObject other)
    {
        if (Time.time < _readyAt) return;
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null) return;

        _readyAt = Time.time + 0.25f;
        pc.LaunchUp(bounceSpeed);

        // Anchor the puff to the player's FEET (the actual push-off point), NOT the
        // pad's collider top — clamping up to the pad top floats the puff above an
        // elevated pad. For a side approach the feet sit at ground level; for a top
        // landing they sit on the pad. Falls back to the pad top only if there's no
        // player collider.
        Collider2D pcol = pc.GetComponent<Collider2D>();
        if (pcol != null)
            SpawnDust(new Vector3(pcol.bounds.center.x, pcol.bounds.min.y, 0f));
        else
            SpawnDust(new Vector3(transform.position.x, GetComponent<Collider2D>().bounds.max.y, 0f));
    }

    private void SpawnDust(Vector3 pos)
    {
        if (dustSprite == null) return;
        DustPuff.Spawn(dustSprite, pos);
    }
}
```

**Wire over MCP**
- `unity_component_add` → `Trampoline` on the bounce-pad GameObject.
- Requires a `Collider2D` (`RequireComponent`). Make it a **trigger** (`isTrigger = true`) so the
  pad never blocks horizontal movement.
- `unity_component_set_property`: `bounceSpeed` (default `18`; keep it above the normal jump for a
  clear boost). Optional juice: `dustSheet` (asset path; the editor auto-loads `dustSprite`).
- **Connects to GameManager:** none directly — it calls `PlayerController.LaunchUp` on the player.
  `DustPuff.Spawn` is optional polish.

---

## Collectible.cs

The pickup script. On the player's trigger overlap it adds score
(`GameManager.AddScore`), spawns a one-shot "collected" pop sprite burst, and destroys itself.
Tag-free: the player is detected by `PlayerController`. `[ExecuteAlways]` + editor hooks auto-load
the pop frames in the editor.

```csharp
using UnityEngine;
#if UNITY_EDITOR
using UnityEditor;
using System.Linq;
#endif

/// <summary>
/// Score pickup. On the player's trigger overlap it adds score, fires the juice
/// (a "collected" pop sprite burst), and removes itself. Name-prefix detection keeps
/// it tag-free; the player is found by its PlayerController.
/// </summary>
[ExecuteAlways]
[RequireComponent(typeof(Collider2D))]
public class Collectible : MonoBehaviour
{
    [Tooltip("Score awarded on pickup.")]
    public int value = 1;

    [Header("Juice (optional)")]
    [Tooltip("Collected.png sliced-sheet path; frames auto-load in editor.")]
    public string collectedSheet;
    [Tooltip("Pickup-pop frames — plays a quick pop where the item was.")]
    public Sprite[] collectedFrames;
    [Tooltip("Pop playback fps.")]
    public float collectedFps = 18f;

    private bool _collected;

    private void Reset()
    {
        GetComponent<Collider2D>().isTrigger = true;
    }

#if UNITY_EDITOR
    private void OnEnable() => ReloadFrames();
    private void OnValidate()
    {
        if (Application.isPlaying) return;
        EditorApplication.delayCall += () => { if (this != null) ReloadFrames(); };
    }

    private void ReloadFrames()
    {
        if (Application.isPlaying || string.IsNullOrEmpty(collectedSheet)) return;
        var all = AssetDatabase.LoadAllAssetsAtPath(collectedSheet).OfType<Sprite>().ToList();
        if (all.Count == 0) return;
        all.Sort((a, b) =>
        {
            int ai = a.name.LastIndexOf('_'), bi = b.name.LastIndexOf('_');
            int.TryParse(ai >= 0 ? a.name.Substring(ai + 1) : "0", out int an);
            int.TryParse(bi >= 0 ? b.name.Substring(bi + 1) : "0", out int bn);
            return an.CompareTo(bn);
        });
        collectedFrames = all.ToArray();
    }
#endif

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (_collected) return;
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null) return;

        _collected = true;
        GameManager gm = GameManager.Instance;
        if (gm != null) gm.AddScore(value);

        SpawnPop();
        Destroy(gameObject);
    }

    private void SpawnPop()
    {
        if (collectedFrames == null || collectedFrames.Length == 0) return;
        var go = new GameObject("PickupPop");
        go.transform.position = transform.position;
        var sr = go.AddComponent<SpriteRenderer>();
        SpriteRenderer mine = GetComponent<SpriteRenderer>();
        if (mine != null)
        {
            sr.sortingLayerID = mine.sortingLayerID;
            sr.sortingOrder = mine.sortingOrder + 1;
        }
        sr.sprite = collectedFrames[0];
        var pop = go.AddComponent<OneShotSpriteBurst>();
        pop.frames = collectedFrames;
        pop.fps = collectedFps;
    }
}
```

**Wire over MCP**
- `unity_component_add` → `Collectible` on each pickup GameObject.
- Requires a `Collider2D` (`RequireComponent`); set `isTrigger = true` (the script's `Reset` does
  this automatically when added in-editor, but set it explicitly over MCP to be safe).
- `unity_component_set_property`: `value` (score per pickup, default `1`). Optional juice:
  `collectedSheet` (pop-sheet asset path; editor auto-fills `collectedFrames`), `collectedFps`
  (`18`).
- **Connects to GameManager** via the singleton: `GameManager.Instance.AddScore(value)`. This is a
  win path only when the contract uses score-threshold completion; then total pickup value should
  reach `GameManager.totalCoins`.

---

## CoinCollectible.cs

The score-pickup path is `Collectible` (above). `CoinCollectible` is a **4-line
empty marker MonoBehaviour** — it is **not** a subclass of `Collectible`, has no fields, and
implements no pickup logic. It exists only as a tag/marker component (e.g. to label or
disambiguate coin-style pickups in the hierarchy). Do **not** rely on it to award score or trigger
the win; the active pickup is `Collectible`.

```csharp
using UnityEngine;

public class CoinCollectible : MonoBehaviour
{
}
```

**Wire over MCP**
- Optional. `unity_component_add` → `CoinCollectible` only if you want a marker on coin-style
  objects. It has no serialized fields and no GameManager connection. For functional pickups, use
  `Collectible` instead.

---

## LevelGoal.cs

The checkpoint flag / level goal — the **visual** goal. Trigger-based, tag-free player detection.
On the player reaching it, it calls `GameManager.WinLevel()` (shows `"LEVEL CLEAR!"`).

> **Win-rule is contract-owned.** Use `LevelGoal` as a primary win trigger only when the game
> contract says reaching a goal is the objective; otherwise it can remain a secondary visual goal.

```csharp
using UnityEngine;

/// <summary>
/// The checkpoint flag / level goal. When the player reaches it the level is won
/// (GameManager.WinLevel). Trigger-based; tag-free player detection.
/// </summary>
[RequireComponent(typeof(Collider2D))]
public class LevelGoal : MonoBehaviour
{
    public bool reached;

    private void Reset()
    {
        GetComponent<Collider2D>().isTrigger = true;
    }

    private void OnTriggerEnter2D(Collider2D other)
    {
        if (reached) return;
        PlayerController pc = other.GetComponent<PlayerController>();
        if (pc == null) pc = other.GetComponentInParent<PlayerController>();
        if (pc == null) return;

        reached = true;
        GameManager gm = GameManager.Instance;
        if (gm != null) gm.WinLevel();
    }
}
```

**Wire over MCP**
- `unity_component_add` → `LevelGoal` on the flag/goal GameObject (the visible end-of-level flag).
- Requires a `Collider2D` (`RequireComponent`); set `isTrigger = true` (the `Reset` does this
  in-editor; set explicitly over MCP).
- `unity_component_set_property`: none required (`reached` is runtime state — leave `false`).
- **Connects to GameManager** via the singleton: `GameManager.Instance.WinLevel()` → shows
  `"LEVEL CLEAR!"`. Whether this is primary completion or a secondary/visual goal is contract-owned.

**Grounded placement — rest the flag's VISIBLE base on the ground, not its transform-center.** A flag
(and any grounded prop) placed by snapping its *transform* `y` to the ground line will **float** — the
sprite's pivot is usually its center, so its visible base sits above the grass. Instead align its
**visible bottom** to the ground's **top**:
- `unity_scene_get_bounds` on the ground → take its `topY`; `unity_scene_get_bounds` on the flag → take
  its `visibleBottomY` (the bottom of the opaque pixels, from `visibleBounds`).
- `unity_scene_set_transform` the flag up/down by `(topY − visibleBottomY)` so `visibleBottomY == topY`.
- **`visibleBounds` requires the sprite texture imported with Read/Write enabled** — otherwise
  `unity_scene_get_bounds` reports *"texture not CPU-readable"* and can't compute the opaque bounds. See
  the Read/Write-enabled import note in `unity-2d-game/references/default-values.md` §7.

The verify **`placement`** gate's `groundedItems` check catches a floating flag (`visibleBottomY` not on
the surface `topY`).

---

## GameManager.cs

The gameplay glue (94 lines): singleton, score, lives, win/game-over state, run timer, and HUD
wiring. It supports score-threshold wins (`score >= totalCoins` inside `AddScore`) and explicit
goal-trigger wins (`WinLevel()`). Respawn-at-spawn is handled by `PlayerController.Respawn()`;
`GameManager` only tracks lives via `PlayerDied()`.

```csharp
using UnityEngine;

public class GameManager : MonoBehaviour
{
    public static GameManager Instance { get; private set; }

    [Header("HUD (wire via unity_component_set_property)")]
    public HudController hud;

    [Header("Settings")]
    [SerializeField] private int startLives = 3;
    [SerializeField] private int totalCoins = 5;

    public int score;
    public int lives;
    public bool isWin;
    public bool isGameOver;
    public float runTime;

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
        if (hud != null) hud.ShowMessage("");
        UpdateUI();
    }

    private void Update()
    {
        if (!isWin && !isGameOver)
        {
            runTime += Time.deltaTime;
            if (hud != null) hud.SetTimer(runTime);
        }
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

    public void WinLevel()
    {
        if (isWin || isGameOver) return;
        isWin = true;
        ShowMessage("LEVEL CLEAR!");
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
        if (hud != null)
        {
            hud.SetScore(score, totalCoins);
            hud.SetLives(lives);
        }
    }

    private void ShowMessage(string msg)
    {
        if (hud != null) hud.ShowMessage(msg);
    }
}
```

**How GameManager implements a score-threshold win**
- `totalCoins` (serialized, default `5`) is the **score/pickup target**. Set it to the required
  pickup count or to the sum of pickup values when the contract uses score-threshold completion.
- Each pickup calls `AddScore(value)`. Inside `AddScore`, `score += amount` then `if (score >=
  totalCoins) { isWin = true; ShowMessage("YOU WIN!"); }`.
- `WinLevel()` (called by `LevelGoal`) is a separate goal-trigger path. The contract decides whether
  that is primary completion, secondary completion, or only a visual endpoint.
- `PlayerDied()` (called by `Hazard`) decrements `lives`; at `0` it sets `isGameOver` and shows
  `"GAME OVER"`. The actual position respawn is `PlayerController.Respawn()` (spawn/checkpoint) —
  `GameManager` does not move the player.

**Wire over MCP**
- `unity_component_add` → `GameManager` on a single manager GameObject (it self-enforces singleton
  via `Awake`; only one in the scene).
- `unity_component_set_property`:
  - `totalCoins` → required score/pickup value when using a score-threshold win.
  - `startLives` → starting lives (default `3`).
  - `hud` → reference to the scene's `HudController` (the HUD wiring). Set the object reference via
    a locator so score/lives/timer/messages render.
- **Connects to interactables** via the `GameManager.Instance` singleton — `Collectible` calls
  `AddScore`, `LevelGoal` calls `WinLevel`, `Hazard` calls `PlayerDied`. No back-references needed
  on the interactables.
