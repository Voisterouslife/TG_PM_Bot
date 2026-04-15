export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('OK');
    try {
      const update = await request.json();
      const adminId = parseInt(env.ADMIN_ID);

      if (update.callback_query) return await handleCallback(update.callback_query, env, adminId);
      if (update.message) return await handleMessage(update.message, env, adminId);
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

// ================= 处理消息 =================
async function handleMessage(message, env, adminId) {
  if (message.chat.type !== 'private') return new Response('OK');

  const chatId = message.chat.id;
  const userId = message.from.id;
  const text = message.text || message.caption || "";
  const isTestCommand = text.startsWith('/test');

  // === 管理员逻辑 ===
  if (userId === adminId && !isTestCommand) {
    
    // 1. 检查管理员当前的 SPA 面板输入状态
    const stateRecord = await env.DB.prepare("SELECT state FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).first();
    
    if (stateRecord) {
      const parts = stateRecord.state.split(':');
      const adminState = parts[0];
      const panelMsgId = parts[1] ? parseInt(parts[1]) : null;

      if (text === '/cancel') {
        await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
        if (panelMsgId) await updateAdminMenu(env, adminId, panelMsgId); 
        await deleteMsg(env, adminId, message.message_id); 
        return new Response('OK');
      }

      if (!text.trim()) {
        await sendTg(env, adminId, "⚠️ 无法识别文本内容，请发送文字，或发送 /cancel 取消。");
        return new Response('OK');
      }

      if (adminState === 'add_spam_word') {
        await env.DB.prepare("INSERT OR IGNORE INTO spam_words (word) VALUES (?)").bind(text).run();
        await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
        
        if (panelMsgId) {
          await renderSpamwordsPanel(env, adminId, panelMsgId, `✅ <b>成功添加屏蔽词：【${escapeHtml(text)}】</b>\n\n请点击下方词汇删除，或继续添加：`);
          await deleteMsg(env, adminId, message.message_id); // 无痕撤回
        } else {
          await sendTg(env, adminId, `✅ 成功添加屏蔽词：【${escapeHtml(text)}】\n请发送 /start 刷新面板。`);
        }
        return new Response('OK');
      }
      
      if (adminState === 'add_ban') {
        const targetId = text.trim();
        if (/^\d+$/.test(targetId)) {
          await env.DB.prepare("INSERT OR REPLACE INTO blacklist (user_id, user_name) VALUES (?, ?)").bind(targetId, '手动输入').run();
          await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
          
          if (panelMsgId) {
            await renderBlacklistPanel(env, adminId, panelMsgId, `✅ <b>成功封禁 ID：<code>${targetId}</code></b>\n\n请点击下方用户解封，或手动添加：`);
            await deleteMsg(env, adminId, message.message_id); // 无痕撤回
          } else {
            await sendTg(env, adminId, `🚫 已封禁 ID：${targetId}\n请发送 /start 刷新面板。`);
          }
        } else {
          await deleteMsg(env, adminId, message.message_id);
          await sendTg(env, adminId, `❌ 输入格式错误，请输入纯数字 ID，或发送 /cancel 取消。`);
        }
        return new Response('OK');
      }
    }

    // 2. 快捷指令区 (无痕自毁)
    if (text.startsWith('/addword ')) {
      const word = text.replace('/addword ', '').trim();
      if (word) {
        await env.DB.prepare("INSERT OR IGNORE INTO spam_words (word) VALUES (?)").bind(word).run();
        await sendTg(env, adminId, `✅ 快捷添加屏蔽词：【${escapeHtml(word)}】\n<i>(可发 /start 刷新面板)</i>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id); 
      return new Response('OK');
    }

    if (text.startsWith('/delword ')) {
      const word = text.replace('/delword ', '').trim();
      if (word) {
        await env.DB.prepare("DELETE FROM spam_words WHERE word = ?").bind(word).run();
        await sendTg(env, adminId, `✅ 快捷删除屏蔽词：【${escapeHtml(word)}】\n<i>(可发 /start 刷新面板)</i>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id); 
      return new Response('OK');
    }

    if (text.startsWith('/ban ') && !message.reply_to_message) {
      const targetId = text.replace('/ban ', '').trim();
      if (/^\d+$/.test(targetId)) {
        await env.DB.prepare("INSERT OR REPLACE INTO blacklist (user_id, user_name) VALUES (?, ?)").bind(targetId, '快捷指令').run();
        await sendTg(env, adminId, `🚫 快捷封禁 ID：<code>${targetId}</code>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id);
      return new Response('OK');
    }

    if (text.startsWith('/unban ')) {
      const targetId = text.replace('/unban ', '').trim();
      if (/^\d+$/.test(targetId)) {
        await env.DB.prepare("DELETE FROM blacklist WHERE user_id = ?").bind(targetId).run();
        await sendTg(env, adminId, `✅ 快捷解封 ID：<code>${targetId}</code>`, "HTML");
      }
      await deleteMsg(env, adminId, message.message_id);
      return new Response('OK');
    }

    // 3. 面板呼出
    if (text === '/start') {
      await sendAdminMenu(env, adminId);
      await deleteMsg(env, adminId, message.message_id);
      return new Response('OK');
    }

    // 4. 回复封禁快捷键
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
      return new Response('OK');
    }

    // 5. 回复访客消息
    if (message.reply_to_message) {
      const replyMsgId = message.reply_to_message.message_id;
      const mapRecord = await env.DB.prepare("SELECT user_id FROM messages_map WHERE msg_id = ?").bind(replyMsgId).first();
      
      if (!mapRecord) {
        await sendTg(env, adminId, "⚠️ 无法回复：数据库中未找到来源记录。");
        return new Response('OK');
      }
      
      // ===== 首次回复提示控制 =====
      const hintRecord = await env.DB.prepare("SELECT 1 FROM reply_hints WHERE user_id = ?").bind(mapRecord.user_id).first();
      let hintText = "";
      if (!hintRecord) {
        hintText = "\n\n<i>(直接发送消息即可继续对话。注：此提示仅显示一次)</i>";
        await env.DB.prepare("INSERT INTO reply_hints (user_id) VALUES (?)").bind(mapRecord.user_id).run();
      }
      // ============================

      // 美化纯文本回复
      if (message.text) {
        const replyText = `💬 <b>回复：</b>\n\n<blockquote>${escapeHtml(message.text)}</blockquote>${hintText}`;
        await sendTg(env, mapRecord.user_id, replyText, "HTML");
      } else {
        // 图片、文件等走 CopyMessage
        await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/copyMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: mapRecord.user_id, from_chat_id: adminId, message_id: message.message_id })
        });
      }
      return new Response('OK');
    }
    return new Response('OK');
  }

  // === 访客与 /test 逻辑 ===
  let guestId = userId.toString();
  let guestName = message.from.first_name || "";
  if (message.from.last_name) guestName += " " + message.from.last_name;
  let guestText = text;

  if (isTestCommand && userId === adminId) {
    guestId = adminId.toString();
    guestName = (guestName ? guestName : "管理员") + "(测试)"; 
    guestText = text.replace(/^\/test\s*/i, '').trim() || "[仅测试指令]"; 
  } else if (text === '/start') {
    await sendTg(env, chatId, "👋 <b>你好，</b>\n\n请直接发送消息，收到后会尽快回复你。", "HTML");
    return new Response('OK');
  }

  const isBanned = await env.DB.prepare("SELECT 1 FROM blacklist WHERE user_id = ?").bind(guestId).first();
  if (isBanned) {
    if (isTestCommand) await sendTg(env, adminId, `🛑 <b>拦截测试命中</b>\n触发原因：ID <code>${guestId}</code> 处于黑名单中`, "HTML");
    return new Response('OK');
  }

  const { results: spamWords } = await env.DB.prepare("SELECT word FROM spam_words").all();
  const lowerText = guestText.toLowerCase();
  const hitWord = spamWords.find(row => row.word.trim() !== "" && lowerText.includes(row.word.toLowerCase()));
  
  if (hitWord) {
    if (isTestCommand) await sendTg(env, adminId, `🚫 <b>拦截测试命中</b>\n触发原因：包含屏蔽词 <code>${escapeHtml(hitWord.word)}</code>`, "HTML");
    return new Response('OK');
  }

  const forwardRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: adminId, from_chat_id: chatId, message_id: message.message_id })
  });
  const forwardData = await forwardRes.json();
  
  if (forwardData.ok) {
    const adminMsgId = forwardData.result.message_id;
    await env.DB.prepare("INSERT INTO messages_map (msg_id, user_id, user_name) VALUES (?, ?, ?)").bind(adminMsgId, guestId, guestName).run();
    
    if (isTestCommand) {
      await sendTg(env, adminId, `✅ <b>转发测试成功</b>\n右滑回复可测试通讯，或回复 \`/ban\` 测试封禁。`, "HTML");
    } 
  }
  return new Response('OK');
}

// ================= 处理内联按键 =================
async function handleCallback(callbackQuery, env, adminId) {
  const data = callbackQuery.data;
  const msgId = callbackQuery.message.message_id;
  const cbId = callbackQuery.id;

  if (callbackQuery.from.id !== adminId) {
    await answerCallback(env, cbId, "无权限");
    return new Response('OK');
  }

  if (data === 'menu_main') {
    await updateAdminMenu(env, adminId, msgId);
    await answerCallback(env, cbId);
  }
  else if (data === 'menu_blacklist') {
    await renderBlacklistPanel(env, adminId, msgId, "🧑‍💻 <b>黑名单管理</b>\n\n请点击下方用户解封，或手动添加：");
    await answerCallback(env, cbId);
  }
  else if (data === 'menu_spamwords') {
    await renderSpamwordsPanel(env, adminId, msgId, "🧑‍💻 <b>屏蔽词管理</b>\n\n请点击下方词汇删除，或添加新词：");
    await answerCallback(env, cbId);
  }
  else if (data === 'action_add_spamword') {
    await env.DB.prepare("INSERT OR REPLACE INTO admin_state (admin_id, state) VALUES (?, ?)").bind(adminId.toString(), `add_spam_word:${msgId}`).run();
    const buttons = [[{ text: '❌ 取消输入', callback_data: 'cancel_state' }]];
    await editMsg(env, adminId, msgId, "✏️ <b>等待输入</b>\n\n请直接发送你要添加的 <b>屏蔽词</b>：", buttons);
    await answerCallback(env, cbId);
  }
  else if (data === 'action_add_ban') {
    await env.DB.prepare("INSERT OR REPLACE INTO admin_state (admin_id, state) VALUES (?, ?)").bind(adminId.toString(), `add_ban:${msgId}`).run();
    const buttons = [[{ text: '❌ 取消输入', callback_data: 'cancel_state' }]];
    await editMsg(env, adminId, msgId, "✏️ <b>等待输入</b>\n\n请直接发送你要封禁的 <b>纯数字 ID</b>：", buttons);
    await answerCallback(env, cbId);
  }
  else if (data === 'cancel_state') {
    await env.DB.prepare("DELETE FROM admin_state WHERE admin_id = ?").bind(adminId.toString()).run();
    await answerCallback(env, cbId, "已取消输入");
    await updateAdminMenu(env, adminId, msgId);
  }
  else if (data.startsWith('confirm_unban_')) {
    const uid = data.replace('confirm_unban_', '');
    const buttons = [[{ text: '✅ 确认解封', callback_data: `do_unban_${uid}` }, { text: '❌ 取消', callback_data: 'menu_blacklist' }]];
    await editMsg(env, adminId, msgId, `❓ 确定要解封 ID: <b>${uid}</b> 吗？`, buttons);
    await answerCallback(env, cbId);
  }
  else if (data.startsWith('do_unban_')) {
    const uid = data.replace('do_unban_', '');
    await env.DB.prepare("DELETE FROM blacklist WHERE user_id = ?").bind(uid).run();
    await answerCallback(env, cbId, "✅ 解封成功", true);
    await renderBlacklistPanel(env, adminId, msgId, "🧑‍💻 <b>黑名单管理</b>\n\n请点击下方用户解封，或手动添加：");
  }
  else if (data.startsWith('confirm_delword_')) {
    const wordId = data.replace('confirm_delword_', '');
    const buttons = [[{ text: '✅ 确认删除', callback_data: `do_delword_${wordId}` }, { text: '❌ 取消', callback_data: 'menu_spamwords' }]];
    await editMsg(env, adminId, msgId, `❓ 确定要删除该屏蔽词吗？`, buttons);
    await answerCallback(env, cbId);
  }
  else if (data.startsWith('do_delword_')) {
    const wordId = data.replace('do_delword_', '');
    await env.DB.prepare("DELETE FROM spam_words WHERE id = ?").bind(wordId).run();
    await answerCallback(env, cbId, "✅ 删除成功", true);
    await renderSpamwordsPanel(env, adminId, msgId, "🧑‍💻 <b>屏蔽词管理</b>\n\n请点击下方词汇删除，或添加新词：");
  }
  else if (data === 'close_panel') {
    await editMsg(env, adminId, msgId, "✅ 面板已关闭。随时发送 /start 重新打开。", []);
    await answerCallback(env, cbId);
  }

  return new Response('OK');
}

// ================= UI 渲染与网格排版 =================

async function renderBlacklistPanel(env, adminId, msgId, headerText) {
  const { results: bannedUsers } = await env.DB.prepare("SELECT user_id, user_name FROM blacklist LIMIT 50").all();
  let buttons = [[{ text: '➕ 手动添加黑名单 (按ID)', callback_data: 'action_add_ban' }]];
  
  // 列表双列网格化排版
  let currentRow = [];
  bannedUsers.forEach((row, index) => {
    let displayName = row.user_name || '未知';
    if (displayName.length > 6) displayName = displayName.substring(0, 6) + '..'; // 截断保证排版
    currentRow.push({ text: `🚫 ${displayName}(${row.user_id})`, callback_data: `confirm_unban_${row.user_id}` });
    
    if (currentRow.length === 2 || index === bannedUsers.length - 1) {
      buttons.push(currentRow);
      currentRow = [];
    }
  });

  buttons.push([{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]);
  await editMsg(env, adminId, msgId, headerText, buttons);
}

async function renderSpamwordsPanel(env, adminId, msgId, headerText) {
  const { results: words } = await env.DB.prepare("SELECT id, word FROM spam_words LIMIT 50").all();
  let buttons = [[{ text: '➕ 添加屏蔽词', callback_data: 'action_add_spamword' }]];
  
  // 列表双列网格化排版
  let currentRow = [];
  words.forEach((row, index) => {
    currentRow.push({ text: `🗑️ ${row.word}`, callback_data: `confirm_delword_${row.id}` });
    if (currentRow.length === 2 || index === words.length - 1) {
      buttons.push(currentRow);
      currentRow = [];
    }
  });

  buttons.push([{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]);
  await editMsg(env, adminId, msgId, headerText, buttons);
}

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
    { text: '🛡️ 黑名单', callback_data: 'menu_blacklist' },
    { text: '🤬 屏蔽词', callback_data: 'menu_spamwords' }
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

// ================= 基础 API =================

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