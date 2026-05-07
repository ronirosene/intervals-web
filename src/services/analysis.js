const XLSX = require('xlsx');
const { generateWorkoutDescription } = require('./ai');

// ===================== HELPERS =====================

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

// ===================== WORKOUT_DOC BUILDER =====================

const STEPS = {
  warmup: (sec, paceLow, paceHigh) => ({
    type: 'warmup',
    duration: { value: sec, unit: 'seconds' },
    pace_min: { value: paceLow, unit: 'min_per_km' },
    pace_max: { value: paceHigh, unit: 'min_per_km' },
  }),
  work: (sec, paceLow, paceHigh) => ({
    type: 'work',
    duration: { value: sec, unit: 'seconds' },
    pace_min: { value: paceLow, unit: 'min_per_km' },
    pace_max: { value: paceHigh, unit: 'min_per_km' },
  }),
  recovery: (sec, paceLow, paceHigh) => ({
    type: 'recovery',
    duration: { value: sec, unit: 'seconds' },
    pace_min: { value: paceLow, unit: 'min_per_km' },
    pace_max: { value: paceHigh, unit: 'min_per_km' },
  }),
  cooldown: (sec, paceLow, paceHigh) => ({
    type: 'cooldown',
    duration: { value: sec, unit: 'seconds' },
    pace_min: { value: paceLow, unit: 'min_per_km' },
    pace_max: { value: paceHigh, unit: 'min_per_km' },
  }),
  repeat: (repeats, steps) => ({
    type: 'repeat',
    repeats,
    steps,
  }),
};

