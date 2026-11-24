# TapTap 开放能力规格核对表（Phase 3）

> 用途：Phase 3 每实现一组 TapTap 特有能力，就在这里固化「官方签名 + 产物佐证 + 本仓库映射 + 真机判据」。
> 第一事实源：`C:\Work\Unity\Tools\minigame-sdk-unity`（com.taptap.minigame v2.0.21）的 `Runtime/Plugins/TapSDK.jslib` 与 `Runtime/Scripts/Wrapper/*`。
> 交叉源：TapTap 官方接入指引（`get_share_integration_guide`，BFF/开发者中心口径）。
> 标注：【产物】= Unity 产物里的真实调用；【官方】= 官方指引明确；【待验证】= 须真机确认。

## 进度

| 组 | 方法数 | 状态 |
|---|---|---|
| 分享板 Shareboard | 5 | 已实现，待真机（需先有已过审模板） |
| 成就 Achievement | 7 | 已实现，自动化测试通过；真机待实际玩法触发 |
| 排行榜 Leaderboard | 5 | 已实现，自动化测试通过；真机待实际玩法触发 |
| 云存档 CloudSave | 6 | 已实现，自动化测试通过；真机待实际玩法触发 |
| 道具直购 Payment | 1 | 已实现；需业务服务端签发参数，真机待接入 |
| 桌面小组件 HomeWidget | 2 | 已实现，自动化测试通过；真机待接入 |
| 对战 Battle | 4 | 已实现（通用分发），未验证；平台可能需开通 |
| 广告 Ads | 3（沿用通用实现） | **平台未开通**；见 §8 |

---

## 1. 分享板（Shareboard）

### 1.1 平台侧签名

| 方法 | 入参 | 回调语义 | 确定性 |
|---|---|---|---|
| `tap.showShareboard(options)` | `{ templateId, sceneParam?, success, fail, complete }`，`templateId` 必传 | **只表示分享面板被拉起**，不是分享成功；真正结果走 `onShareMessage` | 【官方】【产物】 |
| `tap.setShareboardHidden(options)` | `{ hidden: boolean, success, fail, complete }` | 只控制**用户菜单里的分享入口**，不影响 API 主动拉起的面板 | 【官方】【产物】 |
| `tap.onShareMessage(options)` | `{ success, fail, complete }` —— **对象**，不是函数 | `success(res)` 带回 `{ channel }`；`fail(res)` 带回 `{ errMsg }` | 【官方】【产物】 |
| `tap.offShareMessage()` | 无参 | 取消上面的监听 | 【官方】【产物】 |
| `tap.openFriendList()` | 无参，无回调 | 打开好友列表 | 【产物】；官方分享指引未列，真机确认 |

> 关键坑：`onShareMessage` 的入参是回调**对象**。Unity 的 `_Tap_ContactCommonCallback(null, id)` 就是构造 `{success, fail, complete}` 再传进去；如果按「传一个函数」的直觉写，宿主不会报错但永远不回调。

### 1.2 模板与参数

- `templateId` 对应开发者中心的 `template_code`，**必须审核通过（status = 1）**才能使用；未通过时 `showShareboard` 会 fail。
- 模板通过 MCP 工具 `create_share_template` / `list_share_templates` / `get_share_template_info` 管理，修改删除只能去开发者中心。
- `sceneParam` 可选，字符串；推荐 `JSON.stringify({...})` 携带关卡/分数等，卡片回流后从启动参数读取。
- 回流读取：`tap.getLaunchOptionsSync().query.sceneParam`（冷启动）、`tap.onShow(res).query.sceneParam`（热启动）、`tap.getEnterOptionsSync()`（通用）。**1.7.0+ 才支持**。
- 本仓库现状：冷启动走 `MiniGameSDK.get_launch_options()`（内部 `getLaunchOptionsSync`）；热启动走 `app_shown(options_json)` 信号——`onShow` 的 `res` 被原样透传，从 `query.sceneParam` 取即可。唯一没封的是 `getEnterOptionsSync`（统一冷/热两路的便捷版本）。

### 1.3 本仓库映射

