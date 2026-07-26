# Audio / SFX kit: registry-backed cues + a pooled SfxPlayer

Adds **audible polish** to a 2D game: short retro 8-bit sound cues for jump, dash, collect, hit,
trampoline bounce, and win. It is the audio counterpart to `juice.md` (which covers *visual* transient
cues). Prefer the curated CC0 registry entries under `asset-layer/registry/platformer-2d.json`; use the
procedural generator only when the registry is unavailable or a build needs a temporary fallback.

Three pieces:
1. A drop-in **`SfxPlayer`** singleton (pooled `AudioSource`) + a static **`Sfx`** cue API, authored via
   `unity_code_create_script` and wired with generic `unity_*` tools.
2. Six default registry cues: `sfx_jump`, `sfx_dash`, `sfx_collect`, `sfx_hit`, `sfx_bounce`, `sfx_win`.
   Prepare/import them into `Assets/Audio/SFX/{jump,dash,collect,hit,bounce,win}.wav`.
3. A **procedural SFX-gen python script** that can write replacement fallback WAVs if no sourced asset is
   available.

## Principles
- **Resilient, never throws.** No clip → no-op. No `SfxPlayer` in scene → the static `Sfx.Play` is a
  silent no-op (so the hook calls in gameplay scripts never hard-couple to audio existing).
- **Decoupled hooks.** Gameplay scripts call `Sfx.PlayCue("jump")` (or `Sfx.Play(clip)`); they do not
  hold an `AudioSource` reference. Audio can be removed by deleting the `SfxPlayer` object — gameplay
  still runs.
- **Probe-verifiable.** `SfxPlayer` exposes a public **instance** field `PlayCount` (and a per-cue count)
  so `unity_runtime_assert_condition` can confirm a cue fired without listening to audio.

---

## SfxPlayer (singleton + pooled AudioSource) + Sfx static API

Drop **one** `SfxPlayer` on a scene GameObject named `SfxPlayer` (the manifest gate matches that name).
It self-registers as the singleton in `Awake`, builds a small pool of `AudioSource`s, and round-robins
through them so overlapping cues don't cut each other off. The static `Sfx` facade routes cue names and
clips to the live instance; with no instance present every call is a no-op.

Author verbatim via `unity_code_create_script` to `Assets/Scripts/SfxPlayer.cs`:

