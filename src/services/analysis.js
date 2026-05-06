const XLSX = require('xlsx');
const { generateWorkoutDescription, generateSummary } = require('./ai');

function formatPace(paceSecPerKm) {
  if (!paceSecPerKm || paceSecPerKm <= 0 || paceSecPerKm > 600) return 'N/A';
  const mins = Math.floor(paceSecPerKm / 60);
  const secs = Math.round(paceSecPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}/km`;
}

function formatTime(totalSeconds) {
  if (!totalSeconds || totalSeconds <= 0) return 'N/A';
  const mins = Math.floor(totalSeconds / 60);
  const secs = Math.round(totalSeconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function parsePaceFromSpeed(speedMs) {
  if (!speedMs || speedMs <= 0) return 0;
  return 1000 / speedMs;
}

function parsePaceFromDistanceTime(distMeters, timeSeconds) {
  if (!distMeters || !timeSeconds || distMeters <= 0 || timeSeconds <= 0) return 0;
  return (timeSeconds / distMeters) * 1000;
}

function analyzeRuns(runs) {
  runs.forEach(r => {
    r.date = r.start_date_local.split('T')[0];
    r.dateObj = new Date(r.start_date_local);
    r.distKm = parseFloat(r.distance || 0) / 1000;
    r.timeSec = parseFloat(r.moving_time || 0);
    r.timeMin = r.timeSec / 60;

    const speedMs = parseFloat(r.average_speed) / 1000;
    r.paceSecKm = parsePaceFromSpeed(speedMs);
    if (r.paceSecKm <= 0 || r.paceSecKm > 600) {
      r.paceSecKm = parsePaceFromDistanceTime(r.distKm * 1000, r.timeSec);
    }
    r.paceMinKm = r.paceSecKm / 60;
    r.avgHR = parseInt(r.average_heartrate) || 0;
    r.maxHR = parseInt(r.max_heartrate) || 0;
    r.trainingLoad = parseFloat(r.icu_training_load) || 0;
    r.elevGain = parseFloat(r.total_elevation_gain || 0);
  });

  runs.sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime());

  const validRuns = runs.filter(r => r.paceSecKm > 60 && r.paceSecKm < 400);
  const avgPace = validRuns.length > 0 ? validRuns.reduce((s, r) => s + r.paceSecKm, 0) / validRuns.length : 0;
  const avgHR = runs.filter(r => r.avgHR > 0).reduce((s, r, i, arr) => s + r.avgHR / arr.length, 0);

  const best5k = runs
    .filter(r => r.distKm >= 4.5 && r.distKm <= 5.5)
    .sort((a, b) => a.timeSec - b.timeSec)[0];

  const best1k = runs
    .filter(r => r.distKm >= 0.9 && r.distKm <= 1.2)
    .sort((a, b) => a.paceSecKm - b.paceSecKm)[0];

  const longRuns = runs
    .filter(r => r.distKm >= 8)
    .sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime())
    .slice(0, 10);

  const weeklyData = calculateWeeklyVolume(runs);
  const hrZones = analyzeHRZones(runs);

  return {
    totalRuns: runs.length,
    totalDist: runs.reduce((s, r) => s + r.distKm, 0),
    totalTime: runs.reduce((s, r) => s + r.timeMin, 0),
    avgPace,
    avgHR,
    best5k: best5k ? { time: best5k.timeSec, pace: best5k.paceSecKm, date: best5k.date, name: best5k.name } : null,
    best1k: best1k ? { time: best1k.timeSec, pace: best1k.paceSecKm, date: best1k.date, name: best1k.name } : null,
    longRuns: longRuns.map(r => ({
      date: r.date,
      distKm: r.distKm.toFixed(1),
      pace: formatPace(r.paceSecKm),
      elev: Math.round(r.elevGain),
      name: r.name
    })),
    weeklyData: weeklyData.slice(-8),
    hrZones: hrZones.filter(z => z.count > 0),
    validRunsCount: validRuns.length,
    avgWeeklyDist: weeklyData.length > 0 ? weeklyData.reduce((s, w) => s + w.dist, 0) / weeklyData.length : 0,
  };
}

function calculateWeeklyVolume(runs) {
  const weeks = new Map();
  runs.forEach(r => {
    const d = r.dateObj;
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    const key = monday.toISOString().split('T')[0];
    if (!weeks.has(key)) weeks.set(key, { dist: 0, count: 0, load: 0 });
    const w = weeks.get(key);
    w.dist += r.distKm;
    w.count++;
    w.load += r.trainingLoad;
  });
  return Array.from(weeks.entries()).map(([week, data]) => ({ week, ...data })).sort((a, b) => a.week.localeCompare(b.week));
}

function analyzeHRZones(runs) {
  const runsWithHR = runs.filter(r => r.avgHR > 0);
  const zones = [
    { zone: 'Z1 Recuperação', min: 0, max: 145, count: 0, totalPace: 0 },
    { zone: 'Z2 Aeróbico', min: 145, max: 153, count: 0, totalPace: 0 },
    { zone: 'Z3 Tempo', min: 153, max: 162, count: 0, totalPace: 0 },
    { zone: 'Z4 Limiar', min: 162, max: 171, count: 0, totalPace: 0 },
    { zone: 'Z5 VO2Max', min: 171, max: 176, count: 0, totalPace: 0 },
    { zone: 'Z6 Anaeróbico', min: 176, max: 181, count: 0, totalPace: 0 },
    { zone: 'Z7 Neuromuscular', min: 181, max: 999, count: 0, totalPace: 0 },
  ];
  runsWithHR.forEach(r => {
    for (const z of zones) {
      if (r.avgHR >= z.min && r.avgHR < z.max) {
        z.count++;
        z.totalPace += r.paceSecKm;
      }
    }
  });
  return zones;
}

async function generatePlan(analysis, userProfile, weeks = 4, target5kMin = 19) {
  const best5kPace = analysis.best5k ? analysis.best5k.pace : analysis.avgPace;
  const target5kPace = target5kMin * 60 / 5;

  const zones = {
    easy: { min: best5kPace * 1.35, max: best5kPace * 1.5 },
    marathon: { min: best5kPace * 1.2, max: best5kPace * 1.3 },
    threshold: { min: best5kPace * 0.95, max: best5kPace * 1.05 },
    vo2Max: { min: best5kPace * 0.9, max: best5kPace * 0.95 },
    speed: { min: best5kPace * 0.85, max: best5kPace * 0.9 },
  };

  const plan = [];
  const today = new Date();
  let current = new Date(today);
  current.setDate(today.getDate() + 1);

  for (let w = 0; w < weeks; w++) {
    const weekNum = w + 1;
    const isRecovery = w % 3 === 2;
    const volume = isRecovery ? 0.75 : 1.0;

    const days = [
      { name: `[S${weekNum}] Easy Run`, desc: `Corrida leve Z2 | Pace: ${formatPace(zones.easy.min)}-${formatPace(zones.easy.max)} | 40-50 min`, time: Math.round(45 * 60 * volume) },
      { name: `[S${weekNum}] Intervalos`, desc: isRecovery ? `Recuperação ativa | 30min leve + 4x30s` : `Aquec 15min + ${6 + w}x400m @ ${formatPace(zones.speed.min)} / 2min trote + 10min leve`, time: Math.round(50 * 60 * (isRecovery ? 0.6 : 1)) },
      { name: `[S${weekNum}] Descanso`, desc: 'Descanso total ou caminhada leve', isRest: true },
      { name: `[S${weekNum}] Tempo Run`, desc: isRecovery ? `20min leve + 10min @ ${formatPace(zones.threshold.min)}` : `Aquec 15min + ${15 + w * 5}min @ ${formatPace(zones.threshold.min)}-${formatPace(zones.threshold.max)} + 10min leve`, time: Math.round((40 + w * 5) * 60 * volume) },
      { name: `[S${weekNum}] Strides + Core`, desc: `20min leve + 6x100m strides + 15min core`, time: Math.round(35 * 60 * volume) },
      { name: `[S${weekNum}] Descanso`, desc: 'Descanso ativo, alongamento', isRest: true },
      { name: `[S${weekNum}] Long Run`, desc: isRecovery ? `Corrida regenerativa | 45min @ Z2` : `Corrida longa | ${60 + w * 5}min @ Z2-Z3`, time: Math.round((60 + w * 5) * 60 * volume) },
    ];

    for (const d of days) {
      const aiDesc = await generateWorkoutDescription(
        { name: userProfile.name }, 
        { ...d, target5k: formatTime(target5kMin * 60) }
      );
      plan.push({
        name: d.name,
        date: current.toISOString().split('T')[0],
        description: aiDesc,
        type: 'Run',
        moving_time: d.isRest ? 0 : d.time,
      });
      current.setDate(current.getDate() + 1);
    }
  }

  return { plan, zones, best5kPace, target5kPace };
}

async function syncToCalendar(plan, client) {
  const today = new Date().toISOString().split('T')[0];
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const events = await client.events.listEvents({ oldest: today, newest: farFuture, category: ['WORKOUT'] });
  for (const e of events) {
    if (e.id) {
      try { await client.events.deleteEvent(e.id); } catch {}
    }
  }

  let created = 0;
  for (const w of plan) {
    try {
      await client.events.createEvent({
        name: w.name,
        start_date_local: `${w.date}T06:30:00`,
        description: w.description,
        category: 'WORKOUT',
        type: w.type,
        moving_time: w.moving_time,
      });
      created++;
    } catch {}
  }
  return { created, total: plan.length };
}

module.exports = { analyzeRuns, generatePlan, syncToCalendar, formatPace, formatTime };
