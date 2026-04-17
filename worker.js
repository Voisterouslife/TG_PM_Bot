export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('OK');

    // 校验 Secret Token，保护 D1 数据库不被恶意接口扫描
    const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretToken !== env.SECRET_TOKEN) {
      return new Response('Unauthorized', { status: 403 });
    }

    try {
      const update = await request.json();
      const adminId = parseInt(env.ADMIN_ID);

      // 及时返回 OK 阻断 TG 超时重试，业务逻辑交由 waitUntil 后台异步运行
      if (update.callback_query) {
        ctx.waitUntil(handleCallback(update.callback_query, env, adminId));
      }
      
      // 兼容处理新消息与访客重新编辑过的消息
      const msg = update.message || update.edited_message;
      if (msg) {
        ctx.waitUntil(handleMessage(msg, env, adminId));
      }
    } catch (e) {
      console.error("Worker Error:", e);
    }
    
    return new Response('OK');
  }
};

function escapeHtml(text) {
  if (!text) return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ==========================================
// 消息处理主逻辑 (管理员与访客)
// ==========================================
async function handleMessage(message, env, adminId) {
  if (message.chat.type !== 'private') return;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || message.caption || "";
  const isTestCommand = text.startsWith('/test');

  // ------------------------------------------
  // [A] 管理员逻辑专区
  // ------------------------------------------
  if (userId === adminId && !isTestCommand) {
    
    // 1. SPA 面板状态机拦截 (处理等待输入状态)
    const stateRecord = await env.DB.prepare("SELECT state FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).first();
    
    if (stateRecord) {
      const parts = stateRecord.state.split(':');
      const adminState = parts[0];
      const panelMsgId = parts[1] ? parseInt(parts[1]) : null;

      if (text === '/cancel') {
        await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
        if (panelMsgId) await updateAdminMenu(env, adminId, panelMsgId); 
        await deleteMsg(env, adminId, message.message_id); 
        return;
      }

      if (!text.trim()) {
        await sendTg(env, adminId, "⚠️ 无法识别文本内容，请发送文字，或发送 /cancel 取消。");
        return;
      }

      if (adminState === 'add_spam_word') {
        await env.DB.prepare("INSERT OR IGNORE INTO spam_words (word) VALUES (?)").bind(text).run();
        await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
        
        if (panelMsgId) {
          await renderSpamwordsPanel(env, adminId, panelMsgId, `✅ <b>成功添加屏蔽词：【${escapeHtml(text)}】</b>\n\n请点击下方词汇删除，或继续添加：`, 0);
          await deleteMsg(env, adminId, message.message_id); 
        } else {
          await sendTg(env, adminId, `✅ 成功添加屏蔽词：【${escapeHtml(text)}】\n请发送 /start 刷新面板。`);
        }
        return;
      }
      
      if (adminState === 'add_ban') {
        const targetId = text.trim();
        if (/^\d+$/.test(targetId)) {
          await env.DB.prepare("INSERT OR REPLACE INTO blacklist (user_id, user_name) VALUES (?, ?)").bind(targetId, '手动输入').run();
          await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
          
          if (panelMsgId) {
            await renderBlacklistPanel(env, adminId, panelMsgId, `✅ <b>成功封禁 ID：<code>${targetId}</code></b>\n\n请点击下方用户解封，或手动添加：`, 0);
            await deleteMsg(env, adminId, message.message_id); 
          } else {
            await sendTg(env, adminId, `🚫 已封禁 ID：${targetId}\n请发送 /start 刷新面板。`);
          }
        } else {
          await deleteMsg(env, adminId, message.message_id);
          await sendTg(env, adminId, `❌ 输入格式错误，请输入纯数字 ID，或发送 /cancel 取消。`);
        }
        return;
      }
    }

    // 2. 快捷指令解析 (执行后立刻撤回原消息保持面板整洁)
    if (text.startsWith('/addword ')) {
      const word = text.replace('/addword ', '').trim();
      if (word) {
        await env.DB.prepare("INSERT OR IGNORE INTO spam_words (word) VALUES (?)").bind(word).run();
        await sendTg(env, adminId, `✅ 快捷添加屏蔽词：【${escapeHtml(word)}】\n<i>(可发 /start 刷新面板)</i>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id); 
      return;
    }

    if (text.startsWith('/delword ')) {
      const word = text.replace('/delword ', '').trim();
      if (word) {
        await env.DB.prepare("DELETE FROM spam_words WHERE word = ?").bind(word).run();
        await sendTg(env, adminId, `✅ 快捷删除屏蔽词：【${escapeHtml(word)}】\n<i>(可发 /start 刷新面板)</i>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id); 
      return;
    }

    if (text.startsWith('/ban ') && !message.reply_to_message) {
      const targetId = text.replace('/ban ', '').trim();
      if (/^\d+$/.test(targetId)) {
        await env.DB.prepare("INSERT OR REPLACE INTO blacklist (user_id, user_name) VALUES (?, ?)").bind(targetId, '快捷指令').run();
        await sendTg(env, adminId, `🚫 快捷封禁 ID：<code>${targetId}</code>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id);
      return;
    }

    if (text.startsWith('/unban ')) {
      const targetId = text.replace('/unban ', '').trim();
      if (/^\d+$/.test(targetId)) {
        await env.DB.prepare("DELETE FROM blacklist WHERE user_id = ?").bind(targetId).run();
        await sendTg(env, adminId, `✅ 快捷解封 ID：<code>${targetId}</code>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id);
      return;
    }

    // 3. SPA 管理主面板呼出
    if (text === '/start') {
      await sendAdminMenu(env, adminId);
      await deleteMsg(env, adminId, message.message_id);
      return;
    }

    // 4. 对话快捷回复指令 (/ban 与 /unban)
    if (text === '/ban' && message.reply_to_message) {
      const replyMsgId = message.reply_to_message.message_id;
      const mapRecord = await env.DB.prepare("SELECT user_id, user_name FROM messages_map WHERE msg_id = ?").bind(replyMsgId).first();
      
      if (mapRecord) {
        const bName = mapRecord.user_name || '未知';
        await env.DB.prepare("INSERT OR REPLACE INTO blacklist (user_id, user_name) VALUES (?, ?)").bind(mapRecord.user_id, bName).run();
        await sendTg(env, adminId, `🚫 快捷封禁成功！\n被封禁者：<b>${escapeHtml(bName)}</b> (ID: <code>${mapRecord.user_id}</code>)`, "HTML");
      } else {
        await sendTg(env, adminId, "⚠️ 无法定位该消息的发送者，记录已过期。");
      }
      await deleteMsg(env, adminId, message.message_id);
      return;
    }

    if (text === '/unban' && message.reply_to_message) {
      const replyMsgId = message.reply_to_message.message_id;
      const mapRecord = await env.DB.prepare("SELECT user_id, user_name FROM messages_map WHERE msg_id = ?").bind(replyMsgId).first();
      
      if (mapRecord) {
        await env.DB.prepare("DELETE FROM blacklist WHERE user_id = ?").bind(mapRecord.user_id).run();
        const uName = mapRecord.user_name || '未知';
        await sendTg(env, adminId, `✅ 快捷解封成功！\n已解封用户：<b>${escapeHtml(uName)}</b> (ID: <code>${mapRecord.user_id}</code>)`, "HTML");
      } else {
        await sendTg(env, adminId, "⚠️ 无法定位该消息的发送者，记录可能已过期。");
      }
      await deleteMsg(env, adminId, message.message_id);
      return; 
    }

    // 5. D1 映射回复模块 (与访客双向通信)
    if (message.reply_to_message) {
      const replyMsgId = message.reply_to_message.message_id;
      const mapRecord = await env.DB.prepare("SELECT user_id FROM messages_map WHERE msg_id = ?").bind(replyMsgId).first();
      
      if (!mapRecord) {
        await sendTg(env, adminId, "⚠️ 无法回复：未找到来源记录。");
        return;
      }
      
      // 首次回复提示
      const hintRecord = await env.DB.prepare("SELECT 1 FROM reply_hints WHERE user_id = ?").bind(mapRecord.user_id).first();
      let hintText = "";
      if (!hintRecord) {
        hintText = "\n\n<i>(直接发送消息即可继续对话。注：此提示仅显示一次)</i>";
        await env.DB.prepare("INSERT INTO reply_hints (user_id) VALUES (?)").bind(mapRecord.user_id).run();
      }

      // 区分纯文本与多媒体回复
      if (message.text) {
        const replyText = `💬 <b>回复：</b>\n\n<blockquote>${escapeHtml(message.text)}</blockquote>${hintText}`;
        await sendTg(env, mapRecord.user_id, replyText, "HTML");
      } else {
        let copyBody = { chat_id: mapRecord.user_id, from_chat_id: adminId, message_id: message.message_id };
        if (message.caption) {
          copyBody.caption = `💬 <b>回复：</b>\n\n<blockquote>${escapeHtml(message.caption)}</blockquote>${hintText}`;
          copyBody.parse_mode = "HTML";
        }
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(copyBody)
        });
        if (!message.caption && hintText) {
          await sendTg(env, mapRecord.user_id, hintText.trim(), "HTML");
        }
      }
      return;
    }
    return;
  }

  // ------------------------------------------
  // [B] 访客与安防安检专区
  // ------------------------------------------
  let guestId = userId.toString();
  let guestName = message.from.first_name || "";
  if (message.from.last_name) guestName += " " + message.from.last_name;
  let guestText = text;

  // 模拟测试覆盖逻辑
  if (isTestCommand && userId === adminId) {
    guestId = adminId.toString();
    guestName = (guestName ? guestName : "管理员") + "(测试)"; 
    guestText = text.replace(/^\/test\s*/i, '').trim() || "[仅测试指令]"; 
  } else if (text === '/start') {
    await sendTg(env, chatId, "👋 <b>你好，</b>\n\n请直接发送消息，收到后会尽快回复你。", "HTML");
    return;
  }

  // 影子封禁验证 - 黑名单
  const isBanned = await env.DB.prepare("SELECT 1 FROM blacklist WHERE user_id = ?").bind(guestId).first();
  if (isBanned) {
    if (isTestCommand) await sendTg(env, adminId, `🛑 <b>拦截命中</b>\n原因：ID <code>${guestId}</code> 在黑名单中`, "HTML");
    return;
  }

  // 影子封禁验证 - 智能屏蔽词匹配
  const { results: spamWords } = await env.DB.prepare("SELECT word FROM spam_words").all();
  const lowerText = guestText.toLowerCase();
  
  const hitWord = spamWords.find(row => {
    const word = row.word.trim().toLowerCase();
    if (!word) return false;
    // 若为纯英文/数字，使用边界匹配防误杀；否则使用包含匹配
    if (/^[a-z0-9]+$/.test(word)) {
      return new RegExp(`\\b${word}\\b`, 'i').test(lowerText);
    }
    return lowerText.includes(word);
  });
  
  if (hitWord) {
    if (isTestCommand) await sendTg(env, adminId, `🚫 <b>拦截命中</b>\n原因：包含屏蔽词 <code>${escapeHtml(hitWord.word)}</code>`, "HTML");
    return;
  }

  // 安全放行并建立通信映射表
  const forwardRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: adminId, from_chat_id: chatId, message_id: message.message_id })
  });
  const forwardData = await forwardRes.json();
  
  if (forwardData.ok) {
    const adminMsgId = forwardData.result.message_id;
    await env.DB.prepare("INSERT INTO messages_map (msg_id, user_id, user_name) VALUES (?, ?, ?)").bind(adminMsgId, guestId, guestName).run();
    
    // 数据库清理：5% 概率触发清理 30 天前的数据，节约 D1 写入额度
    if (Math.random() < 0.05) {
      await env.DB.prepare("DELETE FROM messages_map WHERE datetime(created_at) < datetime('now', '-30 days')").run();
    }
    
    if (isTestCommand) {
      await sendTg(env, adminId, `✅ <b>测试成功</b>\n右滑回复测试通讯，或回复 \`/ban\` 测试封禁。`, "HTML");
    } 
  }
}

