// public/coderunner.js
// Exécute le code JavaScript écrit par Octopus ET ses tests, dans un bac à sable fermé :
//   - iframe sandbox="allow-scripts" : origine opaque, aucun accès à tes données (localStorage, cookies…)
//   - Worker : le code tourne dans un fil séparé, jamais sur le fil de la page (une boucle infinie ne la fige pas)
//   - Content-Security-Policy "default-src 'none'" : aucun accès au réseau, aucune image, aucun cadre
//   - délai maximal : une boucle infinie est coupée et signalée
// Le résultat (réussite / échecs / erreur) revient à Octopus pour qu'il se corrige tout seul.
//
// Utilisable dans le navigateur (window.CodeRunner) et dans Node (tests unitaires des fonctions pures).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodeRunner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var MAX_AUTO_FIX = 2;

  // Cherche dans la réponse : un ou plusieurs blocs ```js (solution) ET un bloc ```js test (tests)
  function extractBlocks(markdown) {
    var re = /```([^\n`]*)\n([\s\S]*?)```/g;
    var solution = [];
    var tests = [];
    var m;
    while ((m = re.exec(String(markdown || '')))) {
      var info = m[1].trim().toLowerCase();
      var words = info.split(/\s+/).filter(Boolean);
      var lang = (words[0] || '').replace(/-?tests?$/, '');
      if (lang !== 'js' && lang !== 'javascript') continue;
      var isTest = /(^|[\s-])tests?$/.test(info) || words.slice(1).some(function (w) { return w === 'test' || w === 'tests'; });
      (isTest ? tests : solution).push(m[2]);
    }
    if (!solution.length || !tests.length) return null;
    return { solution: solution.join('\n'), tests: tests.join('\n') };
  }

  // Rend un morceau de code sûr à placer dans <script> (évite la fermeture prématurée de la balise)
  function escapeForScript(code) {
    return String(code).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  }

  // Code exécuté DANS le Worker (un fil séparé : une boucle infinie ne fige jamais la page,
  // et le Worker est détruit à la fin ou au délai maximal).
  var HARNESS = [
    '(function(){',
    '  self.__errors = [];',
    '  self.addEventListener("unhandledrejection", function(e){ self.__errors.push("promesse rejetée : " + (e.reason && e.reason.message || e.reason)); });',
    '  self.__tests = [];',
    '  self.test = self.it = function(name, fn){ self.__tests.push({ name: String(name), fn: fn }); };',
    '  self.assert = function(c, m){ if (!c) throw new Error(m || "assertion échouée"); };',
    '  self.assertEqual = function(a, b, m){ if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ? m + " : " : "") + "attendu " + JSON.stringify(b) + ", reçu " + JSON.stringify(a)); };',
    '  self.assertThrows = function(fn, m){ var t = false; try { fn(); } catch (e) { t = true; } if (!t) throw new Error(m || "une exception était attendue"); };',
    '  self.module = { exports: {} }; self.exports = self.module.exports;',
    '  self.require = function(n){ throw new Error("require(\\"" + n + "\\") indisponible : écris du JavaScript autonome, sans import ni require"); };',
    '})();'
  ].join('\n');

  function runnerScript(perTestMs) {
    return [
      '(async function(){',
      '  var results = [];',
      '  for (var i = 0; i < self.__tests.length; i++) {',
      '    var t = self.__tests[i];',
      '    try {',
      '      await Promise.race([Promise.resolve().then(t.fn), new Promise(function(_, rej){ setTimeout(function(){ rej(new Error("test trop lent (> ' + perTestMs + ' ms)")); }, ' + perTestMs + '); })]);',
      '      results.push({ name: t.name, ok: true });',
      '    } catch (e) {',
      '      results.push({ name: t.name, ok: false, error: String(e && e.message || e).slice(0, 300) });',
      '    }',
      '  }',
      '  self.postMessage({ results: results, lateErrors: self.__errors.slice(0, 5) });',
      '})();'
    ].join('\n');
  }

  function buildWorkerSource(solution, tests, perTestMs) {
    return HARNESS + '\n' + String(solution) + '\n;\n' + String(tests) + '\n;\n' + runnerScript(perTestMs || 2000);
  }

  // Page de l'iframe : origine opaque + CSP sans réseau ; elle lance le Worker et relaie le résultat
  function buildSrcdoc(solution, tests, token, perTestMs) {
    var workerSource = buildWorkerSource(solution, tests, perTestMs);
    var loader = [
      '(function(){',
      '  var TOKEN = ' + JSON.stringify(token) + ';',
      '  var CODE = ' + JSON.stringify(workerSource) + ';',
      '  function post(p){ p.token = TOKEN; p.done = true; parent.postMessage(p, "*"); }',
      '  try {',
      '    var w = new Worker(URL.createObjectURL(new Blob([CODE], { type: "text/javascript" })));',
      '    w.onmessage = function(e){ post(e.data || { results: [] }); };',
      '    w.onerror = function(e){ if (e.preventDefault) e.preventDefault(); post({ syntaxErrors: [(e.message || "erreur de chargement") + (e.lineno ? " (ligne " + e.lineno + ")" : "")], results: [] }); };',
      '  } catch (err) { post({ syntaxErrors: ["bac à sable indisponible : " + err.message], results: [] }); }',
      '})();'
    ].join('\n');
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; worker-src blob:">' +
      '</head><body><script>' + escapeForScript(loader) + '<\/script></body></html>';
  }

  function summarize(data) {
    var results = Array.isArray(data.results) ? data.results : [];
    if (data.syntaxErrors && data.syntaxErrors.length) {
      return { status: 'error', total: 0, passed: 0, results: [], message: 'Erreur au chargement du code : ' + data.syntaxErrors.join(' ; ') };
    }
    var passed = results.filter(function (r) { return r.ok; }).length;
    if (!results.length) return { status: 'notests', total: 0, passed: 0, results: [], message: 'Aucun test détecté dans le bloc de tests (utilise test("nom", () => { ... })).' };
    var late = data.lateErrors && data.lateErrors.length ? data.lateErrors.join(' ; ') : '';
    return { status: passed === results.length ? 'pass' : 'fail', total: results.length, passed: passed, results: results, message: late };
  }

  // Exécution (navigateur uniquement)
  function run(solution, tests, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      var iframe = document.createElement('iframe');
      iframe.setAttribute('sandbox', 'allow-scripts');
      iframe.setAttribute('aria-hidden', 'true');
      iframe.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
      var finished = false;
      var timer;
      function finish(result) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        resolve(result);
      }
      function onMessage(e) {
        var d = e.data;
        if (e.source !== iframe.contentWindow || !d || d.token !== token || !d.done) return;
        finish(summarize(d));
      }
      window.addEventListener('message', onMessage);
      timer = setTimeout(function () {
        finish({ status: 'timeout', total: 0, passed: 0, results: [], message: 'Le code tourne trop longtemps (boucle infinie ?) : exécution interrompue.' });
      }, opts.timeoutMs || 6000);
      iframe.srcdoc = buildSrcdoc(solution, tests, token, opts.perTestMs);
      document.body.appendChild(iframe);
    });
  }

  // Message envoyé automatiquement à Octopus quand les tests ne passent pas
  function failureMessage(result) {
    var lines = ['[Exécution automatique de tes tests dans le navigateur]'];
    if (result.status === 'pass') return lines.concat(['Tous les tests passent.']).join('\n');
    if (result.status === 'fail') {
      lines.push('Résultat : ' + result.passed + '/' + result.total + ' tests réussis. Échecs :');
      result.results.filter(function (r) { return !r.ok; }).slice(0, 8).forEach(function (r) { lines.push('- ' + r.name + ' : ' + r.error); });
      if (result.message) lines.push('Erreurs supplémentaires : ' + result.message);
    } else {
      lines.push(result.message || 'Exécution impossible.');
    }
    lines.push('', 'Corrige le code. Si c\'est un test qui est faux, corrige le test, mais ne l\'affaiblis pas pour le faire passer. Renvoie le code complet corrigé dans un bloc ```js et les tests dans un bloc ```js test.');
    return lines.join('\n');
  }

  return { extractBlocks: extractBlocks, buildSrcdoc: buildSrcdoc, summarize: summarize, run: run, failureMessage: failureMessage, escapeForScript: escapeForScript, MAX_AUTO_FIX: MAX_AUTO_FIX };
});
