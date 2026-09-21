#!/usr/bin/env python3
"""
Stage 2: Piper TTS Dataset Preprocessor

Prepares a voice dataset for Piper TTS fine-tuning. Apply this script to the files modified from stage 1 (ps1 script).

Pipeline applied to every clip:
  denoise -> disguise (optional) -> normalize -> trim -> pad

  denoise    light stationary noise reduction, kept conservative so that
             fricatives (s, f, sc) survive intact
  disguise   optional formant and pitch shift to mask the speaker identity
  normalize  EBU R128 loudness normalization to a fixed LUFS target
  trim       leading and trailing silence removal, on already normalized
             material so the absolute threshold behaves consistently
  pad        a fixed silence frame at both ends, which VITS needs to learn
             clean onsets and decays

For datasets larger than --max-hours, clips are also pre-selected by RMS
volume before processing.

Usage:
  python piper_preprocess.py <voice_folder> [--max-hours 5.0] [--disguise low|high]

Arguments:
  voice_folder   Path to the voice folder (must contain wavs/ and metadata.csv)
  --max-hours    Max hours to keep (default: 5.0). Only applies if the dataset
                 exceeds this. Pass 99 to keep everything, which is what you
                 want for a dataset you recorded yourself.
  --disguise     Mask the speaker identity by shifting formants and pitch.
                 'low' gives a deeper, fuller, flatter voice; 'high' a
                 brighter, lighter, more animated one. Omit to keep the
                 original voice. Tune DISGUISE_PROFILES by ear on a handful
                 of clips before processing a whole dataset.

Output:
  <voice_folder>/updated/wavs/        Processed WAV files
  <voice_folder>/updated/metadata.csv Updated metadata referencing new files

Input format:
  WAV mono 22050Hz 16-bit, one file per line in metadata.csv (LJSpeech):
    wavs/000000.wav|Sentence text

Requires:
  numpy, soundfile, noisereduce, pyloudnorm, praat-parselmouth
  (pip install ...)

Examples:
  # Own voice, keep every clip
  python piper_preprocess.py ./voices --max-hours 99

  # Same recordings, published character voice
  python piper_preprocess.py ./voices --max-hours 99 --disguise low

  After this script, put all files created (wavs and metadata) into a 7z file, then apply the runpod guide (stage 3).
"""

import os
import sys
import argparse
import shutil
import numpy as np
import soundfile as sf
import noisereduce as nr
import pyloudnorm as pyln
from pathlib import Path
import parselmouth
from parselmouth.praat import call as praat_call


# ── Audio processing constants ────────────────────────────────────────────────

# Target integrated loudness in LUFS (EBU R128 standard for speech)
TARGET_LUFS = -20.0

# Maximum true-peak in dBTP to avoid clipping after normalization
MAX_TRUE_PEAK_DBTP = -1.0

# Noise reduction strength (0.0 = none, 1.0 = aggressive)
# Keep low to avoid artifacts on clean recordings
NOISE_REDUCTION_PROP = 0.30

# Silence threshold in dBFS: samples below this are considered silence
SILENCE_THRESHOLD_DBFS = -50.0

# Minimum silence duration in seconds to trim at boundaries
MIN_SILENCE_DURATION_S = 0.05

# Minimum clip duration in seconds: shorter clips are discarded
MIN_CLIP_DURATION_S = 1.0

# Maximum clip duration in seconds: longer clips are discarded
MAX_CLIP_DURATION_S = 16.0

# Expected sample rate from cv_explorer.py extraction
EXPECTED_SAMPLE_RATE = 22050

# Target hours threshold: if dataset exceeds this, apply RMS-based selection
MAX_HOURS_DEFAULT = 5.0

