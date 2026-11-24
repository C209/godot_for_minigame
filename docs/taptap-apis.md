# TapTap 开放能力规格核对表（Phase 3）

> 用途：Phase 3 每实现一组 TapTap 特有能力，就在这里固化「官方签名 + 产物佐证 + 本仓库映射 + 真机判据」。
> 第一事实源：`C:\Work\Unity\Tools\minigame-sdk-unity`（com.taptap.minigame v2.0.21）的 `Runtime/Plugins/TapSDK.jslib` 与 `Runtime/Scripts/Wrapper/*`。
> 交叉源：TapTap 官方接入指引（`get_share_integration_guide`，BFF/开发者中心口径）。
> 标注：【产物】= Unity 产物里的真实调用；【官方】= 官方指引明确；【待验证】= 须真机确认。

## 进度

| 组 | 方法数 | 状态 |
|---|---|---|
| 分享板 Shareboard | 5 | 已实现，待真机 |
| 成就 Achievement | — | 未开始 |
| 排行榜 Leaderboard | — | 未开始 |
| 云存档 CloudSave | — | 未开始 |
| 支付 / 对战 / 首页小组件 | — | 未开始 |

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
- 本仓库现状：`MiniGameSDK.get_launch_options()` 已走 `getLaunchOptionsSync`，冷启动可取到 `query.sceneParam`；热启动的 `onShow` 目前只用于前后台切换，**未透传 query**——作为后续小项，不阻塞分享板。

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
