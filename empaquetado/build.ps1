# build.ps1 — arma el instalador del Calendario de guardias (Windows, x64)
# Uso: .\build.ps1    (requiere las herramientas en tools\ y .venv\ ya instaladas)
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
Set-Location $base

$dotnet  = Join-Path $base 'tools\dotnet\dotnet.exe'
$wix     = Join-Path $base 'tools\wix\wix.exe'
$pyi     = Join-Path $base '.venv\Scripts\pyinstaller.exe'
$proyecto = Join-Path $base '..'
$chrome  = 'C:\Program Files\Google\Chrome\Application\chrome.exe'

# El SDK de .NET necesita TMP/TEMP y HOME utilizables; en esta máquina el TEMP por defecto
# rompe MSBuild y NuGet.
$env:TMP  = Join-Path $base '.tmp2'
$env:TEMP = $env:TMP
$env:DOTNET_CLI_HOME = Join-Path $base '.dotnet_home'
$env:NUGET_PACKAGES  = Join-Path $base '.nuget'
$env:APPDATA         = Join-Path $base '.appdata'
$env:LOCALAPPDATA    = $env:APPDATA
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_NOLOGO = '1'
New-Item -ItemType Directory -Force -Path $env:TMP, $env:DOTNET_CLI_HOME, $env:APPDATA | Out-Null

Write-Host '== 1/5 icono ==' -ForegroundColor Cyan
$pyIcono = Join-Path $base '.venv\Scripts\python.exe'
if (-not (Test-Path $pyIcono)) { $pyIcono = 'python' }
& $pyIcono icono.py

Write-Host '== 2/5 copiar fuentes ==' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path 'app' | Out-Null
Copy-Item (Join-Path $proyecto 'servidor.py')   'app\servidor.py'   -Force
Copy-Item (Join-Path $proyecto 'guardias.html') 'app\guardias.html' -Force

Write-Host '== 3/5 motor (PyInstaller) ==' -ForegroundColor Cyan
Remove-Item 'dist\motor' -Recurse -Force -ErrorAction SilentlyContinue
# actualizaciones.json (dónde buscar versiones nuevas) no va al repo: se crea a mano en esta carpeta y se incluye si existe
$extraUpd = @()
if (Test-Path (Join-Path $base 'actualizaciones.json')) { $extraUpd = @('--add-data', 'actualizaciones.json;.') }
# buzon.json (dirección del buzón del grupo) tampoco va al repo: {"url": "https://..."}; se incluye si existe
$extraBuz = @()
if (Test-Path (Join-Path $base 'buzon.json')) { $extraBuz = @('--add-data', 'buzon.json;.') }
& $pyi --noconfirm --clean --onedir --console --icon icono.ico `
       --add-data "app\guardias.html;." @extraUpd @extraBuz --name motor `
       --distpath dist --workpath build --specpath . 'app\servidor.py'
if ($LASTEXITCODE -ne 0) { throw 'falló PyInstaller' }
# nunca empaquetar datos del sanatorio
Remove-Item 'dist\motor\datos' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'dist\motor\config.json' -Force -ErrorAction SilentlyContinue

Write-Host '== 4/5 ventana (dotnet publish) ==' -ForegroundColor Cyan
Remove-Item 'dist\app' -Recurse -Force -ErrorAction SilentlyContinue
& $dotnet publish host\CalendarioGuardias.csproj -c Release -r win-x64 --self-contained true `
           -o dist\app -nodeReuse:false
if ($LASTEXITCODE -ne 0) { throw 'falló dotnet publish' }
Remove-Item 'dist\app\host.log' -Force -ErrorAction SilentlyContinue
Remove-Item 'dist\app\ventana' -Recurse -Force -ErrorAction SilentlyContinue

Write-Host '== 5/5 instalador MSI (WiX) ==' -ForegroundColor Cyan
Remove-Item 'dist\Guardias-Setup-1.0.0.msi' -Force -ErrorAction SilentlyContinue
# la versión del MSI sale de VERSION: si fuera menor o igual que la instalada, Windows rechazaría la actualización
$ver = (Get-Content (Join-Path $base 'VERSION') -TotalCount 1).Trim()
& $wix build 'wix\instalador.wxs' -o 'dist\Guardias-Setup-1.0.0.msi' -arch x64 -d "AppVersion=$ver"
if ($LASTEXITCODE -ne 0) { throw 'falló WiX' }

Write-Host '== extra: guía en PDF ==' -ForegroundColor Cyan
if (Test-Path $chrome) {
  & $chrome --headless=new --disable-gpu --no-first-run --no-pdf-header-footer `
            "--print-to-pdf=$base\dist\Guia-instalacion.pdf" `
            "file:///$($base -replace '\\','/')/guia/guia-instalacion.html" | Out-Null
  & $chrome --headless=new --disable-gpu --no-first-run --no-pdf-header-footer "--print-to-pdf=$base\dist\Guia-uso.pdf" "file:///$($base -replace '\\','/')/guia/guia-uso.html" | Out-Null
}

Write-Host ''
Write-Host 'Listo:' -ForegroundColor Green
Get-ChildItem 'dist\Guardias-Setup-*.msi', 'dist\Guia-instalacion.pdf' -ErrorAction SilentlyContinue |
  Select-Object Name, @{n='MB'; e={ [math]::Round($_.Length / 1MB, 1) } }
