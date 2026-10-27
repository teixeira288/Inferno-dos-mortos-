/*
 * gamepad.js : GamepadManager (Gamepad API, mapeamento "standard" do Xbox Series via Bluetooth).
 *
 * Lê o controle por polling a cada quadro (navigator.getGamepads()), converte para um estado simples
 * e dispara eventos de "borda" (botão acabou de ser pressionado) para o jogo e para a loja.
 *
 *  v5: MAPEAMENTO CONFIGURÁVEL. O jogo continua recebendo os mesmos nomes lógicos de botão (a b x y lb rb lt rt view menu l3 r3
 *  cima baixo esq dir) e os mesmos eixos, mas cada nome lógico agora aponta para uma ENTRADA FÍSICA ("b3" = botão 3, "a5+" = eixo 5
 *  para o lado positivo). Perfis: PADRÃO (W3C standard) e ALTERNATIVO (controles Xbox Bluetooth que o Chrome/Android expõe com
 *  mapping "" — botões/eixos em outra ordem, gatilhos em eixos, D-pad em hat). AUTO escolhe pelo gamepad.mapping. O jogador pode
 *  sobrescrever qualquer entrada em Opções > Controle (captura "pressione o botão"), salvo em localStorage (mv_padmap).
 *
 *  Mapeamento padrão (W3C Standard Gamepad):
 *   eixos 0/1 = analógico esquerdo (mover)        eixos 2/3 = analógico direito (mirar, twin-stick)
 *   0 A  1 B  2 X  3 Y  4 LB  5 RB  6 LT  7 RT  8 View  9 Menu  10 L3  11 R3  12 ↑  13 ↓  14 ←  15 →
 */