// ==========================================
// SPA 内联键盘路由 (Callback Router)
// ==========================================
async function handleCallback(callbackQuery, env, adminId) {
  const data = callbackQuery.data;
  const msgId = callbackQuery.message.message_id;
  const cbId = callbackQuery.id;

  if (callbackQuery.from.id !== adminId) {
    await answerCallback(env, cbId, "无权限");
    return;
  }

  // 基础导航与分页参数捕获
  if (data === 'menu_main') {
    await updateAdminMenu(env, adminId, msgId);
    await answerCallback(env, cbId);
  }
  else if (data.startsWith('menu_blacklist')) {
    const page = parseInt(data.split('_')[2]) || 0;
    await renderBlacklistPanel(env, adminId, msgId, "🧑‍💻 <b>黑名单管理</b>\n\n请点击下方用户解封，或手动添加：", page);
    await answerCallback(env, cbId);
  }
  else if (data.startsWith('menu_spamwords')) {
    const page = parseInt(data.split('_')[2]) || 0;
    await renderSpamwordsPanel(env, adminId, msgId, "🧑‍💻 <b>屏蔽词管理</b>\n\n请点击下方词汇删除，或添加新词：", page);
    await answerCallback(env, cbId);
  }

  // 状态机触发器
  else if (data === 'action_add_spamword') {
    await env.DB.prepare("INSERT OR REPLACE INTO admin_state (admin_id, state) VALUES (?, ?)").bind(adminId.toString(), `add_spam_word:${msgId}`).run();
    const buttons = [[{ text: '❌ 取消输入', callback_data: 'cancel_state' }]];
    await editMsg(env, adminId, msgId, "✏️ <b>等待输入</b>\n\n请发送你要添加的 <b>屏蔽词</b>：", buttons);
    await answerCallback(env, cbId);
  }
  else if (data === 'action_add_ban') {
    await env.DB.prepare("INSERT OR REPLACE INTO admin_state (admin_id, state) VALUES (?, ?)").bind(adminId.toString(), `add_ban:${msgId}`).run();
    const buttons = [[{ text: '❌ 取消输入', callback_data: 'cancel_state' }]];
    await editMsg(env, adminId, msgId, "✏️ <b>等待输入</b>\n\n请发送你要封禁的 <b>纯数字 ID</b>：", buttons);
    await answerCallback(env, cbId);
  }
  else if (data === 'cancel_state') {
    await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
    await answerCallback(env, cbId, "已取消输入");
    await updateAdminMenu(env, adminId, msgId);
  }

  // 二次确认与操作执行 (携带分页参数)
  else if (data.startsWith('c_unban_')) {
    const parts = data.split('_');
    const uid = parts[2];
    const page = parts[3] || '0';
    const buttons = [[{ text: '✅ 确认解封', callback_data: `d_unban_${uid}_${page}` }, { text: '❌ 取消', callback_data: `menu_blacklist_${page}` }]];
    await editMsg(env, adminId, msgId, `❓ 确定要解封 ID: <b>${uid}</b> 吗？`, buttons);
    await answerCallback(env, cbId);
  }
  else if (data.startsWith('d_unban_')) {
    const parts = data.split('_');
    const uid = parts[2];
    const page = parseInt(parts[3] || '0');
    await env.DB.prepare("DELETE FROM blacklist WHERE user_id = ?").bind(uid).run();
    await answerCallback(env, cbId, "✅ 解封成功", true);
    await renderBlacklistPanel(env, adminId, msgId, "🧑‍💻 <b>黑名单管理</b>\n\n请点击下方用户解封，或手动添加：", page);
  }
  else if (data.startsWith('c_delw_')) {
    const parts = data.split('_');
    const wordId = parts[2];
    const page = parts[3] || '0';
    const buttons = [[{ text: '✅ 确认删除', callback_data: `d_delw_${wordId}_${page}` }, { text: '❌ 取消', callback_data: `menu_spamwords_${page}` }]];
    await editMsg(env, adminId, msgId, `❓ 确定要删除该屏蔽词吗？`, buttons);
    await answerCallback(env, cbId);
  }
  else if (data.startsWith('d_delw_')) {
    const parts = data.split('_');
    const wordId = parts[2];
    const page = parseInt(parts[3] || '0');
    await env.DB.prepare("DELETE FROM spam_words WHERE id = ?").bind(wordId).run();
    await answerCallback(env, cbId, "✅ 删除成功", true);
    await renderSpamwordsPanel(env, adminId, msgId, "🧑‍💻 <b>屏蔽词管理</b>\n\n请点击下方词汇删除，或添加新词：", page);
  }
  
  else if (data === 'close_panel') {
    await editMsg(env, adminId, msgId, "✅ 面板已关闭。随时发送 /start 重新打开。", []);
    await answerCallback(env, cbId);
  }
}

