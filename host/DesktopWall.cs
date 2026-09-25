using System.Runtime.InteropServices;

namespace TVLauncher.Host;

/// <summary>
/// Keeps the launcher pinned to the desktop: above the wallpaper, below every other window, and
/// clear of the taskbar.
///
/// This is what makes it behave like a desktop rather than like an app. A normal maximised window
/// sits on top of everything, so opening a program and then clicking the launcher would bury that
/// program — and a full screen window also covers the taskbar, which is where a minimised program
/// goes. Pinning the window to the bottom of the stack avoids both problems at once: the desktop is
/// still the desktop, and the taskbar is always reachable.
///
/// The window is a child of the desktop's own window rather than a top level window. That is what
/// puts it *behind* everything: a top level window can be pushed to the bottom of the z-order, but
/// any newly opened program still lands above it, and clicking the desktop raises it again.
/// Parenting to the desktop makes the ordering a property of the window rather than something that
/// has to be re-asserted.
/// </summary>
internal static class DesktopWall
{
    private const int GWL_EXSTYLE = -20;

    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    private static readonly IntPtr HWND_BOTTOM = new(1);
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOACTIVATE = 0x0010;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindow(string? className, string? windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr FindWindowEx(
        IntPtr parent, IntPtr childAfter, string? className, string? windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    /// <summary>
    /// Whether the launcher stops short of the taskbar.
    ///
    /// With an ordinary opaque taskbar the launcher has to leave the taskbar's strip free,
    /// otherwise it covers the taskbar and with it every minimised window. When the taskbar has been
    /// made transparent by a tool such as TranslucentTB, covering it is harmless and looks better:
    /// the launcher fills the screen and the taskbar simply draws on top of it.
    ///
    /// So the window is sized to the whole screen and placed beneath the taskbar, which is the
    /// arrangement that works with a transparent taskbar.
    /// </summary>
    public static bool FullScreen { get; set; }

    /// <summary>
    /// The rectangle the launcher should occupy.
    ///
    /// In full screen mode this is the whole screen; otherwise the work area, which stops short of
    /// the taskbar.
    /// </summary>
    public static Rectangle TargetArea
    {
        get
        {
            if (FullScreen)
            {
                var screen = Screen.PrimaryScreen;

                return screen is not null
                    ? screen.Bounds
                    : new Rectangle(0, 0, 1920, 1080);
            }

            return WorkArea;
        }
    }

    /// <summary>
    /// The work area of the primary screen: the desktop minus the taskbar and any other appbars.
    ///
    /// Read live from the system rather than from WinForms' cached copy. The cache is taken when the
    /// screen object is first created and is not refreshed when the taskbar is moved, so a launcher
    /// using it would keep the old size after the taskbar switched edges.
    ///
    /// SPI_GETWORKAREA reports the primary screen's work area, which is the one the taskbar affects.
    /// </summary>
    public static Rectangle WorkArea
    {
        get
        {
            var rect = new WindowRect();

            if (SystemParametersInfo(SPI_GETWORKAREA, 0, ref rect, 0))
            {
                return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
            }

            // Fall back to the cached value if the query fails, which still beats no rectangle.
            return Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1040);
        }
    }

    private const uint SPI_GETWORKAREA = 0x0030;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SystemParametersInfo(
        uint action, uint param, ref WindowRect rect, uint flags);

    /// <summary>
    /// Keeps the launcher at the bottom of the window stack.
    ///
    /// The obvious approach is to parent the window to the desktop, which makes the ordering a
    /// property of the window. That does not work here: on a machine where a third-party shell has
    /// replaced the desktop, SetParent reports success but leaves the window unparented, so the
    /// launcher ends up floating over everything.
    ///
    /// So the position is asserted instead. The window is pushed to the bottom of the top level
    /// stack and checked on a timer, which survives both the shell rejecting the parent and any
    /// other program that tries to raise itself.
    /// </summary>
    public static object AttachToDesktop(IntPtr window)
    {
        if (window == IntPtr.Zero || !IsWindow(window))
        {
            return new { ok = false, error = "window is not created" };
        }

        // A tool window is left out of alt-tab and the taskbar, which is right for something that
        // is meant to be part of the desktop rather than a program the user switches to.
        var style = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64();
        style |= WS_EX_TOOLWINDOW;
        SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(style));

        var parented = TryParentToDesktop(window);

        // Parenting resets the window's rectangle to nothing, so it has to be given its size back
        // before anything else is decided about where it sits.
        FitToWorkArea(window);

        var placed = PlaceAboveDesktop(window);

        // Placing can move it again, so the size is asserted once more to be certain.
        FitToWorkArea(window);

        return new
        {
            ok = true,
            parented,
            placed,
            window = window.ToInt64(),
            desktop = FindDesktopWindow().ToInt64(),
            parent = GetParent(window).ToInt64(),
            topmost = IsTopmost(window),
            lastError = Marshal.GetLastWin32Error(),
            visible = IsWindowVisible(window),
            desktopClass = ClassOf(FindDesktopWindow()),
            windowClass = ClassOf(window)
        };
    }

