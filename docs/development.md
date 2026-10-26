# 开发说明

插件采用 OpenCode 供应商插件格式，在 magpie 的 Bun 宿主中运行，供应商 ID 为 `dawanfan`。接口核对和验证范围见 [api-notes.md](api-notes.md)。

## 本地开发

需要 Node.js 22 或更新版本：

```powershell
npm install --ignore-scripts
npm run check
npm test
npm run test:browser
npm pack
```

`test:browser` 会短暂打开本机真实浏览器，使用被拦截的虚构页面验证会话检测和窗口关闭，不操作真实账号。分发包包含 `playwright-core`，无需下载额外的 Chromium；源码环境需先安装 npm 依赖。

将源码文件夹添加到 magpie 后，关闭再开启插件即可加载修改。请使用独立配置目录，做法见 [magpie 官方测试说明](https://usemagpie.ai/docs/zh/plugins#test)。

```powershell
magpie plugin --json
magpie provider test dawanfan
magpie quota
```

## 浏览器选项

插件默认尝试本机已安装的 Edge / Chrome。可通过插件选项指定 `{"browserChannel":"chrome"}` 或 `{"browserChannel":"msedge"}`。

网页登录采用独立的临时浏览器环境，仅检测官网来源下的 `localStorage.zt_token`；正常关闭后由浏览器控制组件清理临时资料。关闭窗口即取消，未完成的登录十分钟后超时。

登录后查找名为 `magpie` 的有效 Key，存在时通过 `/reveal` 读取，不存在时创建。同名但已吊销的 Key 不复用。创建请求不自动重试；响应丢失时，下一次登录重新查询列表，以免盲目重复创建。

## 凭据与协议

magpie 在配置目录的 `plugin-auth.json` 中保存凭据：API Key 位于 `key`，官网会话位于 `metadata.sessionToken`，邮箱位于 `metadata.email`。OpenCode 使用自己的认证存储。插件不另写凭据文件，不操作系统剪贴板，不把官网会话附加到模型请求。

模型采用 OpenAI Chat Completions 协议，由 magpie 转换客户端协议。插件保留原始流式响应、工具调用、上游状态码和取消信号。模型列表未公开上下文和输出上限，使用 magpie 的未知值 `0`，保留用户已配置的限制。

用量以官网的 `subscription.used / subscription.monthly` 计算，单位为次，不使用累计 Token 数计算次数额度百分比。官网会话过期只影响用量和倍率读取，不使仍然有效的模型 API Key 失效；重新网页登录可更新会话并复用现有 Key。

官方 Logo 位于 `assets/logo.svg`，同时内嵌到插件清单和供应商图标。修改图片后运行 `npm run sync-icon`，再用 `npm run check` 检查一致性。