function paceMinPerKmToStr(minPerKm) {
  const totalSec = Math.round(minPerKm * 60);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function stepsToIntervalsSyntax(steps) {
  if (!steps || !steps.length) return '';
  const lines = [];
  for (const step of steps) {
    if (step.type === 'repeat') {
      lines.push('');
      lines.push(`${step.repeats}x`);
      for (const s of (step.steps || [])) {
        const dur = `${Math.round(s.duration.value / 60)}m`;
        const pace = `${paceMinPerKmToStr(s.pace_min.value)}-${paceMinPerKmToStr(s.pace_max.value)}/km Pace`;
        lines.push(`- ${dur} ${pace}`);
      }
      lines.push('');
    } else {
      const dur = `${Math.round(step.duration.value / 60)}m`;
      const pace = `${paceMinPerKmToStr(step.pace_min.value)}-${paceMinPerKmToStr(step.pace_max.value)}/km Pace`;
      lines.push(`- ${dur} ${pace}`);
    }
  }
  return lines.join('\n');
}

function buildWorkoutDoc(name, typeTag, zones, durationSec) {
  const easyPace = zones.easy ? (zones.easy.min + zones.easy.max) / 2 / 60 : 5.5;
  const marathonPace = zones.marathon ? (zones.marathon.min + zones.marathon.max) / 2 / 60 : 5.0;
  const thresholdPace = zones.threshold ? (zones.threshold.min + zones.threshold.max) / 2 / 60 : 4.5;
  const speedPace = zones.speed ? (zones.speed.min + zones.speed.max) / 2 / 60 : 4.0;

  const warmSec = 600;
  const coolSec = 300;

  let steps = [];
  switch (typeTag) {
    case 'easy': {
      const runSec = Math.max(600, durationSec);
      steps = [
        STEPS.warmup(300, easyPace + 1, easyPace + 1.5),
        STEPS.work(runSec, easyPace, marathonPace),
        STEPS.cooldown(300, easyPace + 0.5, easyPace + 1.5),
      ];
      break;
    }
    case 'intervals': {
      const reps = Math.max(4, Math.min(10, Math.floor(durationSec / 300)));
      const workRepSec = Math.floor(durationSec / reps / 2);
      const recRepSec = Math.max(90, Math.floor(workRepSec * 0.4));
      steps = [
        STEPS.warmup(warmSec, easyPace + 0.5, easyPace + 1),
        STEPS.repeat(reps, [
          STEPS.work(workRepSec, speedPace - 0.2, speedPace + 0.2),
          STEPS.recovery(recRepSec, easyPace, easyPace + 1),
        ]),
        STEPS.cooldown(coolSec, easyPace + 0.5, easyPace + 1.5),
      ];
      break;
    }
    case 'tempo': {
      const tempoSec = Math.max(600, durationSec);
      steps = [
        STEPS.warmup(warmSec, easyPace + 0.5, easyPace + 1),
        STEPS.work(tempoSec, thresholdPace - 0.15, thresholdPace + 0.15),
        STEPS.cooldown(coolSec, easyPace + 0.5, easyPace + 1.5),
      ];
      break;
    }
    case 'strides': {
      const easyRunSec = Math.max(600, durationSec - 360);
      steps = [
        STEPS.warmup(300, easyPace + 0.5, easyPace + 1),
        STEPS.repeat(6, [
          STEPS.work(30, speedPace - 0.5, speedPace - 0.3),
          STEPS.recovery(60, easyPace, easyPace + 0.5),
        ]),
        STEPS.work(easyRunSec, easyPace, marathonPace),
        STEPS.cooldown(300, easyPace + 0.5, easyPace + 1.5),
      ];
      break;
    }
    case 'long':
    case 'long-run': {
      const runSec = Math.max(1800, durationSec);
      steps = [
        STEPS.warmup(300, easyPace + 0.5, easyPace + 1),
        STEPS.work(runSec, easyPace, marathonPace),
        STEPS.cooldown(300, easyPace + 0.5, easyPace + 1.5),
      ];
      break;
    }
    case 'beginner': {
      if (durationSec < 1200) {
        steps = [STEPS.work(durationSec, easyPace + 1, easyPace + 2)];
      } else {
        const jogBlocks = Math.max(3, Math.floor(durationSec / 480));
        const jogSec = Math.floor(60);
        const walkSec = Math.floor(120);
        steps = [
          STEPS.warmup(300, easyPace + 1, easyPace + 2),
          STEPS.repeat(jogBlocks, [
            STEPS.work(jogSec, easyPace + 0.5, easyPace + 1.5),
            STEPS.recovery(walkSec, easyPace + 2, easyPace + 3),
          ]),
          STEPS.cooldown(300, easyPace + 1.5, easyPace + 3),
        ];
      }
      break;
    }
    default: {
      steps = [
        STEPS.warmup(300, easyPace + 0.5, easyPace + 1),
        STEPS.work(durationSec, easyPace, marathonPace),
        STEPS.cooldown(300, easyPace + 0.5, easyPace + 1.5),
      ];
    }
  }

  return {
    sport: 'run',
    name: name,
    steps,
  };
}

// Gera descrição textual detalhada igual ao workout_doc
function buildDetailedDescription(name, typeTag, zones, durationSec) {
  if (!durationSec || durationSec <= 0) return `🏃‍♂️ ${name}\n🎯 Descanso ou recuperação ativa`;
  const easy = zones.easy || { min: 360, max: 420 };
  const marathon = zones.marathon || { min: 330, max: 360 };
  const threshold = zones.threshold || { min: 300, max: 330 };
  const speed = zones.speed || { min: 240, max: 270 };

  const fp = (s) => formatPace(s);
  const min = (s) => Math.round(s / 60);

  switch (typeTag) {
    case 'easy':
      return `🏃‍♂️ Corrida leve aeróbica\n📏 Aquecimento: 5min @ ${fp(easy.max * 1.1)}-${fp(easy.max * 1.2)}\n🎯 Principal: ${min(durationSec)}min @ ${fp(easy.min)}-${fp(easy.max)} (Z2)\n🏁 Desaquecimento: 5min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}`;
    case 'intervals': {
      const reps = Math.max(4, Math.min(10, Math.floor(durationSec / 300)));
      const workSec = Math.floor(durationSec / reps / 2);
      const recSec = Math.max(90, Math.floor(workSec * 0.4));
      const workMin = Math.round(workSec / 60);
      return `⚡ Treino de tiros (${reps}x)\n🔥 Aquecimento: 10min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}\n🎯 ${reps}x${workMin == 1 ? '400m' : workMin == 2 ? '800m' : workMin + 'min'} @ ${fp(speed.min)}-${fp(speed.max)} (recup ${Math.round(recSec / 60)}min trote @ ${fp(easy.min)}-${fp(easy.max)})\n🏁 Desaquecimento: 5min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}`;
    }
    case 'tempo': {
      const tempoMin = Math.max(10, min(durationSec));
      return `🔥 Treino de ritmo (Tempo Run)\n🔥 Aquecimento: 10min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}\n🎯 ${tempoMin}min @ ${fp(threshold.min)}-${fp(threshold.max)} (Z4)\n🏁 Desaquecimento: 5min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}`;
    }
    case 'strides':
      return `⚡ Strides + Core\n🏃‍♂️ Aquecimento: 5min leve\n🎯 6x100m strides (30s rápido, 60s trote) @ ${fp(speed.min)}-${fp(speed.max)}\n🎯 Corrida leve: ${min(durationSec - 360)}min @ ${fp(easy.min)}-${fp(marathon.max)}\n🏁 Desaquecimento + core: 10min`;
    case 'long':
    case 'long-run':
      return `🏃‍♂️ Corrida Longa\n🔥 Aquecimento: 5min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}\n🎯 ${min(durationSec)}min @ ${fp(easy.min)}-${fp(marathon.max)} (Z2-Z3)\n🏁 Desaquecimento: 5min @ ${fp(easy.max)}-${fp(easy.max * 1.1)}`;
    case 'beginner':
      return `🌱 Treino Iniciante\n🎯 ${min(durationSec)}min alternando trote + caminhada\n💡 Trote: ritmo confortável (@ ${fp(easy.min)}-${fp(easy.max)})\n💡 Caminhada: ritmo bem leve para recuperar o fôlego`;
    default:
      return `🏃‍♂️ ${name}\n🎯 ${min(durationSec)}min @ ${fp(easy.min)}-${fp(marathon.max)}`;
  }
}

// ===================== ANALYSIS =====================

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

// ===================== PLAN GENERATORS =====================

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

    const dayDefs = [
      { name: `[S${weekNum}] Easy Run`, tag: 'easy', desc: `Corrida leve Z2 | Pace: ${formatPace(zones.easy.min)}-${formatPace(zones.easy.max)} | 40-50 min`, time: Math.round(45 * 60 * volume) },
      { name: `[S${weekNum}] Intervalos`, tag: 'intervals', desc: isRecovery ? `Recuperação ativa | 30min leve + 4x30s` : `Aquec 15min + ${6 + w}x400m @ ${formatPace(zones.speed.min)} / 2min trote + 10min leve`, time: Math.round(50 * 60 * (isRecovery ? 0.6 : 1)) },
      { name: `[S${weekNum}] Descanso`, tag: 'rest', desc: 'Descanso total ou caminhada leve', isRest: true },
      { name: `[S${weekNum}] Tempo Run`, tag: 'tempo', desc: isRecovery ? `20min leve + 10min @ ${formatPace(zones.threshold.min)}` : `Aquec 15min + ${15 + w * 5}min @ ${formatPace(zones.threshold.min)}-${formatPace(zones.threshold.max)} + 10min leve`, time: Math.round((40 + w * 5) * 60 * volume) },
      { name: `[S${weekNum}] Strides + Core`, tag: 'strides', desc: `20min leve + 6x100m strides + 15min core`, time: Math.round(35 * 60 * volume) },
      { name: `[S${weekNum}] Descanso`, tag: 'rest', desc: 'Descanso ativo, alongamento', isRest: true },
      { name: `[S${weekNum}] Long Run`, tag: 'long-run', desc: isRecovery ? `Corrida regenerativa | 45min @ Z2` : `Corrida longa | ${60 + w * 5}min @ Z2-Z3`, time: Math.round((60 + w * 5) * 60 * volume) },
    ];

    for (const d of dayDefs) {
      const aiDesc = await generateWorkoutDescription(
        { name: userProfile.name },
        { ...d, target5k: formatTime(target5kMin * 60) }
      );
      const detailedDesc = buildDetailedDescription(d.name, d.tag, zones, d.time);
      const fullDesc = `${detailedDesc}\n\n💡 ${aiDesc}`;

      const entry = {
        name: d.name,
        date: current.toISOString().split('T')[0],
        description: fullDesc,
        type: 'Run',
        moving_time: d.isRest ? 0 : d.time,
        detailedPlan: detailedDesc,
        week: weekNum,
        workout_doc: d.isRest ? undefined : buildWorkoutDoc(d.name, d.tag, zones, d.time),
      };

      plan.push(entry);
      current.setDate(current.getDate() + 1);
    }
  }

  return { plan, zones, best5kPace, target5kPace };
}