```csharp
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// Drop-in retro-SFX player for 2D games. A singleton that owns a small pool of
/// AudioSources and round-robins through them so overlapping one-shots don't cut each
/// other off. Resilient by design: a null clip is a no-op, and the static Sfx facade
/// is a silent no-op when no SfxPlayer exists in the scene (so gameplay scripts never
/// hard-couple to audio being present).
///
/// Probe-friendly: PlayCount is a public INSTANCE field on this component, so a runtime
/// assertion can read `/SfxPlayer SfxPlayer.PlayCount > 0` to confirm a cue fired
/// (unity_runtime_assert_condition reads instance fields on a locatable GameObject).
/// Per-cue counts live in `_cueCounts` and are exposed via PlayCountFor(name).
///
/// Wire named cues in the inspector (or via unity_component_set_property): the `cues`
/// array maps a cue id ("jump", "dash", ...) to an AudioClip asset. Drop on a GameObject
/// named "SfxPlayer".
/// </summary>
[DisallowMultipleComponent]
public class SfxPlayer : MonoBehaviour
{
    [System.Serializable]
    public struct Cue
    {
        [Tooltip("Cue id used by Sfx.PlayCue(name), e.g. \"jump\", \"collect\".")]
        public string id;
        public AudioClip clip;
        [Range(0f, 1f)] public float volume;
        [Tooltip("Random pitch jitter (±), keeps repeated cues from sounding robotic. 0 = none.")]
        public float pitchJitter;
    }

    [Tooltip("Named cues: id -> clip. Sfx.PlayCue(id) looks up here.")]
    public Cue[] cues;

    [Tooltip("How many pooled AudioSources to round-robin through (overlap headroom).")]
    [Range(1, 16)] public int voices = 6;

    [Range(0f, 1f)] public float masterVolume = 0.8f;

    /// <summary>Total cues played this run. Public INSTANCE field — directly assertable
    /// via unity_runtime_assert_condition on the /SfxPlayer object.</summary>
    public int PlayCount;

    private static SfxPlayer _instance;
    private AudioSource[] _pool;
    private int _next;
    private readonly Dictionary<string, Cue> _byId = new Dictionary<string, Cue>();
    private readonly Dictionary<string, int> _cueCounts = new Dictionary<string, int>();

    private void Awake()
    {
        _instance = this;

        int n = Mathf.Max(1, voices);
        _pool = new AudioSource[n];
        for (int i = 0; i < n; i++)
        {
            var src = gameObject.AddComponent<AudioSource>();
            src.playOnAwake = false;
            src.spatialBlend = 0f; // 2D
            _pool[i] = src;
        }

        _byId.Clear();
        if (cues != null)
            foreach (var c in cues)
                if (!string.IsNullOrEmpty(c.id)) _byId[c.id] = c;
    }

    private void OnDestroy()
    {
        if (_instance == this) _instance = null;
    }

    /// <summary>Per-cue play count (0 if never played / unknown). Probe-readable.</summary>
    public int PlayCountFor(string id)
    {
        return (id != null && _cueCounts.TryGetValue(id, out int v)) ? v : 0;
    }

    /// <summary>Play a clip directly. Null clip = no-op (never throws).</summary>
    public void PlayClip(AudioClip clip, float volume = 1f, float pitchJitter = 0f)
    {
        if (clip == null || _pool == null || _pool.Length == 0) return;

        AudioSource src = _pool[_next];
        _next = (_next + 1) % _pool.Length;

        src.pitch = 1f + (pitchJitter > 0f ? Random.Range(-pitchJitter, pitchJitter) : 0f);
        src.PlayOneShot(clip, Mathf.Clamp01(volume) * masterVolume);
        PlayCount++;
    }

    /// <summary>Play a named cue from the `cues` table. Unknown id / null clip = no-op.</summary>
    public void PlayById(string id)
    {
        if (id == null || !_byId.TryGetValue(id, out Cue c) || c.clip == null) return;
        PlayClip(c.clip, c.volume <= 0f ? 1f : c.volume, c.pitchJitter);
        _cueCounts.TryGetValue(id, out int prev);
        _cueCounts[id] = prev + 1;
    }

    // ---- static facade: silent no-op when no SfxPlayer is present ----

    /// <summary>Play a named cue. Safe to call with no SfxPlayer in scene (no-op).</summary>
    public static void PlayCue(string id)
    {
        if (_instance != null) _instance.PlayById(id);
    }

    /// <summary>Play a clip directly. Safe to call with no SfxPlayer in scene (no-op).</summary>
    public static void Play(AudioClip clip, float volume = 1f)
    {
        if (_instance != null) _instance.PlayClip(clip, volume);
    }
}

/// <summary>
/// Convenience facade so gameplay scripts read `Sfx.Jump()` / `Sfx.PlayCue("jump")`
/// instead of reaching into SfxPlayer. Pure forwarding — every method is a no-op when
/// no SfxPlayer exists, so hooks never hard-couple gameplay to audio.
/// </summary>
public static class Sfx
{
    public static void PlayCue(string id) => SfxPlayer.PlayCue(id);
    public static void Play(AudioClip clip, float volume = 1f) => SfxPlayer.Play(clip, volume);

    public static void Jump()    => SfxPlayer.PlayCue("jump");
    public static void Dash()    => SfxPlayer.PlayCue("dash");
    public static void Collect() => SfxPlayer.PlayCue("collect");
    public static void Hit()     => SfxPlayer.PlayCue("hit");
    public static void Bounce()  => SfxPlayer.PlayCue("bounce");
    public static void Win()     => SfxPlayer.PlayCue("win");
}
```

