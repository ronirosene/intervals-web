const express = require('express');
const multer = require('multer');
const path = require('path');
const XLSX = require('xlsx');
const { IntervalsClient } = require('intervals-icu');
const { auth } = require('../middleware/auth');
const { analyzeRuns, generatePlan, syncToCalendar, generateZeroPlan, generateGoalPlan } = require('../services/analysis');
const { query } = require('../db/pg');

const router = express.Router();

// Multer configurado com limite de tamanho e filtro de extensão
const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Formato de arquivo não permitido. Use .xlsx, .xls ou .csv'));
  }
});

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
    res.status(500).json({ error: 'Erro ao processar arquivo' });
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
    'INSERT INTO training_plans (user_id, plan_name, weeks, plan_data, current_week) VALUES ($1, $2, $3, $4, 1) RETURNING id',
    [req.userId, planName, weeks, JSON.stringify({ plan, zones, best5kPace, target5kPace })]
  );

  res.json({
    message: 'Plano gerado', planId: result.rows[0].id,
    weeks, sessions: plan.length, plan,
    zones, best5kPace, target5kPace,
    current_week: 1,
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
    'INSERT INTO training_plans (user_id, plan_name, weeks, plan_data, current_week) VALUES ($1, $2, $3, $4, 1) RETURNING id',
    [req.userId, planName, weeks, JSON.stringify({ plan, zones, best5kPace, target5kPace })]
  );

  res.json({ message: 'Plano Iniciante gerado', planId: result.rows[0].id, weeks, sessions: plan.length, plan, current_week: 1 });
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
  const result = await query('SELECT id, plan_name, weeks, plan_data, synced, synced_at, created_at, current_week FROM training_plans WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
  const plans = result.rows.map(p => ({
    ...p,
    plan_data: typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data,
    synced: !!p.synced
  }));
  res.json({ plans });
});

