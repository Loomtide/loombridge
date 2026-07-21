import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fetchAuthOptionsForUrl, type FetchAuthOptions } from "../http-auth.js";
import type { AssetFile, AssetRegistryEntry } from "../types.js";
import type { AssetProviderAdapter, AssetProviderRequest, AssetProviderResolution } from "./types.js";

type FetchWithInit = (url: string, init?: FetchAuthOptions) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: {
    get(name: string): string | null;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

type DnsResolver = (hostname: string) => Promise<Array<{ address: string }>>;

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.startsWith("::ffff:")) return true;
  if (host === "localhost" || host === "0.0.0.0" || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  if (match) {
    const octet = Number(match[1]);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

async function assertPublicEndpoint(url: URL, resolver: DnsResolver): Promise<void> {
  if (isBlockedHost(url.hostname)) {
    throw new Error("private or local host is not allowed");
  }
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    return;
  }

  const addresses = await resolver(url.hostname);
  if (addresses.some((address) => isBlockedHost(address.address))) {
    throw new Error("host resolves to a private or local address");
  }
}

function validateDownloadUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    if (isBlockedHost(url.hostname)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function fetchWithTimeout(
  fetchImpl: FetchWithInit,
  url: string,
  init: FetchAuthOptions,
): ReturnType<FetchWithInit> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export class HttpAssetProvider implements AssetProviderAdapter {
  readonly name = "http";

  constructor(
    private readonly fetchImpl: FetchWithInit = fetch as unknown as FetchWithInit,
    private readonly authToken?: string,
    private readonly resolver: DnsResolver = async (hostname) => dns.lookup(hostname, { all: true }),
  ) {}

  canResolve(entry: AssetRegistryEntry, file: AssetFile): boolean {
    return entry.provider.type === "http" || Boolean(file.url);
  }

  async resolve(request: AssetProviderRequest): Promise<AssetProviderResolution> {
    if (!request.file.url) {
      return {
        status: "rejected",
        cachePath: request.cachePath,
        cacheStatus: "skipped",
        diagnostics: [{
          code: "PROVIDER_SOURCE_MISSING",
          message: "HTTP asset provider requires file.url.",
          path: "files[0].url",
        }],
      };
    }

    const url = validateDownloadUrl(request.file.url);
    if (!url) {
      return {
        status: "rejected",
        cachePath: request.cachePath,
        cacheStatus: "skipped",
        diagnostics: [{
          code: "PROVIDER_DOWNLOAD_FAILED",
          message: "HTTP asset provider only downloads from public http(s) URLs.",
          path: "files[0].url",
        }],
      };
    }

    try {
      await assertPublicEndpoint(url, this.resolver);
    } catch (error) {
      return {
        status: "rejected",
        cachePath: request.cachePath,
        cacheStatus: "skipped",
        diagnostics: [{
          code: "PROVIDER_DOWNLOAD_FAILED",
          message: `HTTP asset provider rejected ${url.toString()}: ${error instanceof Error ? error.message : String(error)}.`,
          path: "files[0].url",
        }],
      };
    }

    await fs.mkdir(path.dirname(request.cachePath), { recursive: true });
    if (await fileExists(request.cachePath)) {
      return {
        status: "resolved",
        cachePath: request.cachePath,
        cacheStatus: "hit",
        diagnostics: [],
      };
    }

    try {
      const authOptions = fetchAuthOptionsForUrl(url.toString(), this.authToken) ?? {};
      const response = await fetchWithTimeout(this.fetchImpl, url.toString(), {
        ...authOptions,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        return {
          status: "rejected",
          cachePath: request.cachePath,
          cacheStatus: "miss",
          diagnostics: [{
            code: "PROVIDER_DOWNLOAD_FAILED",
            message: `Download redirect is not followed for ${url.toString()}: HTTP ${response.status}`,
            path: "files[0].url",
          }],
        };
      }
      if (!response.ok) {
        return {
          status: "rejected",
          cachePath: request.cachePath,
          cacheStatus: "miss",
          diagnostics: [{
            code: "PROVIDER_DOWNLOAD_FAILED",
            message: `Download failed for ${url.toString()}: HTTP ${response.status}`,
            path: "files[0].url",
          }],
        };
      }
      const contentLength = response.headers?.get("content-length");
      if (contentLength && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
        return {
          status: "rejected",
          cachePath: request.cachePath,
          cacheStatus: "miss",
          diagnostics: [{
            code: "PROVIDER_DOWNLOAD_FAILED",
            message: `Download too large for ${url.toString()}: ${contentLength} bytes exceeds ${MAX_DOWNLOAD_BYTES}.`,
            path: "files[0].url",
          }],
        };
      }

      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength > MAX_DOWNLOAD_BYTES) {
        return {
          status: "rejected",
          cachePath: request.cachePath,
          cacheStatus: "miss",
          diagnostics: [{
            code: "PROVIDER_DOWNLOAD_FAILED",
            message: `Download too large for ${url.toString()}: ${body.byteLength} bytes exceeds ${MAX_DOWNLOAD_BYTES}.`,
            path: "files[0].url",
          }],
        };
      }
      await fs.writeFile(request.cachePath, body);
      return {
        status: "resolved",
        cachePath: request.cachePath,
        cacheStatus: "miss",
        diagnostics: [],
        metadata: { url: url.toString() },
      };
    } catch (error) {
      return {
        status: "rejected",
        cachePath: request.cachePath,
        cacheStatus: "miss",
        diagnostics: [{
          code: "PROVIDER_DOWNLOAD_FAILED",
          message: error instanceof Error ? error.message : String(error),
          path: "files[0].url",
        }],
      };
    }
  }
}
