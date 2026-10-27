/* ============================================================================================
 * INFERNO DOS MORTOS · intro.js — Intro Cutscene System (4 telas narrativas com FADE)
 *
 * Módulo ISOLADO: cria/usa só o <section id="intro"> (fora do HUD) e não conhece o game loop nem o WebAssembly.
 * O game.js chama  MV.Intro.tocar(callback)  e coloca  estado = 'intro'  (o quadro() não atualiza simulação nem desenha o mundo nesse estado).
 * Quando a última tela termina (ou o jogador pula), o callback é chamado UMA vez → é ali que o novoJogo() de fato começa.
 *
 * Entradas (todas com prioridade sobre o temporizador de 5 s):
 *   · clique do mouse / toque em qualquer ponto da tela ou no botão AVANÇAR
 *   · teclado: Espaço, Enter, → (avança) · Esc (pula tudo)       [capturado em fase de captura: o jogo não recebe essas teclas]
 *   · controle: A / RB / D-pad → avança · Menu / View pula        [o game.js repassa os botões via MV.Intro.botao(nome)]
 * Fade in/out: só opacity via CSS transition (compositor, sem layout) · barra de tempo: transform scaleX com transition linear.
 * ========================================================================================== */
(function (MV) {
  'use strict';
  var DUR = 5000;                                   /* duração base de cada tela (ms) */
  var TELAS = [
    { ano: '2031', titulo: 'EVOLUTION IA', texto: 'Em 2031, uma nova empresa surge prometendo transformar para sempre a indústria dos videogames. Seu console leva o próprio nome da marca: Evolution IA.' },
    { ano: 'O LEITOR NEURAL', titulo: 'IMERSÃO TOTAL', texto: 'A grande inovação é um leitor neural acoplado às têmporas, capaz de transportar a consciência do jogador diretamente para dentro de qualquer título da marca.' },
    { ano: 'TESTE DE ROTINA', titulo: 'O ACIDENTE', texto: 'Durante um teste de rotina, algo inesperado e catastrófico acontece: quatro engenheiros do projeto ficam presos dentro de um jogo de sobrevivência contra hordas de zumbis.' },
    { ano: 'SEM SAÍDA', titulo: 'CONDENADOS', texto: 'O sistema é integrado às sensações humanas: dor real, medo profundo, desespero absoluto. E a morte não traz descanso. Eles estão condenados a nunca morrer de forma definitiva.' }
  ];
  var raiz, cena, elAno, elTitulo, elTexto, barra, passos, btnAv, btnPular, dica;
  var ativo = false, saindo = false, terminando = false, idx = -1, timer = 0, fim = null, fade = 700;

  function pegar() {
    if (raiz) return true;
    raiz = document.getElementById('intro'); if (!raiz) return false;
    cena = document.getElementById('introCena'); elAno = document.getElementById('introAno'); elTitulo = document.getElementById('introTitulo');
    elTexto = document.getElementById('introTexto'); barra = document.getElementById('introBarra'); passos = document.getElementById('introPassos');
    btnAv = document.getElementById('btnIntroAvancar'); btnPular = document.getElementById('btnIntroPular'); dica = document.getElementById('introDica');
    raiz.addEventListener('pointerdown', function (e) {                      /* mouse e toque: qualquer ponto avança */
      if (e.target.closest && e.target.closest('#btnIntroPular')) return;
      e.preventDefault(); avancar();
    });
    btnPular.addEventListener('click', function (e) { e.stopPropagation(); pular(); });
    return true;
  }
  function reflow(el) { void el.offsetWidth; }
  function Som() { return MV.Som || {}; }

  function mostrarTela(i) {
    idx = i; saindo = false;
    var t = TELAS[i];
    elAno.textContent = t.ano; elTitulo.textContent = t.titulo; elTexto.textContent = t.texto;
    var ps = passos.children; for (var k = 0; k < ps.length; k++) { ps[k].classList.toggle('on', k === i); ps[k].classList.toggle('feito', k < i); }
    btnAv.textContent = i === TELAS.length - 1 ? 'INICIAR ▸' : 'AVANÇAR ▸';
    barra.classList.remove('run'); reflow(barra); barra.classList.add('run');   /* reinicia a barra de 5 s (CSS puro) */
    cena.classList.remove('on'); reflow(cena); cena.classList.add('on');        /* FADE IN */
    clearTimeout(timer); timer = setTimeout(avancar, DUR);                      /* 5 s: avança sozinho, mas o input do jogador vem antes */
  }
  /* avança já (ou conclui na última tela). Ignora toques repetidos durante o fade para não pular duas telas. */
  function avancar() {
    if (!ativo || saindo || terminando) return;
    saindo = true; clearTimeout(timer);
    cena.classList.remove('on');                                                /* FADE OUT */
    if (Som().introTransicao) Som().introTransicao();
    timer = setTimeout(function () { if (idx >= TELAS.length - 1) terminar(); else mostrarTela(idx + 1); }, fade + 60);
  }
  function pular() { if (!ativo || terminando) return; clearTimeout(timer); terminar(); }
  function terminar() {
    if (terminando) return; terminando = true; clearTimeout(timer);
    var cb = fim; fim = null;
    window.removeEventListener('keydown', aoTecla, true);
    if (Som().introMusica) Som().introMusica(false);
    if (cb) { try { cb(); } catch (e) { if (window.console) console.error(e); } }   /* o jogo começa aqui, ainda por trás do preto */
    raiz.classList.remove('vis');                                                    /* a intro some em fade, revelando o jogo */
    setTimeout(function () { raiz.hidden = true; ativo = false; terminando = false; cena.classList.remove('on'); barra.classList.remove('run'); }, fade + 80);
  }
  function aoTecla(e) {
    if (!ativo) return;
    var k = e.key;
    if (k === ' ' || k === 'Enter' || k === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) avancar(); }
    else if (k === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); pular(); }
    else e.stopImmediatePropagation();                                             /* nenhuma outra tecla vaza para o jogo */
  }
  /* botões do controle (o game.js repassa aqui enquanto estado === 'intro') */
  function botao(n) {
    if (!ativo) return false;
    if (n === 'a' || n === 'rb' || n === 'dir') avancar(); else if (n === 'menu' || n === 'view') pular();
    return true;
  }
  function tocar(cb) {
    if (ativo || !pegar()) { if (cb) cb(); return; }                 /* sem o markup: não trava o fluxo, vai direto ao jogo */
    ativo = true; saindo = false; terminando = false; fim = cb;
    fade = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ? 90 : 700;
    passos.innerHTML = ''; for (var i = 0; i < TELAS.length; i++) passos.appendChild(document.createElement('i'));
    dica.textContent = (MV.Gamepad && MV.Gamepad.ativo) ? 'A / RB AVANÇA · MENU PULA' : (window.matchMedia && window.matchMedia('(pointer: coarse)').matches ? 'TOQUE NA TELA PARA AVANÇAR' : 'ESPAÇO / ENTER / CLIQUE AVANÇA · ESC PULA');
    raiz.hidden = false; cena.classList.remove('on'); reflow(raiz); raiz.classList.add('vis');
    if (MV.Som) { MV.Som.iniciar(); MV.Som.silencio = false; if (MV.Som.introMusica) MV.Som.introMusica(true); }
    window.addEventListener('keydown', aoTecla, true);
    setTimeout(function () { if (ativo && !terminando && idx < 0) mostrarTela(0); }, 250);   /* preto → 1ª tela em fade */
    idx = -1;
  }
  MV.Intro = { tocar: tocar, avancar: avancar, pular: pular, botao: botao, TELAS: TELAS, get ativo() { return ativo; } };
})(window.MV = window.MV || {});
