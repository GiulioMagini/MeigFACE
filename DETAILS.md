# MeigFACE - Detailed guide

This document explains how to install MeigFACE's runtime components and how the application works, step by step. The README gives the overview; this file is the one to open when something needs to be installed, changed or understood in depth.

MeigFACE is an eye-contact training tool. You talk to a 2D avatar, the avatar answers, and the application measures how much of the time you actually looked it in the eyes. Everything runs on your own machine: the language model, the speech recognition and the speech synthesis are three local programs that MeigFACE starts and stops for you. After the initial download, no data ever leaves your computer and no internet connection is required.

---

## 1. What you need

### Hardware

| Component | Requirement |
| --- | --- |
| Webcam | Any webcam with 1280x720 or superior quality. Quality affects gaze accuracy, i cannot assure if below this threshold it works or not. |
| Microphone | Any microphone, including the one built into a laptop or a webcam. |
| GPU or RAM | See the table below. This is the part that decides whether MeigFACE is usable. |

MeigFACE runs three engines at the same time: the language model that writes the replies, Whisper for transcribing what you say, and Piper for speaking the answer out loud. The language model and Whisper are the two that consume video memory, and they stay loaded for the whole session.

These are the hardware tiers the automatic installer uses. The first matching row wins, and dedicated VRAM always takes priority over the type of system RAM:

| Condition | Conversation model | Whisper model |
| --- | --- | --- |
| 6 GB of VRAM or more | SmolLM3-3B Q8_0 | large-v3-turbo-q8_0 |
| 4 to 5 GB of VRAM | SmolLM3-3B Q4_K_M | large-v3-turbo-q8_0 |
| 3 GB of VRAM | Qwen3-1.7B Q4_K_M | small |
| 2 GB of VRAM, English only | Qwen3.5-0.8B Q4_K_M | tiny |
| DDR5/LPDDR5 RAM, none of the above | SmolLM3-3B Q4_K_M | small, on the CPU |
| anything else | not enough for a useful session | |

IMPORTANT: all llm models are used with "thinking" disabled, it is needed to have decent latency (with thinking enabled LLM models respond 7-10 seconds later).
LLM models are way less smart without it, but it is sufficient to have normal conversations.
The 2 GB tier is restricted to English on purpose and is usable for a very short period of time (1 minute max, then allucinates). 
Qwen3.5-0.8B can hold a very simple and stupid conversation in English (it does not remember any instruction), but not in the other five languages.

### Measured memory use

These figures were read from Task Manager (GPU, dedicated memory) while actually talking to the avatar, so they include the desktop compositor and the application's own webview. They are real numbers, not estimates:

| Combination | Dedicated VRAM |
| --- | --- |
| SmolLM3-3B Q8_0 + whisper small | 4.6 GB |
| SmolLM3-3B Q8_0 + whisper large-v3-turbo-q8_0 | 4.9 GB |
| SmolLM3-3B Q4_K_M + whisper small | 3.3 GB |
| SmolLM3-3B Q4_K_M + whisper large-v3-turbo-q8_0 | 3.7 GB |
| Qwen3-1.7B Q4_K_M + whisper small | 2.7 GB |
| Qwen3-1.7B Q4_K_M + whisper tiny | 2.2 GB |
| Qwen3.5-0.8B Q4_K_M + whisper small | 1.8 GB |
| Qwen3.5-0.8B Q4_K_M + whisper tiny | 1.4 GB |

One caveat worth stating plainly: these were measured on a card larger than the tier limits. On a card that is exactly 3 GB or 4 GB the headroom is around 300 MB, and drivers do not always behave the same way that close to the ceiling.

### Operating systems

| System | Status |
| --- | --- |
| Windows 10/11 | Primary development platform. The automatic installer is Windows-only. |
| Linux | Supported and verified on Debian 13 with WebKitGTK. Manual setup. |
| macOS | Never tested on real hardware. Not covered by this guide. |

### Languages

Six languages are built into the application: Italian, English, French, German, Spanish and Portuguese. They are the six that SmolLM3, the default model, speaks well. Any other language can be added by hand; section 3 explains how.

