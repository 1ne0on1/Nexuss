const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e6
});

// ⚠️ ЗДЕСЬ ВПИШИ СВОЙ НИК — получишь галочку и надпись "Создатель"
const VERIFIED_USERS = ['neon'];
const FOUNDER = VERIFIED_USERS[0];

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

const chats = {};
const messages = {};
const comments = {};
const users = {};
const contacts = {};

function chatToSend(c) {
  return {
    id: c.id, name: c.name, type: c.type, owner: c.owner,
    color: c.color, avatar: c.avatar,
    memberCount: c.members.length, members: c.members.slice()
  };
}
function userToSend(u) {
  return {
    name: u.name, color: u.color, avatar: u.avatar,
    verified: VERIFIED_USERS.map(v => v.toLowerCase()).includes(u.name.toLowerCase()),
    isFounder: u.name === FOUNDER
  };
}

io.on('connection', (socket) => {
  console.log('Подключился:', socket.id);
  let myName = null;

  socket.on('register', (user) => {
    if (!user || !user.name) return;
    const lower = user.name.toLowerCase();
    if (users[lower] && users[lower].name !== user.name) {
      socket.emit('register error', 'Ник занят');
      return;
    }
    users[lower] = { name: user.name, color: user.color, avatar: user.avatar };
    myName = user.name;
    socket.emit('register ok', userToSend(users[lower]));
    const myChats = Object.values(chats).filter(c => c.members.includes(myName));
    socket.emit('chats list', myChats.map(chatToSend));
    const myContacts = (contacts[lower] || []).map(n => users[n] ? userToSend(users[n]) : null).filter(Boolean);
    socket.emit('contacts list', myContacts);
  });

  socket.on('create chat', (data) => {
    if (!data || !data.owner) return;
    const id = data.type + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const chat = {
      id, name: data.name, type: data.type, owner: data.owner,
      color: data.color || '#2d5bff', avatar: data.avatar || null,
      members: [data.owner], createdAt: Date.now()
    };
    chats[id] = chat;
    messages[id] = [];
    io.emit('chat created', chatToSend(chat));
    socket.emit('joined chat', chatToSend(chat));
  });

  socket.on('join chat', (chatId) => {
    if (!myName || !chats[chatId]) return;
    if (!chats[chatId].members.includes(myName)) chats[chatId].members.push(myName);
    io.emit('chat updated', chatToSend(chats[chatId]));
    socket.emit('joined chat', chatToSend(chats[chatId]));
  });

  socket.on('leave chat', (chatId) => {
    if (!myName || !chats[chatId]) return;
    const c = chats[chatId];
    if (c.owner === myName) return;
    c.members = c.members.filter(m => m !== myName);
    io.emit('chat updated', chatToSend(c));
    socket.emit('left chat', chatId);
  });

  socket.on('delete chat', (chatId) => {
    if (!myName || !chats[chatId]) return;
    if (chats[chatId].owner !== myName) return;
    delete chats[chatId]; delete messages[chatId];
    io.emit('chat deleted', chatId);
  });

  socket.on('edit chat', (data) => {
    if (!myName || !chats[data.chatId]) return;
    const c = chats[data.chatId];
    if (c.owner !== myName) return;
    if (data.name) c.name = data.name;
    if (data.avatar !== undefined) c.avatar = data.avatar;
    if (data.color) c.color = data.color;
    io.emit('chat updated', chatToSend(c));
  });

  socket.on('open chat', (chatId) => {
    if (!chats[chatId]) return;
    socket.join(chatId);
    socket.emit('history', messages[chatId] || []);
  });
  socket.on('leave room', (chatId) => socket.leave(chatId));

  socket.on('chat message', (msg) => {
    if (!chats[msg.channel]) return;
    const c = chats[msg.channel];
    if (c.type === 'channel' && c.owner !== msg.name) {
      socket.emit('error message', 'В канале пишет только владелец');
      return;
    }
    if (c.type === 'channel') {
      msg.name = c.name; msg.color = c.color; msg.avatar = c.avatar; msg.isChannel = true;
    }
    if (!messages[msg.channel]) messages[msg.channel] = [];
    messages[msg.channel].push(msg);
    if (messages[msg.channel].length > 100) messages[msg.channel].shift();
    io.to(msg.channel).emit('chat message', msg);
  });

  socket.on('reaction', (data) => {
    const { channel, msgId, emoji, user } = data;
    if (!messages[channel]) return;
    const msg = messages[channel].find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const arr = msg.reactions[emoji];
    const idx = arr.indexOf(user);
    let action = 'add';
    if (idx === -1) arr.push(user);
    else { arr.splice(idx, 1); action = 'remove'; }
    io.to(channel).emit('reaction', { channel, msgId, emoji, user, action });
  });

  socket.on('comment', (data) => {
    const key = data.channel + ':' + data.msgId;
    if (!comments[key]) comments[key] = [];
    comments[key].push(data.comment);
    io.to(data.channel).emit('comment', data);
  });

  socket.on('add contact', (nick) => {
    if (!myName || !nick) return;
    const lower = nick.toLowerCase();
    if (!users[lower]) { socket.emit('contact error', 'Пользователь не найден'); return; }
    if (lower === myName.toLowerCase()) { socket.emit('contact error', 'Нельзя себя'); return; }
    const meLower = myName.toLowerCase();
    if (!contacts[meLower]) contacts[meLower] = [];
    if (contacts[meLower].includes(lower)) { socket.emit('contact error', 'Уже в контактах'); return; }
    contacts[meLower].push(lower);
    socket.emit('contact added', userToSend(users[lower]));
  });

  socket.on('remove contact', (nick) => {
    if (!myName) return;
    const meLower = myName.toLowerCase();
    const lower = nick.toLowerCase();
    if (contacts[meLower]) contacts[meLower] = contacts[meLower].filter(n => n !== lower);
    socket.emit('contact removed', nick);
  });

  socket.on('disconnect', () => console.log('Отключился:', socket.id));
});

server.listen(3000, '0.0.0.0', () => {
  console.log('Сервер слушает на порту 3000');
  console.log('Создатель:', FOUNDER);
});