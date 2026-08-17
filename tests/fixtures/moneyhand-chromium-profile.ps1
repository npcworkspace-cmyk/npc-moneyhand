param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]{1,80}$')]
    [string]$ExpectedDesktopName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Require-EnvironmentPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [ValidateSet("Leaf", "Container")]
        [string]$PathType
    )

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name is required"
    }
    $resolved = (Resolve-Path -LiteralPath $value).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType $PathType)) {
        throw "$Name must identify an existing $PathType"
    }
    return $resolved
}

function Require-EnvironmentValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name is required"
    }
    return $value
}

function ConvertTo-WindowsCommandLineArgument {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $output = [System.Text.StringBuilder]::new()
    [void]$output.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes += 1
            continue
        }
        if ($character -eq '"') {
            [void]$output.Append('\', ($slashes * 2) + 1)
            [void]$output.Append('"')
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) {
            [void]$output.Append('\', $slashes)
            $slashes = 0
        }
        [void]$output.Append($character)
    }
    if ($slashes -gt 0) {
        [void]$output.Append('\', $slashes * 2)
    }
    [void]$output.Append('"')
    return $output.ToString()
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public sealed class MoneyHandChromiumDesktopInfo {
    public string name { get; set; }
    public string inputDesktopName { get; set; }
    public int threadId { get; set; }
    public bool isolated { get; set; }
}

public static class MoneyHandChromiumDesktop {
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const int UOI_NAME = 2;
    private const int ERROR_INSUFFICIENT_BUFFER = 122;

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool GetUserObjectInformationW(
        IntPtr handle,
        int index,
        StringBuilder value,
        uint valueBytes,
        out uint neededBytes
    );

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    private static string DesktopName(IntPtr desktop) {
        StringBuilder value = new StringBuilder(256);
        uint needed;
        if (!GetUserObjectInformationW(
            desktop,
            UOI_NAME,
            value,
            checked((uint)(value.Capacity * sizeof(char))),
            out needed
        )) {
            int error = Marshal.GetLastWin32Error();
            if (error != ERROR_INSUFFICIENT_BUFFER || needed < sizeof(char)) {
                throw new Win32Exception(error, "GetUserObjectInformationW failed");
            }
            value = new StringBuilder(checked((int)(needed / sizeof(char)) + 1));
            if (!GetUserObjectInformationW(
                desktop,
                UOI_NAME,
                value,
                checked((uint)(value.Capacity * sizeof(char))),
                out needed
            )) {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error(),
                    "GetUserObjectInformationW failed"
                );
            }
        }
        return value.ToString();
    }

    public static MoneyHandChromiumDesktopInfo Inspect(string expectedName) {
        uint threadId = GetCurrentThreadId();
        IntPtr desktop = GetThreadDesktop(threadId);
        string actualName = DesktopName(desktop);
        if (!String.Equals(expectedName, actualName, StringComparison.OrdinalIgnoreCase)) {
            throw new InvalidOperationException("Chromium host did not start on the expected desktop");
        }
        IntPtr inputDesktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (inputDesktop == IntPtr.Zero) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenInputDesktop failed");
        }
        string inputName;
        try {
            inputName = DesktopName(inputDesktop);
        } finally {
            CloseDesktop(inputDesktop);
        }
        return new MoneyHandChromiumDesktopInfo {
            name = actualName,
            inputDesktopName = inputName,
            threadId = unchecked((int)threadId),
            isolated = !String.Equals(actualName, inputName, StringComparison.OrdinalIgnoreCase)
        };
    }
}
'@

$desktopBinding = [MoneyHandChromiumDesktop]::Inspect($ExpectedDesktopName)
if (-not $desktopBinding.isolated) {
    throw "Chromium acceptance requires a non-input desktop"
}

$chromiumPath = Require-EnvironmentPath -Name "NPC_MONEYHAND_ACCEPTANCE_CHROMIUM_PATH" -PathType Leaf
$profileRoot = Require-EnvironmentPath -Name "NPC_MONEYHAND_ACCEPTANCE_PROFILE_ROOT" -PathType Container
$extensionPath = Require-EnvironmentPath -Name "NPC_MONEYHAND_ACCEPTANCE_EXTENSION_PATH" -PathType Container
$startUrl = Require-EnvironmentValue -Name "NPC_MONEYHAND_ACCEPTANCE_START_URL"
if (-not (Test-Path -LiteralPath (Join-Path $extensionPath "manifest.json") -PathType Leaf)) {
    throw "NPC_MONEYHAND_ACCEPTANCE_EXTENSION_PATH must contain manifest.json"
}
$parsedStartUrl = [Uri]$startUrl
if ($parsedStartUrl.Scheme -ne "http" -or -not $parsedStartUrl.IsLoopback) {
    throw "NPC_MONEYHAND_ACCEPTANCE_START_URL must use loopback HTTP"
}

