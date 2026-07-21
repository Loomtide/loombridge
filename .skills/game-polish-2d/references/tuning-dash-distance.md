# Tuning Config: dashDistance

Template for tuning `dashSpeed` on `PlatformerPlayerController`. Run only after project
`fixedDeltaTime` is set to the contract value, usually `0.0166667`.

```json
{
  "schemaVersion": "1",
  "id": "platformer-dash-distance",
  "metricId": "dashDistance",
  "mutation": {
    "locator": { "path": "/Player" },
    "type_name": "PlatformerPlayerController",
    "property_path": "dashSpeed"
  },
  "candidates": [17.5, 18.0, 18.75, 19.25, 19.75],
  "measurement": {
    "command": "runtime.measure_motion",
    "params": {
      "locator": { "path": "/Player" },
      "durationMs": 350,
      "captureFps": 60,
      "includeSamples": true
    },
    "resultPath": "dashDistance",
    "timeoutMs": 5000
  },
  "replay": {
    "beforeMeasure": [
      {
        "command": "runtime.probe",
        "params": {
          "locator": { "path": "/Player" },
          "property_path": "forceDash",
          "phases": [
            { "value": 1, "durationMs": 30 },
            { "value": 0, "durationMs": 320 }
          ]
        }
      }
    ],
    "waitFramesAfterReplay": 2
  }
}
```
