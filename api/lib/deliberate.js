// api/lib/deliberate.js
// Réfléchir, puis relire : pour les questions difficiles, Octopus écrit un brouillon en silence,
// un « relecteur » interne le critique, puis la réponse finale est livrée (corrigée si besoin).
// Les questions simples (salutations, demandes courtes) passent directement, sans surcoût.

const { chatCompletion } = require('./llm.js');

const HARD_CUES = /\b(pourquoi|comment|explique|compare|analys|strat[ée]g|plan |d[ée]bug|erreur|bug|calcul|combien|prouve|d[ée]montre|[ée]value|choisir|meilleur|diff[ée]rence|avantages|risque|architecture|optimis|corrige|why|how|explain|compare|analy[sz]e|should|best|difference|debug|prove|porqu[eê]|como|explica|compara|analisa|melhor|diferen[cç]a|devo)\b/i;

function needsDeliberation({ text, mode, hasImage }) {
  if (hasImage || mode === 'concise' || mode === 'music') return false;
  const t = String(text || '').trim();
  const hasMath = /\d\s*[-+*/^%]\s*\d/.test(t);
  if (mode === 'code') return t.length > 15;
  if (t.length > 240) return true;
  if (t.length < 25 && !hasMath) return false;
  return HARD_CUES.test(t) || hasMath || (t.match(/\?/g) || []).length >= 2;
}

function criticPrompt(usedWeb) {
  return [
    "Tu es le relecteur interne d'Octopus. Tu reçois une QUESTION et un BROUILLON de réponse. Cherche UNIQUEMENT les vrais problèmes :",
    "- erreurs factuelles, de calcul ou de logique ;",
    "- affirmations inventées ou invérifiables présentées comme certaines (chiffres, sources, URLs, fonctions de bibliothèque) ;",
    "- une partie de la question ignorée ou mal comprise ;",
    "- code qui ne fonctionnerait pas ;",
    "- flatterie ou remplissage qui noie la réponse.",
    'Réponds UNIQUEMENT par un JSON : {"verdict":"ok"|"revise","confidence":0.0-1.0,"problems":["…"],"needs_fresh_info":true|false}.',
    "« revise » seulement pour un défaut réel, jamais pour une question de style. « confidence » = ta confiance que la réponse est correcte et complète. « needs_fresh_info » = true si la réponse dépend d'informations récentes non vérifiées.",
    usedWeb ? 'Le brouillon a déjà consulté le web : needs_fresh_info doit être false.' : ''
  ].filter(Boolean).join('\n');
}

function parseVerdict(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(raw.slice(start, end + 1));
    const verdict = data.verdict === 'revise' ? 'revise' : data.verdict === 'ok' ? 'ok' : null;
    if (!verdict) return null;
    const confidence = Math.min(1, Math.max(0, Number(data.confidence)));
    return {
      verdict,
      confidence: Number.isFinite(confidence) ? confidence : 0.5,
      problems: Array.isArray(data.problems) ? data.problems.map(p => String(p).slice(0, 300)).slice(0, 5) : [],
      needs_fresh_info: data.needs_fresh_info === true
    };
  } catch (e) {
    return null;
  }
}

// Renvoie un verdict, ou null si le relecteur est indisponible (on livre alors le brouillon tel quel)
async function critique({ question, draft, usedWeb, target, completion = chatCompletion }) {
  if (!target) return null;
  try {
    const text = await completion({
      provider: target.provider,
      apiKey: target.apiKey,
      model: target.model,
      temperature: 0.1,
      timeoutMs: 12000,
      messages: [
        { role: 'system', content: criticPrompt(usedWeb) },
        { role: 'user', content: `QUESTION :\n${String(question).slice(0, 3000)}\n\nBROUILLON :\n${String(draft).slice(0, 7000)}` }
      ]
    });
    return parseVerdict(text);
  } catch (error) {
    console.error('[Relecteur] ignoré :', error.message);
    return null;
  }
}

function buildRevisionNote(verdict, { canSearch }) {
  const problems = verdict.problems.length ? verdict.problems.map(p => `- ${p}`).join('\n') : '- (non détaillé)';
  return [
    '[CONTRÔLE QUALITÉ INTERNE : invisible pour l\'utilisateur]',
    'Ta réponse ci-dessus a été relue et présente ces problèmes :',
    problems,
    canSearch && verdict.needs_fresh_info ? 'Vérifie avec tes outils web ce qui dépend d\'informations récentes.' : '',
    "Écris maintenant ta réponse finale COMPLÈTE, corrigée, comme si c'était la première. Ne mentionne ni ce contrôle ni ces problèmes ; ne t'excuse pas."
  ].filter(Boolean).join('\n');
}

module.exports = { needsDeliberation, critique, parseVerdict, buildRevisionNote };
