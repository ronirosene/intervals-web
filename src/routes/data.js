const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { IntervalsClient } = require('intervals-icu');
const { auth } = require('../middleware/auth');
const { analyzeRuns, generatePlan, syncToCalendar, generateZeroPlan } = require('../services/analysis');
const { generateSummary } = require('../services/ai');
const { query } = require('../db/pg');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', '..', 'uploads') });

// Rota para Upload de Arquivo (Existente)
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    const runs = data.filter(d => ['Run', 'TrailRun', 'VirtualRun'].includes(d.type));
    const analysis = analyzeRuns(runs);
    
    // Salva no banco
    const result = await query(
      'INSERT INTO activities (user_id, file_path, total_activities, total_runs, total_distance, avg_pace, avg_hr, weekly_avg) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [req.userId, req.file.filename, data.length, analysis.totalRuns, analysis.totalDist, analysis.avgPace, analysis.avgHR, analysis.avgWeeklyDist]
    );

    res.json({
      message: 'Dados analisados',
      activityId: result.rows[0].id,
      analysis: {
        totalRuns: analysis.totalRuns,
        totalDist: analysis.totalDist.toFixed(1),
        avgPace: analysis.avgPace,
        best5k: analysis.best5k,
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao processar arquivo', details: e.message });
  }
});

// Rota para Gerar Plano a partir de Upload (Existente)
router.post('/generate-plan', auth, async (req, res) => {
  // ... (mantenha a lógica existente aqui, certificando-se de que salva no banco com query) ...
  // Para simplificar, vou focar na nova rota Zero abaixo, mas certifique-se que esta também usa query.insert
});

// Rota NOVA: Gerar Plano do Zero (Iniciante)
router.post('/generate-zero-plan', auth, async (req, res) => {
  const { weeks = 4, daysPerWeek = 3 } = req.body;

  try {
    const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);
    if (!userResult.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    const userProfile = userResult.rows[0];
    
    // Gera o plano usando a lógica para iniciantes
    const { plan, zones, best5kPace, target5kPace } = await generateZeroPlan(userProfile, weeks, daysPerWeek);

    // Salva o plano no banco
    const result = await query(
      'INSERT INTO training_plans (user_id, weeks, plan_data) VALUES ($1, $2, $3) RETURNING id',
      [req.userId, weeks, JSON.stringify({ plan, zones, best5kPace, target5kPace })]
    );

    res.json({
      message: 'Plano Iniciante gerado',
      planId: result.rows[0].id,
      weeks,
      sessions: plan.length,
      plan // Retorna o plano para exibir na hora
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao gerar plano', details: e.message });
  }
});

// Rota para Sincronizar (Existente - Mantenha igual)
router.post('/sync-plan', auth, async (req, res) => {
   // ... código existente ...
});

// Rota para Listar Planos (Corrigida)
router.get('/plans', auth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM training_plans WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
    // Mapeia para garantir que o JSON venha correto
    const plans = result.rows.map(p => ({
      ...p,
      plan_data: typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data
    }));
    res.json({ plans });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao buscar planos' });
  }
});

module.exports = router;