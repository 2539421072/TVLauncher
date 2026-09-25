using System.Text.Json;
using System.Text.Json.Nodes;

namespace TVLauncher.Host;

/// <summary>
/// The single channel between the page and the host.
///
/// The page sends { id, command, args } and the host replies with { id, ok, result } or
/// { id, ok: false, error }. One channel, one shape, so there is never a question of which path a
/// call took. Everything the page can ask for is listed in <see cref="Execute"/>.
/// </summary>
internal sealed class Bridge
{
    private readonly ShellWindow _window;
    private readonly LaunchService _launch = new();
    private readonly AppCatalog _catalog = new();

    public Bridge(ShellWindow window)
    {
        _window = window;
    }

    /// <summary>Overrides the mode stored in the config, for the --mode switch.</summary>
    public string? ForceMode { get; set; }

    public void Handle(string messageJson)
    {
        string? id = null;

        try
        {
            var node = JsonNode.Parse(messageJson)?.AsObject();
            if (node is null)
            {
                return;
            }

            id = node["id"]?.GetValue<string>();
            var command = node["command"]?.GetValue<string>() ?? string.Empty;
            var args = node["args"];

            var result = Execute(command, args);

            Reply(new JsonObject
            {
                ["id"] = id,
                ["ok"] = true,
                ["result"] = result is null ? null : JsonValue.Create(result)
            });
        }
        catch (Exception ex)
        {
            // The exception type and the failing frame are included: a bare message left several
            // host failures looking identical and impossible to tell apart.
            Reply(new JsonObject
            {
                ["id"] = id,
                ["ok"] = false,
                ["error"] = ex.Message,
                ["type"] = ex.GetType().FullName,
                ["where"] = ex.StackTrace?.Split('\n').FirstOrDefault()?.Trim()
            });
        }
    }

    private void Reply(JsonObject payload)
        => _window.PostToPage(payload);

    /// <summary>
    /// Every host capability. Kept small on purpose: anything that can be done in the page should
    /// be done in the page.
    /// </summary>
    public object? Execute(string command, JsonNode? args) => command switch
    {
        // --- applications -------------------------------------------------
        "scan" => _catalog.Scan(),
        "icon" => _catalog.Icon(Required(args, "path")),
        "launch" => _launch.Launch(Required(args, "target")),

        // --- importing ----------------------------------------------------
        "pickFile" => WithDialog(() => FilePicker.PickFile(
            args?["kind"]?.GetValue<string>() ?? "wallpaper",
            args?["startIn"]?.GetValue<string>(),
            _window.Handle)),
        "pickFiles" => WithDialog(() => FilePicker.PickFiles(
            args?["kind"]?.GetValue<string>() ?? "wallpaper",
            _window.Handle)),
        "import" => AppImporter.Import(args),
        "openFolder" => FilePicker.OpenFolder(
            args?["path"]?.GetValue<string>() ?? AppCatalog.AppsFolder,
            args?["create"]?.GetValue<bool>() ?? true),
        "appsFolder" => new { ok = true, path = AppCatalog.AppsFolder },

        // --- wallpaper ----------------------------------------------------
        "wallpaper" => Wallpaper.Resolve(args?["path"]?.GetValue<string>()),
        "wallpaperImport" => Wallpaper.Import(args),
        "wallpaperClear" => Wallpaper.Clear(),
        "wallpaperRoot" => new { ok = true, path = Wallpaper.Root },
        "wallpaperUrl" => Wallpaper.Url(args?["path"]?.GetValue<string>()),

        // --- picture libraries --------------------------------------------
        "libraryList" => ArtLibrary.List(args?["library"]?.GetValue<string>() ?? "icons"),
        "libraryAdd" => ArtLibrary.Add(args),
        "libraryAddMany" => ArtLibrary.AddMany(args),
        "libraryRemove" => ArtLibrary.Remove(args),
        "libraryFolder" => FilePicker.OpenFolder(
            args?["library"]?.GetValue<string>() == "wallpapers"
                ? ArtLibrary.WallpapersFolder
                : ArtLibrary.IconsFolder,
            create: true),
        "cardArt" => ArtLibrary.CardArt(),
        "setCardArt" => ArtLibrary.SetCardArt(args),
        "assetUrl" => AssetUrl(args),

        // --- backup -------------------------------------------------------
        "backupCreate" => BackupService.Create(args),
        "backupList" => BackupService.List(),
        "backupRestore" => BackupService.Restore(args),
        "backupFolder" => BackupService.OpenFolder(),

        // --- configuration ------------------------------------------------
        "loadConfig" => ConfigStore.Load(),
        "saveConfig" => ConfigStore.Save(args),

