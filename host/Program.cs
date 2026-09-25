using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace TVLauncher.Host;

/// <summary>
/// Entry point.
///
/// The host is deliberately thin: it owns one full screen window, one WebView2 control and a
/// handful of bridge methods. Everything the user sees is HTML/CSS/JS under ui\, so the interface
/// can be changed without touching or recompiling this project.
/// </summary>
internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        // The picture libraries and the app folder are created up front, so the user can open them
        // from the settings before anything has been imported.
        ArtLibrary.EnsureFolders();

        var options = HostOptions.Parse(args);

        if (options.DevTools)
        {
            // F12 and right click open the WebView2 developer tools in this mode.
            Application.Run(new ShellWindow(options));
            return;
        }

        Application.Run(new ShellWindow(options));
    }
}

/// <summary>Command line switches the host understands.</summary>
internal sealed class HostOptions
{
    /// <summary>Open with the developer tools enabled.</summary>
    public bool DevTools { get; private init; }

    /// <summary>Start in a specific mode instead of whatever the config says.</summary>
    public string? Mode { get; private init; }

    /// <summary>Query string appended to the page URL, used to trigger the in-page self test.</summary>
    public string Query { get; private init; } = string.Empty;

    public static HostOptions Parse(string[] args)
    {
        var devTools = false;
        string? mode = null;
        var query = string.Empty;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--devtools":
                    devTools = true;
                    break;
                case "--mode" when i + 1 < args.Length:
                    mode = args[++i];
                    break;
                case "--selftest":
                    query = "?selftest";
                    break;
                case "--probe":
                    query = "?probe";
                    break;
                case "--presstest":
                    query = "?presstest";
                    break;
                case "--layoutprobe":
                    query = "?layoutprobe";
                    break;
                case "--artdemo":
                    query = "?artdemo";
                    break;
                case "--artcheck":
                    query = "?artcheck";
                    break;
                case "--importtest":
                    query = "?importtest";
                    break;
                case "--backuptest":
                    query = "?backuptest";
                    break;
                case "--glassshot":
                    // Takes an optional surface name, so any one of the floating panels can be
                    // opened on its own for a screenshot.
                    query = i + 1 < args.Length && !args[i + 1].StartsWith("--")
                        ? $"?glassshot={args[++i]}"
                        : "?glassshot=panel";
                    break;
                case "--clockprobe":
                    query = "?clockprobe";
                    break;
                case "--wallprobe":
                    query = "?wallprobe";
                    break;
                case "--startprobe":
                    // Takes an optional on/off, so the startup entry can be set and read back.
                    query = i + 1 < args.Length && !args[i + 1].StartsWith("--")
                        ? $"?startprobe={args[++i]}"
                        : "?startprobe=status";
                    break;
                case "--pageprobe":
                    query = "?pageprobe";
                    break;
                case "--dragprobe":
                    query = "?dragprobe";
                    break;
                case "--tvswipeprobe":
                    query = "?tvswipeprobe";
                    break;
                case "--menushot":
                    query = "?menushot";
                    break;
                case "--pickprobe":
                    // Takes an optional kind, so each of the three dialogs can be checked.
                    query = i + 1 < args.Length && !args[i + 1].StartsWith("--")
                        ? $"?pickprobe={args[++i]}"
                        : "?pickprobe=wallpaper";
                    break;
            }
        }

        return new HostOptions { DevTools = devTools, Mode = mode, Query = query };
    }
}

/// <summary>
/// The launcher window. Frameless, full screen, always on top of the desktop, with WebView2
/// filling it completely.
/// </summary>
internal sealed class ShellWindow : Form
{
    private readonly HostOptions _options;
    private readonly WebView2 _webView = new();
    private readonly Bridge _bridge;

    public ShellWindow(HostOptions options)
    {
        _options = options;
        _bridge = new Bridge(this);

        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;

        // The work area, not the full screen: the taskbar stays visible, so a program the user
        // minimises is still reachable.
        Bounds = DesktopWall.WorkArea;

        BackColor = Color.FromArgb(16, 18, 28);
        KeyPreview = true;
        Text = "TVLauncher";
        Icon = LoadAppIcon();

        _webView.Dock = DockStyle.Fill;
        _webView.DefaultBackgroundColor = Color.FromArgb(16, 18, 28);
        Controls.Add(_webView);

        Load += OnLoaded;

        // The cover flow and the grid are both keyboard driven, so the window must not let the
        // WebView2 control swallow arrow keys before the page sees them.
        KeyDown += (_, e) => _bridge.ForwardKey(e.KeyCode.ToString());

        // The launcher must never keep focus. Windows raises whichever window is activated, so an
        // activated launcher would jump in front of the program the user just opened.
        Activated += (_, e) => DesktopWall.KeepBehind(Handle);

        // Re-asserts the desktop position at a slow tick. Explorer rebuilds the desktop's window
        // when the wallpaper changes or the shell restarts, which silently drops the parent
        // relationship and leaves the launcher floating on top of everything.
        // Keeps the window at the bottom of the stack.
        //
        // Clicking a window raises it, so a launcher that is only pushed down once climbs back on
        // top as the user works. A short interval is what keeps it behind other programs: long
        // enough not to burn CPU, short enough that the window never visibly sits in front.
        _wallWatch = new System.Windows.Forms.Timer { Interval = 400 };
        _wallWatch.Tick += (_, _) => DesktopWall.Scrub(Handle);
        _wallWatch.Start();
    }

