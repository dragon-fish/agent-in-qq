function Resolve-BridgeStateDir([string]$Backend, [string]$StateDir) {
  $ClaudeStateDir = Join-Path $HOME '.claude\channels\qq'
  if ($Backend -eq 'codex' -and (!$StateDir -or
      [IO.Path]::GetFullPath($StateDir) -eq [IO.Path]::GetFullPath($ClaudeStateDir))) {
    throw 'Codex requires a separate QQ_STATE_DIR'
  }
  if ($StateDir) { [IO.Path]::GetFullPath($StateDir) } else { $ClaudeStateDir }
}

function Get-BridgeProcess([string]$Backend) {
  Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
    Where-Object {
      $_.CommandLine -like '*src/index.ts*' -and (
        $_.CommandLine -like "*--qq-agent-backend=$Backend*" -or
        ($Backend -eq 'claude' -and $_.CommandLine -notlike '*--qq-agent-backend=*')
      )
    }
}
