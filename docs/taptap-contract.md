# TapTap 平台移植契约（Phase 0 预研产出）

> 状态：Phase 1 已落地（tap provider + templates/taptap 三件套 + support-matrix/exporter/output_guard/dock 接入 + 自动测试）。
> 目标是把 `tap` 平台作为 godot_for_minigame 的第四平台接入。
> 参考项目：`C:\Work\Unity\Tools\minigame-sdk-unity`（com.taptap.minigame v2.0.21，TapTap 提供给团结引擎 Tuanjie 的 SDK）。
> 证据来源：TapTap 官方文档 developer.taptap.cn/minigameapidoc + 本地 Unity SDK 源码。
> 确定性标注：【确认】= 官方文档或源码明确；【推断】= 与微信/抖音同构的合理推断；【待验证】= 须真机/开发者工具实测。

---

## 1. 运行时环境

| 项 | 结论 | 确定性 |
|---|---|---|
| 全局对象 | `tap.*`（官方 API 命名空间），`GameGlobal`（全局变量容器，`GameGlobal.GameGlobal === GameGlobal`） | 【确认】 |
| 运行时分层 | 原生环境 `tap.*` 提供基础+特有能力；团结容器额外暴露 `tj.*`（= 微信 `wx` 100% 兼容别名，Unity SDK 的 JS 适配层 `unity-sdk/` 全走 `tj`），C# 桥 `TapSDK.jslib` 直调 `tap.*` 特有接口 | 【确认】← Unity SDK 源码 |
| DOM/BOM | 无 `window`、无 `document`、无 BOM/DOM，仅 tap 系列 API | 【确认】 |
| 画布 | `tap.createCanvas()` 唯一上屏 canvas，与屏幕等宽高 | 【确认】 |
| JS 引擎 | iOS = JavaScriptCore（WKWebView 高性能模式，对标微信）；Android = V8 | 【确认】 |
| JIT | 默认 iOS/Android 都开启 | 【确认】 |
| 多线程 | 不支持（`System.Threading` 等价能力全部不可用） | 【确认】 |
| 模块系统 | `require`（CommonJS）。`game.js` 以 classic script 执行，ESM `import` 直接 `SyntaxError: Cannot use import statement outside a module`；官方 Unity 管线在打包时用 Babel preset-env 转 CommonJS | 【已确认】← 真机 1.0.5 实测 |
| 渲染 | 支持 WebGL2.0（=OpenGLES3.0）；WebGL1.0（=OpenGLES2.0）；**不支持 WebGPU** | 【确认】 |
| WebAssembly | 支持（"启动阶段会进行 webassembly 编译"），wasm 为 JIT 代码 | 【确认】 |
| WebAssembly 全局对象形态 | 标准 `WebAssembly` 全局存在，`instantiate` 可编译**未压缩** buffer（真机 dev 1.0.4 探针）；但引擎产物是 `godot.wasm.br`，标准实现无法解 brotli，且 fetch polyfill 对 `.wasm` 请求返回空 stub。**必须使用宿主注入的 `WXWebAssembly` 原生桥按路径装载**（真机 dev 1.0.7 实测：标准路径报 `CompileError: BufferSource argument is empty`）。`instantiateStreaming` 不可用 | 【已确认】✅ |
| `canvas.getContext('webgl2')` | **已实测确认**：`canvas.getContext('webgl')` 与 `getContext('webgl2')` 均返回非 null（离屏 canvas 也支持）。Godot 单线程 WebGL2 引擎可直接上屏 | 【已确认】✅ |
| 内存 | Android 独立进程相对宽松；iOS 低档机 <1G，限制严 | 【确认】 |
| 包体 | 整包 ≤60M（压缩后）；优秀参考 20M（接入指南）/ 10M（引擎建议页，两处口径不一，取 20M 为保守） | 【确认】 |
| wasm 体积 | 建议 <10M，超了需 wasm 分包 | 【确认】 |
| 无网 | 暂不支持无网打开 | 【确认】 |

## 2. 配置文件契约

三件套：`game.js` / `game.json` / `project.config.json`（与微信/抖音同构）。

### game.json（以 Unity SDK 实际产物 `Runtime/minigame-default/game.json` 为准）