    private readonly System.Windows.Forms.Timer _wallWatch;

    /// <summary>
    /// The window icon, read from the executable's own resources.
    ///
    /// Reading it back from the running assembly means the icon shown in the taskbar and in the
    /// alt-tab list is always the same artwork that is embedded in the file, with no second copy
    /// to keep in step.
    /// </summary>
    private static Icon? LoadAppIcon()
    {
        try
        {
            var executable = Environment.ProcessPath;

            if (!string.IsNullOrEmpty(executable) && File.Exists(executable))
            {
                var extracted = Icon.ExtractAssociatedIcon(executable);
                if (extracted is not null)
                {
                    return extracted;
                }
            }
        }
        catch
        {
            // A missing icon is cosmetic; never let it stop the launcher.
        }

        return null;
    }

    /// <summary>
    /// Applies the window styles that make this a desktop rather than a program.
    ///
    /// This has to be OnHandleCreated, before the window is first shown. WS_EX_NOACTIVATE is read
    /// when the window is created for display purposes, so setting it afterwards has no effect —
    /// which is why clicking the launcher still pulled focus away from the program the user was
    /// typing into.
    /// </summary>
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        DesktopWall.MakeNonActivating(Handle);
    }

    /// <summary>
    /// Pins the window to the desktop once it is on screen.
    /// </summary>
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);

        DesktopWall.AttachToDesktop(Handle);
    }

    private async void OnLoaded(object? sender, EventArgs e)
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "TVLauncher2", "WebView");

            Directory.CreateDirectory(userData);

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: userData);

            await _webView.EnsureCoreWebView2Async(environment);

            var core = _webView.CoreWebView2;

            core.Settings.AreDefaultContextMenusEnabled = _options.DevTools;
            core.Settings.AreDevToolsEnabled = _options.DevTools;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = _options.DevTools;

            // The page talks to the host through postMessage; the host answers through
            // window.chrome.webview.postMessage. No remote content is ever loaded.
            //
            // The handler runs on whatever thread the WebView2 event arrives on, so replies are
            // marshalled back to the UI thread: posting a web message from a background thread
            // silently does nothing, which is what left the page waiting forever.
            core.WebMessageReceived += (_, args) =>
            {
                var json = args.WebMessageAsJson;
                BeginInvoke(() => _bridge.Handle(json));
            };

            if (_options.Mode is { Length: > 0 } mode)
            {
                _bridge.ForceMode = mode;
            }

            var uiRoot = Path.Combine(AppContext.BaseDirectory, "ui");
            var indexPath = Path.Combine(uiRoot, "index.html");

            if (!File.Exists(indexPath))
            {
                core.NavigateToString(
                    "<html><body style='background:#10121c;color:#fff;font:16px sans-serif;" +
                    "padding:40px'>ui\\index.html not found next to the executable.</body></html>");
                return;
            }

            // Wallpapers and card artwork live in the user profile, outside the interface folder. A
            // file:// URL is blocked from an https page, so the whole launcher data folder is
            // exposed through its own host and the page builds asset URLs against it.
            core.SetVirtualHostNameToFolderMapping(
                "tvlauncher.local", uiRoot, CoreWebView2HostResourceAccessKind.Allow);

            core.SetVirtualHostNameToFolderMapping(
                "tvlauncher-assets.local", ArtLibrary.DataRoot,
                CoreWebView2HostResourceAccessKind.Allow);

            // The interface is plain files next to the exe. WebView2 caches them aggressively, and
            // a stale stylesheet that silently ignores an edit costs far more than the requests
            // saved, so every response is marked no-store.
            core.AddWebResourceRequestedFilter(
                "https://tvlauncher.local/*", CoreWebView2WebResourceContext.All);

            core.WebResourceRequested += (_, args) =>
            {
                var uri = new Uri(args.Request.Uri);
                var relative = uri.AbsolutePath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
                var file = Path.Combine(uiRoot, relative);

                if (!File.Exists(file))
                {
                    args.Response = core.Environment.CreateWebResourceResponse(
                        null, 404, "Not Found", string.Empty);
                    return;
                }

                var stream = new MemoryStream(File.ReadAllBytes(file));

                args.Response = core.Environment.CreateWebResourceResponse(
                    stream,
                    200,
                    "OK",
                    "Content-Type: " + ContentTypeFor(file) + "\r\nCache-Control: no-store\r\n");
            };

            core.Navigate("https://tvlauncher.local/index.html" + _options.Query);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "WebView2 failed to start.\n\n" + ex.Message,
                "TVLauncher",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    /// <summary>Maps a file extension onto the content type the page needs.</summary>
    private static string ContentTypeFor(string file) => Path.GetExtension(file).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream"
    };

    /// <summary>Sends a message to the page.</summary>
    public void PostToPage(object payload)
        => _webView.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
}
