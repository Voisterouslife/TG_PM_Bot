# 🤖 Telegram SPA Private Message Bot

**Made By Gemini** 

> AI太好用了你们知道吗（ 

基于 **Cloudflare Workers** + **D1 数据库**构建的极简、无痕 Telegram 私聊代发与管理机器人。  整个项目仅需一个 `worker.js` 文件即可运行。 

## ✨ 核心特性

- **交互面板**：管理后台采用内联键盘与原生消息编辑，所有状态变更（加词、封禁、解封）都可在主消息面版完成。 
- **发后即焚**：管理员发送的控制指令及输入项在被系统接收后，将瞬间自动撤回，保持聊天界面绝对整洁。 
- **静默**：包含黑名单与屏蔽词机制。  触发拦截后系统不作任何回应。 
- **智能提示**：利用 D1 建立消息映射，首次回复访客时附带提示，后续自动隐藏。 
- **Secret Token**：支持 Webhook 密钥校验，确保请求仅来自 Telegram 官方。
- **自动清理**：自动滚动清理 30 天前的历史消息映射，保持数据库轻量级运作。
- **防超时**：利用 `ctx.waitUntil` 瞬间响应 Telegram 服务器，防止超时重发问题。

---

## 🚀 极简部署指南 (纯网页端操作)

### 第一步：初始化 D1 数据库
1. 登录 Cloudflare 控制台，进入左侧菜单的 **"D1 SQL 数据库"**。 
2. 点击 **"创建数据库"**，命名为 `tg-bot-db`（或任意名称）。 
3. 进入刚刚创建的数据库，点击 **"控制台" (Console)**。 
4. 将以下 SQL 语句完整复制进去并点击 **"执行"**： 

```sql
CREATE TABLE IF NOT EXISTS blacklist (user_id TEXT PRIMARY KEY, user_name TEXT);
CREATE TABLE IF NOT EXISTS spam_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT UNIQUE); [cite: 2]
CREATE TABLE IF NOT EXISTS admin_state (admin_id TEXT PRIMARY KEY, state TEXT); [cite: 3]
CREATE TABLE IF NOT EXISTS messages_map (msg_id INTEGER PRIMARY KEY, user_id TEXT, user_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); [cite: 4]
CREATE TABLE IF NOT EXISTS reply_hints (user_id TEXT PRIMARY KEY); [cite: 5]
```

### 第二步：创建 Worker 代码
1. 进入 Cloudflare **"Workers & Pages"**。 
2. 点击 **"创建应用程序"** -> **"创建 Worker"**。 
3. 点击 **"编辑代码"**，清空后粘贴 `worker.js` 的源码，点击 **"部署"**。 

### 第三步：绑定数据库与环境变量
1. 在 Worker 的 **"设置" (Settings)** -> **"变量和机密" (Variables and Secrets)** 中进行配置。 
2. **绑定 D1 数据库**： 
   - 变量名称填写为：`DB`。 
   - 选择你创建的 D1 数据库。 
3. **添加环境变量**： 
   - `BOT_TOKEN`：填入你的机器人 Token。 
   - `ADMIN_ID`：填入你的 Telegram 纯数字 ID。 
   - `SECRET_TOKEN`：自定义一个复杂的暗号（仅限字母、数字、下划线、连字符）。

### 第四步：设置 Telegram Webhook
在浏览器访问以下网址（替换大写部分）： 

```text
https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=你的WORKER域名&secret_token=你的SECRET_TOKEN
```

---

## ⌨️ 管理员指令说明
- `/start` - 呼出带有内联键盘的 SPA 管理面板 
- `/ban ID` - 快捷封禁用户 
- `/unban ID` - 快捷解封用户 
- `/addword 词汇` - 快捷增加屏蔽词 
- `/delword 词汇` - 快捷删除屏蔽词 
- `/test 内容` - 以访客视角模拟发送消息，测试拦截机制 [cite: 1, 7]

**交互小技巧：**
- 你可以直接回复消息 `/ban` 或 `/unban` 来执行快速封禁/解封。 
- 直接回复消息对方就会收到相应的回复。 
- 可通过 `/test` 指令模拟访客视角进行功能验证。 
---
