using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace TVLauncher.Host;

/// <summary>
/// Native file and folder pickers.
///
/// Windows' own dialogs are used rather than anything drawn in the page, so the picker behaves the
/// way the user expects and can reach network drives, libraries and pinned locations that a custom
/// browser could not.
///
/// The OPENFILENAME structure marshals its string fields as StringBuilder, not string. Windows
/// writes the chosen path back into lpstrFile, and a string field would be marshalled as a
/// temporary buffer that is discarded — and can be collected — the moment the call returns. The
/// second dialog then wrote into freed memory and took the process down with it.
/// </summary>
internal static class FilePicker
{
    private const int OFN_READONLY = 0x00000001;
    private const int OFN_PATHMUSTEXIST = 0x00000800;
    private const int OFN_EXPLORER = 0x00080000;
    private const int OFN_NOCHANGEDIR = 0x00000008;
    private const int OFN_ALLOWMULTISELECT = 0x00000200;

    /*
     * Every pointer field is an IntPtr and every string field is a pointer to memory this class
     * allocates.
     *
     * Managed string fields cannot be used here at all: the marshaller rejects the structure with
     * "cannot be marshaled as an unmanaged structure", which made every file dialog fail to open and
     * left the buttons looking dead. Declaring the layout in raw pointers sidesteps that entirely,
     * and is how this API is meant to be called anyway.
     */
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct OPENFILENAME
    {
        public int lStructSize;
        public IntPtr hwndOwner;
        public IntPtr hInstance;
        public IntPtr lpstrFilter;
        public IntPtr lpstrCustomFilter;
        public int nMaxCustFilter;
        public int nFilterIndex;

        /// <summary>Writable: Windows writes the chosen path or paths here.</summary>
        public IntPtr lpstrFile;

        public int nMaxFile;
        public IntPtr lpstrFileTitle;
        public int nMaxFileTitle;
        public IntPtr lpstrInitialDir;
        public IntPtr lpstrTitle;
        public int Flags;
        public short nFileOffset;
        public short nFileExtension;
        public IntPtr lpstrDefExt;
        public IntPtr lCustData;
        public IntPtr lpfnHook;
        public IntPtr lpTemplateName;
        public IntPtr pvReserved;
        public int dwReserved;
        public int flagsEx;
    }

