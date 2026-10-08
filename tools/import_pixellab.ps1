param(
  [Parameter(Mandatory)][string]$Key,         # 'down' (red) or 'up' (blue)
  [Parameter(Mandatory)][string]$CharacterId  # PixelLab character id
)
# Downloads a PixelLab character zip and copies every east-facing clip into
# src/sprites/<Key>/<clip>/<n>.png, then rewrites that fighter's manifest entry.
# Red's feet are thickened afterwards (see tools/thicken_feet.py).
$root = Split-Path $PSScriptRoot -Parent
$work = Join-Path ([System.IO.Path]::GetTempPath()) "netbattle-$Key-zip"
Remove-Item $work, "$work.zip" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
Invoke-WebRequest "https://api.pixellab.ai/mcp/characters/$CharacterId/download" -OutFile "$work.zip" -UseBasicParsing
Expand-Archive "$work.zip" -DestinationPath $work -Force

$sp = Join-Path $root 'src\sprites'
$target = Join-Path $sp $Key
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
$clips = [ordered]@{}
foreach ($anim in Get-ChildItem (Join-Path $work 'Idle\animations') -Directory) {
  $east = Join-Path $anim.FullName 'east'
  if (-not (Test-Path $east)) { continue }
  $files = Get-ChildItem $east -Filter *.png | Sort-Object { [int]([regex]::Match($_.BaseName, '\d+').Value) }
  $dir = Join-Path $target $anim.Name
  New-Item -ItemType Directory -Force $dir | Out-Null
  $i = 0
  foreach ($f in $files) { Copy-Item $f.FullName (Join-Path $dir "$i.png"); $i++ }
  $clips[$anim.Name] = $i
}
$manifestPath = Join-Path $sp 'manifest.json'
$m = if (Test-Path $manifestPath) { Get-Content $manifestPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$m | Add-Member -NotePropertyName $Key -NotePropertyValue ([pscustomobject]$clips) -Force
$m | ConvertTo-Json -Depth 4 | Out-File -Encoding ascii $manifestPath
($clips.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '

if ($Key -eq 'down') { python (Join-Path $PSScriptRoot 'thicken_feet.py') down }