---

## 2. Automatic setup (Windows)

`MeigFACE-setup.ps1` downloads every runtime component, puts it where the application expects it, and writes the resulting paths into the application's settings. It requires PowerShell 5.1 or newer, which every supported version of Windows already has.

**The script must sit in the same folder as `MeigFACE.exe`.** It installs the Piper voice into the application's own `voices` folder, which it finds relative to its own location. If the executable is not there the script still runs, but it warns you and you will have to move the `voices` folder yourself afterwards.

### Running it

Windows marks every file downloaded from the internet as blocked, and refuses to run blocked scripts. Open a terminal in the application folder and clear that mark first:

```powershell
Unblock-File .\MeigFACE-setup.ps1
```

Then either right-click the file and choose *Run with PowerShell*, or stay in the terminal:

```powershell
powershell -ExecutionPolicy Bypass -File .\MeigFACE-setup.ps1
```

`-ExecutionPolicy Bypass` applies to that single invocation only. It does not change any system setting and it does not persist. It is needed because the default policy on a home installation of Windows refuses to run local scripts at all.

### What it does, in order

1. **Reads the Windows display language.** Specifically the display language, not the regional format, because those two can differ and the first is what the application's interface follows. If it is not one of the six supported languages, the script says so and exits without downloading anything.
2. **Checks whether a manual setup was already started.** If the settings file    already contains at least one of the five executable or model paths, the script stops and changes nothing. This protects a configuration you built by hand from being silently replaced.
3. **Detects the hardware.** It asks `nvidia-smi` for the GPU name, dedicated VRAM and driver version, and falls back to the registry if that tool is not    installed. It then checks whether the system RAM is DDR5 or LPDDR5, and picks a tier from the table in section 1. Thresholds carry a 0.5 GB tolerance,    because cards report slightly less than their nominal size: a card sold as 4 GB typically reports 4095 MiB, and some laptop parts report 3.9 GB.
4. **Warns about old drivers.** Below NVIDIA driver 580 you get a warning, never a hard stop: 580 is NVIDIA's published floor for CUDA 13.0, the builds used here are CUDA 13.3, and the exact requirement is not published. If the model later refuses to start, the driver is the first thing to update.
5. **Downloads and extracts everything**, in the same order the application's own setup screen lists it.
6. **Installs one Piper voice** for the detected language.
7. **Writes the five paths** into the settings file.

### Where the files end up

```
%USERPROFILE%\Downloads\MeigFACE\
  llama.cpp\                 llama-server.exe + the CUDA runtime DLLs
  gguf\                      the conversation model
  whisper\whisper-server\    whisper-server.exe + its CUDA DLLs
  whisper\bin\               the Whisper ggml model
  piper\                     piper.exe

<application folder>\
  voices\<language>\<gender>\    the downloaded voice (.onnx + .onnx.json)
```

The voice goes into the folder of its own gender, because that is the folder the application searches once you pick a male or female avatar.

The Portuguese voice is renamed to an ASCII file name on disk, `tugao` rather than `tugão`. Piper receives the path as a command-line argument, and a non-ASCII character there depends on the console code page; the ASCII name removes that variable entirely.

### What it writes

Five keys in `%APPDATA%\com.giuliomagini.meigface\settings.json`:

| Key | What it points to |
| --- | --- |
| `llm.serverPath` | `llama-server.exe` |
| `llm.modelPath` | the GGUF conversation model |
| `llm.whisperPath` | `whisper-server.exe` |
| `llm.whisperModelPath` | the Whisper `.bin` model |
| `llm.piperPath` | `piper.exe` |

Any other key already in that file is preserved. The file is written as UTF-8 without a byte order mark, because a BOM would break the application's JSON parser.

### If it is interrupted

Every step is skipped when its result already exists, so you can simply run the script again after closing the window, losing the connection or rebooting. Downloads are resumed rather than restarted where the background transfer service is available; if that service is disabled, the script says so and falls back to a plain download, which has to start over if it fails. Archives are deleted once extracted, so a partially extracted archive is never mistaken for a finished one.

