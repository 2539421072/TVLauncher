using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TVLauncher.Host;

/// <summary>
/// Backs up and restores everything the user has customised.
///
/// The things worth protecting are exactly the things that are tedious to redo: which apps are on
/// the launcher, the pictures and colours chosen for each card, the wallpaper and the layout
/// settings. All of it lives under one folder, so a backup is a zip of that folder.
///
/// Backups are written to Documents rather than into the launcher's own folder: a backup stored
/// beside the data it protects is lost along with it.
/// </summary>
internal static class BackupService
{
    private static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TVLauncher2");

    /// <summary>User data worth keeping. Screenshots and logs are not included.</summary>
    private static readonly string[] IncludedFolders =
    {
        "Apps", "Icons", "Wallpapers", "CardArt", "CardIcons"
    };

    private static readonly string[] IncludedFiles = { "config.json" };

    /// <summary>Where backups are written.</summary>
    public static string BackupFolder
    {
        get
        {
            var documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            return Path.Combine(documents, "TVLauncher 备份");
        }
    }

    /// <summary>
    /// Creates a backup and returns its path.
    ///
    /// The zip contains a manifest with the app count and the number of customised pictures, so a
    /// backup can be told apart from an empty one without opening it.
    /// </summary>
    public static object Create(JsonNode? args)
    {
        var note = args?["note"]?.GetValue<string>();

        try
        {
            Directory.CreateDirectory(BackupFolder);

            var stamp = DateTime.Now.ToString("yyyy-MM-dd HHmmss");
            var target = Path.Combine(BackupFolder, $"TVLauncher {stamp}.zip");

            // Never overwrite: two backups in the same second would silently lose one.
            var unique = 2;
            while (File.Exists(target))
            {
                target = Path.Combine(BackupFolder, $"TVLauncher {stamp} ({unique++}).zip");
            }

            var counts = new Dictionary<string, int>();

            using (var stream = File.Create(target))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Create))
            {
                foreach (var file in IncludedFiles)
                {
                    var path = Path.Combine(Root, file);
                    if (File.Exists(path))
                    {
                        zip.CreateEntryFromFile(path, file, CompressionLevel.Optimal);
                    }
                }

                foreach (var folder in IncludedFolders)
                {
                    var path = Path.Combine(Root, folder);
                    if (!Directory.Exists(path))
                    {
                        counts[folder] = 0;
                        continue;
                    }

                    var files = Directory.GetFiles(path);
                    counts[folder] = files.Length;

                    foreach (var file in files)
                    {
                        // Paths inside the zip use forward slashes so the archive reads correctly on
                        // any machine.
                        zip.CreateEntryFromFile(
                            file, $"{folder}/{Path.GetFileName(file)}", CompressionLevel.Optimal);
                    }
                }

                // A manifest makes the archive self-describing.
                var manifest = zip.CreateEntry("backup.json", CompressionLevel.Optimal);
                using var writer = new StreamWriter(manifest.Open());

                writer.Write(JsonSerializer.Serialize(new
                {
                    createdUtc = DateTime.UtcNow,
                    note,
                    apps = counts.GetValueOrDefault("Apps"),
                    icons = counts.GetValueOrDefault("Icons"),
                    wallpapers = counts.GetValueOrDefault("Wallpapers"),
                    cardArt = counts.GetValueOrDefault("CardArt"),
                    cardIcons = counts.GetValueOrDefault("CardIcons")
                }, new JsonSerializerOptions { WriteIndented = true }));
            }

            var size = new FileInfo(target).Length;

            return new
            {
                ok = true,
                path = target,
                size,
                counts
            };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>Lists the existing backups, newest first.</summary>
    public static object List()
    {
        try
        {
            if (!Directory.Exists(BackupFolder))
            {
                return new { ok = true, folder = BackupFolder, backups = Array.Empty<object>() };
            }

            var backups = Directory.EnumerateFiles(BackupFolder, "*.zip")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f =>
                {
                    var summary = ReadManifest(f.FullName);

                    return new
                    {
                        path = f.FullName,
                        name = f.Name,
                        size = f.Length,
                        created = f.LastWriteTime.ToString("yyyy-MM-dd HH:mm"),
                        apps = summary?.apps,
                        cardArt = summary?.cardArt
                    };
                })
                .ToList();

            return new { ok = true, folder = BackupFolder, backups };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Restores a backup over the current data.
    ///
    /// The current state is backed up first, so restoring the wrong archive is itself undoable.
    /// </summary>
    public static object Restore(JsonNode? args)
    {
        var source = args?["path"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(source) || !File.Exists(source))
        {
            return new { ok = false, error = "备份文件不存在" };
        }

        try
        {
            // Copy the current state aside before touching anything.
            var safety = Create(new JsonObject { ["note"] = "恢复前的自动备份" });

            using (var stream = File.OpenRead(source))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                // Clear each managed folder first, so a restore is a replace rather than a merge
                // that leaves stale files behind.
                foreach (var folder in IncludedFolders)
                {
                    var path = Path.Combine(Root, folder);
                    if (Directory.Exists(path))
                    {
                        Directory.Delete(path, recursive: true);
                    }
                }

                foreach (var entry in zip.Entries)
                {
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        continue;
                    }

                    // Only the paths this service writes are extracted: an archive must not be able
                    // to place files anywhere else.
                    var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    var target = Path.GetFullPath(Path.Combine(Root, relative));

                    if (!target.StartsWith(Path.GetFullPath(Root), StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    if (Path.GetFileName(target).Equals("backup.json", StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    entry.ExtractToFile(target, overwrite: true);
                }
            }

            return new { ok = true, safetyBackup = safety };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>Opens the backup folder in Explorer.</summary>
    public static object OpenFolder()
    {
        try
        {
            Directory.CreateDirectory(BackupFolder);
            System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo(BackupFolder) { UseShellExecute = true });

            return new { ok = true, path = BackupFolder };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>Reads the manifest from a backup, or null when it is not one of ours.</summary>
    private static BackupManifest? ReadManifest(string zipPath)
    {
        try
        {
            using var stream = File.OpenRead(zipPath);
            using var zip = new ZipArchive(stream, ZipArchiveMode.Read);

            var entry = zip.GetEntry("backup.json");
            if (entry is null)
            {
                return null;
            }

            using var reader = new StreamReader(entry.Open());
            return JsonSerializer.Deserialize<BackupManifest>(
                reader.ReadToEnd(),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch
        {
            return null;
        }
    }

    private sealed class BackupManifest
    {
        public int apps { get; set; }
        public int cardArt { get; set; }
        public string? note { get; set; }
    }
}
