# Codebase CLI installer (Windows / PowerShell).
#
# Usage:
#   irm https://codebase.foundation/install.ps1 | iex
#   irm https://raw.githubusercontent.com/codebase-foundation/codebase-cli/main/install.ps1 | iex
#
# What this does:
#   1. Detects an existing v1 (Go) binary at ~\.codebase\bin\codebase.exe
#      and offers to remove it.
#   2. Verifies Node.js >= 20 is available (or prints an install hint).
#   3. Installs @codebase-foundation/cli globally via npm.
#   4. Preserves ~\.codebase\ data — sessions, projects, memory, and
#      OAuth credentials carry over from v1 with no re-auth.

$ErrorActionPreference = "Stop"

$Pkg = "@codebase-foundation/cli"
$BinName = "codebase"
$NodeMinMajor = 20

function Write-Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "$msg" -ForegroundColor Cyan }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }

function Prompt-YesNo {
    param([string]$Question, [bool]$Default = $true)
    $hint = if ($Default) { "[Y/n]" } else { "[y/N]" }
    # In iex pipelines stdin may not be a tty; accept the default so we
    # don't hang.
    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        return $Default
    }
    $ans = Read-Host "$Question $hint"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $Default }
    return $ans.Trim().ToLower() -in @("y", "yes")
}

# --- detect existing v1 (Go) binary ----------------------------------------
Write-Note "Checking for an existing codebase install..."

$V1Path = $null
$V1Default = Join-Path $env:USERPROFILE ".codebase\bin\codebase.exe"
if (Test-Path $V1Default) {
    $V1Path = $V1Default
} else {
    $cmd = Get-Command $BinName -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and $cmd.Source -notmatch "node_modules") {
        # The npm install lands in <node-prefix>\codebase.cmd which lives
        # under a node_modules tree once resolved. Anything outside that
        # tree we treat as the v1 binary.
        $V1Path = $cmd.Source
    }
}

if ($V1Path) {
    Write-Warn2 "Detected v1 (Go) binary at: $V1Path"
    Write-Host "  v2 is a Node-based rewrite. Your data carries over untouched:"
    Write-Host "    ~\.codebase\credentials.json  (OAuth tokens — no re-auth needed)"
    Write-Host "    ~\.codebase\sessions\         (resume past conversations)"
    Write-Host "    ~\.codebase\projects\         (per-project memory + state)"
    Write-Host ""
    if (Prompt-YesNo "Remove the old v1 binary now?" $true) {
        Remove-Item -Path $V1Path -Force
        Write-Ok "Removed $V1Path"
        # If the v1 PATH entry was ~\.codebase\bin and that dir is now
        # empty, leave it alone — npm's prefix\bin is the new install
        # location and will re-add itself to PATH.
    } else {
        Write-Warn2 "Keeping v1 binary. The npm-installed v2 may not take precedence."
        Write-Warn2 "If 'codebase --version' still reports v1 after install, remove it manually:"
        Write-Warn2 "  Remove-Item '$V1Path'"
    }
}

# --- verify node >= 20 -----------------------------------------------------
$NodeOk = $false
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
    $NodeVer = (& node -v 2>$null).TrimStart("v")
    if ($NodeVer) {
        $NodeMajor = [int]($NodeVer.Split(".")[0])
        if ($NodeMajor -ge $NodeMinMajor) {
            $NodeOk = $true
            Write-Ok "Node.js v$NodeVer (>= $NodeMinMajor.0)"
        } else {
            Write-Warn2 "Node.js v$NodeVer is too old (need >= $NodeMinMajor.0)"
        }
    }
}

if (-not $NodeOk) {
    Write-Host ""
    Write-Host "Node.js >= $NodeMinMajor is required."
    Write-Host ""
    Write-Host "Install one of:"
    Write-Host "  - winget:  winget install OpenJS.NodeJS.LTS"
    Write-Host "  - choco:   choco install nodejs-lts"
    Write-Host "  - scoop:   scoop install nodejs-lts"
    Write-Host "  - Volta:   https://volta.sh"
    Write-Host "  - Direct:  https://nodejs.org/"
    Write-Host ""
    Write-Host "Then re-run:"
    Write-Host "  irm https://codebase.foundation/install.ps1 | iex"
    Write-Host ""
    exit 1
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm is missing. Reinstall Node.js (npm ships with it)."
}

# --- install ---------------------------------------------------------------
Write-Note "Installing $Pkg..."

# On Windows npm's global prefix is typically %APPDATA%\npm and is
# user-writable, so admin/sudo is rarely needed. If the install fails
# we suggest re-running from an elevated shell.
try {
    & npm install -g $Pkg
} catch {
    Write-Warn2 "npm install failed. If this is a permissions error, retry from an elevated PowerShell:"
    Write-Warn2 "  Start-Process powershell -Verb RunAs"
    Write-Warn2 "  irm https://codebase.foundation/install.ps1 | iex"
    throw
}

# --- post-install verification --------------------------------------------
$Installed = Get-Command $BinName -ErrorAction SilentlyContinue
if (-not $Installed) {
    $NpmBin = (& npm prefix -g).Trim()
    Write-Host ""
    Write-Warn2 "Install completed but '$BinName' is not on your PATH."
    Write-Host ""
    Write-Host "Add npm's global bin directory to PATH:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"$NpmBin;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
    Write-Host ""
    Write-Host "Then close and reopen PowerShell."
    exit 1
}

$InstalledVer = (& $BinName --version 2>$null)
if (-not $InstalledVer) { $InstalledVer = "(unknown)" }
Write-Ok "Installed $BinName $InstalledVer"
Write-Ok "Run '$BinName' in any project directory to get started."

# Hint at sign-in if there are no credentials yet.
$CredPath = Join-Path $env:USERPROFILE ".codebase\credentials.json"
if (-not (Test-Path $CredPath) `
    -and -not $env:ANTHROPIC_API_KEY `
    -and -not $env:OPENAI_API_KEY) {
    Write-Host ""
    Write-Host "First time? Sign in for free Claude usage:"
    Write-Host "  $BinName auth login"
}
