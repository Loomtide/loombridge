using UnityEngine;
using TMPro;

/// <summary>
/// Reusable HUD presentation component for 2D demo games.
/// Owns all on-screen text presentation (score, lives, centered message).
/// Game logic (e.g. GameManager) calls into this; it never reaches into the HUD's
/// individual labels directly.
///
/// Wire the three TMP_Text fields in the inspector (or via
/// unity_component_set_property object-reference values).
/// </summary>
public class HudController : MonoBehaviour
{
    [Header("Label References (wire to TMP_Text objects)")]
    public TMP_Text scoreLabel;
    public TMP_Text livesLabel;
    public TMP_Text messageLabel;
    public TMP_Text timerLabel;

    /// <summary>Update the score readout. Styled like the hero-shot fruit counter:
    /// "x04 /12".</summary>
    public void SetScore(int score, int total)
    {
        if (scoreLabel != null)
        {
            scoreLabel.text = $"x{score:00} <size=70%>/{total}</size>";
        }
    }

    /// <summary>Update the lives readout as heart pips, e.g. "♥ ♥ ♡".</summary>
    public void SetLives(int lives)
    {
        if (livesLabel != null)
        {
            int max = 3;
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < max; i++)
            {
                sb.Append(i < lives ? '♥' : '♡'); // filled / empty heart
                if (i < max - 1) sb.Append(' ');
            }
            livesLabel.text = sb.ToString();
        }
    }

    /// <summary>Update the run timer readout as mm:ss:ff.</summary>
    public void SetTimer(float seconds)
    {
        if (timerLabel == null) return;
        int m = (int)(seconds / 60f);
        int s = (int)(seconds % 60f);
        int ff = (int)((seconds * 100f) % 100f);
        timerLabel.text = $"{m:00}:{s:00}:{ff:00}";
    }

    /// <summary>Show a centered message (e.g. "YOU WIN!" / "GAME OVER"). Pass "" to clear.</summary>
    public void ShowMessage(string msg)
    {
        if (messageLabel != null)
        {
            messageLabel.text = msg;
        }
    }
}
