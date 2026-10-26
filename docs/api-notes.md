# 接口核对记录

核对日期：2026-10-27（北京时间）。通过用户指定的 ego 浏览器访问官网、登录控制台并检查实际前端请求。以下不包含账号、密码、密钥或会话令牌。

## 已确认的接口

- `GET /api/keys`：官网登录会话 Bearer 认证，返回账号的 Key 列表，包含 `id`、`name`、`status`、`has_enc` 等字段。
- `POST /api/keys`：官网登录会话 Bearer 认证，使用 `{"name":"magpie"}` 创建密钥，现场返回 HTTP 200 及完整 `key`。
- `GET /api/keys/{id}/reveal`：官网登录会话 Bearer 认证，读取已有密钥的完整 `key`。
- `GET /v1/models`：API Key Bearer 认证，返回 `{ object: "list", data: [{ id, object, owned_by }] }`。列表按该密钥的账号套餐过滤。
- `POST /v1/chat/completions`：API Key Bearer 认证。真实小请求返回 HTTP 200、`text/event-stream`，包含标准 `choices[].delta` 和 `reasoning_content`。通过插件 loader 追加的强制 `ping` 工具调用测试，返回了 `tool_calls` 与 `[DONE]`。
- `GET /api/me`：官网登录会话 Bearer 认证。返回 `email`、`subscription` 等字段；API Key 调用返回 HTTP 401。
- `GET /api/me/models`：官网登录会话 Bearer 认证。返回 `models`（`model_id`、`name`、`multiplier`、健康信息）、`routes` 和官网接入公告。API Key 调用返回 HTTP 401。
- `GET /v1/usage`、`/v1/dashboard/billing/subscription`、`/v1/dashboard/billing/usage`、`/api/usage` 在本次核对时返回 HTTP 404，不能用作 API Key 用量读取。

官网公布了 `/v1/responses` 和 `/v1/messages`，本插件默认使用 Chat Completions；未对另外两种协议声称真实推理验收。备用域名未测试或默认启用。

## 用量映射

| 官网字段 | magpie 字段 |
| --- | --- |
| `email` | `user` |
| `subscription.plan_name` / `plan` | `plan` |
| `subscription.period_end` | `until`、`windows[0].resetsAt` |
| `subscription.used` | `windows[0].amount` |
| `subscription.monthly` | `windows[0].limit` |
| `used / monthly * 100` | `windows[0].used` |
| `period_end - period_start` | `windows[0].span`（秒） |
| `max(0, monthly - used)` | `balance`（次） |

`period_tokens` 是周期累计 Token，不能与次数额度相除。接口未给出自动续订标记、Token 额度或已确认的会话刷新协议，插件不推测这些内容。

## 验证范围

Node 自动测试覆盖认证隔离、动态模型权限、倍率补充、模型发现失败回退、官网会话过期、配额边界、流式 Response 原样传递、取消信号及目标地址校验。发布包检查校验入口、供应商 id 及本地/内嵌 Logo 一致性。

通过插件实际钩子读取了 4 个当前账号模型及倍率、套餐次数窗口和到期时间；通过实际 loader 发起小型流式工具调用，请求返回 HTTP 200，具备 `tool_calls` 和 `[DONE]`。

网页登录与自动 Key 管理已通过真实账号验证：第一次调用自动登录收尾函数创建了名为 `magpie` 的 Key；第二次调用通过 `/reveal` 读取同一个值，没有再次创建。以取得的凭据读取 4 个模型和用量均成功。测试输出仅记录路径、状态码与验证布尔值，不包含任何凭据。

30 项 Node 自动测试通过，覆盖新增的 Key 创建/复用/吊销、并发登录、创建响应丢失后避免重复创建、登录超时及窗口取消。另用本机真实 Edge 窗口验证会话检测、自动接入和关闭，在 Node 与 Bun 1.4.4 下均通过；该浏览器测试使用被拦截的虚构页面，不将测试凭据发往官网。

使用官方 `internal/plugin/host.js` 在独立目录下进行 Bun 宿主协议检查：默认网页登录无额外问题，正确返回 `opened: true` 与自动回调；回调完成后由真实宿主保存为 API 认证，保留 Key、会话和邮箱。该检查使用虚构凭据，不修改用户日常 magpie 配置。

没有在本机已安装的 magpie 桌面应用内进行完整安装验收；也未测试全部套餐、所有模型、长上下文或工具的实际执行。真实官网登录态检测、Key 管理与宿主保存分别验证，不声称已经在 magpie 桌面内逐步操作完整登录流程。工具调用测试只验证模型发出工具请求，不执行工具。

实现依据：[magpie 插件开发文档](https://usemagpie.ai/docs/zh/plugins)、[官方插件宿主源码](https://github.com/yetone/magpie/blob/main/internal/plugin/host.js)。官网接口属于当前实现，日后可能变化。
