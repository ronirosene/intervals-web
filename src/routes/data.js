const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { IntervalsClient } = require('intervals-icu');
const { auth } = require('../middleware/auth');
const { analyzeRuns, generatePlan, syncToCalendar, generateZeroPlan, generateGoalPlan } = require('../services/analysis');
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

// ===================== REAL-TIME INTERVALS SYNC =====================

// Sincronizar atividades recentes do Intervals.icu
router.post('/sync-activities', auth, async (req, res) => {
  const { days = 7 } = req.body;
  const user = await query('SELECT intervals_api_key, intervals_athlete_id FROM users WHERE id = $1', [req.userId]);
  const u = user.rows[0];
  if (!u.intervals_api_key || !u.intervals_athlete_id) {
    return res.status(400).json({ error: 'Configure sua API Key e Athlete ID nas Configurações' });
  }

  try {
    const client = new IntervalsClient({ apiKey: u.intervals_api_key, athleteId: u.intervals_athlete_id });
    const activities = await client.activities.listActivities();
    const runs = activities.filter(a => ['Run', 'TrailRun', 'VirtualRun'].includes(a.type));

    // Pega só os últimos N dias
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const recent = runs.filter(a => new Date(a.start_date) >= cutoff);

    let imported = 0;
    for (const a of recent) {
      const pace = a.distance > 0 ? a.moving_time / (a.distance / 1000) : 0;
      try {
        await query(
          `INSERT INTO activity_log (user_id, intervals_activity_id, name, type, distance, moving_time, avg_pace, avg_hr, start_date, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (intervals_activity_id) DO NOTHING`,
          [req.userId, a.id, a.name, a.type, a.distance, a.moving_time, pace, a.avg_heart_rate, a.start_date, a.description || '']
        );
        imported++;
      } catch (e) {
        // pula duplicatas
      }
    }

    // Atualiza análise de atividade para o dashboard
    const totalDist = recent.reduce((s, a) => s + (a.distance || 0), 0);
    const totalTime = recent.reduce((s, a) => s + (a.moving_time || 0), 0);
    const avgPace = totalDist > 0 ? totalTime / (totalDist / 1000) : 0;

    res.json({ message: `${imported} atividades importadas`, total: imported, avgPace, totalDist, totalTime });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao sincronizar atividades', details: e.message });
  }
});

// Listar atividades importadas
router.get('/activity-log', auth, async (req, res) => {
  const result = await query(
    'SELECT * FROM activity_log WHERE user_id = $1 ORDER BY start_date DESC LIMIT 50',
    [req.userId]
  );
  res.json({ activities: result.rows });
});

// ===================== DASHBOARD =====================

router.get('/dashboard', auth, async (req, res) => {
  // Última atividade
  const lastAct = await query(
    'SELECT * FROM activity_log WHERE user_id = $1 ORDER BY start_date DESC LIMIT 1',
    [req.userId]
  );

  // Último plano ativo (compara treinos planejados vs realizados)
  const lastPlan = await query(
    'SELECT * FROM training_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [req.userId]
  );

  // Meta ativa (goal_plan)
  const goalPlan = await query(
    'SELECT * FROM goal_plans WHERE user_id = $1 AND active = true ORDER BY created_at DESC LIMIT 1',
    [req.userId]
  );

  // Últimos 30 dias de atividades para análise de confiança
  const recentAct = await query(
    `SELECT * FROM activity_log WHERE user_id = $1 AND start_date >= CURRENT_DATE - INTERVAL '30 days' ORDER BY start_date`,
    [req.userId]
  );

  // Calcula confiança (0-100)
  let confidence = 50;
  let nextWorkout = null;
  let plannedVsActual = null;

  if (lastPlan.rows[0]) {
    const planData = typeof lastPlan.rows[0].plan_data === 'string'
      ? JSON.parse(lastPlan.rows[0].plan_data)
      : lastPlan.rows[0].plan_data;

    if (planData.plan) {
      // Próximo treino agendado (primeiro com data >= hoje)
      const today = new Date().toISOString().split('T')[0];
      const upcoming = planData.plan.find(w => w.date >= today);
      if (upcoming) nextWorkout = upcoming;

      // Compara último treino planejado com atividade real
      const plannedYesterday = planData.plan.filter(w => w.date < today).pop();
      if (plannedYesterday && lastAct.rows[0]) {
        plannedVsActual = {
          planned: { name: plannedYesterday.name, time: plannedYesterday.moving_time },
          actual: { name: lastAct.rows[0].name, distance: lastAct.rows[0].distance, time: lastAct.rows[0].moving_time, pace: lastAct.rows[0].avg_pace },
          completed: !!lastAct.rows[0],
        };
      }
    }
  }

  // Confiança baseada em consistência dos últimos 30 dias
  if (recentAct.rows.length > 0) {
    const totalRuns = recentAct.rows.length;
    const totalDist = recentAct.rows.reduce((s, a) => s + (a.distance || 0), 0);
    const weeksCovered = Math.max(1, Math.ceil(totalRuns / 4));
    const weeklyAvg = totalDist / weeksCovered;

    // Score: 0-100, baseado em frequência e volume
    const freqScore = Math.min(40, (totalRuns / 12) * 40); // ideal: 12+ runs/mês
    const volScore = Math.min(40, (weeklyAvg / 25) * 40);  // ideal: 25km+/semana
    const consistencyScore = Math.min(20, (weeksCovered / 4) * 20);
    confidence = Math.round(freqScore + volScore + consistencyScore);
  }

  // Última atividade com resumo
  let lastActivitySummary = null;
  if (lastAct.rows[0]) {
    const a = lastAct.rows[0];
    const distKm = a.distance ? (a.distance / 1000).toFixed(1) : '0';
    const paceStr = a.avg_pace > 0 ? formatPace(a.avg_pace) : '—';
    lastActivitySummary = {
      name: a.name,
      type: a.type,
      distance: a.distance,
      time: a.moving_time,
      pace: a.avg_pace,
      hr: a.avg_hr,
      date: a.start_date,
      summary: `Corrida de ${distKm}km em ritmo ${paceStr}${a.avg_hr ? ', FC média ' + a.avg_hr : ''}`
    };
  }

  res.json({
    lastActivity: lastAct.rows[0] ? {
      id: lastAct.rows[0].id,
      name: lastAct.rows[0].name,
      distance: lastAct.rows[0].distance,
      time: lastAct.rows[0].moving_time,
      pace: lastAct.rows[0].avg_pace,
      date: lastAct.rows[0].start_date,
    } : null,
    lastActivitySummary,
    nextWorkout,
    plannedVsActual,
    confidence,
    recentActivityCount: recentAct.rows.length,
    goalPlan: goalPlan.rows[0] || null,
  });
});

