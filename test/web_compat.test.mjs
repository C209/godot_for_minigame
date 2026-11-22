import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// iOS JavaScriptCore ships no WHATWG encoding APIs, and TapTap's own
// `Response` constructor calls `new TextEncoder()` while WXWebAssembly reads
// engine/godot.wasm.br. These cases pin the fill that keeps that host path
// alive, plus the encoding semantics the engine and the fetch polyfill rely on.
const projectRoot = path.resolve(import.meta.dirname, "..");
const commonRoot = path.join(projectRoot, "addons/godot_mini_game/templates/common");

function read(relativePath) {
  return fs.readFileSync(path.join(commonRoot, relativePath), "utf8");
}

function moduleUrl(source) {
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}#${Date.now()}-${Math.random()}`;
}

function replaceSpecifier(source, specifier, replacement) {
  return source.replaceAll(JSON.stringify(specifier), JSON.stringify(replacement));
}

const HOST_API_NAMES = ["TextEncoder", "TextDecoder", "atob", "btoa"];

function stashHostApis() {
  const saved = new Map();
  for (const name of HOST_API_NAMES) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  return saved;
}

function restoreHostApis(saved) {
  for (const name of HOST_API_NAMES) {
    delete globalThis[name];
    const descriptor = saved.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  }
}

function removeHostApis() {
  for (const name of HOST_API_NAMES) delete globalThis[name];
  assert.equal(typeof globalThis.TextEncoder, "undefined");
  assert.equal(typeof globalThis.TextDecoder, "undefined");
}

async function importCompat() {
  delete globalThis.__godotMiniGamePlatformRuntime;
  delete globalThis.PlatformRuntime;
  const runtimeUrl = moduleUrl(read("js/platform_runtime.js"));
  const source = replaceSpecifier(read("js/web_compat.js"), "./platform_runtime", runtimeUrl);
  await import(moduleUrl(source));
}