| GDScript | sdk.js（桥接名） | 平台调用 | 信号 |
|---|---|---|---|
| `taptap_show_shareboard(template_id, scene_param)` | `tapShowShareboard` | `showShareboard` | `tap_shareboard_result("showShareboard", ok, data, err)` |
| `taptap_set_shareboard_hidden(hidden)` | `tapSetShareboardHidden` | `setShareboardHidden` | `tap_shareboard_result("setShareboardHidden", …)` |
| `taptap_open_friend_list()` | `tapOpenFriendList` | `openFriendList` | `tap_shareboard_result("openFriendList", …)` |
| `taptap_on_share_message()` | `tapOnShareMessage` | `onShareMessage` | `tap_share_message(channel, err_msg, data_json)` |
| `taptap_off_share_message()` | `tapOffShareMessage` | `offShareMessage` | —（无回调） |

约定：

- 非 TapTap 宿主调用时**不静默**：`tap_shareboard_result` 回 `success=false`，错误串为 `<action> is only supported on TapTap`；`tap_share_message` 回 `err_msg` 说明原因。
- 宿主缺少对应方法时回 `tap.<method> is not supported`，而不是伪造成功。
- `taptap_on_share_message()` 用持久回调注册（`_track_persistent`），可重复调用不会泄漏；`taptap_off_share_message()` 后 JS 侧清空句柄。

### 1.4 真机验收判据

下一轮真机包（dev 1.0.46 起）按此采集：

| 判据 | 期望 |
|---|---|
| `[Probe]` 后调用 `taptap_show_shareboard("<已过审模板>")` | `tap_shareboard_result: showShareboard ok=true`，屏幕上出现分享面板 |
| 传入不存在的模板 ID | `ok=false`，错误串包含宿主 errMsg，不崩溃 |
| 调用 `taptap_set_shareboard_hidden(true)` 后看右上角菜单 | 分享入口消失；`ok=true` |
| `taptap_on_share_message()` 后实际分享一次 | `tap_share_message` 收到 `channel`，且**只触发一次**（success/fail 不重复） |
| `taptap_off_share_message()` 后再分享 | 不再有 `tap_share_message` |
| `taptap_open_friend_list()` | `ok=true` 且好友列表出现；若宿主无此方法，错误串为 `tap.openFriendList is not supported` |
| 非 iOS/Android 的桌面预览 | 所有调用回 `only supported on TapTap`，无异常 |

验收通过后把 `support-matrix.json` 的 `android.shareboard` / `ios.shareboard` 由 `pending` 改为 `verified`。

---

## 2. 成就（Achievement）

### 2.1 平台签名

| 方法 | 入参 | 回调 | 确定性 |
|---|---|---|---|
| `tap.createAchievementManager(options)` | `{ toastEnable?: boolean }` | 无，返回 manager | 【产物】 |
| `manager.toastEnable` | 布尔属性，可直接赋值 | — | 【产物】 |
| `manager.unlockAchievement(options)` | `{ achievementId }` | **无回调** | 【产物】 |
| `manager.incrementAchievement(options)` | `{ achievementId, steps }` | **无回调** | 【产物】 |
| `manager.showAchievements()` | 无参 | 无 | 【产物】 |
| `manager.registerListener(listener)` | `{ onAchievementSuccess(code, result), onAchievementFailure(id, code, msg) }` | 两个事件 | 【产物】 |
| `manager.unregisterListener()` | 无参 | 无 | 【产物】 |

### 2.2 本仓库映射

`taptap_achievement_create(toast_enable)` / `_set_toast_enabled` / `_unlock` / `_increment` / `_show_all` / `_listen` / `_stop_listening` → `tap_achievement_result(operation, success, data_json, error)`，监听事件走 `tap_achievement_unlocked(code, result_json)` 与 `tap_achievement_failed(achievement_id, code, message)`。

### 2.3 注意

- `unlock` / `increment` 在平台上没有回调，所以 `tap_achievement_result` 的成功**只代表已派发**，真实结果只从监听事件来。
- 监听器只需注册一次；重复 `taptap_achievement_listen()` 复用同一个持久回调。

---

## 3. 排行榜（Leaderboard）

### 3.1 平台签名

