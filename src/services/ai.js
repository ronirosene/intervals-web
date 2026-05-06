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

module.exports = { generateWorkoutDescription, generateSummary };