# Konclave — launcher local de dev/demo (Windows).
#
# Fluxo (ADR-0004): builda o UI bundle no Windows, sobe a ponte local
# (`konclave serve`) dentro do WSL escutando só em 127.0.0.1, e abre o navegador.
# Não depende do WSLg — a UI roda no navegador do Windows falando com o backend no WSL
# via localhost.
#
#   Uso:  powershell -ExecutionPolicy Bypass -File scripts\konclave.ps1 [-Port 4762] [-NoBuild]
param(
  [int]$Port = 4762,
  [switch]$NoBuild,
  [string]$Distro = 'Ubuntu'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

if (-not $NoBuild) {
  Write-Host "→ buildando o UI bundle (npm run build)…" -ForegroundColor Cyan
  Push-Location "$repo\ui"
  try { npm run build | Out-Null } finally { Pop-Location }
}

Write-Host "→ subindo a ponte local no WSL ($Distro)…" -ForegroundColor Cyan
# Converte o caminho Windows → /mnt/<drive>/... (evita a mangeladura de barras do wslpath).
$shWin = "$repo\scripts\_serve.sh"
$shWsl = "/mnt/" + $shWin.Substring(0, 1).ToLower() + $shWin.Substring(2).Replace('\', '/')
wsl -d $Distro -u root -- bash $shWsl $Port

Write-Host "→ abrindo http://localhost:$Port/ …" -ForegroundColor Cyan
Start-Process "http://localhost:$Port/"
Write-Host ""
Write-Host "Konclave rodando em http://localhost:$Port/  (Ctrl+clique ou cole no navegador)" -ForegroundColor Green
Write-Host "Para parar:  wsl -d $Distro -u root -- pkill -f 'konclave serve'"
