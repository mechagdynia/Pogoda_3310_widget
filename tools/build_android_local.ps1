param(
  [switch]$SkipWeb
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$javaHomeCandidates = @(@(
  'C:\Program Files\Eclipse Adoptium\jdk-17.0.20.8-hotspot',
  $env:JAVA_HOME
) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'bin\java.exe')) })
$sdkCandidates = @(@(
  $env:ANDROID_HOME,
  $env:ANDROID_SDK_ROOT,
  'C:\Users\mecha\AppData\Local\Android\Sdk'
) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'platforms\android-34\android.jar')) })

if (-not $javaHomeCandidates) { throw 'Nie znaleziono JDK 17. Zainstaluj Eclipse Temurin 17.' }
if (-not $sdkCandidates) { throw 'Nie znaleziono Android SDK z platformą android-34.' }

$javaHome = $javaHomeCandidates[0]
$sdkRoot = $sdkCandidates[0]
$javaExe = Join-Path $javaHome 'bin\java.exe'
$env:JAVA_HOME = $javaHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:Path = "$javaHome\bin;$sdkRoot\cmdline-tools\latest\bin;$sdkRoot\platform-tools;$env:Path"

$localProperties = Join-Path $projectRoot 'android\local.properties'
$sdkProperty = 'sdk.dir=' + ($sdkRoot -replace '\\', '/')
[IO.File]::WriteAllText($localProperties, "$sdkProperty`n", [Text.UTF8Encoding]::new($false))

if (-not $SkipWeb) {
  $nodeCandidates = @(@(
    'D:\pinokio\bin\miniconda\node.exe',
    (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
  if (-not $nodeCandidates) { throw 'Nie znaleziono Node.js.' }
  $nodeExe = $nodeCandidates[0]

  Push-Location $projectRoot
  try {
    & $nodeExe '.\node_modules\typescript\bin\tsc' --noEmit
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript typecheck nie powiódł się.' }
    & $nodeExe '.\node_modules\vite\bin\vite.js' build
    if ($LASTEXITCODE -ne 0) { throw 'Vite build nie powiódł się.' }
    & $nodeExe '.\node_modules\@capacitor\cli\bin\capacitor' sync android
    if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync nie powiódł się.' }
  } finally {
    Pop-Location
  }
}

Push-Location (Join-Path $projectRoot 'android')
try {
  & $javaExe -classpath 'gradle\wrapper\gradle-wrapper.jar' org.gradle.wrapper.GradleWrapperMain assembleDebug
  if ($LASTEXITCODE -ne 0) { throw 'Gradle assembleDebug nie powiódł się.' }
} finally {
  Pop-Location
}

$apk = Join-Path $projectRoot 'android\app\build\outputs\apk\debug\app-debug.apk'
$apkItem = Get-Item -LiteralPath $apk
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $apk).Hash.ToLowerInvariant()
Write-Host "APK: $($apkItem.FullName)"
Write-Host ('Rozmiar: {0:N2} MB' -f ($apkItem.Length / 1MB))
Write-Host "SHA-256: $hash"
