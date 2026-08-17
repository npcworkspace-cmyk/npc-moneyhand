param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Create", "Open")]
    [string]$DesktopMode,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]{1,80}$')]
    [string]$DesktopName,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$TargetScript,

    [switch]$Sta,

    [switch]$VerifyDesktop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class IsolatedDesktopLauncher {
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const uint DESKTOP_CREATEWINDOW = 0x0002;
    private const uint DESKTOP_CREATEMENU = 0x0004;
    private const uint DESKTOP_HOOKCONTROL = 0x0008;
    private const uint DESKTOP_ENUMERATE = 0x0040;
    private const uint DESKTOP_WRITEOBJECTS = 0x0080;
    private const uint DESKTOP_ACCESS = DESKTOP_READOBJECTS
        | DESKTOP_CREATEWINDOW
        | DESKTOP_CREATEMENU
        | DESKTOP_HOOKCONTROL
        | DESKTOP_ENUMERATE
        | DESKTOP_WRITEOBJECTS;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint DUPLICATE_SAME_ACCESS = 0x00000002;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint INFINITE = 0xFFFFFFFF;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateDesktopW(
        string desktop,
        string device,
        IntPtr deviceMode,
        uint flags,
        uint desiredAccess,
        IntPtr securityAttributes
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenDesktopW(
        string desktop,
        uint flags,
        bool inherit,
        uint desiredAccess
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DuplicateHandle(
        IntPtr sourceProcess,
        IntPtr sourceHandle,
        IntPtr targetProcess,
        out IntPtr targetHandle,
        uint desiredAccess,
        bool inherit,
        uint options
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    private static IntPtr DuplicateStandardHandle(int kind) {
        IntPtr source = GetStdHandle(kind);
        if (source == IntPtr.Zero || source == INVALID_HANDLE_VALUE) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Standard handle is unavailable");
        }
        IntPtr duplicate;
        IntPtr process = GetCurrentProcess();
        if (!DuplicateHandle(
            process,
            source,
            process,
            out duplicate,
            0,
            true,
            DUPLICATE_SAME_ACCESS
        )) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateHandle failed");
        }
        return duplicate;
    }

    private static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) {
            return value;
        }
        StringBuilder output = new StringBuilder();
        output.Append('"');
        int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') {
                slashes += 1;
                continue;
            }
            if (character == '"') {
                output.Append('\\', slashes * 2 + 1);
                output.Append('"');
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes);
            slashes = 0;
            output.Append(character);
        }
        output.Append('\\', slashes * 2);
        output.Append('"');
        return output.ToString();
    }

    private static string CommandLine(
        string executable,
        string targetScript,
        string desktopName,
        bool sta,
        bool verifyDesktop
    ) {
        List<string> arguments = new List<string> {
            executable,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass"
        };
        if (sta) arguments.Add("-Sta");
        arguments.Add("-File");
        arguments.Add(targetScript);
        if (verifyDesktop) {
            arguments.Add("-ExpectedDesktopName");
            arguments.Add(desktopName);
        }
        for (int index = 0; index < arguments.Count; index += 1) {
            arguments[index] = Quote(arguments[index]);
        }
        return String.Join(" ", arguments.ToArray());
    }

    private static IntPtr OpenOrCreateDesktop(string mode, string desktopName) {
        IntPtr desktop = String.Equals(mode, "Create", StringComparison.Ordinal)
            ? CreateDesktopW(desktopName, null, IntPtr.Zero, 0, DESKTOP_ACCESS, IntPtr.Zero)
            : OpenDesktopW(desktopName, 0, false, DESKTOP_ACCESS);
        if (desktop == IntPtr.Zero) {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                String.Equals(mode, "Create", StringComparison.Ordinal)
                    ? "CreateDesktopW failed"
                    : "OpenDesktopW failed"
            );
        }
        return desktop;
    }

    private static IntPtr CreateKillOnCloseJob() {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
        }
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr value = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, value, false);
            if (!SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                value,
                checked((uint)size)
            )) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "SetInformationJobObject failed"
                );
            }
        } catch {
            CloseHandle(job);
            throw;
        } finally {
            Marshal.FreeHGlobal(value);
        }
        return job;
    }

    public static int Run(
        string desktopMode,
        string desktopName,
        string executable,
        string targetScript,
        bool sta,
        bool verifyDesktop,
        string currentDirectory
    ) {
        IntPtr desktop = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        IntPtr input = IntPtr.Zero;
        IntPtr output = IntPtr.Zero;
        IntPtr error = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        try {
            desktop = OpenOrCreateDesktop(desktopMode, desktopName);
            job = CreateKillOnCloseJob();
            input = DuplicateStandardHandle(STD_INPUT_HANDLE);
            output = DuplicateStandardHandle(STD_OUTPUT_HANDLE);
            error = DuplicateStandardHandle(STD_ERROR_HANDLE);
            STARTUPINFO startup = new STARTUPINFO {
                cb = checked((uint)Marshal.SizeOf(typeof(STARTUPINFO))),
                lpDesktop = desktopName,
                dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES,
                wShowWindow = SW_HIDE,
                hStdInput = input,
                hStdOutput = output,
                hStdError = error
            };
            StringBuilder commandLine = new StringBuilder(CommandLine(
                executable,
                targetScript,
                desktopName,
                sta,
                verifyDesktop
            ));
            if (!CreateProcessW(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW,
                IntPtr.Zero,
                currentDirectory,
                ref startup,
                out process
            )) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
            }
            if (!AssignProcessToJobObject(job, process.hProcess)) {
                int assignError = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(assignError, "AssignProcessToJobObject failed");
            }
            if (ResumeThread(process.hThread) == UInt32.MaxValue) {
                int resumeError = Marshal.GetLastWin32Error();
                TerminateProcess(process.hProcess, 1);
                throw new Win32Exception(resumeError, "ResumeThread failed");
            }
            CloseHandle(process.hThread);
            process.hThread = IntPtr.Zero;
            CloseHandle(input);
            input = IntPtr.Zero;
            CloseHandle(output);
            output = IntPtr.Zero;
            CloseHandle(error);
            error = IntPtr.Zero;
            WaitForSingleObject(process.hProcess, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "GetExitCodeProcess failed");
            }
            return unchecked((int)exitCode);
        } finally {
            if (input != IntPtr.Zero) CloseHandle(input);
            if (output != IntPtr.Zero) CloseHandle(output);
            if (error != IntPtr.Zero) CloseHandle(error);
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
        }
    }
}
'@

$powershell = Join-Path $PSHOME "powershell.exe"
$target = (Resolve-Path -LiteralPath $TargetScript).Path
$exitCode = [IsolatedDesktopLauncher]::Run(
    $DesktopMode,
    $DesktopName,
    $powershell,
    $target,
    [bool]$Sta,
    [bool]$VerifyDesktop,
    (Get-Location).Path
)
exit $exitCode
