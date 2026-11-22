/**
 * Godot engine loader for mini games.
 *
 * Handles: loading screen → engine subpackage → boot Godot → FS restore → auto-sync.
 */

import "./libs/godot";
import { BRIDGE_GLOBAL_NAME, GodotSDK } from "./libs/sdk";
import { waitForImage } from "./image_loader";
import { PlatformRuntime } from "./platform_runtime";

const _api = PlatformRuntime.requireCapabilities(
  ["canvas", "fileSystem", "image", "lifecycle", "subpackage", "windowInfo"],
  "engine loader",
);
const _global = PlatformRuntime.global;

const LoaderConfig = {
  logo: "images/logo.png",
  background: "images/background.png",
  iconWidth: 128,
  iconHeight: 128,
  backgroundColor: "#282c34",
  loadingBarHeight: 20,
  loadingBarColor: "#478CBF",
  loadingBarBgColor: "#444",
};

const fallbackCrypto = {
  // Compatibility fallback only. Preserve a native crypto implementation
  // whenever the host provides one.
  getRandomValues(view) {
    for (let i = 0; i < view.length; i++) view[i] = Math.floor(Math.random() * 256);
    return view;
  },
};

class FakeBlob {
  constructor(data, opts) {
    this.data = data || [];
    this.type = opts?.type || "";
    this.size = this.data.reduce((t, i) => t + (i.length || 0), 0);
  }
}

const godotSdk = new GodotSDK();
const _persistentWritebackEnabled = godotSdk.platform !== "tiktok";

function _safeSet(obj, key, value) {
  if (!obj) return false;
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && !desc.writable && !desc.configurable) return obj[key] === value;
    Object.defineProperty(obj, key, { value, configurable: true, writable: true });
  } catch (_) { /* read-only in this runtime — skip */ }
  return obj[key] === value;
}

/// Normalises whatever a host readFile() reports as "the bytes".
///
/// WeChat hands over an ArrayBuffer, TikTok a view on one, and TapTap's Node
/// shim a Buffer-like wrapper whose shape is not documented. The engine only
/// needs the raw bytes, so every plausible wrapper is unwrapped here instead of
/// failing on a host-specific class name.
function _fileBytes(data, depth = 0) {
  if (!data || depth > 3) return null;
  if (typeof data === "string") return null; // text is handled by _base64Bytes
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  // Buffer serialised as plain JSON: { type: "Buffer", data: [80, 75, ...] }.
  if (Array.isArray(data.data)) return Uint8Array.from(data.data);
  // Cross-realm ArrayBuffer: `instanceof` fails, the internal slot does not, and
  // the constructor throws or returns length 0 for anything that is not one.
  const byteLength = Number(data.byteLength);
  if (Number.isFinite(byteLength) && byteLength > 0) {
    try {
      const bytes = new Uint8Array(data);
      if (bytes.byteLength === byteLength) return bytes;
    } catch (_) { /* not an ArrayBuffer */ }
  }
  if (data.buffer) {
    const nested = _fileBytes(data.buffer, depth + 1);
    if (nested) return nested;
  }
  if (data.data) {
    const nested = _fileBytes(data.data, depth + 1);
    if (nested) return nested;
  }
  // Array-like of byte values: { length, 0: 80, 1: 75, ... }.
  const length = Number(data.length);
  if (Number.isInteger(length) && length > 0) {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      const value = data[index];
      if (typeof value !== "number") return null;
      bytes[index] = value;
    }
    return bytes;
  }
  return null;
}

/// Wraps _fileBytes with the async shapes a host may hand back instead of
/// bytes: a promise, a Blob-like with arrayBuffer(), or a text body.
async function _bytesFromRead(value, depth = 0) {
  if (!value || depth > 3) return null;
  if (typeof value.then === "function") return _bytesFromRead(await value, depth + 1);
  const direct = _fileBytes(value);
  if (direct) return direct;
  if (typeof value.arrayBuffer === "function") {
    try { return await _bytesFromRead(await value.arrayBuffer(), depth + 1); } catch (_) {}
  }
  if (typeof value.text === "function") {
    try {
      const bytes = _base64Bytes(await value.text());
      if (bytes) return bytes;
    } catch (_) {}
  }
  if (value.data) return _bytesFromRead(value.data, depth + 1);
  if (value.buffer) return _bytesFromRead(value.buffer, depth + 1);
  return null;
}

