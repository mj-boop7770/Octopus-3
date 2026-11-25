// api/lib/agent.js
// Le cerveau d'Octopus 3.
//
//   Question simple  -> réponse directe en flux (rapide, comme avant)
//   Question difficile -> RÉFLEXION : brouillon silencieux (avec outils), en parallèle d'un CONSEIL
//                         d'autres modèles ; si le conseil répond : synthèse finale en flux.
//                         Sinon RELECTURE par un critique interne -> livraison, ou réécriture
//   Après la réponse -> MÉMOIRE : nouveaux souvenirs durables proposés au navigateur
//
// Événements envoyés à l'interface (via emit) :
//   {t:'recall', count}           nombre de souvenirs utilisés
//   {t:'phase', name, label}      think | council | check | revise
//   {t:'tool', id, name, label}   un outil démarre
//   {t:'tool_done', id, ok}       un outil est terminé
//   {t:'sources', items}          sources web
//   {t:'image', url, prompt}      image à afficher
//   {t:'music', prompt}           musique à générer (l'interface appelle /api/music)
//   {t:'delta', text}             morceau de texte de la réponse
//   {t:'meta', confidence, checked, revised, council}   verdict de la relecture ; council = nombre d'avis comparés (0 si aucun)
//   {t:'memory', add:[...]}       nouveaux souvenirs à enregistrer
//   {t:'done', model}             fin
//   {t:'error', message}          erreur

const { streamChat, geminiChat, parseDataUrl } = require('./llm.js');
const { getToolSpecs, describeTool, runTool } = require('./tools.js');
const { buildSystemPrompt } = require('./soul.js');
const { selectRelevant, shouldExtract, extractFacts } = require('./memory.js');
const { needsDeliberation, critique, buildRevisionNote } = require('./deliberate.js');
const { getMembers, councilAllowed, askCouncil, buildSynthesisNote } = require('./council.js');

const MAX_STEPS = 4;
const BUDGET_MS = 50000; // Vercel : maxDuration 60 s, on garde de la marge
const WEB_TOOLS = new Set(['web_search', 'read_url']);