// Helper inline (também no analysis.js, duplicado aqui para evitar dependência circular)
function formatPace(pace) {
  if (!pace || pace <= 0) return '0:00';
  const min = Math.floor(pace / 60);
  const sec = Math.floor(pace % 60);
  return `${min}:${sec.toString().padStart(2, '0')}/km`;
}

// ===================== GOAL-BASED PLANS =====================

// Criar plano com meta
router.post('/goal-plans', auth, async (req, res) => {
  const { planName, distanceKm, targetTimeSeconds, targetDate, targetPace } = req.body;

  if (!distanceKm || !targetDate) {
    return res.status(400).json({ error: 'Distância e data alvo são obrigatórios' });
  }

  const distOptions = [5, 10, 21.1, 42.2];
  const closest = distOptions.reduce((prev, curr) => Math.abs(curr - distanceKm) < Math.abs(prev - distanceKm) ? curr : prev);
  const actualDist = closest;

  const d1 = new Date();
  const d2 = new Date(targetDate);
  const diffDays = Math.ceil((d2 - d1) / (1000 * 60 * 60 * 24));
  const weeks = Math.max(12, Math.min(52, Math.round(diffDays / 7)));

  const targetPaceValue = targetPace || (targetTimeSeconds / actualDist);
  const actualTimeSeconds = targetTimeSeconds || (targetPaceValue * actualDist);

  const userResult = await query('SELECT name FROM users WHERE id = $1', [req.userId]);
  const userProfile = userResult.rows[0];

  const { plan, summary } = generateGoalPlan({
    distanceKm: actualDist,
    targetTimeSeconds: actualTimeSeconds,
    targetDate,
    weeks,
    planName: planName || `Plano ${actualDist}km`,
  });

  const result = await query(
    `INSERT INTO goal_plans (user_id, plan_name, distance_km, target_time_seconds, target_pace, target_date, weeks, plan_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [req.userId, planName || `Plano ${actualDist}km`, actualDist, actualTimeSeconds, targetPaceValue, targetDate, weeks, JSON.stringify({ plan, summary })]
  );

  // Salva também como training_plan para compatibilidade com sync
  await query(
    `INSERT INTO training_plans (user_id, plan_name, weeks, plan_data, goal_plan_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [req.userId, planName || `Plano ${actualDist}km`, weeks, JSON.stringify({ plan, zones: summary, best5kPace: null, target5kPace: targetPaceValue }), result.rows[0].id]
  );

  res.json({
    message: 'Plano com meta criado!',
    goalPlanId: result.rows[0].id,
    plan,
    summary
  });
});

// Listar goal plans
router.get('/goal-plans', auth, async (req, res) => {
  const result = await query(
    'SELECT * FROM goal_plans WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  );
  const plans = result.rows.map(p => ({
    ...p,
    plan_data: typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data
  }));
  res.json({ plans });
});

module.exports = router;