/// Reads one file through the WeChat-style options object.
function _readFileOptions(fs, filePath, extra) {
  return new Promise((resolve, reject) => {
    try {
      fs.readFile(Object.assign({
        filePath,
        success: (result) => resolve(result && result.data),
        fail: (error) => reject(
          new Error((error && error.errMsg) || `readFile 失败: ${filePath}`),
        ),
      }, extra || {}));
    } catch (error) {
      reject(error);
    }
  });
}

/// Reads one file through the Node-style `readFile(path, callback)` signature.
/// Bounded by a timeout because a host that only understands the options object
/// silently ignores the callback.
function _readFileNodeStyle(fs, filePath) {
  const read = new Promise((resolve, reject) => {
    try {
      const maybe = fs.readFile(filePath, (error, data) => {
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(data);
      });
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("readFile(path, cb) 未回调")), 4000);
    read.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function _base64Bytes(text) {
  const cleaned = String(text).replace(/[\s\r\n]+/g, "");
  if (cleaned.length < 8) return null;
  if (typeof atob !== "function") return null;
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (_) {
    return null;
  }
}

/// True when a read answered with an empty envelope (`{}`, null, or an object
/// without bytes, length or a body method) — the usual answer for a path that
/// does not exist in this host's namespace.
function _isEmptyPayload(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return false;
  if (value.byteLength || value.length) return false;
  if (typeof value.arrayBuffer === "function" || typeof value.text === "function") return false;
  try {
    for (const key in value) {
      if (key) return false;
    }
  } catch (_) { return true; }
  return true;
}

/// One-line shape description, used only when every unwrapping path failed.
/// `for...in` is lazy so a huge array never materialises its keys.
function _describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const type = typeof value;
  if (type !== "object") return type;
  const tag = Object.prototype.toString.call(value);
  const name = (value.constructor && value.constructor.name) || "?";
  let keys = "";
  let count = 0;
  try {
    for (const key in value) {
      if (count >= 6) break;
      keys += (count > 0 ? "," : "") + key;
      count += 1;
    }
  } catch (_) { /* exotic proxy */ }
  const byteLength = value.byteLength === undefined ? "-" : value.byteLength;
  const length = value.length === undefined ? "-" : value.length;
  return `${tag}/${name} keys=[${keys}] byteLength=${byteLength} length=${length}`;
}

if (!_global.crypto || typeof _global.crypto.getRandomValues !== "function") {
  _safeSet(_global, "crypto", fallbackCrypto);
}
if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
  _safeSet(globalThis, "crypto", fallbackCrypto);
}
_safeSet(_global, "Blob", FakeBlob);
const _bridgeTargets = [_global, globalThis];
if (_global.__adapter && _global.__adapter.window) {
  _bridgeTargets.push(_global.__adapter.window);
}
// A host may expose a real global `window` that the engine resolves instead of
// our adapter window (Godot reads window[name] in
// _godot_js_wrapper_interface_get). Register there too when it exists.
let _hostWindow = null;
try {
  if (typeof window !== "undefined" && window) _hostWindow = window;
} catch (_) {}
if (_hostWindow) _bridgeTargets.push(_hostWindow);
for (const target of [...new Set(_bridgeTargets)]) {
  if (!_safeSet(target, BRIDGE_GLOBAL_NAME, godotSdk)) {
    throw new Error(`[Loader] Cannot register versioned bridge ${BRIDGE_GLOBAL_NAME}`);
  }
  // Backward-compatible alias for projects that access the JavaScript object
  // directly. GDScript uses the versioned name and performs an ABI handshake.
  _safeSet(target, "godotSdk", godotSdk);
}
// Hosts differ in which global object Godot's JavaScriptBridge resolves names
// against (`_godot_js_wrapper_interface_get` reads window[name]). Report every
// registration target once so a missing bridge is diagnosable from a device log.
console.log(
  "[Loader] bridge scope: GameGlobal=" + typeof _global[BRIDGE_GLOBAL_NAME]
  + ", globalThis=" + typeof globalThis[BRIDGE_GLOBAL_NAME]
  + ", adapterWindow=" + (
    _global.__adapter && _global.__adapter.window
      ? typeof _global.__adapter.window[BRIDGE_GLOBAL_NAME]
      : "no-adapter-window"
  )
  + ", hostWindow=" + (
    _hostWindow ? typeof _hostWindow[BRIDGE_GLOBAL_NAME] : "absent"
  )
  + ", hostIsAdapterWindow=" + (
    _hostWindow && _global.__adapter
      ? String(_hostWindow === _global.__adapter.window)
      : "n/a"
  ),
);

