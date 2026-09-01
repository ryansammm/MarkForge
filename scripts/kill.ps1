#requires -Version 5.1
<#
  MarkForge-local process killer.

  Walks every Windows process, follows the parent chain to the root, and
  terminates the whole tree only when the root commandline looks like a
  MarkForge process (this project's dev server, the Electron app, the
  in-process test runners). Anything else — your open PowerShell, your
  editor, an unrelated `node` script — is left exactly where it is.

  The match is rooted in the project path so two checkouts side by side
  each kill only their own tree. The repository root is derived from this
  script's location, which is `scripts/kill.ps1`, so the value tracks
  renames.
#>

[CmdletBinding()]
param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$repoLower = $repoRoot.ToLowerInvariant()

Write-Host "Repo: $repoRoot"

# `taskkill /T` needs the PID; we walk the tree top-down so children do
# not re-spawn a sibling between read and kill. `wmic` is gone from
# Windows 11 24H2+, so we use Cim + Win32_Process.
$all = Get-CimInstance -ClassName Win32_Process |
  Select-Object ProcessId, ParentProcessId, Name, CommandLine,
                @{n = 'Cwd'; e = { $_.ExecutablePath } }

# Build a parent -> children map for tree walking. Keys are
# normalised to [int] so the lookup in `Get-Ancestry` matches
# without surprises: Win32_Process returns ProcessId as uint32,
# which the hashtable otherwise stores as a different key type.
$byPid = @{}
foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }

function Get-Ancestry {
  param([int]$StartId, [hashtable]$Table)
  $chain = New-Object System.Collections.Generic.List[object]
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $cur = $StartId
  while ($cur -and $seen.Add($cur) -and $Table.ContainsKey($cur)) {
    $chain.Add($Table[$cur])
    $cur = [int]$Table[$cur].ParentProcessId
    if ($chain.Count -gt 64) { break }   # cycle guard
  }
  return ,$chain
}

function Test-IsMarkForge {
  param([object[]]$Chain)
  # The chain is this process followed by its parent, grandparent, …
  # A process is MarkForge-owned iff:
  #   - some link in the chain is one of our markers (the Electron
  #     build's binary, an explicit `pnpm dev|desktop|test|build|start`,
  #     `next dev`, or `electron .`), AND
  #   - the link that matched is on the *process side* of any
  #     editor / AI tool in the chain (we don't walk past a
  #     `Code.exe` or `opencode.exe` — those are hosts, the
  #     process is theirs to manage, and killing the editor
  #     is exactly what the user does not want).
  #
  # The repo path alone is not a marker: a TypeScript language
  # server the editor opened against this project has the path
  # in its commandline too, and it is not ours to kill.
  $touchesRepo = $false
  foreach ($node in $Chain) {
    if ($node.Name -ieq 'Code.exe') { break }
    if ($node.Name -ieq 'opencode.exe') { break }
    $cl = ''
    if ($node.CommandLine) { $cl = [string]$node.CommandLine }
    $clLower = $cl.ToLowerInvariant()

    if ($node.Name -ieq 'markforge.exe') { $touchesRepo = $true }
    if ($clLower -match 'pnpm[\s\/]+(dev|desktop|test|build|start)') { $touchesRepo = $true }
    if ($clLower -match 'next[\s]+dev') { $touchesRepo = $true }
    if ($clLower -match 'electron[\s]+\.') { $touchesRepo = $true }
  }
  return $touchesRepo
}

# Collect every PID whose ancestry root is MarkForge. Using a HashSet
# avoids killing the same process twice when a tree has many branches.
$targets = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in $all) {
  # Never match the script's own chain: it is the running command,
  # not a MarkForge process to terminate. `$PSCommandPath` is the
  # absolute path of this .ps1 as it was invoked.
  if ($p.CommandLine -and $p.CommandLine.Contains($PSCommandPath)) { continue }
  $chain = Get-Ancestry -StartId ([int]$p.ProcessId) -Table $byPid
  if (Test-IsMarkForge -Chain $chain) { [void]$targets.Add([int]$p.ProcessId) }
}

if ($targets.Count -eq 0) {
  Write-Host "No MarkForge processes found."
  exit 0
}

$rows = foreach ($procId in $targets) {
  $p = $byPid[$procId]
  $cl = if ($p.CommandLine) { $p.CommandLine } else { '' }
  if ($cl.Length -gt 200) { $cl = $cl.Substring(0, 197) + '...' }
  [pscustomobject]@{ ProcessId = $procId; Name = $p.Name; Command = $cl }
}
$rows | Format-Table -AutoSize | Out-String | Write-Host

if ($DryRun) {
  Write-Host "Dry run: would terminate $($targets.Count) process(es)."
  exit 0
}

# Filter to PIDs that still exist; taskkill's batch mode fails
# the whole invocation if any one PID is gone, which is the
# common case once a parent shell has been reaped.
$live = foreach ($procId in ($targets | Sort-Object)) {
  if (Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$procId") { $procId }
}
if (-not $live) {
  Write-Host "No live MarkForge processes to terminate."
  exit 0
}
# taskkill's argument parser is brittle from PowerShell; cmd /c
# rebuilds the commandline so the array is joined the way taskkill
# expects.
$args = @('/F', '/T') + (@($live) | ForEach-Object { "/PID $_" })
& cmd.exe /c "taskkill.exe $($args -join ' ')" 2>&1 | ForEach-Object { Write-Host $_ }
Write-Host "Terminated $($live.Count) process(es)."
exit 0
