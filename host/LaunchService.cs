using System.Diagnostics;
using System.Runtime.InteropServices;

namespace TVLauncher.Host;

/// <summary>
/// Starts an application the way a launcher should.
///
/// The target may be an executable, a shortcut, a document, a folder or a URL. Windows already
/// knows how to resolve all of those, so this asks the shell to do it rather than trying to
/// interpret the path itself.
/// </summary>
internal sealed class LaunchService
{
    /// <summary>Starts the target and reports what happened.</summary>
    public object Launch(string target)
    {
        if (string.IsNullOrWhiteSpace(target))
        {
            return new { ok = false, error = "empty target" };
        }

        try
        {
            var info = new ProcessStartInfo(target)
            {
                // UseShellExecute lets the shell resolve .lnk, .url, documents and folders. It is
                // also what makes a shortcut launch with its own working directory and arguments.
                UseShellExecute = true
            };

            Process.Start(info);
            return new { ok = true };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = ex.Message };
        }
    }
}

/// <summary>Reads the clock, network state, volume and battery for the top bar.</summary>
internal static class SystemStatus
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX buffer);

    public static object Snapshot()
    {
        var memory = new MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>() };
        var hasMemory = GlobalMemoryStatusEx(ref memory);

        return new
        {
            time = DateTime.Now.ToString("HH:mm"),
            date = DateTime.Now.ToString("yyyy/MM/dd"),
            weekday = DateTime.Now.ToString("dddd"),
            online = IsOnline(),
            memoryLoadPercent = hasMemory ? memory.dwMemoryLoad : (uint?)null
        };
    }

    private static bool IsOnline()
    {
        try
        {
            return System.Net.NetworkInformation.NetworkInterface
                .GetIsNetworkAvailable();
        }
        catch
        {
            return false;
        }
    }
}