// Use __adapter.canvas which has properly wrapped addEventListener/getContext,
// even when GameGlobal.canvas is a non-configurable native getter that we can't replace.
const _canvas = (_global.__adapter && _global.__adapter.canvas) || _global.canvas || _api.createCanvas();
const _window = (_global.__adapter && _global.__adapter.window) || _global.window || globalThis;
console.log("[Loader] canvas source:", _global.__adapter?.canvas ? "__adapter.canvas" : "GameGlobal.canvas");
console.log("[Loader] canvas.addEventListener:", typeof _canvas.addEventListener);

class Loader {
  constructor(config) {
    this.config = { ...LoaderConfig, ...config };
    const info = PlatformRuntime.getSystemInfo();
    const loadingDpr = Math.max(
      1,
      Number(info.pixelRatio ?? info.devicePixelRatio)
        || Number(_window.devicePixelRatio)
        || 1,
    );
    this.progress = 0;
    this.state = "idle";
    this.engine = null;
    this._loadPromise = null;
    this._syncTimer = null;
    this._syncPromise = null;
    this._hideSyncPending = false;
    this._hideSyncHandler = null;
    this._loadingResizeHandler = null;
    this._loadingSurfaceCleaned = false;

    this.screenCtx = _canvas.getContext("webgl2");
    this.loadingCanvas = _api.createCanvas();
    this.loadingCtx = this.loadingCanvas.getContext("2d");
    if (!this.screenCtx || !this.loadingCtx) {
      throw new Error("[Loader] WebGL2 and 2D canvas contexts are required");
    }
    this.loadingDpr = loadingDpr;
    this._syncLoadingSurfaceSize();
    // The adapter owns the main canvas backing size. Do not rewrite it after
    // creating WebGL: collapsing it to logical pixels would discard the real
    // DPR and make Godot's entire framebuffer blurry on high-DPI devices.
    this.bgImage = _api.createImage();
    this.bgImage.src = this.config.background;
    this.logoImage = _api.createImage();
    this.logoImage.src = this.config.logo;

    const [tex, clean] = this._initWebgl();
    this.screenTexture = tex;
    this.cleanWebgl = clean;
    if (typeof _window.addEventListener === "function") {
      this._loadingResizeHandler = () => {
        if (!this._loadingSurfaceCleaned && this.state !== "disposed") {
          this._drawLoading();
        }
      };
      _window.addEventListener("resize", this._loadingResizeHandler);
    }
  }

  async loadSubpackages() {
    console.log("[Loader] await loadSubpackage('engine')...");
    await new Promise((resolve, reject) => {
      _api.loadSubpackage({ name: "engine", success: resolve, fail: reject });
    });
    console.log("[Loader] await loadSubpackage('engine') done");
    this._step();
  }

  _step() {
    if (this._loadingSurfaceCleaned || this.state === "disposed") return;
    this.progress = Math.min(this.progress + 1, 3);
    this._drawLoading();
  }

  _syncLoadingSurfaceSize() {
    const width = Math.max(1, Number(_window.innerWidth) || 1);
    const height = Math.max(1, Number(_window.innerHeight) || 1);
    const pixelWidth = Math.max(1, Math.round(width * this.loadingDpr));
    const pixelHeight = Math.max(1, Math.round(height * this.loadingDpr));
    if (this.loadingCanvas.width !== pixelWidth || this.loadingCanvas.height !== pixelHeight) {
      this.loadingCanvas.width = pixelWidth;
      this.loadingCanvas.height = pixelHeight;
      if (typeof this.loadingCtx.setTransform === "function") {
        this.loadingCtx.setTransform(this.loadingDpr, 0, 0, this.loadingDpr, 0, 0);
      } else {
        this.loadingCtx.scale(this.loadingDpr, this.loadingDpr);
      }
    }
    return { width, height };
  }

