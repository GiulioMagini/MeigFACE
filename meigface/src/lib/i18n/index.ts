//! Minimal runtime-switchable i18n store.
//!
//! Loads dictionaries statically at build time (fast, no network),
//! detects the browser language once on startup, and exposes a Svelte
//! store plus a `t()` helper for component use. The active language
//! can be swapped at any time via `setLocale()`.

import { writable, derived, get, type Readable } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";

import en from "./en.json";
import it from "./it.json";
import fr from "./fr.json";
import de from "./de.json";
import es from "./es.json";
import pt from "./pt.json";

/** Built-in locales that always ship with the app: the six languages the
 *  default conversation model handles, so every one of them works out of the
 *  box once matching voices are installed. Other languages come from custom
 *  dictionaries loaded at runtime. */
const BASE_LOCALES = ["en", "it", "fr", "de", "es", "pt"];

/** A locale code (built-in or a custom one loaded at runtime). */
export type Locale = string;

/**
 * Locales currently available in the UI. Starts with the built-ins and grows
 * as valid custom dictionaries are loaded from disk (see loadCustomLocales).
 * Reactive so language switchers update when custom locales are registered.
 */
export const availableLocales = writable<string[]>([...BASE_LOCALES]);

/** Recursive dictionary type — accepts nested string maps only. */
type Dictionary = { [key: string]: string | Dictionary };

/**
 * Registered dictionaries, keyed by locale code. Mutated at runtime by
 * registerLocale when custom locales are loaded.
 */
const dictionaries: Record<string, Dictionary> = {
  en: en as Dictionary,
  it: it as Dictionary,
  fr: fr as Dictionary,
  de: de as Dictionary,
  es: es as Dictionary,
  pt: pt as Dictionary,
};

/**
 * Pick the best locale for the browser's language preferences among the given
 * available codes, falling back to English. Used at startup for the built-in
 * locales, and again after custom locales load so a browser language matching a
 * user-provided dictionary (e.g. French) is selected automatically.
 */
function detectLocale(available: string[]): string {
  if (typeof navigator === "undefined") return "en";
  const prefs = navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
  for (const pref of prefs) {
    const primary = pref.toLowerCase().split("-")[0];
    if (available.includes(primary)) {
      return primary;
    }
  }
  return "en";
}

/** Current active locale. Bind against this for UI language switchers. */
export const locale = writable<Locale>(detectLocale(BASE_LOCALES));

/** Change the active locale at runtime. No persistence yet. */
export function setLocale(next: Locale): void {
  locale.set(next);
}

/**
 * Look up a key like "calibration.introTitle" against the given dict.
 * Returns null if any segment of the path is missing, so the caller
 * can choose to fall back to another language.
 */
function resolveKey(dict: Dictionary, path: string): string | null {
  const segments = path.split(".");
  let cursor: string | Dictionary = dict;
  for (const segment of segments) {
    if (typeof cursor === "string") return null;
    if (!(segment in cursor)) return null;
    cursor = cursor[segment];
  }
  return typeof cursor === "string" ? cursor : null;
}

/**
 * Substitute {placeholders} in a message with values from the params
 * map. Missing placeholders are left untouched so typos are visible
 * during development instead of silently rendering empty strings.
 */
function interpolate(
  message: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (match, name) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Reactive translation function. Use with Svelte's auto-subscription:
 *   <p>{$t("calibration.introTitle")}</p>
 *
 * The returned function accepts an optional params map for
 * interpolation (e.g. `{ count: 25 }` fills `{count}` in the
 * translated string).
 */
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export const t: Readable<TranslateFn> = derived(
  [locale, availableLocales],
  ([$locale]) => {
    return (key: string, params?: Record<string, string | number>): string => {
      // A custom locale may not be registered yet (or was removed); fall back
      // to the English dictionary for lookup in that case.
      const active = dictionaries[$locale] ?? dictionaries.en;
      const primary = resolveKey(active, key);
      if (primary !== null) return interpolate(primary, params);
      // Fall back to English when the active language is missing a key,
      // so a half-translated UI never crashes the layout.
      const fallback = resolveKey(dictionaries.en, key);
      if (fallback !== null) return interpolate(fallback, params);
      // Last resort: render the key itself, making missing translations
      // obvious at a glance during development.
      return key;
    };
  },
);

/**
 * Non-reactive one-shot lookup. Prefer the reactive `$t(...)` form
 * inside Svelte templates; use this only from plain TypeScript modules
 * where reactivity is not needed (e.g. inside business logic).
 */
export function translate(
  key: string,
  params?: Record<string, string | number>,
): string {
  return get(t)(key, params);
}

/**
 * Register a runtime-loaded dictionary under a locale code and make it
 * selectable in the UI. Called by loadCustomLocales for each valid file.
 */
export function registerLocale(code: string, dict: Dictionary): void {
  dictionaries[code] = dict;
  availableLocales.update((list) =>
    list.includes(code) ? list : [...list, code],
  );
}

/**
 * Return the first key path present in `reference` but missing (or of the
 * wrong kind) in `candidate`, or null if the candidate covers the whole
 * reference structure. Used to validate custom dictionaries against English.
 */
function firstMissingPath(
  reference: Dictionary,
  candidate: unknown,
  prefix = "",
): string | null {
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    return prefix || "(root)";
  }
  const cand = candidate as Record<string, unknown>;
  for (const key of Object.keys(reference)) {
    const refVal = reference[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof refVal === "string") {
      if (typeof cand[key] !== "string") return path;
    } else {
      const missing = firstMissingPath(refVal, cand[key], path);
      if (missing) return missing;
    }
  }
  return null;
}

/**
 * Load user-provided dictionaries from the on-disk "i18n" folder next to the
 * app. Each file must match the English structure exactly; valid ones get their
 * voices/<code>/{male,female} folders created and are registered as selectable
 * locales. Safe to call once at startup; per-file failures are logged and
 * skipped so a bad file never blocks the app.
 */
export async function loadCustomLocales(): Promise<void> {
  try {
    // Drop an English reference dictionary so users can base a translation on
    // it (e.g. via an AI); written only if absent (never overwritten).
    await invoke("ensure_locale_reference", {
      content: JSON.stringify(en, null, 2),
    });
  } catch (e) {
    console.warn("could not write locale references:", e);
  }

  let customs: Array<{ code: string; content: string }> = [];
  try {
    customs = await invoke<Array<{ code: string; content: string }>>(
      "list_custom_locales",
    );
  } catch (e) {
    console.warn("could not list custom locales:", e);
    return;
  }

  for (const { code, content } of customs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.warn(`custom locale "${code}" skipped: invalid JSON`);
      continue;
    }
    const missing = firstMissingPath(dictionaries.en, parsed);
    if (missing) {
      console.warn(
        `custom locale "${code}" skipped: missing/invalid key "${missing}"`,
      );
      continue;
    }
    try {
      // Create voices/<code>/{male,female} so the user can add matching voices.
      await invoke("ensure_voice_dirs", { code });
    } catch (e) {
      console.warn(
        `custom locale "${code}": could not create voice folders:`,
        e,
      );
    }
    registerLocale(code, parsed as Dictionary);
  }

  // Re-run browser-language detection now that custom locales are registered,
  // so a browser language matching a user-provided dictionary (e.g. fr) is
  // selected automatically. detectLocale only returns an available code, so
  // this also recovers when the previously active locale is no longer present.
  locale.set(detectLocale(get(availableLocales)));
}