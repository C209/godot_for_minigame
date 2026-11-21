import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// TapTap integration smoke test. Loads the shared adapter / fetch / SDK /
// loader against a `tap` host fixture and asserts the provider contract the
// exporter guarantees (templates/taptap + support-matrix.json "taptap").
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

function makeCanvas() {
  return {
    width: 0,
    height: 0,
    style: {},
    getContext(type) { return { type, canvas: this }; },
  };
}

function installTapGlobals() {
  delete globalThis.wx;
  delete globalThis.tt;
  delete globalThis.TTMinis;
  delete globalThis.tap;
  delete globalThis.__godotMiniGamePlatformRuntime;
  delete globalThis.PlatformRuntime;
  delete globalThis.godotSdk;
  delete globalThis.godotMiniGameBridgeV1;
  delete globalThis.WXWebAssembly;
  delete globalThis.TTWebAssembly;

  const canvas = makeCanvas();
  const callbacks = {};
  let storageInfoCalls = 0;
  let nativeInstantiateCalls = 0;
  globalThis.GameGlobal = { canvas };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const api = {
    env: { USER_DATA_PATH: "/tmp" },
    createCanvas: makeCanvas,
    createImage() { return {}; },
    getWindowInfo() {
      return {
        platform: "android",
        language: "zh_CN",
        windowWidth: 360,
        windowHeight: 780,
        screenWidth: 360,
        screenHeight: 780,
        pixelRatio: 2,
      };
    },
    getSystemInfoSync() { return this.getWindowInfo(); },
    getFileSystemManager() { return { writeFileSync() {} }; },
    getStorageSync() { return null; },
    setStorageSync() {},
    removeStorageSync() {},
    clearStorageSync() {},
    getStorageInfoSync() {
      storageInfoCalls += 1;
      return { keys: ["save"], currentSize: 3, limitSize: 10 };
    },
    request(options) {
      options.success({ data: "ok", statusCode: 200, errMsg: "request:ok", header: {} });
    },
    onTouchStart(fn) { callbacks.touchStart = fn; },
    onTouchMove(fn) { callbacks.touchMove = fn; },
    onTouchEnd(fn) { callbacks.touchEnd = fn; },
    onTouchCancel(fn) { callbacks.touchCancel = fn; },
    onWindowResize(fn) { callbacks.resize = fn; },
    onShow() {},
    onHide() {},
    loadSubpackage(options) { options.success(); },
  };
  globalThis.tap = api;
  // The TapTap host also runs a WeChat-compatibility layer that exposes `wx`
  // next to `tap`. The provider must still resolve to taptap, and it must not
  // pick up the WeChat native WASM shim through that alias.
  globalThis.wx = {
    createCanvas: makeCanvas,
    getStorageSync() { return null; },
    getStorageInfoSync() {
      throw new Error("TapTap must not route through the wx compatibility alias");
    },
  };
  // The TapTap host also injects a WeChat-compatible native WASM bridge. The
  // engine ships as godot.wasm.br, which standard WebAssembly cannot decompress,
  // so this bridge must be selected and installed as the WebAssembly shim.
  globalThis.WXWebAssembly = {
    instantiate() {
      nativeInstantiateCalls += 1;
      throw new Error("native instantiate is not exercised during import");
    },
  };
  return {
    storageInfoCalls: () => storageInfoCalls,
    nativeInstantiateCalls: () => nativeInstantiateCalls,
  };
}