  _drawLoading() {
    if (this._loadingSurfaceCleaned || this.state === "disposed") return;
    const ctx = this.loadingCtx;
    const size = this._syncLoadingSurfaceSize();
    const w = size.width, h = size.height;

    ctx.fillStyle = this.config.backgroundColor;
    ctx.fillRect(0, 0, w, h);
    if (this.bgImage.complete) ctx.drawImage(this.bgImage, 0, 0, w, h);
    if (this.logoImage.complete) {
      const iw = this.config.iconWidth, ih = this.config.iconHeight;
      ctx.drawImage(this.logoImage, (w - iw) / 2, h / 3 - ih / 3, iw, ih);
    }

    const barW = w - 48, barX = (w - barW) / 2, barY = h - this.config.loadingBarHeight / 2 - 100;
    const pct = this.progress / 3;
    ctx.fillStyle = this.config.loadingBarBgColor;
    ctx.fillRect(barX, barY, barW, this.config.loadingBarHeight);
    ctx.fillStyle = this.config.loadingBarColor;
    ctx.fillRect(barX, barY, pct * barW, this.config.loadingBarHeight);
    ctx.font = "16px sans-serif"; ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(`${(pct * 100).toFixed(1)}%`, w / 2, barY + this.config.loadingBarHeight - 4);

    this._blit();
  }

  _initWebgl() {
    const gl = this.screenCtx;
    const vsSrc = `attribute vec4 a_position; attribute vec2 a_texCoord; varying vec2 v_texCoord;
      void main() { gl_Position = a_position; v_texCoord = a_texCoord; }`;
    const fsSrc = `precision mediump float; varying vec2 v_texCoord; uniform sampler2D u_texture;
      void main() { gl_FragColor = texture2D(u_texture, v_texCoord); }`;
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);

