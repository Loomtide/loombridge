using System.Runtime.CompilerServices;

// Grant the EditMode test assembly access to internal members (e.g. the pure helpers
// UIScreenSpaceIntrospection.SelectReferenceFrame and ScreenshotCapture.CollectActiveOverlayRootCanvases
// that are unit-tested without exposing them on the public bridge surface).
[assembly: InternalsVisibleTo("com.loomtide.unitybridge.tests")]
