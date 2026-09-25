using System.Text.Json.Nodes;

namespace TVLauncher.Host;

/// <summary>
/// The picture libraries.
///
/// Two folders the user curates: one holds images used as TV card artwork, the other holds
/// wallpapers. Both work the same way — the user drops files in, opens the folder from the
/// settings, or picks a file through the ordinary Windows dialog, and the picker copies it in.
///
/// Copying rather than referencing is deliberate: a picture chosen from a downloads folder or a USB
/// stick would otherwise vanish the moment that file moved, and the user would have no idea why
/// their card artwork reverted.
/// </summary>
internal static class ArtLibrary
{
    private static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "TVLauncher2");

    /// <summary>The launcher's data folder. Everything served to the page lives under here.</summary>
    public static string DataRoot => Root;

    /// <summary>Images offered as TV card artwork.</summary>
    public static string IconsFolder => Path.Combine(Root, "Icons");

    /// <summary>Images offered as wallpapers.</summary>
    public static string WallpapersFolder => Path.Combine(Root, "Wallpapers");

    /// <summary>
    /// Where a picture picked as a card background is copied to.
    ///
    /// Backgrounds and icons are stored separately because they are independent: a card can have a
    /// custom background, a custom icon, both, or neither. Keeping them in one folder keyed by app
    /// would make one silently overwrite the other.
    /// </summary>
    public static string CardArtFolder => Path.Combine(Root, "CardArt");

    /// <summary>Where a picture picked as a card icon is copied to.</summary>
    public static string CardIconFolder => Path.Combine(Root, "CardIcons");

    private static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif",

        // SVG is handled by the browser, not by this process: it is a vector format and the page
        // renders it natively, so it needs no decoding here. It is worth supporting because a
        // vector stays sharp at any card size, which is exactly what a card background wants.
        ".svg"
    };

    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp4", ".webm", ".wmv", ".avi", ".mov", ".mkv"
    };

    public static void EnsureFolders()
    {
        Directory.CreateDirectory(IconsFolder);
        Directory.CreateDirectory(WallpapersFolder);
        Directory.CreateDirectory(CardArtFolder);
        Directory.CreateDirectory(CardIconFolder);
        EnsureReadme(IconsFolder, "这里存放可选作卡片背景的图片。", "在卡片上点右键即可从中选择。");
        EnsureReadme(WallpapersFolder, "这里存放壁纸。", "在设置里选壁纸时可以直接从中挑。");
    }

    /// <summary>Lists the images in a library, newest names last so the order is stable.</summary>
    public static object List(string library)
    {
        var folder = FolderFor(library);

        if (!Directory.Exists(folder))
        {
            return new { ok = true, folder, files = Array.Empty<object>() };
        }

        var files = Directory.EnumerateFiles(folder)
            .Where(f => AllowedExtensionsFor(library).Contains(Path.GetExtension(f)))
            .OrderBy(f => Path.GetFileName(f), StringComparer.OrdinalIgnoreCase)
            .Select(f => new
            {
                name = Path.GetFileNameWithoutExtension(f),
                fileName = Path.GetFileName(f),
                path = f,
                size = new FileInfo(f).Length,

                // Reported so the picker knows whether to draw a video badge.
                kind = VideoExtensions.Contains(Path.GetExtension(f)) ? "video" : "image"
            })
            .ToList();

        return new { ok = true, folder, files };
    }

    /// <summary>
    /// What a library accepts.
    ///
    /// The wallpaper library takes video as well, because a wallpaper can be one. The icon library
    /// takes pictures only, since a video cannot be a card's artwork.
    /// </summary>
    private static HashSet<string> AllowedExtensionsFor(string library)
    {
        if (library != "wallpapers")
        {
            return ImageExtensions;
        }

        var both = new HashSet<string>(ImageExtensions, StringComparer.OrdinalIgnoreCase);

        foreach (var video in VideoExtensions)
        {
            both.Add(video);
        }

        return both;
    }

    /// <summary>
    /// Copies a picture into a library. Used when the user picks a file from outside.
    /// </summary>
    public static object Add(JsonNode? args)
    {
        var library = args?["library"]?.GetValue<string>() ?? "icons";
        var source = args?["path"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(source) || !File.Exists(source))
        {
            return new { ok = false, error = "文件不存在" };
        }

        try
        {
            var folder = FolderFor(library);
            Directory.CreateDirectory(folder);

            if (!AllowedExtensionsFor(library).Contains(Path.GetExtension(source)))
            {
                return new { ok = false, error = $"不支持的格式：{Path.GetExtension(source)}" };
            }

            var target = CopyIn(source, folder);

            return new
            {
                ok = true,
                file = new
                {
                    name = Path.GetFileNameWithoutExtension(target),
                    fileName = Path.GetFileName(target),
                    path = target,
                    size = new FileInfo(target).Length
                }
            };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Copies several files into a library in one go.
    ///
    /// Each file is reported individually rather than as one result: a folder of pictures often
    /// contains one or two the library will not take, and failing the whole import because of them
    /// would be worse than importing the rest and saying what was skipped.
    /// </summary>
    public static object AddMany(JsonNode? args)
    {
        var library = args?["library"]?.GetValue<string>() ?? "icons";
        var incoming = args?["paths"]?.AsArray();

        if (incoming is null || incoming.Count == 0)
        {
            return new { ok = false, cancelled = true };
        }

        var added = new List<object>();
        var skipped = new List<string>();

        try
        {
            var folder = FolderFor(library);
            Directory.CreateDirectory(folder);

            var allowed = AllowedExtensionsFor(library);

            foreach (var node in incoming)
            {
                var source = node?.GetValue<string>();

                if (string.IsNullOrWhiteSpace(source) || !File.Exists(source))
                {
                    continue;
                }

                if (!allowed.Contains(Path.GetExtension(source)))
                {
                    skipped.Add(Path.GetFileName(source));
                    continue;
                }

                var target = CopyIn(source, folder);

                added.Add(new
                {
                    name = Path.GetFileNameWithoutExtension(target),
                    fileName = Path.GetFileName(target),
                    path = target,
                    size = new FileInfo(target).Length
                });
            }

            return new
            {
                ok = added.Count > 0,
                count = added.Count,
                files = added,
                skipped,

                // The panel shows the first imported name, so it is surfaced directly rather than
                // making the page dig it out of the list.
                file = added.Count > 0 ? added[0] : null
            };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Copies a file into a folder, never overwriting one that is already there.
    ///
    /// A silent overwrite would be indistinguishable from the launcher losing a picture the user
    /// had chosen, so a clash gets a numeric suffix instead.
    /// </summary>
    private static string CopyIn(string source, string folder)
    {
        var extension = Path.GetExtension(source);
        var stem = Path.GetFileNameWithoutExtension(source);
        var target = Path.Combine(folder, stem + extension);

        var unique = 2;
        while (File.Exists(target) &&
               !string.Equals(Path.GetFullPath(target), Path.GetFullPath(source),
                   StringComparison.OrdinalIgnoreCase))
        {
            target = Path.Combine(folder, $"{stem} ({unique++}){extension}");
        }

        if (!string.Equals(Path.GetFullPath(target), Path.GetFullPath(source),
                StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(source, target, overwrite: false);
        }

        return target;
    }

    /// <summary>Removes a picture from a library.</summary>
    public static object Remove(JsonNode? args)
    {
        var library = args?["library"]?.GetValue<string>() ?? "icons";
        var path = args?["path"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(path))
        {
            return new { ok = false, error = "空路径" };
        }

        var folder = Path.GetFullPath(FolderFor(library));
        var full = Path.GetFullPath(path);

        // Refuse to delete anything outside the library, whatever the page asks for.
        if (!full.StartsWith(folder, StringComparison.OrdinalIgnoreCase))
        {
            return new { ok = false, error = "只能删除库文件夹里的图片" };
        }

        try
        {
            if (File.Exists(full))
            {
                File.Delete(full);
            }

            return new { ok = true };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Copies a picture for one card and returns a URL the page can load.
    ///
    /// <c>kind</c> selects which of the card's two pictures is being set: its background or its
    /// icon. They are stored in separate folders so setting one never disturbs the other.
    ///
    /// The copy is keyed by the app, so choosing a new picture replaces the old one instead of
    /// piling up files the user never asked for.
    /// </summary>
    public static object SetCardArt(JsonNode? args)
    {
        var appId = args?["appId"]?.GetValue<string>();
        var source = args?["path"]?.GetValue<string>();
        var colour = args?["colour"]?.GetValue<string>();
        var kind = args?["kind"]?.GetValue<string>() ?? "background";

        if (string.IsNullOrWhiteSpace(appId))
        {
            return new { ok = false, error = "缺少应用标识" };
        }

        // A flat colour is not a file. Only a card background can be one, so it is only accepted
        // for that kind; an icon has to be a picture.
        if (!string.IsNullOrWhiteSpace(colour))
        {
            if (kind != "background")
            {
                return new { ok = false, error = "图标只能使用图片" };
            }

            if (!IsHexColour(colour))
            {
                return new { ok = false, error = "颜色格式不对" };
            }

            var colourFile = Path.Combine(CardArtFolder, Sanitise(appId) + ".colour");

            try
            {
                Directory.CreateDirectory(CardArtFolder);

                // A card has one background, so setting a colour clears a picture and vice versa.
                foreach (var old in Directory.EnumerateFiles(CardArtFolder, Sanitise(appId) + ".*"))
                {
                    File.Delete(old);
                }

                File.WriteAllText(colourFile, colour.ToLowerInvariant());
                return new { ok = true, colour = colour.ToLowerInvariant(), url = (string?)null };
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        var folder = kind == "icon" ? CardIconFolder : CardArtFolder;

        try
        {
            Directory.CreateDirectory(folder);

            // Any previous picture of this kind for this card goes first, so the extension can
            // change freely.
            foreach (var old in Directory.EnumerateFiles(folder, Sanitise(appId) + ".*"))
            {
                File.Delete(old);
            }

            if (string.IsNullOrWhiteSpace(source))
            {
                // Clearing is a valid request: the card goes back to the stock look.
                return new { ok = true, url = (string?)null };
            }

            if (!File.Exists(source))
            {
                return new { ok = false, error = "图片不存在" };
            }

            var extension = Path.GetExtension(source);

            if (!ImageExtensions.Contains(extension))
            {
                return new { ok = false, error = $"不支持的图片格式：{extension}" };
            }

            var target = Path.Combine(folder, Sanitise(appId) + extension.ToLowerInvariant());

            // Copying onto itself throws, which happens when the user picks the picture that is
            // already in place.
            if (!string.Equals(Path.GetFullPath(target), Path.GetFullPath(source),
                    StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(source, target, overwrite: true);
            }

            return new { ok = true, url = Url(target) };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// Every saved card picture, so the page can restore them at startup.
    ///
    /// Backgrounds and icons are returned separately: the page applies them differently, and one
    /// must never stand in for the other. A background may be a flat colour instead of a picture,
    /// in which case it is reported in <c>colours</c>.
    /// </summary>
    public static object CardArt()
    {
        return new
        {
            ok = true,
            art = ReadFolder(CardArtFolder),
            icons = ReadFolder(CardIconFolder),
            colours = ReadColours(CardArtFolder)
        };
    }

    /// <summary>
    /// Reads the flat colours. They are stored as .colour text files beside the pictures, keyed by
    /// the same app id, so one lookup finds whichever the card actually uses.
    /// </summary>
    private static Dictionary<string, string> ReadColours(string folder)
    {
        var result = new Dictionary<string, string>();

        try
        {
            if (!Directory.Exists(folder))
            {
                return result;
            }

            foreach (var file in Directory.EnumerateFiles(folder, "*.colour"))
            {
                var key = Path.GetFileNameWithoutExtension(file);
                var text = File.ReadAllText(file).Trim();

                if (IsHexColour(text))
                {
                    result[key] = text.ToLowerInvariant();
                }
            }
        }
        catch
        {
            // A missing folder simply means nothing has been customised yet.
        }

        return result;
    }

    /// <summary>True for a #rrggbb value.</summary>
    private static bool IsHexColour(string value)
    {
        if (value.Length != 7 || value[0] != '#')
        {
            return false;
        }

        for (var i = 1; i < value.Length; i++)
        {
            if (!Uri.IsHexDigit(value[i]))
            {
                return false;
            }
        }

        return true;
    }

    private static Dictionary<string, string> ReadFolder(string folder)
    {
        var result = new Dictionary<string, string>();

        try
        {
            if (!Directory.Exists(folder))
            {
                return result;
            }

            foreach (var file in Directory.EnumerateFiles(folder))
            {
                // A flat colour is stored beside the pictures as a .colour text file. It is not an
                // image, and listing it here made the card try to load it as one: the failed load
                // then covered the very colour it was supposed to represent.
                if (Path.GetExtension(file).Equals(".colour", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var key = Path.GetFileNameWithoutExtension(file);

                if (Url(file) is { } url)
                {
                    result[key] = url;
                }
            }
        }
        catch
        {
            // A missing folder simply means nothing has been customised yet.
        }

        return result;
    }

    /// <summary>
    /// A URL the page may load for a file, or null when the file is outside the launcher's folders.
    ///
    /// The containment check is what stops the page from reading arbitrary files: only paths under
    /// the launcher's own data folder are exposed.
    /// </summary>
    public static string? Url(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return null;
        }

        var root = Path.GetFullPath(Root);
        var full = Path.GetFullPath(path);

        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var relative = Path.GetRelativePath(root, full).Replace('\\', '/');
        var stamp = File.GetLastWriteTimeUtc(full).Ticks;

        // The query defeats a cached copy when a picture is replaced under the same name.
        return $"https://tvlauncher-assets.local/{Uri.EscapeDataString(relative).Replace("%2F", "/")}?v={stamp}";
    }

    private static string FolderFor(string library) => library switch
    {
        "wallpapers" => WallpapersFolder,
        _ => IconsFolder
    };

    /// <summary>Keeps an app id usable as a file name.</summary>
    private static string Sanitise(string value)
    {
        foreach (var bad in Path.GetInvalidFileNameChars())
        {
            value = value.Replace(bad, '_');
        }

        return value;
    }

    private static void EnsureReadme(string folder, string purpose, string detail)
    {
        var readme = Path.Combine(folder, "说明.txt");

        if (File.Exists(readme))
        {
            return;
        }

        File.WriteAllText(
            readme,
            purpose + "\r\n\r\n" +
            detail + "\r\n\r\n" +
            "支持格式：jpg / jpeg / png / webp / bmp / gif / svg\r\n" +
            "也可以把图片直接拖进这个文件夹，软件会自动识别。\r\n" +
            "svg 是矢量图，放大不会模糊，适合做卡片背景。\r\n",
            System.Text.Encoding.UTF8);
    }
}