### When not to use it

- **You do not have an NVIDIA card.** The builds it downloads are CUDA builds. They are expected to fall back to the CPU when no NVIDIA device is present,   which is what makes the DDR5 tier work, but that fallback has not been verified on these exact builds. If you have an AMD or Intel GPU, use the manual setup and pick the Vulkan builds, or ask a LLM to change the script for your case.
- **Your system language is not one of the six.** See section 3.
- **You want to choose your own models.** The script makes one reasonable choice per tier. The manual setup gives you the whole catalogue.

---

## 3. Adding a language the installer (and the original program) does not cover

Say your system is in Swedish. MeigFACE has no Swedish built in, and the installer will refuse to run. Adding it is entirely possible, but it takes **three separate things**, and having only some of them gives you a half-working application rather than a broken one, which is more confusing:

| What | Without it |
| --- | --- |
| A translated interface (custom locale) | The interface falls back to English. |
| A Piper voice for the language | The avatar cannot speak. The system check fails at the TTS step. |
| A language model that speaks the language | The avatar answers in the wrong language, or in broken Swedish. |

All the passage below are fit to match the Swedish language, but you can apply it for all languages.

### 3.1 Translating the interface

The application reads extra languages from an `i18n` folder that sits next to its `voices` folder. The first time it starts it writes a reference dictionary there, called `en - for translation.json`. That file is a template, never loaded as a language.

Copy it, name the copy after the language code (for our example: `sv.json`), and translate the values while leaving every key exactly as it is; otherwise you can use a LLM to do it and provide you the translation file. Save the new file in the same i18n folder. The application validates the structure against English and refuses a file with missing or extra keys, so a partial translation will not load. On the next start the language appears in the switcher, and if your browser or system language matches it, it is selected automatically.

Do not name the file after one of the six built-in languages. A file called `fr.json` in that folder replaces the built-in French dictionary instead of adding a language.

### 3.2 Choosing a Piper voice

Voices live at `huggingface.co/rhasspy/piper-voices`, one folder per language. For our example, Swedish, you want the `sv` tree. 
Alternatively you can go to `https://rhasspy.github.io/piper-samples/`, select your language (for our example, Swedish), and when you find a voice that you appreciate click on "download".

- **Prefer a `medium` voice.** The `x_low` and `low` voices sound noticeably synthetic, with very poor quality, and `high` ones cost more memory and time for a gain you will not hear through the avatar.
- **Listen to the samples** in the voice's `samples` folder before committing. Quality varies enormously for the same quality type between languages, and this is the one thing no documentation can tell you.
- **Read the `MODEL_CARD` file.** Every voice has one, and it names the dataset and its licence. Some Piper voices are public domain, some require attribution and some are restricted to non-commercial research use. Piper itself adds no   restrictions, so the voice's own licence is the only one that applies. They are all ok for personal use, but if you want to customize the program in order to sell it you have to be careful about this aspect. CC0 licenses are preferred, since it is the type of license that offers the most freedom. 

You need two files: `<voice>.onnx` and `<voice>.onnx.json`. For our example case put both in `voices/sv/male/` or `voices/sv/female/` (sv is swedish language), matching the voice's actual gender, and create the folders if they are missing.

