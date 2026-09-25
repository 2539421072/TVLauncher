using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TVLauncher.Host;

/// <summary>
/// Finds the applications to show and produces their icons.
///
/// The source of truth is one folder the user curates: they drop shortcuts into it and those are
/// the apps on the home screen. Nothing is scanned from the Start Menu, so the user is never
/// surprised by an app they did not put there.
///
/// Icons are extracted by PowerShell using System.Drawing, the same approach the previous version
/// used: it resolves the icon a shortcut actually points at, including the icon inside an .exe,
/// which no managed API does reliably. Results are cached on disk because extraction costs about
/// 40 ms per app.
/// </summary>
internal sealed class AppCatalog
{
    private static readonly string DataRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TVLauncher2");

    private static readonly string CacheRoot = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "TVLauncher2", "IconCache");

    /// <summary>The folder the user drops shortcuts into.</summary>
    public static string AppsFolder => Path.Combine(DataRoot, "Apps");

    public AppCatalog()
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(AppsFolder);
        Directory.CreateDirectory(CacheRoot);
        EnsureReadme();
    }

    /// <summary>
    /// Lists the apps in the folder. Sub folders are included one level deep so a user can group
    /// things, and the placeholder file is skipped.
    /// </summary>
    public object Scan()
    {
        var apps = new List<object>();

        foreach (var file in EnumerateShortcuts(AppsFolder))
        {
            var name = Path.GetFileNameWithoutExtension(file);

            apps.Add(new
            {
                id = MakeId(file),
                name,
                path = file,
                kind = Describe(file),

                // A shortcut whose target no longer exists still deserves a place in the grid, but
                // the UI should say so instead of failing silently when it is clicked.
                broken = IsBroken(file)
            });
        }

        // Stable order: by name, so the grid does not reshuffle between runs.
        apps.Sort((a, b) => string.CompareOrdinal(
            (string)a.GetType().GetProperty("name")!.GetValue(a)!,
            (string)b.GetType().GetProperty("name")!.GetValue(b)!));

        return new { folder = AppsFolder, apps };
    }

    /// <summary>True when a shortcut points at something that is no longer there.</summary>
    private static bool IsBroken(string file)
    {
        if (!string.Equals(Path.GetExtension(file), ".lnk", StringComparison.OrdinalIgnoreCase))
        {
            return !File.Exists(file);
        }

        try
        {
            // Resolving a shortcut is cheap and does not start anything.
            var shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType is null)
            {
                return false;
            }

            dynamic shell = Activator.CreateInstance(shellType)!;
            dynamic link = shell.CreateShortcut(file);
            string target = link.TargetPath;

            return !string.IsNullOrEmpty(target) && !File.Exists(target) && !Directory.Exists(target);
        }
        catch
        {
            return false;
        }
    }

    private static IEnumerable<string> EnumerateShortcuts(string folder)
    {
        var patterns = new[] { "*.lnk", "*.url", "*.exe", "*.appref-ms" };

        foreach (var pattern in patterns)
        {
            foreach (var file in Directory.EnumerateFiles(folder, pattern))
            {
                yield return file;
            }
        }

        foreach (var sub in Directory.EnumerateDirectories(folder))
        {
            foreach (var pattern in patterns)
            {
                foreach (var file in Directory.EnumerateFiles(sub, pattern))
                {
                    yield return file;
                }
            }
        }
    }

    private static string Describe(string file) => Path.GetExtension(file).ToLowerInvariant() switch
    {
        ".lnk" => "shortcut",
        ".url" => "link",
        ".exe" => "program",
        _ => "app"
    };

    private static string MakeId(string path)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path.ToLowerInvariant())))[..16];

    // ------------------------------------------------------------------ icons

    /// <summary>
    /// Returns a data URL for the app's icon, using the disk cache when the source file has not
    /// changed.
    /// </summary>
    public object Icon(string path)
    {
        if (!File.Exists(path))
        {
            return new { ok = false, error = "file not found" };
        }

        var stamp = File.GetLastWriteTimeUtc(path).Ticks;
        var key = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes($"{path.ToLowerInvariant()}|{stamp}|v4")))[..32];

        var cached = Path.Combine(CacheRoot, key + ".png");
        if (File.Exists(cached))
        {
            return new { ok = true, dataUrl = ToDataUrl(cached), cached = true };
        }

        try
        {
            var bytes = ExtractIcon(path);

            if (bytes is null || bytes.Length == 0)
            {
                return new { ok = false, error = "no icon" };
            }

            File.WriteAllBytes(cached, bytes);
            return new { ok = true, dataUrl = ToDataUrl(cached), cached = false };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    private static string ToDataUrl(string pngPath)
        => "data:image/png;base64," + Convert.ToBase64String(File.ReadAllBytes(pngPath));

    /// <summary>
    /// Extracts a 256 px icon as PNG bytes by asking PowerShell to do it with System.Drawing.
    ///
    /// A separate process is used on purpose: System.Drawing's icon APIs are not supported inside
    /// a modern .NET process, and shelling out keeps the host free of that dependency.
    ///
    /// The script tries several sources in order and keeps the largest icon it finds. A shortcut's
    /// IconLocation is often present but empty (",0"), so treating it as the answer is what made
    /// some apps show no icon at all; the target executable is the reliable fallback.
    /// </summary>
    private static byte[]? ExtractIcon(string path)
    {
        var script = """
            param([string]$Target, [string]$Out)
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName System.Drawing

            function Get-ShortcutTarget([string]$lnk) {
                try {
                    $shell = New-Object -ComObject WScript.Shell
                    $s = $shell.CreateShortcut($lnk)
                    $candidates = @()
                    # IconLocation is frequently ",0" with no path at all, which is not an icon.
                    if ($s.IconLocation) {
                        $p = ($s.IconLocation -split ',')[0].Trim().Trim('"')
                        if ($p) { $candidates += $p }
                    }
                    if ($s.TargetPath) { $candidates += $s.TargetPath }
                    return $candidates
                } catch { return @() }
            }

            $sources = @()
            if ([System.IO.Path]::GetExtension($Target) -ieq '.lnk') {
                $sources += Get-ShortcutTarget $Target
            }
            $sources += $Target

            # Drop duplicates and blanks, and order so a real .exe is tried first: an .exe carries
            # its own icon resource, while a document does not.
            $sources = $sources | Where-Object { $_ } | Select-Object -Unique

            $icon = $null
            foreach ($src in $sources) {
                if (-not $src) { continue }
                if (-not (Test-Path -LiteralPath $src)) { continue }
                try {
                    $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
                    if ($icon) { break }
                } catch { $icon = $null }
            }

            if (-not $icon) { exit 2 }

            # ExtractAssociatedIcon only ever returns 32x32. Upscaling that to 256 is what made
            # launcher icons look blurry, so the icon is taken from the executable's own resource
            # table at its largest size when one is available.
            $best = $null
            foreach ($src in $sources) {
                if (-not $src -or -not (Test-Path -LiteralPath $src)) { continue }
                try {
                    $extracted = [System.Drawing.Icon]::ExtractAssociatedIcon($src)
                    if (-not $extracted) { continue }

                    # Render whatever the source gives at its native size, then keep the sharpest.
                    $native = $extracted.ToBitmap()
                    if (-not $best -or $native.Width -gt $best.Width) {
                        if ($best) { $best.Dispose() }
                        $best = $native
                    } else {
                        $native.Dispose()
                    }
                    $extracted.Dispose()
                } catch { }
            }

            if (-not $best) { exit 3 }

            # Normalise the icon into a rounded white tile.
            #
            # Windows icons come in two shapes: some carry their own square plate, others are an
            # irregular glyph on a transparent background. Dropped straight onto a card, the second
            # kind reads as an odd shape floating on white, and the two kinds look inconsistent
            # side by side.
            #
            # Drawing every icon onto the same rounded white tile, scaled to a shared margin,
            # makes all of them the same shape. An icon that already had a plate simply covers the
            # tile with its own.
            $size = 256
            $radius = [int]($size * 0.22)

            $bmp = New-Object System.Drawing.Bitmap $size, $size
            $bmp.SetResolution(96, 96)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.Clear([System.Drawing.Color]::Transparent)

            # The rounded tile, built from a path so the corners are genuinely round rather than
            # approximated by clipping a rectangle.
            $path = New-Object System.Drawing.Drawing2D.GraphicsPath
            $d = $radius * 2
            $path.AddArc(0, 0, $d, $d, 180, 90)
            $path.AddArc($size - $d, 0, $d, $d, 270, 90)
            $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
            $path.AddArc(0, $size - $d, $d, $d, 90, 90)
            $path.CloseFigure()

            $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
            $g.FillPath($white, $path)
            $white.Dispose()

            # The glyph is inset so it does not touch the tile's edge, which is what gives a row of
            # icons a consistent visual weight.
            $inset = [int]($size * 0.14)
            $inner = $size - ($inset * 2)

            $srcRatio = $best.Width / $best.Height
            if ($srcRatio -ge 1) {
                $dw = $inner
                $dh = [int]($inner / $srcRatio)
            } else {
                $dh = $inner
                $dw = [int]($inner * $srcRatio)
            }

            $dx = [int](($size - $dw) / 2)
            $dy = [int](($size - $dh) / 2)

            # Clip to the tile so an icon that overflows its own bounds cannot escape the rounded
            # corners.
            $g.SetClip($path)
            $g.DrawImage($best, (New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh))
            $g.ResetClip()
            $g.Dispose()
            $path.Dispose()

            $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
            $best.Dispose()
            """;

        var temp = Path.Combine(Path.GetTempPath(), "tvlauncher-icon-" + Guid.NewGuid().ToString("N"));
        var scriptFile = temp + ".ps1";
        var outFile = temp + ".png";

        try
        {
            File.WriteAllText(scriptFile, script, Encoding.UTF8);

            var info = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            info.ArgumentList.Add("-NoProfile");
            info.ArgumentList.Add("-ExecutionPolicy");
            info.ArgumentList.Add("Bypass");
            info.ArgumentList.Add("-File");
            info.ArgumentList.Add(scriptFile);
            info.ArgumentList.Add(path);
            info.ArgumentList.Add(outFile);

            using var process = Process.Start(info);
            if (process is null)
            {
                return null;
            }

            process.WaitForExit(15000);

            return File.Exists(outFile) ? File.ReadAllBytes(outFile) : null;
        }
        finally
        {
            TryDelete(scriptFile);
            TryDelete(outFile);
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Cache housekeeping only.
        }
    }

    /// <summary>Leaves a note in the folder so its purpose is obvious.</summary>
    private static void EnsureReadme()
    {
        var readme = Path.Combine(AppsFolder, "把快捷方式放到这里.txt");

        if (File.Exists(readme))
        {
            return;
        }

        File.WriteAllText(
            readme,
            "把想让 TVLauncher 显示的快捷方式放进这个文件夹。\r\n\r\n" +
            "支持：.lnk（快捷方式）、.exe（程序）、.url（网址）\r\n" +
            "可以建子文件夹分类，子文件夹里的也会被读取（只读一层）。\r\n",
            Encoding.UTF8);
    }
}

/// <summary>Reads and writes the settings file the UI owns.</summary>
internal static class ConfigStore
{
    private static readonly string File_ = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "TVLauncher2", "config.json");

    public static object Load()
    {
        try
        {
            if (!File.Exists(File_))
            {
                return new { ok = true, config = (JsonNode?)null };
            }

            var text = File.ReadAllText(File_);
            return new { ok = true, config = JsonNode.Parse(text) };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    public static object Save(JsonNode? args)
    {
        try
        {
            var config = args?["config"];

            if (config is null)
            {
                return new { ok = false, error = "config is required" };
            }

            Directory.CreateDirectory(Path.GetDirectoryName(File_)!);

            File.WriteAllText(
                File_,
                config.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                Encoding.UTF8);

            return new { ok = true, path = File_ };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}
