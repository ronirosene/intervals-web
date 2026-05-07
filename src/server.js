require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { query } = require('./db/pg');

const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3000;

// ===================== SEGURANÇA =====================

// 1. Helmet — headers de segurança (XSS, CSP, etc)
app.use(helmet({
  contentSecurityPolicy: false, // desabilitado para permitir scripts inline do frontend SPA
  crossOriginEmbedderPolicy: false,
}));

// 2. CORS restrito
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'https://intervals-web.onrender.com'];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, true); // permite requisições sem origin (curl, etc)
  },
  credentials: true,
}));

// 3. Rate limiting global
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100, // limite de 100 requisições por janela
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em alguns minutos.' },
});
app.use('/api/', globalLimiter);

// 4. Rate limit mais restrito para auth (login/register)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em 15 minutos.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ===================== BANCO DE DADOS =====================

async function initDb() {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        intervals_api_key TEXT,
        intervals_athlete_id TEXT,
        target_5k_time INTEGER DEFAULT 1140,
        strava_client_id TEXT,
        strava_client_secret TEXT,
        strava_refresh_token TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        file_path TEXT,
        total_activities INTEGER,
        total_runs INTEGER,
        total_distance REAL,
        best_5k_pace REAL,
        best_5k_time INTEGER,
        avg_pace REAL,
        avg_hr REAL,
        weekly_avg REAL,
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS training_plans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        plan_name TEXT DEFAULT 'Meu Plano',
        weeks INTEGER,
        plan_data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        synced BOOLEAN DEFAULT false,
        synced_at TIMESTAMP
      );
    `);
    await query(`ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'Meu Plano'`).catch(() => {});
    await query(`ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS goal_plan_id INTEGER`).catch(() => {});
    await query(`ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS current_week INTEGER DEFAULT 1`).catch(() => {});
    await query(`ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`).catch(() => {});
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_client_id TEXT`).catch(() => {});
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_client_secret TEXT`).catch(() => {});
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_refresh_token TEXT`).catch(() => {});
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_state TEXT`).catch(() => {});

    await query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        intervals_activity_id TEXT UNIQUE,
        name TEXT,
        type TEXT,
        distance REAL,
        moving_time INTEGER,
        avg_pace REAL,
        avg_hr REAL,
        start_date TIMESTAMP,
        description TEXT,
        planned_workout_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS goal_plans (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        plan_name TEXT,
        distance_km REAL,
        target_time_seconds INTEGER,
        target_pace REAL,
        target_date DATE,
        weeks INTEGER,
        plan_data TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('\u2705 Banco de dados inicializado');
  } catch (e) {
    console.error('\u274c Erro ao inicializar DB:', e.message);
  }
}

// ===================== ROTAS =====================

app.use('/api/auth', authRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/chat', chatRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Handler global de erros (não expõe detalhes em produção)
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({ error: 'Erro interno do servidor' });
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`\u{1F680} Servidor rodando em http://localhost:${PORT}`);
  });
}

start();
