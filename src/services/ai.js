const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function generateWorkoutDescription(userProfile, workout) {
  if (!process.env.GEMINI_API_KEY) {
    return `${workout.name}: ${workout.description}`;
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `
Você é um treinador de corrida pessoal, motivacional e didático.
Gere uma explicação clara e motivadora para o seguinte treino:

- **Atleta**: ${userProfile.name}
- **Meta 5K**: ${workout.target5k || '19:00'}
- **Treino**: ${workout.name}
- **Detalhes técnicos**: ${workout.description}
- **Duração prevista**: ${workout.moving_time ? Math.round(workout.moving_time / 60) + ' min' : 'Descanso/Recuperação'}

Instruções:
1. Explique o **objetivo** deste treino na semana (ex: criar base, melhorar velocidade, recuperação).
2. Dê uma **dica técnica ou mental** simples para ajudar na execução.
3. Seja motivador, mas realista. Use emojis.
4. Retorne APENAS o texto, sem markdown extra.
`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    console.error('Gemini AI Error:', error.message);
    return `${workout.name}: ${workout.description}`;
  }
}

async function generateSummary(analysis) {
  if (!process.env.GEMINI_API_KEY) {
    return `Total: ${analysis.totalRuns} corridas | Distância: ${analysis.totalDist.toFixed(1)}km | Melhor 5K: ${analysis.best5k?.time || 'N/A'}`;
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    const prompt = `
Analise os dados de corrida deste atleta e gere um resumo encorajador em 2-3 frases:
- Total de corridas: ${analysis.totalRuns}
- Distância total: ${analysis.totalDist.toFixed(1)} km
- Pace médio: ${analysis.avgPace?.toFixed(2)} s/km
- Melhor 5K: ${analysis.best5k?.time || 'N/A'}
- FC média: ${analysis.avgHR || 'N/A'} bpm
- Foco principal: ${analysis.totalRuns > 20 ? 'Consistência' : 'Progressão inicial'}
`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (error) {
    return `Análise: ${analysis.totalRuns} corridas, ${analysis.totalDist.toFixed(1)}km percorridos.`;
  }
}

module.exports = { generateWorkoutDescription, generateSummary };
