const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');

const config = require('./config');
require('./db'); // ensures schema + bootstrap admin run first
const { loadProfile, requireAuth, requireAdmin } = require('./middleware/auth');
const profileRoutes = require('./routes/profiles');
const adminRoutes = require('./routes/admin');
const roomRoutes = require('./routes/rooms');
const scheduler = require('./cleanup/scheduler');
const roomSocket = require('./sockets/roomSocket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.set('trust proxy', 1);

// Security headers against common web vulnerabilities (XSS, Clickjacking, MIME sniffing)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

const sessionMiddleware = session({
  secret: config.sessionSecret,
  name: 'screening.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production' ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
});

app.use(express.json({ limit: '100kb' }));
app.use(sessionMiddleware);
app.use(loadProfile);

// Share the same session with Socket.IO connections.
io.engine.use(sessionMiddleware);

app.use('/api/profiles', profileRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/rooms', roomRoutes);

app.get('/api/admin/check', requireAuth, requireAdmin, (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

roomSocket.attach(io);
scheduler.startSweeper();

server.listen(config.port, () => {
  console.log(`Screening Room running at http://localhost:${config.port}`);
});
