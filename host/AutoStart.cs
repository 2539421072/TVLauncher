using Microsoft.Win32;

namespace TVLauncher.Host;

/// <summary>
/// Starting with Windows.
///
/// Implemented through the per-user Run key rather than a scheduled task or a service. A launcher
/// is a personal thing, it needs no elevation, and the user can see and remove it themselves in
/// Task Manager's startup tab — which is exactly the right amount of visibility for something that
/// takes over the desktop.
///
/// HKCU is used rather than HKLM so no administrator rights are needed and the setting belongs to
/// the person who turned it on.
/// </summary>
internal static class AutoStart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "TVLauncher";

    /// <summary>
    /// The command Windows should run at sign-in.
    ///
    /// The path is quoted because it can contain spaces, and a trailing switch is deliberately not
    /// added: the launcher should open in whatever mode the user last chose, which it reads from its
    /// own settings.
    /// </summary>
    private static string Command
    {
        get
        {
            var executable = Environment.ProcessPath;

            if (string.IsNullOrEmpty(executable))
            {
                executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
            }

            return $"\"{executable}\"";
        }
    }

    /// <summary>True when the launcher is registered to start with Windows.</summary>
    public static bool IsEnabled()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            var value = key?.GetValue(ValueName) as string;
            return !string.IsNullOrWhiteSpace(value);
        }
        catch
        {
            // A missing or unreadable key means "not enabled", which is the safe answer.
            return false;
        }
    }

    /// <summary>Turns startup on or off. Returns the state actually in effect afterwards.</summary>
    public static object Set(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);

            if (key is null)
            {
                return new { ok = false, error = "无法打开注册表启动项" };
            }

            if (enabled)
            {
                key.SetValue(ValueName, Command, RegistryValueKind.String);
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }

            return new
            {
                ok = true,
                enabled = IsEnabled(),
                command = enabled ? Command : string.Empty
            };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }

    /// <summary>
    /// The current state, including the registered command.
    ///
    /// The command is reported so a stale entry — one pointing at a folder the launcher has since
    /// moved out of — can be spotted rather than silently failing at the next sign-in.
    /// </summary>
    public static object Status()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            var registered = key?.GetValue(ValueName) as string;

            return new
            {
                ok = true,
                enabled = !string.IsNullOrWhiteSpace(registered),
                registered = registered ?? string.Empty,
                current = Command,
                matches = string.Equals(registered, Command, StringComparison.OrdinalIgnoreCase)
            };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}
