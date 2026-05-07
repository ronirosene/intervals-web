const express = require('express');
const { auth } = require('../middleware/auth');
const { chat } = require('../services/chat');
const { query } = require('../db/pg');

const router = express.Router();

router.post('/', auth, async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Mensagem vazia' });
  }

  try {
    const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);
    const userProfile = userResult.rows[0] || null;

    const response = await chat(message.trim(), userProfile);
    res.json({ response, user: message });
  } catch (e) {
    res.status(500).json({ error: 'Erro no chat' });
  }
});

module.exports = router;