    /// <summary>
    /// Does not parent the window, deliberately.
    ///
    /// Parenting to the desktop looks like the right answer — it makes the z-order a property of
    /// the window rather than something to keep re-asserting — but it puts the launcher inside the
    /// desktop's own window. Whatever covers the desktop then covers the launcher too, so it
    /// disappears behind the wallpaper and its icons. Measured on this machine: the window ends up
    /// correctly sized and visible, and still invisible on screen.
    ///
    /// So the launcher stays a top level window and its position is asserted instead.
    /// </summary>
    private static bool TryParentToDesktop(IntPtr window)
    {
        // If it was parented by an earlier build, undo that.
        if (GetParent(window) != IntPtr.Zero)
        {
            SetParent(window, IntPtr.Zero);
        }

        return false;
    }

    /// <summary>
    /// Pushes the window to the bottom of the top level stack, without activating it.
    /// </summary>
    private static bool PushToBottom(IntPtr window)
    {
        return SetWindowPos(
            window, HWND_BOTTOM, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    /// <summary>Re-asserts the bottom position, for use after the desktop is rebuilt.</summary>
    public static void SendToBottom(IntPtr window)
    {
        if (IsWindow(window))
        {
            SetWindowPos(window, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        }
    }

    /// <summary>
    /// Puts the window back at the bottom and stops it from staying raised.
    /// <summary>
    /// Gives the window its correct screen rectangle.
    ///
    /// This has to be re-applied after parenting. SetParent resets the window's position and size,
    /// leaving it zero by zero at the origin, so a launcher that was parented successfully would
    /// still be invisible — which is exactly what happened before this was added.
    ///
    /// The work area is used rather than the full screen so the taskbar stays clear, which is what
    /// keeps a minimised program reachable.
    /// </summary>
    public static void FitToWorkArea(IntPtr window)
    {
        if (!IsWindow(window))
        {
            return;
        }

        var area = TargetArea;

        SetWindowPos(
            window, IntPtr.Zero, area.X, area.Y, area.Width, area.Height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }

    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_SHOWWINDOW = 0x0040;

    /// <summary>
    /// Reports each placement strategy's result, so the one that actually works on this machine can
    /// be identified rather than assumed.
    /// </summary>
    public static object Probe(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return new { ok = false };
        }

        var desktop = FindDesktopWindow();
        var results = new List<object>();

        void Try(string name, Func<bool> place)
        {
            place();

            // Let the shell settle before reading the result back.
            Thread.Sleep(400);

            results.Add(new
            {
                name,
                parent = GetParent(window).ToInt64(),
                aboveDesktop = IsAboveDesktop(window, desktop)
            });
        }

        Try("bottom", () => SetWindowPos(window, HWND_BOTTOM, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE));

        Try("above desktop", () => PlaceAboveDesktop(window));

        Try("top", () => SetWindowPos(window, HWND_TOP, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE));

        return new
        {
            ok = true,
            desktop = desktop.ToInt64(),
            desktopClass = ClassOf(desktop),
            window = window.ToInt64(),
            results
        };
    }

    /// <summary>True when the window sits after the desktop in the top level stack.</summary>
    private static bool IsAboveDesktop(IntPtr window, IntPtr desktop)
    {
        if (desktop == IntPtr.Zero)
        {
            return false;
        }

        // Walking forward from the desktop reaches the windows above it. If the launcher is among
        // them it is above the desktop rather than buried beneath it.
        var current = desktop;

        for (var i = 0; i < 500 && current != IntPtr.Zero; i++)
        {
            current = GetWindow(current, GW_HWNDNEXT);

            if (current == window)
            {
                return true;
            }
        }

        return false;
    }

    private const uint GW_HWNDNEXT = 2;

    /// <summary>
    /// Describes a window's extended style flags, for diagnosing why a dialog misbehaves.
    ///
    /// The two flags that matter here: WS_EX_NOACTIVATE keeps the launcher from stealing focus, but
    /// it also stops a dialog owned by it from coming to the front, and WS_EX_TOOLWINDOW keeps it
    /// out of alt-tab.
    /// </summary>
    public static object DescribeWindow(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return new { ok = false };
        }

        var style = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64();

        return new
        {
            noActivate = (style & WS_EX_NOACTIVATE) != 0,
            toolWindow = (style & WS_EX_TOOLWINDOW) != 0,
            topmost = (style & 0x00000008L) != 0,
            exStyle = style
        };
    }

    /// <summary>
    /// Removes WS_EX_NOACTIVATE for as long as a dialog is open, then puts it back.
    ///
    /// A dialog owned by a non-activating window is refused the foreground, so the file picker
    /// opened behind the launcher and appeared never to have opened at all. Letting the window
    /// activate while the dialog is up is what fixes it; the flag goes back afterwards so the
    /// launcher still does not steal focus during normal use.
    /// </summary>
    public static void BeginDialog(IntPtr window)
    {
        if (!IsWindow(window))
        {
            return;
        }

        var style = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64();
        style &= ~WS_EX_NOACTIVATE;
        SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(style));
    }

    /// <summary>Restores the non-activating behaviour once a dialog has closed.</summary>
    public static void EndDialog(IntPtr window)
    {
        if (!IsWindow(window))
        {
            return;
        }

        var style = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64();
        style |= WS_EX_NOACTIVATE;
        SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(style));

        // Put the launcher back behind everything, since activating it raised it.
        PlaceAboveDesktop(window);
    }

