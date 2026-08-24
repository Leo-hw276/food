/**
 * 极速快运平台 - 后端服务
 * 用户端 / 骑手端 / 管理员端
 * 启动：npm install && npm start
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

// 管理员内置账号（登录即用）
const ADMIN_PHONE = '18000000000';
const ADMIN_PASSWORD = 'adminpassword';

// ===================== 数据存储（JSON 文件） =====================
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const DEFAULT_DB = {
  users: [], // { id, phone, name, password, role: 'user'|'rider', createdAt }
  orders: [], // { id, orderNo, type, content, scheduledTime, estimatedFee, serviceFee, total, pickupCode, status, phone, name, createdAt }
  counters: { order: 0 },
  config: { serviceFee: 1.5 }
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      const db = clone(DEFAULT_DB);
      if (Array.isArray(saved.users)) db.users = saved.users;
      if (Array.isArray(saved.orders)) db.orders = saved.orders;
      if (saved.counters) db.counters = Object.assign({}, db.counters, saved.counters);
      if (saved.config) db.config = Object.assign({}, db.config, saved.config);
      return db;
    }
  } catch (e) {
    console.error('读取数据文件失败，使用默认数据：', e.message);
  }
  return clone(DEFAULT_DB);
}

let db = loadDB();

function saveDB() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('保存数据失败：', e.message);
  }
}

// ===================== 会话 =====================
const sessions = new Map(); // token -> { phone, role, name }

function createSession(phone, role, name) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { phone, role, name });
  return token;
}

function auth(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: '未登录或登录已过期，请重新登录' });
  req.session = s;
  next();
}

function authRole() {
  const roles = Array.from(arguments);
  return (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: '没有权限执行此操作' });
    next();
  };
}

// ===================== 工具函数 =====================
function pad(n) {
  return String(n).padStart(2, '0');
}

function formatTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function statusText(s) {
  return ({ pending: '待处理', accepted: '已接单', completed: '已完成' })[s] || s || '';
}

function orderToText(o) {
  const typeText = o.type === 'door' ? '上门服务' : '外卖配送';
  const timeLabel = o.type === 'door' ? '上门时间' : '送达时间';
  const lines = [
    '【极速快运订单详情】',
    '订单号：' + o.orderNo,
    '订单类型：' + typeText,
    '内容：' + o.content,
    timeLabel + '：' + formatTime(o.scheduledTime),
    '个人预估费用：' + o.estimatedFee + ' 元',
    '服务费：' + o.serviceFee + ' 元',
    '总价：' + o.total + ' 元'
  ];
  if (o.pickupCode) lines.push('取餐码：' + o.pickupCode);
  lines.push(
    '下单人：' + o.name,
    '联系电话：' + o.phone,
    '下单时间：' + formatTime(o.createdAt),
    '订单状态：' + statusText(o.status)
  );
  return lines.join('\n');
}

async function qrDataUrl(o) {
  const text = orderToText(o);
  const qr = await QRCode.toDataURL(text, { margin: 1, width: 360, errorCorrectionLevel: 'M' });
  return { qr, text };
}

function publicOrder(o) {
  return Object.assign({}, o, {
    typeText: o.type === 'door' ? '上门服务' : '外卖配送',
    statusText: statusText(o.status),
    timeText: formatTime(o.scheduledTime),
    createdText: formatTime(o.createdAt)
  });
}

function publicUser(u) {
  return {
    id: u.id,
    phone: u.phone,
    name: u.name,
    role: u.role,
    roleText: u.role === 'rider' ? '骑手' : '普通用户',
    createdAt: u.createdAt
  };
}

// ===================== 静态页面 =====================
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ===================== 公共接口 =====================
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/config', (req, res) => {
  res.json({ serviceFee: db.config.serviceFee });
});

// 注册：手机号 + 名称 + 密码
app.post('/api/register', (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  const name = String((req.body && req.body.name) || '').trim();
  const password = String((req.body && req.body.password) || '').trim();
  if (!/^1\d{10}$/.test(phone)) return res.status(400).json({ error: '请输入正确的 11 位手机号' });
  if (!name) return res.status(400).json({ error: '请输入名称' });
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (phone === ADMIN_PHONE) return res.status(400).json({ error: '该手机号为系统管理员账号，无法注册' });
  if (db.users.some((u) => u.phone === phone)) return res.status(400).json({ error: '该手机号已注册，请直接登录' });
  const user = {
    id: db.users.length + 1,
    phone,
    name,
    password, // 实际项目应使用哈希
    role: 'user',
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  saveDB();
  const token = createSession(user.phone, user.role, user.name);
  res.json({ token, user: publicUser(user) });
});

// 登录：手机号 + 密码
app.post('/api/login', (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  const password = String((req.body && req.body.password) || '').trim();
  if (!phone) return res.status(400).json({ error: '请输入手机号' });
  if (!password) return res.status(400).json({ error: '请输入密码' });
  if (phone === ADMIN_PHONE) return res.status(400).json({ error: '管理员请到管理员端登录' });
  const user = db.users.find((u) => u.phone === phone);
  if (!user) return res.status(400).json({ error: '该手机号未注册，请先注册' });
  if (user.password !== password) return res.status(400).json({ error: '密码错误' });
  const token = createSession(user.phone, user.role, user.name);
  res.json({ token, user: publicUser(user) });
});

// ===================== 用户端接口 =====================
// 下单
app.post('/api/orders', auth, async (req, res) => {
  const { type, content, scheduledTime, estimatedFee } = req.body || {};
  if (!['door', 'delivery'].includes(type)) return res.status(400).json({ error: '订单类型无效' });
  const contentText = String(content || '').trim();
  if (!contentText) return res.status(400).json({ error: '请填写服务/外卖内容' });
  if (!scheduledTime) return res.status(400).json({ error: '请选择上门/送达时间' });
  const fee = Number(estimatedFee);
  if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: '个人预估费用无效' });

  db.counters.order = (db.counters.order || 0) + 1;
  const now = new Date();
  const orderNo = 'D' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
    '-' + pad(db.counters.order);

  const user = db.users.find((u) => u.phone === req.session.phone);
  const serviceFee = db.config.serviceFee;
  const order = {
    id: crypto.randomUUID(),
    orderNo,
    type,
    content: contentText,
    scheduledTime,
    estimatedFee: Math.round(fee * 100) / 100,
    serviceFee,
    total: Math.round((fee + serviceFee) * 100) / 100,
    pickupCode: type === 'delivery' ? String(Math.floor(1000 + Math.random() * 9000)) : null,
    status: 'pending',
    phone: req.session.phone,
    name: user ? user.name : req.session.name,
    createdAt: now.toISOString()
  };
  db.orders.unshift(order);
  saveDB();
  let qr = null;
  try {
    const q = await qrDataUrl(order);
    qr = q.qr;
  } catch (e) {
    // 二维码生成失败不阻塞下单
  }
  res.json({ order: publicOrder(order), qr });
});

// 我的订单
app.get('/api/orders', auth, (req, res) => {
  const orders = db.orders.filter((o) => o.phone === req.session.phone).map(publicOrder);
  res.json({ orders });
});

// 订单详情
app.get('/api/orders/:id', auth, (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const canView = order.phone === req.session.phone || req.session.role === 'rider' || req.session.role === 'admin';
  if (!canView) return res.status(403).json({ error: '无权查看该订单' });
  res.json({ order: publicOrder(order) });
});

// 订单二维码
app.get('/api/orders/:id/qr', auth, async (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const canView = order.phone === req.session.phone || req.session.role === 'rider' || req.session.role === 'admin';
  if (!canView) return res.status(403).json({ error: '无权查看该订单' });
  try {
    res.json(await qrDataUrl(order));
  } catch (e) {
    res.status(500).json({ error: '生成二维码失败' });
  }
});

// ===================== 骑手端接口 =====================
app.get('/api/rider/orders', auth, authRole('rider', 'admin'), (req, res) => {
  res.json({ orders: db.orders.map(publicOrder) });
});

app.post('/api/rider/orders/:id/status', auth, authRole('rider', 'admin'), (req, res) => {
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: '订单不存在' });
  const { status } = req.body || {};
  if (!['pending', 'accepted', 'completed'].includes(status)) return res.status(400).json({ error: '订单状态无效' });
  order.status = status;
  saveDB();
  res.json({ order: publicOrder(order) });
});

// ===================== 管理员端接口 =====================
app.post('/api/admin/login', (req, res) => {
  const phone = String((req.body && req.body.phone) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (phone !== ADMIN_PHONE || password !== ADMIN_PASSWORD) {
    return res.status(400).json({ error: '管理员账号或密码错误' });
  }
  const token = createSession(ADMIN_PHONE, 'admin', '管理员');
  res.json({ token, user: { phone: ADMIN_PHONE, name: '管理员', role: 'admin', roleText: '管理员' } });
});

app.put('/api/admin/config', auth, authRole('admin'), (req, res) => {
  const fee = Number((req.body || {}).serviceFee);
  if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: '服务费金额无效' });
  db.config.serviceFee = Math.round(fee * 100) / 100;
  saveDB();
  res.json({ serviceFee: db.config.serviceFee });
});

app.get('/api/admin/orders', auth, authRole('admin'), (req, res) => {
  res.json({ orders: db.orders.map(publicOrder) });
});

app.get('/api/admin/users', auth, authRole('admin'), (req, res) => {
  res.json({ users: db.users.map(publicUser) });
});

app.post('/api/admin/set-role', auth, authRole('admin'), (req, res) => {
  const phone = String((req.body || {}).phone || '').trim();
  const role = (req.body || {}).role;
  if (!['user', 'rider'].includes(role)) return res.status(400).json({ error: '角色无效' });
  const user = db.users.find((u) => u.phone === phone);
  if (!user) return res.status(400).json({ error: '该用户不存在' });
  user.role = role;
  saveDB();
  res.json({ user: publicUser(user) });
});

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

app.listen(PORT, () => {
  console.log('============================================');
  console.log('  极速快运平台已启动');
  console.log('  用户端   ：http://localhost:' + PORT + '/');
  console.log('  骑手端   ：http://localhost:' + PORT + '/rider.html');
  console.log('  管理员端 ：http://localhost:' + PORT + '/admin.html');
  console.log('  管理员账号：' + ADMIN_PHONE + '  密码：' + ADMIN_PASSWORD);
  console.log('============================================');
});