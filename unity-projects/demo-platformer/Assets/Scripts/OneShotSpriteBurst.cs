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