Unity SDK 的 game.json 模板（团结转换工具实际生成、可上传平台）如下，`$...` 为转换时注入的占位符：

```json
{
  "deviceOrientation": "$ORIENTATION",
  "appId": "$APP_ID",
  "companyName": "$COMPANYNAME",
  "productName": "$PRODUCTNAME",
  "productVersion": "$PRODUCTVERSION",
  "buildDescription": "$BUILDDESCRIPTION",
  "isWasmSplitSupport": "$ISWASMSPLITSUPPORT",
  "convertScriptVersion": "$CONVERTSCRIPTVERSION",
  "convertToolVersion": "$CONVERTTOOLVERSION",
  "openDataContext": "open-data",
  "iOSHighPerformance": true,
  "iOSHighPerformance+": "$ENABLE_IOSPERFORMANCEPLUS",
  "subpackages": [
    { "name": "wasmcode", "root": "wasmcode/" },
    { "name": "data-package", "root": "data-package/" }
  ],
  "parallelPreloadSubpackages": [
    { "name": "wasmcode" },
    { "name": "data-package" }
  ],
  "plugins": {
    "UnityPlugin": { "contexts": [{ "type": "isolatedContext" }] }
  },
  "workers": "workers"
}
```

关键结论（以 Unity SDK 为准）：

- **分包字段是 `subpackages`（小写）**，与微信一致，**不是驼峰 `subPackages`**。官方文档「小游戏配置」「分包加载」页写 `subPackages`，「开发小游戏」页写 `subpackages`，自相矛盾；Unity SDK 实际产物为 `subpackages`，以产物为准。
- 分包项结构：`{ "name": "别名", "root": "目录或js文件" }`；`tap.loadSubpackage({name})` 加载，返回 LoadSubpackageTask（`onProgressUpdate`）。
- `workers` 是**字符串**（目录名），不是微信的 `{path, isSubpackage}` 对象。
- `parallelPreloadSubpackages`：并行预加载分包（Unity SDK 用 wasmcode/data-package 并行下载）。
- `plugins.UnityPlugin` 是团结引擎「快适配」宿主插件（微信 minigame-unity-webgl-transform 的 UnityPlugin，需向平台申请开通）：负责 Unity IL2CPP wasm 加载/编译、AssetBundle 资源包管理、coverview 高性能渲染、Unity 引擎内存上报/快照/性能监控。Godot 方案**不需要**——它自带标准 Emscripten 引擎模板（godot.js + godot.wasm.br）+ loader/adapter/fetch 全套 JS 适配层，等价职责已自行实现，且不依赖团结容器。
- 元数据字段（appId/companyName/productName/productVersion/buildDescription/convertScriptVersion/convertToolVersion/isWasmSplitSupport）由团结转换工具注入，Godot 按需保留。
- 官方字段 `showStatusBar`/`networkTimeout` 见官方「小游戏配置」页（Unity SDK game.json 未出现，属原生 tap 环境字段，仅作参考）。

Godot 方案 game.json.template 需要的字段：`deviceOrientation`、`iOSHighPerformance`、`subpackages`（小写）、（可选）`workers`、`parallelPreloadSubpackages`。

### project.config.json（以 Unity SDK 实际产物为准）

Unity SDK 的 `Runtime/minigame-default/project.config.json` 与微信小游戏开发者工具的工程配置**几乎完全一致**：

```json
{
  "description": "项目配置文件",
  "setting": {
    "urlCheck": false, "es6": true, "enhance": true, "postcss": true,
    "minified": true, "newFeature": true, "coverView": true,
    "babelSetting": { "ignore": [], "disablePlugins": [], "outputPath": "" },
    "useIsolateContext": true, "useCompilerModule": true
  },
  "compileType": "game",
  "libVersion": "3.5.1",
  "appid": "$APP_ID",
  "projectname": "$PROJECT_NAME",
  "simulatorType": "wechat",
  "packOptions": { "ignore": [] },
  "condition": {}
}
```

关键结论：TapTap 小游戏复用微信开发者工具的工程配置格式（`compileType:"game"`、`libVersion`、`simulatorType:"wechat"` 直接沿用微信）。Godot 方案的 `templates/taptap/project.config.json.template` 可**直接复用 wechat 模板结构**，仅替换 `appid`/`projectname` 占位符。