# ── Voice disguise profiles ───────────────────────────────────────────────────
# Applied via Praat's "Change gender", which shifts formants and pitch
# independently. Formants carry most of the speaker identity, so the formant
# ratio matters more than the pitch median for masking the original voice.
#
#   formant_shift_ratio: <1.0 simulates a longer vocal tract (deeper, larger),
#                        >1.0 a shorter one (brighter, smaller).
#                        Stay within 0.80-1.25 to avoid audible artefacts.
#   new_pitch_median:    target median F0 in Hz. 0.0 leaves pitch unchanged.
#   pitch_range_factor:  <1.0 flattens intonation, >1.0 exaggerates it.
#                        1.0 leaves the original range.
#
# Tune these by ear on a handful of clips before processing a whole dataset.
DISGUISE_PROFILES = {
    "low": {
        "formant_shift_ratio": 0.94,
        "new_pitch_median": 0,
        "pitch_range_factor": 0.95,
    },
    "high": {
        "formant_shift_ratio": 1.03,
        "new_pitch_median": 182.0,
        "pitch_range_factor": 1.02,
    },
}

"""
Valori originali:
DISGUISE_PROFILES = {
    "low": {
        "formant_shift_ratio": 0.88,
        "new_pitch_median": 112.0,   # -23% from the measured ~145 Hz
        "pitch_range_factor": 0.90,
    },
    "high": {
        "formant_shift_ratio": 1.14,
        "new_pitch_median": 182.0,   # +26% from the measured ~145 Hz
        "pitch_range_factor": 1.10,
    },
}
"""

# Pitch search bounds for the analysis step, in Hz.
# Wide enough to cover both male and female speakers.
PITCH_FLOOR_HZ = 60.0
PITCH_CEILING_HZ = 500.0


