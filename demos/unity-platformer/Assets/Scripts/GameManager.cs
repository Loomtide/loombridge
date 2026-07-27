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