**Wire over MCP:**
1. `unity_scene_create_object` a GameObject named **`SfxPlayer`** (the manifest gate matches this name).
2. `unity_code_attach_script SfxPlayer` onto it.
3. Set the `cues` array via `unity_component_set_property` — each entry maps a cue id to a clip asset.
   AudioClip references are wired the build-safe object-reference way (same shape as sprite refs):
   ```
   cues = [
     { "id": "jump",    "clip": { "asset_path": "Assets/Audio/SFX/jump.wav" },    "volume": 0.8, "pitchJitter": 0.04 },
     { "id": "dash",    "clip": { "asset_path": "Assets/Audio/SFX/dash.wav" },    "volume": 0.7, "pitchJitter": 0.0  },
     { "id": "collect", "clip": { "asset_path": "Assets/Audio/SFX/collect.wav" }, "volume": 0.8, "pitchJitter": 0.05 },
     { "id": "hit",     "clip": { "asset_path": "Assets/Audio/SFX/hit.wav" },     "volume": 0.9, "pitchJitter": 0.0  },
     { "id": "bounce",  "clip": { "asset_path": "Assets/Audio/SFX/bounce.wav" },  "volume": 0.8, "pitchJitter": 0.03 },
     { "id": "win",     "clip": { "asset_path": "Assets/Audio/SFX/win.wav" },     "volume": 0.9, "pitchJitter": 0.0  }
   ]
   ```
4. Optionally set `voices` (default 6) and `masterVolume` (default 0.8).

---

## Hook points (minimal, decoupled)

Each gameplay script calls a one-line `Sfx.*()` at the existing cue moment — no `AudioSource` reference,
no new fields. If `SfxPlayer` is absent every call is a no-op, so these edits are safe even before audio
is wired. Add the call **right next to the existing juice/effect call** at each site:

| Cue | Script | Site | Add |
|---|---|---|---|
| `jump` | `PlayerController` | in `FixedUpdate`, right after `velocity.y = jumpSpeed;` (the launch branch) | `Sfx.Jump();` |
| `dash` | `PlayerController` | top of `BeginDash(...)`, after `_isDashing = true;` | `Sfx.Dash();` |
| `collect` | `Collectible` | in `OnTriggerEnter2D`, alongside `SpawnPop();` on pickup | `Sfx.Collect();` |
| `hit` | `Hazard` | in `Hit(...)`, alongside `HitStop.Do(...)` / `CameraShake.Shake(...)` | `Sfx.Hit();` |
| `bounce` | `Trampoline` | in `TryBounce(...)`, after `pc.LaunchUp(bounceSpeed);` | `Sfx.Bounce();` |
| `win` | `GameManager` | in `WinLevel()`, after `isWin = true;` | `Sfx.Win();` |

Apply each with `unity_code_modify_script` (insert the single call line). Example — the jump cue:

```csharp
if (wantsJump && canJump)
{
    velocity.y = jumpSpeed;
    Sfx.Jump();                 // <-- audio hook (no-op if no SfxPlayer)
    _isJumping = true;
    // ...
}
```

> **Alternative (zero gameplay edits): SfxPlayer subscribes.** If you'd rather not touch gameplay scripts,
> have those scripts expose C# events (e.g. `Collectible.OnCollected`, `GameManager.OnWin`) and let
> `SfxPlayer` subscribe in `OnEnable`/`OnDisable`. The inline `Sfx.*()` calls above are simpler and were
> the verified path; the subscriber pattern is the choice when gameplay scripts must stay audio-agnostic.

---

## Fallback procedural SFX-gen recipe (numpy → 16-bit PCM .wav)

Generates the six retro cues **procedurally** — no samples, no downloads, CC0 by construction (same
provenance story as the PIL-generated sky/hills). Run with numpy installed
(`pip install numpy`); writes to `unity-dev-project/<project>/Assets/Audio/`. ~22050 Hz mono, 16-bit PCM
(uncompressed WAV — Unity decodes it natively, no FFmpeg/Vorbis dependency).

