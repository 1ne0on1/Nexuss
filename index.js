const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e6
});

// ⚠️ ЗДЕСЬ ВПИШИ СВОЙ НИК
const VERIFIED_USERS = ['neon'];
const FOUNDER = VERIFIED_USERS[0];

const DB_FILE = path.join(__dirname, 'nexus.db');
let db = null;

function saveDb() {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch(e) { console.error('Ошибка сохранения БД:', e); }
}

async function startServer() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_FILE)) {
    const filebuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(filebuffer);
    console.log('✅ База данных загружена');
  } else {
    db = new SQL.Database();
    console.log('✅ Создана новая база данных');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (name TEXT PRIMARY KEY, lower_name TEXT UNIQUE NOT NULL, color TEXT, avatar TEXT);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, owner TEXT NOT NULL, color TEXT, avatar TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS chat_members (chat_id TEXT NOT NULL, user_name TEXT NOT NULL, PRIMARY KEY (chat_id, user_name));
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT, avatar TEXT, text TEXT, image TEXT, reply_to_id TEXT, reply_to_name TEXT, reply_to_text TEXT, is_channel INTEGER DEFAULT 0, created_at INTEGER, reactions TEXT DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, msg_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT, avatar TEXT, text TEXT, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS contacts (owner TEXT NOT NULL, contact TEXT NOT NULL, PRIMARY KEY (owner, contact));
  `);
  saveDb();

  app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

  io.on('connection', (socket) => {
    console.log('Подключился:', socket.id);
    let myName = null;

    function getUser(name) {
      const stmt = db.prepare('SELECT * FROM users WHERE lower_name = ?');
      stmt.bind([name.toLowerCase()]);
      if (stmt.step()) { const r = stmt.getAsObject(); stmt.free(); return r; }
      stmt.free(); return null;
    }
    function userToSend(u) {
      return {
        name: u.name, color: u.color, avatar: u.avatar,
        verified: VERIFIED_USERS.map(v => v.toLowerCase()).includes(u.name.toLowerCase()),
        isFounder: u.name === FOUNDER
      };
    }
    function getChatMembers(chatId) {
      const stmt = db.prepare('SELECT user_name FROM chat_members WHERE chat_id = ?');
      stmt.bind([chatId]);
      const m = [];
      while (stmt.step()) m.push(stmt.getAsObject().user_name);
      stmt.free();
      return m;
    }
    function chatToSend(c) {
      const members = getChatMembers(c.id);
      const memberDetails = members.map(n => {
        const u = getUser(n);
        return u ? { name: u.name, color: u.color, avatar: u.avatar } : null;
      }).filter(Boolean);
      return {
        id: c.id, name: c.name, type: c.type, owner: c.owner,
        color: c.color, avatar: c.avatar,
        memberCount: members.length, members, memberDetails
      };
    }
    function getMyChats(userName) {
      const stmt = db.prepare(`
        SELECT c.* FROM chats c
        INNER JOIN chat_members m ON m.chat_id = c.id
        WHERE m.user_name = ?
        ORDER BY c.created_at DESC
      `);
      stmt.bind([userName]);
      const r = [];
      while (stmt.step()) r.push(stmt.getAsObject());
      stmt.free();
      return r;
    }

    socket.on('register', (user) => {
      if (!user || !user.name) return;
      const lower = user.name.toLowerCase();
      const existing = getUser(user.name);
      if (existing && existing.name !== user.name) {
        socket.emit('register error', 'Этот ник занят');
        return;
      }
      if (existing) {
        db.run('UPDATE users SET color = ?, avatar = ? WHERE lower_name = ?', [user.color, user.avatar, lower]);
      } else {
        db.run('INSERT INTO users (name, lower_name, color, avatar) VALUES (?, ?, ?, ?)', [user.name, lower, user.color, user.avatar]);
      }
      saveDb();
      myName = user.name;
      socket.emit('register ok', userToSend({ name: user.name, color: user.color, avatar: user.avatar }));
      socket.emit('chats list', getMyChats(myName).map(chatToSend));

      const cs = db.prepare('SELECT contact FROM contacts WHERE owner = ?');
      cs.bind([lower]);
      const cr = [];
      while (cs.step()) cr.push(cs.getAsObject().contact);
      cs.free();
      socket.emit('contacts list', cr.map(n => {
        const u = getUser(n);
        return u ? userToSend(u) : null;
      }).filter(Boolean));
    });

    socket.on('create chat', (data) => {
      if (!data || !data.owner) return;
      const id = data.type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      db.run('INSERT INTO chats (id, name, type, owner, color, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [id, data.name, data.type, data.owner, data.color || '#2d5bff', data.avatar || null, Date.now()]);
      db.run('INSERT INTO chat_members (chat_id, user_name) VALUES (?, ?)', [id, data.owner]);
      saveDb();
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([id]); stmt.step();
      const chat = stmt.getAsObject(); stmt.free();
      io.emit('chat created', chatToSend(chat));
      socket.emit('joined chat', chatToSend(chat));
    });

    socket.on('join chat', (chatId) => {
      if (!myName) return;
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      const check = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_name = ?');
      check.bind([chatId, myName]);
      const already = check.step(); check.free();
      if (!already) {
        db.run('INSERT INTO chat_members (chat_id, user_name) VALUES (?, ?)', [chatId, myName]);
        saveDb();
      }
      io.emit('chat updated', chatToSend(chat));
      socket.emit('joined chat', chatToSend(chat));
    });

    // ===== ДОБАВИТЬ УЧАСТНИКА В ГРУППУ (только владелец) =====
    socket.on('add member', (data) => {
      if (!myName || !data || !data.chatId || !data.userName) return;
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([data.chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      if (chat.owner !== myName) {
        socket.emit('member error', 'Только владелец может добавлять');
        return;
      }
      const user = getUser(data.userName);
      if (!user) { socket.emit('member error', 'Пользователь не найден'); return; }
      const check = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_name = ?');
      check.bind([data.chatId, user.name]);
      const already = check.step(); check.free();
      if (already) { socket.emit('member error', 'Уже в группе'); return; }
      db.run('INSERT INTO chat_members (chat_id, user_name) VALUES (?, ?)', [data.chatId, user.name]);
      saveDb();
      socket.emit('member added', { userName: user.name });
      io.emit('chat updated', chatToSend(chat));
    });

    // ===== КИКНУТЬ УЧАСТНИКА (только владелец) =====
    socket.on('kick member', (data) => {
      if (!myName || !data || !data.chatId || !data.userName) return;
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([data.chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      if (chat.owner !== myName) return;
      if (data.userName === chat.owner) { socket.emit('member error', 'Нельзя кикнуть владельца'); return; }
      db.run('DELETE FROM chat_members WHERE chat_id = ? AND user_name = ?', [data.chatId, data.userName]);
      saveDb();
      io.emit('chat updated', chatToSend(chat));
      io.emit('member kicked', { chatId: data.chatId, userName: data.userName });
    });

    socket.on('leave chat', (chatId) => {
      if (!myName) return;
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      if (chat.owner === myName) return;
      db.run('DELETE FROM chat_members WHERE chat_id = ? AND user_name = ?', [chatId, myName]);
      saveDb();
      io.emit('chat updated', chatToSend(chat));
      socket.emit('left chat', chatId);
    });

    socket.on('delete chat', (chatId) => {
      if (!myName) return;
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      if (chat.owner !== myName) return;
      db.run('DELETE FROM chat_members WHERE chat_id = ?', [chatId]);
      db.run('DELETE FROM messages WHERE chat_id = ?', [chatId]);
      db.run('DELETE FROM chats WHERE id = ?', [chatId]);
      saveDb();
      io.emit('chat deleted', chatId);
    });

    socket.on('edit chat', (data) => {
      if (!myName) return;
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([data.chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      if (chat.owner !== myName) return;
      const newName = data.name || chat.name;
      const newAvatar = data.avatar !== undefined ? data.avatar : chat.avatar;
      const newColor = data.color || chat.color;
      db.run('UPDATE chats SET name = ?, avatar = ?, color = ? WHERE id = ?', [newName, newAvatar, newColor, data.chatId]);
      saveDb();
      const stmt2 = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt2.bind([data.chatId]); stmt2.step();
      const updated = stmt2.getAsObject(); stmt2.free();
      io.emit('chat updated', chatToSend(updated));
    });

    socket.on('open chat', (chatId) => {
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([chatId]);
      if (!stmt.step()) { stmt.free(); return; }
      stmt.free();
      socket.join(chatId);
      const ms = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC LIMIT 100');
      ms.bind([chatId]);
      const msgs = [];
      while (ms.step()) msgs.push(ms.getAsObject());
      ms.free();
      socket.emit('history', msgs.map(m => ({
        id: m.id, channel: m.chat_id, name: m.name, color: m.color, avatar: m.avatar,
        text: m.text, image: m.image,
        replyTo: m.reply_to_id ? { id: m.reply_to_id, name: m.reply_to_name, text: m.reply_to_text } : null,
        isChannel: !!m.is_channel,
        reactions: JSON.parse(m.reactions || '{}')
      })));
      const cs = db.prepare('SELECT * FROM comments WHERE chat_id = ? ORDER BY created_at ASC');
      cs.bind([chatId]);
      const cmts = [];
      while (cs.step()) cmts.push(cs.getAsObject());
      cs.free();
      cmts.forEach(c => {
        socket.emit('comment', {
          channel: c.chat_id, msgId: c.msg_id,
          comment: { id: c.id, name: c.name, color: c.color, avatar: c.avatar, text: c.text }
        });
      });
    });
    socket.on('leave room', (chatId) => socket.leave(chatId));

    socket.on('chat message', (msg) => {
      const stmt = db.prepare('SELECT * FROM chats WHERE id = ?');
      stmt.bind([msg.channel]);
      if (!stmt.step()) { stmt.free(); return; }
      const chat = stmt.getAsObject(); stmt.free();
      if (chat.type === 'channel' && chat.owner !== msg.name) {
        socket.emit('error message', 'В канале пишет только владелец');
        return;
      }
      if (chat.type === 'channel') {
        msg.name = chat.name; msg.color = chat.color; msg.avatar = chat.avatar; msg.isChannel = true;
      }
      db.run(`INSERT INTO messages (id, chat_id, name, color, avatar, text, image, reply_to_id, reply_to_name, reply_to_text, is_channel, created_at, reactions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
        [msg.id, msg.channel, msg.name, msg.color, msg.avatar, msg.text || '', msg.image || null,
         msg.replyTo ? msg.replyTo.id : null, msg.replyTo ? msg.replyTo.name : null, msg.replyTo ? msg.replyTo.text : null,
         msg.isChannel ? 1 : 0, Date.now()]);
      saveDb();
      io.to(msg.channel).emit('chat message', msg);
    });

    socket.on('reaction', (data) => {
      const stmt = db.prepare('SELECT * FROM messages WHERE id = ?');
      stmt.bind([data.msgId]);
      if (!stmt.step()) { stmt.free(); return; }
      const msg = stmt.getAsObject(); stmt.free();
      let reactions = JSON.parse(msg.reactions || '{}');
      if (!reactions[data.emoji]) reactions[data.emoji] = [];
      const arr = reactions[data.emoji];
      const idx = arr.indexOf(data.user);
      let action = 'add';
      if (idx === -1) arr.push(data.user);
      else { arr.splice(idx, 1); action = 'remove'; }
      db.run('UPDATE messages SET reactions = ? WHERE id = ?', [JSON.stringify(reactions), data.msgId]);
      saveDb();
      io.to(data.channel).emit('reaction', { channel: data.channel, msgId: data.msgId, emoji: data.emoji, user: data.user, action });
    });

    socket.on('comment', (data) => {
      const c = data.comment;
      db.run('INSERT INTO comments (id, chat_id, msg_id, name, color, avatar, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [c.id, data.channel, data.msgId, c.name, c.color, c.avatar, c.text, Date.now()]);
      saveDb();
      io.to(data.channel).emit('comment', data);
    });

    socket.on('add contact', (nick) => {
      if (!myName || !nick) return;
      const meLower = myName.toLowerCase();
      const lower = nick.toLowerCase();
      const user = getUser(nick);
      if (!user) { socket.emit('contact error', 'Пользователь не найден'); return; }
      if (lower === meLower) { socket.emit('contact error', 'Нельзя себя'); return; }
      const check = db.prepare('SELECT 1 FROM contacts WHERE owner = ? AND contact = ?');
      check.bind([meLower, lower]);
      const ex = check.step(); check.free();
      if (ex) { socket.emit('contact error', 'Уже в контактах'); return; }
      db.run('INSERT INTO contacts (owner, contact) VALUES (?, ?)', [meLower, lower]);
      saveDb();
      socket.emit('contact added', userToSend(user));
    });

    socket.on('remove contact', (nick) => {
      if (!myName) return;
      const meLower = myName.toLowerCase();
      db.run('DELETE FROM contacts WHERE owner = ? AND contact = ?', [meLower, nick.toLowerCase()]);
      saveDb();
      socket.emit('contact removed', nick);
    });

    socket.on('disconnect', () => console.log('Отключился:', socket.id));
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log('✅ Сервер слушает на порту', PORT);
    console.log('👑 Создатель:', FOUNDER);
  });
}

startServer().catch(err => {
  console.error('Ошибка запуска:', err);
  process.exit(1);
});