require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { query } = require('./db/pg');

const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');
const chatRoutes = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

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
    // Adiciona coluna plan_name se não existir (para tabelas já criadas)
    await query(`ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS plan_name TEXT DEFAULT 'Meu Plano'`).catch(() => {});
    await query(`ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS goal_plan_id INTEGER`).catch(() => {});
    // Colunas do Strava (para tabelas já existentes)
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_client_id TEXT`).catch(() => {});
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_client_secret TEXT`).catch(() => {});
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS strava_refresh_token TEXT`).catch(() => {});

    // Tabela para log de atividades sincronizadas em tempo real
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
    // Tabela para planos com meta (5k/10k/21k/42k)
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
    console.log('✅ Banco de dados inicializado');
  } catch (e) {
    console.error('❌ Erro ao inicializar DB:', e.message);
  }
}

app.use('/api/auth', authRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/chat', chatRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
  });
}

start();