(function (MV) {
  'use strict';

  var G = {
    ativo: false,            /* true quando o último dispositivo usado foi o controle (esconde os controles de toque) */
    conectado: false,
    nome: '',
    deadzone: 0.18,          /* ajustável (0.05 a 0.5) e salva em localStorage */
    deadzoneMira: 0.25,
    mx: 0, my: 0,            /* movimento já com zona morta radial, em [-1,1] */
    miraMag: 0,
    scrollY: 0,              /* analógico direito nos painéis de lista (Legado): -1..1 */
    mira: null,              /* ângulo (rad) do analógico direito, ou null se solto */
    fogo: false,             /* RT ou X seguro */
    correr: false,           /* clique no analógico esquerdo (L3) seguro */
    navStick: false,         /* o jogo liga isto só em menus/loja: no combate o analógico esquerdo só move o soldado */
    onBotao: null,           /* function (nome) chamada na borda de descida */
    onAtivoMudou: null       /* function (ativo) quando alterna controle <-> toque */
  };

  try { var dz = parseFloat(localStorage.getItem('mv_deadzone')); if (dz >= 0.05 && dz <= 0.5) G.deadzone = dz; } catch (e) { }

  /* ---------- perfis de mapeamento ----------
   * Entrada física: "b<i>" botão i · "a<i>+" / "a<i>-" eixo i (lado positivo/negativo; gatilhos em eixo repousam em -1 e são normalizados). */
  var NOMES = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'view', 'menu', 'l3', 'r3', 'cima', 'baixo', 'esq', 'dir'];
  var PERFIL_PADRAO = { a: 'b0', b: 'b1', x: 'b2', y: 'b3', lb: 'b4', rb: 'b5', lt: 'b6', rt: 'b7', view: 'b8', menu: 'b9', l3: 'b10', r3: 'b11', cima: 'b12', baixo: 'b13', esq: 'b14', dir: 'b15',
    eixos: { mx: 0, my: 1, rx: 2, ry: 3 } };
  /* Layout "evdev" (Xbox One/Series via Bluetooth em Android/Linux sem mapping standard): X=b3, Y=b4, LB=b6, RB=b7, View=b10, Menu=b11,
     L3=b13, R3=b14; LT=eixo 2, RT=eixo 5, mira nos eixos 3/4, D-pad no hat (eixos 6/7). */
  var PERFIL_ALT = { a: 'b0', b: 'b1', x: 'b3', y: 'b4', lb: 'b6', rb: 'b7', lt: 'a2+', rt: 'a5+', view: 'b10', menu: 'b11', l3: 'b13', r3: 'b14', cima: 'a7-', baixo: 'a7+', esq: 'a6-', dir: 'a6+',
    eixos: { mx: 0, my: 1, rx: 3, ry: 4 } };
  var DESCR = { a: 'Confirmar · comprar/equipar · Armaria', b: 'Recarregar · voltar · fechar', x: 'Atirar (alternativo) · munição na loja', y: 'Trocar arma · munição na loja',
    lb: 'Lançar granada', rb: 'Recarregar', lt: 'Granada (gatilho esquerdo)', rt: 'Atirar (gatilho direito)', view: 'Abrir/fechar Armaria', menu: 'Pausar / continuar',
    l3: 'Correr (clique no analógico esq.)', r3: '(sem função)', cima: 'Navegar para cima', baixo: 'Navegar para baixo', esq: 'Trocar arma anterior · navegar', dir: 'Próxima arma · navegar' };
  var ROTULO = { a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', view: 'VIEW', menu: 'MENU', l3: 'L3', r3: 'R3', cima: 'D-PAD ↑', baixo: 'D-PAD ↓', esq: 'D-PAD ←', dir: 'D-PAD →' };
  var ROT_EIXO = { mx: 'MOVER · horizontal', my: 'MOVER · vertical', rx: 'MIRAR · horizontal', ry: 'MIRAR · vertical' };

  var cfgMap = { perfil: 'auto', custom: {}, eixos: {} };   /* perfil: auto | padrao | alt */
  try {
    var m = JSON.parse(localStorage.getItem('mv_padmap') || 'null');
    if (m && typeof m === 'object') {
      if (m.perfil === 'auto' || m.perfil === 'padrao' || m.perfil === 'alt') cfgMap.perfil = m.perfil;
      if (m.custom && typeof m.custom === 'object') for (var q in m.custom) if (NOMES.indexOf(q) >= 0 && /^(b\d{1,2}|a\d{1,2}[+-])$/.test(m.custom[q])) cfgMap.custom[q] = m.custom[q];
      if (m.eixos && typeof m.eixos === 'object') for (var e in m.eixos) if (ROT_EIXO[e] && m.eixos[e] >= 0 && m.eixos[e] < 32) cfgMap.eixos[e] = m.eixos[e] | 0;
    }
  } catch (e) { }
  function salvarMapa() { try { localStorage.setItem('mv_padmap', JSON.stringify(cfgMap)); } catch (e) { } }

  var ant = {};              /* estado anterior (botões) para detectar bordas */
  var repete = { cima: 0, baixo: 0, esq: 0, dir: 0 };
  var ultimoPad = null, ultimoT = 0;
  var repouso = {};          /* valor de repouso por eixo ("id|i"): gatilhos em eixo ficam em -1; usado para normalizar */
  var captura = null;        /* { tipo:'botao'|'eixo', cb, base } enquanto o jogador remapeia */

  /* perfil efetivo para o controle conectado */
  function perfilAtivo(p) {
    var nome = cfgMap.perfil === 'auto' ? ((p && p.mapping === 'standard') ? 'padrao' : 'alt') : cfgMap.perfil;
    return nome === 'padrao' ? PERFIL_PADRAO : PERFIL_ALT;
  }
  /* entrada física efetiva de um nome lógico (customizada > perfil) */
  function ligacao(nome, p) { return cfgMap.custom[nome] || perfilAtivo(p)[nome]; }
  function indiceEixo(nome, p) { var v = cfgMap.eixos[nome]; return v != null ? v : perfilAtivo(p).eixos[nome]; }

  function dispara(nome) { if (G.onBotao) { try { G.onBotao(nome); } catch (e) { } } }
  function marcarAtivo(v) {
    if (G.ativo === v) return;
    G.ativo = v;
    document.documentElement.classList.toggle('modo-controle', v);
    if (G.onAtivoMudou) { try { G.onAtivoMudou(v); } catch (e) { } }
  }

  /* zona morta radial com reescala: o analógico começa em 0 logo após a zona morta, sem "salto" */
  function radial(x, y, dz, out) {
    var l = Math.sqrt(x * x + y * y);
    if (l < dz) { out.x = 0; out.y = 0; out.m = 0; return out; }
    var m = Math.min(1, (l - dz) / (1 - dz));
    out.x = x / l * m; out.y = y / l * m; out.m = m;
    return out;
  }
  var tmp = { x: 0, y: 0, m: 0 };

  /* escolhe o controle: prefere os com mapping "standard", senão o primeiro conectado (inclui os de mapping "") */
  function pegarPad() {
    var lista = [];
    try { lista = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { }
    var melhor = null;
    for (var i = 0; i < lista.length; i++) {
      var p = lista[i];
      if (p && p.connected !== false && ((p.buttons && p.buttons.length) || (p.axes && p.axes.length))) { if (!melhor || (p.mapping === 'standard' && melhor.mapping !== 'standard')) melhor = p; }
    }
    return melhor;
  }

  /* valor de um eixo normalizado pelo repouso (gatilho em -1 → 0) */
  function eixoBruto(p, i) { var v = p.axes && p.axes[i]; return typeof v === 'number' && isFinite(v) ? v : 0; }
  function eixoRel(p, i) {
    var k = p.id + '|' + p.index + '|' + i, v = eixoBruto(p, i);
    if (repouso[k] === undefined) repouso[k] = (Math.abs(v + 1) < 0.05) ? -1 : (Math.abs(v) > 1.05 ? v : 0);   /* repouso 0, -1 (gatilho) ou valor fora de faixa (hat ocioso) */
    return v - repouso[k];
  }
  /* lê uma entrada física: devolve 0..1 (analógico para gatilhos) */
  function ler(p, spec) {
    if (!spec) return 0;
    var i = parseInt(spec.slice(1), 10);
    if (spec.charAt(0) === 'b') { var b = p.buttons[i]; return b ? (b.pressed ? Math.max(1, b.value) : b.value) : 0; }
    var d = eixoRel(p, i) * (spec.charAt(spec.length - 1) === '-' ? -1 : 1);
    return d > 0 ? Math.min(1, d) : 0;
  }
  function ativoSpec(p, spec) { var v = ler(p, spec); return spec && spec.charAt(0) === 'b' ? v > 0.5 : v > 0.5; }
  function gatilhoSpec(p, spec) { return ler(p, spec) > (spec && spec.charAt(0) === 'b' ? 0.35 : 0.5); }

  /* captura de remapeamento: detecta a primeira entrada nova */
  function processarCaptura(p) {
    var c = captura; if (!c) return false;
    if (!c.base) { c.base = { b: [], a: [] }; for (var i = 0; i < p.buttons.length; i++) c.base.b[i] = (p.buttons[i].pressed || p.buttons[i].value > 0.5); for (var k = 0; k < (p.axes || []).length; k++) c.base.a[k] = eixoRel(p, k); c.t = 0.35; return true; }
    for (var j = 0; j < p.buttons.length; j++) {
      var on = p.buttons[j].pressed || p.buttons[j].value > 0.5;
      if (c.tipo === 'botao' && on && !c.base.b[j]) return concluir('b' + j);
      c.base.b[j] = on;
    }
    var melhor = -1, mv = 0.6;
    for (var a = 0; a < (p.axes || []).length; a++) {
      var d = eixoRel(p, a) - (c.base.a[a] || 0);
      if (Math.abs(d) > mv) { mv = Math.abs(d); melhor = a; }
    }
    if (melhor >= 0) return concluir(c.tipo === 'botao' ? 'a' + melhor + (eixoRel(p, melhor) - (c.base.a[melhor] || 0) > 0 ? '+' : '-') : melhor);
    return true;
  }
  function concluir(valor) { var cb = captura.cb; captura = null; ant = {}; try { cb(valor); } catch (e) { } return true; }

  /* chamado uma vez por quadro; dt em segundos */
  G.atualizar = function (dt) {
    var p = pegarPad();
    if (!p) { if (G.conectado) { G.conectado = false; G.mx = G.my = 0; G.mira = null; G.fogo = false; G.correr = false; marcarAtivo(false); } return; }
    if (!G.conectado) { G.conectado = true; G.nome = p.id; }
    ultimoPad = p; G.ultimoMapping = p.mapping || '';
    if (captura && processarCaptura(p)) return;            /* durante a captura o jogo não recebe botões */

    var atividade = false;
    var iMX = indiceEixo('mx', p), iMY = indiceEixo('my', p), iRX = indiceEixo('rx', p), iRY = indiceEixo('ry', p);
    var lx = eixoBruto(p, iMX), ly = eixoBruto(p, iMY);
    radial(lx, ly, G.deadzone, tmp);
    G.mx = tmp.x; G.my = tmp.y; if (tmp.m > 0) atividade = true;
    radial(eixoBruto(p, iRX), eixoBruto(p, iRY), G.deadzoneMira, tmp);
    G.mira = tmp.m > 0.25 ? Math.atan2(tmp.y, tmp.x) : null;
    var ryv = eixoBruto(p, iRY); G.scrollY = (G.navStick && Math.abs(ryv) > 0.25) ? ryv : 0;      /* analógico direito rola listas nos menus */
    G.miraMag = tmp.m;       /* intensidade do analógico direito (0..1): o jogo só larga o alvo travado com empurrão firme (≥ 0,6) */
    if (tmp.m > 0) atividade = true;

    var botoes = {}, n;
    for (var u = 0; u < NOMES.length; u++) { n = NOMES[u]; var sp = ligacao(n, p); botoes[n] = (n === 'lt' || n === 'rt') ? gatilhoSpec(p, sp) : ativoSpec(p, sp); }
    var fogo = botoes.rt || botoes.x;
    /* o analógico esquerdo também navega nos menus (com repetição automática) */
    var navX = !G.navStick ? 0 : (lx > 0.6 ? 1 : (lx < -0.6 ? -1 : 0)), navY = !G.navStick ? 0 : (ly > 0.6 ? 1 : (ly < -0.6 ? -1 : 0));
    botoes.cima = botoes.cima || navY < 0; botoes.baixo = botoes.baixo || navY > 0;
    botoes.esq = botoes.esq || navX < 0; botoes.dir = botoes.dir || navX > 0;

    for (var k in botoes) {
      var v = botoes[k];
      if (v) atividade = true;
      if (k === 'cima' || k === 'baixo' || k === 'esq' || k === 'dir') {
        if (v) {                                   /* repetição: 1º disparo imediato, depois a cada 0,22 s após 0,4 s */
          if (!ant[k]) { repete[k] = 0.4; if (atividade) marcarAtivo(true); dispara(k); }
          else { repete[k] -= dt; if (repete[k] <= 0) { repete[k] = 0.22; dispara(k); } }
        }
      } else if (v && !ant[k]) { marcarAtivo(true); dispara(k); }
      ant[k] = v;
    }
    G.fogo = fogo; G.correr = botoes.l3;
    if (atividade) marcarAtivo(true);
  };

  /* vibração: dual-rumble (Chrome/Edge/Android) com reserva para hapticActuators antigos. Respeita o interruptor G.vibracaoOn. */
  G.vibracaoOn = true;
  G.vibrar = function (duracao, fraco, forte) {
    if (!G.vibracaoOn || !G.conectado || !G.ativo || !ultimoPad) return;
    var p = ultimoPad;
    try {
      if (p.vibrationActuator && p.vibrationActuator.playEffect) {
        p.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(duracao * 1000), weakMagnitude: Math.min(1, fraco), strongMagnitude: Math.min(1, forte) });
      } else if (p.hapticActuators && p.hapticActuators[0] && p.hapticActuators[0].pulse) {
        p.hapticActuators[0].pulse(Math.min(1, Math.max(fraco, forte)), Math.round(duracao * 1000));
      }
    } catch (e) { }
  };

  G.definirDeadzone = function (v) {
    G.deadzone = Math.min(0.5, Math.max(0.05, v));
    try { localStorage.setItem('mv_deadzone', String(G.deadzone)); } catch (e) { }
  };

  /* ---------- API de remapeamento (usada pela tela de Opções) ---------- */
  G.NOMES = NOMES; G.DESCR = DESCR; G.ROTULO = ROTULO; G.ROT_EIXO = ROT_EIXO;
  G.perfil = function () { return cfgMap.perfil; };
  G.definirPerfil = function (v) { if (v === 'auto' || v === 'padrao' || v === 'alt') { cfgMap.perfil = v; salvarMapa(); } };
  /* texto legível da entrada física atual de um nome lógico (ex.: "BOTÃO 3", "EIXO 5+") */
  G.textoLigacao = function (nome) {
    var s = ligacao(nome, ultimoPad); if (!s) return '—';
    return (s.charAt(0) === 'b' ? 'BOTÃO ' + s.slice(1) : 'EIXO ' + s.slice(1, -1) + (s.slice(-1) === '+' ? ' (+)' : ' (−)')) + (cfgMap.custom[nome] ? ' ★' : '');
  };
  G.textoEixo = function (nome) { return 'EIXO ' + indiceEixo(nome, ultimoPad) + (cfgMap.eixos[nome] != null ? ' ★' : ''); };
  /* inicia a captura: cb recebe "b3"/"a5+" (botão) ou índice do eixo (tipo 'eixo'). Devolve false se não há controle. */
  G.capturar = function (tipo, cb) { if (!G.conectado) return false; captura = { tipo: tipo, cb: cb, base: null }; return true; };
  G.cancelarCaptura = function () { captura = null; ant = {}; };
  G.capturando = function () { return !!captura; };
  /* se a entrada física já era usada por outro botão lógico, os dois trocam de lugar (nunca ficam duplicados) */
  G.definirLigacao = function (nome, spec) {
    if (NOMES.indexOf(nome) < 0) return;
    if (spec) {
      var velha = ligacao(nome, ultimoPad);
      for (var i = 0; i < NOMES.length; i++) { var o = NOMES[i]; if (o !== nome && ligacao(o, ultimoPad) === spec) cfgMap.custom[o] = velha; }
      cfgMap.custom[nome] = spec;
    } else delete cfgMap.custom[nome];
    salvarMapa();
  };
  G.definirEixo = function (nome, i) { if (!ROT_EIXO[nome]) return; if (i == null) delete cfgMap.eixos[nome]; else cfgMap.eixos[nome] = i | 0; salvarMapa(); };
  G.restaurarPadrao = function () { cfgMap.custom = {}; cfgMap.eixos = {}; cfgMap.perfil = 'auto'; salvarMapa(); ant = {}; };
  /* diagnóstico ao vivo (id, mapping, quantos botões/eixos e quais estão ativos) para descobrir o layout real do controle */
  G.diagnostico = function () {
    var p = ultimoPad && G.conectado ? ultimoPad : pegarPad();
    if (!p) return null;
    var bs = [], ax = [], i;
    for (i = 0; i < p.buttons.length; i++) if (p.buttons[i].pressed || p.buttons[i].value > 0.3) bs.push(i);
    for (i = 0; i < (p.axes || []).length; i++) ax.push(+eixoBruto(p, i).toFixed(2));
    return { id: p.id, mapping: p.mapping || '(nenhum)', nBotoes: p.buttons.length, nEixos: (p.axes || []).length, botoes: bs, eixos: ax, perfil: perfilAtivo(p) === PERFIL_PADRAO ? 'PADRÃO' : 'ALTERNATIVO' };
  };

  /* alterna para a interface de toque assim que alguém toca na tela */
  window.addEventListener('pointerdown', function (e) { if (e.pointerType === 'touch') marcarAtivo(false); }, true);
  window.addEventListener('gamepadconnected', function (e) { G.conectado = true; G.nome = e.gamepad.id; });
  window.addEventListener('gamepaddisconnected', function () { if (!pegarPad()) { G.conectado = false; marcarAtivo(false); G.mx = G.my = 0; G.mira = null; G.fogo = false; } });

  /* para testes: injeta um controle falso (usado nos testes automatizados, não afeta o jogo normal) */
  MV.Gamepad = G;
})(window.MV = window.MV || {});
