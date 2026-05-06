const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { IntervalsClient } = require('intervals-icu');
const { auth } = require('../middleware/auth');
const { analyzeRuns, generatePlan, syncToCalendar } = require('../services/analysis');
const { generateSummary } = require('../services/ai');
const { query } = require('../db/pg');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', '..', 'uploads') });

router.post('/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo não enviado' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet);

    const runs = data.filter(d => ['Run', 'TrailRun', 'VirtualRun'].includes(d.type));
    const analysis = analyzeRuns(runs);

    const userResult = await query('SELECT name, intervals_api_key, intervals_athlete_id, target_5k_time FROM users WHERE id = $1', [req.userId]);
    const userProfile = userResult.rows[0];
    
    const aiSummary = await generateSummary(analysis);

    const result = await query(
      'INSERT INTO activities (user_id, file_path, total_activities, total_runs, total_distance, best_5k_pace, best_5k_time, avg_pace, avg_hr, weekly_avg) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [
        req.userId,
        req.file.filename,
        data.length,
        analysis.totalRuns,
        analysis.totalDist,
        analysis.best5k ? analysis.best5k.pace : null,
        analysis.best5k ? analysis.best5k.time : null,
        analysis.avgPace,
        analysis.avgHR,
        analysis.avgWeeklyDist
      ]
    );

    res.json({
      message: 'Dados analisados',
      aiSummary,
      activityId: result.rows[0].id,
      analysis: {
        totalRuns: analysis.totalRuns,
        totalDist: analysis.totalDist.toFixed(1),
        totalTime: Math.round(analysis.totalTime),
        avgPace: analysis.avgPace,
        avgHR: Math.round(analysis.avgHR),
        best5k: analysis.best5k,
        best1k: analysis.best1k,
        longRuns: analysis.longRuns,
        weeklyData: analysis.weeklyData,
        hrZones: analysis.hrZones,
        avgWeeklyDist: analysis.avgWeeklyDist.toFixed(1),
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao processar arquivo', details: e.message });
  }
});

router.post('/generate-plan', auth, async (req, res) => {
  const { weeks = 4, target5kMin = 19, activityId } = req.body;

  let data;
  if (activityId) {
    const record = await query('SELECT file_path FROM activities WHERE id = $1 AND user_id = $2', [activityId, req.userId]);
    if (record.rows[0]) {
      const workbook = XLSX.readFile(path.join(__dirname, '..', '..', 'uploads', record.rows[0].file_path));
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      data = XLSX.utils.sheet_to_json(sheet);
    }
  }

  if (!data) {
    const allActivities = await query('SELECT file_path FROM activities WHERE user_id = $1 ORDER BY analyzed_at DESC LIMIT 1', [req.userId]);
    if (allActivities.rows[0]) {
      const workbook = XLSX.readFile(path.join(__dirname, '..', '..', 'uploads', allActivities.rows[0].file_path));
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      data = XLSX.utils.sheet_to_json(sheet);
    }
  }

  if (!data) {
    return res.status(400).json({ error: 'Nenhum dado de atividade encontrado. Faça upload primeiro.' });
  }

  const runs = data.filter(d => ['Run', 'TrailRun', 'VirtualRun'].includes(d.type));
  const analysis = analyzeRuns(runs);
  
  const userResult = await query('SELECT name, intervals_api_key, intervals_athlete_id, target_5k_time FROM users WHERE id = $1', [req.userId]);
  const userProfile = userResult.rows[0];
  const planTarget = target5kMin || (userProfile.target_5k_time / 60) || 19;
  
  const { plan, zones, best5kPace, target5kPace } = await generatePlan(analysis, userProfile, weeks, planTarget);

  const result = await query(
    'INSERT INTO training_plans (user_id, weeks, plan_data) VALUES ($1, $2, $3) RETURNING id',
    [req.userId, weeks, JSON.stringify({ plan, zones, best5kPace, target5kPace })]
  );

  res.json({
    message: 'Plano gerado',
    planId: result.rows[0].id,
    weeks,
    sessions: plan.length,
    plan,
    zones,
    best5kPace,
    target5kPace,
    analysis: {
      totalRuns: analysis.totalRuns,
      totalDist: analysis.totalDist.toFixed(1),
      best5k: analysis.best5k,
    }
  });
});

router.post('/sync-plan', auth, async (req, res) => {
  const { planId } = req.body;
  const user = await query('SELECT intervals_api_key, intervals_athlete_id FROM users WHERE id = $1', [req.userId]);
  const u = user.rows[0];

  if (!u.intervals_api_key || !u.intervals_athlete_id) {
    return res.status(400).json({ error: 'Configure sua API Key e Athlete ID nas configurações' });
  }

  const planRecord = await query('SELECT * FROM training_plans WHERE id = $1 AND user_id = $2', [planId, req.userId]);
  if (!planRecord.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });

  const planData = JSON.parse(planRecord.rows[0].plan_data);

  try {
    const client = new IntervalsClient({
      apiKey: u.intervals_api_key,
      athleteId: u.intervals_athlete_id,
    });

    const result = await syncToCalendar(planData.plan, client);

    await query('UPDATE training_plans SET synced = true, synced_at = CURRENT_TIMESTAMP WHERE id = $1', [planId]);

    res.json({ message: 'Plano sincronizado', ...result });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao sincronizar', details: e.message });
  }
});

router.get('/plans', auth, async (req, res) => {
  const plans = await query('SELECT * FROM training_plans WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  res.json({ plans: plans.rows.map(p => ({ ...p, synced: !!p.synced })) });
});

router.get('/activities', auth, async (req, res) => {
  const activities = await query('SELECT * FROM activities WHERE user_id = $1 ORDER BY analyzed_at DESC', [req.userId]);
  res.json({ activities: activities.rows });
});

module.exports = router;
