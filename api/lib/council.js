// api/lib/council.js
// Le CONSEIL : pour les questions difficiles, plusieurs modèles gratuits de familles différentes
// répondent en parallèle ; Octopus compare leurs réponses, tranche les désaccords par le
// raisonnement (pas par la majorité) et écrit la meilleure réponse finale.
// Aucun modèle gratuit n'égale un grand modèle payant, mais un conseil de modèles
// différents se trompe rarement de la même façon : les erreurs se corrigent entre elles.
//
// Membres par défaut (vérifiés sur les pages officielles de Groq et OpenRouter, nov. 2026) :
//   groq        llama-3.3-70b-versatile        (famille Meta)
//   groq        qwen/qwen3.8-27b               (famille Qwen, préversion)
//   openrouter  nvidia/nemotron-3-ultra-550b-a55b:free   (très gros modèle, plus lent)
// Les modèles gratuits changent souvent : remplace-les avec la variable COUNCIL_MODELS,
// par exemple :  groq:llama-3.3-70b-versatile,openrouter:nvidia/nemotron-3-ultra-550b-a55b:free
// Désactiver le conseil : COUNCIL=off

const { chatCompletion } = require('./llm.js');

const DEFAULT_MEMBERS = [
  'groq:llama-3.3-70b-versatile',
  'groq:qwen/qwen3.8-27b',
  'openrouter:nvidia/nemotron-3-ultra-550b-a55b:free'
];
const MEMBER_TIMEOUT_MS = 20000;
const MAX_MEMBERS = 3;
const MAX_ANSWER_CHARS = 5000;

function parseMember(spec) {
  const i = String(spec).indexOf(':');
  if (i < 1) return null;
  return { provider: spec.slice(0, i).trim(), model: spec.slice(i + 1).trim() };
}

// Membres utilisables : clé disponible, et différents du modèle principal
function getMembers(keys, primaryModel, env = process.env) {
  if (String(env.COUNCIL || '').toLowerCase() === 'off') return [];
  const specs = (env.COUNCIL_MODELS ? env.COUNCIL_MODELS.split(',') : DEFAULT_MEMBERS).slice(0, 6);
  const out = [];
  for (const spec of specs) {
    const m = parseMember(spec);
    if (!m || !m.model || m.model === primaryModel) continue;
    const apiKey = keys[m.provider];
    if (!apiKey || !['groq', 'openrouter'].includes(m.provider)) continue;
    out.push({ ...m, apiKey });
    if (out.length >= MAX_MEMBERS) break;
  }
  return out;
}

// Le conseil n'a de sens que pour les questions difficiles « de fond »
function councilAllowed(mode) {
  return mode !== 'code' && mode !== 'concise';
}

// Interroge un membre ; renvoie son texte, ou null s'il échoue (un membre en panne n'arrête rien)
async function askMember({ member, systemPrompt, messages, temperature, completion = chatCompletion }) {
  try {
    const text = await completion({
      provider: member.provider,
      apiKey: member.apiKey,
      model: member.model,
      temperature,
      timeoutMs: MEMBER_TIMEOUT_MS,
      messages: [
        { role: 'system', content: systemPrompt + "\n\nDans cet échange tu n'as accès à aucun outil : réponds directement, et signale clairement ce que tu ne peux pas vérifier." },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ]
    });
    const clean = String(text || '').trim();
    return clean ? { model: member.model, text: clean.slice(0, MAX_ANSWER_CHARS) } : null;
  } catch (error) {
    console.error(`[Conseil] ${member.model} ignoré :`, error.message);
    return null;
  }
}

async function askCouncil({ members, systemPrompt, messages, temperature, completion }) {
  const answers = await Promise.all(members.map(member => askMember({ member, systemPrompt, messages, temperature, completion })));
  return answers.filter(Boolean);
}

// Note interne donnée au modèle principal pour qu'il fasse la synthèse
function buildSynthesisNote(answers) {
  const blocks = answers.map((a, i) => `--- Avis ${String.fromCharCode(66 + i)} ---\n${a.text}`).join('\n\n');
  return [
    "[CONSEIL INTERNE : invisible pour l'utilisateur]",
    "Ta réponse ci-dessus est l'avis A. D'autres modèles ont répondu à la même question :",
    '',
    blocks,
    '',
    "Compare les avis. Là où ils divergent, détermine qui a raison par le raisonnement et, pour les chiffres, avec l'outil calculate : ne suis jamais la majorité aveuglément, un seul avis peut avoir raison. Garde ce qui est juste et utile dans chacun, corrige ce qui est faux, supprime les doublons.",
    "Écris maintenant la réponse finale COMPLÈTE, meilleure que chaque avis, dans le caractère d'Octopus. Ne mentionne ni le conseil, ni les avis, ni d'autres modèles ; ne t'excuse pas."
  ].join('\n');
}

module.exports = { getMembers, councilAllowed, askCouncil, buildSynthesisNote, DEFAULT_MEMBERS };