async function generateZeroPlan(userProfile, weeks = 4, daysPerWeek = 3) {
  const plan = [];
  const today = new Date();
  let current = new Date(today);
  current.setDate(today.getDate() + 1);

  let runDays = [1, 3, 5];
  if (daysPerWeek === 2) runDays = [1, 4];
  if (daysPerWeek === 4) runDays = [1, 2, 4, 5];
  if (daysPerWeek === 5) runDays = [1, 2, 3, 4, 5];

  // Use beginner-friendly paces (6-7 min/km como Easy)
  const beginnerZones = {
    easy: { min: 360, max: 420 },
    marathon: { min: 330, max: 360 },
    threshold: { min: 300, max: 330 },
    vo2Max: { min: 270, max: 300 },
    speed: { min: 240, max: 270 },
  };

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const isRunDay = runDays.includes(d);

      if (!isRunDay) {
        plan.push({
          name: `[S${w + 1}] Descanso`,
          date: current.toISOString().split('T')[0],
          description: 'Descanso total ou caminhada leve de 15 min.',
          type: 'Run',
          moving_time: 0,
          week: w + 1,
        });
        current.setDate(current.getDate() + 1);
        continue;
      }

      const duration = 25 + (w * 5);
      const time = duration * 60;
      const desc = `Comece com 5min de caminhada. Alterne 1min trote leve / 2min caminhada por ${duration} minutos. Foco na respiração.`;
      const name = `[S${w + 1}] Caminhada/Trote`;

      const aiDesc = await generateWorkoutDescription(
        { name: userProfile.name },
        { name, description: desc, moving_time: time }
      );
      const detailedDesc = buildDetailedDescription(name, 'beginner', beginnerZones, time);

      plan.push({
        name,
        date: current.toISOString().split('T')[0],
        description: `${detailedDesc}\n\n💡 ${aiDesc}`,
        detailedPlan: detailedDesc,
        type: 'Run',
        moving_time: time,
        week: w + 1,
        workout_doc: buildWorkoutDoc(name, 'beginner', beginnerZones, time),
      });

      current.setDate(current.getDate() + 1);
    }
  }

  return { plan, zones: {}, best5kPace: 0, target5kPace: 0 };
}