        // --- window -------------------------------------------------------
        "quit" => Quit(),
        "minimize" => Minimize(),
        "wallStatus" => DesktopWall.Status(_window.Handle),
        "wallProbe" => DesktopWall.Probe(_window.Handle),
        "wallFullScreen" => SetFullScreen(args),

        // --- startup ------------------------------------------------------
        "autoStartStatus" => AutoStart.Status(),
        "autoStartSet" => AutoStart.Set(args?["enabled"]?.GetValue<bool>() ?? false),

        // --- diagnostics --------------------------------------------------
        "pickTest" => PickTest(),

        // --- diagnostics --------------------------------------------------
        "log" => WriteDiagnostic(args),

        // --- system status ------------------------------------------------
        "status" => SystemStatus.Snapshot(),

        _ => throw new InvalidOperationException($"Unknown command '{command}'")
    };

    private static string Required(JsonNode? args, string name)
        => args?[name]?.GetValue<string>()
           ?? throw new InvalidOperationException($"'{name}' is required");

    /// <summary>
    /// Runs a file dialog with the launcher temporarily allowed to take focus.
    ///
    /// The launcher is normally a non-activating desktop window, so it never steals focus while the
    /// user is typing elsewhere. That same flag stops a dialog it owns from being brought to the
    /// front, which made the picker open behind everything and look like it had not opened at all.
    ///
    /// The flag is restored afterwards, whatever the dialog did.
    /// </summary>
    private object WithDialog(Func<object> show)
    {
        DesktopWall.BeginDialog(_window.Handle);

        try
        {
            return show();
        }
        finally
        {
            DesktopWall.EndDialog(_window.Handle);
        }
    }

    /// <summary>
    /// Reports the size the marshaller computes for the dialog's structure.
    ///
    /// The picker refused to run because Marshal.SizeOf rejected the structure, so its size is
    /// reported here rather than assumed.
    /// </summary>
    private object PickTest()
    {
        string size;
        string error = string.Empty;

        try
        {
            size = FilePicker.ReportStructSize();
        }
        catch (Exception ex)
        {
            size = "failed";
            error = ex.GetType().Name + ": " + ex.Message;
        }

        return new
        {
            ok = true,
            structSize = size,
            sizeError = error,
            window = _window.Handle.ToInt64(),
            windowCreated = _window.IsHandleCreated,
            visible = _window.Visible,
            styles = DesktopWall.DescribeWindow(_window.Handle)
        };
    }

    /// <summary>
    /// Switches between filling the screen and stopping short of the taskbar.
    ///
    /// Filling the screen is right when the taskbar is transparent, since the taskbar then draws on
    /// top of the launcher rather than being hidden by it. Stopping short is right for an ordinary
    /// taskbar, which the launcher would otherwise cover along with every minimised window.
    /// </summary>
    private object SetFullScreen(System.Text.Json.Nodes.JsonNode? args)
    {
        var enabled = args?["enabled"]?.GetValue<bool>() ?? true;

        DesktopWall.FullScreen = enabled;
        DesktopWall.FitToWorkArea(_window.Handle);

        return new { ok = true, fullScreen = DesktopWall.FullScreen };
    }

    /// <summary>
    /// Resolves a file path into a URL the page may load.
    ///
    /// Only files inside the launcher's own data folder are served: the page is loaded over https
    /// and cannot read file:// paths, and exposing anything else would let the page read arbitrary
    /// files on the machine.
    /// </summary>
    private static object AssetUrl(JsonNode? args)
    {
        var path = args?["path"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(path))
        {
            return new { ok = false };
        }

        return ArtLibrary.Url(path) is { } url
            ? new { ok = true, url }
            : new { ok = false, error = "文件不在允许的目录里" };
    }

    /// <summary>
    /// Writes a diagnostic report to a file.
    ///
    /// The page cannot show a readable overlay when the launcher's own content covers the screen,
    /// so anything that needs inspecting is written out and read from the file instead.
    /// </summary>
    private static object? WriteDiagnostic(JsonNode? args)
    {
        var text = args?["text"]?.GetValue<string>() ?? string.Empty;

        var path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "TVLauncher2", "diagnostic.txt");

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);

        return new { ok = true, path };
    }

    private object? Quit()
    {
        _window.BeginInvoke(_window.Close);
        return true;
    }

    private object? Minimize()
    {
        _window.BeginInvoke(() => _window.WindowState = FormWindowState.Minimized);
        return true;
    }

    /// <summary>Forwards a key the window saw before the page did.</summary>
    public void ForwardKey(string key)
        => _window.PostToPage(new JsonObject { ["event"] = "key", ["key"] = key });
}
