# Tuning Config: runSpeed

Template for `verification/tuning-runner.ts`. Fill locators if the player is not at `/Player`.

```json
{
  "schemaVersion": "1",
  "id": "platformer-run-speed",
  "metricId": "runSpeed",
  "mutation": {
    "locator": { "path": "/Player" },
    "type_name": "PlatformerPlayerController",
    "property_path": "moveSpeed"
  },
  "candidates": [6.4, 6.7, 7.0, 7.3, 7.6],
  "measurement": {
    "command": "runtime.measure_motion",
    "params": {
      "locator": { "path": "/Player" },
      "durationMs": 900,
      "captureFps": 60
    },
    "resultPath": "runSpeed",
    "timeoutMs": 5000
  },
  "replay": {
    "beforeMeasure": [
      {
        "command": "runtime.probe",
        "params": {
          "locator": { "path": "/Player" },
          "property_path": "forceHorizontal",
          "phases": [
            { "value": 1, "durationMs": 900 },
            { "value": 0, "durationMs": 100 }
          ]
        }
      }
    ],
    "waitFramesAfterReplay": 2
  }
}
```
