# Juice kit: dash trail, fade-out, dust, pickup pop, hit-stop, screen shake

The transient-effect ("juice") components that make a 2D game read as alive: dash/move
afterimage ghosts, fading sparkles, landing/contact dust, pickup pop, hit-stop freeze, and screen shake.
(Parallax/scrolling backdrops moved to the `/parallax-2d` skill.) Each is a small, drop-in C# component
with a probe-friendly design. Source
is embedded below so a clean-room agent can recreate the components with `unity_code_create_script`.

> **Serialized component values override code defaults — set these via `set_property` in EDIT mode,
> not by relying on the `.cs` default.** The code defaults are conservative examples. The game brief
> or acceptance contract owns exact colors, counts, durations, and trigger rules. Set those values with
> `unity_component_set_property` after attaching, in edit mode, and save the scene (play-mode writes
> revert on stop).

## Configuration surface
- **Afterimage**: `ghostTint`, `ghostOpacities`, `ghostSpacing`, `holdAfterDash`, and `sortingOffset`.
  The contract should say how many ghosts, their color/opacity curve, spacing, and when they appear.
  Keep `sortingOffset` positive when the ghosts must render in front of same-order environment sprites.
- **Hit-stop**: duration and affected sprite flash are a game-feel decision; keep it short enough that
  input still reads responsive.
- **Screen shake**: amplitude, duration, and trigger source are contract values. Avoid firing shake on
  unrelated contacts if the game only wants impact/death shake.
- **SpriteFadeOut**: `useUnscaledTime = false` gives probe-deterministic fades and pauses with
  `Time.timeScale`; use unscaled time only when an effect must continue during hit-stop.

---

## DashTrail (dash afterimage ghosts)
Renders at most 3 cyan ghosts trailing the player while dashing (reads `PlayerController.IsDashing` and
clones the live `SpriteRenderer` frame), held briefly after the dash ends. Drop on the player.

```csharp
using UnityEngine;

/// <summary>
/// Configurable dash/move afterimage.
/// Renders a short trail behind the player while dashing. The game contract supplies
/// the tint, ghost count/opacities, spacing, and hold duration.
///
/// Decoupled: reads PlayerController.IsDashing and clones the live SpriteRenderer frame,
/// so it works with any sprite animator. Drop on the player (needs PlayerController +
/// SpriteRenderer). The ghosts use a positive sortingOffset so they render ABOVE the
/// ground (the fix for ghosts hiding behind same-order environment sprites).
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
[RequireComponent(typeof(PlayerController))]
public class DashTrail : MonoBehaviour
{
    [Tooltip("Ghost tint. Alpha is overridden per-ghost by ghostOpacities.")]
    public Color ghostTint = new Color(0.35f, 0.8f, 1f, 1f);

    [Tooltip("Per-ghost opacities, nearest (most opaque) first.")]
    public float[] ghostOpacities = { 0.5f, 0.3f, 0.15f };

    [Tooltip("World-space spacing between successive ghosts along the trail (~0.1u = ~10px @ ppu100).")]
    public float ghostSpacing = 0.1f;

    [Tooltip("How long ghosts linger after the dash ends before being cleared (seconds).")]
    public float holdAfterDash = 0.08f;

    [Tooltip("Sorting-order offset vs the player. Positive renders ghosts ABOVE the ground " +
             "(co-planar/negative can hide them behind same-order environment sprites).")]
    public int sortingOffset = 1;

    private PlayerController _pc;
    private SpriteRenderer _sr;
    private SpriteRenderer[] _ghosts;
    private bool _wasDashing;
    private float _clearAt;
    private int _facing = 1; // last dash direction (sign of trail offset)

    private void Awake()
    {
        _pc = GetComponent<PlayerController>();
        _sr = GetComponent<SpriteRenderer>();
        int n = (ghostOpacities != null) ? ghostOpacities.Length : 0;
        _ghosts = new SpriteRenderer[n];
        for (int i = 0; i < n; i++)
        {
            var go = new GameObject("DashGhost_" + i);
            go.transform.SetParent(null, true);
            var gsr = go.AddComponent<SpriteRenderer>();
            gsr.enabled = false;
            _ghosts[i] = gsr;
        }
    }

    private void OnDestroy()
    {
        if (_ghosts == null) return;
        foreach (var g in _ghosts)
            if (g != null) Destroy(g.gameObject);
    }

    private void LateUpdate()
    {
        if (_pc == null || _sr == null || _ghosts == null) return;

        bool dashing = _pc.IsDashing;

        if (dashing)
        {
            // Trail points opposite the travel direction. Use flipX as the facing cue
            // (player faces dash direction); flipX=true => facing left.
            _facing = _sr.flipX ? -1 : 1;
            PositionGhosts();
            _wasDashing = true;
            return;
        }

        if (_wasDashing)
        {
            // Dash just ended: hold the last ghost pose for a short beat, then clear.
            _wasDashing = false;
            _clearAt = Time.time + holdAfterDash;
        }

        if (_clearAt > 0f)
        {
            if (Time.time >= _clearAt)
            {
                HideGhosts();
                _clearAt = 0f;
            }
            // else: leave the ghosts frozen in place during the hold window.
        }
    }

    private void PositionGhosts()
    {
        if (_sr.sprite == null) { HideGhosts(); return; }

        Vector3 basePos = transform.position;
        for (int i = 0; i < _ghosts.Length; i++)
        {
            var gsr = _ghosts[i];
            if (gsr == null) continue;

            // Ghost i sits (i+1) steps BEHIND the player along the trail.
            float back = -_facing * ghostSpacing * (i + 1);
            gsr.transform.position = basePos + new Vector3(back, 0f, 0f);
            gsr.transform.rotation = transform.rotation;
            gsr.transform.localScale = transform.lossyScale;

            gsr.sprite = _sr.sprite;
            gsr.flipX = _sr.flipX;
            gsr.flipY = _sr.flipY;

            Color c = ghostTint;
            c.a = ghostOpacities[i];
            gsr.color = c;

            gsr.sortingLayerID = _sr.sortingLayerID;
            gsr.sortingOrder = _sr.sortingOrder + sortingOffset;
            gsr.enabled = true;
        }
    }

    private void HideGhosts()
    {
        if (_ghosts == null) return;
        foreach (var g in _ghosts)
            if (g != null) g.enabled = false;
    }
}
```

