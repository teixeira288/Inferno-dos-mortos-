/* sprites.js : arte procedural (infectados, chão, silhuetas de armas). Tudo gerado em canvas, sem imagens externas.
 *
 * Anti-chuvisco: os sprites são gerados em 3 densidades (1, 2 e 3 pixels por unidade de mundo) e o jogo escolhe
 * a mais próxima do zoom real da tela. Assim a imagem quase nunca é reduzida por um fator grande
 * (reduções fortes + rotação são o que faz o contorno "cintilar" quando o inimigo se move).
 */
(function (MV) {
  'use strict';
  var TAU = Math.PI * 2;
  var U = 56;                 /* lado do sprite, em unidades de arte (o infectado comum tem raio 14) */
  var QUADROS = 7;            /* 0-3 andando, 4 ataque, 5 preparo do bote, 6 bote */
  var NTIPOS = 7;             /* 0 comum, 1 veloz, 2 bruto, 3 corredor, 4 tanque, 5 tóxico, 6 bomber */

  var PALETAS = [
    { pele: '#93a578', peleEsc: '#5d6e4a', roupa: '#4b4035', roupa2: '#2c3947', sangue: '#6b1414' },   /* comum */
    { pele: '#b2b88f', peleEsc: '#6f7858', roupa: '#6e2b2b', roupa2: '#3d2020', sangue: '#7a1616' },   /* veloz */
    { pele: '#6f8a68', peleEsc: '#43573f', roupa: '#2f3438', roupa2: '#1c2023', sangue: '#4d0e0e' }    /* bruto */
  ];

  PALETAS[6] = { pele: '#a89b6e', peleEsc: '#6d6544', roupa: '#7a4d22', roupa2: '#3b2a18', sangue: '#5a1414' };   /* Bomber */

  /* toco sangrento no ombro/pescoço de um membro arrancado (perd: bit 1 cabeça, 2 braço esquerdo, 4 braço direito) */
  function toco(g, x, y, r) {
    g.fillStyle = '#5c0d10'; g.beginPath(); g.arc(x, y, r || 3.2, 0, TAU); g.fill();
    g.fillStyle = '#8f1a1d'; g.beginPath(); g.arc(x + 0.4, y - 0.4, (r || 3.2) * 0.55, 0, TAU); g.fill();
    g.fillStyle = '#e6dccb'; g.beginPath(); g.arc(x, y, (r || 3.2) * 0.22, 0, TAU); g.fill();
  }

  function maos(g, x, y, cor, corte, garras) {
    g.fillStyle = cor; g.beginPath(); g.arc(x + 0.8, y, 2.6, 0, TAU); g.fill();
    g.strokeStyle = corte; g.lineWidth = 1.1;
    for (var d = -1; d <= 1; d++) { g.beginPath(); g.moveTo(x + 1.2, y); g.lineTo(x + garras, y + d * 1.9); g.stroke(); }
  }

  /* ---------- infectados comuns (tipos 0, 1, 2) ---------- */
  function desenharComum(g, tipo, quadro, perd, antesCabeca) {
    perd = perd | 0;
    var p = PALETAS[tipo];
    var atq = quadro === 4;
    var balanco = quadro < 4 ? Math.sin(quadro / 4 * TAU) : 0;
    var larg = tipo === 1 ? 0.82 : 1;
    var lados = [-1, 1];
    for (var i = 0; i < 2; i++) {
      var s = lados[i];
      if (perd & (i ? 4 : 2)) { toco(g, 1, s * 9.4 * larg, 3.4); continue; }
      var comp = atq ? 22 : 15 + balanco * 3.4 * s;
      var ombroY = s * 9.4 * larg;
      var maoX = 1 + comp, maoY = s * (atq ? 4.2 : 6.6);
      var meioX = (1 + maoX) / 2 + 0.5, meioY = (ombroY + maoY) / 2 + s * 1.2;
      g.strokeStyle = '#0b0d0c'; g.lineWidth = 6.6;
      g.beginPath(); g.moveTo(1, ombroY); g.lineTo(meioX, meioY); g.lineTo(maoX, maoY); g.stroke();
      g.strokeStyle = p.roupa; g.lineWidth = 5.2;
      g.beginPath(); g.moveTo(1, ombroY); g.lineTo(meioX, meioY); g.stroke();
      g.strokeStyle = p.pele; g.lineWidth = 4.2;
      g.beginPath(); g.moveTo(meioX, meioY); g.lineTo(maoX, maoY); g.stroke();
      maos(g, maoX, maoY, p.peleEsc, p.peleEsc, 4.4);
    }
    g.fillStyle = p.roupa; g.strokeStyle = '#0b0d0c'; g.lineWidth = 1.3;
    g.beginPath(); g.ellipse(0, 0, 7.4, 12.4 * larg, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = p.roupa2;
    g.beginPath(); g.ellipse(-2.2, 2.6 * balanco, 3.8, 7.5 * larg, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-5, -8 * larg); g.lineTo(-1, -2); g.moveTo(-4, 8 * larg); g.lineTo(0, 3); g.stroke();
    g.fillStyle = p.sangue;
    g.beginPath(); g.ellipse(2, 4 * larg, 3.2, 2.2, 0.5, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(-3, -5 * larg, 2.2, 1.6, -0.3, 0, TAU); g.fill();
    if (antesCabeca) antesCabeca(g, quadro, balanco);
    var hy = balanco * 0.8;
    if (perd & 1) { toco(g, 4, hy, 4.2); return; }
    g.fillStyle = p.pele; g.strokeStyle = '#0b0d0c'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(2, hy, 6.5, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = p.peleEsc;
    g.beginPath(); g.arc(0.4, hy, 5.8, Math.PI * 0.55, Math.PI * 1.45); g.lineTo(0.4, hy); g.fill();
    g.fillStyle = p.sangue;
    g.beginPath(); g.ellipse(3.2, hy - 3.8, 2.2, 1.3, 0.4, 0, TAU); g.fill();
    g.fillStyle = '#ff3b30';
    g.beginPath(); g.arc(6.2, hy - 2.5, 1.25, 0, TAU); g.arc(6.2, hy + 2.5, 1.25, 0, TAU); g.fill();
    g.fillStyle = '#1a0606';
    g.beginPath(); g.ellipse(7, hy, 1.1, atq ? 2.4 : 1.4, 0, 0, TAU); g.fill();
  }

  /* ---------- CORREDOR (tipo 3): moletom cinza-azulado com capuz, garras, agachado ---------- */
  function desenharCorredor(g, q, perd) {
    perd = perd | 0;
    var atq = q === 4, prep = q === 5, bote = q === 6;
    var b = q < 4 ? Math.sin(q / 4 * TAU) : 0;
    var capuz = '#222c35', jaq = '#566b7d', esc = '#27323c', pele = '#b7bda3';
    for (var i = 0; i < 2; i++) {
      var s = i ? 1 : -1;
      if (perd & (i ? 4 : 2)) { toco(g, 1, s * 7.4, 3.2); continue; }
      var len = bote ? 17 : prep ? 6 : atq ? 16 : 11 + b * 3.2 * s;
      var ombY = s * (prep ? 8.4 : 7.4);
      var mx = 1 + len, my = s * (bote ? 3 : prep ? 9.6 : atq ? 3.6 : 6);
      g.strokeStyle = '#080a0c'; g.lineWidth = 6.4;
      g.beginPath(); g.moveTo(1, ombY); g.lineTo(mx, my); g.stroke();
      g.strokeStyle = jaq; g.lineWidth = 5;
      g.beginPath(); g.moveTo(1, ombY); g.lineTo((1 + mx) / 2 + 1, (ombY + my) / 2); g.stroke();
      g.strokeStyle = pele; g.lineWidth = 3.6;
      g.beginPath(); g.moveTo((1 + mx) / 2 + 1, (ombY + my) / 2); g.lineTo(mx, my); g.stroke();
      g.strokeStyle = '#eceadc'; g.lineWidth = 1.2;
      for (var d = -1; d <= 1; d++) { g.beginPath(); g.moveTo(mx + 0.5, my); g.lineTo(mx + 4.6, my + d * 2.1 + s * 0.6); g.stroke(); }
    }
    var rx = bote ? 9.4 : prep ? 6.2 : 6.8, ry = bote ? 8.2 : prep ? 10.6 : 10.8;
    g.fillStyle = jaq; g.strokeStyle = '#080a0c'; g.lineWidth = 1.3;
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.fill(); g.stroke();
    g.strokeStyle = esc; g.lineWidth = 2;
    g.beginPath(); g.moveTo(-rx + 1, 0); g.lineTo(rx - 2, 0); g.stroke();
    g.fillStyle = '#6a1a1a';
    g.beginPath(); g.ellipse(-1.5, ry * 0.45, 2.6, 1.7, 0.4, 0, TAU); g.fill();
    var hx = bote ? 7.2 : prep ? -0.6 : 2.2, hy = b * 0.7;
    if (perd & 1) { toco(g, hx + 1, hy, 4); return; }
    g.fillStyle = capuz; g.strokeStyle = '#080a0c'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(hx, hy, 6.1, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = pele;
    g.beginPath(); g.ellipse(hx + 2.8, hy, 3.2, 3.9, 0, 0, TAU); g.fill();
    g.fillStyle = '#ffd23a';
    g.beginPath(); g.arc(hx + 4.3, hy - 1.7, 1.15, 0, TAU); g.arc(hx + 4.3, hy + 1.7, 1.15, 0, TAU); g.fill();
    g.fillStyle = '#240808';
    g.beginPath(); g.ellipse(hx + 5.2, hy, 0.9, (atq || bote) ? 2.1 : 1.1, 0, 0, TAU); g.fill();
  }

  /* ---------- TANQUE (tipo 4): gigante, braço direito desproporcional, pele cinza-parda com veias ---------- */
  function desenharTanque(g, q, perd) {
    perd = perd | 0;
    var atq = q === 4;
    var b = q < 4 ? Math.sin(q / 4 * TAU) : 0;
    var pele = '#8c7667', esc = '#5d4a40', calca = '#35373a', veia = '#9a1f1f';
    for (var i = 0; i < 2; i++) {
      var s = i ? 1 : -1, grosso = s > 0;
      if (perd & (i ? 4 : 2)) { toco(g, 1, s * (grosso ? 11.4 : 10.4), grosso ? 5 : 4); continue; }
      var len = atq ? 15.5 : (grosso ? 11.5 + b * 2 : 10.5 - b * 2);
      var ombY = s * (grosso ? 11.4 : 10.4);
      var mx = 1 + len, my = s * (atq ? 5.2 : (grosso ? 8 : 6.6));
      g.strokeStyle = '#0a0808'; g.lineWidth = grosso ? 12.4 : 9.4;
      g.beginPath(); g.moveTo(1, ombY); g.lineTo(mx, my); g.stroke();
      g.strokeStyle = pele; g.lineWidth = grosso ? 10.2 : 7.4;
      g.beginPath(); g.moveTo(1, ombY); g.lineTo(mx, my); g.stroke();
      g.strokeStyle = veia; g.lineWidth = 0.9;
      g.beginPath(); g.moveTo(2, ombY - s * 1.5); g.lineTo(mx - 3, my - s * 1.2); g.moveTo(3, ombY + s); g.lineTo(mx - 5, my + s * 0.8); g.stroke();
      g.fillStyle = esc; g.strokeStyle = '#0a0808'; g.lineWidth = 1.2;
      var fr = grosso ? 5.8 : 4.4;
      g.beginPath(); g.arc(mx + 1.5, my, fr, 0, TAU); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 0.9;
      g.beginPath(); g.moveTo(mx + 1.5 + fr * 0.2, my - fr * 0.7); g.lineTo(mx + 1.5 + fr * 0.2, my + fr * 0.7); g.stroke();
    }
    g.fillStyle = calca; g.fillRect(-9.5, -8, 5.5, 16);
    g.fillStyle = pele; g.strokeStyle = '#0a0808'; g.lineWidth = 1.4;
    g.beginPath(); g.ellipse(0, 0, 10, 15, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.ellipse(3, -5.5, 4.2, 3.6, 0, 0, TAU); g.ellipse(3, 5.5, 4.2, 3.6, 0, 0, TAU); g.fill();
    g.strokeStyle = veia; g.lineWidth = 1;
    g.beginPath(); g.moveTo(-3, -12); g.lineTo(1, -6); g.lineTo(-1, -2); g.moveTo(-2, 12); g.lineTo(2, 6); g.lineTo(0, 3); g.stroke();
    g.fillStyle = '#4f1717';
    g.beginPath(); g.ellipse(-3, 3, 3, 2, 0.3, 0, TAU); g.fill();
    var hy = b * 0.5;
    if (perd & 1) { toco(g, 5, hy, 4.6); return; }
    g.fillStyle = pele; g.strokeStyle = '#0a0808'; g.lineWidth = 1.3;
    g.beginPath(); g.arc(4.6, hy, 5.2, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = esc;
    g.beginPath(); g.arc(3.4, hy, 4.6, Math.PI * 0.55, Math.PI * 1.45); g.lineTo(3.4, hy); g.fill();
    g.fillStyle = '#ff2a1c';
    g.beginPath(); g.arc(7.6, hy - 1.8, 1.1, 0, TAU); g.arc(7.6, hy + 1.8, 1.1, 0, TAU); g.fill();
    g.fillStyle = '#1a0606';
    g.beginPath(); g.ellipse(8.6, hy, 1, atq ? 2.2 : 1.3, 0, 0, TAU); g.fill();
  }

  /* ---------- TÓXICO (tipo 5): inchado, verde-amarelado, bolsas de bile ---------- */
  function desenharToxico(g, q, perd) {
    perd = perd | 0;
    var atq = q === 4;
    var b = q < 4 ? Math.sin(q / 4 * TAU) : 0;
    var corpo = '#9aab52', claro = '#d4e36a', escuro = '#5f6e2b', pele = '#b9c47c';
    for (var i = 0; i < 2; i++) {
      var s = i ? 1 : -1;
      if (perd & (i ? 4 : 2)) { toco(g, 2, s * 9.6, 3.4); continue; }
      var len = atq ? 14 : 9.5 + b * 1.6 * s;
      var mx = 1 + len, my = s * (atq ? 4.4 : 7.4);
      g.strokeStyle = '#0a0c06'; g.lineWidth = 5.6;
      g.beginPath(); g.moveTo(2, s * 9.6); g.lineTo(mx, my); g.stroke();
      g.strokeStyle = pele; g.lineWidth = 4;
      g.beginPath(); g.moveTo(2, s * 9.6); g.lineTo(mx, my); g.stroke();
      maos(g, mx, my, escuro, escuro, 3.4);
    }
    var gr = g.createRadialGradient(0, 0, 3, 0, 0, 16);
    gr.addColorStop(0, '#b9cc5a'); gr.addColorStop(1, corpo);
    g.fillStyle = gr; g.strokeStyle = '#0a0c06'; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(-0.5, 0, 12.8, 14.6, 0, 0, TAU); g.fill(); g.stroke();
    var bolhas = [[-4, -6, 3.6], [-1, 6, 4.2], [-7, 1, 3], [3, -2, 2.6], [1, 9.5, 2.2], [-6, -10, 2.4]];
    for (var k = 0; k < bolhas.length; k++) {
      var bl = bolhas[k];
      g.fillStyle = k % 2 ? claro : '#7f9140';
      g.beginPath(); g.arc(bl[0], bl[1], bl[2], 0, TAU); g.fill();
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 0.8; g.stroke();
      g.fillStyle = 'rgba(255,255,255,.35)';
      g.beginPath(); g.arc(bl[0] - bl[2] * 0.3, bl[1] - bl[2] * 0.3, bl[2] * 0.28, 0, TAU); g.fill();
    }
    g.fillStyle = '#4e5a22';
    g.beginPath(); g.ellipse(-8, -4, 2.2, 1.5, 0.3, 0, TAU); g.ellipse(-3, 11, 2.4, 1.6, -0.2, 0, TAU); g.fill();
    var hy = b * 0.6;
    if (perd & 1) { toco(g, 9, hy, 4.4); return; }
    g.fillStyle = pele; g.strokeStyle = '#0a0c06'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(9, hy, 5.2, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = '#d9e87a';
    g.beginPath(); g.arc(11.2, hy - 2, 1.25, 0, TAU); g.arc(11.2, hy + 2, 1.25, 0, TAU); g.fill();
    g.fillStyle = '#4b5a1c';
    g.beginPath(); g.ellipse(12.8, hy, 1.7, atq ? 2.8 : 2, 0, 0, TAU); g.fill();
    g.fillStyle = 'rgba(206,226,90,.75)';
    g.beginPath(); g.ellipse(14.4, hy + 1, 1.6, 2.6, 0, 0, TAU); g.fill();
  }

  /* ---------- BOMBER (tipo 6): colete de cartuchos de dinamite, fios e luz vermelha piscando ---------- */
  function colete(g) {
    g.fillStyle = '#3a2a1a'; g.strokeStyle = '#0b0d0c'; g.lineWidth = 1;
    g.beginPath(); g.ellipse(0.2, 0, 8.4, 13.4, 0, 0, TAU); g.fill(); g.stroke();
    var xs = [-4.6, -1.4, 1.8, 5];
    for (var k = 0; k < xs.length; k++) {
      g.fillStyle = '#c0392b'; g.strokeStyle = '#2a0908'; g.lineWidth = 0.9;
      g.beginPath(); g.rect(xs[k] - 1.3, -8.4, 2.6, 16.8); g.fill(); g.stroke();
      g.fillStyle = '#f2d16b'; g.fillRect(xs[k] - 1.3, -2, 2.6, 2.2);
    }
    g.strokeStyle = '#d9c9a0'; g.lineWidth = 0.9;
    g.beginPath(); g.moveTo(-6.4, -9); g.bezierCurveTo(-1, -3, 2, 4, 6.4, 9); g.stroke();
    g.fillStyle = '#16181a'; g.fillRect(-2.6, -2.4, 5.2, 4.8);
    g.fillStyle = '#ff2a1c'; g.beginPath(); g.arc(0, 0, 1.4, 0, TAU); g.fill();
  }
  function desenharBomber(g, quadro, perd) { desenharComum(g, 6, quadro < 5 ? quadro : 0, perd, colete); }

  /* perd: máscara de membros perdidos (1 cabeça, 2 braço esquerdo, 4 braço direito). 0 = sprite normal. */
  function desenharZumbi(g, tipo, quadro, nivel, perd) {
    g.save();
    g.scale(nivel, nivel);
    g.translate(U / 2, U / 2);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (tipo <= 2) desenharComum(g, tipo, quadro < 5 ? quadro : 0, perd);
    else if (tipo === 3) desenharCorredor(g, quadro, perd);
    else if (tipo === 4) desenharTanque(g, quadro < 5 ? quadro : 0, perd);
    else if (tipo === 5) desenharToxico(g, quadro < 5 ? quadro : 0, perd);
    else desenharBomber(g, quadro, perd);
    g.restore();
  }

  /* gera o conjunto de sprites normais + versões em flash branco (acerto) para uma densidade */
  function criarZumbis(nivel) {
    var normal = [], flash = [], lado = U * nivel;
    for (var t = 0; t < NTIPOS; t++) {
      normal.push([]); flash.push([]);
      for (var q = 0; q < QUADROS; q++) {
        var c = document.createElement('canvas'); c.width = c.height = lado;
        desenharZumbi(c.getContext('2d'), t, q, nivel, 0);
        normal[t].push(c);
        flash[t].push(flashDe(c, lado));
      }
    }
    return { normal: normal, flash: flash, nivel: nivel, U: U, membros: {} };
  }
  function flashDe(c, lado) {
    var f = document.createElement('canvas'); f.width = f.height = lado;
    var fg = f.getContext('2d');
    fg.drawImage(c, 0, 0);
    fg.globalCompositeOperation = 'source-atop';
    fg.fillStyle = 'rgba(255,92,80,.78)';        /* flash avermelhado de dano */
    fg.fillRect(0, 0, lado, lado);
    return f;
  }
  /* variantes com membros arrancados, criadas sob demanda (máscara 1 cabeça · 2 braço E · 4 braço D) e guardadas no conjunto da densidade atual */
  function membro(sp, tipo, mask) {
    mask &= 7;
    if (!mask) return sp;
    var key = tipo * 8 + mask, e = sp.membros[key];
    if (!e) {
      e = sp.membros[key] = { normal: [], flash: [] };
      var lado = U * sp.nivel;
      for (var q = 0; q < QUADROS; q++) {
        var c = document.createElement('canvas'); c.width = c.height = lado;
        desenharZumbi(c.getContext('2d'), tipo, q, sp.nivel, mask);
        e.normal.push(c); e.flash.push(flashDe(c, lado));
      }
    }
    /* devolve a mesma forma de {normal[tipo][quadro]}: um conjunto de um tipo só, indexado pelo tipo pedido */
    var out = { normal: [], flash: [] }; out.normal[tipo] = e.normal; out.flash[tipo] = e.flash;
    return out;
  }

  /* ---------- chão: concreto que se repete a cada 512 unidades de mundo ----------
   * Sem grão de 1 pixel: grãos pequenos e contrastados "fervem" quando a câmera rola (era a principal fonte de chuvisco).
   * A textura mestra tem 1024 px; para cada densidade geramos uma cópia reduzida com filtragem de qualidade. */
  var mestreChao = null;
  function criarMestreChao() {
    var N = 1024;
    var c = document.createElement('canvas'); c.width = c.height = N;
    var g = c.getContext('2d');
    var seed = 20260;
    function r() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
    g.fillStyle = '#1c211d'; g.fillRect(0, 0, N, N);
    var L = 256;
    for (var y = 0; y < N; y += L) for (var x = 0; x < N; x += L) {
      var v = r();
      g.fillStyle = v < 0.5 ? 'rgba(255,255,255,' + (0.012 + r() * 0.025) + ')' : 'rgba(0,0,0,' + (0.04 + r() * 0.08) + ')';
      g.fillRect(x, y, L, L);
      var gr = g.createLinearGradient(x, y, x + L, y + L);
      gr.addColorStop(0, 'rgba(255,255,255,.02)'); gr.addColorStop(1, 'rgba(0,0,0,.05)');
      g.fillStyle = gr; g.fillRect(x, y, L, L);
    }
    for (var i = 0; i < 18; i++) {
      var mx = r() * N, my = r() * N, mr = 50 + r() * 140;
      var rg = g.createRadialGradient(mx, my, 0, mx, my, mr);
      var esc = r() < 0.7;
      rg.addColorStop(0, esc ? 'rgba(0,0,0,.26)' : 'rgba(60,50,28,.13)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(mx - mr, my - mr, mr * 2, mr * 2);
    }
    /* grão suave: pontos de 4 px com opacidade baixa (não cintilam na redução) */
    for (i = 0; i < 1400; i++) {
      g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,' + (0.012 + r() * 0.02) + ')' : 'rgba(0,0,0,' + (0.03 + r() * 0.05) + ')';
      var sz = 3 + r() * 5;
      g.fillRect(r() * N, r() * N, sz, sz);
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (i = 0; i < 14; i++) {
      var cx = r() * N, cy = r() * N, ang = r() * TAU;
      g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 3 + r() * 1.5;
      g.beginPath(); g.moveTo(cx, cy);
      var n = 6 + (r() * 8) | 0;
      for (var k = 0; k < n; k++) {
        ang += (r() - 0.5) * 1.1; var ll = 16 + r() * 28;
        cx += Math.cos(ang) * ll; cy += Math.sin(ang) * ll;
        g.lineTo(cx, cy);
        if (r() < 0.18) { var ba = ang + (r() - 0.5) * 2; g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ba) * 30, cy + Math.sin(ba) * 30); g.moveTo(cx, cy); }
      }
      g.stroke();
    }
    for (var j = 0; j < N; j += L) {
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(j - 3, 0, 6, N); g.fillRect(0, j - 3, N, 6);
      g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(j + 3, 0, 3, N); g.fillRect(0, j + 3, N, 3);
    }
    g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(N - 3, 0, 3, N); g.fillRect(0, N - 3, N, 3);
    return c;
  }
  function criarChao(ctx, nivel) {
    if (!mestreChao) mestreChao = criarMestreChao();
    var lado = 512 * nivel, c = mestreChao;
    if (lado !== 1024) {
      c = document.createElement('canvas'); c.width = c.height = lado;
      var g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(mestreChao, 0, 0, lado, lado);
    }
    var pat = ctx.createPattern(c, 'repeat');
    try { pat.setTransform(new DOMMatrix([1 / nivel, 0, 0, 1 / nivel, 0, 0])); } catch (e) { }
    return pat;
  }

  /* ---------- silhuetas das armas para o HUD (viewBox 0 0 64 26) ---------- */
  var ICONES_ARMA = [
    'M4 4h40v8H28l-3 11h-9l3-11H4z',
    'M1 7h47v7H31v10h-7V14h-6l-3 9h-7l3-9H1zM48 8h13v5H48z',
    'M0 9h13l3-3h26l4 3h18v6H49l-3 3h-3v8h-7v-8H22l-3 7h-7l3-7H0z',
    'M0 8h56l5 3v3H44v3H30v-3H15l-7 8H2l5-8H0z',
    'M2 6h42l6-3h12v10H50l-6-3H2zM18 13h8l2 10h-8z',
    'M0 9h10l3-3h14v3h9l2-3h20v3h5v5H46l-2 3H27v6h-6v-6H13l-3-3H0z',
    'M2 6h40l4-2h16v8H44l-3 2h-5l-1 10h-7l1-10H18l-3 6H9l3-6H2z'
  ];
  var ICONE_GRANADA = 'M29 2h10l-2 5v1.5a8.5 8.5 0 1 1-6 0V7z';

  /* escolhe a densidade de sprite mais próxima do zoom real (pixels de tela por unidade de mundo) */
  function escolherNivel(pxPorUnidade) { return pxPorUnidade <= 1.25 ? 1 : (pxPorUnidade <= 2.4 ? 2 : 3); }

  MV.Sprites = { criarZumbis: criarZumbis, membro: membro, criarChao: criarChao, ICONES_ARMA: ICONES_ARMA, ICONE_GRANADA: ICONE_GRANADA, escolherNivel: escolherNivel, U: U };
})(window.MV = window.MV || {});