```python
#!/usr/bin/env python3
"""Generate retro 8-bit SFX cues as 16-bit PCM mono WAVs (CC0, procedurally generated).

Cues: jump (rising square blip), dash (downward noise sweep), collect (ascending
arpeggio), hit (noise burst), bounce (pitch-up boing), win (major-arpeggio jingle).

No external assets — every waveform is synthesized with numpy, so the output is CC0.
Usage:  python generate_sfx.py [out_dir]   (default: Assets/Audio)
"""
import math
import os
import struct
import sys
import wave

import numpy as np

SR = 22050  # sample rate (Hz) — plenty for chiptone cues, keeps files tiny


def _t(dur):
    """Time vector for `dur` seconds."""
    return np.linspace(0.0, dur, int(SR * dur), endpoint=False)


def square(freq, t, duty=0.5):
    """Band-unlimited square wave (the classic 8-bit timbre)."""
    phase = (freq * t) % 1.0
    return np.where(phase < duty, 1.0, -1.0)


def env_ad(n, attack=0.005, release=0.05):
    """Attack/decay envelope over n samples (click-free, fades to 0)."""
    a = max(1, int(attack * SR))
    r = max(1, int(release * SR))
    e = np.ones(n)
    e[:a] = np.linspace(0.0, 1.0, a)
    e[-r:] = np.linspace(1.0, 0.0, r)
    return e


def to_pcm16(sig):
    """Normalize to ~-1 dBFS and convert float [-1,1] -> int16."""
    peak = np.max(np.abs(sig)) or 1.0
    sig = (sig / peak) * 0.89
    return np.clip(sig * 32767.0, -32768, 32767).astype(np.int16)


def write_wav(path, sig):
    pcm = to_pcm16(sig)
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)        # 16-bit
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    print(f"wrote {path}  ({len(pcm)} samples, {len(pcm)/SR*1000:.0f} ms)")


# ---- cue synths ----

def jump():
    """Rising square blip — a quick upward pitch slide."""
    dur = 0.16
    t = _t(dur)
    freq = np.linspace(330.0, 880.0, len(t))   # A4 -> A5 sweep up
    sig = square(freq, t, duty=0.5) * env_ad(len(t), 0.002, 0.06)
    return sig


def dash():
    """Downward noise sweep / whoosh — filtered white noise gliding down."""
    dur = 0.22
    t = _t(dur)
    noise = np.random.uniform(-1.0, 1.0, len(t))
    # one-pole low-pass whose cutoff falls over time -> 'whoosh down'
    cut = np.linspace(0.9, 0.08, len(t))
    out = np.zeros(len(t))
    prev = 0.0
    for i in range(len(t)):
        prev = prev + cut[i] * (noise[i] - prev)
        out[i] = prev
    return out * env_ad(len(t), 0.002, 0.1)


def collect():
    """Short ascending arpeggio — a bright pickup sparkle (C5-E5-G5-C6)."""
    notes = [523.25, 659.25, 783.99, 1046.50]
    step = 0.045
    seg = []
    for f in notes:
        t = _t(step)
        seg.append(square(f, t, duty=0.5) * env_ad(len(t), 0.002, 0.02))
    return np.concatenate(seg)


def hit():
    """Noise burst — a harsh, short impact."""
    dur = 0.18
    t = _t(dur)
    noise = np.random.uniform(-1.0, 1.0, len(t))
    # fast exponential decay for a punchy thwack
    decay = np.exp(-t * 28.0)
    tone = square(110.0, t, duty=0.5) * 0.4   # low square adds body
    return (noise * decay) + tone * decay


def bounce():
    """Boing / pitch-up — a fast upward portamento with a little wobble."""
    dur = 0.2
    t = _t(dur)
    base = np.linspace(220.0, 760.0, len(t))
    wobble = 30.0 * np.sin(2 * math.pi * 18.0 * t)
    sig = square(base + wobble, t, duty=0.5) * env_ad(len(t), 0.002, 0.08)
    return sig


def win():
    """Short major-arpeggio jingle — C-E-G-C with a held final note."""
    notes = [(523.25, 0.10), (659.25, 0.10), (783.99, 0.10), (1046.50, 0.30)]
    seg = []
    for f, d in notes:
        t = _t(d)
        # two stacked squares (octave) for a fuller fanfare
        v = square(f, t, 0.5) * 0.6 + square(f * 2, t, 0.5) * 0.25
        seg.append(v * env_ad(len(t), 0.003, min(0.08, d * 0.4)))
    return np.concatenate(seg)


CUES = {
    "jump": jump,
    "dash": dash,
    "collect": collect,
    "hit": hit,
    "bounce": bounce,
    "win": win,
}


def main():
    np.random.seed(7)  # deterministic noise cues across runs
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "Assets/Audio"
    os.makedirs(out_dir, exist_ok=True)
    for name, fn in CUES.items():
        write_wav(os.path.join(out_dir, f"{name}.wav"), fn())


if __name__ == "__main__":
    main()
```