**Wire over MCP** — `unity_component_add` `DashTrail` on the **Player** (auto-requires `SpriteRenderer`
+ `PlayerController`). Then set the contract values with `unity_component_set_property`:
- `ghostTint` = game-defined effect color
- `ghostOpacities` = game-defined opacity curve, nearest most-opaque first
- `ghostSpacing` = world-space spacing between ghosts
- `holdAfterDash` = linger time after movement ends
- `sortingOffset` = usually positive so ghosts render in front of ground/environment sprites

---

## SpriteFadeOut (ghost / sparkle fade-out)
Fades a `SpriteRenderer` alpha to zero over `lifetime` (optionally drifting), then destroys the
GameObject. Reusable for afterimage ghosts, sparkles, etc.

```csharp
using UnityEngine;

/// <summary>
/// Fades a SpriteRenderer's alpha to zero over `lifetime` (optionally drifting), then
/// destroys the GameObject. Reusable for afterimage ghosts, sparkles, etc. Runs on
/// UNSCALED time by default so it keeps fading during a hit-stop freeze.
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
public class SpriteFadeOut : MonoBehaviour
{
    public float lifetime = 0.25f;
    public Vector2 drift = Vector2.zero;   // world units / second
    [Tooltip("Fade on unscaled time (keeps fading during a hit-stop freeze). Off = game time, " +
             "which pauses with Time.timeScale and is deterministic under runtime.probe.")]
    public bool useUnscaledTime = false;

    private SpriteRenderer _sr;
    private Color _base;
    private float _t;

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        _base = _sr.color;
    }

    private void Update()
    {
        float dt = useUnscaledTime ? Time.unscaledDeltaTime : Time.deltaTime;
        _t += dt;
        float k = (lifetime <= 0f) ? 1f : Mathf.Clamp01(_t / lifetime);
        if (drift != Vector2.zero)
            transform.position += (Vector3)(drift * dt);
        Color c = _base;
        c.a = _base.a * (1f - k);
        _sr.color = c;
        if (k >= 1f) Destroy(gameObject);
    }
}
```