    /// <summary>
    /// Puts the window back in place and stops it from staying raised.
    ///
    /// Windows raises a window whenever it is activated, so a launcher that is only placed once
    /// climbs back on top the moment the user interacts with it — which is exactly the situation
    /// being fixed: launch a program, click the launcher, and the program disappears behind it.
    ///
    /// So the position is re-asserted on a timer. The interval is short because the window is only
    /// out of place until the next tick, and anything slower shows it sitting in front.
    /// </summary>
    public static void Scrub(IntPtr window)
    {
        if (!IsWindow(window))
        {
            return;
        }

        if (IsTopmost(window))
        {
            ClearTopmost(window);
        }

        PlaceAboveDesktop(window);

        // Re-fitting here is what makes the launcher follow the taskbar: when the taskbar moves to
        // another edge the work area changes, and this notices on its own. It also recovers the
        // window if the shell rebuilt its parent and collapsed the rectangle to nothing.
        EnsureFitted(window);
    }

    /// <summary>
    /// Re-fits the window whenever it no longer matches the work area.
    ///
    /// This is what makes the launcher follow the taskbar. Moving the taskbar to another edge
    /// changes the work area, and a window that kept its old rectangle would either overlap the
    /// taskbar or leave a gap. Comparing the rectangle against the work area catches that as well as
    /// the collapsed-to-nothing case that SetParent produces.
    /// </summary>
    private static void EnsureFitted(IntPtr window)
    {
        if (!GetWindowRect(window, out var rect))
        {
            return;
        }

        var area = TargetArea;

        var matches =
            rect.Left == area.X &&
            rect.Top == area.Y &&
            rect.Right - rect.Left == area.Width &&
            rect.Bottom - rect.Top == area.Height;

        if (!matches)
        {
            FitToWorkArea(window);
        }
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out WindowRect rect);

    [StructLayout(LayoutKind.Sequential)]
    private struct WindowRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    /// <summary>
    /// Stops the window taking focus when it is clicked.
    ///
    /// This is what makes it behave like a desktop rather than like a program: clicking the desktop
    /// must not steal focus from whatever the user is typing into. The window still receives mouse
    /// input and the keyboard reaches the page while the launcher itself has focus.
    ///
    /// It also removes the launcher from the taskbar and from alt-tab, which is right for something
    /// that is part of the desktop rather than a program to switch to.
    /// </summary>
    public static void MakeNonActivating(IntPtr window)
    {
        if (!IsWindow(window))
        {
            return;
        }

        var style = GetWindowLongPtr(window, GWL_EXSTYLE).ToInt64();
        style |= WS_EX_NOACTIVATE;
        SetWindowLongPtr(window, GWL_EXSTYLE, new IntPtr(style));
    }

    /// <summary>
    /// Puts the window back behind everything after it was activated.
    ///
    /// Called from the window's Activated event. Windows raises a window as part of activating it,
    /// so the only way to stay behind is to put it back immediately afterwards. Doing it here
    /// rather than waiting for the timer removes the brief moment where the launcher sits in front
    /// of the program the user just opened.
    /// </summary>
    public static void KeepBehind(IntPtr window)
    {
        if (!IsWindow(window))
        {
            return;
        }

        PlaceAboveDesktop(window);
    }