Run it pointing at the project's audio folder, then refresh assets:

```
python generate_sfx.py unity-dev-project/<project>/Assets/Audio
# then in Unity: unity_editor_refresh_assets  (so the .wav files import as AudioClips)
```

### Unity import settings (short SFX)

For tiny one-shot cues, set the `AudioImporter` so playback is instant and unstreamed:
- **Load Type = Decompress On Load** (decoded into memory once; lowest play latency).
- **Compression Format = PCM** (already uncompressed; keeps the cue sample-accurate. ADPCM is fine if you
  want smaller files, but PCM is the safe default for sub-second cues).
- **Preload Audio Data = on**, **Load In Background = off**, **streaming = off** — never stream a short SFX.
- **Force To Mono** if the importer defaults to stereo (these are mono already).

Apply via the `AudioImporter` (e.g. an editor script setting `defaultSampleSettings.loadType =
AudioClipLoadType.DecompressOnLoad` + `compressionFormat = AudioCompressionFormat.PCM`,
`preloadAudioData = true`, `loadInBackground = false`, then `AssetImporter.SaveAndReimport()`), or set
them in the inspector. The defaults are usually acceptable; the load-on-decompress + no-streaming points
are the ones that matter for latency.

---

## Verification (LIGHT — reuse existing machinery, no new gate)

Two cheap checks, both reusing machinery that already exists:

**1. Presence — the existing `manifest` gate.** The acceptance contract lists `SfxPlayer` as a required
manifest element (`{ "nameRegex": "SfxPlayer", "type": "GameObject", "primitive": "audio", "required":
true }`) and the `audio` block enumerates the six cues + `playerComponent: "SfxPlayer"`. The manifest gate
(`unity_scene_verify_manifest`) confirms the `SfxPlayer` GameObject is present in-scene — no new gate
needed. (The `.wav` clips are project assets, not scene objects, so they are covered by the audio block +
the runtime assertion below rather than by the scene-object manifest match.)

**2. A cue actually fired — a runtime assertion.** `SfxPlayer.PlayCount` is a public **instance** field on
the `/SfxPlayer` object, so `unity_runtime_assert_condition` reads it directly (it reads instance fields on
a locatable GameObject, not statics). After driving a collect or a jump, assert the count rose:

```
# Enter play, baseline, drive a collect (or jump) with unity_runtime_probe, then:
unity_runtime_assert_condition
  locator:    { path: "/SfxPlayer" }
  component:  "SfxPlayer"
  expression: "PlayCount > 0"
# Per-cue (optional): drive the collect, then assert the collect cue specifically fired.
# PlayCountFor("collect") is a method, so prefer the instance PlayCount field for a direct
# field read; use the per-cue count when you've driven exactly one cue type.
```

Drive the sim with `unity_runtime_probe` (physics timeline), never real-time waits — the sim freezes when
the editor is backgrounded (see `verify-2d-game/references/playability-checks.md`). This mirrors the
existing `collectibleIncrements` recipe (read `score`, drive over a fruit, assert it incremented) — here
you additionally assert `SfxPlayer.PlayCount` rose on the same drive.

> Keep it to manifest-presence + one runtime assertion. A dedicated audio gate is **not** warranted: there
> is no microphone capture in the bridge, and `PlayCount` already proves a cue fired through the real code
> path (resilient no-op behavior means a missing clip would leave the count at 0 → the assertion fails,
> catching an unwired cue).