**Wire over MCP** — `unity_component_add` `SpriteFadeOut` on the transient ghost/sparkle GameObject
(needs a `SpriteRenderer`). Set:
- `useUnscaledTime` = `false` — **scaled/game time, so the fade is probe-deterministic** (pauses with
  `Time.timeScale`). Note the code default comment says "UNSCALED by default" but the serialized field
  default is `false`; keep it `false` for the verified build.
- `lifetime` = fade duration in seconds (e.g. `0.25`); optional `drift` for a rising/floating motion.

---

## DustPuff (landing dust)
A short-lived dust puff: spawns a single sprite that rises, scales up, and fades out, then self-destroys.
Used for landing dust and trampoline-launch dust (hero-shot cue E). Static `Spawn` factory keeps callers
a one-liner — `PlayerController.SpawnLandingDust()` calls `DustPuff.Spawn(sprite, feet)` on touchdown.

```csharp
using UnityEngine;

/// <summary>
/// A short-lived dust puff: spawns a single sprite that rises a little, scales up, and
/// fades to transparent over its lifetime, then destroys itself. Used for landing dust
/// and trampoline-launch dust (the hero-shot's "E · landing dust" cue). Static Spawn
/// factory keeps callers a one-liner.
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
public class DustPuff : MonoBehaviour
{
    public float lifetime = 0.24f;   // mock: fade over 240 ms
    public float riseSpeed = 1.2f;
    public float startScale = 0.5f;
    public float endScale = 1.1f;

    private SpriteRenderer _sr;
    private float _t;
    private Color _baseColor;

    public static DustPuff Spawn(Sprite sprite, Vector3 pos)
    {
        var go = new GameObject("DustPuff");
        go.transform.position = pos;
        var sr = go.AddComponent<SpriteRenderer>();
        sr.sprite = sprite;
        return go.AddComponent<DustPuff>();
    }

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        _baseColor = _sr.color;
        transform.localScale = Vector3.one * startScale;
    }

    private void Update()
    {
        _t += Time.deltaTime;
        float k = Mathf.Clamp01(_t / lifetime);
        transform.position += Vector3.up * (riseSpeed * Time.deltaTime);
        transform.localScale = Vector3.one * Mathf.Lerp(startScale, endScale, k);
        Color c = _baseColor;
        c.a = _baseColor.a * (1f - k);
        _sr.color = c;
        if (k >= 1f) Destroy(gameObject);
    }
}
```

**Wire over MCP** — `DustPuff` is **spawned in code**, not attached in the editor: `PlayerController`
calls `DustPuff.Spawn(landingDustSprite, feet)` on a fast touchdown. You don't add it to a GameObject
directly. Instead wire the dust sprite on the **Player**'s `PlayerController`:
- `landingDustSheet` (string) — editor-only convenience that auto-fills `landingDustSprite` from a sheet
  path in `OnValidate`; **not** required at runtime.
- `landingDustSprite` (Sprite) — the actual dust frame, set build-safe via
  `unity_component_set_property` `{ "asset_path": "...", "sub_asset": "..." }`.
- `landingDustMinSpeed` = `3` — min downward speed at touchdown to emit dust.
Defaults on the spawned puff: `lifetime 0.24`, `riseSpeed 1.2`, `startScale 0.5`, `endScale 1.1`.

---

## OneShotSpriteBurst (fruit-collect pop)
Plays a sprite-frame burst once (no loop) then destroys its GameObject. Used for transient juice like
the fruit-collect pop.

```csharp
using UnityEngine;

/// <summary>
/// Plays a sprite-frame burst once (no loop) then destroys its GameObject. Used for
/// transient juice like the fruit-collect pop and landing dust puff.
/// </summary>
[RequireComponent(typeof(SpriteRenderer))]
public class OneShotSpriteBurst : MonoBehaviour
{
    public Sprite[] frames;
    public float fps = 18f;

    private SpriteRenderer _sr;
    private float _t;
    private int _index;

    private void Awake()
    {
        _sr = GetComponent<SpriteRenderer>();
        if (frames != null && frames.Length > 0) _sr.sprite = frames[0];
    }

    private void Update()
    {
        if (frames == null || frames.Length == 0 || fps <= 0f)
        {
            Destroy(gameObject);
            return;
        }
        _t += Time.deltaTime * fps;
        int i = Mathf.FloorToInt(_t);
        if (i >= frames.Length)
        {
            Destroy(gameObject);
            return;
        }
        if (i != _index)
        {
            _index = i;
            _sr.sprite = frames[i];
        }
    }
}
```

