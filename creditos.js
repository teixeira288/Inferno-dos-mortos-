/* creditos.js : proteção dos créditos do jogo.
 * Os créditos NÃO ficam no HTML: são montados a partir de dados congelados (Object.freeze) com uma cópia redundante
 * codificada e uma impressão digital (hash). A lista é redesenhada a partir do dado verificado sempre que a tela abre,
 * e um MutationObserver desfaz na hora qualquer alteração feita no DOM (via console, extensão ou script).
 * Limite honesto: JavaScript no navegador roda na máquina do jogador; quem editar o arquivo-fonte inteiro ainda consegue
 * trocar tudo. Esta trava impede alteração em tempo de execução e detecta/repara edição parcial do arquivo. */
(function () {
  'use strict';
  var HASH = '983565c7f85e4';
  var COPIA = 'VmliZSBjb2RlOnxNQVRIRVVTIFRFSVhFSVJBClByb2dyYW1hZG9yZXM6fENMQVVERSBJQSwgR0VNSU5JIElB';
  var PRIMARIO = Object.freeze([
    Object.freeze({ rotulo: 'Vibe code:', nome: 'MATHEUS TEIXEIRA' }),
    Object.freeze({ rotulo: 'Programadores:', nome: 'CLAUDE IA, GEMINI IA' })
  ]);

  function hash(s) {
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57, i, c;
    for (i = 0; i < s.length; i++) { c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }
  function serializar(l) { var a = []; for (var i = 0; i < l.length; i++) a.push(l[i].rotulo + '|' + l[i].nome); return a.join('\n'); }
  function decodificar() {
    try {
      var bin = atob(COPIA), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var txt = new TextDecoder('utf-8').decode(bytes);
      return txt.split('\n').map(function (ln) { var p = ln.split('|'); return Object.freeze({ rotulo: p[0], nome: p[1] }); });
    } catch (e) { return null; }
  }
  /* dado confiável: o primário se o hash conferir; senão a cópia codificada; senão nada é exibido (nunca um texto adulterado) */
  function confiavel() {
    if (hash(serializar(PRIMARIO)) === HASH) return PRIMARIO;
    var c = decodificar();
    if (c && hash(serializar(c)) === HASH) return c;
    return [];
  }

  var raiz = null, lista = null, ocupado = false, obs = null;
  function desenhar() {
    if (!lista) return;
    ocupado = true;
    var dados = confiavel(), i, li, sp, b;
    while (lista.firstChild) lista.removeChild(lista.firstChild);
    for (i = 0; i < dados.length; i++) {
      li = document.createElement('li'); sp = document.createElement('span'); b = document.createElement('b');
      sp.textContent = dados[i].rotulo; b.textContent = dados[i].nome;
      li.appendChild(sp); li.appendChild(document.createTextNode(' ')); li.appendChild(b); lista.appendChild(li);
    }
    if (obs && obs.takeRecords) obs.takeRecords();
    ocupado = false;
  }
  function iniciar() {
    raiz = document.getElementById('creditos'); lista = document.getElementById('credLista');
    if (!raiz || !lista) return;
    desenhar();
    if (window.MutationObserver) {
      obs = new MutationObserver(function () { if (!ocupado) desenhar(); });
      obs.observe(raiz, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'id'] });
    }
    /* verificação periódica leve (a cada 2 s) e ao abrir a tela */
    setInterval(function () { if (raiz && !raiz.hidden) desenhar(); }, 2000);
  }
  var API = Object.freeze({ verificar: desenhar });
  try { Object.defineProperty(window, 'MVCreditos', { value: API, writable: false, configurable: false }); } catch (e) { }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