// Échelle de secours : Groq 120b -> Groq 20b -> OpenRouter (si clé)
function buildLadder(keys) {
  const ladder = [];
  if (keys.groq) {
    ladder.push({ provider: 'groq', apiKey: keys.groq, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b' });
    ladder.push({ provider: 'groq', apiKey: keys.groq, model: 'openai/gpt-oss-20b' });
  }
  if (keys.openrouter) {
    ladder.push({ provider: 'openrouter', apiKey: keys.openrouter, model: process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b:free' });
  }
  return ladder;
}

function friendlyError(error) {
  const s = error && error.providerStatus;
  if (s === 429) return 'Les modèles sont saturés (limite gratuite atteinte). Réessaie dans une minute.';
  if (s === 401 || s === 403) return 'Une clé API est refusée. Vérifie les variables dans Vercel.';
  return (error && error.message) || 'Erreur inconnue.';
}

function parseArgs(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch (e) {
    return {};
  }
}

// Erreur déjà signalée à l'interface : on arrête sans en émettre une deuxième
class ReportedError extends Error {}

async function runAgent({ messages, keys, mode, webSearch, hasImage, file, memories = [], emit: rawEmit }) {
  const startedAt = Date.now();
  const left = () => BUDGET_MS - (Date.now() - startedAt);

  let outChars = 0;
  const emit = (event) => { if (event.t === 'delta') outChars += event.text.length; rawEmit(event); };

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const question = lastUser ? lastUser.content : '';
  const recalled = selectRelevant(memories, question);
  if (recalled.length) emit({ t: 'recall', count: recalled.length });

  // ---------- Cas image : Gemini voit l'image, sans outils ----------
  if (hasImage) {
    const image = parseDataUrl(file && file.data);
    if (!keys.gemini || !image) {
      emit({ t: 'error', message: "L'analyse d'image nécessite GEMINI_API_KEY et une image valide." });
      return;
    }
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const text = await geminiChat({
      apiKey: keys.gemini,
      model: geminiModel,
      messages: [
        { role: 'system', content: buildSystemPrompt({ mode, hasWebTool: false, memories: recalled, model: geminiModel }) },
        ...messages.map(m => ({ role: m.role, content: m.content }))
      ],
      image
    });
    emit({ t: 'delta', text: text || '(réponse vide)' });
    emit({ t: 'done', model: 'gemini' });
    return;
  }

  // ---------- Préparation ----------
  const tools = getToolSpecs({ webSearch });
  const hasWebTool = tools.some(t => WEB_TOOLS.has(t.function.name));
  const ladder = buildLadder(keys);
  if (!ladder.length) {
    emit({ t: 'error', message: 'Aucune clé disponible (GROQ_API_KEY ou OPENROUTER_API_KEY).' });
    return;
  }

  const state = { rung: 0, useTools: true, model: ladder[0].model };
  const convo = [
    { role: 'system', content: buildSystemPrompt({ mode, hasWebTool, memories: recalled, model: ladder[0].model }) },
    ...messages.map(m => ({ role: m.role, content: m.content }))
  ];
  const temperature = mode === 'creative' ? 0.9 : 0.5;

  // Un appel de modèle avec repli automatique. En mode silencieux, rien n'est envoyé à l'interface,
  // on peut donc changer de modèle sans risque de doublon.
  async function callModel({ toolList, silent }) {
    let lastError = null;
    while (state.rung < ladder.length) {
      const target = ladder[state.rung];
      state.model = target.model;
      let emitted = false;
      try {
        return await streamChat({
          ...target,
          messages: convo,
          tools: toolList,
          temperature,
          onText: silent ? () => {} : (text) => { emitted = true; emit({ t: 'delta', text }); },
          timeoutMs: Math.max(8000, left())
        });
      } catch (error) {
        lastError = error;
        console.error(`[Agent] ${target.model} :`, error.message);
        if (emitted) { emit({ t: 'error', message: friendlyError(error) }); throw new ReportedError(error.message); }
        // 400 : l'appel d'outil a mal tourné -> même modèle sans outils
        if (error.providerStatus === 400 && toolList.length && state.useTools) { state.useTools = false; toolList = []; continue; }
        state.rung += 1;
      }
    }
    emit({ t: 'error', message: friendlyError(lastError) });
    throw new ReportedError('aucun modèle disponible');
  }

  // Boucle « modèle -> outils -> modèle » jusqu'à une réponse sans appel d'outil
  async function gather({ silent, allowTools = true, maxSteps = MAX_STEPS }) {
    let usedWeb = false;
    for (let step = 0; step <= maxSteps; step++) {
      const finalStep = step >= maxSteps || left() < 15000;
      const result = await callModel({ toolList: allowTools && state.useTools && !finalStep ? tools : [], silent });

      if (!result.toolCalls.length) return { content: result.content, usedWeb };

      convo.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
      });

      for (const call of result.toolCalls) {
        const args = parseArgs(call.arguments);
        emit({ t: 'tool', id: call.id, name: call.name, label: describeTool(call.name, args) });
        const out = await runTool(call.name, args);
        if (WEB_TOOLS.has(call.name) && !out.failed) usedWeb = true;
        for (const event of out.events || []) emit(event);
        emit({ t: 'tool_done', id: call.id, ok: !out.failed });
        convo.push({ role: 'tool', tool_call_id: call.id, content: out.content });
      }
    }
    return { content: '', usedWeb };
  }

  // Livre un texte déjà écrit comme s'il arrivait en flux
  const flush = (text) => { for (let i = 0; i < text.length; i += 80) emit({ t: 'delta', text: text.slice(i, i + 80) }); };

  let finalText = '';

  try {
    if (needsDeliberation({ text: question, mode, hasImage }) && left() > 25000) {
      // ---------- Réflexion ----------
      emit({ t: 'phase', name: 'think', label: 'Je réfléchis' });
      // Le conseil démarre en même temps que le brouillon : il ne rallonge presque pas l'attente
      const members = councilAllowed(mode) ? getMembers(keys, ladder[0].model) : [];
      const councilPromise = members.length
        ? askCouncil({
            members, messages, temperature,
            systemPrompt: buildSystemPrompt({ mode, hasWebTool: false, memories: recalled, model: 'un modèle du conseil' })
          }).catch(() => [])
        : Promise.resolve([]);
      const draft = await gather({ silent: true });
      const draftText = draft.content.trim();

      // ---------- Conseil : les avis des autres modèles (déjà lancés en parallèle) ----------
      const avis = await councilPromise;

      if (!draftText) {
        emit({ t: 'delta', text: '(réponse vide)' });
      } else if (avis.length && left() > 12000) {
        emit({ t: 'phase', name: 'council', label: `Je compare ${avis.length + 1} modèles` });
        convo.push({ role: 'assistant', content: draftText });
        convo.push({ role: 'user', content: buildSynthesisNote(avis) });
        const before = outChars;
        let synth = null;
        try {
          synth = await gather({ silent: false, allowTools: true, maxSteps: 2 });
        } catch (error) {
          if (!(error instanceof ReportedError) || outChars > before) throw error;
        }
        if (outChars === before) {
          flush(draftText);
          finalText = draftText;
          emit({ t: 'meta', confidence: null, checked: false, revised: false, council: 0 });
        } else {
          finalText = synth ? synth.content : '';
          emit({ t: 'meta', confidence: null, checked: true, revised: false, council: avis.length + 1 });
        }
      } else {
        // ---------- Relecture ----------
        let verdict = null;
        if (left() > 12000) {
          emit({ t: 'phase', name: 'check', label: 'Je relis et je vérifie' });
          verdict = await critique({
            question, draft: draftText, usedWeb: draft.usedWeb,
            target: ladder[Math.min(state.rung, ladder.length - 1)]
          });
        }

        if (!verdict || verdict.verdict === 'ok') {
          flush(draftText);
          finalText = draftText;
          emit({ t: 'meta', confidence: verdict ? verdict.confidence : null, checked: Boolean(verdict), revised: false });
        } else {
          // ---------- Correction ----------
          emit({ t: 'phase', name: 'revise', label: 'Je corrige ma réponse' });
          const canSearch = hasWebTool && !draft.usedWeb && verdict.needs_fresh_info;
          convo.push({ role: 'assistant', content: draftText });
          convo.push({ role: 'user', content: buildRevisionNote(verdict, { canSearch }) });
          const before = outChars;
          let revised = null;
          try {
            revised = await gather({ silent: false, allowTools: canSearch, maxSteps: 2 });
          } catch (error) {
            if (!(error instanceof ReportedError) || outChars > before) throw error;
          }
          if (outChars === before) {
            // La correction a échoué sans rien produire : on livre le brouillon plutôt que rien
            flush(draftText);
            finalText = draftText;
            emit({ t: 'meta', confidence: verdict.confidence, checked: true, revised: false });
          } else {
            finalText = revised ? revised.content : '';
            emit({ t: 'meta', confidence: verdict.confidence, checked: true, revised: true });
          }
        }
      }
    } else {
      // ---------- Réponse directe ----------
      const result = await gather({ silent: false });
      finalText = result.content;
      if (!result.content.trim() && outChars === 0) emit({ t: 'delta', text: '(réponse vide)' });
    }
  } catch (error) {
    if (error instanceof ReportedError) return;
    throw error;
  }

  // ---------- Mémoire ----------
  if (shouldExtract(question) && left() > 8000) {
    const target = ladder.find(l => /20b/.test(l.model)) || ladder[Math.min(state.rung, ladder.length - 1)];
    const add = await extractFacts({ userMessage: question, answer: finalText, existing: memories, target });
    if (add.length) emit({ t: 'memory', add });
  }

  emit({ t: 'done', model: state.model });
}

module.exports = { runAgent };