$portFile = Join-Path $profileRoot "DevToolsActivePort"
if (Test-Path -LiteralPath $portFile) {
    throw "Disposable profile unexpectedly contains DevToolsActivePort"
}

$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $chromiumPath
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$browserArguments = @(
    "--user-data-dir=$profileRoot",
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--disable-extensions-except=$extensionPath",
    "--load-extension=$extensionPath",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-gpu",
    "--enable-automation",
    "--site-per-process",
    "--host-resolver-rules=MAP localhost 127.0.0.1",
    "--disable-client-side-phishing-detection",
    "--disable-features=CalculateNativeWinOcclusion,MediaRouter,OptimizationHints",
    "--metrics-recording-only",
    "--noerrdialogs",
    "--password-store=basic",
    "--window-position=0,0",
    "--window-size=800,600",
    $startUrl
)
$startInfo.Arguments = ($browserArguments | ForEach-Object {
    ConvertTo-WindowsCommandLineArgument -Value $_
}) -join ' '

$sandboxDisabled = [Environment]::GetEnvironmentVariable(
    "NPC_MONEYHAND_ACCEPTANCE_DISABLE_CHROMIUM_SANDBOX",
    "Process"
) -eq "1"
if ($sandboxDisabled) {
    $startInfo.Arguments = "--no-sandbox $($startInfo.Arguments)"
}

$loggingEnabled = [Environment]::GetEnvironmentVariable(
    "NPC_MONEYHAND_ACCEPTANCE_CHROMIUM_LOGGING",
    "Process"
) -eq "1"
if ($loggingEnabled) {
    $logArguments = @(
        "--enable-logging",
        "--v=1",
        "--log-file=$(Join-Path $profileRoot 'chromium-debug.log')"
    ) | ForEach-Object { ConvertTo-WindowsCommandLineArgument -Value $_ }
    $startInfo.Arguments = (($logArguments + $startInfo.Arguments) -join ' ')
}

$browser = [System.Diagnostics.Process]::Start($startInfo)
if ($null -eq $browser) {
    throw "Failed to start Chromium"
}

$deadline = [DateTime]::UtcNow.AddSeconds(25)
while (-not (Test-Path -LiteralPath $portFile -PathType Leaf)) {
    if ($browser.HasExited) {
        throw "Chromium exited before publishing DevToolsActivePort"
    }
    if ([DateTime]::UtcNow -ge $deadline) {
        throw "Timed out waiting for DevToolsActivePort"
    }
    Start-Sleep -Milliseconds 50
}

$portLines = @(Get-Content -LiteralPath $portFile)
if ($portLines.Count -lt 2 -or $portLines[0] -notmatch '^\d{1,5}$') {
    throw "DevToolsActivePort is invalid"
}
$devToolsPort = [int]$portLines[0]
if ($devToolsPort -lt 1 -or $devToolsPort -gt 65535 -or $portLines[1] -notmatch '^/devtools/browser/') {
    throw "DevToolsActivePort is invalid"
}

[Console]::Out.WriteLine(([ordered]@{
    event = "chromium.ready"
    hostPid = $PID
    browserPid = $browser.Id
    desktopName = $desktopBinding.name
    inputDesktopName = $desktopBinding.inputDesktopName
    isolatedDesktop = $desktopBinding.isolated
    browserSandboxDisabled = $sandboxDisabled
    devToolsPort = $devToolsPort
    browserWebSocketPath = [string]$portLines[1]
} | ConvertTo-Json -Compress))
[Console]::Out.Flush()

$command = [Console]::In.ReadLine()
if ($null -ne $command -and $command -ne "stop") {
    throw "Chromium host accepts only the stop command"
}

[Console]::Out.WriteLine(([ordered]@{
    event = "chromium.stopping"
    hostPid = $PID
    browserPid = $browser.Id
    browserExited = $browser.HasExited
    browserExitCode = if ($browser.HasExited) { $browser.ExitCode } else { $null }
} | ConvertTo-Json -Compress))
[Console]::Out.Flush()
