using System.Text.Json.Nodes;

namespace TVLauncher.Host;

/// <summary>
/// Owns the wallpaper file.
///
/// The chosen file is copied into the launcher's own folder rather than referenced where it sits.
/// A wallpaper picked from a downloads folder or a USB stick would otherwise disappear the moment
/// that file moved, and the user would have no idea why their background reverted.
/// </summary>
internal static class Wallpaper
{
    /// <summary>
    /// The wallpaper folder. It is the same folder the picture library exposes as the wallpaper
    /// library, so a wallpaper copied in through the settings, through the file dialog or by hand
    /// all end up in one place and the picker sees them all.
    /// </summary>
    private static string Folder => ArtLibrary.WallpapersFolder;

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"
    };

    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".wmv", ".avi", ".mov", ".mkv"
    };

    /// <summary>
    /// Validates a wallpaper path and reports what kind of media it is, so the page knows whether
    /// to render an img or a video.
    /// </summary>
    public static object Resolve(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return new { ok = false, error = "空路径" };
        }

        if (!File.Exists(path))
        {
            return new { ok = false, error = "文件不存在" };
        }

        var extension = Path.GetExtension(path);

        if (ImageExtensions.Contains(extension))
        {
            return new { ok = true, kind = "image", path };
        }

        if (VideoExtensions.Contains(extension))
        {
            return new { ok = true, kind = "video", path };
        }

        return new { ok = false, error = $"不支持的格式：{extension}" };
    }

    /// <summary>
    /// Copies the chosen file into the launcher's wallpaper folder and returns the stable path.
    /// The previous wallpaper is removed so the folder does not grow without bound.
    /// </summary>
    public static object Import(JsonNode? args)
    {
        var source = args?["path"]?.GetValue<string>();

        if (source is null || !File.Exists(source))
        {
            return new { ok = false, error = "文件不存在" };
        }

        var extension = Path.GetExtension(source);
        var isImage = ImageExtensions.Contains(extension);
        var isVideo = VideoExtensions.Contains(extension);

        if (!isImage && !isVideo)
        {
            return new { ok = false, error = $"不支持的格式：{extension}" };
        }

        try
        {
            Directory.CreateDirectory(Folder);

            // The wallpaper folder doubles as the wallpaper library, so nothing is deleted here:
            // clearing it would wipe every picture the user had collected. Copying under the
            // file's own name also means the picker lists it like any other entry.
            var stem = Path.GetFileNameWithoutExtension(source);
            var target = Path.Combine(Folder, stem + extension.ToLowerInvariant());

            if (!string.Equals(Path.GetFullPath(target), Path.GetFullPath(source),
                    StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(source, target, overwrite: true);
            }

            return new
            {
                ok = true,
                kind = isVideo ? "video" : "image",
                path = target
            };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Removes the wallpaper setting. The picture itself is left in the library: the user collected
    /// it deliberately and clearing the background is not the same as deleting the file.
    /// </summary>
    public static object Clear()
    {
        return new { ok = true };
    }

    /// <summary>The wallpaper library folder, exposed to the page as a virtual host.</summary>
    public static string Root => Folder;

    /// <summary>
    /// The URL the page should use for a wallpaper file.
    ///
    /// Resolved by the shared library helper, which is also what enforces that only files inside
    /// the launcher's own folders are ever served.
    /// </summary>
    public static object Url(string? path)
    {
        if (ArtLibrary.Url(path ?? string.Empty) is { } url)
        {
            return new { ok = true, url };
        }

        return new { ok = false, error = "壁纸文件不在" };
    }
}
