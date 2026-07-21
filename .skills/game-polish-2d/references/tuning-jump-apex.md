# Tuning Config: jumpApex

Template for tuning `jumpSpeed` on `PlatformerPlayerController`.

```json
{
  "schemaVersion": "1",
  "id": "platformer-jump-apex",
  "metricId": "jumpApex",
  "mutation": {
    "locator": { "path": "/Player" },
    "type_name": "PlatformerPlayerController",
    "property_path": "jumpSpeed"
  },
  "candidates": [13.6, 13.9, 14.22, 14.5, 14.8],
  "measurement": {
    "command": "runtime.measure_motion",
    "params": {
      "locator": { "path": "/Player" },
      "durationMs": 1000,
      "captureFps": 60,
      "includeSamples": true
    },
    "resultPath": "jumpApex",
    "timeoutMs": 5000
  },
  "replay": {
    "beforeMeasure": [
      {
        "command": "runtime.probe",
        "params": {
          "locator": { "path": "/Player" },
          "property_path": "forceJump",
          "phases": [
            { "value": 1, "durationMs": 50 },
            { "value": 0, "durationMs": 950 }
          ]
        }
      }
    ],
    "waitFramesAfterReplay": 2
  }
}
```