async function testTapAdapterFetchLoaderAndSdkImports() {
  const counters = installTapGlobals();
  const nativeWebAssembly = globalThis.WebAssembly;

  const runtimeUrl = moduleUrl(read("js/platform_runtime.js"));

  const adapterUrl = moduleUrl(
    replaceSpecifier(read("adapter.js"), "./js/platform_runtime", runtimeUrl),
  );
  await import(adapterUrl);

  assert.equal(globalThis.GameGlobal.PlatformRuntime.platform, "taptap");
  assert.equal(globalThis.GameGlobal.PlatformRuntime.apiPrefix, "tap");
  assert.deepEqual(
    globalThis.GameGlobal.PlatformRuntime.getNativeWebAssemblyApis(),
    [globalThis.WXWebAssembly],
  );
  assert.equal(globalThis.GameGlobal.PlatformRuntime.capabilities.webAssembly, true);
  assert.notEqual(
    globalThis.WebAssembly,
    nativeWebAssembly,
    "TapTap installs the native WASM bridge shim for the Brotli engine file",
  );
  assert.equal(
    typeof globalThis.WebAssembly.instantiate,
    "function",
    "the installed shim keeps an instantiate entry point",
  );
  assert.equal(counters.nativeInstantiateCalls(), 0);

  // Non-TikTok hosts keep the established 1x backing store until they are
  // device-certified for the DPR split.
  assert.equal(globalThis.GameGlobal.__adapter.window.innerWidth, 360);
  assert.equal(globalThis.GameGlobal.__adapter.window.devicePixelRatio, 1);
  assert.equal(globalThis.GameGlobal.__adapter.canvas.clientWidth, 360);
  assert.equal(globalThis.GameGlobal.__adapter.canvas.width, 360);
  assert.equal(globalThis.GameGlobal.__adapter.canvas.height, 780);

  const fetchUrl = moduleUrl(
    replaceSpecifier(read("fetch.js"), "./js/platform_runtime", runtimeUrl),
  );
  await import(fetchUrl);
  assert.equal(typeof globalThis.GameGlobal.fetch, "function");

  const sdkUrl = moduleUrl(
    replaceSpecifier(read("js/libs/sdk.js"), "../platform_runtime", runtimeUrl),
  );
  const { GodotSDK } = await import(sdkUrl);
  const standaloneSdk = new GodotSDK();
  assert.equal(JSON.parse(standaloneSdk.getBridgeInfo()).platform, "taptap");

  const storage = globalThis.GameGlobal.__adapter.window.localStorage;
  const storageInfo = JSON.parse(standaloneSdk.storageGetAll());
  const batteryInfo = JSON.parse(standaloneSdk.getBatteryInfoSync());
  assert.deepEqual(storageInfo, { keys: ["save"], size: 3, limit: 10 });
  assert.equal(storage.length, 1);
  assert.equal(storage.key(0), "save");
  assert.equal(counters.storageInfoCalls(), 3);
  assert.deepEqual(batteryInfo, {});

  const [level, charging, , error] = await new Promise((resolve) => {
    standaloneSdk.getBatteryInfo((...args) => resolve(args));
  });
  assert.equal(level, 0);
  assert.equal(charging, false);
  assert.equal(error, "tap.getBatteryInfo is not supported");

  const godotStubUrl = moduleUrl("export {};");
  const imageLoaderStubUrl = moduleUrl(
    "export function waitForImage() { return Promise.resolve(); }",
  );
  let loaderSource = read("js/loader.js");
  loaderSource = replaceSpecifier(loaderSource, "./libs/godot", godotStubUrl);
  loaderSource = replaceSpecifier(loaderSource, "./libs/sdk", sdkUrl);
  loaderSource = replaceSpecifier(loaderSource, "./image_loader", imageLoaderStubUrl);
  loaderSource = replaceSpecifier(loaderSource, "./platform_runtime", runtimeUrl);
  const { default: Loader } = await import(moduleUrl(loaderSource));

  assert.equal(typeof Loader, "function");
  assert.equal(globalThis.GameGlobal.godotSdk, globalThis.godotSdk);
  assert.equal(globalThis.GameGlobal.__adapter.window.godotSdk, globalThis.godotSdk);
  assert.equal(globalThis.GameGlobal.godotMiniGameBridgeV1, globalThis.godotSdk);
  assert.equal(globalThis.GameGlobal.__adapter.window.godotMiniGameBridgeV1, globalThis.godotSdk);
  assert.equal(JSON.parse(globalThis.godotSdk.getBridgeInfo()).platform, "taptap");
}

await testTapAdapterFetchLoaderAndSdkImports();

console.log("tap_platform_smoke.test.mjs: ok");
