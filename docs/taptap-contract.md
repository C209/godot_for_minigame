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
| 渲染 | 支持 WebGL2.0（=OpenGLES3.0）；WebGL1.0（=OpenGLES2.0）；**不支持 WebGPU** | 【确认】 |
| WebAssembly | 支持（"启动阶段会进行 webassembly 编译"），wasm 为 JIT 代码 | 【确认】 |
| WebAssembly 全局对象形态 | **已实测确认（真机 dev 1.0.4，猫咪消消落）**：原生 tap 环境提供标准 `WebAssembly` 全局 + `instantiate` 可用；另注入 `WXWebAssembly` 原生桥（微信式，可作兜底）；`instantiateStreaming` 不可用（无 fetch Response，正常）。Godot 引擎 wasm 走标准 `WebAssembly.instantiate`，开箱即用，无需原生桥 | 【已确认】✅ |
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
| webAudio | `tap.createWebAudioContext()`（或 getAudioContext） | 【待验证】 |
| innerAudio | `tap.createInnerAudioContext()` | 【确认】← InnerAudioContext 文档 |
| webAssembly | 见 §1 待验证项 | 【待验证】 |

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

### 已解决（真机 dev 1.0.4 验证 ✅）
1. **WebAssembly 全局形态**：原生 tap 环境提供**标准 `WebAssembly` + `instantiate`**（Emscripten 产物开箱即用），另有 `WXWebAssembly` 原生桥兜底。Godot 无需写原生 WASM 桥。
2. **`canvas.getContext('webgl2')`**：`webgl` 与 `webgl2` 均可用（离屏 canvas 也支持）。Godot 单线程 WebGL2 引擎可上屏。
3. **真机验证通道**：走 `taptap-cli` 上传开发测试包 + 后台扫码。**VS Code 插件「TapTap MiniGame Debugger」局域网调试对裸三件套有加载 bug（下载 zip 但不执行 game.js），不可用**。

### 仍待验证
- **iOS 高性能模式内存**：Godot 引擎 + 资源在 iOS <1G 内存约束下的表现（本次为 Android 真机，iOS 未测）。
- **canvas 无系统字体**：实测 `fillText` 不显示（无字体），需 `tap.loadFont` 加载字体文件。Godot 移植须预置中文字体（与微信/抖音同限制）。

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

### 关键实现决策

- **TapTap 走标准 `WebAssembly`，不启用 `WXWebAssembly` 路径 shim**：`getNativeWebAssemblyApis()` 对 `taptap` 返回空数组。adapter 的原生 shim 会把 `instantiate(ArrayBuffer)` 改写成 `instantiate(文件路径)`，而真机探测已确认标准 `WebAssembly.instantiate(buffer)` 可用，启用 shim 反而替换掉可工作的实现。`tap_platform_smoke` 里用「注入 WXWebAssembly 后 `globalThis.WebAssembly` 不变」锁定该决策。
- **`game.json` 保持最小集**：不写 `plugins`（不需要 UnityPlugin）、不写 `workers`（TapTap 的 `workers` 是字符串目录名，本项目未使用 worker）。`parallelPreloadSubpackages` 留作后续启动优化，未默认开启。
- **分包占位文件沿用微信/抖音的零字节行为**：TapTap CLI 上传是否拒绝零字节文件尚未验证；若真机发现拒绝，把 `taptap` 加入 `zero_byte_allowed` 排除项并写注释占位即可。
- **`supportTier: beta`**：Android 真机只验证了引擎启动与 WebGL2/WASM，iOS、开放能力、DevTools/CLI 全链路仍未验收。

## 7. 后续阶段（Phase 2–4 待办）

- Phase 2：`USAGE`/`README` 中的 TapTap 导出与上传步骤（`taptap-cli` 上传开发测试包 + 后台扫码），以及可选的 `parallelPreloadSubpackages` 启动优化。
- Phase 3：按 Unity Wrapper 语义实现 TapTap 特有能力的 GDScript + JS bridge，逐项真机核对签名。
- Phase 4：官网/文档平台矩阵更新、真机回归（iOS 高性能模式内存、音频驱动分支、`canvas` 字体）。
