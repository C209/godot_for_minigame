/**
 * Fills the Web APIs that some mini-game JavaScript realms never received.
 *
 * Apple's JavaScriptCore realms — which is what TapTap runs inside on iOS —
 * expose none of the WHATWG encoding APIs. Android (V8) and every DevTools
 * browser provide them, so the gap only appears on iOS, and only once
 * somebody dereferences them:
 *
 *   [Loader] ✗ 加载失败: TypeError: undefined is not a constructor
 *            (evaluating 'new TextEncoder()')
 *   Stack: Response@tjapp://game-runtime/tjfs/index.js:7870:61
 *
 * That `Response` belongs to the host's own fetch/file-system layer, which
 * `WXWebAssembly.instantiate()` uses to read `engine/godot.wasm.br`, so the
 * engine never started. Restoring `TextEncoder` fixes the host code path, not
 * just our own: the host resolves the same bare global.
 *
 * Ordering matters. This module must be imported before `adapter.js`, because
 * the adapter copies `globalThis.TextEncoder` onto GameGlobal and the engine
 * glue resolves those identifiers afterwards. Nothing here replaces an
 * implementation the host already ships — every fill is feature-detected, so
 * a working host API is left untouched.
 */

import { PlatformRuntime } from "./platform_runtime";

const _global = PlatformRuntime.global;

// ── UTF-8 primitives ──────────────────────────────────────────────
// `1 x U+FFFD` is what both TextEncoder and TextDecoder emit for an
// unencodable code unit or an undecodable byte sequence.
const _REPLACEMENT = 0xFFFD;

/// Encodes `source` into `destination` starting at `offset`, returning
/// `{ read, written }` so encode() and encodeInto() share one surrogate
/// handling path.
function _encodeUtf8(source, destination, offset) {
  let read = 0;
  let written = offset;
  while (read < source.length) {
    const unit = source.charCodeAt(read);
    let codePoint = unit;
    let size;
    let units = 1;

    if (unit < 0x80) {
      size = 1;
    } else if (unit < 0x800) {
      size = 2;
    } else if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = read + 1 < source.length ? source.charCodeAt(read + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codePoint = 0x10000 + ((unit - 0xD800) << 10) + (next - 0xDC00);
        size = 4;
        units = 2;
      } else {
        // Lone high surrogate: WHATWG substitutes U+FFFD, it does not throw.
        codePoint = _REPLACEMENT;
        size = 3;
      }
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      codePoint = _REPLACEMENT;
      size = 3;
    } else {
      size = 3;
    }

    if (written + size > destination.length) break;

    if (size === 1) {
      destination[written] = codePoint;
    } else if (size === 2) {
      destination[written] = 0xC0 | (codePoint >> 6);
      destination[written + 1] = 0x80 | (codePoint & 0x3F);
    } else if (size === 3) {
      destination[written] = 0xE0 | (codePoint >> 12);
      destination[written + 1] = 0x80 | ((codePoint >> 6) & 0x3F);
      destination[written + 2] = 0x80 | (codePoint & 0x3F);
    } else {
      destination[written] = 0xF0 | (codePoint >> 18);
      destination[written + 1] = 0x80 | ((codePoint >> 12) & 0x3F);
      destination[written + 2] = 0x80 | ((codePoint >> 6) & 0x3F);
      destination[written + 3] = 0x80 | (codePoint & 0x3F);
    }
    written += size;
    read += units;
  }
  return { read, written: written - offset };
}

