const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db/pg');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { name, email, password, intervals_api_key, intervals_athlete_id } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios' });
  }

  try {
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const result = await query(
      'INSERT INTO users (name, email, password_hash, intervals_api_key, intervals_athlete_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, email, hash, intervals_api_key || null, intervals_athlete_id || null]
    );

    const token = jwt.sign({ userId: result.rows[0].id, email }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ message: 'Usuário criado', token, user: { id: result.rows[0].id, name, email } });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email ou senha inválidos' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    res.status(500).json({ error: 'Erro no login' });
  }
});

router.get('/me', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const result = await query(
      'SELECT id, name, email, intervals_api_key, intervals_athlete_id, strava_client_id, strava_client_secret, strava_refresh_token, target_5k_time FROM users WHERE id = $1',
      [decoded.userId]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

router.put('/settings', async (req, res) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autorizado' });

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const { intervals_api_key, intervals_athlete_id, target_5k_time, strava_client_id, strava_client_secret, strava_refresh_token } = req.body;

    await query(
      'UPDATE users SET intervals_api_key = $1, intervals_athlete_id = $2, target_5k_time = $3, strava_client_id = $4, strava_client_secret = $5, strava_refresh_token = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7',
      [intervals_api_key || null, intervals_athlete_id || null, target_5k_time || 1140, strava_client_id || null, strava_client_secret || null, strava_refresh_token || null, decoded.userId]
    );

    res.json({ message: 'Configurações atualizadas' });
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
