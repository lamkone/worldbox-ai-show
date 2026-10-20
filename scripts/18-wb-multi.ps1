# 18-wb-multi.ps1 - helper multiagente del bridge WorldBox
#
# Los tokens NO viven en el repositorio. Se leen, por orden, de:
#   1) variables de entorno  $env:WB_TOKEN_ROJO / $env:WB_TOKEN_AZUL
#   2) fichero local         scripts\agents.local.json   (ignorado por git)
#
# agents.local.json tiene esta forma (mira agents.example.json):
#   { "rojo": "TOKEN_DEL_AGENTE_ROJO", "azul": "TOKEN_DEL_AGENTE_AZUL" }
$ErrorActionPreference = 'Stop'

$script:WbBase = 'http://127.0.0.1:8723/cmd'
$script:WbTok = @{ rojo = ''; azul = '' }

$cfgLocal = Join-Path $PSScriptRoot 'agents.local.json'
if (Test-Path -LiteralPath $cfgLocal) {
  $cfg = Get-Content -LiteralPath $cfgLocal -Raw | ConvertFrom-Json
  foreach ($k in @('rojo', 'azul')) {
    if ($cfg.PSObject.Properties.Name -contains $k) { $script:WbTok[$k] = [string]$cfg.$k }
  }
}
foreach ($k in @('rojo', 'azul')) {
  $envTok = [Environment]::GetEnvironmentVariable('WB_TOKEN_' + $k.ToUpper())
  if ($envTok) { $script:WbTok[$k] = $envTok }
}

function Invoke-WbAgent {
  param(
    [Parameter(Mandatory)][string]$Agent,
    [Parameter(Mandatory)][string]$Name,
    [hashtable]$A = @{},
    [int]$TimeoutSec = 60
  )
  $tok = $script:WbTok[$Agent]
  if (-not $tok) { throw "Falta el token del agente '$Agent': crea scripts\agents.local.json o define la variable de entorno WB_TOKEN_$($Agent.ToUpper())." }
  $payload = @{ name = $Name; args = $A } | ConvertTo-Json -Compress -Depth 8
  try {
    $r = Invoke-RestMethod -Uri $script:WbBase -Method Post -TimeoutSec $TimeoutSec `
      -Headers @{ 'X-WB-Token' = $tok } -ContentType 'application/json' -Body $payload
    return [pscustomobject]@{ ok = $true; result = $r.result; tick = $r.tick }
  } catch {
    $raw = $_.ErrorDetails.Message
    $code = $null; $txt = $_.Exception.Message
    if ($raw) {
      try { $o = $raw | ConvertFrom-Json; $code = $o.error.code; $txt = $o.error.message } catch { $txt = $raw }
    }
    return [pscustomobject]@{ ok = $false; code = $code; error = $txt }
  }
}

function Show-Wb {
  param([string]$Label, $R)
  Write-Output ("--- " + $Label)
  if ($R.ok) { Write-Output ($R.result | ConvertTo-Json -Compress -Depth 8) }
  else { Write-Output ("    ERROR " + $R.code + ": " + $R.error) }
}

function Wait-WbWorld {
  param([string]$Agent = 'rojo', [int]$Intentos = 90)
  for ($i = 1; $i -le $Intentos; $i++) {
    $s = Invoke-WbAgent -Agent $Agent -Name 'get_world_state'
    if ($s.ok -and -not $s.result.world_loading) { return $s }
    Start-Sleep -Milliseconds 700
  }
  return $s
}
