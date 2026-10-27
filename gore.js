/* ============================================================================================
 * INFERNO DOS MORTOS · gore.js — partes do corpo, corpos e sangue (desenho puro, sem estado de jogo)
 *
 * O game.js mantém o pool dinâmico de GorePart (partes voando) e o canvas offscreen persistente (goreCv).
 * Este módulo só sabe DESENHAR em um contexto 2D já transformado para coordenadas de mundo:
 *   · desenharParte(g, tipoParte, tipoZumbi, esc, rot, x, y)  cabeça / braço E / braço D / pernas
 *   · corpo(sp, tipo, mascara)                                  sprite escurecido do cadáver (cacheado por densidade)
 *   · jorro / poca / rastro                                     manchas de sangue direcionais, poças e rastros
 * Partes: 0 cabeça, 1 braço esquerdo, 2 braço direito, 3 pernas.
 * ========================================================================================== */
(function (MV) {
  'use strict';
  var TAU = Math.PI * 2;
  function rnd() { return Math.random(); }

  /* pele / roupa / bota / sangue por tipo de infectado (0 comum, 1 veloz, 2 bruto, 3 corredor, 4 tanque, 5 tóxico, 6 bomber) */
  var PAL = [
    { pele: '#93a578', esc: '#5d6e4a', roupa: '#4b4035', calca: '#2c3947', sangue: '88,8,12' },
    { pele: '#b2b88f', esc: '#6f7858', roupa: '#6e2b2b', calca: '#3d2020', sangue: '92,10,12' },
    { pele: '#6f8a68', esc: '#43573f', roupa: '#2f3438', calca: '#1c2023', sangue: '70,8,10' },
    { pele: '#b7bda3', esc: '#7d8470', roupa: '#566b7d', calca: '#27323c', sangue: '90,10,14' },
    { pele: '#8c7667', esc: '#5d4a40', roupa: '#8c7667', calca: '#35373a', sangue: '82,8,10' },
    { pele: '#b9c47c', esc: '#7f9140', roupa: '#9aab52', calca: '#5f6e2b', sangue: '96,128,26' },
    { pele: '#a89b6e', esc: '#6d6544', roupa: '#7a4d22', calca: '#3b2a18', sangue: '84,12,10' }
  ];
  function pal(t) { return PAL[t] || PAL[0]; }

  function toco(g, x, y, r) {
    g.fillStyle = '#5c0d10'; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.fillStyle = '#9a1c20'; g.beginPath(); g.arc(x + r * 0.15, y - r * 0.15, r * 0.55, 0, TAU); g.fill();
    g.fillStyle = '#e6dccb'; g.beginPath(); g.arc(x, y, r * 0.24, 0, TAU); g.fill();
  }

  /* desenha uma parte do corpo centrada em (x,y), girada por rot; esc = raio do zumbi / 14 */
  function desenharParte(g, parte, tipo, esc, rot, x, y) {
    var p = pal(tipo);
    g.save(); g.translate(x, y); g.rotate(rot); g.scale(esc, esc);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (parte === 0) {                                              /* cabeça */
      g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.ellipse(1.4, 1.8, 7, 6, 0, 0, TAU); g.fill();
      g.fillStyle = p.pele; g.strokeStyle = '#0b0d0c'; g.lineWidth = 1.2;
      g.beginPath(); g.arc(0, 0, 6.5, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = p.esc; g.beginPath(); g.arc(-1.6, 0, 5.6, Math.PI * 0.55, Math.PI * 1.45); g.lineTo(-1.6, 0); g.fill();
      g.strokeStyle = '#1a0606'; g.lineWidth = 1;                   /* olhos mortos (X) */
      g.beginPath(); g.moveTo(3.2, -3.6); g.lineTo(5.2, -1.6); g.moveTo(5.2, -3.6); g.lineTo(3.2, -1.6); g.moveTo(3.2, 1.6); g.lineTo(5.2, 3.6); g.moveTo(5.2, 1.6); g.lineTo(3.2, 3.6); g.stroke();
      g.fillStyle = 'rgba(' + p.sangue + ',.9)'; g.beginPath(); g.ellipse(-4.6, 0.4, 3.6, 3.1, 0.3, 0, TAU); g.fill();
      toco(g, -5.4, 0.4, 2.4);
    } else if (parte === 3) {                                       /* pernas (par) */
      for (var k = -1; k <= 1; k += 2) {
        var oy = k * 3.6;
        g.strokeStyle = '#0b0d0c'; g.lineWidth = 6.4; g.beginPath(); g.moveTo(-8, oy); g.lineTo(8, oy + k * 0.8); g.stroke();
        g.strokeStyle = p.calca; g.lineWidth = 5; g.beginPath(); g.moveTo(-8, oy); g.lineTo(8, oy + k * 0.8); g.stroke();
        g.fillStyle = '#17181a'; g.beginPath(); g.ellipse(9, oy + k * 0.9, 3.6, 2.6, 0, 0, TAU); g.fill();
        toco(g, -8.4, oy, 2.7);
      }
    } else {                                                        /* braço (1 esquerdo · 2 direito) */
      var s = parte === 1 ? -1 : 1;
      g.strokeStyle = '#0b0d0c'; g.lineWidth = 6.4; g.beginPath(); g.moveTo(-8, 0); g.lineTo(0, s * 1.2); g.lineTo(8, 0); g.stroke();
      g.strokeStyle = p.roupa; g.lineWidth = 5; g.beginPath(); g.moveTo(-8, 0); g.lineTo(0, s * 1.2); g.stroke();
      g.strokeStyle = p.pele; g.lineWidth = 4; g.beginPath(); g.moveTo(0, s * 1.2); g.lineTo(8, 0); g.stroke();
      g.fillStyle = p.esc; g.beginPath(); g.arc(9.4, 0, 2.8, 0, TAU); g.fill();
      g.strokeStyle = '#c9c5b3'; g.lineWidth = 0.9;
      for (var d = -1; d <= 1; d++) { g.beginPath(); g.moveTo(10, 0); g.lineTo(13.2, d * 1.9); g.stroke(); }
      toco(g, -8.6, 0, 3);
    }
    g.restore();
  }

  /* cadáver: o sprite do infectado (sem os membros perdidos), escurecido e com uma mancha de sangue por baixo. Um canvas por (tipo, máscara, densidade). */
  var corpos = {};
  function corpo(sp, tipo, mask) {
    var key = sp.nivel + ':' + tipo + ':' + (mask & 7), c = corpos[key];
    if (c) return c;
    var lado = sp.U * sp.nivel, set = MV.Sprites.membro(sp, tipo, mask & 7);
    c = document.createElement('canvas'); c.width = c.height = lado;
    var g = c.getContext('2d');
    g.drawImage(set.normal[tipo][1], 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(26,10,10,.52)'; g.fillRect(0, 0, lado, lado);           /* palidez de morto */
    g.globalCompositeOperation = 'source-over';
    corpos[key] = c;
    return c;
  }
  function limparCache(nivel) { for (var k in corpos) if (nivel === undefined || k.indexOf(nivel + ':') === 0) delete corpos[k]; }

  /* ---- sangue ---- */
  /* jorro direcional: gotas em leque na direção do tiro (dx,dy), maiores perto da origem, com respingos alongados.
     intens 0.3 (acerto) a 2 (explosão). cor = "r,g,b". */
  function jorro(g, x, y, dx, dy, intens, cor) {
    var base = Math.atan2(dy, dx), n = Math.min(34, (4 + intens * 9) | 0), i;
    for (i = 0; i < n; i++) {
      var a = base + (rnd() - 0.5) * (intens > 1 ? 3.2 : 1.2), d = 8 + rnd() * rnd() * (60 + 110 * intens);
      var px = x + Math.cos(a) * d, py = y + Math.sin(a) * d, r = (0.9 + rnd() * 2.6) * (1.1 - d / (220 * intens + 60) * 0.5);
      g.fillStyle = 'rgba(' + cor + ',' + (0.45 + rnd() * 0.4).toFixed(2) + ')';
      g.beginPath(); g.ellipse(px, py, r * (1 + d / 70), r, a, 0, TAU); g.fill();
    }
    if (intens >= 0.8) {                                                  /* traço comprido de sangue arrastado */
      g.strokeStyle = 'rgba(' + cor + ',.38)'; g.lineWidth = 1.2 + rnd() * 1.6; g.lineCap = 'round';
      for (i = 0; i < 2 + ((intens * 2) | 0); i++) {
        var a2 = base + (rnd() - 0.5) * 0.9, l = 30 + rnd() * 90 * intens;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a2) * l, y + Math.sin(a2) * l); g.stroke();
      }
    }
  }
  /* poça irregular (várias elipses sobrepostas); a = opacidade */
  function poca(g, x, y, r, cor, a) {
    for (var i = 0, n = 3 + ((r / 9) | 0); i < n; i++) {
      var rr = r * (0.3 + rnd() * 0.5), ox = (rnd() - 0.5) * r * 0.9, oy = (rnd() - 0.5) * r * 0.9;
      g.fillStyle = 'rgba(' + cor + ',' + (a * (0.7 + rnd() * 0.4)).toFixed(2) + ')';
      g.beginPath(); g.ellipse(x + ox, y + oy, rr, rr * (0.6 + rnd() * 0.4), rnd() * TAU, 0, TAU); g.fill();
    }
    g.fillStyle = 'rgba(' + cor + ',' + (a * 0.6).toFixed(2) + ')';                 /* brilho úmido no centro */
    g.beginPath(); g.ellipse(x, y, r * 0.35, r * 0.28, rnd() * TAU, 0, TAU); g.fill();
  }
  /* rastro de arrasto (rastejador) */
  function rastro(g, x, y, ang, cor) {
    g.fillStyle = 'rgba(' + cor + ',.5)';
    g.beginPath(); g.ellipse(x - Math.cos(ang) * 4, y - Math.sin(ang) * 4, 5.5, 3, ang, 0, TAU); g.fill();
  }

  MV.Gore = { desenharParte: desenharParte, corpo: corpo, limparCache: limparCache, jorro: jorro, poca: poca, rastro: rastro, corSangue: function (t) { return pal(t).sangue; } };
})(window.MV = window.MV || {});