// ==========================================
// 模块化视图渲染系统 (支持分页)
// ==========================================
async function renderBlacklistPanel(env, adminId, msgId, headerText, page = 0) {
  const limit = 30; // 每页显示 30 个 (15 行双列)
  const offset = page * limit;
  
  const totalRes = await env.DB.prepare("SELECT COUNT(*) as total FROM blacklist").first();
  const total = totalRes.total;
  
  const { results: bannedUsers } = await env.DB.prepare("SELECT user_id, user_name FROM blacklist ORDER BY rowid DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
  
  let buttons = [[{ text: '➕ 手动添加黑名单 (按ID)', callback_data: 'action_add_ban' }]];
  let currentRow = [];
  
  bannedUsers.forEach((row, index) => {
    let displayName = row.user_name || '未知';
    if (displayName.length > 6) displayName = displayName.substring(0, 6) + '..'; 
    currentRow.push({ text: `🚫 ${displayName}`, callback_data: `c_unban_${row.user_id}_${page}` });
    
    if (currentRow.length === 2 || index === bannedUsers.length - 1) {
      buttons.push(currentRow);
      currentRow = [];
    }
  });

  let navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ 上一页', callback_data: `menu_blacklist_${page - 1}` });
  if (offset + limit < total) navRow.push({ text: '下一页 ➡️', callback_data: `menu_blacklist_${page + 1}` });
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]);
  
  const pageInfo = total > 0 ? `\n<i>(第 ${page + 1} 页 / 共 ${Math.ceil(total/limit)} 页)</i>` : '';
  await editMsg(env, adminId, msgId, headerText + pageInfo, buttons);
}

