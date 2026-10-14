#Requires -Version 5.1
<#
================================================================================
 MeigFACE - runtime components installer (Windows, PowerShell 5.1+)
================================================================================

WHAT THIS SCRIPT DOES
  1. Detects the Windows display language. Only the six languages built into
     MeigFACE are handled (it, en, fr, de, es, pt); anything else exits.
  2. Refuses to run if MeigFACE's settings.json already holds at least one of
     the five executable/model paths: that means a manual setup was started and
     must not be overwritten.
  3. Detects the NVIDIA GPU (dedicated VRAM, driver version) and whether the
     system RAM is DDR5/LPDDR5, then picks a download profile (table below).
  4. Creates %USERPROFILE%\Downloads\MeigFACE with the sub-folders
       llama.cpp\              llama-server + CUDA runtime DLLs
       gguf\                   the conversation model
       whisper\whisper-server\ whisper-server + its CUDA DLLs
       whisper\bin\            the Whisper ggml model
       piper\                  Piper TTS executable
     downloads every component in the order the app lists them, extracts the
     zip archives (overwriting), deletes each archive once extracted, 
     and skips every step whose result already
     exists so the script can be re-run after an interruption.
  5. Downloads one Piper voice for the detected language, of a single gender,
     into the app's own voices\<lang>\<gender>\ folder 
     (next to this script - it must sit in the same folder as MeigFACE.exe).
  6. Writes the five paths into settings.json so the app starts ready to use.

HOW TO RUN
    From a terminal in the app folder:
    Unblock-File .\MeigFACE-setup.ps1
    then: Right-click > "Run with PowerShell"
    or from a terminal in the app folder:
    powershell -ExecutionPolicy Bypass -File .\MeigFACE-setup.ps1

HARDWARE PROFILES (first matching row wins; VRAM always beats RAM type)
  +----------------------------+-----------------------+---------------------------+
  | Condition                  | Conversation model    | Whisper model             |
  +----------------------------+-----------------------+---------------------------+
  | VRAM >= 6 GB               | SmolLM3-3B Q8_0       | large-v3-turbo-q8_0       |
  | VRAM 4-5 GB                | SmolLM3-3B Q4_K_M     | large-v3-turbo-q8_0       |
  | VRAM 3 GB                  | Qwen3-1.7B Q4_K_M     | small                     |
  | VRAM 2 GB AND language=en  | Qwen3.5-0.8B Q4_K_M   | tiny                      |
  | DDR5/LPDDR5, none above    | SmolLM3-3B Q4_K_M     | small (CPU inference)     |
  | otherwise                  | not eligible - exit   |                           |
  +----------------------------+-----------------------+---------------------------+
  The 2 GB tier is English-only because Qwen3.5-0.8B can hold a very simple
  chat in English (and Chinese) but not in the other five languages.
  Thresholds are applied with a 0.5 GB tolerance because cards report slightly
  less than their nominal size (a "4 GB" card reports 4095 MiB, some mobile
  parts report 3.9 GB).