// Deletar plano (e remove treinos sincronizados do Intervals.icu automaticamente)
router.delete('/plan/:id', auth, async (req, res) => {
  const { id } = req.params;

  // Carrega o plano antes de deletar
  const planRecord = await query('SELECT * FROM training_plans WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!planRecord.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });

  const p = planRecord.rows[0];
  const planData = typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data;
  let deletedFromIntervals = false;

  // Se o plano foi sincronizado, remove os treinos do Intervals.icu
  if (p.synced && planData.plan && planData.plan.length > 0) {
    const user = await query('SELECT intervals_api_key, intervals_athlete_id FROM users WHERE id = $1', [req.userId]);
    const u = user.rows[0];
    if (u.intervals_api_key && u.intervals_athlete_id) {
      try {
        const client = new IntervalsClient({ apiKey: u.intervals_api_key, athleteId: u.intervals_athlete_id });

        // Descobre a data mais antiga e mais recente do plano
        const dates = planData.plan.map(w => w.date).filter(Boolean).sort();
        const oldest = dates[0];
        const newest = dates[dates.length - 1];

        if (oldest && newest) {
          // Lista eventos WORKOUT no período
          const futureDate = new Date(newest);
          futureDate.setDate(futureDate.getDate() + 1);
          const events = await client.events.listEvents({
            oldest,
            newest: futureDate.toISOString().split('T')[0],
            category: ['WORKOUT']
          });
          const today = new Date().toISOString().split('T')[0];
          for (const e of events) {
            // Só apaga treinos futuros (hoje em diante), preserva o que já passou
            if (e.id && e.start_date && e.start_date.split('T')[0] >= today) {
              try { await client.events.deleteEvent(e.id); } catch {}
            }
          }
          deletedFromIntervals = true;
        }
      } catch (e) {
        console.error('Erro ao deletar treinos do Intervals:', e.message);
        // Continua mesmo se falhar — o plano é deletado do DB de qualquer forma
      }
    }
  }

  // Deleta o plano do banco
  await query('DELETE FROM training_plans WHERE id = $1 AND user_id = $2', [id, req.userId]);

  res.json({
    message: deletedFromIntervals
      ? 'Plano excluído e treinos removidos do Intervals.icu'
      : 'Plano excluído'
  });
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
    // Busca atividades dos últimos 60 dias
    const oldest = new Date();
    oldest.setDate(oldest.getDate() - 60);
    const activities = await client.activities.listActivities({ oldest: oldest.toISOString().split('T')[0], resolve: true });
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
          [req.userId, a.id, a.name, a.type, a.distance, a.moving_time, pace, a.average_heartrate, a.start_date, a.description || '']
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
    res.status(500).json({ error: 'Erro ao sincronizar atividades: ' + e.message });
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
    'SELECT id, plan_name, weeks, plan_data, current_week, synced, synced_at, created_at FROM training_plans WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
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
      // Filtra apenas semanas liberadas
      const currentWeek = lastPlan.rows[0].current_week || 1;
      const availablePlan = planData.plan.filter(w => {
        if (w.week) return w.week <= currentWeek;
        return true;
      });

      // Próximo treino agendado (primeiro com data >= hoje, dentro semanas liberadas)
      const today = new Date().toISOString().split('T')[0];
      const upcoming = availablePlan.find(w => w.date >= today);
      if (upcoming) nextWorkout = upcoming;

      // Compara último treino planejado dentro semanas liberadas
      const plannedYesterday = availablePlan.filter(w => w.date < today).pop();
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
    `INSERT INTO training_plans (user_id, plan_name, weeks, plan_data, goal_plan_id, current_week)
     VALUES ($1, $2, $3, $4, $5, 1)`,
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

// Detalhes de um plano específico (retorna apenas semanas liberadas)
router.get('/plan/:id', auth, async (req, res) => {
  const { id } = req.params;
  const result = await query('SELECT * FROM training_plans WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });
  const p = result.rows[0];
  const planData = typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data;
  const currentWeek = p.current_week || 1;
  // Filtra apenas semanas liberadas (1 até current_week)
  if (planData.plan) {
    planData.plan = planData.plan.filter(w => {
      if (w.week) return w.week <= currentWeek;
      // Se não tem week, calcula pela data relativa
      return true; // mostra todos se não tiver week (compatibilidade)
    });
  }
  res.json({ plan: { ...p, plan_data: planData, current_week: currentWeek } });
});

// Avançar para próxima semana (com adaptação baseada no rendimento)
router.post('/plan/:id/advance-week', auth, async (req, res) => {
  const { id } = req.params;
  const planRecord = await query('SELECT * FROM training_plans WHERE id = $1 AND user_id = $2', [id, req.userId]);
  if (!planRecord.rows[0]) return res.status(404).json({ error: 'Plano não encontrado' });

  const p = planRecord.rows[0];
  const planData = typeof p.plan_data === 'string' ? JSON.parse(p.plan_data) : p.plan_data;
  const currentWeek = p.current_week || 1;
  const totalWeeks = p.weeks || planData.plan.length / 7 || 4;

  if (currentWeek >= totalWeeks) {
    return res.json({ message: 'Plano completo! Todas as semanas já foram liberadas.', done: true, current_week: currentWeek });
  }

  // Busca atividades recentes para avaliar rendimento
  const activities = await query(
    `SELECT * FROM activity_log WHERE user_id = $1 AND start_date >= CURRENT_DATE - INTERVAL '14 days' ORDER BY start_date`,
    [req.userId]
  );

  // Encontra treinos da semana atual
  const currentWeekWorkouts = planData.plan ? planData.plan.filter(w => w.week === currentWeek || (!w.week && false)) : [];
  const plannedNonRest = currentWeekWorkouts.filter(w => w.moving_time > 0 && w.name && !w.name.toLowerCase().includes('descanso'));
  let completedCount = 0;

  for (const planned of plannedNonRest) {
    // Procura atividade realizada no mesmo dia
    const act = activities.rows.find(a => {
      const aDate = new Date(a.start_date).toISOString().split('T')[0];
      return aDate === planned.date;
    });
    if (act && act.distance > 0) {
      completedCount++;
    }
  }

  const totalNonRest = Math.max(1, plannedNonRest.length);
  const completionRate = completedCount / totalNonRest;

  // Ajuste baseado no rendimento (completion rate)
  let adjustment = 1.0;
  if (completionRate >= 0.8) {
    // Completou 80%+ → aumenta volume em 5% nas próximas semanas
    adjustment = 0.95;
  } else if (completionRate >= 0.6) {
    // Completou 60-80% → mantém progressão normal
    adjustment = 1.0;
  } else if (completionRate >= 0.4) {
    // Completou 40-60% → reduz leve incremento
    adjustment = 1.03;
  }

  // Se completou menos de 40% dos treinos, repete a semana
  if (completionRate < 0.4) {
    // Não avança - repete a semana
    await query('UPDATE training_plans SET current_week = $1 WHERE id = $2', [currentWeek, id]);
    return res.json({
      message: `Você completou apenas ${Math.round(completionRate * 100)}% dos treinos desta semana. Vamos repetir a Semana ${currentWeek}.`,
      advanced: false,
      reason: 'low_completion',
      completionRate: Math.round(completionRate * 100),
      current_week: currentWeek
    });
  }

  // Avança para próxima semana e ajusta treinos futuros
  const nextWeek = currentWeek + 1;

  // Ajusta treinos das próximas semanas baseado no rendimento
  if (planData.plan && adjustment !== 1.0) {
    for (const w of planData.plan) {
      if (w.week && w.week > currentWeek) {
        // Ajusta tempo/moving_time baseado no rendimento
        if (w.moving_time > 0) {
          if (adjustment < 1.0) {
            // Se foi mais rápido, aumenta um pouco o volume
            w.moving_time = Math.round(w.moving_time * (1 + (1 - adjustment) * 0.5));
          } else {
            // Se foi mais lento, mantém volume parecido
            w.moving_time = Math.round(w.moving_time / adjustment);
          }
        }
      }
    }
  }

  // Salva progresso
  const newPlanData = JSON.stringify(planData);
  await query(
    'UPDATE training_plans SET current_week = $1, plan_data = $2 WHERE id = $3',
    [nextWeek, newPlanData, id]
  );

  res.json({
    message: `Semana ${currentWeek} concluída! Avançando para Semana ${nextWeek}.${adjustment < 1.0 ? ' Seu rendimento foi excelente, então aumentamos levemente a intensidade!' : adjustment > 1.0 ? ' Seu rendimento foi moderado, mantivemos a progressão mais suave.' : ''}`,
    advanced: true,
    completionRate: Math.round(completionRate * 100),
    adjustment: adjustment,
    current_week: nextWeek,
    total_weeks: totalWeeks
  });
});

// Helper: estima pace a partir de tempo e distância
function parsePaceFromDuration(timeSec, distM) {
  if (!distM || !timeSec || distM <= 0 || timeSec <= 0) return 0;
  return (timeSec / distM) * 1000;
}

// Upload CSV Strava
router.post('/upload-strava-csv', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo CSV não enviado' });
  try {
    const fs = require('fs');
    const csvContent = fs.readFileSync(req.file.path, 'utf8');
    const lines = csvContent.split('\n');
    const headers = lines[0].split(',');
    let imported = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const vals = lines[i].split(',');
      const row = {};
      headers.forEach((h, idx) => row[h.trim()] = (vals[idx] || '').trim());
      if (row['Activity Type'] && ['Run', 'TrailRun', 'VirtualRun'].includes(row['Activity Type'])) {
        const dist = parseFloat(row['Distance']) || 0;
        const time = parseFloat(row['Elapsed Time']) || parseFloat(row['Moving Time']) || 0;
        const pace = dist > 0 && time > 0 ? time / dist : 0;
        try {
          await query(
            `INSERT INTO activity_log (user_id, intervals_activity_id, name, type, distance, moving_time, avg_pace, avg_hr, start_date, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (intervals_activity_id) DO NOTHING`,
            [req.userId, 'strava_' + i + '_' + Date.now(), row['Activity Name'] || 'Strava Run', row['Activity Type'], dist * 1000, time, pace, parseFloat(row['Average Heart Rate']) || 0, row['Activity Date'] || new Date().toISOString(), row['Activity Description'] || '']
          );
          imported++;
        } catch {}
      }
    }
    fs.unlinkSync(req.file.path);
    res.json({ message: `${imported} atividades importadas do Strava`, total: imported });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao importar CSV: ' + e.message });
  }
});

// ===================== MANUAL ACTIVITY ENTRY =====================

// Adicionar atividade manualmente
router.post('/manual-activity', auth, async (req, res) => {
  const { date, distanceKm, minutes, seconds, heartRate, notes } = req.body;
  if (!date || !distanceKm || distanceKm <= 0) {
    return res.status(400).json({ error: 'Data e distância são obrigatórios' });
  }
  const totalSec = (minutes || 0) * 60 + (seconds || 0);
  const distM = distanceKm * 1000;
  const pace = totalSec > 0 && distM > 0 ? totalSec / distanceKm : 0;
  try {
    await query(
      `INSERT INTO activity_log (user_id, intervals_activity_id, name, type, distance, moving_time, avg_pace, avg_hr, start_date, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [req.userId, 'manual_' + Date.now() + '_' + req.userId, notes || 'Corrida manual', 'Run', distM, totalSec, pace, heartRate || null, date, notes || '']
    );
    res.json({ message: `Atividade de ${distanceKm}km registrada!`, pace });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao registrar: ' + e.message });
  }
});

// ===================== STRAVA LINK IMPORT =====================

// Importar atividade do Strava pelo link
router.post('/strava-import-link', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Link da atividade é obrigatório' });

  // Extrai ID da URL (ex: strava.com/activities/1234567890)
  const match = url.match(/strava\.com\/activities\/(\d+)/i);
  if (!match) return res.status(400).json({ error: 'Link do Strava inválido. Use algo como: https://www.strava.com/activities/1234567890' });

  const activityId = match[1];

  try {
    // Tenta buscar via API se tiver tokens configurados
    const user = await query('SELECT strava_client_id, strava_client_secret, strava_refresh_token FROM users WHERE id = $1', [req.userId]);
    const u = user.rows[0];

    if (u && u.strava_client_id && u.strava_client_secret && u.strava_refresh_token) {
      // Troca refresh token por access token
      const tokenResp = await fetch('https://www.strava.com/api/v3/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: u.strava_client_id,
          client_secret: u.strava_client_secret,
          grant_type: 'refresh_token',
          refresh_token: u.strava_refresh_token,
        }),
      });
      const tokenData = await tokenResp.json();
      const accessToken = tokenData.access_token;
      if (tokenData.refresh_token) {
        await query('UPDATE users SET strava_refresh_token = $1 WHERE id = $2', [tokenData.refresh_token, req.userId]);
      }

      if (accessToken) {
        const actResp = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (actResp.ok) {
          const act = await actResp.json();
          const pace = act.moving_time > 0 && act.distance > 0 ? act.moving_time / (act.distance / 1000) : 0;
          await query(
            `INSERT INTO activity_log (user_id, intervals_activity_id, name, type, distance, moving_time, avg_pace, avg_hr, start_date, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (intervals_activity_id) DO NOTHING`,
            [req.userId, 'strava_' + activityId, act.name || 'Strava Run', act.type || 'Run', act.distance || 0, act.moving_time || 0, pace, act.average_heartrate || null, act.start_date || date, act.description || '']
          );
          return res.json({ message: `✅ "${act.name}" importado do Strava!`, distance: act.distance, moving_time: act.moving_time, pace });
        }
      }
    }

    // Sem API configurada: oferecer entrada manual
    return res.json({
      message: `Link reconhecido! Atividade #${activityId}.`,
      activityId,
      manual: true,
      hint: 'Configure o Strava nas Configurações para importação automática, ou adicione manualmente abaixo.'
    });

  } catch (e) {
    res.status(500).json({ error: 'Erro ao importar: ' + e.message });
  }
});

module.exports = router;
