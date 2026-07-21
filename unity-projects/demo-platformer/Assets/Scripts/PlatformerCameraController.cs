using UnityEngine;

public class PlatformerCameraController : MonoBehaviour
{
    public Transform target;
    [SerializeField] private float orthographicSize = 2.1f;
    [SerializeField] private Vector2 deadZone = new Vector2(0.25f, 0.7f);
    [SerializeField] private Vector2 lookAhead = new Vector2(1f, 0.15f);
    [SerializeField] private Vector2 framingOffset = new Vector2(0f, -0.25f);
    [SerializeField] private Vector2 damping = new Vector2(0.12f, 0.18f);
    [Tooltip("Target speed at which look-ahead reaches full magnitude.")]
    [SerializeField] private float lookAheadSpeed = 6f;
    [Tooltip("Seconds to ease the look-ahead in/out so it never snaps on a direction change.")]
    [SerializeField] private float lookAheadSmoothing = 0.2f;
    [SerializeField] private bool useBounds = true;
    [SerializeField] private Vector2 minBounds = new Vector2(-9.5f, -3.6f);
    [SerializeField] private Vector2 maxBounds = new Vector2(9.5f, 4.4f);
    private Camera cam;
    private Rigidbody2D targetBody;
    private Vector2 smoothVelocity;
    private Vector2 currentLookAhead;
    private Vector2 lookAheadDampVelocity;
    private Vector3 previousTargetPosition;
    private void Awake() {
        cam = GetComponent<Camera>();
        if (cam != null) {
            cam.orthographic = true;
            cam.orthographicSize = orthographicSize;
        }
    }
    private void Start() {
        if (target == null) {
            GameObject player = GameObject.Find("Player");
            if (player != null) target = player.transform;
        }
        if (target != null) {
            targetBody = target.GetComponent<Rigidbody2D>();
            previousTargetPosition = target.position;
            SnapToTarget();
        }
    }
    private void LateUpdate() {
        if (target == null) return;
        if (cam != null && Mathf.Abs(cam.orthographicSize - orthographicSize) > 0.001f) cam.orthographicSize = orthographicSize;
        Vector3 current = transform.position;
        Vector3 desired = current;
        Vector3 rawTargetPosition = target.position;
        Vector3 targetPosition = rawTargetPosition + (Vector3)framingOffset;
        Vector2 delta = targetPosition - current;
        if (Mathf.Abs(delta.x) > deadZone.x) desired.x = targetPosition.x - Mathf.Sign(delta.x) * deadZone.x;
        if (Mathf.Abs(delta.y) > deadZone.y) desired.y = targetPosition.y - Mathf.Sign(delta.y) * deadZone.y;
        // Velocity-proportional look-ahead, smoothed. Proportional (not Mathf.Sign) so it
        // passes smoothly through zero: at rest the look-ahead is 0 (no left/right bias),
        // and stopping from either direction relaxes it symmetrically. The previous
        // Mathf.Sign(velocity) * lookAhead snapped to +1 even at rest (Mathf.Sign(0) == 1),
        // which biased the camera right and made a left-then-stop lurch ~2x farther than a
        // right-then-stop (the asymmetric "spring" on the left).
        Vector2 velocity = ReadTargetVelocity(rawTargetPosition);
        float refSpeed = Mathf.Max(0.01f, lookAheadSpeed);
        Vector2 targetLookAhead = new Vector2(
            Mathf.Clamp(velocity.x / refSpeed, -1f, 1f) * lookAhead.x,
            Mathf.Clamp(velocity.y / refSpeed, -1f, 1f) * lookAhead.y);
        float lookAheadTime = Mathf.Max(0.001f, lookAheadSmoothing);
        currentLookAhead.x = Mathf.SmoothDamp(currentLookAhead.x, targetLookAhead.x, ref lookAheadDampVelocity.x, lookAheadTime);
        currentLookAhead.y = Mathf.SmoothDamp(currentLookAhead.y, targetLookAhead.y, ref lookAheadDampVelocity.y, lookAheadTime);
        desired.x += currentLookAhead.x;
        desired.y += currentLookAhead.y;
        desired.z = -10f;
        desired = ClampToBounds(desired);
        current.x = Mathf.SmoothDamp(current.x, desired.x, ref smoothVelocity.x, Mathf.Max(0.001f, damping.x));
        current.y = Mathf.SmoothDamp(current.y, desired.y, ref smoothVelocity.y, Mathf.Max(0.001f, damping.y));
        current.z = desired.z;
        transform.position = current;
        previousTargetPosition = rawTargetPosition;
    }
    private void SnapToTarget() {
        Vector3 next = target.position + (Vector3)framingOffset;
        next.z = -10f;
        transform.position = ClampToBounds(next);
    }
    private Vector2 ReadTargetVelocity(Vector3 targetPosition) {
        if (targetBody != null) {
#if UNITY_6000_0_OR_NEWER
            return targetBody.linearVelocity;
#else
            return targetBody.velocity;
#endif
        }
        if (Time.deltaTime <= 0f) return Vector2.zero;
        return (targetPosition - previousTargetPosition) / Time.deltaTime;
    }
    private Vector3 ClampToBounds(Vector3 value) {
        if (!useBounds || cam == null) return value;
        float halfHeight = cam.orthographicSize;
        float halfWidth = halfHeight * cam.aspect;
        value.x = ClampCenter(value.x, minBounds.x, maxBounds.x, halfWidth);
        value.y = ClampCenter(value.y, minBounds.y, maxBounds.y, halfHeight);
        return value;
    }
    private static float ClampCenter(float value, float min, float max, float extent) {
        float low = min + extent;
        float high = max - extent;
        if (low > high) return (min + max) * 0.5f;
        return Mathf.Clamp(value, low, high);
    }
}