| 方法 | 入参 | 确定性 |
|---|---|---|
| `tap.getLeaderboardManager()` | 无，返回 manager | 【产物】 |
| `manager.openLeaderboard(params)` | `{ leaderboardId, collection }` | 【产物】 |
| `manager.submitScores(params)` | `{ scores: [{ leaderboardId, score }] }` | 【产物】 |
| `manager.loadLeaderboardScores(params)` | `{ leaderboardId, collection, nextPage? }` | 【产物】 |
| `manager.loadCurrentPlayerLeaderboardScore(params)` | `{ leaderboardId, collection, periodToken? }` | 【产物】 |
| `manager.loadPlayerCenteredScores(params)` | `{ leaderboardId, collection, maxCount?, periodToken? }` | 【产物】 |

**关键差异**：排行榜把回调嵌在 `params.callback = { onSuccess, onFailure(code, message) }`，不是顶层 `success/fail`。`collection` 例：`public` 总榜、`friends` 好友榜。

### 3.2 本仓库映射

`taptap_leaderboard_open` / `_submit_scores` / `_load_scores` / `_load_current_player_score` / `_load_player_centered_scores`，统一回 `tap_leaderboard_result(operation, success, data_json, error)`；`params` 原样透传。

---

## 4. 云存档（CloudSave）

### 4.1 平台签名

| 方法 | 入参 | 成功返回 | 确定性 |
|---|---|---|---|
| `tap.getCloudSaveManager()` | 无 | manager | 【产物】 |
| `manager.createArchive(options)` | `{ archiveMetaData: { name, summary, extra, playtime }, archiveFilePath, archiveCoverPath? }` | `{ uuid, fileId }` | 【产物】 |
| `manager.updateArchive(options)` | 同上 + `archiveUUID` | `{ uuid, fileId }` | 【产物】 |
| `manager.getArchiveList(options)` | `{}` | `{ saves: [{ uuid, fileId, name, summary, saveSize, createdTime, modifiedTime, extra }] }`（时间戳为秒） | 【产物】 |
| `manager.getArchiveData(options)` | `{ archiveUUID, archiveFileId, targetFilePath? }` | `{ filePath }` | 【产物】 |
| `manager.getArchiveCover(options)` | 同上 | `{ filePath }` | 【产物】 |
| `manager.deleteArchive(options)` | `{ archiveUUID }` | `{ uuid }` | 【产物】 |

**关键差异**：云存档的失败回调是 `fail(errMsg, errno)` **两个位置参数**，不是对象；本仓库已按此解包成 `code=… errMsg`。

限制（Unity 注释）：单个存档文件 ≤10MB，封面 ≤512KB。

### 4.2 本仓库映射

`taptap_cloudsave_create_archive(params)` / `_update_archive` / `_get_archive_list()` / `_get_archive_data(uuid, file_id?, target_path?)` / `_get_archive_cover(…)` / `_delete_archive(uuid)` → `tap_cloudsave_result(operation, success, data_json, error)`。

---

## 5. 道具直购（Payment）

| 方法 | 入参 | 确定性 |
|---|---|---|
| `tap.requestPaymentGameItem(options)` | `{ signData, paySig, signature, success, fail, complete }` | 【产物】 |

- 三个签名字段**全部由业务服务端下发**，客户端拼不出来；缺 `signData` 时本仓库在本地就拒绝，不会打到宿主。
- success/fail 回 `{ errCode, errMsg }`；**发货必须在服务端的 goods-deliver notify 里完成**，客户端成功只代表支付动作走完。
- 本仓库：`taptap_request_payment_game_item(params)` → `tap_payment_result(success, err_code, err_msg, data_json)`。

---

## 6. 桌面小组件（HomeScreenWidget）

| 方法 | 入参 | 确定性 |
|---|---|---|
| `tap.createHomeScreenWidget(options)` | `{ success, fail, complete }` | 【产物】 |
| `tap.hasHomeScreenWidgetAndPinned(options)` | 同上 | 【产物】 |

本仓库：`taptap_create_home_screen_widget()` / `taptap_has_home_screen_widget_and_pinned()` → `tap_widget_result(operation, success, data_json, error)`。

---

## 7. 对战（OnlineBattle）

### 7.1 平台签名

`tap.getOnlineBattleManager()` 返回 manager，方法分四类：