MEASURED VRAM USAGE (steady state, while talking to the avatar, read from Task
Manager > GPU > dedicated memory, so it includes the desktop compositor and the
app's WebView2). Whisper .bin files weigh the same whether English-only or
multilingual, so only multilingual models were measured.
  SmolLM3-3B Q8_0   + whisper small                 4.6 GB
  SmolLM3-3B Q8_0   + whisper medium                5.6 GB  (rejected, see below)
  SmolLM3-3B Q8_0   + whisper large-v3-turbo-q8_0   4.9 GB
  SmolLM3-3B Q4_K_M + whisper small                 3.3 GB
  SmolLM3-3B Q4_K_M + whisper large-v3-turbo-q8_0   3.7 GB
  Qwen3-1.7B Q4_K_M + whisper small                 2.7 GB
  Qwen3-1.7B Q4_K_M + whisper tiny                  2.2 GB
  Qwen3.5-0.8B Q4_K_M + whisper small               1.8 GB
  Qwen3.5-0.8B Q4_K_M + whisper tiny                1.4 GB
  These were measured on a card larger than the tier limits; on a 3 GB or 4 GB
  card the headroom is ~300 MB and the driver may behave differently close to
  the limit. Real validation on those cards is still pending.

WHY THESE WHISPER MODELS
  medium (fp16) is less accurate than large-v3-turbo and heavier: rejected.
  Among the large models only the turbo variant is fast enough (4 decoder
  layers instead of 32, speed comparable to small); its q8_0 quantisation
  keeps almost all of the accuracy while saving ~800 MB of VRAM versus fp16,
  q5 saves only ~300 MB more and loses accuracy. tiny and small are used
  unquantised: the saving is negligible and they are already the weakest.

ADAPTING THIS SCRIPT (for a person or an AI assistant)
  * Another language: add a row to $Messages (all keys), a row to $Voices
    (Piper voice from https://huggingface.co/rhasspy/piper-voices, one .onnx +
    its .onnx.json), and pick a conversation model that actually speaks that
    language in each tier of Select-Profile, keeping the VRAM budget above.
  * Non-NVIDIA GPU: replace the llama.cpp and whisper.cpp zips with the
    Vulkan/HIP builds, drop the cudart zip, and replace Get-NvidiaInfo with a
    detection that fits the vendor. The CUDA builds are used here because
    NVIDIA is what general-public machines ship with.
  * Update-only: llama.cpp has no "latest" download URL, the build number in
    $Urls.LlamaZip / $Urls.CudartZip must be bumped by hand.

KNOWN LIMITS
  * The CUDA builds are expected to fall back to CPU when no NVIDIA device is
    present (DDR5 profile). This has not been verified on this exact build.
  * Piper is the last native Windows build (2023.11.14-2); newer Piper is
    pip-only. It is the version all the measurements were taken with.
  * es_ES-sharvard has two speakers; the app currently always uses speaker 0.
================================================================================
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

# Minimum NVIDIA driver for the CUDA 13.x runtime shipped with llama.cpp. 580
# is NVIDIA's published floor for CUDA 13.0; CUDA 13.3 may need a newer one, so
# this is a warning, never a hard stop.
$MinDriverMajor = 580

$SupportedLanguages = @('it', 'en', 'fr', 'de', 'es', 'pt')

$Urls = @{
    LlamaZip   = 'https://github.com/ggml-org/llama.cpp/releases/download/b11600/llama-b11600-bin-win-cuda-13.4-x64.zip'
    CudartZip  = 'https://github.com/ggml-org/llama.cpp/releases/download/b11600/cudart-llama-bin-win-cuda-13.4-x64.zip'
    WhisperZip = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip'
    PiperZip   = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip'
}

$LlmModels = @{
    SmolLM3_Q8 = @{ File = 'SmolLM3-Q8_0.gguf';        Url = 'https://huggingface.co/ggml-org/SmolLM3-3B-GGUF/resolve/main/SmolLM3-Q8_0.gguf?download=true' }
    SmolLM3_Q4 = @{ File = 'SmolLM3-Q4_K_M.gguf';      Url = 'https://huggingface.co/ggml-org/SmolLM3-3B-GGUF/resolve/main/SmolLM3-Q4_K_M.gguf?download=true' }
    Qwen3_1_7B = @{ File = 'Qwen3-1.7B-Q4_K_M.gguf';   Url = 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf?download=true' }
    Qwen35_08B = @{ File = 'Qwen3.5-0.8B-Q4_K_M.gguf'; Url = 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf?download=true' }
}

$WhisperModels = @{
    Tiny  = @{ File = 'ggml-tiny.bin';                Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin?download=true' }
    Small = @{ File = 'ggml-small.bin';               Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin?download=true' }
    Large = @{ File = 'ggml-large-v3-turbo-q8_0.bin'; Url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin?download=true' }
}

# One medium-quality voice per language. `File` is the on-disk base name: the
# Portuguese voice is renamed to ASCII so the path never depends on the console
# code page when Piper receives it as a command-line argument.
$Voices = @{
    it = @{ Gender = 'female'; File = 'it_IT-paola-medium';              Base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium' }
    en = @{ Gender = 'male';   File = 'en_US-lessac-medium';             Base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium' }
    fr = @{ Gender = 'female'; File = 'fr_FR-siwis-medium';              Base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR/siwis/medium/fr_FR-siwis-medium' }
    de = @{ Gender = 'male';   File = 'de_DE-thorsten_emotional-medium'; Base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten_emotional/medium/de_DE-thorsten_emotional-medium' }
    es = @{ Gender = 'male';   File = 'es_ES-sharvard-medium';           Base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/sharvard/medium/es_ES-sharvard-medium' }
    pt = @{ Gender = 'male';   File = 'pt_PT-tugao-medium';              Base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_PT/tug%C3%A3o/medium/pt_PT-tug%C3%A3o-medium' }
}

# Tauri store used by the app (plugin-store v2: a flat JSON object).
$SettingsDir  = Join-Path $env:APPDATA 'com.giuliomagini.meigface'
$SettingsFile = Join-Path $SettingsDir 'settings.json'
$SettingsKeys = @('llm.serverPath', 'llm.modelPath', 'llm.whisperPath', 'llm.whisperModelPath', 'llm.piperPath')

$Root       = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\MeigFACE'
$LlamaDir   = Join-Path $Root 'llama.cpp'
$GgufDir    = Join-Path $Root 'gguf'
$WhisperDir = Join-Path $Root 'whisper\whisper-server'
$WhisperBin = Join-Path $Root 'whisper\bin'
$PiperDir   = Join-Path $Root 'piper'
$VoicesRoot = Join-Path $PSScriptRoot 'voices'

# --------------------------------------------------------------------------
# Messages (all six languages, same keys). {0}/{1} are -f placeholders.
# --------------------------------------------------------------------------
$Messages = @{
    en = @{
        title       = 'MeigFACE - automatic setup'
        alreadySet  = 'settings.json already contains executable paths: a manual setup was started. Nothing was changed.'
        appMissing  = 'MeigFACE.exe was not found next to this script. Voices will still be placed in {0}; move the folder next to the app if needed.'
        detecting   = 'Detecting hardware...'
        gpuFound    = 'GPU: {0} - {1:N1} GB dedicated VRAM - driver {2}'
        gpuNone     = 'GPU: no NVIDIA card detected'
        ramType     = 'System RAM: {0}'
        driverOld   = 'WARNING: driver {0} is older than {1}. llama-server needs a recent driver for CUDA 13; update it if the model fails to start.'
        profile     = 'Profile: {0} -> {1} + {2}'
        notEligible = 'This PC does not meet the minimum requirements (NVIDIA card with at least 3 GB of VRAM, 2 GB for English only, or DDR5 RAM). Nothing was downloaded.'
        mkdir       = 'Creating folder: {0}'
        dirExists   = 'Folder already exists: {0}'
        download    = 'Downloading file: {0}'
        resume      = 'Resuming interrupted download: {0}'
        skipDl      = 'Already downloaded, skipping: {0}'
        bitsFallback = 'Background transfer service unavailable, using a plain download (no resume).'
        extract     = 'Extracting {0} into {1}'
        skipExtract = 'Already extracted, skipping: {0}'
        cleanup     = 'Removing archive: {0}'
        exeMissing  = '{0} not found after extraction in {1}'
        voice       = 'Installing voice {0} for "{1}" in {2}'
        settings    = 'Writing executable paths to {0}'
        done        = 'Done. Launch MeigFACE: every path is already set.'
        failed      = 'Setup stopped: {0}'
        pressKey    = 'Press Enter to exit'
    }
    it = @{
        title       = 'MeigFACE - installazione automatica'
        alreadySet  = 'settings.json contiene già dei percorsi di eseguibili: è stata avviata una configurazione manuale. Non è stato modificato nulla.'
        appMissing  = 'MeigFACE.exe non trovato accanto a questo script. Le voci saranno comunque messe in {0}; sposta la cartella accanto all''app se necessario.'
        detecting   = 'Rilevamento hardware...'
        gpuFound    = 'GPU: {0} - {1:N1} GB di VRAM dedicata - driver {2}'
        gpuNone     = 'GPU: nessuna scheda NVIDIA rilevata'
        ramType     = 'RAM di sistema: {0}'
        driverOld   = 'ATTENZIONE: il driver {0} è più vecchio di {1}. llama-server richiede un driver recente per CUDA 13; aggiornalo se il modello non si avvia.'
        profile     = 'Profilo: {0} -> {1} + {2}'
        notEligible = 'Questo PC non soddisfa i requisiti minimi (scheda NVIDIA con almeno 3 GB di VRAM, 2 GB solo per l''inglese, oppure RAM DDR5). Non è stato scaricato nulla.'
        mkdir       = 'Creo la cartella: {0}'
        dirExists   = 'Cartella già presente: {0}'
        download    = 'Download file: {0}'
        resume      = 'Riprendo il download interrotto: {0}'
        skipDl      = 'Già scaricato, salto: {0}'
        bitsFallback = 'Servizio di trasferimento in background non disponibile, uso un download semplice (senza ripresa).'
        extract     = 'Scompatto {0} dentro {1}'
        cleanup     = 'Rimuovo l''archivio: {0}'
        skipExtract = 'Già scompattato, salto: {0}'
        exeMissing  = '{0} non trovato dopo lo scompattamento in {1}'
        voice       = 'Installo la voce {0} per "{1}" in {2}'
        settings    = 'Scrivo i percorsi degli eseguibili in {0}'
        done        = 'Fatto. Avvia MeigFACE: tutti i percorsi sono già impostati.'
        failed      = 'Installazione interrotta: {0}'
        pressKey    = 'Premi Invio per uscire'
    }
    fr = @{
        title       = 'MeigFACE - installation automatique'
        alreadySet  = 'settings.json contient déjà des chemins d''exécutables : une configuration manuelle a été commencée. Rien n''a été modifié.'
        appMissing  = 'MeigFACE.exe est introuvable à côté de ce script. Les voix seront tout de même placées dans {0} ; déplacez le dossier à côté de l''application si besoin.'
        detecting   = 'Détection du matériel...'
        gpuFound    = 'GPU : {0} - {1:N1} Go de VRAM dédiée - pilote {2}'
        gpuNone     = 'GPU : aucune carte NVIDIA détectée'
        ramType     = 'RAM système : {0}'
        driverOld   = 'ATTENTION : le pilote {0} est plus ancien que {1}. llama-server a besoin d''un pilote récent pour CUDA 13 ; mettez-le à jour si le modèle ne démarre pas.'
        profile     = 'Profil : {0} -> {1} + {2}'
        notEligible = 'Ce PC ne remplit pas les conditions minimales (carte NVIDIA avec au moins 3 Go de VRAM, 2 Go pour l''anglais uniquement, ou RAM DDR5). Rien n''a été téléchargé.'
        mkdir       = 'Création du dossier : {0}'
        dirExists   = 'Dossier déjà présent : {0}'
        download    = 'Téléchargement du fichier : {0}'
        resume      = 'Reprise du téléchargement interrompu : {0}'
        skipDl      = 'Déjà téléchargé, ignoré : {0}'
        bitsFallback = 'Service de transfert en arrière-plan indisponible, téléchargement simple (sans reprise).'
        extract     = 'Extraction de {0} dans {1}'
        skipExtract = 'Déjà extrait, ignoré : {0}'
        cleanup     = 'Suppression de l''archive : {0}'
        exeMissing  = '{0} introuvable après extraction dans {1}'
        voice       = 'Installation de la voix {0} pour « {1} » dans {2}'
        settings    = 'Écriture des chemins des exécutables dans {0}'
        done        = 'Terminé. Lancez MeigFACE : tous les chemins sont déjà définis.'
        failed      = 'Installation interrompue : {0}'
        pressKey    = 'Appuyez sur Entrée pour quitter'
    }
    de = @{
        title       = 'MeigFACE - automatische Einrichtung'
        alreadySet  = 'settings.json enthält bereits Pfade zu ausführbaren Dateien: Eine manuelle Einrichtung wurde begonnen. Es wurde nichts geändert.'
        appMissing  = 'MeigFACE.exe wurde neben diesem Skript nicht gefunden. Die Stimmen werden trotzdem in {0} abgelegt; verschiebe den Ordner bei Bedarf neben die App.'
        detecting   = 'Hardware wird erkannt...'
        gpuFound    = 'GPU: {0} - {1:N1} GB dedizierter VRAM - Treiber {2}'
        gpuNone     = 'GPU: keine NVIDIA-Karte erkannt'
        ramType     = 'Arbeitsspeicher: {0}'
        driverOld   = 'WARNUNG: Treiber {0} ist älter als {1}. llama-server braucht für CUDA 13 einen aktuellen Treiber; aktualisiere ihn, falls das Modell nicht startet.'
        profile     = 'Profil: {0} -> {1} + {2}'
        notEligible = 'Dieser PC erfüllt die Mindestanforderungen nicht (NVIDIA-Karte mit mindestens 3 GB VRAM, 2 GB nur für Englisch, oder DDR5-RAM). Es wurde nichts heruntergeladen.'
        mkdir       = 'Ordner wird erstellt: {0}'
        dirExists   = 'Ordner bereits vorhanden: {0}'
        download    = 'Datei wird heruntergeladen: {0}'
        resume      = 'Unterbrochener Download wird fortgesetzt: {0}'
        skipDl      = 'Bereits heruntergeladen, übersprungen: {0}'
        bitsFallback = 'Hintergrundübertragungsdienst nicht verfügbar, einfacher Download (ohne Fortsetzung).'
        extract     = '{0} wird nach {1} entpackt'
        skipExtract = 'Bereits entpackt, übersprungen: {0}'
        cleanup     = 'Archiv wird entfernt: {0}'
        exeMissing  = '{0} nach dem Entpacken in {1} nicht gefunden'
        voice       = 'Stimme {0} für „{1}“ wird in {2} installiert'
        settings    = 'Pfade der ausführbaren Dateien werden in {0} geschrieben'
        done        = 'Fertig. Starte MeigFACE: Alle Pfade sind bereits gesetzt.'
        failed      = 'Einrichtung abgebrochen: {0}'
        pressKey    = 'Zum Beenden Eingabetaste drücken'
    }
    es = @{
        title       = 'MeigFACE - instalación automática'
        alreadySet  = 'settings.json ya contiene rutas de ejecutables: se inició una configuración manual. No se ha modificado nada.'
        appMissing  = 'No se encontró MeigFACE.exe junto a este script. Las voces se colocarán igualmente en {0}; mueve la carpeta junto a la aplicación si hace falta.'
        detecting   = 'Detectando hardware...'
        gpuFound    = 'GPU: {0} - {1:N1} GB de VRAM dedicada - controlador {2}'
        gpuNone     = 'GPU: no se detectó ninguna tarjeta NVIDIA'
        ramType     = 'RAM del sistema: {0}'
        driverOld   = 'ATENCIÓN: el controlador {0} es anterior a {1}. llama-server necesita un controlador reciente para CUDA 13; actualízalo si el modelo no arranca.'
        profile     = 'Perfil: {0} -> {1} + {2}'
        notEligible = 'Este PC no cumple los requisitos mínimos (tarjeta NVIDIA con al menos 3 GB de VRAM, 2 GB solo para inglés, o RAM DDR5). No se ha descargado nada.'
        mkdir       = 'Creando carpeta: {0}'
        dirExists   = 'La carpeta ya existe: {0}'
        download    = 'Descargando archivo: {0}'
        resume      = 'Reanudando descarga interrumpida: {0}'
        skipDl      = 'Ya descargado, se omite: {0}'
        bitsFallback = 'Servicio de transferencia en segundo plano no disponible, descarga simple (sin reanudación).'
        extract     = 'Extrayendo {0} en {1}'
        skipExtract = 'Ya extraído, se omite: {0}'
        cleanup     = 'Eliminando el archivo comprimido: {0}'
        exeMissing  = '{0} no encontrado tras la extracción en {1}'
        voice       = 'Instalando la voz {0} para «{1}» en {2}'
        settings    = 'Escribiendo las rutas de los ejecutables en {0}'
        done        = 'Listo. Abre MeigFACE: todas las rutas ya están configuradas.'
        failed      = 'Instalación interrumpida: {0}'
        pressKey    = 'Pulsa Intro para salir'
    }
    pt = @{
        title       = 'MeigFACE - instalação automática'
        alreadySet  = 'O settings.json já contém caminhos de executáveis: foi iniciada uma configuração manual. Nada foi alterado.'
        appMissing  = 'MeigFACE.exe não foi encontrado ao lado deste script. As vozes serão colocadas na mesma em {0}; mova a pasta para junto da aplicação se necessário.'
        detecting   = 'A detetar o hardware...'
        gpuFound    = 'GPU: {0} - {1:N1} GB de VRAM dedicada - controlador {2}'
        gpuNone     = 'GPU: nenhuma placa NVIDIA detetada'
        ramType     = 'RAM do sistema: {0}'
        driverOld   = 'ATENÇÃO: o controlador {0} é anterior a {1}. O llama-server precisa de um controlador recente para CUDA 13; atualize-o se o modelo não arrancar.'
        profile     = 'Perfil: {0} -> {1} + {2}'
        notEligible = 'Este PC não cumpre os requisitos mínimos (placa NVIDIA com pelo menos 3 GB de VRAM, 2 GB apenas para inglês, ou RAM DDR5). Nada foi transferido.'
        mkdir       = 'A criar a pasta: {0}'
        dirExists   = 'Pasta já existente: {0}'
        download    = 'A transferir o ficheiro: {0}'
        resume      = 'A retomar a transferência interrompida: {0}'
        skipDl      = 'Já transferido, ignorado: {0}'
        bitsFallback = 'Serviço de transferência em segundo plano indisponível, transferência simples (sem retoma).'
        extract     = 'A extrair {0} para {1}'
        skipExtract = 'Já extraído, ignorado: {0}'
        cleanup     = 'A remover o arquivo: {0}'
        exeMissing  = '{0} não encontrado após a extração em {1}'
        voice       = 'A instalar a voz {0} para «{1}» em {2}'
        settings    = 'A escrever os caminhos dos executáveis em {0}'
        done        = 'Concluído. Abra o MeigFACE: todos os caminhos já estão definidos.'
        failed      = 'Instalação interrompida: {0}'
        pressKey    = 'Prima Enter para sair'
    }
}

# --------------------------------------------------------------------------
# Output helpers
# --------------------------------------------------------------------------
$script:M = $null   # message table of the detected language, set in Main

function Say {
    param([string]$Key, [object[]]$Values = @())
    Write-Host ($script:M[$Key] -f $Values)
}

function Warn {
    param([string]$Key, [object[]]$Values = @())
    Write-Host ($script:M[$Key] -f $Values) -ForegroundColor Yellow
}

function Wait-Exit {
    param([int]$Code)
    Write-Host ''
    if ($script:M) { Read-Host $script:M.pressKey | Out-Null } else { Read-Host 'Press Enter to exit' | Out-Null }
    exit $Code
}

# --------------------------------------------------------------------------
# Detection
# --------------------------------------------------------------------------

# Windows display language (Get-UICulture), not the regional format
# (Get-Culture): the two can differ and only the former is what the app shows.
function Get-UiLanguage {
    return (Get-UICulture).TwoLetterISOLanguageName.ToLowerInvariant()
}

# True when settings.json already holds at least one non-empty executable path.
function Test-ManualSetup {
    if (-not (Test-Path -LiteralPath $SettingsFile)) { return $false }
    try {
        $json = Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    foreach ($key in $SettingsKeys) {
        $prop = $json.PSObject.Properties[$key]
        if ($prop -and -not [string]::IsNullOrWhiteSpace([string]$prop.Value)) { return $true }
    }
    return $false
}

# Convert the registry's Windows driver version (e.g. 32.0.15.8000) into the
# NVIDIA marketing version (580.00): last digit of the third group followed by
# the fourth group, with a dot before the last two digits. Best effort only.
function ConvertTo-NvidiaVersion {
    param([string]$WindowsVersion)
    $parts = $WindowsVersion -split '\.'
    if ($parts.Count -ne 4) { return $null }
    $digits = $parts[2].Substring($parts[2].Length - 1) + $parts[3]
    if ($digits.Length -lt 3) { return $null }
    return $digits.Substring(0, $digits.Length - 2) + '.' + $digits.Substring($digits.Length - 2)
}

# First NVIDIA GPU: name, dedicated VRAM in MiB, driver version. nvidia-smi is
# preferred; the registry is the fallback. Win32_VideoController.AdapterRAM is
# deliberately not used: it is a 32-bit field and saturates at 4 GB.
function Get-NvidiaInfo {
    $smi = @(
        (Join-Path $env:SystemRoot 'System32\nvidia-smi.exe'),
        (Join-Path $env:ProgramFiles 'NVIDIA Corporation\NVSMI\nvidia-smi.exe')
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

    if ($smi) {
        try {
            $line = & $smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null | Select-Object -First 1
            if ($line) {
                $f = $line -split ',\s*'
                return @{ Name = $f[0].Trim(); VramMiB = [double]$f[1]; Driver = $f[2].Trim() }
            }
        } catch { }
    }

    $classKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
    $adapters = Get-ChildItem -Path $classKey -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue } |
        Where-Object { ($_.PSObject.Properties['ProviderName'] -and $_.ProviderName -match 'NVIDIA') -or
                       ($_.PSObject.Properties['DriverDesc'] -and $_.DriverDesc -match 'NVIDIA') }
    foreach ($a in $adapters) {
        $size = $a.PSObject.Properties['HardwareInformation.qwMemorySize']
        if ($size -and $size.Value) {
            $driver = $null
            if ($a.PSObject.Properties['DriverVersion']) { $driver = ConvertTo-NvidiaVersion $a.DriverVersion }
            return @{ Name = $a.DriverDesc; VramMiB = [double]$size.Value / 1MB; Driver = $driver }
        }
    }
    return $null
}

# SMBIOSMemoryType 34 = DDR5, 35 = LPDDR5 (laptops).
function Get-RamType {
    $types = Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue | ForEach-Object { $_.SMBIOSMemoryType }
    if ($types -contains 34) { return 'DDR5' }
    if ($types -contains 35) { return 'LPDDR5' }
    return 'other'
}

# Pick the download profile. VRAM always wins over RAM type; thresholds carry
# a 0.5 GB tolerance for cards that report a little less than nominal.
function Select-Profile {
    param([double]$VramGiB, [bool]$Ddr5, [string]$Lang)
    if ($VramGiB -ge 5.5) { return @{ Name = 'GPU 6GB+';   Llm = $LlmModels.SmolLM3_Q8; Whisper = $WhisperModels.Large } }
    if ($VramGiB -ge 3.5) { return @{ Name = 'GPU 4-5GB';  Llm = $LlmModels.SmolLM3_Q4; Whisper = $WhisperModels.Large } }
    if ($VramGiB -ge 2.5) { return @{ Name = 'GPU 3GB';    Llm = $LlmModels.Qwen3_1_7B; Whisper = $WhisperModels.Small } }
    if ($VramGiB -ge 1.5 -and $Lang -eq 'en') {
                            return @{ Name = 'GPU 2GB (en)'; Llm = $LlmModels.Qwen35_08B; Whisper = $WhisperModels.Tiny } }
    if ($Ddr5)            { return @{ Name = 'CPU DDR5';   Llm = $LlmModels.SmolLM3_Q4; Whisper = $WhisperModels.Small } }
    return $null
}

# --------------------------------------------------------------------------
# File operations
# --------------------------------------------------------------------------

function New-DirIfMissing {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) { Say dirExists $Path } else { Say mkdir $Path; New-Item -ItemType Directory -Path $Path | Out-Null }
}

# Download with BITS: it shows progress, writes a temporary file and only
# creates the final one on completion (so "file exists" means "complete"), and
# a job left over from a closed window is resumed on the next run. Falls back
# to Invoke-WebRequest when BITS is unavailable; then any partial file is
# discarded and the download restarts.
function Invoke-Download {
    param([string]$Url, [string]$Dest)
    $name = Split-Path -Leaf $Dest
    if (Test-Path -LiteralPath $Dest) { Say skipDl $name; return }

    $jobName = "MeigFACE:$name"
    $job = $null
    try {
        Import-Module BitsTransfer -ErrorAction Stop
        $job = Get-BitsTransfer -Name $jobName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($job) {
            Say resume $name
            Resume-BitsTransfer -BitsJob $job -Asynchronous | Out-Null
        } else {
            Say download $name
            $job = Start-BitsTransfer -Source $Url -Destination $Dest -DisplayName $jobName -Asynchronous -Priority Foreground
        }
    } catch {
        # BITS module or service missing/disabled.
        $job = $null
    }

    if ($job) {
        $stalled = 0
        $failed = $false
        while ($true) {
            $job = Get-BitsTransfer -JobId $job.JobId
            $state = [string]$job.JobState
            if ($state -eq 'Transferred') {
                Complete-BitsTransfer -BitsJob $job
                Write-Progress -Activity $name -Completed
                return
            }
            if ($state -eq 'Error') {
                # Server not BITS-compatible (no Range support, odd redirect):
                # drop the job and use a plain download instead.
                Remove-BitsTransfer -BitsJob $job
                $failed = $true
                break
            }
            if ($state -eq 'TransientError') {
                # BITS retries by itself; give it ten minutes before giving up.
                $stalled++
                if ($stalled -gt 600) { Remove-BitsTransfer -BitsJob $job; $failed = $true; break }
            } else {
                $stalled = 0
            }
            if ($job.BytesTotal -gt 0) {
                $pct = [int](100 * $job.BytesTransferred / $job.BytesTotal)
                Write-Progress -Activity $name -Status ("{0}% ({1:N0} / {2:N0} MB)" -f $pct, ($job.BytesTransferred / 1MB), ($job.BytesTotal / 1MB)) -PercentComplete $pct
            }
            Start-Sleep -Seconds 1
        }
        Write-Progress -Activity $name -Completed
        if (-not $failed) { return }
    }

    Warn bitsFallback
    $part = "$Dest.part"
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    Say download $name
    Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing
    Move-Item -LiteralPath $part -Destination $Dest -Force
}

# Download a zip, extract it (overwriting) and delete the archive. The whole
# step is skipped when `$Marker` (a file expected inside the archive) already
# exists in `$Dest`: since the zip is removed on success, the extracted file is
# the only reliable sign that the step completed. The archive layout is never
# assumed: callers locate the executables afterwards with Find-File.
function Install-Zip {
    param([string]$Url, [string]$Dest, [string]$Marker)
    $name = Split-Path -Leaf $Url
    if (Find-File $Dest $Marker) { Say skipExtract $name; return }
    $zip = Join-Path $Dest $name
    Invoke-Download $Url $zip
    Say extract $name, $Dest
    Expand-Archive -LiteralPath $zip -DestinationPath $Dest -Force
    Say cleanup $name
    Remove-Item -LiteralPath $zip -Force
}

function Find-File {
    param([string]$Dir, [string]$Pattern)
    $hit = Get-ChildItem -LiteralPath $Dir -Recurse -File -Filter $Pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

function Get-RequiredFile {
    param([string]$Dir, [string]$Pattern)
    $path = Find-File $Dir $Pattern
    if (-not $path) { throw ($script:M.exeMissing -f $Pattern, $Dir) }
    return $path
}

# Merge the five paths into settings.json, keeping any other key. Written as
# UTF-8 without BOM: a BOM would break the app's JSON parser.
function Save-Settings {
    param([hashtable]$Values)
    if (-not (Test-Path -LiteralPath $SettingsDir)) { New-Item -ItemType Directory -Path $SettingsDir | Out-Null }
    $json = [pscustomobject]@{}
    if (Test-Path -LiteralPath $SettingsFile) {
        try { $json = Get-Content -LiteralPath $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    foreach ($k in $Values.Keys) {
        $json | Add-Member -NotePropertyName $k -NotePropertyValue $Values[$k] -Force
    }
    Say settings $SettingsFile
    $text = $json | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($SettingsFile, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
function Main {
    $lang = Get-UiLanguage
    if ($SupportedLanguages -notcontains $lang) {
        Write-Host "Language '$lang' is not supported by this installer (it, en, fr, de, es, pt)." -ForegroundColor Yellow
        Wait-Exit 1
    }
    $script:M = $Messages[$lang]

    Write-Host ('=' * 60)
    Write-Host $script:M.title
    Write-Host ('=' * 60)

    if (Test-ManualSetup) { Warn alreadySet; Wait-Exit 0 }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'MeigFACE.exe'))) { Warn appMissing $VoicesRoot }

    # ---- hardware ----
    Say detecting
    $gpu = Get-NvidiaInfo
    $vramGiB = 0.0
    if ($gpu) {
        $vramGiB = $gpu.VramMiB / 1024
        Say gpuFound $gpu.Name, $vramGiB, $gpu.Driver
        if ($gpu.Driver -and ([double](($gpu.Driver -split '\.')[0]) -lt $MinDriverMajor)) { Warn driverOld $gpu.Driver, $MinDriverMajor }
    } else {
        Say gpuNone
    }
    $ram = Get-RamType
    Say ramType $ram

    $profile = Select-Profile -VramGiB $vramGiB -Ddr5 ($ram -ne 'other') -Lang $lang
    if (-not $profile) { Warn notEligible; Wait-Exit 1 }
    Say profile $profile.Name, $profile.Llm.File, $profile.Whisper.File
    Write-Host ''

    # ---- folders ----
    foreach ($d in @($Root, $LlamaDir, $GgufDir, $WhisperDir, $WhisperBin, $PiperDir)) { New-DirIfMissing $d }
    Write-Host ''

    # ---- llama-server + CUDA runtime (same order as the app's setup screen) ----
    Install-Zip $Urls.LlamaZip  $LlamaDir 'llama-server.exe'
    Install-Zip $Urls.CudartZip $LlamaDir 'cudart64_*.dll'
    $serverExe = Get-RequiredFile $LlamaDir 'llama-server.exe'

    # ---- conversation model ----
    $modelPath = Join-Path $GgufDir $profile.Llm.File
    Invoke-Download $profile.Llm.Url $modelPath

    # ---- whisper-server ----
    Install-Zip $Urls.WhisperZip $WhisperDir 'whisper-server.exe'
    $whisperExe = Get-RequiredFile $WhisperDir 'whisper-server.exe'

    # ---- whisper model ----
    $whisperModel = Join-Path $WhisperBin $profile.Whisper.File
    Invoke-Download $profile.Whisper.Url $whisperModel

    # ---- piper ----
    Install-Zip $Urls.PiperZip $PiperDir 'piper.exe'
    $piperExe = Get-RequiredFile $PiperDir 'piper.exe'

    # ---- voice: placed only in voices\<lang>\<gender>\ of its own gender, the
    # folder the app searches for the matching avatar. The gender value is
    # validated so that a wrong edit of $Voices fails here, not in the app. ----
    $v = $Voices[$lang]
    if ($v.Gender -ne 'male' -and $v.Gender -ne 'female') { throw "invalid voice gender for '$lang': $($v.Gender)" }
    $voiceDir = Join-Path $VoicesRoot (Join-Path $lang $v.Gender)
    if (-not (Test-Path -LiteralPath $voiceDir)) { New-Item -ItemType Directory -Path $voiceDir | Out-Null }
    Say voice $v.File, $lang, $voiceDir
    Invoke-Download ($v.Base + '.onnx?download=true') (Join-Path $voiceDir ($v.File + '.onnx'))
    Invoke-Download ($v.Base + '.onnx.json')          (Join-Path $voiceDir ($v.File + '.onnx.json'))
    Write-Host ''

    # ---- settings ----
    Save-Settings @{
        'llm.serverPath'       = $serverExe
        'llm.modelPath'        = $modelPath
        'llm.whisperPath'      = $whisperExe
        'llm.whisperModelPath' = $whisperModel
        'llm.piperPath'        = $piperExe
    }

    Write-Host ''
    Write-Host $script:M.done -ForegroundColor Green
    Wait-Exit 0
}

try {
    Main
} catch {
    Write-Host ''
    if ($script:M) { Write-Host ($script:M.failed -f $_.Exception.Message) -ForegroundColor Red }
    else { Write-Host "Setup stopped: $($_.Exception.Message)" -ForegroundColor Red }
    Wait-Exit 1
}
