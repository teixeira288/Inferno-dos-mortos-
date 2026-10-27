/* ============================================================================================
 * INFERNO DOS MORTOS · meta.js — progresso permanente
 *   · 3 slots de save (localStorage: mv_slot_1..3) com checkpoint de partida + perfil permanente
 *   · 3 árvores de habilidades (Tiro, Força, Corrida) · níveis 1 a 10, ganhas por XP
 *   · 30 conquistas e 12 recompensas (Comum / Rara / Épica / Lendária)
 * Tudo é DADO (arrays/objetos) + funções puras; o game.js só chama inc()/max()/checar() e consulta bônus.
 * ========================================================================================== */
(function (MV) {
  'use strict';
  var N_SLOTS = 3, VERSAO = 1;

  /* ---------- raridades: cor + pontos de conquista proporcionais à dificuldade ---------- */
  var RARIDADES = {
    comum: { nome: 'COMUM', cor: '#cfd8c6', pts: 20, ord: 0 },
    rara: { nome: 'RARA', cor: '#5ee7ff', pts: 50, ord: 1 },
    epica: { nome: 'ÉPICA', cor: '#c06bff', pts: 100, ord: 2 },
    lendaria: { nome: 'LENDÁRIA', cor: '#ffb000', pts: 250, ord: 3 }
  };

  /* ---------- habilidades ----------
   * xp acumulado total → nível = 1 + quantos limiares foram superados. LIMIARES[k] = XP total para chegar ao nível k+2. */
  var LIMIARES = [60, 160, 310, 520, 800, 1160, 1610, 2160, 2820];
  var HAB = {
    tiro: { nome: 'TIRO', desc: 'Cadência de disparo e recarga mais rápidas', ganho: 'Ganha XP atirando e abatendo infectados',
      efeito: function (n) { return '+' + Math.round((cadencia(n) - 1) * 100) + '% cadência · −' + Math.round((1 - recarga(n)) * 100) + '% recarga'; } },
    forca: { nome: 'FORÇA', desc: 'Resistência a dano e empurrão ao ser atingido', ganho: 'Ganha XP ao levar dano e ao sobreviver às rodadas',
      efeito: function (n) { return '−' + Math.round((1 - danoRecebido(n)) * 100) + '% dano recebido · empurrão ' + (n - 1) + '/9'; } },
    corrida: { nome: 'CORRIDA', desc: 'Velocidade de movimento', ganho: 'Ganha XP correndo de forma contínua',
      efeito: function (n) { return '+' + Math.round((velocidade(n) - 1) * 100) + '% velocidade'; } }
  };
  function cadencia(n) { return 1 + 0.04 * (n - 1); }        /* multiplicador da cadência de tiro */
  function recarga(n) { return 1 - 0.035 * (n - 1); }        /* multiplicador do tempo de recarga */
  function danoRecebido(n) { return 1 - 0.035 * (n - 1); }   /* multiplicador do dano sofrido */
  function velocidade(n) { return 1 + 0.025 * (n - 1); }     /* multiplicador da velocidade de movimento */
  function nivelDeXp(xp) { var n = 1; for (var i = 0; i < LIMIARES.length; i++) if (xp >= LIMIARES[i]) n = i + 2; return n; }
  /* progresso (0..1) dentro do nível atual */
  function progressoXp(xp) {
    var n = nivelDeXp(xp); if (n >= 10) return 1;
    var a = n === 1 ? 0 : LIMIARES[n - 2], b = LIMIARES[n - 1];
    return Math.max(0, Math.min(1, (xp - a) / (b - a)));
  }

  /* ---------- conquistas (30) ----------
   * stat: contador | modo: 'tot' (acumulado, soma) ou 'max' (recorde) | meta: valor para desbloquear */
  function C(id, nome, desc, rar, stat, meta) { return { id: id, nome: nome, desc: desc, rar: rar, stat: stat, meta: meta, pts: RARIDADES[rar].pts }; }
  var CONQUISTAS = [
    C('c01', 'PRIMEIRO SANGUE', 'Abata seu primeiro infectado.', 'comum', 'abates', 1),
    C('c02', 'AINDA RESPIRANDO', 'Alcance a rodada 3.', 'comum', 'rodadaMax', 3),
    C('c03', 'CAÇADOR', 'Abata 50 infectados.', 'comum', 'abates', 50),
    C('c04', 'CLIENTE DA ARMARIA', 'Faça 3 compras na Armaria.', 'comum', 'compras', 3),
    C('c05', 'PINO PUXADO', 'Abata 5 infectados com granadas.', 'comum', 'granadaKills', 5),
    C('c06', 'PIRÔMANO', 'Abata 5 infectados com fogo.', 'comum', 'fogoKills', 5),
    C('c07', 'MOCHILA CHEIA', 'Use 3 postos de reabastecimento.', 'comum', 'reabast', 3),
    C('c08', 'PRIMEIROS SOCORROS', 'Use 3 atendimentos médicos.', 'comum', 'curas', 3),
    C('c09', 'CATADOR', 'Colete 5 suprimentos raros.', 'comum', 'buffs', 5),
    C('c10', 'FÔLEGO DE ATLETA', 'Corra por 2 minutos no total.', 'comum', 'corridaSeg', 120),
    C('c11', 'VETERANO', 'Alcance a rodada 7.', 'rara', 'rodadaMax', 7),
    C('c12', 'EXTERMINADOR', 'Abata 300 infectados.', 'rara', 'abates', 300),
    C('c13', 'CAMPO MINADO', 'Abata 10 infectados com minas.', 'rara', 'minaKills', 10),
    C('c14', 'BARRIL DE PÓLVORA', 'Abata 10 infectados com barris explosivos.', 'rara', 'barrilKills', 10),
    C('c15', 'CAÇA-TANQUES', 'Derrube 3 tanques.', 'rara', 'tanques', 3),
    C('c16', 'ANTÍDOTO', 'Abata 10 tóxicos.', 'rara', 'toxicos', 10),
    C('c17', 'REFLEXOS', 'Abata 15 corredores.', 'rara', 'corredores', 15),
    C('c18', 'ARSENAL', 'Tenha 4 armas ao mesmo tempo.', 'rara', 'armasMax', 4),
    C('c19', 'PELE DE AÇO', 'Chegue à Força nível 5.', 'rara', 'forcaNv', 5),
    C('c20', 'GATILHO LEVE', 'Chegue ao Tiro nível 5.', 'rara', 'tiroNv', 5),
    C('c21', 'LINHA DE FRENTE', 'Alcance a rodada 12.', 'epica', 'rodadaMax', 12),
    C('c22', 'MASSACRE', 'Abata 1.000 infectados.', 'epica', 'abates', 1000),
    C('c23', 'REAÇÃO EM CADEIA', 'Abata 8 infectados em uma única explosão.', 'epica', 'multiKill', 8),
    C('c24', 'INTOCÁVEL', 'Termine 3 rodadas sem levar dano.', 'epica', 'rodadasLimpas', 3),
    C('c25', 'NO LIMITE', 'Alcance a rodada 5 no Modo Insano.', 'epica', 'insanoRodada', 5),
    C('c26', 'ESPECIALISTA', 'Todas as habilidades no nível 7.', 'epica', 'habMin', 7),
    C('c27', 'MAGNATA DO APOCALIPSE', 'Ganhe 100.000 pontos no total.', 'epica', 'pontosTot', 100000),
    C('c28', 'ÚLTIMO DE PÉ', 'Alcance a rodada 20.', 'lendaria', 'rodadaMax', 20),
    C('c29', 'LENDA VIVA', 'Alcance a rodada 10 no Modo Insano.', 'lendaria', 'insanoRodada', 10),
    C('c30', 'IMORTAL', 'Todas as habilidades no nível 10.', 'lendaria', 'habMin', 10)
  ];

  /* ---------- recompensas (12) · custo em pontos de conquista ---------- */
  function R(id, nome, desc, rar, custo) { return { id: id, nome: nome, desc: desc, rar: rar, custo: custo }; }
  var RECOMPENSAS = [
    R('r01', 'VERBA DE GUERRA', 'Começa cada nova operação com +1.000 pontos.', 'comum', 60),
    R('r02', 'ARSENAL TÁTICO', 'Começa com +2 granadas, +1 molotov e +1 mina.', 'comum', 80),
    R('r03', 'COLETE REFORÇADO', '+25 de integridade máxima.', 'rara', 150),
    R('r04', 'MOCHILA DE MUNIÇÃO', '+30% de capacidade de munição de reserva.', 'rara', 150),
    R('r05', 'OLHOS DE GATO', 'Lanterna com +25% de alcance.', 'rara', 200),
    R('r06', 'ESCUDO INICIAL', 'Começa cada rodada com o escudo ativo.', 'epica', 250),
    R('r07', 'DESCONTO DE VETERANO', '−15% em tudo na Armaria e nos postos.', 'epica', 300),
    R('r08', 'STAMINA INFINITA', 'Energia infinita para correr (exceto no Modo Insano).', 'epica', 400),
    R('r09', 'VIDA INFINITA', 'Integridade nunca cai (exceto no Modo Insano).', 'epica', 500),
    R('r10', 'VIDA INFINITA · INSANO', 'Integridade nunca cai também no Modo Insano.', 'lendaria', 600),
    R('r11', 'MUNIÇÃO INFINITA · INSANO', 'Pente sem fim no Modo Insano.', 'lendaria', 600),
    R('r12', 'MINI GUN', 'Arma exclusiva: 22 tiros/s. Já vem na mochila.', 'lendaria', 700)
  ];

  /* ---------- perfil permanente (um por slot) ---------- */
  function perfilNovo() { return { xp: { tiro: 0, forca: 0, corrida: 0 }, conq: {}, stats: {}, resg: {}, tempo: 0 }; }
  var P = perfilNovo();      /* perfil ativo */
  var slot = 0;              /* 0 = nenhum (partida rápida, nada é salvo) */
  var onConquista = null;    /* function (conquista) */
  var onNivel = null;        /* function (habKey, nivel) */

  /* ---------- armazenamento ---------- */
  function chave(i) { return 'mv_slot_' + i; }
  function ler(i) {
    try { var s = JSON.parse(localStorage.getItem(chave(i)) || 'null'); return s && typeof s === 'object' && s.perfil ? s : null; } catch (e) { return null; }
  }
  function gravar(i, obj) { try { localStorage.setItem(chave(i), JSON.stringify(obj)); return true; } catch (e) { return false; } }
  function apagar(i) { try { localStorage.removeItem(chave(i)); } catch (e) { } }
  /* sanitiza um save lido (dados corrompidos/antigos não derrubam o jogo) */
  function limpoPerfil(p) {
    var o = perfilNovo(); if (!p || typeof p !== 'object') return o;
    ['tiro', 'forca', 'corrida'].forEach(function (k) { var v = p.xp && +p.xp[k]; o.xp[k] = v > 0 && isFinite(v) ? v : 0; });
    if (p.conq) CONQUISTAS.forEach(function (c) { if (p.conq[c.id]) o.conq[c.id] = p.conq[c.id]; });
    if (p.resg) RECOMPENSAS.forEach(function (r) { if (p.resg[r.id]) o.resg[r.id] = true; });
    if (p.stats) for (var k in p.stats) { var v = +p.stats[k]; if (isFinite(v) && v >= 0) o.stats[k] = v; }
    o.tempo = +p.tempo > 0 ? +p.tempo : 0;
    return o;
  }

  function novoSlot(i, extra) {
    P = perfilNovo(); slot = i;
    var agora = Date.now();
    var s = { v: VERSAO, criado: agora, atual: agora, perfil: P, ck: null, info: { rodada: 1, pontos: 0, dif: 'normal' } };
    if (extra) for (var k in extra) s[k] = extra[k];
    gravar(i, s); return s;
  }
  function carregarSlot(i) {
    var s = ler(i); if (!s) return null;
    P = limpoPerfil(s.perfil); slot = i; s.perfil = P; return s;
  }
  /* grava o perfil e o checkpoint (ck pode ser undefined = mantém o anterior) */
  function salvar(ck, info) {
    if (!slot) return false;
    var s = ler(slot) || { v: VERSAO, criado: Date.now(), ck: null, info: {} };
    s.v = VERSAO; s.atual = Date.now(); s.perfil = P;
    if (ck !== undefined) s.ck = ck;
    if (info) { s.info = s.info || {}; for (var k in info) s.info[k] = info[k]; }
    return gravar(slot, s);
  }
  function sair() { slot = 0; P = perfilNovo(); }

  /* ---------- estatísticas, habilidades, conquistas ---------- */
  function inc(stat, n) { if (!slot) return; P.stats[stat] = (P.stats[stat] || 0) + (n === undefined ? 1 : n); }
  function max(stat, v) { if (!slot) return; if (v > (P.stats[stat] || 0)) P.stats[stat] = v; }
  function stat(s) { return P.stats[s] || 0; }
  function nivel(k) { return slot ? nivelDeXp(P.xp[k] || 0) : 1; }     /* sem slot: tudo nível 1 */
  function ganharXp(k, v) {
    if (!slot || !(v > 0)) return;
    var antes = nivelDeXp(P.xp[k]); P.xp[k] += v;
    var dep = nivelDeXp(P.xp[k]);
    if (dep > antes && onNivel) onNivel(k, dep);
  }
  function atualizarNiveis() {
    var a = nivel('tiro'), b = nivel('forca'), c = nivel('corrida');
    max('tiroNv', a); max('forcaNv', b); max('corridaNv', c); max('habMin', Math.min(a, b, c));
  }
  /* verifica todas as conquistas; devolve as recém-desbloqueadas (e avisa por onConquista) */
  function checar() {
    if (!slot) return [];
    atualizarNiveis();
    var novas = [];
    for (var i = 0; i < CONQUISTAS.length; i++) {
      var c = CONQUISTAS[i];
      if (!P.conq[c.id] && (P.stats[c.stat] || 0) >= c.meta) { P.conq[c.id] = Date.now(); novas.push(c); if (onConquista) onConquista(c); }
    }
    return novas;
  }
  function pontosGanhos() { var t = 0; for (var i = 0; i < CONQUISTAS.length; i++) if (P.conq[CONQUISTAS[i].id]) t += CONQUISTAS[i].pts; return t; }
  function pontosGastos() { var t = 0; for (var i = 0; i < RECOMPENSAS.length; i++) if (P.resg[RECOMPENSAS[i].id]) t += RECOMPENSAS[i].custo; return t; }
  function pontosDisponiveis() { return pontosGanhos() - pontosGastos(); }
  function tem(id) { return !!(slot && P.resg[id]); }
  function resgatar(id) {
    var r = null; for (var i = 0; i < RECOMPENSAS.length; i++) if (RECOMPENSAS[i].id === id) r = RECOMPENSAS[i];
    if (!r || !slot) return 'sem-slot';
    if (P.resg[id]) return 'ja';
    if (pontosDisponiveis() < r.custo) return 'pontos';
    P.resg[id] = true; return 'ok';
  }

  MV.Meta = {
    N_SLOTS: N_SLOTS, RARIDADES: RARIDADES, HAB: HAB, LIMIARES: LIMIARES, CONQUISTAS: CONQUISTAS, RECOMPENSAS: RECOMPENSAS,
    cadencia: cadencia, recarga: recarga, danoRecebido: danoRecebido, velocidade: velocidade, nivelDeXp: nivelDeXp, progressoXp: progressoXp,
    ler: ler, apagar: apagar, novoSlot: novoSlot, carregarSlot: carregarSlot, salvar: salvar, sair: sair,
    inc: inc, max: max, stat: stat, nivel: nivel, ganharXp: ganharXp, checar: checar,
    pontosGanhos: pontosGanhos, pontosGastos: pontosGastos, pontosDisponiveis: pontosDisponiveis, tem: tem, resgatar: resgatar,
    get slot() { return slot; }, get perfil() { return P; },
    set onConquista(f) { onConquista = f; }, set onNivel(f) { onNivel = f; }
  };
})(window.MV = window.MV || {});