async function renderSpamwordsPanel(env, adminId, msgId, headerText, page = 0) {
  const limit = 30;
  const offset = page * limit;
  
  const totalRes = await env.DB.prepare("SELECT COUNT(*) as total FROM spam_words").first();
  const total = totalRes.total;
  
  const { results: words } = await env.DB.prepare("SELECT id, word FROM spam_words ORDER BY id DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
  
  let buttons = [[{ text: '➕ 添加屏蔽词', callback_data: 'action_add_spamword' }]];
  let currentRow = [];
  
  words.forEach((row, index) => {
    currentRow.push({ text: `🗑️ ${row.word}`, callback_data: `c_delw_${row.id}_${page}` });
    if (currentRow.length === 2 || index === words.length - 1) {
      buttons.push(currentRow);
      currentRow = [];
    }
  });

  let navRow = [];
  if (page > 0) navRow.push({ text: '⬅️ 上一页', callback_data: `menu_spamwords_${page - 1}` });
  if (offset + limit < total) navRow.push({ text: '下一页 ➡️', callback_data: `menu_spamwords_${page + 1}` });
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]);
  
  const pageInfo = total > 0 ? `\n<i>(第 ${page + 1} 页 / 共 ${Math.ceil(total/limit)} 页)</i>` : '';
  await editMsg(env, adminId, msgId, headerText + pageInfo, buttons);
}