/// Decodes UTF-8 the way the Encoding standard does: a malformed sequence is
/// reported as U+FFFD and decoding resumes at the first byte that could not be
/// consumed. `allowIncomplete` returns the trailing partial sequence in `tail`
/// instead of replacing it, which is what a streaming decode needs.
function _decodeUtf8(bytes, fatal, allowIncomplete) {
  let text = "";
  let index = 0;
  let tail = null;

  while (index < bytes.length) {
    const lead = bytes[index];
    if (lead < 0x80) {
      text += String.fromCharCode(lead);
      index += 1;
      continue;
    }

    let needed;
    let codePoint;
    let lower = 0x80;
    let upper = 0xBF;
    if (lead >= 0xC2 && lead <= 0xDF) {
      needed = 1;
      codePoint = lead & 0x1F;
    } else if (lead >= 0xE0 && lead <= 0xEF) {
      needed = 2;
      codePoint = lead & 0x0F;
      if (lead === 0xE0) lower = 0xA0;
      if (lead === 0xED) upper = 0x9F;
    } else if (lead >= 0xF0 && lead <= 0xF4) {
      needed = 3;
      codePoint = lead & 0x07;
      if (lead === 0xF0) lower = 0x90;
      if (lead === 0xF4) upper = 0x8F;
    } else {
      // 0x80-0xC1 and 0xF5-0xFF can never start a sequence.
      if (fatal) throw new TypeError("TextDecoder: invalid UTF-8 lead byte");
      text += String.fromCharCode(_REPLACEMENT);
      index += 1;
      continue;
    }

    let cursor = index + 1;
    let truncated = false;
    let malformed = false;
    for (let step = 0; step < needed; step += 1, cursor += 1) {
      if (cursor >= bytes.length) {
        truncated = true;
        break;
      }
      const byte = bytes[cursor];
      const minimum = step === 0 ? lower : 0x80;
      const maximum = step === 0 ? upper : 0xBF;
      if (byte < minimum || byte > maximum) {
        malformed = true;
        break;
      }
      codePoint = (codePoint << 6) | (byte & 0x3F);
    }

    if (truncated) {
      // A streaming decode always carries the partial sequence, even in fatal
      // mode; only the final flush reports it.
      if (allowIncomplete) {
        tail = bytes.subarray(index);
        break;
      }
      if (fatal) throw new TypeError("TextDecoder: truncated UTF-8 sequence");
      text += String.fromCharCode(_REPLACEMENT);
      break;
    }
    if (malformed) {
      if (fatal) throw new TypeError("TextDecoder: invalid UTF-8 continuation byte");
      text += String.fromCharCode(_REPLACEMENT);
      // Resume on the offending byte: it may start a valid sequence.
      index = cursor;
      continue;
    }

    text += String.fromCodePoint(codePoint);
    index = cursor;
  }

  return { text, tail };
}

// ── Polyfills ─────────────────────────────────────────────────────
class TextEncoderPolyfill {
  get encoding() { return "utf-8"; }

  encode(input = "") {
    const source = String(input);
    // 3 bytes is the worst case per code unit (a surrogate pair is 2 units
    // producing 4 bytes), so one allocation always suffices.
    const destination = new Uint8Array(source.length * 3);
    const written = _encodeUtf8(source, destination, 0).written;
    return destination.subarray(0, written);
  }

  encodeInto(source, destination) {
    if (!(destination instanceof Uint8Array)) {
      throw new TypeError("TextEncoder.encodeInto requires a Uint8Array destination");
    }
    return _encodeUtf8(String(source), destination, 0);
  }
}

const _UTF8_LABELS = [
  "unicode-1-1-utf-8", "unicode11utf8", "unicode20utf8",
  "utf-8", "utf8", "x-unicode20utf8",
];

class TextDecoderPolyfill {
  constructor(label = "utf-8", options = {}) {
    const normalised = String(label).trim().toLowerCase();
    if (!_UTF8_LABELS.includes(normalised)) {
      throw new RangeError(`TextDecoder: unsupported encoding "${label}"`);
    }
    const settings = options || {};
    this.encoding = "utf-8";
    this.fatal = !!settings.fatal;
    this.ignoreBOM = !!settings.ignoreBOM;
    this._pending = null;
    this._bomHandled = false;
  }

  decode(input, options = {}) {
    const streaming = !!(options && options.stream);
    let bytes;
    if (input === undefined || input === null) {
      bytes = new Uint8Array(0);
    } else if (input instanceof ArrayBuffer) {
      bytes = new Uint8Array(input);
    } else if (ArrayBuffer.isView(input)) {
      bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } else {
      throw new TypeError("TextDecoder.decode requires an ArrayBuffer or an ArrayBuffer view");
    }

    if (this._pending) {
      const merged = new Uint8Array(this._pending.length + bytes.length);
      merged.set(this._pending, 0);
      merged.set(bytes, this._pending.length);
      bytes = merged;
      this._pending = null;
    }

    const { text, tail } = _decodeUtf8(bytes, this.fatal, streaming);
    if (tail) this._pending = tail;

    let output = text;
    if (!this._bomHandled) {
      this._bomHandled = true;
      if (!this.ignoreBOM && output.charCodeAt(0) === 0xFEFF) {
        output = output.slice(1);
      }
    }
    return output;
  }
}

