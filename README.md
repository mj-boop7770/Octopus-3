# 🐙 Octopus 3

Assistant IA qui **réfléchit, vérifie ses réponses et se souvient** : gratuit, sans base de données, déployable sur Vercel depuis un téléphone.

## Ce qui le rend différent

| Capacité | Comment |
|---|---|
| **Un vrai caractère** | `api/lib/soul.js` : honnêteté d'abord, contredit avec tact, pas de flatterie, répond dans ta langue (FR / PT / EN), connaît le contexte du Mozambique. |
| **Réfléchit, puis relit** | Questions difficiles : brouillon silencieux → relecteur interne → réponse livrée (ou réécrite si un vrai défaut est trouvé). Badge « Relue · confiance 91 % » ou « À vérifier ». Questions simples : réponse directe, sans surcoût. |
| **Mémoire qu'on contrôle** | Les souvenirs vivent dans ton navigateur (bouton 🧠 Mémoire) : zéro base de données, tu vois, ajoutes et effaces tout. Les secrets (mots de passe, clés, longs numéros) ne sont jamais retenus. |
| **Outils** | `calculate` (arithmétique exacte), `read_url` (lit une page, protégé contre les attaques SSRF), `web_search` (Tavily), images, musique. |
| **Solide** | Repli automatique entre modèles (Groq 120b → 20b → OpenRouter), 26 tests automatiques, clés uniquement côté serveur. |

## Démarrer

```bash
npm start          # http://localhost:3000
npm test           # 26 tests avec faux fournisseurs (aucune clé nécessaire)
npm run evals      # 12 questions sur le VRAI modèle : mesure si Octopus progresse
```

## Variables (Vercel → Settings → Environment Variables)

- `GROQ_API_KEY` : obligatoire (ou `OPENROUTER_API_KEY`)
- `TAVILY_API_KEY` : recherche web (bouton Web)
- `GEMINI_API_KEY` : analyse d'images
- `HUGGINGFACE_API_KEY` : musique (et images si `IMAGE_PROVIDER=huggingface`)
- Optionnelles : `GROQ_MODEL`, `OPENROUTER_MODEL`, `GEMINI_MODEL`, `ALLOWED_ORIGINS`, `RATE_LIMIT_PER_MIN`

Node 22 ou plus.

## Comment l'améliorer

1. Modifie `api/lib/soul.js` (le caractère), lance `npm run evals`, compare le score.
2. Ajoute des questions dans `evals/cases.json` à chaque défaut que tu remarques.
3. Les modèles gratuits changent : si un modèle disparaît, change `GROQ_MODEL` dans Vercel.

## Architecture

```
public/index.html      interface (réflexion, badges, panneau Mémoire)
api/chat.js            entrée : sécurité → agent → flux NDJSON
api/music.js           musique (Hugging Face)
api/lib/soul.js        caractère et principes
api/lib/agent.js       boucle d'agent : direct | réfléchir → relire → corriger | mémoire
api/lib/deliberate.js  quand réfléchir, relecteur interne
api/lib/memory.js      choix et extraction des souvenirs
api/lib/tools.js       outils ; calc.js et safefetch.js en sont les moteurs sûrs
tests/  evals/         tests automatiques et mesure de qualité
```