// ==========================================
// UI 常量与底层 API 封装
// ==========================================
const adminMenuText = `
🧑‍💻 <b>管理中心</b>

<b>快捷指令：</b>
• <code>/ban ID</code> - 封禁用户
• <code>/unban ID</code> - 解封用户
• <code>/addword 词汇</code> - 增加屏蔽词
• <code>/delword 词汇</code> - 删除屏蔽词
• <code>/test 内容</code> - 模拟访客测试

<b>操作模块：</b>
请选择你要管理的类目：`;

const adminMenuButtons = [
  [
    { text: '🛡️ 黑名单', callback_data: 'menu_blacklist_0' },
    { text: '🤬 屏蔽词', callback_data: 'menu_spamwords_0' }
  ],
  [{ text: '❌ 关闭面板', callback_data: 'close_panel' }]
];

async function sendAdminMenu(env, chatId) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ chat_id: chatId, text: adminMenuText.trim(), parse_mode: 'HTML', reply_markup: { inline_keyboard: adminMenuButtons } }) 
  });
}

async function updateAdminMenu(env, chatId, msgId) {
  return editMsg(env, chatId, msgId, adminMenuText.trim(), adminMenuButtons);
}

async function editMsg(env, chatId, msgId, text, buttons) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text: text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }) 
  });
}

async function deleteMsg(env, chatId, msgId) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ chat_id: chatId, message_id: msgId }) 
  });
}

async function answerCallback(env, cbId, text = "", showAlert = false) {
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ callback_query_id: cbId, text: text, show_alert: showAlert }) 
  });
}

async function sendTg(env, chatId, text, parseMode = "") {
  const body = { chat_id: chatId, text: text };
  if (parseMode) body.parse_mode = parseMode;
  return fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify(body) 
  });
}