For our Swedish example you can use [this male voice](https://huggingface.co/rhasspy/piper-voices/tree/main/sv/sv_SE/nst/medium).

### 3.3 Choosing a language model

The constraint is not size, it is coverage. A 3B model that was never trained on Swedish will produce confident nonsense. Check the model card for the list of languages it claims to support, and prefer models that name your language explicitly rather than saying "multilingual".

IMPORTANT: **IF YOU FIND A LLM MODEL WHO ENDS WITH "BASE", IT WILL NOT WORK. USE "INSTRUCT" MODELS ONLY. IF YOU DON'T KNOW THE DIFFERENCE, OR YOU CAN'T FIND A SUITABLE MODEL FOR YOU, ASK A LLM TO HELP YOU.**

Then match the quantisation to the VRAM budget in section 1, and test it before wiring it into the application: section 4 shows how to run `llama-server` by hand and talk to it.

For our Swedish example you can use [this LLM](https://huggingface.co/mradermacher/EuroLLM-1.7B-Instruct-GGUF). It isn't specific to Swedish, but it is compatible and fairly lightweight.

### 3.4 Editing the installer

If you would rather adapt the script than install everything by hand, four places need changing:

1. **`$SupportedLanguages`** - add the two-letter code.
2. **`$Messages`** - add a block for the language with *every* key present. The script uses the block wholesale and a missing key throws at the point it is used, halfway through a download. Note that these are PowerShell single-quoted strings, so an apostrophe inside the text must be doubled.
3. **`$Voices`** - add a row with the gender, the on-disk base name and the base URL. Keep the file name ASCII and URL-encode any non-ASCII character in the URL, which is exactly what the Portuguese row does.
4. **`Select-Profile`** - each tier names a specific model. Replace them with models that speak your language, keeping the memory budget in mind.

Alternatively you can ask a LLM to do all this changes for you, for example you can put this command:

```bash
Change this script to work with my language, Swedish. 
Select nst as Swedish male piper voice and gpt-sw3-1.3b-gguf as choosen LLM.
# Otherwise: choose the best medium Piper swedish voice and the best Swedish LLM for this usage.
```

---

## 4. Manual setup

Manual setup is the right choice when you have an AMD or Intel GPU, when you are on Linux, when your language is not one of the six, or simply when you want to pick your own models. It is the same five components, downloaded by hand.

The application never asks you to edit the settings file: once each component is on disk, you point the application at it through the setup screen, and it stores the paths itself.

### 4.1 The conversation engine (llama.cpp)

MeigFACE talks to `llama-server`, the HTTP server that ships with llama.cpp. It does not bundle it, so you download a build that matches your GPU:

| Hardware | Build |
| --- | --- |
| NVIDIA | the CUDA build, plus the separate CUDA runtime archive |
| AMD, Intel, or mixed | the Vulkan build |
| CPU only | the plain CPU build |

On Windows the CUDA build needs its runtime DLLs, distributed as a second archive from the same release. Extract both into the same folder.

On Linux, a prebuilt Vulkan archive works without compiling anything. The build used for testing was `llama-b9862-bin-ubuntu-vulkan-x64.tar.gz`, chosen because the test machine has an AMD card. Extract it and use the `llama-server` binary.

### 4.2 The conversation model (GGUF)

Pick an **instruction-tuned** model, not a base one. Base models continue text rather than answering, which produces a conversation partner that repeats your sentence back at you in longer form.

Beyond that, three criteria:

- **Languages.** As in section 3.3: the model card must name your language.
- **Size against VRAM.** Use the table in section 1 as the budget. The model and Whisper share the same card.
- **Quantisation.** Q4_K_M is the usual sweet spot and Q8_0 is noticeably better if it fits. Below Q4 the quality drop becomes audible in the replies.

You can test it before touching the application with this command:

```
llama-server -m /path/to/model.gguf --host 127.0.0.1 --port 8080 -ngl 999
```

`-ngl` is the number of layers pushed onto the GPU; 999 simply means "all of them". If the server starts and prints its listening address, the model and the build agree with each other. MeigFACE uses port 8080 for the language model and 8081 for Whisper, and those two ports are fixed.

### 4.3 Speech recognition (whisper.cpp)

Two pieces: the `whisper-server` executable and a `ggml-*.bin` model. **The model file is identical on every platform**; only the executable changes.

On Windows, download the prebuilt server archive matching your GPU. On Linux, the Vulkan build is not published prebuilt, so it has to be compiled. On Debian 13 the following is enough:

```bash
sudo apt install git cmake build-essential \
                 vulkan-tools libvulkan-dev \
                 curl wget \
                 glslc spirv-headers

git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp

# GGML_VULKAN=1 is required explicitly: without it, cmake produces a
# CPU-only build even with the Vulkan system libraries installed.
cmake -B build -DGGML_VULKAN=1
cmake --build build -j
```

That comment is not a detail. Leaving the flag out gives you a working binary that silently runs on the CPU, which looks like a very slow GPU rather than a misconfiguration.

**Which model to pick.** The reasoning behind the defaults, so you can depart from it knowingly:

- `medium` (fp16) is both less accurate than `large-v3-turbo` and heavier. There is no configuration in which it is the right answer, so it is not used at all.
- Among the large models, only the turbo variant is fast enough for a conversation: it has 4 decoder layers instead of 32, which puts its speed in the same range as `small`.
- `large-v3-turbo-q8_0` keeps almost all of the accuracy of the fp16 version while saving around 800 MB of VRAM. Going down to q5 saves only about 300 MB more and starts costing accuracy.
- `tiny` and `small` are used unquantised. They are already the weakest models and the saving would be negligible, especially for non-english languages.

You can test it before launching the application with this command:

```
whisper-server --model /path/to/ggml-small.bin --host 127.0.0.1 --port 8081
```

### 4.4 Speech synthesis (Piper)

Piper is a single executable plus one voice. The Windows and Linux builds are published as `piper_windows_amd64.zip` and `piper_linux_x86_64.tar.gz`; extract either and keep the whole folder, because the executable needs the libraries next to it.

The build in use is `2023.11.14-2`, the last one with native desktop binaries. Later Piper releases are distributed through Python packaging instead. All the timing and memory figures in this document were taken with that build.

Voices go in `voices/<language>/<gender>/`, as described in section 3.2. You can install as many as you like per folder; the application lists all of them and lets you choose.

You never launch Piper yourself. Running `piper --help` once is a useful check that the binary and its libraries are intact, and nothing more.

### 4.5 Pointing the application at everything

Open MeigFACE and use the setup screen. It asks for five paths, in this order: the `llama-server` executable, the GGUF model, the `whisper-server` executable, the Whisper `.bin` model, and the Piper executable. Each one opens a native file dialog, and each choice is saved as you make it.

Two numeric settings sit alongside them:

**GPU layers** is how much of the language model lives on the GPU. The application suggests a value once you have chosen the executable and the model, by inspecting the model and the available memory. Accept the suggestion (999 is the default value for LLM entirely inside the GPU) unless you have a specific reason not to; lowering it moves work to the CPU and makes replies slower, raising it past what fits makes the model fail to start.

**Whisper GPU index** is the one people get wrong first. On a machine with more than one GPU visible to Vulkan or CUDA, which is every laptop with an integrated chip alongside a discrete card, `whisper-server` in Linux (the compiled one, see section 4.3) does not reliably pick the right one. There is no auto-detection for this: the index has to come from the engine's own device list, which `whisper-server --help` prints. Leave it empty to use the engine's default, and set it only if transcription turns out to be absurdly slow. The index is applied everywhere the engine is started, including the system check and the live session.

---

## 5. First launch

### Camera and microphone permissions

MeigFACE asks for the camera and the microphone as soon as it opens, before you have done anything. That is deliberate. Later on there is a timed check that waits twelve seconds for you to speak; if the operating system prompt appeared in the middle of it, the time spent reading and clicking *Allow* would eat the whole window and the check would fail for the wrong reason.

If you skip this decision (close the permission window), the application shows a banner with the path to re-enable them. If you refuse to use it (deny the usage), the program will not work.

For Windows: if you denied the usage and you want to reset it, you can go to `%LOCALAPPDATA%\com.giuliomagini.meigface\` and eliminate `EBWebView` folder, then restart the app. You will see again the banners.

For Linux: the permissions are already enabled by default, this part is skipped.

### Choosing the input devices

Right on the home screen, before you pick any executable, there are two dropdowns for the microphone and the camera. *System default* is fine for most people, and the lists only show device names after permission has been granted, which is why they appear where they do.

Picking them this early is important. The wrong camera reveals itself immediately, as soon as the tracking preview shows the wrong room. The wrong microphone, on the other hand, stays invisible until the speech step of the system check times out, at which point it looks like a broken Whisper install. Setting both now removes that confusion. Whatever you choose here is used everywhere afterwards: the system check, the calibration, the bias correction and the live session.

### Interface language

The language switcher is on the same screen (up - right). On first start MeigFACE picks the language of your browser environment if it matches one of the available ones, and falls back to English otherwise. Custom languages installed as described in section 3.1 appear here alongside the built-in six. The chosen language is not only the interface. It is the language of the conversation, of the default system prompt, of the voices the application looks for, and of the dates written into your session history.

### The system check

Before you are allowed to calibrate, MeigFACE exercises all three engines end to end. It uses the same backend commands and the same audio code as a real session, so passing it means the actual pipeline is wired correctly.

| Step | What happens | What a failure means |
| --- | --- | --- |
| Language model | Starts `llama-server`, asks a trivial question (e.g., "Say Hi"), requires a non-empty reply, stops it. | The executable, the model or the GPU-layers value is wrong. A model that is too large for the card fails here. |
| Speech recognition | Starts `whisper-server` and asks you to say one word, with twelve seconds to do it. | Either the wrong microphone is selected, or the word was not spoken loudly enough, or the Whisper executable and model do not match. |
| Speech synthesis | Synthesises one word with the first available voice for the current language and plays it back. | No voice is installed for this language, or it is filed in the wrong folder. Female is tried first, then male; the check accepts either. |

The result is remembered along with **the language it passed for**. Since the third step is language-specific, switching to a language you have never checked invalidates the result and the check runs again. This is not pedantry: it is the one moment where a missing voice is caught before it ruins a session.

---

## 6. Gaze calibration

### Why it exists

MediaPipe tells the application where your irises are inside the video frame. Turning that into "this person is looking at the avatar's eyes" requires knowing how your eyes, your face and your seating position map onto your screen, and that is different for everyone. Calibration measures it by asking you to look at targets whose position is known.

### The two blocks

Calibration is not a single grid of dots. It runs two different blocks, and the second one is the reason accuracy is good where it matters:

1. **Four screen corners**, repeated for several cycles. These pin down the overall mapping across the whole screen.
2. **Four anchor points placed exactly on the avatar's eye band**, also repeated. This is the only region of the screen where eye-contact scoring actually happens, so it gets its own reinforcement. During this block a stylised outline of the avatar appears, drawn from the same geometry that generates the targets, so the outline and the dots can never disagree.

### Light or heavy

| Mode | Cycles | Points | 
| --- | --- | --- | 
| Light (recommended) | 3 | 24 |
| Heavy | 4 | 32 |

Light is the right default. Heavy exists for low-quality webcams, where more samples per point compensate for a noisier signal. If the test screen below looks good with light, there is nothing to gain from heavy.

Each point gives you 600 milliseconds to move your eyes, which is discarded, and then collects samples for 1.5 seconds.

### How to sit

- **Light on your face, not behind you.** A window at your back turns your face into a silhouette and the iris detection degrades badly.
- **Put your pc at the same level as your head,** the camera should be higher than your head. This will reduce up and down precision, but the left and right signal (which is the most important) will be way more stable.
- **Keep your head still, move your eyes.** The whole point is to associate iris positions with screen positions. Turning your head to face each target teaches the model nothing.
- **Stay at the distance you will actually use.** Calibrating leaning forward and then sitting back invalidates the mapping.
- **Glasses are fine**, reflections are not. If a lamp is mirrored in your lenses, move it.
- **You can have more than two faces in the screen (e.g., child and parent) when doing both tracking and sessions**, assuming the second face is in the background and the face of the person  who is doing the tracking is in the foreground. Mediapipe recognizes only one face at a time, and it is the foreground face.

### Checking the result

The test screen mounts the webcam, applies the fitted model to every frame and draws a small black dot wherever it thinks you are looking. A light smoothing filter removes tremor without hiding systematic drift, so what you see is honest.

Look around the screen and watch the dot. It will never be perfect, and it does not need to be: what matters is that when you look at the avatar's eyes, the dot lands on the avatar's eyes. If the dot is consistently offset in one direction, or barely moves, recalibrate. Trying heavy mode is the next thing to try after that, alternatively use bias correction before doing a session (see below).

### How long it lasts

The fitted model is saved and survives navigation and restarts, so you calibrate once and start sessions from then on. Recalibrate when you change your physical setup: a different person using the program, a different chair or desk height, a different monitor, a different webcam, or a lighting change big enough to notice.

### Bias correction before a session

When a calibration exists, the session offers an optional refinement before any engine starts. It repeats the four eye-anchor points twice, this time directly on the avatar's own face, with the avatar held perfectly still so its eyes sit under the target dots. From those eight measurements it fits a single translational offset onto your existing model.

It takes about twenty seconds and it corrects exactly the error that costs you points: a systematic shift in the region you are being scored on. Accept it when you have sat down differently from when you calibrated, or when the test screen showed a small constant offset that you did not want to recalibrate over. Skip it when you have just calibrated and the dot was already landing where it should.

---

## 7. Session settings and profiles

### Avatar

Male or female. The choice is not only cosmetic: **the avatar's gender selects which voice folder the application reads.** Choosing the female avatar makes MeigFACE list the voices in `voices/<language>/female/` and nothing else. If the voice list is empty, that is almost always the reason, and the fix is either switching avatar or moving the voice file into the matching folder.

### Appearance and speech

| Setting | Range | What it changes |
| --- | --- | --- |
| Head movement | 0 to 2 | How much the avatar sways while it talks. 0 holds it still. |
| Mouth sensitivity | 0.4 to 4 | How strongly the mouth reacts to the audio. Raise it for a quiet voice, lower it if the mouth flaps constantly. |
| Voice speed | 0.7 to 1.4 | Piper's speaking rate. |

A preview of the avatar sits next to them, and a test button speaks a sample sentence with the current voice and speed, so you can hear a change instead of guessing at it. 
### Pause before replying, and maximum listening time

These two matter more than everything above put together, because they decide whether the conversation feels natural or fights you.

**Pause before replying** (0.5 to 5 seconds) is how much silence has to pass before the avatar decides you are done and starts answering. Set it low and the avatar interrupts you every time you stop to think. Set it high and every exchange gains a noticeable delay. The right value depends on how *you* speak, not on some ideal number: if you think mid-sentence and pause often, raise it; if you speak in clean complete sentences, lower it.

**Maximum listening time** (10 to 180 seconds) is the hard ceiling on a single turn. When it expires, whatever you have said so far is sent regardless of whether you stopped talking. It exists so that someone who talks at length without clear pauses still gets an answer instead of being listened to forever. Raise it if you tell long stories.

### Parameter profiles

A profile saves those two values under a name. The name is the point: **it identifies you**, and it is the key the session history is filed under. Two people sharing a computer keep separate histories by using separate profiles.

The profile also feeds a feature that is easy to miss. At the start of a session, MeigFACE looks at the last two sessions saved under the active profile, asks the language model to pull the recurring topics out of their summaries, and appends those topics to the system prompt. The avatar therefore remembers, in a loose sense, what you have talked about before. Only two sessions are used, because a longer block of context does not fit comfortably in a 3B-class model (or below). Without a profile selected, this does not happen and every session starts from nothing.

### The system prompt

The prompt is the instructions the model receives before you say anything, and MeigFACE ships a sensible default for each language. You can edit it freely. The default ends with an *Other details:* marker, which is where your own context belongs: who you are, what you want to practise, what the avatar should be to you.

**Positive thinking mode** replaces the prompt with a different exercise: instead of a conversation, you read a list of affirmations aloud while maintaining eye contact. Rules are explained directly in the app.

Prompts can be saved by name and reloaded later, the same way parameter profiles work, so you can keep a conversational prompt and several affirmation lists side by side.

### A note on responsibility

You choose the model and you write the prompt. The developer is not responsible for what the model generates, including inappropriate or harmful content, and that includes content directed at children or at any other person. Running an uncensored model, or writing a prompt that steers one, is entirely your decision and your responsibility.

---

## 8. The session

### The phases

1. **Length.** A dropdown offers one to four minutes.
2. **Bias correction.** Offered if a calibration exists, as described in section 6. Engines have not started yet, so declining costs nothing.
3. **Engines starting.** The language model and Whisper come up. This is the slowest part of the whole application, because the model is being read from disk into video memory.
4. **Conversation.** The countdown, the live score and the avatar.
5. **Results.**

### How the conversation works

The loop is strictly turn-based: listen, transcribe, generate, speak, listen again. While the avatar is speaking it is not listening, and listening resumes only when it has finished. This avoids the avatar transcribing its own voice, and it means you should wait for it to finish rather than talking over it.

Audio is captured in the interface and sent straight to Whisper. The reply and its audio go through the backend. A transcription that hangs, caused by a Whisper error, is abandoned after thirty seconds and surfaces as a recoverable error for that turn, rather than freezing the session.

### What is measured

| Metric | Meaning |
| --- | --- |
| Contact | Percentage of the session spent looking at the avatar's eyes. |
| Longest streak | The longest unbroken stretch of eye contact. |
| Breaks | How many times you looked away. |
| Trend | Whether the last fifteen seconds are better or worse than the session as a whole. |

The trend arrow only moves when the difference exceeds eight percentage points, so it shows a real change of behaviour rather than noise.

### How eye contact is decided

Your predicted gaze point is compared against an oval covering the avatar's eyes. Rather than flipping the moment the point crosses the edge, the application keeps a smoothed running value and switches state at two different thresholds: it takes a fairly convinced reading to turn contact on, and an equally convinced one to turn it off. That is what stops the halo from flickering when your gaze sits exactly on the boundary.

On top of that, looking away is treated asymmetrically. Coming back into the oval counts instantly, but leaving it only counts as a break if you stay out continuously for 400 milliseconds. A blink lasts roughly 300 to 400 milliseconds, so **blinking does not cost you points**, and neither does a momentary tracker wobble.

### The closing line

When the time runs out, the avatar does not stop mid-conversation. It finishes what it is saying and then delivers a scripted farewell. **Scoring is frozen the instant that farewell begins**: the closing line is not part of the exercise, so looking away while it plays neither helps nor hurts.

### Results

The results screen shows the four metrics plus the session duration, and next to them your historical average and the total number of sessions recorded under the active profile (if it is active). 

Afterwards, MeigFACE asks the language model for a topics-only summary of the transcript and stores it on the session record. The metrics are saved first and immediately, so they survive even if the summary generation fails or the model has already been shut down.

---

## 9. History and your data

### The session history

The history screen lists your sessions as cards, filtered by the active profile. Each card carries the date written in the language that session was held in, a language tag, the metrics, and the topic summary. You can find it in the Settings page, at the bottom, when you have selected a specific profile.

Two actions sit on every card:

- **Edit** opens the summary for inline editing. Useful when the model produced something vague, or when you want to write your own note instead.
- **Delete** removes that single session, after a confirmation.

At the bottom of the popup there is a selectable bulk prune that removes the five or ten oldest sessions,  or all of them, always behind a confirmation. Every deletion reloads the list and refreshes the averages shown elsewhere, because removing a session changes them.

### Where the data lives

Sessions, profiles and saved prompts are stored in an SQLite database called `meigface.db`, inside the application's data folder. On Windows that is `%APPDATA%\com.giuliomagini.meigface\`, alongside the `settings.json` that holds your paths and preferences. Deleting a profile deletes its sessions with it.

Back it up by copying the file. There is no export function.

### Privacy

Everything is local, and that is not a policy statement but a description of the architecture. The language model, Whisper and Piper are three programs running on your machine, reached over localhost. Your webcam feed is processed in the application and never written to disk. Your audio goes to a local port and nowhere else. No account, no telemetry, no server.

The only moment MeigFACE touches the network is when you download the components described in sections 2 and 4. After that you can unplug the network cable and nothing changes.