    const verts = new Float32Array([-1,1,0,0, -1,-1,0,1, 1,-1,1,1, -1,1,0,0, 1,-1,1,1, 1,1,1,0]);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const posL = gl.getAttribLocation(prog, "a_position");
    const texL = gl.getAttribLocation(prog, "a_texCoord");
    if (posL < 0 || texL < 0) throw new Error("[Loader] loading shader attributes are unavailable");
    gl.vertexAttribPointer(posL, 2, gl.FLOAT, false, 16, 0); gl.enableVertexAttribArray(posL);
    gl.vertexAttribPointer(texL, 2, gl.FLOAT, false, 16, 8); gl.enableVertexAttribArray(texL);

    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // The viewport belongs to the destination framebuffer. Read its actual
    // size instead of assuming that either canvas has a particular DPR.
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);

    const clean = () => {
      gl.disableVertexAttribArray(posL);
      if (texL !== posL) gl.disableVertexAttribArray(texL);
      gl.bindBuffer(gl.ARRAY_BUFFER, null); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(null);
      gl.deleteBuffer(buf); gl.deleteTexture(tex);
      gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog);
    };
    return [tex, clean];
  }

  _blit() {
    const gl = this.screenCtx;
    // The host may resize the visible canvas while subpackages are loading.
    // Always bind the blit to the current destination size.
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindTexture(gl.TEXTURE_2D, this.screenTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.loadingCanvas);
    gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  load() {
    if (this.state === "disposed") {
      return Promise.reject(new Error("[Loader] Cannot load after dispose()"));
    }
    if (!this._loadPromise) {
      this.state = "loading";
      this._loadPromise = this._loadOnce();
    }
    return this._loadPromise;
  }

  async _loadOnce() {
    try {
      console.log("[Loader] ▶ 开始加载流程");

      console.log("[Loader] 1/6 加载图片资源...");
      await Promise.all([waitForImage(this.bgImage), waitForImage(this.logoImage)]);
      this._assertNotDisposed();

      console.log("[Loader] 2/6 图片加载完成，开始加载引擎子包...");
      this._step();
      await this.loadSubpackages();
      this._assertNotDisposed();

      console.log("[Loader] 3/6 子包加载完成，初始化引擎...");
      this._step();
      const _Engine = _global.Engine || globalThis.Engine || null;
      console.log("[Loader]     Engine 类:", _Engine ? "已找到" : "未找到!");
      if (!_Engine) throw new Error("Engine not found – godot.js may not have loaded correctly");
      const engine = new _Engine();
      _global.engine = engine;
      this.engine = engine;
      godotSdk.set_engine(engine);

      const executable = "engine/godot";
      const mainPack = "engine/godot.zip";
      const persistentPaths = ["/userfs"];
      const engineConfig = {
        canvas: _canvas,
        executable,
        mainPack,
        args: [],
        // This template is built without IDBFS. Passing the Web default
        // ['/userfs'] into Engine.init() attempts to mount a missing backend.
        persistentPaths: [],
      };
      if (PlatformRuntime.platform === "taptap") {
        // TapTap's canvas is already the on-screen surface sized by the adapter.
        // With the default policy 2 Godot recomputes the canvas from
        // window.innerWidth/Height before the size is published, and the root
        // Window freezes at zero height (black frame, dead input). Policy 0
        // treats the canvas size as authoritative instead.
        engineConfig.canvasResizePolicy = 0;
      }
      if (!engine.config || typeof engine.config.update !== "function"
          || typeof engine.init !== "function"
          || (typeof engine.copyToFS !== "function"
            && typeof engine.preloadFile !== "function")
          || typeof engine.start !== "function") {
        throw new Error("Engine does not expose the staged init/copy/start API required for persistent restore");
      }
      engine.config.update(engineConfig);
      console.log(
        "[Loader] engine config: canvas=" + _canvas.width + "x" + _canvas.height
        + ", resizePolicy=" + (engineConfig.canvasResizePolicy === undefined
          ? "default" : engineConfig.canvasResizePolicy),
      );
      const configuredArgs = Array.isArray(engine.config.args) ? engine.config.args.slice() : [];
      if (PlatformRuntime.platform === "taptap") {
        // The root Window is created from the startup resolution. Publish the
        // adapter viewport explicitly instead of relying on host defaults.
        configuredArgs.push("--resolution", `${_canvas.width}x${_canvas.height}`);
      }
      engine.config.args = ["--main-pack", mainPack, ...configuredArgs];

      console.log("[Loader] 4/7 初始化引擎并预加载主包...");
      await engine.init(executable);
      this._assertNotDisposed();
      await this._stageMainPack(engine, mainPack);
      this._assertNotDisposed();

      console.log("[Loader] 5/7 从宿主持久目录恢复 /userfs...");
      const restored = await godotSdk.restorePersistentPaths(persistentPaths);
      console.log(`[Loader]     已恢复 ${restored.entries || 0} 个持久文件系统条目`);
      this._assertNotDisposed();

      console.log("[Loader] 6/7 启动 Godot...");
      console.log("[Loader]     canvas:", _canvas ? `${_canvas.width}x${_canvas.height}` : "null");
      const ctx = _canvas.getContext("webgl2");
      console.log("[Loader]     WebGL2 context:", ctx ? "OK" : "FAILED (null)");
      if (ctx) {
        console.log("[Loader]     GL_RENDERER:", ctx.getParameter?.(ctx.RENDERER));
        console.log("[Loader]     GL_VERSION:", ctx.getParameter?.(ctx.VERSION));
      }

      // Engine.start() copies preloaded files and immediately invokes callMain.
      // Release the loading renderer before callMain lets Godot take ownership
      // of this same cached WebGL context. Cleaning it afterwards can invalidate
      // state that Godot has already cached for its first frame.
      this._cleanupLoadingSurface();
      // Restoring above therefore guarantees user:// is ready before GDScript.
      await engine.start();
      this._assertNotDisposed();
      // Godot resolves start() even when its setup aborts (missing pack, failed
      // FS mount): the runtime exit callback clears rtenv first. Reporting
      // "loaded" for a dead engine leaves the player on a black screen with no
      // clue, so surface it as the startup failure it is.
      if (!engine.rtenv) {
        throw new Error(
          "[Loader] 引擎启动后立即退出：主包未挂载或引擎初始化失败（见上方 Godot 错误）",
        );
      }

      console.log("[Loader] 7/7 engine.start() 完成，设置文件同步...");
      if (_persistentWritebackEnabled) {
        this._syncTimer = _window.setInterval(() => {
          if (!this.engine || !this.engine.rtenv) {
            // The runtime is gone; stop snapshotting instead of repeating the
            // same rejection every interval.
            if (this._syncTimer !== null) {
              _window.clearInterval(this._syncTimer);
              this._syncTimer = null;
            }
            return;
          }
          this._flushPersistentFiles("interval");
        }, 5000);
        this._hideSyncHandler = () => { this._flushPersistentFiles("hide"); };
        _api.onHide(this._hideSyncHandler);
      } else {
        console.log("[Loader]     TikTok Native persistent writeback disabled; read-only restore remains enabled");
      }
      this.state = "running";
      console.log("[Loader] ✓ 加载完成，游戏已启动");
      return engine;
    } catch (err) {
      if (this.state !== "disposed") this.state = "failed";
      this._cleanupLoadingSurface();
      console.error("[Loader] ✗ 加载失败:", err);
      if (err && err.stack) console.error("[Loader] Stack:", err.stack);
      throw err;
    }
  }

  _assertNotDisposed() {
    if (this.state === "disposed") throw new Error("[Loader] Load was disposed");
  }

  /// Stage the main pack into the engine's virtual file system.
  ///
  /// The stock path is Engine.preloadFile() -> preloader queue -> FS write
  /// inside Engine.start(). That indirection re-wraps the response body in a new
  /// Response/ReadableStream and only then copies it, so a host whose Response
  /// or stream semantics differ can leave the queue empty without any error
  /// here; Godot then aborts with "Couldn't load project data at path /" and the
  /// real cause is invisible. Reading the pack through the same host FS call the
  /// persistent restore uses, then writing it through the engine's own bridge,
  /// keeps both the byte count and the failure point in the log.
  async _stageMainPack(engine, mainPack) {
    const bytes = await this._readMainPack(mainPack);
    const magic = Array.from(bytes.subarray(0, 4))
      .map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    console.log(`[Loader]     主包 ${mainPack}: ${bytes.byteLength} bytes, magic=${magic}`);
    if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      throw new Error(
        `[Loader] 主包内容不是 ZIP: ${bytes.byteLength} bytes, magic=${magic}`,
      );
    }
    if (typeof engine.copyToFS === "function") {
      engine.copyToFS(mainPack, bytes);
      console.log("[Loader]     主包已写入引擎虚拟文件系统");
      return;
    }
    // Wrappers without copyToFS fall back to the preload queue. The bytes are
    // already in memory, so hand them over instead of a path.
    await engine.preloadFile(bytes, mainPack);
  }

  /// Reads the pack from the host FS.
  ///
  /// Confirmed shapes: WeChat returns an ArrayBuffer, TikTok a view. TapTap's
  /// FileSystemManager delegates to a Node-shaped shim, so the payload is not a
  /// documented class and the path may need a leading slash. Every candidate
  /// path is tried with every call style, and a failure reports the shape each
  /// call actually produced instead of guessing.
  async _readMainPack(mainPack) {
    const fs = _api.getFileSystemManager();
    if (!fs || typeof fs.readFile !== "function") {
      throw new Error("[Loader] 主包读取失败: 宿主缺少 FileSystemManager.readFile");
    }
    const candidates = [mainPack, `/${mainPack}`];
    const rejected = [];
    for (const candidate of candidates) {
      const info = {};
      const bytes = await this._readPackFrom(fs, candidate, rejected, info);
      if (bytes) {
        // Which call style and path actually worked: the host differences are
        // documented in docs/taptap-contract.md, and this line keeps the answer
        // visible on every device run.
        console.log(`[Loader]     主包读取方式: ${info.via} (${info.path})`);
        return bytes;
      }
    }
    throw new Error(`[Loader] 主包读取失败: 无法识别宿主返回的数据 (${rejected.join(" | ")})`);
  }

  async _readPackFrom(fs, packPath, rejected, info) {
    // 1. WeChat-style options object.
    try {
      const raw = await _readFileOptions(fs, packPath);
      const bytes = await _bytesFromRead(raw);
      if (bytes) { info.via = "options"; info.path = packPath; return bytes; }
      rejected.push(`${packPath} binary: ${_describeValue(raw)}`);
      // An empty envelope means the path resolved to nothing useful; the other
      // call styles would only repeat the same answer.
      if (_isEmptyPayload(raw)) return null;
    } catch (error) {
      rejected.push(`${packPath} binary: ${error && error.message}`);
    }

    // 2. Ask for base64. A string survives every fs implementation and decodes
    //    through the atob every host (or web_compat) provides.
    try {
      const text = await _readFileOptions(fs, packPath, { encoding: "base64" });
      if (typeof text === "string") {
        const bytes = _base64Bytes(text);
        if (bytes) { info.via = "base64"; info.path = packPath; return bytes; }
      }
      rejected.push(`${packPath} base64: ${_describeValue(text)}`);
    } catch (error) {
      rejected.push(`${packPath} base64: ${error && error.message}`);
    }

    // 3. Node-style host fs.
    try {
      const raw = await _readFileNodeStyle(fs, packPath);
      const bytes = await _bytesFromRead(raw);
      if (bytes) { info.via = "node"; info.path = packPath; return bytes; }
      rejected.push(`${packPath} node: ${_describeValue(raw)}`);
    } catch (error) {
      rejected.push(`${packPath} node: ${error && error.message}`);
    }

    // 4. Synchronous Node-style read, the remaining call that can hand back a
    //    plain Buffer on a Node-shaped host.
    if (typeof fs.readFileSync === "function") {
      try {
        const raw = fs.readFileSync(packPath);
        const bytes = await _bytesFromRead(raw);
        if (bytes) { info.via = "readFileSync"; info.path = packPath; return bytes; }
        rejected.push(`${packPath} readFileSync: ${_describeValue(raw)}`);
      } catch (error) {
        rejected.push(`${packPath} readFileSync: ${error && error.message}`);
      }
    }
    return null;
  }

  _flushPersistentFiles(reason) {
    if (this._syncPromise) {
      // A hide event may arrive after the current snapshot was captured. Keep
      // one pending follow-up so the returned promise includes the latest save.
      if (reason === "hide") this._hideSyncPending = true;
      return this._syncPromise;
    }
    const flush = async () => {
      let result = false;
      let currentReason = reason;
      do {
        this._hideSyncPending = false;
        try { result = await godotSdk.syncfs(); }
        catch (error) { console.error(`[sync:${currentReason}]`, error); result = false; }
        currentReason = "hide";
      } while (this._hideSyncPending && this.state !== "disposed");
      return result;
    };
    const operation = flush();
    this._syncPromise = operation.then((result) => {
      this._syncPromise = null;
      return result;
    }, (error) => {
      this._syncPromise = null;
      throw error;
    });
    return this._syncPromise;
  }

  _cleanupLoadingSurface() {
    if (this._loadingSurfaceCleaned) return;
    this._loadingSurfaceCleaned = true;
    if (this._loadingResizeHandler !== null && typeof _window.removeEventListener === "function") {
      try { _window.removeEventListener("resize", this._loadingResizeHandler); } catch (_) {}
    }
    this._loadingResizeHandler = null;
    try { this.cleanWebgl(); } catch (_) {}
    // clearRect only clears pixels; it keeps the high-DPR backing store alive.
    // Release the loading-only surface without resizing Godot's main canvas.
    if (this.loadingCanvas && this.loadingCanvas !== _canvas) {
      try { this.loadingCanvas.width = 1; this.loadingCanvas.height = 1; } catch (_) {}
    }
    this.loadingCanvas = null;
    this.loadingCtx = null;
    this.bgImage = null;
    this.logoImage = null;
    this.screenTexture = null;
    this.screenCtx = null;
    this.cleanWebgl = null;
  }

  dispose() {
    if (this.state === "disposed") return;
    if (this._syncTimer !== null) {
      _window.clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this._hideSyncHandler !== null && typeof _api.offHide === "function") {
      try { _api.offHide(this._hideSyncHandler); } catch (_) {}
    }
    this._hideSyncHandler = null;
    if (this.engine && typeof this.engine.requestQuit === "function") {
      try { this.engine.requestQuit(); } catch (_) {}
    }
    if (_global.engine === this.engine) _safeSet(_global, "engine", null);
    this._cleanupLoadingSurface();
    this.state = "disposed";
  }
}

export default Loader;