## 3. tap.* API 清单（与现有 Provider capability 映射）

### 3.1 基础能力（对应现有 capability 检测）

| Provider capability | tap.* API | 确定性 |
|---|---|---|
| canvas | `tap.createCanvas()` | 【确认】 |
| image | `tap.createImage()` / `tap.createImageData()` | 【确认】← Cocos/Laya/Egret 适配文档 |
| request | `tap.request()` | 【确认】 |
| fileSystem | `tap.getFileSystemManager()` | 【确认】 |
| storage | `tap.setStorageSync()` / `tap.getStorageSync()`（remove/clear/getStorageInfo 同构） | 【确认】 |
| touch | `tap.onTouchStart/Move/End/Cancel()` | 【确认】 |
| windowInfo | `tap.getSystemInfoSync()` / `tap.getWindowInfo()` | 【确认】 |
| windowResize | `tap.onWindowResize()` | 【推断】 |
| subpackage | `tap.loadSubpackage()` | 【确认】 |
| updateManager | `tap.getUpdateManager()` | 【待验证】 |
| lifecycle | `tap.onShow()` / `tap.onHide()` | 【确认】← life-cycle 文档 |
| runtimeError | `tap.onError()` | 【推断】 |
| webAudio | `tap.createWebAudioContext()`（或 getAudioContext）。真机确认存在（44100），但宿主**不驱动 `onaudioprocess`**，引擎混音不可用 | 【已确认】⚠️ |
| innerAudio | `tap.createInnerAudioContext()`。真机 dev 1.0.37 确认可发声（经 `MiniGameSDK.inner_audio_*`） | 【已确认】✅ |
| webAssembly | 见 §1（走 `WXWebAssembly` 原生桥） | 【已确认】✅ |

> **非 Unity 引擎适配路径（关键证据）**：官方「Cocos/Laya/Egret 引擎适配」文档明确，非 Unity 引擎**自己构造 document 适配层**（`document.createElement` 返回 `tap.createCanvas`/`tap.createImage`/audio/video），用 `tap` API 抹平浏览器差异（touch/缓存/音频/图片/socket/request），开放能力再主动走 `tap` API。**Godot 的 `adapter.js` 正是这一性质**——等价于 Cocos/Laya/Egret 路径，不依赖 UnityPlugin，也不依赖团结容器 `tj`。Unity SDK 走 `tj.*`+UnityPlugin 是「复用微信快适配」的实现选择，非唯一途径。

### 3.2 渲染/帧率/字体

`tap.createPath2D()`、`tap.setPreferredFramesPerSecond()`、`tap.loadFont()`、`tap.createImageData()`【确认】。

### 3.3 开放能力（TapTap 特有，与微信/抖音差异最大）

准确方法名以 Unity SDK `Runtime/Plugins/TapSDK.jslib` 的 `tap.*` 调用为准：

| 能力 | tap.* 方法（TapSDK.jslib 源码确认） | Unity Wrapper（子方法语义，Phase 3 详查） |
|---|---|---|
| 分享板 | `setShareboardHidden` / `showShareboard` / `onShareMessage` / `offShareMessage` / `openFriendList` | `Wrapper/Share/*` |
| 成就 | `createAchievementManager({toastEnable})` → AchievementManager | `Wrapper/Achievement/*` |
| 排行榜 | `getLeaderboardManager()` → LeaderboardManager | `Wrapper/Leaderboard/*` |
| 云存档 | `getCloudSaveManager()` → CloudSaveManager | `Wrapper/CloudSave/*` |
| 虚拟支付 | `requestPaymentGameItem({...})` | `Wrapper/Payment/*` |
| 首页小组件 | `createHomeScreenWidget()` / `hasHomeScreenWidgetAndPinned()` | `Wrapper/HomeScreenWidget/*` |
| 对战 | `getOnlineBattleManager()` → OnlineBattleManager | `Wrapper/TapBattleClient/*` |
| 登录 | `login` / `getAccountInfoSync` / `getUserInfo` / `requirePrivacyAuthorize` | `Tap.cs` |
| 界面 | `showToast` / `showModal` / `showLoading` / `showActionSheet` | `Tap.cs` |
| 媒体 | `setInnerAudioOption` / `createVideo` / `saveImageToPhotosAlbum` | `Tap.cs` |