    /// <summary>
    /// Places the window directly above the desktop, and therefore below every other window.
    ///
    /// The window is not parented, so its position has to be asserted: it is inserted immediately
    /// after the desktop in the top level stack. That is the one slot that is above the wallpaper
    /// and its icons but underneath every ordinary program.
    /// </summary>
    private static bool PlaceAboveDesktop(IntPtr window)
    {
        var desktop = FindDesktopWindow();

        if (desktop == IntPtr.Zero)
        {
            // Without a desktop to anchor to, the bottom of the stack is the closest match.
            return SetWindowPos(window, HWND_BOTTOM, 0, 0, 0, 0,
                SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
        }

        // Inserting *after* the desktop in z-order puts the launcher immediately above it, which is
        // exactly the slot wanted: over the wallpaper, under everything the user opens.
        return SetWindowPos(
            window, desktop, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    private const uint GW_HWNDPREV = 3;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    private static void ClearTopmost(IntPtr window)
    {
        SetWindowPos(
            window, HWND_NOTOPMOST, 0, 0, 0, 0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
    }

    private static readonly IntPtr HWND_NOTOPMOST = new(-2);

    /// <summary>True when the window is marked always-on-top, which would defeat the whole idea.</summary>
    private static bool IsTopmost(IntPtr window)
    {
        const int GWL_EXSTYLE_ = -20;
        const long WS_EX_TOPMOST = 0x00000008;

        return (GetWindowLongPtr(window, GWL_EXSTYLE_).ToInt64() & WS_EX_TOPMOST) != 0;
    }

    /// <summary>True when the window's parent is the desktop, where the shell allows it.</summary>
    public static bool IsParented(IntPtr window)
    {
        var desktop = FindDesktopWindow();
        return desktop != IntPtr.Zero && GetParent(window) == desktop;
    }

    /// <summary>The window's class name, for diagnosing which window was actually found.</summary>
    private static string ClassOf(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return "(none)";
        }

        var buffer = new System.Text.StringBuilder(256);
        GetClassName(window, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    /// <summary>
    /// Describes the current attachment, so the launcher's position in the stack can be confirmed
    /// rather than assumed.
    /// </summary>
    public static object Status(IntPtr window)
    {
        // Try again on demand, and report what that attempt produced. This turns the probe into a
        // real test of the attachment rather than a description of whatever state it happens to be
        // in.
        var attempt = window == IntPtr.Zero ? null : AttachToDesktop(window);

        var desktop = FindDesktopWindow();
        var parent = window == IntPtr.Zero ? IntPtr.Zero : GetParent(window);

        return new
        {
            ok = true,
            window = window.ToInt64(),
            desktop = desktop.ToInt64(),
            parent = parent.ToInt64(),
            attached = parent != IntPtr.Zero && parent == desktop,
            desktopClass = ClassOf(desktop),
            windowClass = ClassOf(window),
            windowVisible = window != IntPtr.Zero && IsWindowVisible(window),
            attempt,
            fullScreen = FullScreen,
            target = new
            {
                x = TargetArea.X,
                y = TargetArea.Y,
                width = TargetArea.Width,
                height = TargetArea.Height
            },
            workArea = new
            {
                x = WorkArea.X,
                y = WorkArea.Y,
                width = WorkArea.Width,
                height = WorkArea.Height
            },
            screen = new
            {
                width = Screen.PrimaryScreen?.Bounds.Width ?? 0,
                height = Screen.PrimaryScreen?.Bounds.Height ?? 0
            }
        };
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hWnd);

    /// <summary>
    /// Finds the window that hosts the desktop.
    ///
    /// GetShellWindow is tried first because it is the dependable route: it returns the shell's own
    /// window whatever it happens to be called. Class name lookups come second, because they fail
    /// outright on machines where a third-party shell replacement has taken over the desktop —
    /// FindWindow("Progman") returns nothing there even though the window exists and GetShellWindow
    /// still finds it.
    /// </summary>
    private static IntPtr FindDesktopWindow()
    {
        var shell = GetShellWindow();

        if (shell != IntPtr.Zero)
        {
            return shell;
        }

        var progman = FindWindow("Progman", null);

        if (progman != IntPtr.Zero)
        {
            return progman;
        }

        // The desktop list view's parent is the other place the desktop lives.
        var shellView = FindWindowEx(IntPtr.Zero, IntPtr.Zero, "SHELLDLL_DefView", null);

        return shellView != IntPtr.Zero
            ? FindWindowEx(IntPtr.Zero, shellView, "WorkerW", null)
            : IntPtr.Zero;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();
}
