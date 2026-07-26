/**
 * TraceRecorder — JSONL trace logging with artifact storage.
 *
 * Records all ops to `trace/trace-{sessionId}.jsonl` and handles:
 * - Base64 image redaction (replaces blobs with artifact file references)
 * - Unity artifact ingestion (copies source files into trace/artifacts/)
 * - Lazy directory creation (no disk writes until first record)
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface TraceEntry {
  timestamp: number;
  sessionId: string;
  type: "op" | "connect" | "disconnect" | "error";
  op?: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  durationMs?: number;
  projectPathCanonical?: string;
  projectName?: string;
  editorSessionId?: string;
  processId?: number;
  consoleDelta?: Array<{ type: string; message: string; stackTrace?: string }>;
  artifacts?: string[];
  inputDiagnostics?: {
    action: string;
    backend?: string;
    sessionId?: string;
    key?: string;
    errorCode?: string;
  };
}

export interface ArtifactDescriptor {
  kind: "screenshot" | "file";
  sourcePath?: string;
  format?: "jpeg" | "png";
  width?: number;
  height?: number;
  sizeBytes?: number;
  description?: string;
}

// ─────────────────────────────────────────────
// TraceRecorder
// ─────────────────────────────────────────────

export class TraceRecorder {
  private _traceDir: string;
  private _sessionId: string = "unknown";
  private _dirsCreated = false;

  constructor(traceDir: string = "./trace") {
    this._traceDir = traceDir;
  }

  /** Where traces and artifacts are written. Reported at boot so it is never a mystery. */
  get traceDirectory(): string {
    return this._traceDir;
  }

  /** The current session ID. */
  get sessionId(): string {
    return this._sessionId;
  }

  /** Set the session ID (called after handshake). Names the JSONL file. */
  setSessionId(id: string): void {
    this._sessionId = id;
  }

  /**
   * Record a trace entry. Appends one JSON line to the JSONL file.
   * If the output contains `image_base64`, it is redacted and saved as an artifact.
   */
  async record(entry: TraceEntry): Promise<void> {
    await this._ensureDirs();

    // Clone entry to avoid mutating the original
    const recorded: Record<string, unknown> = { ...entry };

    // Handle base64 redaction for screenshot output
    if (entry.output && typeof entry.output === "object" && "image_base64" in entry.output) {
      const output = { ...entry.output };
      const base64Data = output.image_base64 as string;
      const format = (output.format as string) || "png";
      const ext = format === "jpeg" ? ".jpg" : ".png";

      // Generate artifact filename
      const opShort = (entry.op || "unknown").replace(/\./g, "_");
      const artifactName = `screenshot_${entry.timestamp}_${opShort}${ext}`;
      const artifactRelPath = `artifacts/${artifactName}`;

      // Write artifact file
      const artifactFullPath = path.join(this._traceDir, artifactRelPath);
      await this._ensureArtifactsDir();
      await fsp.writeFile(artifactFullPath, Buffer.from(base64Data, "base64"));

      // Replace base64 with reference
      delete output.image_base64;
      output.artifactRef = artifactRelPath;
      recorded.output = output;
    }

    const inputDiagnostics = this._deriveInputDiagnostics(entry, recorded);
    if (inputDiagnostics) {
      recorded.inputDiagnostics = inputDiagnostics;
    }

    // Write JSONL line
    const filePath = this._getTraceFilePath();
    const line = JSON.stringify(recorded) + "\n";
    await fsp.appendFile(filePath, line, "utf-8");
  }

  /**
   * Ingest artifacts from Unity (copy source files into trace/artifacts/).
   * Returns array of relative paths for successfully ingested artifacts.
   * Missing source files are skipped with a console warning.
   */
  async ingestArtifacts(descriptors: ArtifactDescriptor[]): Promise<string[]> {
    await this._ensureDirs();
    await this._ensureArtifactsDir();

    const results: string[] = [];

    for (const desc of descriptors) {
      if (!desc.sourcePath) continue;

      try {
        // Check if source file exists
        await fsp.access(desc.sourcePath, fs.constants.R_OK);

        // Generate destination filename
        const ext = path.extname(desc.sourcePath) || this._formatToExt(desc.format);
        const baseName = path.basename(desc.sourcePath, path.extname(desc.sourcePath));
        const timestamp = Date.now();
        const destName = `${baseName}_${timestamp}${ext}`;
        const destRelPath = `artifacts/${destName}`;
        const destFullPath = path.join(this._traceDir, destRelPath);

        await fsp.copyFile(desc.sourcePath, destFullPath);
        results.push(destRelPath);
      } catch (err) {
        // Log warning and skip missing files
        console.warn(
          `[TraceRecorder] Failed to ingest artifact from ${desc.sourcePath}: ${(err as Error).message}`
        );
      }
    }

    return results;
  }

  // ─────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────

  private _getTraceFilePath(): string {
    return path.join(this._traceDir, `trace-${this._sessionId}.jsonl`);
  }

  /** Lazily create the trace directory. */
  private async _ensureDirs(): Promise<void> {
    if (this._dirsCreated) return;
    await fsp.mkdir(this._traceDir, { recursive: true });
    this._dirsCreated = true;
  }

  /** Ensure the artifacts subdirectory exists. */
  private async _ensureArtifactsDir(): Promise<void> {
    const artifactsDir = path.join(this._traceDir, "artifacts");
    await fsp.mkdir(artifactsDir, { recursive: true });
  }

  /** Map format string to file extension. */
  private _formatToExt(format?: string): string {
    if (format === "jpeg") return ".jpg";
    if (format === "png") return ".png";
    return "";
  }

  private _deriveInputDiagnostics(
    entry: TraceEntry,
    recorded: Record<string, unknown>,
  ): TraceEntry["inputDiagnostics"] | undefined {
    if (!entry.op?.startsWith("input.")) {
      return undefined;
    }

    const input = this._asRecord(entry.input);
    const output = this._asRecord(recorded.output);
    const error = this._asRecord(entry.error);

    const action = entry.op.slice("input.".length);
    const backend = this._stringOrUndefined(output?.backend) ?? this._stringOrUndefined(input?.backend);
    const sessionId = this._stringOrUndefined(output?.sessionId) ?? this._stringOrUndefined(input?.sessionId);
    const key = this._stringOrUndefined(output?.key) ?? this._stringOrUndefined(input?.key);
    const errorCode = this._stringOrUndefined(error?.code);

    return {
      action,
      backend,
      sessionId,
      key,
      errorCode,
    };
  }

  private _asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
    return undefined;
  }

  private _stringOrUndefined(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
  }
}