async function testFillOnHostWithoutEncodingApis() {
  const saved = stashHostApis();
  try {
    removeHostApis();
    // GameGlobal is a distinct object on several hosts; both realms must be
    // filled or the engine and host modules disagree about what exists.
    globalThis.GameGlobal = { __platform: "taptap" };
    globalThis.tap = {};

    await importCompat();

    assert.equal(typeof globalThis.TextEncoder, "function", "TextEncoder must be filled in");
    assert.equal(typeof globalThis.TextDecoder, "function", "TextDecoder must be filled in");
    assert.equal(typeof globalThis.atob, "function");
    assert.equal(typeof globalThis.btoa, "function");
    assert.equal(
      globalThis.GameGlobal.TextEncoder,
      globalThis.TextEncoder,
      "every realm must share one implementation",
    );
    assert.equal(globalThis.GameGlobal.TextDecoder, globalThis.TextDecoder);

    const encoder = new globalThis.TextEncoder();
    assert.equal(encoder.encoding, "utf-8");
    assert.deepEqual([...encoder.encode("A")], [0x41]);
    assert.deepEqual([...encoder.encode("é")], [0xC3, 0xA9]);
    assert.deepEqual([...encoder.encode("世")], [0xE4, 0xB8, 0x96]);
    assert.deepEqual([...encoder.encode("🐉")], [0xF0, 0x9F, 0x90, 0x89]);
    // A lone surrogate cannot be encoded; the standard substitutes U+FFFD
    // instead of throwing, which is what engine string marshalling expects.
    assert.deepEqual([...encoder.encode("\uD800")], [0xEF, 0xBF, 0xBD]);
    assert.deepEqual([...encoder.encode("")], []);

    const decoder = new globalThis.TextDecoder();
    assert.equal(decoder.encoding, "utf-8");
    const sample = "冰瀑洞穴 fox 🦊";
    assert.equal(decoder.decode(encoder.encode(sample)), sample);
    // A BOM is only meaningful at the head of the stream, so each case gets a
    // fresh decoder.
    assert.equal(
      new globalThis.TextDecoder().decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41])),
      "A",
      "BOM is stripped",
    );
    assert.equal(
      new globalThis.TextDecoder("utf-8", { ignoreBOM: true })
        .decode(new Uint8Array([0xEF, 0xBB, 0xBF, 0x41])),
      "\uFEFFA",
      "ignoreBOM keeps the BOM",
    );
    assert.equal(
      decoder.decode(new Uint8Array([0xC3, 0x28])),
      "\uFFFD(",
      "malformed bytes decode to U+FFFD and resume at the offending byte",
    );
    assert.throws(
      () => new globalThis.TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xC3, 0x28])),
      TypeError,
      "fatal decoding must throw",
    );
    assert.throws(() => new globalThis.TextDecoder("gbk"), RangeError);

    // Streaming decode must carry the trailing partial code point.
    const streaming = new globalThis.TextDecoder();
    assert.equal(streaming.decode(new Uint8Array([0xE4, 0xB8]), { stream: true }), "");
    assert.equal(streaming.decode(new Uint8Array([0x96])), "世");
    // Fatal only applies to the final flush: a stream may still be mid sequence.
    const fatalStream = new globalThis.TextDecoder("utf-8", { fatal: true });
    assert.equal(fatalStream.decode(new Uint8Array([0xE4]), { stream: true }), "");
    assert.equal(fatalStream.decode(new Uint8Array([0xB8, 0x96])), "世");
    assert.throws(() => new globalThis.TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xE4])), TypeError);

    // ArrayBuffer and offset views are both valid inputs.
    const encoded = encoder.encode("洞穴");
    assert.equal(decoder.decode(encoded.buffer), "洞穴");
    const padded = new Uint8Array([0xFF, ...encoded, 0xFF]);
    assert.equal(
      decoder.decode(new Uint8Array(padded.buffer, 1, encoded.length)),
      "洞穴",
    );

    // encodeInto stops cleanly when the destination cannot hold the next code
    // point, and reports exactly what it consumed.
    const destination = new Uint8Array(4);
    const progress = encoder.encodeInto("abc世", destination);
    assert.deepEqual(progress, { read: 3, written: 3 });
    assert.deepEqual([...destination.subarray(0, 3)], [0x61, 0x62, 0x63]);
    assert.throws(() => encoder.encodeInto("a", "not a buffer"), TypeError);

    assert.equal(globalThis.btoa("hello"), "aGVsbG8=");
    assert.equal(globalThis.atob("aGVsbG8="), "hello");
    assert.equal(globalThis.btoa(""), "");
    assert.throws(() => globalThis.btoa("世"), (error) => error.name === "InvalidCharacterError");
    assert.throws(() => globalThis.atob("****"), (error) => error.name === "InvalidCharacterError");
  } finally {
    restoreHostApis(saved);
    delete globalThis.GameGlobal;
    delete globalThis.tap;
    delete globalThis.PlatformRuntime;
    delete globalThis.__godotMiniGamePlatformRuntime;
  }
}

async function testExistingHostApisAreKept() {
  globalThis.GameGlobal = { __platform: "taptap" };
  globalThis.tap = {};
  const hostEncoder = globalThis.TextEncoder;
  const hostDecoder = globalThis.TextDecoder;
  const hostAtob = globalThis.atob;
  const hostBtoa = globalThis.btoa;
  try {
    await importCompat();
    assert.equal(globalThis.TextEncoder, hostEncoder, "a working host TextEncoder must survive");
    assert.equal(globalThis.TextDecoder, hostDecoder, "a working host TextDecoder must survive");
    assert.equal(globalThis.atob, hostAtob);
    assert.equal(globalThis.btoa, hostBtoa);
    assert.equal(globalThis.GameGlobal.TextEncoder, hostEncoder);
  } finally {
    delete globalThis.GameGlobal;
    delete globalThis.tap;
    delete globalThis.PlatformRuntime;
    delete globalThis.__godotMiniGamePlatformRuntime;
  }
}

await testFillOnHostWithoutEncodingApis();
await testExistingHostApisAreKept();

console.log("web_compat.test.mjs: ok");
