# Stage 1: Convert recordings to Piper format (mono) and renumber them by recording time.
#
# Usage:
#   if scripts are blocked
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#
#   .\prepare_wavs.ps1 -InputDir 'C:\Users\...' -OutputDir 'C:\Users\...' -LastIndex 955 -Check
#   .\prepare_wavs.ps1 -InputDir 'C:\Users\...' -OutputDir 'C:\Users\...' -LastIndex 955
#
# Always run once with -Check before the real conversion.

param(
    [Parameter(Mandatory = $true)][string]$InputDir,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [int]$LastIndex = 0,
    [switch]$Check
)
$ErrorActionPreference = "Stop"
$SampleRate = 22050

# Index of the first file to write.
# 0 means "empty dataset, start from 000000".
# Any other value is the last index already present, so we continue after it.
$startIndex = if ($LastIndex -eq 0) { 0 } else { $LastIndex + 1 }

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Error "ffmpeg not found in PATH. Install it with: winget install ffmpeg"
}

# Oldest first, by last write time
$files = Get-ChildItem -Path $InputDir -Filter *.wav -File | Sort-Object LastWriteTime

if ($files.Count -eq 0) {
    Write-Error "No WAV files found in $InputDir"
}

Write-Host "Found $($files.Count) files, ordered oldest first:`n"

$i = $startIndex
foreach ($f in $files) {
    $newName = "{0:D6}.wav" -f $i
    $stamp = $f.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
    Write-Host ("  {0}  <-  {1}  ({2})" -f $newName, $f.Name, $stamp)
    $i++
}

if ($Check) {
    Write-Host "`nCheck only, nothing converted. Rerun without -Check to proceed."
    exit 0
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-Host "`nConverting to mono ${SampleRate}Hz 16-bit..."

$i = $startIndex
foreach ($f in $files) {
    # Refuse to overwrite existing files in the output directory
    $out = Join-Path $OutputDir ("{0:D6}.wav" -f $i)
    if (Test-Path $out) {
        Write-Error "$out already exists. Check -LastIndex before running."
    }
    ffmpeg -y -hide_banner -loglevel error `
        -i $f.FullName -ac 1 -ar $SampleRate -acodec pcm_s16le $out
    if ($LASTEXITCODE -ne 0) {
        Write-Error "ffmpeg failed on $($f.Name)"
    }
    $i++
}

Write-Host "Done: $i files written to $OutputDir"