**Wire over MCP** — Add `OneShotSpriteBurst` to a transient burst GameObject (it spawns and
self-destructs; `Collectible` instantiates it on pickup). Set the frame set + speed:
- `frames` (Sprite[]) — the pop frames, wired as a JSON array of object references, in order:
  `[{ "asset_path": "Assets/.../Pop.png", "sub_asset": "pop_0" }, { ..., "sub_asset": "pop_1" }, ...]`
  (build-safe; same pattern as `PlayerSpriteAnimator` frames — see `character-anim.md`).
- `fps` = `18` (burst playback speed).

---

## HitStop (hit-stop / time-freeze on impact)
Brief global freeze: sets `Time.timeScale` to 0 for a short REAL-time window, then restores it — a
punchy pause on impact (hero-shot cue G). Static API `HitStop.Do(seconds [, flash] [, onComplete])`,
self-bootstraps a hidden persistent runner; overlapping calls replace the in-flight freeze.

```csharp
using System.Collections;
using UnityEngine;

/// <summary>
/// Brief global "hit-stop" freeze (hero-shot cue G): sets Time.timeScale to 0 for a short
/// REAL-time window, then restores it — a punchy pause on impact. Static API:
/// HitStop.Do(seconds [, flash] [, onComplete]). Self-bootstraps a hidden persistent runner;
/// overlapping calls replace the in-flight freeze rather than stacking. Optionally flashes a
/// SpriteRenderer white for the duration of the freeze.
/// </summary>
public class HitStop : MonoBehaviour
{
    private static HitStop _instance;
    private Coroutine _running;
    private float _savedTimeScale = 1f;

    private static HitStop Instance
    {
        get
        {
            if (_instance == null)
            {
                var go = new GameObject("~HitStop") { hideFlags = HideFlags.HideAndDontSave };
                _instance = go.AddComponent<HitStop>();
            }
            return _instance;
        }
    }

    public static void Do(float seconds, SpriteRenderer flash = null, System.Action onComplete = null)
    {
        Instance.Run(seconds, flash, onComplete);
    }

    private void Run(float seconds, SpriteRenderer flash, System.Action onComplete)
    {
        if (_running != null) StopCoroutine(_running);
        _running = StartCoroutine(Freeze(seconds, flash, onComplete));
    }

    private IEnumerator Freeze(float seconds, SpriteRenderer flash, System.Action onComplete)
    {
        if (Time.timeScale != 0f) _savedTimeScale = Time.timeScale;

        Color flashBase = default;
        if (flash != null) { flashBase = flash.color; flash.color = Color.white; }

        Time.timeScale = 0f;
        yield return new WaitForSecondsRealtime(seconds);
        Time.timeScale = _savedTimeScale;

        if (flash != null) flash.color = flashBase;
        _running = null;
        onComplete?.Invoke();
    }
}
```

**Wire over MCP** — `HitStop` has **no serialized fields and is not attached** to any GameObject; it
self-bootstraps a hidden runner on first call. Create the script so the type exists, then call it from
the hit/death path (e.g. `Hazard` / `PlayerController` on a HIT): `HitStop.Do(0.1f, playerSprite)` —
**~100ms** freeze, optionally flashing the player white. Fire only on a HIT, paired with `CameraShake`.

---

## CameraShake (screen shake on a HIT)
Decaying positional screen shake for a static (or simple) 2D camera. Static API
`CameraShake.Shake(amplitude, duration)`. Applies a noise offset on top of the camera's rest position in
`LateUpdate`, on UNSCALED time so it animates during a hit-stop freeze. Drop on the Main Camera.

