/* ============================================================================================
 * INFERNO DOS MORTOS · legado.js — conquistas permanentes, Pontos de Recompensa (PC) e árvore de metaprogressão
 *
 * Perfil GLOBAL (independe dos 3 slots de campanha), salvo em localStorage ("mv_legado").
 *   · 11 conquistas (Categoria A iniciais + Categoria B avançadas, com o Veterano em 4 estágios). Cada uma paga PC e libera um bônus passivo.
 *   · Árvore de metaprogressão: gaste PC no menu principal em 4 trilhas (HP, velocidade, munição, drops).
 *   · Tudo é DADO + funções puras. O game.js só chama inc()/max()/marcar()/checar() e consulta os multiplicadores (hpMult(), velMult()...).
 *
 * Escala de distância: 60 unidades de mundo = 1 metro (o mapa tem 40 × 30 m; o soldado anda ≈ 3 m/s; 50 km ≈ 4,7 h de caminhada).
 * ========================================================================================== */
(function (MV) {
  'use strict';
  var CHAVE = 'mv_legado', VERSAO = 1;
  var UNID_POR_M = 60;

  /* ---------- conquistas ----------
   * modo 'tot' (contador acumulado), 'max' (recorde) ou 'ev' (evento marcado pelo jogo com marcar(id)).
   * bonus: id que o resto do jogo consulta com tem(id). */
  function C(id, cat, nome, desc, stat, meta, pc, bonus, bonusTxt, extra) {
    var o = { id: id, cat: cat, nome: nome, desc: desc, stat: stat, meta: meta, pc: pc, bonus: bonus, bonusTxt: bonusTxt };
    if (extra) for (var k in extra) o[k] = extra[k];
    return o;
  }
  var CONQUISTAS = [
    /* Categoria A · iniciais */
    C('a1', 'A', 'PRIMEIRA SANGRIA', 'Elimine 50 zumbis.', 'abates', 50, 100, 'laser', 'MIRA LASER VERMELHA · +5% de precisão'),
    C('a2', 'A', 'SOBREVIVENTE URBANO', 'Sobreviva até a Horda 5 em uma partida.', 'rodadaMax', 5, 250, 'recarga10', '+10% de velocidade de recarga base', { modo: 'max' }),
    C('a3', 'A', 'MESTRE DO ARSENAL', 'Elimine 1 zumbi com 4 armas diferentes na mesma rodada.', 'a3', 1, 300, 'troca', 'TROCA RÁPIDA · −50% no tempo de troca', { modo: 'ev' }),
    C('a4', 'A', 'TIRADOR DE ELITE', 'Alcance 85% de precisão em uma onda (mínimo de 30 tiros).', 'a4', 1, 200, 'critico', '+15% de chance crítica (dano 2×)', { modo: 'ev' }),
    /* Categoria B · avançadas */
    C('b1', 'B', 'VETERANO DO APOCALIPSE · I', 'Acumule 1.000 abates.', 'abates', 1000, 500, 'perfurante', 'MUNIÇÃO PERFURANTE · +1 alvo atravessado'),
    C('b2', 'B', 'VETERANO DO APOCALIPSE · II', 'Acumule 10.000 abates.', 'abates', 10000, 2500, 'skinAzul', 'SKIN CAMUFLAGEM DIGITAL BLUE'),
    C('b3', 'B', 'VETERANO DO APOCALIPSE · III', 'Acumule 50.000 abates.', 'abates', 50000, 7500, 'hp15', '+15% de HP máximo base'),
    C('b4', 'B', 'VETERANO DO APOCALIPSE · IV', 'Acumule 100.000 abates.', 'abates', 100000, 20000, 'berserker', 'MODO BERSERKER · +0,5% de dano a cada 1% de HP perdido'),
    C('b5', 'B', 'MARATONISTA SINISTRO', 'Percorra 50 km acumulados no mapa.', 'unid', 50 * 1000 * UNID_POR_M, 1500, 'botas', 'BOTAS TÁTICAS · +12% de velocidade de movimento', { fmt: 'km' }),
    C('b6', 'B', 'RESISTÊNCIA ABSOLUTA', 'Complete 100 ondas acumuladas.', 'ondas', 100, 3000, 'pesadelo', 'LIBERA O MODO PESADELO · +50% de XP e pontos'),
    C('b7', 'B', 'INIMIGO DO PERIGO', 'Colete 200 drops/caixas.', 'drops', 200, 1200, 'ima', 'Raio de atração de itens +35%')
  ];
  var POR_ID = {}; CONQUISTAS.forEach(function (c) { POR_ID[c.id] = c; });

  /* ---------- árvore de metaprogressão: custo em PC por nível ---------- */
  var ARVORE = [
    { id: 'fisica', nome: 'RESISTÊNCIA FÍSICA', custo: [200, 500, 1000, 2000, 5000], por: '+5% de HP máximo por nível', ef: function (n) { return '+' + (n * 5) + '% HP máx.'; } },
    { id: 'agil', nome: 'AGILIDADE TÁTICA', custo: [200, 500, 1000, 2000, 5000], por: '+3% de velocidade por nível', ef: function (n) { return '+' + (n * 3) + '% velocidade'; } },
    { id: 'muni', nome: 'MANÍACO POR MUNIÇÃO', custo: [1000, 2500, 5000], por: '+15% de capacidade de munição por nível', ef: function (n) { return '+' + (n * 15) + '% munição'; } },
    { id: 'sorte', nome: 'SORTE DE SAQUEADOR', custo: [800, 2000, 4000], por: '+10% de chance de drop de itens por nível', ef: function (n) { return '+' + (n * 10) + '% drops'; } }
  ];
  var ARV_POR_ID = {}; ARVORE.forEach(function (t) { ARV_POR_ID[t.id] = t; });

  /* ---------- perfil ---------- */
  function perfilNovo() { return { v: VERSAO, pc: 0, gasto: 0, conq: {}, stats: {}, niv: { fisica: 0, agil: 0, muni: 0, sorte: 0 }, pesadelo: false, cache: 0 }; }
  var P = perfilNovo();
  var sujo = false, onConquista = null;

  function num(v, d) { v = +v; return isFinite(v) && v >= 0 ? v : d; }
  function limpo(p) {
    var o = perfilNovo(); if (!p || typeof p !== 'object') return o;
    o.pc = Math.floor(num(p.pc, 0)); o.gasto = Math.floor(num(p.gasto, 0));
    if (p.conq && typeof p.conq === 'object') CONQUISTAS.forEach(function (c) { if (p.conq[c.id]) o.conq[c.id] = +p.conq[c.id] || 1; });
    if (p.stats && typeof p.stats === 'object') for (var k in p.stats) { var v = +p.stats[k]; if (isFinite(v) && v >= 0) o.stats[k] = v; }
    ARVORE.forEach(function (t) { var n = Math.floor(num(p.niv && p.niv[t.id], 0)); o.niv[t.id] = Math.min(t.custo.length, n); });
    o.pesadelo = !!p.pesadelo;
    return o;
  }
  function carregar() {
    try { P = limpo(JSON.parse(localStorage.getItem(CHAVE) || 'null')); } catch (e) { P = perfilNovo(); }
    sujo = false;
  }
  function salvar(forcar) {
    if (!sujo && !forcar) return true;
    try { localStorage.setItem(CHAVE, JSON.stringify(P)); sujo = false; return true; } catch (e) { return false; }
  }
  function apagarTudo() { P = perfilNovo(); sujo = true; salvar(true); }

  /* ---------- estatísticas e conquistas ---------- */
  function inc(stat, n) { P.stats[stat] = (P.stats[stat] || 0) + (n === undefined ? 1 : n); sujo = true; }
  function max(stat, v) { if (v > (P.stats[stat] || 0)) { P.stats[stat] = v; sujo = true; } }
  function stat(s) { return P.stats[s] || 0; }
  function marcar(id) { var c = POR_ID[id]; if (c && c.modo === 'ev' && !P.conq[id]) { P.stats[c.stat] = 1; sujo = true; } }
  /* verifica tudo; devolve as recém-desbloqueadas (paga o PC na hora e avisa por onConquista) */
  function checar() {
    var novas = [];
    for (var i = 0; i < CONQUISTAS.length; i++) {
      var c = CONQUISTAS[i];
      if (!P.conq[c.id] && (P.stats[c.stat] || 0) >= c.meta) {
        P.conq[c.id] = Date.now(); P.pc += c.pc; sujo = true; novas.push(c);
        if (onConquista) { try { onConquista(c); } catch (e) { } }
      }
    }
    if (novas.length) salvar(true);
    return novas;
  }
  function progresso(c) { return Math.min(1, (P.stats[c.stat] || 0) / c.meta); }
  function tem(bonus) { for (var i = 0; i < CONQUISTAS.length; i++) if (CONQUISTAS[i].bonus === bonus) return !!P.conq[CONQUISTAS[i].id]; return false; }

  /* ---------- árvore ---------- */
  function niv(id) { return P.niv[id] || 0; }
  function custoProx(id) { var t = ARV_POR_ID[id]; if (!t) return 0; var n = niv(id); return n >= t.custo.length ? 0 : t.custo[n]; }
  function comprar(id) {
    var t = ARV_POR_ID[id]; if (!t) return 'invalido';
    var n = niv(id); if (n >= t.custo.length) return 'maximo';
    var c = t.custo[n]; if (P.pc < c) return 'pc';
    P.pc -= c; P.gasto += c; P.niv[id] = n + 1; sujo = true; salvar(true); return 'ok';
  }

  /* ---------- multiplicadores consultados pelo jogo ---------- */
  function hpMult() { return 1 + 0.05 * niv('fisica') + (tem('hp15') ? 0.15 : 0); }
  function velMult() { return (1 + 0.03 * niv('agil')) * (tem('botas') ? 1.12 : 1); }
  function capMun() { return 1 + 0.15 * niv('muni'); }
  function dropMult() { return 1 + 0.10 * niv('sorte'); }
  function pesadeloAtivo() { return tem('pesadelo') && !!P.pesadelo; }
  function xpMult() { return pesadeloAtivo() ? 1.5 : 1; }
  function precisaoMult() { return tem('laser') ? 0.95 : 1; }      /* multiplica o espalhamento: −5% = +5% de precisão */
  function recargaMult() { return tem('recarga10') ? 0.9 : 1; }
  function trocaMult() { return tem('troca') ? 0.5 : 1; }
  function chanceCritica() { return tem('critico') ? 0.15 : 0; }
  function perfurar() { return tem('perfurante') ? 1 : 0; }
  function berserk() { return tem('berserker'); }
  function imaMult() { return tem('ima') ? 1.35 : 1; }
  function alternarPesadelo() { if (!tem('pesadelo')) return false; P.pesadelo = !P.pesadelo; sujo = true; salvar(true); return P.pesadelo; }

  function fmtKm(u) { var km = u / UNID_POR_M / 1000; return km >= 10 ? km.toFixed(1).replace('.', ',') : km.toFixed(2).replace('.', ','); }

  carregar();
  MV.Legado = {
    CONQUISTAS: CONQUISTAS, ARVORE: ARVORE, UNID_POR_M: UNID_POR_M,
    carregar: carregar, salvar: salvar, apagarTudo: apagarTudo,
    inc: inc, max: max, stat: stat, marcar: marcar, checar: checar, progresso: progresso, tem: tem,
    niv: niv, custoProx: custoProx, comprar: comprar,
    hpMult: hpMult, velMult: velMult, capMun: capMun, dropMult: dropMult, xpMult: xpMult, pesadeloAtivo: pesadeloAtivo,
    precisaoMult: precisaoMult, recargaMult: recargaMult, trocaMult: trocaMult, chanceCritica: chanceCritica, perfurar: perfurar, berserk: berserk, imaMult: imaMult,
    alternarPesadelo: alternarPesadelo, fmtKm: fmtKm,
    get pc() { return P.pc; }, get gasto() { return P.gasto; }, get pesadelo() { return P.pesadelo; }, get conq() { return P.conq; }, get perfil() { return P; },
    set onConquista(f) { onConquista = f; }
  };
})(window.MV = window.MV || {});
