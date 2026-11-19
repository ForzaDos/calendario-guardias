# crear-instalador-exe.ps1 — arma el instalador de UN SOLO ARCHIVO (.exe) con el MSI adentro.
# Uso (desde esta carpeta):  .\crear-instalador-exe.ps1
# Requisitos: haber corrido antes build.ps1 (genera dist\Guardias-Setup-1.0.0.msi). Usa el compilador de
# .NET Framework 4 que trae Windows (no hace falta instalar nada).
$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$ver  = (Get-Content (Join-Path $base 'VERSION') -TotalCount 1).Trim()
$msi  = Join-Path $base 'dist\Guardias-Setup-1.0.0.msi'     # el nombre del MSI no cambia; la versión va adentro (VERSION)
$out  = Join-Path $base ('dist\Instalar-Calendario-Guardias-' + $ver + '.exe')
$csc  = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $msi)) { throw "Falta $msi : corré primero build.ps1" }

# 1) comprobación: el paquete NO puede llevar datos del sanatorio (instalación limpia)
$chk = Join-Path $env:TEMP ('chk_msi_' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $chk | Out-Null
$p = Start-Process msiexec -ArgumentList '/a', "`"$msi`"", '/qn', "TARGETDIR=$chk" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw 'No pude abrir el MSI para revisarlo' }
$malos = Get-ChildItem $chk -Recurse -Force -File | Where-Object { $_.Name -in 'guardias.db','config.json' -or $_.Extension -in '.db','.db-wal','.db-shm' -or $_.FullName -match '\\datos\\' }
Remove-Item $chk -Recurse -Force -ErrorAction SilentlyContinue
if ($malos) { throw ('El MSI lleva datos que no corresponden: ' + ($malos.FullName -join ', ')) }
Write-Host 'OK: el MSI no lleva base de datos, médicos ni guardias.' -ForegroundColor Green

# 2) compilar el .exe con el MSI como recurso
if (Test-Path $out) { Remove-Item $out -Force }
# versión visible en las propiedades del .exe
$ai = Join-Path $env:TEMP 'AssemblyInfoGuardias.cs'
$v4 = $ver + '.0'
"using System.Reflection;[assembly: AssemblyTitle(`"Instalador del Calendario de guardias`")][assembly: AssemblyProduct(`"Calendario de guardias`")][assembly: AssemblyVersion(`"$v4`")][assembly: AssemblyFileVersion(`"$v4`")]" | Set-Content $ai -Encoding ascii
& $csc /nologo /target:winexe /optimize+ "/out:$out" "/win32icon:$base\icono.ico" "/win32manifest:$base\instalador\Instalar.manifest" `
       "/resource:$msi,msi" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "$base\instalador\Instalar.cs" $ai
if ($LASTEXITCODE -ne 0) { throw 'falló la compilación del instalador' }
# 3) version.json: el archivo chico que el programa consulta para avisar de versiones nuevas (se sube a Drive junto con el instalador)
$nov = ''
$novFile = Join-Path $base 'NOVEDADES.txt'
if (Test-Path $novFile) { $nov = ((Get-Content $novFile -Encoding UTF8 -TotalCount 1) -join '').Trim() }
# huella y tamaño del instalador: el programa los usa para comprobar que lo que baja de Drive es exactamente este archivo
$sha = (Get-FileHash $out -Algorithm SHA256).Hash.ToLower()
$bytes = (Get-Item $out).Length
$json = [ordered]@{ version = $ver; novedades = $nov; sha256 = $sha; bytes = [int64]$bytes } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $base 'dist\version.json'), $json, (New-Object Text.UTF8Encoding $false))
Write-Host ('version.json generado: ' + $json.Replace("`r`n",' ')) -ForegroundColor Green
Get-ChildItem $out | Select-Object Name, @{n='MB'; e={ [math]::Round($_.Length / 1MB, 1) }}