| 类别 | 方法 |
|---|---|
| 生命周期 | `initialize` / `connect` / `disconnect` / `finalize` / `destroy` |
| 房间 | `createRoom` / `matchRoom` / `joinRoom` / `getRoomList` / `leaveRoom` / `kickRoomPlayer` |
| 玩家与房间属性 | `updatePlayerCustomStatus` / `updatePlayerCustomProperties` / `updateRoomProperties` |
| 帧同步与消息 | `startFrameSync` / `sendFrameInput` / `stopFrameSync` / `sendCustomMessage` |
| 监听 | `registerListener(listener)` / `unregisterListener(listener)` |

13 个事件：`onDisconnected`、`onBattleServiceError`、`onRoomPropertiesChanged`、`onPlayerCustomPropertiesChanged`、`onPlayerCustomStatusChanged`、`onFrameSyncStopped`、`onFrameReceived`、`onFrameSyncStarted`、`onPlayerOffline`、`onPlayerLeft`、`onPlayerEntered`、`onCustomMessageReceived`、`onPlayerKicked`。

### 7.2 本仓库映射

对战方法的 option 形状逐个不同（例如 `sendFrameInput` 要 `{ data: "<字符串>" }`，`updatePlayerCustomProperties` 要 `{ properties: "<字符串>" }`），因此用**通用分发**而不是 25 个 typed 方法：

- `taptap_battle_create_manager()` → `tap_battle_result("createManager", …)`
- `taptap_battle_call(operation, params)` → `tap_battle_result(operation, …)`；`finalize` / `destroy` 无参数无回调，立即回成功
- `taptap_battle_listen()` → `tap_battle_event(event_name, data_json)`（13 个事件合并到一条信号）
- `taptap_battle_stop_listening()`

### 7.3 未验证项

- 平台是否要求开通/白名单未知；
- `connect` 返回的 `playerId` 是后续房间与帧同步的前提，必须先拿到；
- 帧同步的确定性 RNG（Unity 里的 `newRandomNumberGenerator` / `randomInt`）**未封装**——Godot 侧应使用自己的 `RandomNumberGenerator`，只有需要与其它端逐帧一致时才需要平台 RNG。

---

## 8. 广告（平台未开通，尚未接入）

**结论：TapTap 小游戏有广告变现，是平台一级能力，不是"没有广告"。** Phase 0 只对照了 Unity 产物，而 Unity 走的是微信兼容路径，所以当时漏了这条。

| 事实 | 来源 |
|---|---|
| 以激励视频为核心，插屏 / Banner 为可选 | 官方广告接入工作流（MCP `get_ads_integration_workflow`） |
| 必须先开通广告变现：0 = 未开通，1 = 已生效，2 = 已封禁 | `check_ads_status` |
| 猫咪消消落（app 1063959）当前 **status = 0 未开通**；开通入口 `https://developer.taptap.cn/forge/425398/app/1063959/operation/ad-monetization` | 2026-11-24 实测 |
| 广告位按横竖屏各一个（type 1 横 / 2 竖），`space_id` 由服务端下发，**不得手填、不得跨应用复用** | 同上 |
| 接入代码必须等 status = 1 后由 `get_ad_integration_guide` 生成 | 同上 |
| Unity 产物只有 `tj.createRewardedVideoAd`（微信兼容别名），**没有 native `tap` 广告封装**，不能作为第一事实源 | `Runtime/minigame-default/unity-sdk/ad.js:80` |

本仓库现状：`create_rewarded_ad` / `create_banner_ad` / `create_interstitial_ad` 三个通用方法存在，走 `_api.createRewardedVideoAd` 等微信同名 API；TapTap 上宿主没有同名函数时返回 `createRewardedVideoAd not supported`（优雅失败，不崩）。

开通后再确认（**禁止按微信经验假设**）：

- 参数名是 `adUnitId` 还是 `spaceId`；
- 奖励判定是 `onClose(res.isEnded)` 还是工作流提到的 `onReward()`；
- 横竖屏两个广告位如何按 `game.json` 的 `deviceOrientation` 选择；
- 是否需要在 `game.json` 里额外声明广告配置。

---

## 9. 后续触发测试的时机

这批接口不做专项真机轮次，按「实际玩法用到哪组就验哪组」推进。每组的验收判据在该组章节；新增一条通用要求：**任何 `tap_*_result` 的 `error` 非空时，必须能定位到宿主 errMsg 或 `only supported on TapTap`，不允许出现「成功但无效果」。**

