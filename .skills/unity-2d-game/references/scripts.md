# Script Templates (Unity 6000.3 + 2022.3 Compatible)

These scripts have been validated end-to-end through Loombridge MCP.

## PlayerController.cs

```csharp
using UnityEngine;
using UnityEngine.InputSystem;

public class PlayerController : MonoBehaviour
{
    [Header("Movement")]
    [SerializeField] private float moveSpeed = 6f;
    [SerializeField] private float jumpSpeed = 12f;

    [Header("Ground Check")]
    [SerializeField] private float groundCheckDistance = 0.15f;
    [SerializeField] private LayerMask groundLayers = ~0;

    [Header("Detection (name-prefix, no tags needed)")]
    [SerializeField] private string enemyNamePrefix = "Enemy";
    [SerializeField] private string coinNamePrefix = "Coin";

    [Header("References")]
    public GameManager gameManager;

    private Rigidbody2D rb;
    private Vector3 spawnPoint;
    private bool facingRight = true;
    private bool prevJumpHeld;

    private void Awake()
    {
        rb = GetComponent<Rigidbody2D>();
    }

    private void Start()
    {
        spawnPoint = transform.position;
        if (gameManager == null)
        {
            gameManager = GameManager.Instance;
        }
    }

    private void Update()
    {
        float moveInput = ReadHorizontal();
        Vector2 velocity = ReadVelocity();
        velocity.x = moveInput * moveSpeed;

        if (ReadJumpPressed() && IsGrounded())
        {
            velocity.y = jumpSpeed;
        }

        WriteVelocity(velocity);

        if (moveInput > 0 && !facingRight) Flip();
        else if (moveInput < 0 && facingRight) Flip();
    }

    private float ReadHorizontal()
    {
        Keyboard kb = Keyboard.current;
        if (kb == null) return 0f;
        float input = 0f;
        if (kb.leftArrowKey.isPressed || kb.aKey.isPressed) input -= 1f;
        if (kb.rightArrowKey.isPressed || kb.dKey.isPressed) input += 1f;
        return Mathf.Clamp(input, -1f, 1f);
    }

    private bool ReadJumpPressed()
    {
        Keyboard kb = Keyboard.current;
        bool jumpHeld = kb != null && (kb.spaceKey.isPressed || kb.upArrowKey.isPressed || kb.wKey.isPressed);
        bool pressed = jumpHeld && !prevJumpHeld;
        prevJumpHeld = jumpHeld;
        return pressed;
    }

    private bool IsGrounded()
    {
        Vector2 origin = (Vector2)transform.position + Vector2.down * 0.4f;
        RaycastHit2D hit = Physics2D.Raycast(origin, Vector2.down, groundCheckDistance, groundLayers);
        return hit.collider != null && hit.collider.gameObject != gameObject;
    }

    private void Flip()
    {
        facingRight = !facingRight;
        Vector3 scale = transform.localScale;
        scale.x = Mathf.Abs(scale.x) * (facingRight ? 1f : -1f);
        transform.localScale = scale;
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
}
```

## EnemyPatrol.cs

```csharp
using UnityEngine;

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
}
```

## GameManager.cs

```csharp
using UnityEngine;
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
}
```

## Wiring UI References via MCP

After creating the GameManager object and attaching the script, wire the UI Text references:

```
unity_component_set_property:
  locator: { path: "/GameManager" }
  type_name: "GameManager"
  property_path: "scoreText"
  value: { locator: { path: "/Canvas/ScoreText" } }

unity_component_set_property:
  locator: { path: "/GameManager" }
  type_name: "GameManager"
  property_path: "livesText"
  value: { locator: { path: "/Canvas/LivesText" } }

unity_component_set_property:
  locator: { path: "/GameManager" }
  type_name: "GameManager"
  property_path: "messageText"
  value: { locator: { path: "/Canvas/MessageText" } }

unity_component_set_property:
  locator: { path: "/Player" }
  type_name: "PlayerController"
  property_path: "gameManager"
  value: { locator: { path: "/GameManager" } }
```

## Notes

- If you prefer tag-based logic, add tags first and switch name-prefix checks to `CompareTag`.
- Keep the `ReadVelocity` / `WriteVelocity` wrappers when editing player motion code.
- The GameManager uses public fields for `score`/`lives`/`isWin`/`isGameOver` so `unity_runtime_wait_for_condition` can read them.
- `Time.timeScale = 0f` is intentionally omitted — it freezes the editor loop and blocks MCP-driven verification.
