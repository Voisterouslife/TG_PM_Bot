# Telegram SPA Private Message Bot 

Made By Gemini

AI太好用了你们知道吗（

基于 Cloudflare Workers + D1 数据库构建的极简、无痕 Telegram 私聊代发与管理机器人。整个项目仅需一个 `worker.js` 文件即可运行。

## ✨ 核心特性

- **SPA 单页交互面板**：管理后台采用内联键盘与原生消息编辑，所有状态变更（加词、封禁、解封）都可在主消息面版完成。
- **发后即焚（无痕办公）**：管理员发送的控制指令及输入项在被系统接收后，将瞬间自动撤回，保持聊天界面绝对整洁。
- **静默防骚扰 (Shadowban)**：包含黑名单与屏蔽词机制。触发拦截后系统不作任何回应，降低骚扰者的试探欲望。
- **隐私穿透与智能提示**：利用 D1 建立消息映射，首次回复访客时附带提示，后续自动隐藏。

---

## 🚀 极简部署指南 (纯网页端操作)

无需本地安装任何环境，全部在 Cloudflare 网页控制台完成。

### 第一步：初始化 D1 数据库
1. 登录 Cloudflare 控制台，进入左侧菜单的 **"D1 SQL 数据库"**。
2. 点击 **"创建数据库"**，命名为 `tg-bot-db`（或任意名称）。
3. 进入刚刚创建的数据库，点击 **"控制台" (Console)**。
4. 将以下 SQL 语句完整复制进去并点击 **"执行"**（用于创建必要的 5 张数据表）：

```sql
CREATE TABLE IF NOT EXISTS blacklist (user_id TEXT PRIMARY KEY, user_name TEXT);
CREATE TABLE IF NOT EXISTS spam_words (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS admin_state (admin_id TEXT PRIMARY KEY, state TEXT);
CREATE TABLE IF NOT EXISTS messages_map (msg_id INTEGER PRIMARY KEY, user_id TEXT, user_name TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS reply_hints (user_id TEXT PRIMARY KEY);
```

### 第二步：创建 Worker 代码
1. 进入 Cloudflare 左侧菜单的 **"Workers & Pages"**。
2. 点击 **"创建应用程序"** -> **"创建 Worker"**。随便起个名字并部署。
3. 点击 **"编辑代码"**，将默认代码清空，把本项目中 `worker.js` 的所有代码复制粘贴进去，点击 **"部署"**。

### 第三步：绑定数据库与环境变量
1. 返回该 Worker 的设置页面，进入 **"设置" (Settings)** -> **"变量和机密" (Variables and Secrets)**。
2. **绑定 D1 数据库：**
   - 找到 "D1 数据库绑定"，点击添加。
   - 变量名称填写为：`DB`（也可以填别的，但是记得worker.js里面对应的也要改）
   - D1 数据库选择你第一步创建的 `tg-bot-db`。（创的什么选什么）
3. **添加环境变量：**
   - 添加 `BOT_TOKEN`：填入你从 @BotFather 获取的机器人 Token。
   - 添加 `ADMIN_ID`：填入你本人的 Telegram 纯数字 ID。

### 第四步：设置 Telegram Webhook
在浏览器地址栏输入以下网址（替换其中的大写部分），按回车执行：

```text
https://api.telegram.org/bot你的BOT_TOKEN/setWebhook?url=你的WORKER域名
```
*(注：如果网页返回 `{"ok":true,"result":true,"description":"Webhook was set"}` 即代表大功告成！)*

---

## ⌨️ 管理员指令说明
在机器人对话框内直接发送：
- `/start` - 呼出带有内联键盘的 SPA 管理面板
- `/ban ID` - 快捷封禁用户
- `/unban ID` - 快捷解封用户
- `/addword 词汇` - 快捷增加屏蔽词
- `/delword 词汇` - 快捷删除屏蔽词
- `/test 内容` - 以访客视角模拟发送消息，测试拦截机制

你也可以直接回复消息/ban或/unban来执行快速封禁/解封\
直接回复消息对方就会收到相应的消息\
可通过/test指令来模拟访客视角，请自行探索

---
