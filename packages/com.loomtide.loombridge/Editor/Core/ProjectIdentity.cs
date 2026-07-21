using System;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace UnityBridge.Core
{
    /// <summary>
    /// Stable project identity used by MCP-side routing. SessionId changes on domain reload;
    /// the canonical project path is the durable editor target.
    /// </summary>
    public static class ProjectIdentity
    {
        public static JObject ToJson()
        {
            string projectPath = GetProjectPath();
            return new JObject
            {
                ["projectPath"] = projectPath,
                ["projectPathCanonical"] = CanonicalizePath(projectPath),
                ["projectName"] = GetProjectName(projectPath),
                ["processId"] = GetProcessId()
            };
        }

        private static string GetProjectPath()
        {
            try
            {
                return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
            }
            catch
            {
                return Application.dataPath ?? string.Empty;
            }
        }

        private static string CanonicalizePath(string path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return string.Empty;
            }

            try
            {
                return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
            catch
            {
                return path.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
        }

        private static string GetProjectName(string projectPath)
        {
            string canonical = CanonicalizePath(projectPath);
            if (string.IsNullOrWhiteSpace(canonical))
            {
                return string.Empty;
            }

            try
            {
                return new DirectoryInfo(canonical).Name;
            }
            catch
            {
                return string.Empty;
            }
        }

        private static int GetProcessId()
        {
            try
            {
                return System.Diagnostics.Process.GetCurrentProcess().Id;
            }
            catch
            {
                return 0;
            }
        }
    }
}