// ===================== SYNC =====================

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
      const eventData = {
        name: w.name,
        start_date_local: `${w.date}T06:30:00`,
        description: w.description,
        category: 'WORKOUT',
        type: w.type,
        moving_time: w.moving_time,
      };
      if (w.workout_doc) {
        const syntax = stepsToIntervalsSyntax(w.workout_doc.steps);
        if (syntax) {
          eventData.description = syntax;
        }
      }
      await client.events.createEvent(eventData);
      created++;
    } catch (e) {
      console.error('Sync error:', w.name, e.message);
    }
  }
  return { created, total: plan.length };
}

module.exports = { analyzeRuns, generatePlan, syncToCalendar, formatPace, formatTime, generateZeroPlan, generateGoalPlan, buildDetailedDescription };

// ===================== GOAL-BASED PLAN GENERATOR =====================

function generateGoalPlan(params) {
  const { distanceKm, targetTimeSeconds, targetDate, weeks, planName, current5kPace } = params;
  const targetPace = targetTimeSeconds / distanceKm;
  const now = new Date();

  const zones = {
    easy: { min: targetPace * 1.35, max: targetPace * 1.5 },
    marathon: { min: targetPace * 1.2, max: targetPace * 1.3 },
    threshold: { min: targetPace * 0.95, max: targetPace * 1.05 },
    vo2Max: { min: targetPace * 0.9, max: targetPace * 0.95 },
    speed: { min: targetPace * 0.85, max: targetPace * 0.9 },
    racePace: { min: targetPace * 0.97, max: targetPace * 1.0 },
  };

  const plan = [];
  const phases = ['Base', 'Build', 'Race Prep', 'Taper'];
  const phaseWeeks = [Math.ceil(weeks * 0.4), Math.ceil(weeks * 0.35), Math.ceil(weeks * 0.15), Math.max(2, weeks - Math.ceil(weeks * 0.4) - Math.ceil(weeks * 0.35) - Math.ceil(weeks * 0.15))];

  // Distances for key workouts
  const longRunDist = Math.min(distanceKm, Math.max(5, Math.round(distanceKm * 0.6)));

  let weekIdx = 0;
  for (let phase = 0; phase < phases.length; phase++) {
    for (let pw = 0; pw < phaseWeeks[phase]; pw++) {
      weekIdx++;
      const isRecovery = pw % 3 === 2;
      const volFactor = isRecovery ? 0.7 : 1.0;
      const phaseName = phases[phase];
      const weekPct = weekIdx / weeks;
      const weekKm = Math.round((5 + (distanceKm * 0.15) * weekPct) * volFactor);

      const days = [
        {
          name: `[S${weekIdx}] Easy Run`,
          tag: 'easy',
          desc: `Fase ${phaseName} | Corrida leve Z2 | ${Math.round(30 * volFactor)} min`,
          time: Math.round(30 * 60 * volFactor),
        },
        {
          name: `[S${weekIdx}] Treino Específico`,
          tag: phase === 0 ? 'tempo' : phase === 1 ? 'intervals' : 'tempo',
          desc: phase === 0
            ? `Fase ${phaseName} | ${Math.round(8 * volFactor)}x400m progressivos`
            : `Fase ${phaseName} | ${Math.round(6 - phase + 3)}x${distanceKm < 15 ? 1000 : 2000}m @ ritmo de prova / 3min descanso`,
          time: Math.round(45 * 60 * volFactor),
        },
        {
          name: `[S${weekIdx}] Descanso`,
          tag: 'rest',
          desc: 'Descanso total',
          isRest: true,
          time: 0,
        },
        {
          name: `[S${weekIdx}] Tempo Run`,
          tag: 'tempo',
          desc: `Fase ${phaseName} | ${Math.round(15 * volFactor + weekIdx * 2)}min @ ${formatPace(zones.threshold.min * 60)}`,
          time: Math.round((20 + weekIdx * 2) * 60 * volFactor),
        },
        {
          name: `[S${weekIdx}] Regenerativo`,
          tag: 'easy',
          desc: `Fase ${phaseName} | 25min leve + alongamento`,
          time: Math.round(25 * 60 * volFactor),
        },
        {
          name: `[S${weekIdx}] Descanso`,
          tag: 'rest',
          desc: 'Descanso ativo',
          isRest: true,
          time: 0,
        },
        {
          name: `[S${weekIdx}] Long Run`,
          tag: 'long-run',
          desc: `Fase ${phaseName} | ${phase === 3 ? `Simulado: ${Math.round(distanceKm * 0.6)}km` : `Longo: ${Math.round(weekKm * 1.5)}km`} @ ritmo de prova + 10%`,
          time: Math.round((35 + weekIdx * 3) * 60 * volFactor),
        },
      ];

      for (const d of days) {
        const date = new Date(now);
        date.setDate(date.getDate() + (plan.length));
        const detailedDesc = d.isRest ? d.desc : buildDetailedDescription(d.name, d.tag, zones, d.time);
        plan.push({
          name: d.name,
          date: date.toISOString().split('T')[0],
          description: d.isRest ? d.desc : `${detailedDesc}\n📌 ${d.desc}`,
          detailedPlan: detailedDesc,
          type: 'Run',
          moving_time: d.isRest ? 0 : Math.max(1, d.time),
          week: weekIdx,
          phase: phaseName,
          volumeKm: weekKm,
          workout_doc: d.isRest ? undefined : buildWorkoutDoc(d.name, d.tag, zones, d.time),
        });
      }
    }
  }

  const summary = {
    distanceKm,
    targetTime: formatTime(targetTimeSeconds),
    targetPace: formatPace(targetPace * 60),
    weeks,
    sessions: plan.length,
    phases: phases.map((name, i) => ({ name, weeks: phaseWeeks[i], focus: i === 0 ? 'Base aeróbica' : i === 1 ? 'Desenvolvimento' : i === 2 ? 'Afinamento' : 'Recuperação' })),
  };

  return { plan, summary, zones };
}