```csharp
using UnityEngine;

/// <summary>
/// Decaying positional screen shake for a static (or simple) 2D camera. Static API:
/// CameraShake.Shake(amplitude, duration). Applies a noise offset on top of the camera's
/// rest position in LateUpdate, on UNSCALED time so it animates during a hit-stop freeze.
/// Drop on the Main Camera (hero-shot cues G/H).
///
/// Captures the rest position when a shake begins, so it composes with a static camera
/// (Camera2DSetup, which only positions the camera on enable, not per-frame). Not intended
/// to layer on top of a per-frame follow camera without ordering care.
/// </summary>
[DisallowMultipleComponent]
public class CameraShake : MonoBehaviour
{
    private static CameraShake _instance;

    private Vector3 _restPos;
    private float _amplitude;
    private float _duration;
    private float _elapsed;
    private bool _shaking;

    private void Awake()
    {
        _instance = this;
        _restPos = transform.localPosition;
    }

    private void OnDestroy()
    {
        if (_instance == this) _instance = null;
    }

    /// <summary>Trigger a shake. Re-triggering keeps the stronger remaining amplitude.</summary>
    public static void Shake(float amplitude, float duration)
    {
        if (_instance != null) _instance.Begin(amplitude, duration);
    }

    private void Begin(float amplitude, float duration)
    {
        if (!_shaking) _restPos = transform.localPosition;
        _amplitude = Mathf.Max(_shaking ? RemainingAmplitude() : 0f, amplitude);
        _duration = Mathf.Max(0.0001f, duration);
        _elapsed = 0f;
        _shaking = true;
    }

    private float RemainingAmplitude()
    {
        return _amplitude * Mathf.Clamp01(1f - _elapsed / _duration);
    }

    private void LateUpdate()
    {
        if (!_shaking) return;
        _elapsed += Time.unscaledDeltaTime;
        float k = Mathf.Clamp01(_elapsed / _duration);
        if (k >= 1f)
        {
            transform.localPosition = _restPos;
            _shaking = false;
            return;
        }
        float damp = (1f - k) * (1f - k);   // ease-out
        float ox = (Mathf.PerlinNoise(Time.unscaledTime * 40f, 0f) - 0.5f) * 2f;
        float oy = (Mathf.PerlinNoise(0f, Time.unscaledTime * 40f) - 0.5f) * 2f;
        transform.localPosition = _restPos + new Vector3(ox, oy, 0f) * (_amplitude * damp);
    }
}
```

**Wire over MCP** — `unity_component_add` `CameraShake` on the **Main Camera**. It has no serialized
fields (amplitude/duration come from the `Shake(...)` call). Trigger it from the hit/death path **only**:
`CameraShake.Shake(0.04f, 0.2f)` — **~4px** amplitude (`0.04`u @ ppu100). Fire on a **HIT ONLY** —
never on a normal landing (landing emits dust via `DustPuff`, not shake). Pair with `HitStop.Do(0.1f)`.

---

## EndCard (styled win / lose end state + win celebration)
The win/lose state must NOT be raw `ShowMessage("YOU WIN!")` text floating over the hazard — an
adversarial review flagged exactly that ("unstyled `YOU WIN!` floating over the saw, zero juice"). The
message has to sit on a styled surface — a panel or a **dimmed full-screen backdrop** (semi-transparent
overlay) — centered in clear space, and the win should fire a short celebration cue. Two parts:

**1 · Styled end-card surface.** Either extend `HudController` (see `hud-kit.md`) with an end-card group
it shows/hides, or drop in this small standalone `EndCard` helper. It owns a **full-screen dimming
overlay** + a centered card; `Show(msg, win)` reveals it, tints the message (win=gold / lose=red), and
dims the gameplay behind it. Authored via `unity_code_create_script`; the overlay/card objects are built
once over MCP (see Wire note).