    [DllImport("comdlg32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetOpenFileNameW(ref OPENFILENAME ofn);

    /// <summary>
    /// The size of the structure in bytes, as the marshaller computes it.
    ///
    /// Now that every field is a pointer or a primitive, the generic overload works and the layout
    /// follows from the declared field types.
    /// </summary>
    private static readonly int StructSize = Marshal.SizeOf<OPENFILENAME>();

    /// <summary>Reports the computed size, for diagnosing a structure that will not marshal.</summary>
    public static string ReportStructSize() => StructSize.ToString();

    /// <summary>
    /// Asks for a file. <paramref name="kind"/> selects the filter: "wallpaper" for images and
    /// video, "shortcut" for a launcher entry, "image" for a picture only.
    /// </summary>
    public static object PickFile(string kind, string? startIn, IntPtr owner)
    {
        var filter = kind switch
        {
            "shortcut" =>
                "快捷方式与程序\0*.lnk;*.url;*.exe;*.appref-ms\0" +
                "所有文件\0*.*\0\0",
            "image" =>
                "图片\0*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.svg\0" +
                "所有文件\0*.*\0\0",
            _ =>
                "图片与视频\0*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.svg;*.mp4;*.webm;*.wmv;*.avi;*.mov;*.mkv\0" +
                "图片\0*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.svg\0" +
                "视频\0*.mp4;*.webm;*.wmv;*.avi;*.mov;*.mkv\0" +
                "所有文件\0*.*\0\0"
        };

        var title = kind switch
        {
            "shortcut" => "选择要添加的程序或快捷方式",
            "image" => "选择图片",
            _ => "选择壁纸"
        };

        var paths = Show(
            filter,
            title,
            multi: false,
            owner,
            allowVideo: kind != "image",
            startIn);

        if (paths.Count == 0)
        {
            return new { ok = false, cancelled = true };
        }

        return File.Exists(paths[0])
            ? new { ok = true, path = paths[0] }
            : new { ok = false, cancelled = true };
    }

    /// <summary>
    /// Asks for one or more pictures.
    ///
    /// The dialog writes the result in one of two shapes. When a single file is chosen the buffer
    /// holds just its full path. When several are chosen it holds the folder first, then each file
    /// name, all NUL separated — so the paths have to be reassembled from the folder. Both shapes
    /// turn up depending on how the user clicks, which is why both are handled.
    /// </summary>
    public static object PickFiles(string kind, IntPtr owner)
    {
        var filter = kind switch
        {
            "image" =>
                "图片\0*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.svg\0" +
                "所有文件\0*.*\0\0",
            _ =>
                "图片与视频\0*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.svg;*.mp4;*.webm;*.wmv;*.avi;*.mov;*.mkv\0" +
                "图片\0*.jpg;*.jpeg;*.png;*.webp;*.bmp;*.gif;*.svg\0" +
                "视频\0*.mp4;*.webm;*.wmv;*.avi;*.mov;*.mkv\0" +
                "所有文件\0*.*\0\0"
        };

        var paths = Show(
            filter,
            "选择要导入的文件（可多选）",
            multi: true,
            owner,
            allowVideo: kind != "image",
            null);

        return paths.Count > 0
            ? new { ok = true, paths }
            : new { ok = false, cancelled = true };
    }

    /// <summary>
    /// Shows the dialog and returns the chosen paths.
    ///
    /// Two details matter and both were wrong before. The owner window is now passed in: without one
    /// the dialog belongs to no window, and since the launcher is a non-activating desktop window it
    /// opened behind everything with no way to reach it — which looked exactly like the button doing
    /// nothing.
    ///
    /// And the buffer is sized in characters, which is what nMaxFile counts, rather than in bytes.
    /// </summary>
    private static List<string> Show(
        string filter,
        string title,
        bool multi,
        IntPtr owner,
        bool allowVideo,
        string? startIn)
    {
        // Sized for a multi selection: several hundred paths fit comfortably.
        const int capacity = 32768;

        var flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_READONLY | OFN_NOCHANGEDIR;

        if (multi)
        {
            flags |= OFN_ALLOWMULTISELECT;
        }

        // The dialog writes into memory it can write to, so the buffers are allocated outside the
        // managed heap and freed once the dialog has closed.
        var fileBuffer = Marshal.AllocHGlobal(capacity * 2);
        var titleBuffer = Marshal.AllocHGlobal(512 * 2);
        var filterBuffer = Marshal.StringToHGlobalUni(filter);
        var titleText = Marshal.StringToHGlobalUni(title);
        var initialDir = string.IsNullOrEmpty(startIn) || !Directory.Exists(startIn)
            ? IntPtr.Zero
            : Marshal.StringToHGlobalUni(startIn);

        try
        {
            // A zeroed first character means "no initial selection".
            Marshal.WriteInt16(fileBuffer, 0);

            var ofn = new OPENFILENAME
            {
                lStructSize = StructSize,

                // Owning the dialog to the launcher is what keeps it in front of it.
                hwndOwner = owner,

                lpstrFilter = filterBuffer,
                nFilterIndex = 1,
                lpstrFile = fileBuffer,
                nMaxFile = capacity,
                lpstrFileTitle = titleBuffer,
                nMaxFileTitle = 512,
                lpstrInitialDir = initialDir,
                lpstrTitle = titleText,
                Flags = flags
            };

            var chosen = new List<string>();

            if (!GetOpenFileNameW(ref ofn))
            {
                // Cancelling is the ordinary outcome here, not a failure.
                return chosen;
            }

            var result = Marshal.PtrToStringUni(fileBuffer) ?? string.Empty;

            // The buffer ends with an extra NUL, so the split leaves a trailing empty entry.
            var parts = result.Split('\0', StringSplitOptions.RemoveEmptyEntries);

            if (parts.Length <= 1)
            {
                if (parts.Length == 1 && File.Exists(parts[0]))
                {
                    chosen.Add(parts[0]);
                }

                return chosen;
            }

            // Several choices arrive as a folder followed by file names.
            var folder = parts[0];

            for (var i = 1; i < parts.Length; i++)
            {
                var full = Path.Combine(folder, parts[i]);

                if (File.Exists(full))
                {
                    chosen.Add(full);
                }
            }

            return chosen;
        }
        finally
        {
            Marshal.FreeHGlobal(fileBuffer);
            Marshal.FreeHGlobal(titleBuffer);
            Marshal.FreeHGlobal(filterBuffer);
            Marshal.FreeHGlobal(titleText);

            if (initialDir != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(initialDir);
            }
        }
    }

    /// <summary>Opens a folder in Explorer and returns the path that was opened.</summary>
    public static object OpenFolder(string path, bool create)
    {
        try
        {
            if (create)
            {
                Directory.CreateDirectory(path);
            }

            if (!Directory.Exists(path))
            {
                return new { ok = false, error = "文件夹不存在" };
            }

            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            return new { ok = true, path };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}

/// <summary>
/// Copies a shortcut into the launcher's apps folder and gives it a usable name.
///
/// The apps folder is the single source of truth for what the launcher shows, so importing means
/// putting a file there rather than keeping a reference somewhere else. That way the user can still
/// open the folder and rearrange things by hand.
/// </summary>
internal static class AppImporter
{
    public static object Import(System.Text.Json.Nodes.JsonNode? args)
    {
        var source = args?["path"]?.GetValue<string>();
        var rename = args?["name"]?.GetValue<string>();

        if (string.IsNullOrWhiteSpace(source) || !File.Exists(source))
        {
            return new { ok = false, error = "文件不存在" };
        }

        try
        {
            var folder = AppCatalog.AppsFolder;
            Directory.CreateDirectory(folder);

            var extension = Path.GetExtension(source);
            var stem = string.IsNullOrWhiteSpace(rename)
                ? Path.GetFileNameWithoutExtension(source)
                : rename!.Trim();

            // Strip characters a file name cannot contain, so a name typed by the user cannot
            // produce an unusable path.
            foreach (var bad in Path.GetInvalidFileNameChars())
            {
                stem = stem.Replace(bad, '_');
            }

            var target = Path.Combine(folder, stem + extension);

            // Never overwrite silently: an import that replaced a differently named shortcut would
            // be indistinguishable from the launcher losing an app.
            var unique = 2;
            while (File.Exists(target) &&
                   !string.Equals(
                       Path.GetFullPath(target),
                       Path.GetFullPath(source),
                       StringComparison.OrdinalIgnoreCase))
            {
                target = Path.Combine(folder, $"{stem} ({unique++}){extension}");
            }

            if (!string.Equals(
                    Path.GetFullPath(target),
                    Path.GetFullPath(source),
                    StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(source, target, overwrite: false);
            }

            return new { ok = true, path = target, name = Path.GetFileNameWithoutExtension(target) };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}