def load_metadata(metadata_path: Path) -> list[tuple[str, str]]:
    """
    Load metadata.csv in LJSpeech format: wavs/000000.wav|sentence text

    Returns a list of (wav_relative_path, sentence) tuples.
    """
    entries = []
    with open(metadata_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split("|", 1)
            if len(parts) != 2:
                continue
            wav_rel, sentence = parts
            entries.append((wav_rel.strip(), sentence.strip()))
    return entries


def compute_rms(audio: np.ndarray) -> float:
    """Compute RMS amplitude of an audio array. Returns 0.0 for silent clips."""
    if len(audio) == 0:
        return 0.0
    return float(np.sqrt(np.mean(audio.astype(np.float64) ** 2)))


def trim_silence(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """
    Trim leading and trailing silence from audio.

    Uses a simple energy threshold approach to avoid dependency on librosa.
    """
    if len(audio) == 0:
        return audio

    # Convert threshold from dBFS to linear amplitude
    threshold_linear = 10 ** (SILENCE_THRESHOLD_DBFS / 20.0)

    # Compute frame-based energy with small hop
    frame_size = int(MIN_SILENCE_DURATION_S * sample_rate)
    frame_size = max(frame_size, 64)

    audio_float = audio.astype(np.float32)

    # Find start: first frame with energy above threshold
    start = 0
    for i in range(0, len(audio_float) - frame_size, frame_size):
        frame = audio_float[i : i + frame_size]
        if np.sqrt(np.mean(frame ** 2)) > threshold_linear:
            start = max(0, i - frame_size)
            break

    # Find end: last frame with energy above threshold
    end = len(audio_float)
    for i in range(len(audio_float) - frame_size, frame_size, -frame_size):
        frame = audio_float[i : i + frame_size]
        if np.sqrt(np.mean(frame ** 2)) > threshold_linear:
            end = min(len(audio_float), i + frame_size * 2)
            break

    trimmed = audio[start:end]

    # If trimming removed too much, return the original
    if len(trimmed) < frame_size:
        return audio

    return trimmed


def apply_noise_reduction(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """
    Apply light stationary noise reduction.

    The noise profile is estimated from the whole signal instead of from a
    leading window: Common Voice clips are short and tightly cut, so the first
    frames usually contain speech, not background.
    """
    audio_float = audio.astype(np.float32)

    # Too short for a meaningful spectral estimate
    if len(audio_float) < int(0.3 * sample_rate):
        return audio_float

    try:
        reduced = nr.reduce_noise(
            y=audio_float,
            sr=sample_rate,
            prop_decrease=NOISE_REDUCTION_PROP,
            stationary=True,
        )
        return reduced
    except Exception:
        # If noise reduction fails for any reason, return original
        return audio_float


def apply_voice_disguise(audio: np.ndarray, sample_rate: int, profile: str) -> np.ndarray:
    """
    Shift formants and pitch to mask the original speaker identity.

    Uses Praat's "Change gender" algorithm, which resamples the spectral
    envelope independently from the fundamental frequency. This is what makes
    the result sound like a different person rather than the same person
    transposed.

    Returns the original audio unchanged if the profile is unknown or if the
    clip is too short for a reliable pitch analysis.
    """
    params = DISGUISE_PROFILES.get(profile)
    if params is None:
        return audio

    audio_float = audio.astype(np.float64)

    # Praat needs enough signal to estimate F0
    if len(audio_float) < int(0.2 * sample_rate):
        return audio

    try:
        sound = parselmouth.Sound(audio_float, sampling_frequency=sample_rate)
        shifted = praat_call(
            sound,
            "Change gender",
            PITCH_FLOOR_HZ,
            PITCH_CEILING_HZ,
            params["formant_shift_ratio"],
            params["new_pitch_median"],
            params["pitch_range_factor"],
            1.0,  # duration factor: keep the original timing
        )
        return np.asarray(shifted.values[0], dtype=np.float32)
    except Exception as e:
        print(f"    [WARN] Voice disguise failed, keeping original: {e}")
        return audio.astype(np.float32)


def normalize_loudness(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """
    Normalize audio to TARGET_LUFS using pyloudnorm (EBU R128).

    Applies a true-peak limiter to avoid clipping after normalization.
    If the clip is too short for loudness measurement, falls back to RMS normalization.
    """
    audio_float = audio.astype(np.float64)

    meter = pyln.Meter(sample_rate)

    try:
        loudness = meter.integrated_loudness(audio_float)

        # pyloudnorm returns -inf for silence
        if not np.isfinite(loudness):
            return audio_float.astype(np.float32)

        # Compute required gain
        gain_db = TARGET_LUFS - loudness

        # Safety cap: never boost more than +20dB to avoid amplifying noise
        if gain_db > 20.0:
            gain_db = 20.0

        gain_linear = 10 ** (gain_db / 20.0)
        normalized = audio_float * gain_linear

        # True-peak limiting: hard clip at MAX_TRUE_PEAK_DBTP
        max_peak = 10 ** (MAX_TRUE_PEAK_DBTP / 20.0)
        peak = np.max(np.abs(normalized))
        if peak > max_peak:
            normalized = normalized * (max_peak / peak)

        return normalized.astype(np.float32)

    except Exception:
        # Fallback: simple RMS normalization
        rms = compute_rms(audio_float)
        if rms < 1e-8:
            return audio_float.astype(np.float32)
        target_rms = 10 ** (TARGET_LUFS / 20.0)
        gain = target_rms / rms
        gain = min(gain, 10.0)  # cap at +20dB
        return (audio_float * gain).astype(np.float32)


# Silence padding added at both ends after trimming, in seconds.
# VITS needs a consistent silence frame to learn clean onsets and decays.
PAD_SILENCE_S = 0.05

def pad_silence(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    """Add a fixed amount of digital silence at both ends of the clip."""
    pad_samples = int(PAD_SILENCE_S * sample_rate)
    if pad_samples <= 0:
        return audio
    padding = np.zeros(pad_samples, dtype=audio.dtype)
    return np.concatenate([padding, audio, padding])


def process_clip(wav_path: Path, disguise: str | None = None) -> tuple[np.ndarray | None, int, float]:
    """
    Load, validate, and preprocess a single WAV clip.

    Returns (processed_audio, sample_rate, original_rms) or (None, 0, 0.0) on failure.
    """
    try:
        audio, sample_rate = sf.read(str(wav_path), dtype="float32")
    except Exception as e:
        print(f"    [SKIP] Cannot read {wav_path.name}: {e}")
        return None, 0, 0.0

    # Ensure mono
    if audio.ndim > 1:
        audio = audio.mean(axis=1)

    # Check sample rate matches expectation
    if sample_rate != EXPECTED_SAMPLE_RATE:
        print(f"    [WARN] {wav_path.name}: unexpected sample rate {sample_rate}Hz (expected {EXPECTED_SAMPLE_RATE}Hz)")

    # Compute RMS before any processing (used for selection ranking)
    original_rms = compute_rms(audio)

    # Check duration
    duration_s = len(audio) / sample_rate
    if duration_s < MIN_CLIP_DURATION_S:
        print(f"    [SKIP] {wav_path.name}: too short ({duration_s:.2f}s)")
        return None, sample_rate, original_rms

    if duration_s > MAX_CLIP_DURATION_S:
        print(f"    [SKIP] {wav_path.name}: too long ({duration_s:.2f}s)")
        return None, sample_rate, original_rms

    # Pipeline: denoise -> disguise -> normalize -> trim -> pad
    # The disguise runs on denoised audio (cleaner pitch tracking) and before
    # normalization, since shifting changes the output level.
    audio = apply_noise_reduction(audio, sample_rate)
    if disguise:
        audio = apply_voice_disguise(audio, sample_rate, disguise)
    audio = normalize_loudness(audio, sample_rate)
    audio = trim_silence(audio, sample_rate)
    audio = pad_silence(audio, sample_rate)

    return audio, sample_rate, original_rms


def collect_clip_rms(entries: list[tuple[str, str]], wavs_dir: Path) -> list[tuple[str, str, float]]:
    """
    Compute RMS for all clips without processing them.

    Returns list of (wav_rel, sentence, rms) sorted by RMS descending.
    """
    print("  Scanning RMS levels for all clips...")
    results = []

    for i, (wav_rel, sentence) in enumerate(entries):
        # wav_rel is like "wavs/000000.wav" — get just the filename
        wav_filename = Path(wav_rel).name
        wav_path = wavs_dir / wav_filename

        if not wav_path.exists():
            continue

        try:
            audio, _ = sf.read(str(wav_path), dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            rms = compute_rms(audio)
        except Exception:
            rms = 0.0

        results.append((wav_rel, sentence, rms))

        if (i + 1) % 500 == 0:
            print(f"    Scanned {i + 1}/{len(entries)} clips...")

    # Sort by RMS descending (highest volume first)
    results.sort(key=lambda x: x[2], reverse=True)
    return results


def run_preprocessing(voice_folder: str, max_hours: float, disguise: str | None = None) -> None:
    """
    Main preprocessing pipeline for a single voice folder.
    """
    voice_path = Path(voice_folder).resolve()

    if not voice_path.exists():
        print(f"Error: folder not found: {voice_path}")
        sys.exit(1)

    wavs_dir = voice_path / "wavs"
    metadata_path = voice_path / "metadata.csv"

    if not wavs_dir.exists():
        print(f"Error: wavs/ folder not found inside {voice_path}")
        sys.exit(1)

    if not metadata_path.exists():
        print(f"Error: metadata.csv not found inside {voice_path}")
        sys.exit(1)

    # Output directory
    updated_dir = voice_path / "updated"
    updated_wavs_dir = updated_dir / "wavs"
    updated_metadata_path = updated_dir / "metadata.csv"

    if updated_dir.exists():
        print(f"Warning: updated/ already exists, removing it...")
        shutil.rmtree(updated_dir)

    updated_wavs_dir.mkdir(parents=True)

    print(f"\n{'=' * 60}")
    print(f"Processing: {voice_path.name}")
    print(f"{'=' * 60}")

    # Load metadata
    entries = load_metadata(metadata_path)
    print(f"  Loaded {len(entries)} entries from metadata.csv")

    if disguise:
        params = DISGUISE_PROFILES[disguise]
        print(f"  Voice disguise: '{disguise}' "
              f"(formants x{params['formant_shift_ratio']}, "
              f"median {params['new_pitch_median']}Hz, "
              f"range x{params['pitch_range_factor']})")

    # Compute total estimated duration
    total_duration_s = 0.0
    for wav_rel, _ in entries:
        wav_path = wavs_dir / Path(wav_rel).name
        if wav_path.exists():
            try:
                info = sf.info(str(wav_path))
                total_duration_s += info.duration
            except Exception:
                total_duration_s += 5.4  # fallback to average

    total_hours = total_duration_s / 3600.0
    print(f"  Total audio: {total_hours:.2f} hours")

    # ── Selection phase (only if dataset exceeds max_hours) ───────────────────
    if total_hours > max_hours:
        print(f"\n  Dataset exceeds {max_hours:.1f}h target → selecting best clips by RMS volume")
        ranked = collect_clip_rms(entries, wavs_dir)

        # Select clips until we reach the target duration
        selected = []
        selected_duration = 0.0
        target_duration_s = max_hours * 3600.0

        for wav_rel, sentence, rms in ranked:
            wav_path = wavs_dir / Path(wav_rel).name
            if not wav_path.exists():
                continue
            try:
                info = sf.info(str(wav_path))
                duration = info.duration
            except Exception:
                duration = 5.4

            if selected_duration + duration <= target_duration_s:
                selected.append((wav_rel, sentence))
                selected_duration += duration

            if selected_duration >= target_duration_s:
                break

        print(f"  Selected {len(selected)} clips ({selected_duration / 3600:.2f}h) out of {len(entries)}")
        entries_to_process = selected
    else:
        print(f"  Dataset within {max_hours:.1f}h target → processing all clips")
        entries_to_process = entries

    # ── Processing phase ───────────────────────────────────────────────────────
    print(f"\n  Processing {len(entries_to_process)} clips...")

    metadata_rows = []
    processed = 0
    skipped = 0

    for i, (wav_rel, sentence) in enumerate(entries_to_process):
        wav_filename = Path(wav_rel).name
        src_path = wavs_dir / wav_filename

        if not src_path.exists():
            print(f"    [SKIP] File not found: {wav_filename}")
            skipped += 1
            continue

        # Process the clip
        audio, sample_rate, _ = process_clip(src_path, disguise)

        if audio is None:
            skipped += 1
            continue

        # Save with a new sequential filename
        new_filename = f"{processed:06d}.wav"
        dst_path = updated_wavs_dir / new_filename

        try:
            sf.write(str(dst_path), audio, sample_rate, subtype="PCM_16")
            metadata_rows.append(f"wavs/{new_filename}|{sentence}")
            processed += 1
        except Exception as e:
            print(f"    [SKIP] Cannot write {new_filename}: {e}")
            skipped += 1

        if (i + 1) % 200 == 0:
            print(f"    Progress: {i + 1}/{len(entries_to_process)} (processed: {processed}, skipped: {skipped})")

    # ── Write updated metadata ─────────────────────────────────────────────────
    with open(updated_metadata_path, "w", encoding="utf-8") as f:
        f.write("\n".join(metadata_rows))

    final_duration_s = sum(
        sf.info(str(updated_wavs_dir / Path(r.split("|")[0]).name)).duration
        for r in metadata_rows
        if (updated_wavs_dir / Path(r.split("|")[0]).name).exists()
    )

    print(f"\n{'=' * 60}")
    print(f"DONE: {voice_path.name}")
    print(f"{'=' * 60}")
    print(f"  Processed:  {processed} clips")
    print(f"  Skipped:    {skipped} clips")
    print(f"  Total audio:{final_duration_s / 3600:.2f} hours")
    print(f"  Output:     {updated_dir}/")
    print(f"{'=' * 60}\n")


def main():
    parser = argparse.ArgumentParser(
        description="Preprocess a Piper TTS voice dataset for fine-tuning."
    )
    parser.add_argument(
        "voice_folder",
        help="Path to the voice folder (must contain wavs/ and metadata.csv)",
    )
    parser.add_argument(
        "--max-hours",
        type=float,
        default=MAX_HOURS_DEFAULT,
        help=f"Max hours to keep if dataset is larger (default: {MAX_HOURS_DEFAULT}). "
             "Set to a large number (e.g. 99) to process all clips.",
    )

    parser.add_argument(
        "--disguise",
        choices=sorted(DISGUISE_PROFILES.keys()),
        default=None,
        help="Mask the speaker identity by shifting formants and pitch. "
             "'low' makes the voice deeper, 'high' brighter. "
             "Omit to keep the original voice.",
    )

    args = parser.parse_args()
    run_preprocessing(args.voice_folder, args.max_hours, args.disguise)


if __name__ == "__main__":
    main()