> **The polished run hit two real bugs here — both load-bearing, both verified by the VLM.**
>
> **(a) The dim wasn't full-screen.** The backdrop Image was built as a fixed centered rectangle, so it
> dimmed a box, not the screen — the corners stayed bright gameplay. Fix: the backdrop's RectTransform
> must **STRETCH to fill the screen** — anchors `min (0,0)` / `max (1,1)`, **all four offsets 0**. The
> centered card sits on top of that full-screen dim.
>
> **(b) World sprites drew IN FRONT of the card.** The EndCard lived on the **Screen Space-Camera HUD
> canvas**, whose UI renders at the canvas **plane distance** in front of the camera. Gameplay sprites
> (box, player, flag) with a **nearer Z** are *closer to the camera than that plane*, so they composite
> **over** the card — the centered "YOU WIN!" was occluded by world geometry. `Canvas.sortingOrder`
> alone does **NOT** fix this: sorting order only orders **canvas-vs-canvas / UI-vs-UI**, it does not win
> a **world-Z-vs-canvas-plane** depth contest. You need to break the EndCard out of that depth test:
>
> **PREFERRED — put the EndCard on its own child Canvas with override-sorting.** Add a nested `Canvas`
> on the EndCard root with **`overrideSorting = true`** and a **high `sortingOrder`** (e.g. `100`). An
> override-sorting canvas is composited as its own sorting group **above the world and the HUD regardless
> of world Z** — the card always wins, and you never have to touch a single world sprite. `sortingOrder`
> and `overrideSorting` are now settable over the bridge via `component_set_property` (the Canvas sorting
> setter was just added), so wire them via MCP — no inspector round-trip. **Keep it Screen Space-Camera**
> (an override-sorting child inherits the parent's render mode): Overlay isn't composited by
> `Camera.Render` so the bridge screenshot wouldn't capture it (see `hud-kit.md`) — Screen Space-Camera +
> override-sorting child gives you both *captured* **and** *in front*.
>
> **ALTERNATIVE (the run's actual fix) — lower the world's sorting under the HUD canvas.** Keep every
> gameplay `SpriteRenderer`'s `sortingOrder` **below** the HUD/EndCard canvas's `sortingOrder` so the
> canvas wins. Works, but it's the fallback: it requires touching *every* world sprite and stays fragile
> as you add more. Prefer the dedicated override-sorting overlay canvas above — it's robust and local.

```csharp
using UnityEngine;
using UnityEngine.UI;
using TMPro;

/// <summary>
/// Styled end-state card: a STRETCH-to-fill, semi-transparent backdrop that DIMS the WHOLE
/// screen, with a centered card + message on top — so the win/lose text reads on a clean
/// surface instead of floating raw over the hazard. Call EndCard.Show("YOU WIN!", win:true) /
/// Show("GAME OVER", win:false) from the win/death path. Hidden until Show().
///
/// MUST render IN FRONT of all world sprites: the EndCard root carries its own override-sorting
/// child Canvas (overrideSorting=true, high sortingOrder), so it composites above world+HUD
/// regardless of world Z. (Plain Canvas.sortingOrder can't beat a nearer world-Z sprite.)
///
/// Owns presentation only. Wire `backdrop` (full-screen STRETCH Image), `card` (centered panel
/// RectTransform/Image), and `messageLabel` (TMP_Text child of the card) over MCP. Build the
/// override-sorting child Canvas over MCP too (see Wire note).
/// </summary>
[RequireComponent(typeof(Canvas))]   // the EndCard root's own override-sorting overlay canvas
public class EndCard : MonoBehaviour
{
    [Header("Wire over MCP")]
    public Image backdrop;          // FULL-SCREEN dimming overlay (anchors 0,0..1,1, offsets 0; rgba 0,0,0,~0.6)
    public RectTransform card;       // centered panel behind the message
    public TMP_Text messageLabel;    // big centered message on the card

    [Tooltip("Win tint (mock gold).")]  public Color winColor  = new Color(1f, 0.92f, 0.23f, 1f);
    [Tooltip("Lose tint.")]              public Color loseColor = new Color(0.96f, 0.36f, 0.36f, 1f);

    [Header("Overlay sorting (own child Canvas — wired over MCP)")]
    [Tooltip("Render above world + HUD regardless of world Z.")]
    public int sortingOrder = 100;

    private void Awake()
    {
        // Belt-and-suspenders: guarantee the root canvas overrides sorting even if the
        // MCP wiring missed it. The high sortingOrder is what beats world-Z occlusion.
        var canvas = GetComponent<Canvas>();
        if (canvas != null)
        {
            canvas.overrideSorting = true;
            canvas.sortingOrder = sortingOrder;
        }
        SetVisible(false);
    }

    public void Show(string msg, bool win)
    {
        if (messageLabel != null)
        {
            messageLabel.text = msg;
            messageLabel.color = win ? winColor : loseColor;
        }
        SetVisible(true);
    }

    public void Hide() { SetVisible(false); }

    private void SetVisible(bool on)
    {
        if (backdrop != null) backdrop.enabled = on;
        if (card != null) card.gameObject.SetActive(on);
        if (messageLabel != null) messageLabel.gameObject.SetActive(on);
    }
}
```

**Wire over MCP** — build the surface once in edit mode, then attach + wire:
- EndCard root: an empty child of the HUD Canvas with its **own** `Canvas` (`unity_component_add Canvas`).
  Set it to **override-sort above everything** — the load-bearing fix for world-Z occlusion:
  ```
  unity_component_set_property Canvas m_OverrideSorting = true     # break out of the parent's sorting
  unity_component_set_property Canvas m_SortingOrder    = 100      # render above world + HUD
  ```
  Leave its render mode inherited (Screen Space-Camera) so the bridge screenshot still captures it.
- Backdrop: `unity_ui_add_image` child of the EndCard root, **STRETCH full-screen** (anchors `min 0,0` /
  `max 1,1`, **all offsets 0** via `unity_ui_set_rect_transform`), color rgba `0,0,0,0.6`. This is the
  full-screen dim — it's what separates "card on a dimmed screen" from "text over gameplay". A fixed
  centered rect dims only a box and leaves the corners bright (the run's bug).
- Card: `unity_ui_add_image` child of the EndCard root (drawn above the backdrop), centered (anchor/pivot
  `0.5,0.5`), size ~`560x200`, a solid/branded panel color.
- Message: `unity_ui_add_text text_backend:"tmp"` child of the card, font ~64, `MiddleCenter`, centered.
  (Reuse the HUD's message styling from `hud-kit.md` — font + warm tint — so it matches the readout.)
- `unity_code_attach_script EndCard` to the EndCard root; wire `backdrop` / `card` / `messageLabel` via
  `unity_component_set_property value:{locator:{path:...}}`. Game logic calls `EndCard.Show(...)` on
  win/death instead of `hud.ShowMessage(...)`. (`Awake` re-asserts `overrideSorting`/`sortingOrder` as a
  safety net, but set them over MCP so the order is correct in edit mode too.)

**EndCard is visual presentation only.** Pair it with `references/end-state.md` so the win/lose card is
modal: gameplay input is locked, player motion is frozen, mutable systems stop, and restart works.

**2 · Win celebration cue.** On the win, fire a **short, readable** burst over the goal — reuse the
existing juice helpers, don't invent new infra:
- A flash/pop **burst** with `OneShotSpriteBurst` (spawn it at the goal/flag, set its `frames` to the
  pop/sparkle sheet) — same one-shot pattern as the fruit-collect pop.
- If a **flag goal** exists, a flag-wave/pop reads great: spawn a `DustPuff` (or a second
  `OneShotSpriteBurst`) **at the flag head**, OR drive the flag's animator/scale for a quick wave.
- Keep it brief (≈0.2–0.4s) so the end-card stays the focus — a single burst, not a confetti storm.

```csharp
// in the win path (e.g. GameManager.Win()):
endCard.Show("YOU WIN!", win: true);
OneShotSpriteBurst.SpawnAt(winBurstFrames, flag.transform.position);  // celebration pop at the goal
DustPuff.Spawn(winSparkleSprite, flag.transform.position);            // optional flag-head sparkle
// (add a one-line static SpawnAt to OneShotSpriteBurst mirroring DustPuff.Spawn if not present)
```

Pairs with the **`win` SFX cue** (added in `references/audio.md`) — fire the audio on the same `Win()`
call. The VLM **`end-state-styling`** criterion checks the message is styled and **on top of a full-screen
dim** (panel/backdrop, mock font/tint — not default-font text over gameplay, not occluded by the box/
player/flag), the **`rendering-artifacts`** criterion catches world sprites poking through the card (the
occlusion bug above), and **`juice-cue-presence`** checks a celebration cue plays on the win. See
`verify-2d-game/references/feel-checks.md` for how to verify a short burst actually fired (transient FX
fade before you can query them — pin them to catch them).

---

## Parallax / scrolling backgrounds → see the `/parallax-2d` skill
Parallax and scrolling backdrops now live in the dedicated **`/parallax-2d`** skill (seamless, edge-safe
**texture-offset scroll** on a static frame-covering quad — `ParallaxLayer`, with AmbientDrift and
CameraFollow modes, multi-layer depth, and the coverage-gate verification recipe).

The old **`BackdropDrift`** (transform-translation + `Mathf.Repeat` on a world offset) is **superseded** —
it **snapped** the whole backdrop ~8u sideways on each wrap and **exposed a gap** of bare camera
background on one edge as its own edges slid across the frame. Use `/parallax-2d` instead.
