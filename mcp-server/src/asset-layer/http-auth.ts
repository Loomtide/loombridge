export interface FetchAuthOptions {
  headers?: Record<string, string>;
  redirect?: "follow" | "manual" | "error";
  signal?: AbortSignal;
}

const githubHosts = new Set(["github.com", "raw.githubusercontent.com", "api.github.com"]);

function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.LOOMTIDE_ASSET_REGISTRY_TOKEN ?? env.GITHUB_TOKEN ?? env.GH_TOKEN;
}

function isGitHubUrl(url: string): boolean {
  try {
    return githubHosts.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function fetchAuthOptionsForUrl(url: string, token = githubTokenFromEnv()): FetchAuthOptions | undefined {
  if (!token || !isGitHubUrl(url)) {
    return undefined;
  }

  return {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}
