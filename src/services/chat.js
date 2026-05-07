const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const SYSTEM_PROMPT = `Você é um assistente virtual de corrida, simpático e motivador, do sistema "Roni Treinos IA".

SOBRE O SISTEMA:
- Dashboard em tempo real: última atividade, comparativo planejado vs realizado, próximo treino, nível de confiança (0-100)
- O usuário pode sincronizar atividades direto do Intervals.icu (API) em tempo real, sem precisar de arquivo
- Pode fazer upload de dados do Intervals.icu (.xlsx) para análise histórica
- Pode gerar planos de treino baseados nos dados reais dele
- Pode criar planos "do zero" para iniciantes (caminhada/trote progressivo)
- Pode criar Planos por Meta (5k, 10k, 21k, 42k) com tempo alvo e data específica
- Pode importar CSV do Strava (exportação de dados)
- Pode sincronizar os planos com o relógio via Intervals.icu (com workout_doc estruturado com paces)
- Os planos usam IA (Gemini) para descrever e motivar cada treino
- Há uma FAQ completa explicando o sistema
- Os treinos têm descrições detalhadas com paces específicos (ex: "8x400m @ 3:50-4:00/km")

REGRAS:
1. Seja curto, direto e motivacional (máx 3-4 frases por resposta)
2. Use português brasileiro natural
3. Use emojis com moderação
4. Se perguntarem sobre treino, dê dicas práticas e seguras com paces e durações
5. Se perguntarem como usar o sistema, explique o fluxo: Sincronizar atividades → Dashboard → Gerar Plano (por Meta, Dados ou Iniciante) → Sincronizar com relógio
6. Para iniciantes, recomende: aba "Iniciante" ou "Plano por Meta", 3x/semana
7. NUNCA dê conselhos médicos - recomende um profissional se necessário
8. Se não souber responder algo, seja honesto e sugira a FAQ`;

async function chat(message, userProfile = null) {
  if (!process.env.GEMINI_API_KEY) {
    return getFallbackResponse(message);
  }

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
    
    let context = SYSTEM_PROMPT;
    if (userProfile) {
      context += `\n\nSOBRE O USUÁRIO ATUAL:\n- Nome: ${userProfile.name || 'Usuário'}`;
    }

    const result = await model.generateContent([
      { text: context },
      { text: `Usuário: ${message}\n\nAssistente:` }
    ]);

    const response = result.response.text().trim();
    return response || getFallbackResponse(message);
  } catch (error) {
    console.error('Chat AI Error:', error.message);
    return getFallbackResponse(message);
  }
}

function getFallbackResponse(message) {
  const msg = message.toLowerCase();
  
  if (msg.includes('começ') || msg.includes('inici') || msg.includes('zero') || msg.includes('primeiro')) {
    return "🌱 Que bom te ver aqui! Vá na aba 'Iniciante', escolha quantos dias por semana você pode treinar, e clique em 'Gerar Plano'. Começamos com caminhada leve alternada com trote!";
  }
  if (msg.includes('upload') || msg.includes('arquivo') || msg.includes('excel') || msg.includes('xlsx')) {
    return "📁 Na aba 'Upload', você envia o arquivo .xlsx exportado do Intervals.icu. O sistema analisa seus treinos e depois você pode gerar um plano personalizado baseado no seu desempenho real!";
  }
  if (msg.includes('sincron') || msg.includes('relóg') || msg.includes('garmin') || msg.includes('intervals')) {
    return "🔗 Nas Configurações, coloque sua API Key e Athlete ID do Intervals.icu. Depois de gerar um plano, clique em 'Sincronizar' na aba Planos. Os treinos vão pro seu calendário e pro seu relógio!";
  }
  if (msg.includes('plano') || msg.includes('treino') || msg.includes('correr')) {
    return "🏃 O sistema cria planos progressivos! A cada semana os treinos ficam um pouco mais longos ou intensos, com uma semana de recuperação a cada 3 semanas. Tudo baseado nos seus dados ou no seu nível atual.";
  }
  if (msg.includes('olá') || msg.includes('oi') || msg.includes('bom dia') || msg.includes('boa tarde') || msg.includes('boa noite')) {
    return "Olá! 👋 Sou seu assistente de corrida. Posso ajudar com dúvidas sobre treinos, explicar como usar o sistema, ou dar dicas para começar. O que você precisa?";
  }
  if (msg.includes('obrig') || msg.includes('valeu') || msg.includes('brigad')) {
    return "Por nada! 🏃‍♂️ Continue firme que os resultados vêm. Qualquer dúvida, estou aqui!";
  }
  
  return "Olá! 👋 Posso ajudar com:\n\n🌱 Como começar (plano iniciante)\n📁 Como analisar seus dados (upload)\n🔗 Como sincronizar com o relógio\n🏃 Dúvidas sobre treinos\n\nO que você quer saber?";
}

module.exports = { chat };
