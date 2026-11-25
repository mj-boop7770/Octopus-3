// api/lib/memory.js
// Mémoire à long terme d'Octopus : les souvenirs vivent dans le NAVIGATEUR de l'utilisateur
// (localStorage). Le serveur n'a aucune base de données : zéro coût, zéro fuite côté serveur,
// et l'utilisateur voit, corrige et efface tout depuis le panneau « Mémoire ».
//
// Cycle : le navigateur envoie ses souvenirs -> le serveur choisit les plus pertinents pour la
// question -> après la réponse, il propose de NOUVEAUX souvenirs (événement {t:'memory'}) que le
// navigateur enregistre.

const { chatCompletion } = require('./llm.js');

const MAX_MEMORIES = 80;
const MAX_FACT_CHARS = 200;
const MAX_RECALL = 8;
const MAX_RECALL_CHARS = 1400;

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');
}

const STOPWORDS = new Set((
  'le la les un une des de du et ou en au aux que qui est sont pour par sur dans avec sans pas ce cet cette ces mon ma mes ton ta tes son sa ses ' +
  'je tu il elle nous vous ils elles me te se ne plus tres the and for with that this you are was has have not but your from ' +
  'um uma uns umas os as do da dos das em no na nos nas por para com sem que meu minha teu tua seu sua nao mais'
).split(' '));

function tokens(text) {
  return normalize(text).split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

// Refuse de garder des secrets : clés, mots de passe, longs numéros (cartes, comptes, pièces d'identité…)
function looksSensitive(text) {
  const t = String(text || '');
  return (
    /\b(gsk_|sk-|ghp_|github_pat_|AIza|hf_|xox[bp]-)[A-Za-z0-9_-]{8,}/.test(t) ||
    /\d[\d\s.-]{8,}\d/.test(t) ||
    /(mot de passe|password|senha|passwd|api[ _-]?key|token secret|code pin|\bpin\b)/i.test(t)
  );
}

function cleanFact(text) {
  return String(text || '').replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
}

// Valide la liste envoyée par le navigateur (jamais de confiance aveugle)
function sanitizeMemories(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, MAX_MEMORIES)) {
    const text = cleanFact(typeof item === 'string' ? item : item && item.t);
    if (!text || looksSensitive(text)) continue;
    const ts = item && Number.isFinite(item.ts) ? item.ts : 0;
    out.push({ t: text, ts });
  }
  return out;
}

// Choisit les souvenirs utiles pour cette question (recouvrement de mots + un peu de fraîcheur)
function selectRelevant(memories, query, limit = MAX_RECALL) {
  const list = sanitizeMemories(memories);
  if (!list.length) return [];
  const q = new Set(tokens(query));
  const newest = Math.max(...list.map(m => m.ts || 0), 1);

  const scored = list.map(m => {
    const words = tokens(m.t);
    let overlap = 0;
    for (const w of words) if (q.has(w)) overlap += 1;
    const recency = (m.ts || 0) / newest; // 0..1
    return { text: m.t, score: overlap * 3 + recency };
  });

  const relevant = scored.filter(s => s.score >= 3).sort((a, b) => b.score - a.score);
  // Les 3 souvenirs les plus récents servent de contexte de base (qui est l'utilisateur)
  const recent = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 3).map(m => ({ text: m.t, score: 0 }));

  const picked = [];
  const seen = new Set();
  let chars = 0;
  for (const s of [...relevant, ...recent]) {
    if (picked.length >= limit || seen.has(s.text)) continue;
    if (chars + s.text.length > MAX_RECALL_CHARS) break;
    seen.add(s.text);
    picked.push(s.text);
    chars += s.text.length;
  }
  return picked;
}

// Ne dépense un appel de modèle que si le message ressemble à une information personnelle durable
const PERSONAL_CUE = /(?:^|[^\p{L}])(?:je|moi|mon|ma|mes|notre|nos|eu|meu|minha|meus|minhas|chamo-me|i|my|our|retiens|souviens|remember|lembra)(?![\p{L}])|(?:^|[^\p{L}])j['’]\p{L}/iu;

function shouldExtract(userMessage) {
  const t = String(userMessage || '').trim();
  return t.length >= 12 && t.length <= 4000 && PERSONAL_CUE.test(t);
}

function parseFacts(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const data = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(data.facts) ? data.facts.filter(f => typeof f === 'string') : [];
  } catch (e) {
    return [];
  }
}

function similar(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return false;
  let common = 0;
  for (const w of A) if (B.has(w)) common += 1;
  return common / Math.min(A.size, B.size) >= 0.7;
}

// Filtre final : pas de doublons, pas de secrets, pas de phrases trop courtes
function filterNewFacts(candidates, existing) {
  const known = sanitizeMemories(existing).map(m => m.t);
  const out = [];
  for (const c of candidates) {
    const fact = cleanFact(c);
    if (fact.length < 8 || looksSensitive(fact)) continue;
    if ([...known, ...out].some(k => similar(k, fact))) continue;
    out.push(fact);
    if (out.length >= 3) break;
  }
  return out;
}

const EXTRACT_PROMPT = [
  "Tu es le module de mémoire d'Octopus. On te donne un échange entre un utilisateur et l'assistant.",
  "Extrais 0 à 3 faits DURABLES et utiles sur l'UTILISATEUR (identité professionnelle, projets, préférences, contraintes, objectifs, contexte de vie qu'il a lui-même énoncé), pour mieux l'aider plus tard.",
  "Règles : uniquement ce que l'utilisateur a dit explicitement (jamais d'invention, jamais ce que dit l'assistant) ; une phrase courte à la troisième personne, dans la langue de l'utilisateur ; ignore les états passagers, les questions ponctuelles, et tout secret (mots de passe, clés, numéros).",
  'Réponds UNIQUEMENT par du JSON : {"facts":["…"]}. Si rien de durable : {"facts":[]}.'
].join('\n');

async function extractFacts({ userMessage, answer, existing, target, completion = chatCompletion }) {
  if (!target) return [];
  try {
    const text = await completion({
      provider: target.provider,
      apiKey: target.apiKey,
      model: target.model,
      temperature: 0.1,
      timeoutMs: 9000,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: `UTILISATEUR : ${String(userMessage).slice(0, 2000)}\n\nASSISTANT : ${String(answer || '').slice(0, 800)}` }
      ]
    });
    return filterNewFacts(parseFacts(text), existing);
  } catch (error) {
    console.error('[Mémoire] extraction ignorée :', error.message);
    return [];
  }
}

module.exports = {
  sanitizeMemories, selectRelevant, shouldExtract, extractFacts,
  filterNewFacts, parseFacts, looksSensitive, similar, MAX_MEMORIES
};
