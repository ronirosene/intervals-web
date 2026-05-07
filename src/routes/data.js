const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { IntervalsClient } = require('intervals-icu');
const { auth } = require('../middleware/auth');
const { analyzeRuns, generatePlan, syncToCalendar, generateZeroPlan } = require('../services/analysis');
const { query } = require('../db/pg');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', '..', 'uploads') });

// Upload .xlsx
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);
    const runs = data.filter(d => ['Run', 'TrailRun', 'VirtualRun'].includes(d.type));
    const analysis = analyzeRuns(runs);

    await query(
      'INSERT INTO activities (user_id, file_path, total_activities, total_runs, total_distance, avg_pace, avg_hr, weekly_avg) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [req.userId, req.file.filename, data.length, analysis.totalRuns, analysis.totalDist, analysis.avgPace, analysis.avgHR, analysis.avgWeeklyDist]
    );

    res.json({
      message: 'Dados analisados',
      analysis: {
        totalRuns: analysis.totalRuns,
        totalDist: analysis.totalDist.toFixed(1),
        avgPace: analysis.avgPace,
        best5k: analysis.best5k,
        best1k: analysis.best1k,
        avgWeeklyDist: analysis.avgWeeklyDist.toFixed(1),
        longRuns: analysis.longRuns,
        weeklyData: analysis.weeklyData,
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao processar arquivo', details: e.message });
  }
});

// Plano baseado no Upload (Intervals)
router.post('/generate-plan', auth, async (req, res) => {
  const { weeks = 4, target5kMin = 19, planName = 'Meu Plano' } = req.body;

  const last = await query('SELECT file_path FROM activities WHERE user_id = $1 ORDER BY analyzed_at DESC LIMIT 1', [req.userId]);
  if (!last.rows[0]) return res.status(400).json({ error: 'Faça upload dos dados primeiro' });

  const workbook = XLSX.readFile(path.join(__dirname, '..', '..', 'uploads', last.rows[0].file_path));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);
  const runs = data.filter(d => ['Run', 'TrailRun', 'VirtualRun'].includes(d.type));
  const analysis = analyzeRuns(runs);

  const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);
  const userProfile = userResult.rows[0];

  const { plan, zones, best5kPace, target5kPace } = await generatePlan(analysis, userProfile, weeks, target5kMin);

  const result = await query(
    'INSERT INTO training_plans (user_id, plan_name, weeks, plan_data) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.userId, planName, weeks, JSON.stringify({ plan, zones, best5kPace, target5kPace })]
  );

  res.json({
    message: 'Plano gerado', planId: result.rows[0].id,
    weeks, sessions: plan.length, plan,
    zones, best5kPace, target5kPace,
    analysis: { totalRuns: analysis.totalRuns, totalDist: analysis.totalDist.toFixed(1), best5k: analysis.best5k }
  });
});

// Plano do Zero (Iniciante)
router.post('/generate-zero-plan', auth, async (req, res) => {
  const { weeks = 4, daysPerWeek = 3, planName = 'Plano Iniciante' } = req.body;

  const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);
  if (!userResult.rows[0]) return res.status(404).json({ error: 'Usuário não encontrado' });

  const userProfile = userResult.rows[0];
  const { plan, zones, best5kPace, target5kPace } = await generateZeroPlan(userProfile, weeks, daysPerWeek);

  const result = await query(
    'INSERT INTO training_plans (user_id, plan_name, weeks, plan_data) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.userId, planName, weeks, JSON.stringify({ plan, zones, best5kPace, target5kPace })]
  );

  res.json({ message: 'Plano Iniciante gerado', planId: result.rows[0].id, weeks, sessions: plan.length, plan });
});

// Sincronizar com Intervals.icu
router.post('/sync-plan', auth, async (req, res) => {
  const { planId } = req.body;
  const user = await query('SELECT intervals_api_key, intervals_athlete_id FROM users WHERE id = $1', [req.userId]);
  const u = user.rows[0];
  if (!u.intervals_api_key || !u.intervals_athlete_id) {
    return res.status(400).json({ error: 'Configure sua API Key e Athlete ID nas Configurações' });
  }

  const planRecord = await query('SELECT * FROM training_plans WHERE id = $1 AND user_id = $2', [planId, req.userId]);
  if (!planRecord.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });

  const planData = JSON.parse(planRecord.rows[0].plan_data);

  try {
    const client = new IntervalsClient({ apiKey: u.intervals_api_key, athleteId: u.intervals_athlete_id });
    const result = await syncToCalendar(planData.plan, client);
    await query('UPDATE training_plans SET synced = true, synced_at = CURRENT_TIMESTAMP WHERE id = $1', [planId]);
    res.json({ message: 'Plano sincronizado', ...result });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao sincronizar', details: e.message });
  }
});

// Listar planos
router.get('/plans', auth, async (req, res) => {
  const result = await query('SELECT id, plan_name, weeks, plan_data, synced, synced_at, created_at FROM training_plans WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  const plans = result.rows.map(p => ({
    ...p,
    plan_data: typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data,
    synced: !!p.synced
  }));
  res.json({ plans });
});

// Deletar plano
router.delete('/plan/:id', auth, async (req, res) => {
  const { id } = req.params;
  const result = await query('DELETE FROM training_plans WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });
  res.json({ message: 'Plano excluído' });
});

module.exports = router;
