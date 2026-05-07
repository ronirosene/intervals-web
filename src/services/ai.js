const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inicializa o client com a chave do ambiente
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function generateWorkoutDescription(userProfile, workout) {
  // Se não tiver chave configurada, retorna fallback técnico
  if (!process.env.GEMINI_API_KEY) {
    const desc = workout.description || workout.desc || 'Detalhes não fornecidos';
    return `📋 ${workout.name}: ${desc}`;
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    // Usa 'description' ou 'desc' (corrige o bug de variável)
    const techDetails = workout.description || workout.desc || 'Sem detalhes técnicos.';

    const prompt = `
Você é um treinador de corrida pessoal, motivacional e didático.
Gere uma explicação clara e motivadora para o seguinte treino:

- **Atleta**: ${userProfile.name}
- **Treino**: ${workout.name}
- **Detalhes técnicos**: ${techDetails}
- **Duração prevista**: ${workout.moving_time ? Math.round(workout.moving_time / 60) + ' min' : 'Descanso/Recuperação'}

Instruções:
1. Explique o **objetivo** deste treino na semana (ex: criar base, melhorar velocidade, recuperação).
2. Dê uma **dica técnica ou mental** simples para ajudar na execução.
3. Seja motivador, mas realista. Use emojis.
4. Retorne APENAS o texto da explicação, sem títulos ou "markdown" extra.
`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    
    // Se a IA retornar vazio, usa fallback
    return text || `📋 ${workout.name}: ${techDetails}`;
  } catch (error) {
    console.error('Erro ao gerar texto da IA:', error.message);
    // Fallback em caso de erro
    const desc = workout.description || workout.desc || 'Treino gerado.';
    return `⚠️ ${workout.name}: ${desc}`;
  }
}

async function generateSummary(analysis) {
  if (!process.env.GEMINI_API_KEY) {
    return `Análise técnica: ${analysis.totalRuns} corridas, ${analysis.totalDist.toFixed(1)}km.`;
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    const prompt = `Analise os dados deste corredor e dê um feedback motivacional de 2 frases.
    Dados: ${analysis.totalRuns} corridas, ${analysis.totalDist.toFixed(1)} km no total, pace médio de ${Math.round(analysis.avgPace/60)}min/km.`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    return "Análise concluída com sucesso!";
  }
}

async function generateEvolutionInsight(periodsData, comparison) {
  if (!process.env.GEMINI_API_KEY) {
    return getFallbackInsight(periodsData, comparison);
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    const dataStr = periodsData.map(p =>
      `${p.period}: ${p.totalRuns} corridas, ${p.totalDistanceKm}km, ritmo ${p.avgPace}, ${p.runsPerWeek} corridas/semana, média ${p.avgDistPerRunKm}km/corrida`
    ).join('\n');

    const compStr = comparison ? `
Comparação últimos 3 meses vs 3 meses anteriores:
- Recente: ${comparison.recent3mo.runs} corridas, ${comparison.recent3mo.distKm}km, ${comparison.recent3mo.freq}/semana
- Anterior: ${comparison.prev3mo.runs} corridas, ${comparison.prev3mo.distKm}km, ${comparison.prev3mo.freq}/semana
- Tendência: ${comparison.trend} (${comparison.diff.runsPct > 0 ? '+' : ''}${comparison.diff.runsPct}% em corridas)
` : '';

    const prompt = `Você é um coach de corrida analisando a evolução de um atleta.
Com base nos dados abaixo, gere UM PARÁGRAFO CURTO (2-3 frases) em português brasileiro, motivacional e com emojis, destacando:
- A evolução ou tendência principal
- Um ponto de melhoria ou parabéns específico

Dados de treino por período:
${dataStr}
${compStr}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    return text || getFallbackInsight(periodsData, comparison);
  } catch {
    return getFallbackInsight(periodsData, comparison);
  }
}

function getFallbackInsight(periodsData, comparison) {
  const p = periodsData[0] || {};
  const trend = comparison?.trend || 'estável';
  if (trend === 'crescimento') {
    return `📈 Evolução positiva! Nos últimos 3 meses foram ${p.totalRuns} corridas (${p.totalDistanceKm}km), com média de ${p.runsPerWeek} por semana. Continue assim que a consistência está trazendo resultados! 🏃‍♂️`;
  } else if (trend === 'queda') {
    return `📉 Nos últimos 3 meses você fez ${p.totalRuns} corridas. Que tal retomar a regularidade? Mesmo 2x por semana já mantém a base! 💪`;
  }
  return `🏃‍♂️ Nos últimos 3 meses: ${p.totalRuns} corridas, ${p.totalDistanceKm}km percorridos, ritmo médio de ${p.avgPace}. Mantenha a consistência que os resultados aparecem!`;
}

module.exports = { generateWorkoutDescription, generateSummary, generateEvolutionInsight };