// ── Base64 ────────────────────────────────────────────────────────
// Kept to the ASCII surface the mini-game hosts use (file contents and
// signatures). Anything outside it fails loudly instead of silently
// producing corrupt bytes.
const _BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function _invalidCharacter(api, value) {
  const error = new Error(`${api}: the string contains characters outside of the Latin1 range`);
  error.name = "InvalidCharacterError";
  error.value = value;
  return error;
}

function _btoa(value) {
  const source = String(value);
  let output = "";
  for (let index = 0; index < source.length; index += 3) {
    const first = source.charCodeAt(index);
    const second = index + 1 < source.length ? source.charCodeAt(index + 1) : NaN;
    const third = index + 2 < source.length ? source.charCodeAt(index + 2) : NaN;
    if (first > 0xFF || second > 0xFF || third > 0xFF) throw _invalidCharacter("btoa", value);
    const chunk = (first << 16)
      | ((Number.isNaN(second) ? 0 : second) << 8)
      | (Number.isNaN(third) ? 0 : third);
    output += _BASE64_ALPHABET[(chunk >> 18) & 0x3F];
    output += _BASE64_ALPHABET[(chunk >> 12) & 0x3F];
    output += Number.isNaN(second) ? "=" : _BASE64_ALPHABET[(chunk >> 6) & 0x3F];
    output += Number.isNaN(third) ? "=" : _BASE64_ALPHABET[chunk & 0x3F];
  }
  return output;
}

function _atob(value) {
  let source = String(value).replace(/[\t\n\f\r ]/g, "");
  if (source.length % 4 === 0) source = source.replace(/==?$/, "");
  if (source.length % 4 === 1) {
    const error = new TypeError("atob: invalid base64 length");
    error.name = "InvalidCharacterError";
    throw error;
  }
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < source.length; index += 1) {
    const digit = _BASE64_ALPHABET.indexOf(source[index]);
    if (digit === -1) {
      const error = new TypeError("atob: invalid base64 character");
      error.name = "InvalidCharacterError";
      throw error;
    }
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xFF);
    }
  }
  return output;
}

// ── Installation ──────────────────────────────────────────────────
/// Publishes one global into every runtime-facing realm. `PlatformRuntime.global`
/// and `globalThis` are the same object on the hosts that keep a single realm;
/// TikTok and the DevTools frames keep GameGlobal separate, so both are covered
/// (the same target list the adapter's WebAssembly shim uses).
function _realms() {
  const targets = [];
  for (const candidate of [_global, globalThis]) {
    if (candidate && !targets.includes(candidate)) targets.push(candidate);
  }
  return targets;
}

function _define(target, name, value) {
  try {
    Object.defineProperty(target, name, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch (_) {
    try { target[name] = value; } catch (_2) {}
  }
}

const _sources = [];

function _fill(name, factory) {
  const realms = _realms();
  // A host that ships the API in one realm only (GameGlobal without the module
  // global, or the reverse) must see its own implementation propagated instead
  // of being replaced by a JavaScript version of it.
  const existing = realms
    .map((target) => target[name])
    .find((candidate) => typeof candidate === "function") || null;
  if (existing) {
    for (const target of realms) {
      if (typeof target[name] !== "function") _define(target, name, existing);
    }
    _sources.push(`${name}=host`);
    return;
  }
  const value = factory();
  for (const target of realms) _define(target, name, value);
  _sources.push(`${name}=polyfill`);
}

_fill("TextEncoder", () => TextEncoderPolyfill);
_fill("TextDecoder", () => TextDecoderPolyfill);
_fill("atob", () => _atob);
_fill("btoa", () => _btoa);

console.log(
  `[Compat] platform=${PlatformRuntime.platform} 编码 API: ${_sources.join(" ")}`,
);
if (_sources.some((entry) => entry.endsWith("=polyfill"))) {
  // Expected on iOS JavaScriptCore; without this line the next failure looks
  // like an engine bug instead of a host API gap.
  console.log("[Compat] 宿主未提供 WHATWG 编码 API，已由运行时补齐");
}

// Snapshot the APIs that no other runtime layer synthesises (`Blob` is faked
// by loader.js, so it is not listed). When the next host-side failure names one
// of these, the log already says whether the realm had it at startup instead of
// costing another device round trip to find out.
const _watchlist = ["FormData", "structuredClone", "TextDecoderStream"];
const _absent = _watchlist.filter((name) => typeof globalThis[name] === "undefined");
console.log(
  _absent.length === 0
    ? "[Compat] 宿主全局快照: 齐备"
    : `[Compat] 宿主全局快照: 缺失 ${_absent.join(", ")}`,
);