> 关键模式：TapTap 特有能力多为 **manager 工厂**——`createAchievementManager` / `getLeaderboardManager` / `getCloudSaveManager` / `getOnlineBattleManager` 返回 manager 对象，具体操作（submitScore/loadScores/createArchive/updateArchive/unlock 等）在 manager 上。Unity `Tap.cs` 的 `tap` 特有方法直调原生 `tap.*`（非 `tj`），基础能力（存储/文件/网络/音频/触摸/生命周期）则通过团结容器 `tj.*`（= 微信 `wx`）提供。Godot 方案统一走 `tap.*`，Phase 3 再按 manager 子方法逐个映射。

## 4. 与现有三平台的关键差异

| 差异点 | 微信 | 抖音 | TikTok | **TapTap** |
|---|---|---|---|---|
| api namespace | `wx` | `tt` | `TTMinis.game` | `tap` |
| 分包字段 | `subpackages` | `subPackages` | `subpackages` | `subpackages`（小写，同微信） |
| iOS 高性能字段 | `iOSHighPerformance(+`)` | — | — | `iOSHighPerformance` |
| 分享 | `shareAppMessage` | `shareAppMessage` | `shareAppMessage` | **分享板** `showShareboard`/`onShareMessage` |
| 成就/云存档/排行榜/对战/首页小组件 | 无 | 无 | 无 | **有**（平台特有） |
| WASM 全局 | `WXWebAssembly` | `TTWebAssembly` | `TTWebAssembly` | 标准 `WebAssembly` ✅ + `WXWebAssembly`（实测） |
| 支付 | `requestMidasPayment` | 抖币 | — | 虚拟支付 `requestPaymentGameItem`（服务端 goods-deliver-notify） |

## 5. 风险清单（Phase 0 实测后更新）

### 已解决（真机 dev 1.0.4 – 1.0.37 验证 ✅）
1. **WebAssembly 全局形态**：原生 tap 环境提供**标准 `WebAssembly` + `instantiate`**（Emscripten 产物开箱即用），另有 `WXWebAssembly` 原生桥兜底。Godot 无需写原生 WASM 桥。
2. **`canvas.getContext('webgl2')`**：`webgl` 与 `webgl2` 均可用（离屏 canvas 也支持）。Godot 单线程 WebGL2 引擎可上屏。
3. **真机验证通道**：走 `taptap-cli` 上传开发测试包 + 后台扫码。**VS Code 插件「TapTap MiniGame Debugger」局域网调试对裸三件套有加载 bug（下载 zip 但不执行 game.js），不可用**。
4. **黑屏根因 `GL_MAX_VIEWPORT_DIMS`**（真机 1.0.30 定位）：宿主对 `getParameter(GL_MAX_VIEWPORT_DIMS)` 返回 `undefined`/非数组，Godot 把它当窗口最大尺寸、`size.min(max)` 把根窗口高度钳成 0 → 视口 `0x0x16384x0`、整屏黑、输入也映射不到控件。adapter 拦截并回落到 `16384x16384` 后 `window.size=(360,800)`，画面与点击同时恢复。
5. **JS Bridge 缺失（4.7.2 eval-free 模板）**：`GodotJSWrapper`/`_godot_js_wrapper_interface_get` 在 4.7.2 r1 模板整体缺失（4.6.1 内置模板有），`MiniGameSDK.get_interface` 恒为 null、整个 SDK 不可用、`inner_audio_*` 也无法调用。**r2 模板用 `javascript_eval=yes` 重建，真机 dev 1.0.37 确认 `MiniGameSDK` 可用、`inner_audio` 发声**——这是影响全平台（含微信/抖音）的模板层修复，非 TapTap 独有。
6. **分包零字节占位**：真机 1.0.7 确认 CLI 上传接受 `engine/game.js`、`subpacks/game.js` 零字节占位。

### 仍待验证 / 已知限制
- **iOS 高性能模式内存**：Godot 引擎 + 资源在 iOS <1G 内存约束下的表现（本次为 Android 真机，iOS 未测）。
- **引擎 WebAudio 混音不可用（宿主限制）**：`tap.createWebAudioContext()` 存在、驱动可初始化（`init channels=2`/`script_create ok`/`script_start ok`、不再报 driver failed），但宿主从不回调 `onaudioprocess`（计数恒 0），引擎混音拿不到时间片。**请用 `inner_audio_*` 播预编码音频（真机 1.0.37 已确认发声）**，引擎 `AudioStreamGenerator` 视为静音。
- **canvas 无系统字体**：实测 `fillText` 不显示（无字体），需 `tap.loadFont` 加载字体文件。Godot 移植须预置中文字体（与微信/抖音同限制）。
- **DPR 仍 1x**：backing store 保持 1x（真机验证时的配置），切 host DPR 拆分需另行真机验收。
- **`updateManager` / `getUpdateManager`**：尚未真机核对。

## 6. Phase 1 实现记录

| # | 改动 | 状态 |
|---|---|---|
| 1 | `templates/common/js/platform_runtime.js`：`taptap` 归一化、`scope.tap`/`GameGlobal.tap` 探测、错误信息、`getNativeWebAssemblyApis()` 对 tap 返回空 | ✅ |
| 2 | `templates/taptap/game.js`：`requirePlatform("taptap", "TapTap entrypoint")` + 受保护的更新检查 | ✅ |
| 3 | `templates/taptap/game.json.template`：`deviceOrientation` + `iOSHighPerformance` + `subpackages`（小写）/ `engine` + `subpacks` | ✅ |
| 4 | `templates/taptap/project.config.json.template`：复用微信结构（Unity 产物 `simulatorType:"wechat"`、`libVersion:"3.5.1"`） | ✅ |
| 5 | `exporter.gd`：`SUPPORTED_PLATFORMS` + `PLATFORM_CONTRACTS["taptap"]`（`tap` / `subpackages` / 无 private config / 允许 eval） | ✅ |
| 6 | `core/output_guard.gd`：taptap 所有权清单契约（旧清单不认领） | ✅ |
| 7 | `export_dock.gd`：TapTap 平台选项 | ✅ |
| 8 | `support-matrix.json`：`platformContracts.taptap`（`supportTier: beta`）+ 每行 `platforms.taptap: automated` | ✅ |
| 9 | 自动测试：`tap_platform_smoke.test.mjs`、`entry_platform`、`platform_runtime`、`exporter_platform_contract`、`release_contract`、CI `taptap` 校验分支 | ✅ |
| 10 | `MiniGameSDK.gd` TapTap 特有 API（分享板/成就/云存档/排行榜/支付/首页小组件/对战） | ⏳ Phase 3 |
| 11 | 导出器 taptap 分支：7 个共享模块 ESM→CommonJS 转换，转换失败即中止导出 | ✅ 真机问题修复 |

### 关键实现决策

- **宿主同时暴露 `wx` 兼容别名，`tap` 必须在自动探测中优先**：真机日志显示 TapTap 启动时会 `run tj-proxy.js` / `use a new namespace: tap`，同时向全局注入 `wx` 与 `WXWebAssembly`。若按「wx 优先」探测，会被误判为微信并且错误安装 WXWebAssembly 路径 shim（真机 1.0.6 即因此报 `TapTap entrypoint requires taptap, but detected wechat`）。因此 `platform_runtime` 的自动优先级为 `tap` → `TTMinis.game` → `wx` → `tt`；显式 `GameGlobal.__platform` 仍然最优先。
- **TapTap 不支持 ES Module，导出时转 CommonJS**：真机 1.0.5（首个完整引擎包）启动即报 `SyntaxError: Cannot use import statement outside a module`——运行时把 `game.js` 当普通脚本解析。官方 Unity SDK 的 `Editor/.Babel` 会在打包时用 `@babel/preset-env` 把整包转成 CommonJS，说明 `require` 才是平台支持的模块系统。导出器对 taptap 的 7 个共享模块（`game.js` / `adapter.js` / `fetch.js` / `js/loader.js` / `js/libs/sdk.js` / `js/image_loader.js` / `js/platform_runtime.js`）做机械 ESM→CJS 转换：`import` → `require(...)`、`export default` → `module.exports.default`、具名导出 → `exports.x = x`；遇到无法识别的语法直接让导出失败，不产出坏包。`js/libs/godot.js` 本身是 UMD，保持原样（由 loader `require` 执行，尾部的 `GameGlobal.Engine` 注入仍生效）。
- **TapTap 的 WebGL2 只有 Unity 需要的子集**：真机 1.0.8/1.0.9 连续暴露 `getSyncParameter`、`uniform1ui` 缺失（宿主是自研 Chromium Webglhost）。除引擎侧给 `_glGetSynciv`/`_glFenceSync`/`_glDeleteSync` 加守卫外，adapter 还加了 `_installWebGLCompat`：只填补宿主缺失的 WebGL2 方法（setter→no-op、create*→`{}`、getter→null/0、is*→false、`checkFramebufferStatus`→36053），并一次性打印缺失清单与 `WebGL caps`（version/vao/uniform1ui/instanced/uniformBuffer）。若清单里出现 `drawArraysInstanced`/`drawElementsInstanced` 等绘制路径，需要再评估。
- **音频驱动的失败点是 `destination.channelCount`**：真机 1.0.9 日志 `scriptProcessor=function, worklet=undefined, destination.channelCount=undefined`。Godot 的 `GodotAudio.init()` 直接返回 `ctx.destination.channelCount`，undefined 会被判为无效声道数从而放弃驱动（`All audio drivers failed`）。adapter 现在用 Proxy 把 `destination.channelCount`/`maxChannelCount` 兜底为 2（不改原生对象，避免 defineProperty 失败）。
- **TapTap 的 WebGL2 上下文缺少 sync 对象方法**：真机 1.0.8 启动到 `callMain` 时报 `TypeError: GLctx.getSyncParameter is not a function`（`_glGetSynciv` 未做存在性判断）。导出器给 `_glGetSynciv` / `_glFenceSync` / `_glDeleteSync` 加了方法存在性守卫；宿主实现了这些方法时行为与上游完全一致，缺失时安全跳过。该守卫对所有平台生效，不会改变微信/抖音/TikTok 路径。
- **TapTap 必须走 `WXWebAssembly` 原生桥（不能只用标准 `WebAssembly`）**：引擎以 `godot.wasm.br` 交付，标准 `WebAssembly.instantiate` 无法解 brotli，且 `fetch.js` 对 `.wasm` 请求设计上返回空 stub（原设计假设由原生桥按路径读取）。真机 1.0.7 因此报 `CompileError: WebAssembly.instantiate(): BufferSource argument is empty`。修复：`getNativeWebAssemblyApis()` 对 taptap 返回宿主注入的 `WXWebAssembly`，adapter 安装路径式 shim 后用 `instantiate("engine/godot.wasm.br")` 装载，解压由宿主完成。真机 1.0.6 已证实该桥存在且可调用。
- **`game.json` 保持最小集**：不写 `plugins`（不需要 UnityPlugin）、不写 `workers`（TapTap 的 `workers` 是字符串目录名，本项目未使用 worker）。`parallelPreloadSubpackages` 留作后续启动优化，未默认开启。
- **分包占位文件沿用微信/抖音的零字节行为**：真机 1.0.7 确认 CLI 上传接受零字节占位（`engine/game.js`、`subpacks/game.js`），无需把 taptap 加入 `zero_byte_allowed` 排除项。
- **`supportTier: beta`**：Android 真机已验证渲染/输入/JS Bridge/InnerAudio；iOS、TapTap 开放能力（分享板/成就/云存档/排行榜/支付/小组件/对战）、`updateManager` 与 host DPR 拆分仍未验收。

## 7. 后续阶段（Phase 2–4 待办）

- Phase 2：`USAGE`/`README` 中的 TapTap 导出与上传步骤（`taptap-cli` 上传开发测试包 + 后台扫码），以及可选的 `parallelPreloadSubpackages` 启动优化。
- Phase 3：按 Unity Wrapper 语义实现 TapTap 特有能力的 GDScript + JS bridge，逐项真机核对签名。
- Phase 4：官网/文档平台矩阵更新、真机回归（iOS 高性能模式内存、音频驱动分支、`canvas` 字体）。
