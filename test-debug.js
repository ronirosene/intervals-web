const { buildDetailedDescription, buildWorkoutDoc, generateGoalPlan } = require('./src/services/analysis');

console.log('=== TESTE 1: buildDetailedDescription com zonas realistas ===\n');
const zones = {
  easy: { min: 324, max: 360 },
  marathon: { min: 288, max: 312 },
  threshold: { min: 228, max: 252 },
  vo2Max: { min: 216, max: 228 },
  speed: { min: 204, max: 216 },
};

const tests = [
  ['Easy', 'easy', zones, 2400],
  ['Intervals', 'intervals', zones, 2700],
  ['Tempo', 'tempo', zones, 2700],
  ['Long Run', 'long-run', zones, 5400],
  ['Strides', 'strides', zones, 2100],
  ['Beginner', 'beginner', { easy: { min: 360, max: 420 } }, 1500],
];

for (const [name, tag, z, dur] of tests) {
  const desc = buildDetailedDescription(name, tag, z, dur);
  const hasNA = desc.includes('N/A');
  console.log(name + ':', hasNA ? '❌ CONTEM N/A' : '✅ OK');
  console.log(desc);
  console.log();
}

console.log('=== TESTE 2: workout_doc paces ===\n');
const doc = buildWorkoutDoc('Teste Intervalos', 'intervals', zones, 2700);
function printPaces(steps, indent) {
  for (const s of steps) {
    if (s.pace_min) console.log(indent + 'pace: ' + s.pace_min.value + '-' + s.pace_max.value + ' min/km');
    if (s.steps) printPaces(s.steps, indent + '  ');
  }
}
printPaces(doc.steps, '');

console.log('\n=== TESTE 3: generateGoalPlan - verificando N/A ===\n');
const result = generateGoalPlan({
  distanceKm: 5, targetTimeSeconds: 1200, targetDate: '2026-08-08', weeks: 12
});
const naCount = result.plan.filter(p => (p.description || '').includes('N/A')).length;
console.log('Total de treinos: ' + result.plan.length);
console.log('Treinos com N/A: ' + naCount);
if (naCount > 0) {
  console.log('\nPrimeiros treinos com N/A:');
  result.plan.filter(p => (p.description || '').includes('N/A')).slice(0, 3).forEach(p => {
    console.log('- ' + p.name + ': ' + p.description.substring(0, 150));
  });
}

console.log('\n=== TESTE 4: generatePlan - verificando N/A ===\n');
// Testa com análise mock
const mockAnalysis = {
  totalRuns: 50, totalDist: 400, avgPace: 300,
  best5k: { time: 1200, pace: 240, date: '2026-01-01', name: 'Test' },
  avgWeeklyDist: 25,
  weeklyData: [{ week: '2026-01-01', dist: 25, count: 4, load: 100 }],
  hrZones: [], validRunsCount: 50,
  longRuns: [], avgHR: 150, totalTime: 2000, best1k: null
};

async function testGeneratePlan() {
  const { generatePlan } = require('./src/services/analysis');
  const planResult = await generatePlan(mockAnalysis, { name: 'Teste' }, 4, 19);
  const pNA = planResult.plan.filter(p => (p.description || '').includes('N/A')).length;
  console.log('Total de treinos: ' + planResult.plan.length);
  console.log('Treinos com N/A: ' + pNA);
  if (pNA > 0) {
    planResult.plan.filter(p => (p.description || '').includes('N/A')).slice(0, 3).forEach(p => {
      console.log('- ' + p.name + ': ' + p.description.substring(0, 150));
    });
  }
}
testGeneratePlan().then(() => console.log('\n✅ Testes concluídos!'));
