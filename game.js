/* game.js : Inferno dos mortos, sobrevivência em ondas.
 * O JavaScript cuida de entrada, renderização, áudio, HUD e regras das rodadas.
 * Física, IA dos zumbis e colisões das balas ficam no módulo WebAssembly (sim.c),
 * com um equivalente em JS (sim-js.js) como reserva.
 */
(function (MV) {
  'use strict';
  var Som = MV.Som;
  var LEG = MV.Legado;      /* conquistas permanentes, PC e árvore de metaprogressão (legado.js) */
  var Gore = MV.Gore;       /* desenho de partes do corpo, cadáveres e sangue (gore.js) */
  var TAU = Math.PI * 2;

  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function angDif(a, b) { var d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
    /* hipotenusa 2D: Math.hypot é bem mais lento que sqrt direto em laços quentes (IA de estações, colisões, luz) */
  function hip(a, b) { return Math.sqrt(a * a + b * b); }
function guardar(k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  function ler(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function fmtNum(n) { return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

  /* =====================  CONFIGURAÇÕES (localStorage)  =====================
   * autoAim: mira automática | luz: 0-100 (raio da lanterna; 100 = cenário completo) | escala: 50-150 (% dos botões touch) */
  var cfg = { autoAim: true, luz: 70, escala: 100, escalaStick: 100, vibrar: true, zoom: 100, skin: 0, shake: 100, noite: true };
  (function () {
    try {
      var o = JSON.parse(localStorage.getItem('mv_cfg') || 'null');
      if (o) {
        if (typeof o.autoAim === 'boolean') cfg.autoAim = o.autoAim;
        if (o.luz >= 0 && o.luz <= 100) cfg.luz = +o.luz;
        if (o.escala >= 50 && o.escala <= 150) cfg.escala = +o.escala;
        cfg.escalaStick = (o.escalaStick >= 50 && o.escalaStick <= 150) ? +o.escalaStick : cfg.escala;
        if (o.skin >= 0 && o.skin <= 4) cfg.skin = o.skin | 0;
        if (o.shake >= 0 && o.shake <= 150) cfg.shake = +o.shake;
        if (typeof o.noite === 'boolean') cfg.noite = o.noite;
        if (typeof o.vibrar === 'boolean') cfg.vibrar = o.vibrar;
        if (o.zoom >= 60 && o.zoom <= 160) cfg.zoom = +o.zoom;
      }
    } catch (e) { }
  })();
  function salvarCfg() { guardar('mv_cfg', JSON.stringify(cfg)); }
  /* ---- vibração do aparelho (Vibration API) ----
   * suportada: Chrome/Android e similares (iOS não expõe a API). O interruptor das Opções também governa a vibração do controle (dual-rumble). */
  var VIBRACAO_OK = !!(navigator.vibrate);
  function vibrarTela(padrao) { if (!cfg.vibrar || !VIBRACAO_OK) return; try { navigator.vibrate(padrao); } catch (e) { } }
  function aplicarVibracao() { MV.Gamepad.vibracaoOn = !!cfg.vibrar; if (!cfg.vibrar && VIBRACAO_OK) { try { navigator.vibrate(0); } catch (e) { } } }
  /* tamanho dos controles touch: botões (--tsb) e analógico (--tsk) ajustáveis separadamente nas Opções */
  function aplicarEscalaTouch() { var r = document.documentElement.style; r.setProperty('--ts', (cfg.escala / 100).toFixed(2)); r.setProperty('--tsb', (cfg.escala / 100).toFixed(2)); r.setProperty('--tsk', (cfg.escalaStick / 100).toFixed(2)); }
  aplicarEscalaTouch();

  /* =====================  OBJECT POOL  =====================
   * Vetor fixo de objetos pré-alocados: add() devolve um objeto reciclado (nenhuma alocação em jogo) e rem(i) troca com o último
   * ativo. Textos flutuantes, explosões, nuvens e suprimentos usam isto, então o coletor de lixo quase nunca roda durante a partida. */
  function Pool(max, make) { this.a = []; this.n = 0; for (var i = 0; i < max; i++) this.a.push(make()); }
  Pool.prototype.add = function () {
    if (this.n >= this.a.length) { var t0 = this.a[0]; this.a.copyWithin(0, 1); this.a[this.n - 1] = t0; return t0; }   /* cheio: recicla o mais antigo */
    return this.a[this.n++];
  };
  Pool.prototype.rem = function (i) { var t = this.a[i]; this.a[i] = this.a[this.n - 1]; this.a[this.n - 1] = t; this.n--; };
  var pTexto = new Pool(32, function () { return { x: 0, y: 0, txt: '', cor: '', tam: 16, vida: 0, max: 1 }; });
  var pFx = new Pool(10, function () { return { x: 0, y: 0, r: 0, t: 0, max: 1, tp: 1 }; });
  var pNuvens = new Pool(8, function () { return { x: 0, y: 0, r: 0, t: 0, max: 1, fase: 0 }; });
  var pDrops = new Pool(10, function () { return { x: 0, y: 0, tipo: 0, t: 0 }; });
  var pFogoZ = new Pool(12, function () { return { x: 0, y: 0, r: 0, t: 0, max: 1 }; });      /* zonas de fogo (molotov/barril) */
  var pRastro = new Pool(90, function () { return { x: 0, y: 0, t: 0, max: 1 }; });           /* rastro tóxico no chão */
  var pMinas = new Pool(8, function () { return { x: 0, y: 0, arm: 0, t: 0 }; });            /* minas plantadas */
  var queima = new Float32Array(256), rastroT = new Float32Array(256);                        /* por zumbi: tempo de chamas / intervalo do rastro */
  var blastQ = new Float32Array(6 * 32), blastN = 0;                                          /* fila de explosões em área (balas explosivas) */

  /* =====================  MUNDO  ===================== */
  var MUNDO = { w: 2400, h: 1800, p: 40 };
  var BARRIS = [];   /* barris de gasolina: { x, y, hp, vivo, estoura, flash } (4 a 10 por partida) */
  var PROPS = [];    /* adereços decorativos sem colisão (pneus, poças, entulho, cones...) */
  var OBST = [];   /* preenchido por gerarCenario() a cada partida (mesmo mapa 2400×1800) */
  /* janelas barricadas por onde os zumbis entram */
  var JANELAS = [
    { x: 500, y: 40, lado: 'c' }, { x: 1200, y: 40, lado: 'c' }, { x: 1900, y: 40, lado: 'c' },
    { x: 600, y: 1760, lado: 'b' }, { x: 1200, y: 1760, lado: 'b' }, { x: 1800, y: 1760, lado: 'b' },
    { x: 40, y: 450, lado: 'e' }, { x: 40, y: 1300, lado: 'e' },
    { x: 2360, y: 450, lado: 'd' }, { x: 2360, y: 1300, lado: 'd' }
  ];
  var ESTACOES = [
    { id: 'municao', x: 2060, y: 900, r: 48, custo: 500, nome: 'REABASTECIMENTO', cor: '#e8b630', cd: 0 },
    { id: 'medico', x: 340, y: 900, r: 48, custo: 600, nome: 'POSTO MÉDICO', cor: '#a3d05c', cd: 0 },
    { id: 'armaria', x: 1250, y: 1480, r: 52, custo: 0, nome: 'ARMARIA', cor: '#a6ff00', cd: 0 }
  ];
  var INICIO = { x: 1200, y: 900 };

  /* =====================  CENÁRIO PROCEDURAL  =====================
   * Sorteia os obstáculos de cada partida dentro da MESMA área jogável. Regras de validação (com novas tentativas):
   *  - nunca perto do spawn do jogador, das estações (munição/médico/armaria) nem na "boca" das janelas dos zumbis;
   *  - distância mínima entre obstáculos (corredores jogáveis) e margem das paredes;
   *  - conectividade: por flood-fill em grade, o jogador alcança todas as estações e todas as janelas.
   * Determinístico para uma semente (útil para testes): gerarCenario(seed). */
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var TIPOS_OBST = [
    { t: 'concreto', formas: [[180, 60], [60, 220], [220, 60], [60, 160]], peso: 3 },
    { t: 'container', formas: [[240, 80], [80, 240], [180, 70], [70, 180]], peso: 2 },
    { t: 'caixote', formas: [[160, 160], [120, 120], [100, 100], [70, 70], [140, 140]], peso: 3 },
    { t: 'carro', formas: [[220, 96], [96, 220], [200, 90]], peso: 2 },           /* carcaça de veículo */
    { t: 'sacos', formas: [[190, 52], [52, 190], [130, 52]], peso: 2 }            /* barricada de sacos de areia */
  ];
  function sortearTipoObst(rnd) { var tot = 0, i; for (i = 0; i < TIPOS_OBST.length; i++) tot += TIPOS_OBST[i].peso; var r = rnd() * tot; for (i = 0; i < TIPOS_OBST.length; i++) { if (r < TIPOS_OBST[i].peso) return TIPOS_OBST[i]; r -= TIPOS_OBST[i].peso; } return TIPOS_OBST[0]; }
  /* retângulo r (com folga m) toca a área proibida (centro cx,cy, raio rad)? */
  function tocaCirculo(r, m, cx, cy, rad) {
    var px = Math.max(r.x - m, Math.min(cx, r.x + r.w + m)), py = Math.max(r.y - m, Math.min(cy, r.y + r.h + m));
    return (px - cx) * (px - cx) + (py - cy) * (py - cy) < rad * rad;
  }
  /* o jogador (raio ~14, folga 22) consegue ir do spawn a todas as estações e janelas? flood-fill em grade de 30 px */
  function cenarioConectado(lista) {
    var G = 30, cols = Math.ceil(MUNDO.w / G), lin = Math.ceil(MUNDO.h / G), liv = new Uint8Array(cols * lin), x, y, i, o;
    for (y = 0; y < lin; y++) for (x = 0; x < cols; x++) {
      var wx = x * G + G / 2, wy = y * G + G / 2, ok = wx > MUNDO.p + 14 && wx < MUNDO.w - MUNDO.p - 14 && wy > MUNDO.p + 14 && wy < MUNDO.h - MUNDO.p - 14;
      for (i = 0; ok && i < lista.length; i++) { o = lista[i]; if (wx > o.x - 24 && wx < o.x + o.w + 24 && wy > o.y - 24 && wy < o.y + o.h + 24) ok = false; }
      liv[y * cols + x] = ok ? 1 : 0;
    }
    var vis = new Uint8Array(cols * lin), pilha = [(INICIO.y / G | 0) * cols + (INICIO.x / G | 0)];
    vis[pilha[0]] = 1;
    while (pilha.length) {
      var c = pilha.pop(), cx = c % cols, cy = (c / cols) | 0;
      var viz = [cx > 0 ? c - 1 : -1, cx < cols - 1 ? c + 1 : -1, cy > 0 ? c - cols : -1, cy < lin - 1 ? c + cols : -1];
      for (var k = 0; k < 4; k++) { var n = viz[k]; if (n >= 0 && liv[n] && !vis[n]) { vis[n] = 1; pilha.push(n); } }
    }
    /* alvo: célula livre mais próxima (raio de 3 células) do ponto precisa estar visitada */
    function alcanca(px, py) {
      var gx = px / G | 0, gy = py / G | 0;
      for (var dy = -3; dy <= 3; dy++) for (var dx = -3; dx <= 3; dx++) { var a = gx + dx, b = gy + dy; if (a >= 0 && b >= 0 && a < cols && b < lin && vis[b * cols + a]) return true; }
      return false;
    }
    for (i = 0; i < ESTACOES.length; i++) if (!alcanca(ESTACOES[i].x, ESTACOES[i].y)) return false;
    for (i = 0; i < JANELAS.length; i++) {
      var j = JANELAS[i], ix = j.lado === 'e' ? 110 : (j.lado === 'd' ? -110 : 0), iy = j.lado === 'c' ? 110 : (j.lado === 'b' ? -110 : 0);
      if (!alcanca(j.x + ix, j.y + iy)) return false;
    }
    return true;
  }
  /* BARRIS DE GASOLINA: 4 a 10 por partida, às vezes em grupos (reação em cadeia). Cada barril ocupa 32×32 como obstáculo e o conjunto
   * é validado pelo mesmo teste de conectividade; se reprovar, sorteia de novo. Devolve a lista de barris. */
  function gerarBarris(rnd, lista) {
    var alvo = 4 + ((rnd() * 7) | 0), tent, i, bs;
    for (tent = 0; tent < 25; tent++) {
      bs = []; var falhas = 0;
      while (bs.length < alvo && falhas < 200) {
        var x, y;
        if (bs.length && rnd() < 0.3) { var pb = bs[bs.length - 1], an = rnd() * TAU; x = pb.x + Math.cos(an) * (46 + rnd() * 30); y = pb.y + Math.sin(an) * (46 + rnd() * 30); }
        else { x = MUNDO.p + 150 + rnd() * (MUNDO.w - 2 * MUNDO.p - 300); y = MUNDO.p + 150 + rnd() * (MUNDO.h - 2 * MUNDO.p - 300); }
        x = Math.round(x); y = Math.round(y);
        var r = { x: x - 16, y: y - 16, w: 32, h: 32 };
        var ok = x > MUNDO.p + 120 && x < MUNDO.w - MUNDO.p - 120 && y > MUNDO.p + 120 && y < MUNDO.h - MUNDO.p - 120 && !tocaCirculo(r, 0, INICIO.x, INICIO.y, 150);
        for (i = 0; ok && i < ESTACOES.length; i++) ok = !tocaCirculo(r, 0, ESTACOES[i].x, ESTACOES[i].y, 130);
        for (i = 0; ok && i < JANELAS.length; i++) ok = !tocaCirculo(r, 0, JANELAS[i].x + (JANELAS[i].lado === 'e' ? 120 : JANELAS[i].lado === 'd' ? -120 : 0), JANELAS[i].y + (JANELAS[i].lado === 'c' ? 120 : JANELAS[i].lado === 'b' ? -120 : 0), 120);
        for (i = 0; ok && i < lista.length; i++) { var o = lista[i]; ok = r.x > o.x + o.w + 44 || r.x + r.w + 44 < o.x || r.y > o.y + o.h + 44 || r.y + r.h + 44 < o.y; }
        for (i = 0; ok && i < bs.length; i++) ok = hip(bs[i].x - x, bs[i].y - y) > 44;
        if (ok) bs.push({ x: x, y: y, hp: 40, vivo: true, estoura: -1, flash: 0 }); else falhas++;
      }
      if (bs.length < 4) continue;
      var caixas = lista.slice();
      for (i = 0; i < bs.length; i++) caixas.push({ x: bs[i].x - 16, y: bs[i].y - 16, w: 32, h: 32 });
      if (cenarioConectado(caixas)) return bs;
    }
    return [];
  }
  /* ADEREÇOS PROCEDURAIS: decoração sem colisão (pneus, poças de óleo, entulho, cones, placas caídas, sacos de lixo, ossadas) */
  var TIPOS_PROP = ['pneus', 'poca', 'entulho', 'cones', 'placa', 'lixo', 'ossos'];
  function gerarProps(rnd, lista, barris) {
    var n = 18 + ((rnd() * 9) | 0), out = [], tent, i;
    for (tent = 0; tent < n * 8 && out.length < n; tent++) {
      var x = Math.round(MUNDO.p + 50 + rnd() * (MUNDO.w - 2 * MUNDO.p - 100)), y = Math.round(MUNDO.p + 50 + rnd() * (MUNDO.h - 2 * MUNDO.p - 100));
      var ok = hip(x - INICIO.x, y - INICIO.y) > 80;
      for (i = 0; ok && i < lista.length; i++) { var o = lista[i]; ok = !(x > o.x - 16 && x < o.x + o.w + 16 && y > o.y - 16 && y < o.y + o.h + 16); }
      for (i = 0; ok && i < ESTACOES.length; i++) ok = hip(x - ESTACOES[i].x, y - ESTACOES[i].y) > 90;
      for (i = 0; ok && i < barris.length; i++) ok = hip(x - barris[i].x, y - barris[i].y) > 40;
      if (ok) out.push({ t: TIPOS_PROP[(rnd() * TIPOS_PROP.length) | 0], x: x, y: y, a: rnd() * TAU, s: 0.8 + rnd() * 0.5, v: (rnd() * 1e6) | 0 });
    }
    return out;
  }
  /* gera e grava em OBST; devolve o número de tentativas usadas */
  function gerarCenario(semente) {
    var rnd = mulberry32(semente == null ? ((Date.now() ^ (Math.random() * 4294967296)) >>> 0) : semente), tent, lista, i;
    for (tent = 1; tent <= 40; tent++) {
      lista = [];
      var alvo = 9 + ((rnd() * 6) | 0), falhas = 0;
      while (lista.length < alvo && falhas < 200) {
        var tp = sortearTipoObst(rnd), f = tp.formas[(rnd() * tp.formas.length) | 0];
        var r = { x: Math.round(MUNDO.p + 110 + rnd() * (MUNDO.w - 2 * MUNDO.p - 220 - f[0])), y: Math.round(MUNDO.p + 110 + rnd() * (MUNDO.h - 2 * MUNDO.p - 220 - f[1])), w: f[0], h: f[1], t: tp.t };
        var ok = !tocaCirculo(r, 0, INICIO.x, INICIO.y, 170);
        for (i = 0; ok && i < ESTACOES.length; i++) ok = !tocaCirculo(r, 0, ESTACOES[i].x, ESTACOES[i].y, 140);
        for (i = 0; ok && i < JANELAS.length; i++) ok = !tocaCirculo(r, 0, JANELAS[i].x + (JANELAS[i].lado === 'e' ? 120 : JANELAS[i].lado === 'd' ? -120 : 0), JANELAS[i].y + (JANELAS[i].lado === 'c' ? 120 : JANELAS[i].lado === 'b' ? -120 : 0), 130);
        for (i = 0; ok && i < lista.length; i++) { var o = lista[i]; ok = r.x > o.x + o.w + 90 || r.x + r.w + 90 < o.x || r.y > o.y + o.h + 90 || r.y + r.h + 90 < o.y; }
        if (ok) lista.push(r); else falhas++;
      }
      if (lista.length >= 8 && cenarioConectado(lista)) break;
    }
    if (tent > 40) lista = [{ x: 700, y: 500, w: 200, h: 60, t: 'concreto' }, { x: 1500, y: 400, w: 60, h: 240, t: 'concreto' }, { x: 1100, y: 1150, w: 240, h: 80, t: 'container' }, { x: 400, y: 1100, w: 60, h: 260, t: 'concreto' }, { x: 900, y: 1350, w: 160, h: 160, t: 'caixote' }, { x: 1700, y: 700, w: 120, h: 120, t: 'caixote' }];  /* reserva (layout clássico) */
    OBST.length = 0; for (i = 0; i < lista.length; i++) OBST.push(lista[i]);
    BARRIS = gerarBarris(rnd, lista);
    PROPS = gerarProps(rnd, lista, BARRIS);
    return tent;
  }

  /* =====================  ARMAS E LOJA  =====================
   * Cada arma é só dados: a lógica de disparo escolhe o comportamento pelos campos
   *   pellets / cone ... escopeta: quantos balins e a abertura do cone (rad)
   *   proj ............. 1 = lança-leitões (projétil pesado com explosão em área)
   *   raio ............. raio da explosão (leitão)
   *   knock ............ empurrão em unidades de mundo por acerto (o tanque quase não se move)
   *   preco / precoMun . preço da arma e da reposição de munição (já escalados pela dificuldade em precoArma/precoMun)
   *   barra / exib ..... barras (0 a 1) e textos mostrados na loja
   *   shake / vib ...... tremor de câmera por tiro e vibração do controle [duração s, leve, forte]
   */
  var ARMAS = [
    { id: 'm1911', nome: 'M1911', tipo: 'PISTOLA', dano: 26, cad: 5.5, pente: 12, resMax: 96, resIni: 60, recarga: 1.25, esp: 0.025, vel: 1700, alc: 650, perf: 0, comp: 27, recuo: 2.4, tremor: 1.1, knock: 2.5,
      preco: 0, precoMun: 100, barra: [0.20, 0.40, 0.55, 0.15], exib: { dano: '26', cad: '5,5 /s', alc: '650', pente: '12' }, vib: [0.05, 0.2, 0.1],
      desc: 'Pistola padrão do soldado. Confiável, precisa e econômica.' },
    { id: 'mp5', nome: 'MP5', tipo: 'SUBMETRALHADORA', dano: 22, cad: 12.5, pente: 30, resMax: 300, resIni: 150, recarga: 1.7, esp: 0.07, vel: 1700, alc: 570, perf: 0, comp: 32, recuo: 1.8, tremor: 1.0, knock: 3,
      preco: 1200, precoMun: 250, barra: [0.17, 0.92, 0.50, 0.30], exib: { dano: '22', cad: '12,5 /s', alc: '570', pente: '30' }, vib: [0.05, 0.25, 0.1],
      desc: 'Cadência altíssima. Ideal para limpar corredores e hordas de perto.' },
    { id: 'm16', nome: 'M16', tipo: 'RIFLE DE ASSALTO', dano: 54, cad: 9, pente: 30, resMax: 240, resIni: 150, recarga: 2.0, esp: 0.03, vel: 1900, alc: 900, perf: 1, comp: 40, recuo: 3.2, tremor: 1.7, knock: 5,
      preco: 2800, precoMun: 400, barra: [0.42, 0.65, 0.90, 0.30], exib: { dano: '54 · perfura', cad: '9 /s', alc: '900', pente: '30' }, vib: [0.07, 0.3, 0.2],
      desc: 'Rifle de assalto. Perfura o primeiro alvo e alcança longe.' },
    { id: 'escopeta', nome: 'ESCOPETA 12', tipo: 'ESPINGARDA CAL. 12', dano: 18, pellets: 8, cone: 0.2, cad: 1.15, pente: 6, resMax: 48, resIni: 18, recarga: 2.3, esp: 0, vel: 1500, alc: 340, perf: 0, comp: 44, recuo: 6.5, tremor: 3.4, shake: 4.6, knock: 20,
      preco: 1800, precoMun: 300, barra: [0.62, 0.20, 0.30, 0.12], exib: { dano: '18 × 8 balins', cad: '1,1 /s', alc: '340', pente: '6' }, vib: [0.12, 0.4, 0.9],
      desc: 'Cone de 8 balins e coice brutal: empurra a horda para trás. Curto e médio alcance.' },
    { id: 'leitao', nome: 'LANÇA-PORCOS', tipo: 'LEITÕES EXPLOSIVOS', dano: 300, raio: 150, proj: 1, cad: 0.8, pente: 1, resMax: 8, resIni: 3, recarga: 2.4, esp: 0.02, vel: 880, alc: 1100, perf: 0, comp: 46, recuo: 9, tremor: 4, shake: 6, knock: 0,
      preco: 5000, precoMun: 800, barra: [1, 0.15, 0.95, 0.05], exib: { dano: '300 · área 150', cad: '0,8 /s', alc: '1100', pente: '1' }, vib: [0.25, 0.5, 1.0],
      desc: 'Dispara leitões explosivos que guincham até o impacto. Explosão em área devastadora.' },
    { id: 'minigun', nome: 'MINI GUN', tipo: 'ARMA EXCLUSIVA · RECOMPENSA', exclusiva: true, semRecarga: true, dano: 19, cad: 22, pente: 2000, resMax: 0, resIni: 0, recarga: 0, esp: 0.085, vel: 1800, alc: 640, perf: 0, comp: 40, recuo: 1.3, tremor: 1.1, knock: 3,
      preco: 0, precoMun: 1000, barra: [0.2, 1, 0.55, 1], exib: { dano: '19', cad: '22 /s', alc: '640', pente: '2000 (único)' }, vib: [0.06, 0.3, 0.2],
      desc: 'Exclusiva: resgate em RECOMPENSAS. Um único pente gigante de 2000 tiros: não recarrega em combate. Esgotou? Compre um pente cheio na Armaria.' },
    { id: 'uzi', nome: 'MINI UZI', tipo: 'SUBMETRALHADORA COMPACTA', dano: 20, cad: 14.5, pente: 32, resMax: 320, resIni: 128, recarga: 1.5, esp: 0.075, vel: 1700, alc: 500, perf: 0, comp: 24, recuo: 1.5, tremor: 0.9, knock: 2.5,
      preco: 1600, precoMun: 220, barra: [0.16, 1, 0.45, 0.32], exib: { dano: '20', cad: '14,5 /s', alc: '500', pente: '32' }, vib: [0.04, 0.2, 0.1],
      desc: 'Compacta e veloz. Compre uma segunda e passe a atirar com duas ao mesmo tempo.' }
  ];
  var IDX_PISTOLA = 0, IDX_MINI = 5, IDX_UZI = 6;
  /* ARMAS DUPLAS (akimbo): a 2ª unidade é comprada na Armaria. Dano/espalhamento por tiro não mudam; dobra o pente e a reserva,
   * a cadência sobe (tiros alternados nas duas mãos) e a recarga demora proporcionalmente mais (duas armas recarregadas). */
  ARMAS[IDX_PISTOLA].dual = { preco: 900, cad: 1.7, pente: 2, res: 2, recarga: 1.5, nome: 'M1911 ×2', tipo: 'PISTOLAS DUPLAS (AKIMBO)', exib: { dano: '26', cad: '9,4 /s', alc: '650', pente: '24' } };
  ARMAS[IDX_UZI].dual = { preco: 2200, cad: 1.6, pente: 2, res: 2, recarga: 1.4, nome: 'UZI ×2', tipo: 'SUBMETRALHADORAS DUPLAS', exib: { dano: '20', cad: '23 /s', alc: '500', pente: '64' } };
  ARMAS.forEach(function (a) { a.base = { nome: a.nome, tipo: a.tipo, cad: a.cad, pente: a.pente, resMax: a.resMax, recarga: a.recarga, exib: a.exib }; });
  /* liga/desliga o modo duplo de uma arma, ajustando os números efetivos que o resto do jogo já lê (cad, pente, resMax, recarga) */
  /* capacidade do pente = pente da arma × (Maníaco por Munição da árvore) × (perk Pente Estendido, +25% por nível) */
  function penteMax(i) { return Math.round(ARMAS[i].pente * ((J && J.magMult) || 1)); }
  function limResMax(a) { return Math.round(a.resMax * dif.resMax * (MV.Meta.tem('r04') ? 1.3 : 1) * (demo ? 1 : LEG.capMun())); }
  function aplicarDual(i, on) {
    var a = ARMAS[i], b = a.base, d = a.dual;
    if (!d) return;
    a.nome = on ? d.nome : b.nome; a.tipo = on ? d.tipo : b.tipo; a.exib = on ? d.exib : b.exib;
    a.cad = b.cad * (on ? d.cad : 1); a.pente = b.pente * (on ? d.pente : 1); a.resMax = b.resMax * (on ? d.res : 1); a.recarga = b.recarga * (on ? d.recarga : 1);
    if (LIM && LIM[i]) LIM[i].resMax = limResMax(a);
    if (S) { S.dual[i] = !!on; }
  }
  var GRANADA = { nome: 'GRANADA DE FRAGMENTAÇÃO', tipo: 'EXPLOSIVO ARREMESSÁVEL', max: 6, preco: 400, dano: 210, raio: 135, pavio: 1.8, cd: 0.7, vz: 480,
    barra: [0.70, 0.12, 0.45, 0.30], exib: { dano: '210 · área 135', cad: '1 a cada 0,7 s', alc: '≈ 380 + quique', pente: 'até 6' },
    desc: 'Arremesso em arco. Explode por tempo ou impacto e solta 24 estilhaços em 360°.' };
  /* Molotov: arco curto, cria zona de fogo (dano em área + incendeia 3 s). Mina: plantada, arma em 1 s, detona por proximidade de INIMIGOS. */
  var MOLOTOV = { nome: 'COQUETEL MOLOTOV', tipo: 'INCENDIÁRIO ARREMESSÁVEL', max: 6, preco: 260, cd: 0.8, raio: 100, voo: 0.85, dur: 6, dps: 20,
    barra: [0.45, 0.2, 0.4, 0.3], exib: { dano: '20/s · fogo 3 s', cad: '1 a cada 0,8 s', alc: '≈ 380', pente: 'até 6' },
    desc: 'Garrafa incendiária: cria uma zona de fogo por 6 s e incendeia quem passa. Zumbis em chamas contaminam quem tocar neles.' };
  var MINA = { nome: 'MINA DE APROXIMAÇÃO', tipo: 'EXPLOSIVO PLANTÁVEL', max: 6, preco: 380, armar: 1.0, gatilho: 36, raio: 175, dano: 520,
    barra: [1, 0.1, 0.45, 0.3], exib: { dano: '520 · área 175', cad: 'arma em 1 s', alc: 'proximidade', pente: 'até 6' },
    desc: 'Plante e afaste-se: só inimigos a acionam. Detona por proximidade com dano massivo em área.' };
  var FOGO_DPS = 14;      /* dano por segundo de um inimigo em chamas */
  var TROCA_TEMPO = 0.3;
  var MIRA_INTENCAO_PX = 60;      /* arrastar além disto (px) = intenção clara de mirar à mão; abaixo é ruído e não solta o alvo travado */
  var PONTOS_ACERTO = 10;

  /* =====================  NÍVEIS DE DIFICULDADE  =====================
   * Cada campo é um multiplicador (ou valor absoluto) aplicado em tempo de execução:
   *  hp / dano / vel ........ atributos de todos os infectados
   *  qtd .................... quantidade de infectados por rodada
   *  esp .................... frequência dos infectados especiais
   *  munIni / resMax ........ munição inicial e capacidade máxima de reserva
   *  drop ................... chance de um suprimento cair de um infectado abatido
   *  bonus .................. pentes de reforço ao fim de cada rodada
   *  custoMun / custoMed .... preço dos postos de reabastecimento e médico
   *  regenAtraso / regen .... segundos sem dano até regenerar, e vida por segundo
   *  intervalo / vivos ...... ritmo de entrada e limite de infectados simultâneos
   */
  var DIFS = {
    facil: { id: 'facil', ia: 0, nome: 'FÁCIL', patente: 'RECRUTA', raro: 0, hp: 0.75, dano: 0.6, vel: 0.88, qtd: 0.85, esp: 0.6, munIni: 1.5, resMax: 1.4, drop: 0.08, bonus: 2, escalaPreco: 0.03, custoMun: 350, custoMed: 400, regenAtraso: 3.5, regen: 28, intervalo: 1.25, vivos: 0.8, tanque: { de: 6, cada: 4 } },
    normal: { id: 'normal', ia: 1, nome: 'NORMAL', patente: 'SOLDADO', raro: 0.15, hp: 1, dano: 1, vel: 1, qtd: 1, esp: 1, munIni: 1, resMax: 1, drop: 0.035, bonus: 1, escalaPreco: 0.06, custoMun: 500, custoMed: 600, regenAtraso: 5, regen: 20, intervalo: 1, vivos: 1, tanque: { de: 5, cada: 3 } },
    dificil: { id: 'dificil', ia: 2, nome: 'DIFÍCIL', patente: 'VETERANO', raro: 0.35, hp: 1.35, dano: 1.4, vel: 1.12, qtd: 1.2, esp: 1.5, munIni: 0.55, resMax: 0.7, drop: 0.015, bonus: 0, escalaPreco: 0.11, custoMun: 750, custoMed: 850, regenAtraso: 8, regen: 12, intervalo: 0.8, vivos: 1.2, tanque: { de: 4, cada: 2 } },
    /* MODO INSANO: zumbis ~2× mais resistentes e IA preditiva (ia 3); especiais garantidos em toda rodada; energia gasta 3,7× e só volta comprando na Armaria;
       lanterna a 40%; preços sobem 18% por rodada (inflacao); comuns esquivam/curam (feito na simulação). */
    insano: { id: 'insano', ia: 3, insano: true, nome: 'INSANO', patente: 'LENDA', raro: 0.6, hp: 1.9, dano: 1.6, vel: 1.15, qtd: 1.3, esp: 2.4, munIni: 0.5, resMax: 0.65, drop: 0.01, bonus: 0, escalaPreco: 0.18, custoMun: 900, custoMed: 1000, regenAtraso: 10, regen: 8, intervalo: 0.7, vivos: 1.3, tanque: { de: 3, cada: 2 },
      luz: 0.4, stamDreno: 3.7, stamRegen: false, inflacao: 0.18, especiais: true }
  };
  var dif = DIFS.normal;
  (function () { var d = null; try { d = localStorage.getItem('mv_dif'); } catch (e) { } if (d && DIFS[d]) dif = DIFS[d]; })();

  /* infectados: 0 comum, 1 veloz, 2 bruto, 3 corredor (bote), 4 tanque (blindado), 5 tóxico (explode) */
  var TIPOS = [
    { nome: 'INFECTADO', pts: 60, raio: 14 }, { nome: 'VELOZ', pts: 80, raio: 12.5 }, { nome: 'BRUTO', pts: 130, raio: 21 },
    { nome: 'CORREDOR', pts: 150, raio: 13 }, { nome: 'TANQUE', pts: 600, raio: 28 }, { nome: 'TÓXICO', pts: 100, raio: 20 }, { nome: 'BOMBER', pts: 90, raio: 14 }
  ];
  /* arquétipos: Walker = 0 (comum) · Runner = 3 (corredor) · Brute = 2 (bruto, golpe em área) · Bomber = 6 (pavio de 1,5 s) */
  var COR_TIPO = ['#ff4a4a', '#ff4a4a', '#ff4a4a', '#ffd23a', '#ff7a2a', '#b6e04a', '#ff4d2a'];
  var XP_TIPO = [10, 12, 26, 18, 120, 22, 18];           /* XP da partida por abate (sobe o nível dos perks) */
  var BOOM_R = 125;

  /* =====================  ESTADO  ===================== */
  var estado = 'carregando';      /* carregando | menu | jogando | pausa | fim */
  var demo = true;                /* fundo do menu: o soldado atira sozinho e não leva dano */
  var S, J, armaEst, IN, LIM;
  var sim = null, V = null, simTipo = '', simNota = '';
  var perf = { sim: 0, quadro: 16, simN: 0, simAcc: 0 };
  var sprites = null, chao = null;
  var cv, ctx, app, view = { w: 800, h: 600, dpr: 1, pxr: 1, zoom: 1, escala: 1 };
  var decalCv, decalCtx, vinheta, vinhetaDano, vinhetaGas;
  var cam = { x: INICIO.x, y: INICIO.y };
  var tremor = { amp: 0, x: 0, y: 0 };
  var P = null;                   /* partículas */
  var MAXP = 700;
  var lastT = 0;
  var avisoHud = {};

  function novoEstado() {
    S = {
      t: 0, tempo: 0, rodada: 0, pontos: 0, abates: 0,
      aSpawnar: 0, tSpawn: 0, fase: 'espera', tFase: 0,
      drops: pDrops, efeitos: { insta: 0, dobro: 0, boom: 0, fogo: 0 }, tickFogo: 0, boomCd: 0, noRastro: false, fogoZ: pFogoZ, rastro: pRastro, minas: pMinas, escudoFx: 0, molCd: 0, minaCd: 0,
      dano: 0, brilhoTiro: 0, estTempo: 0, dica: 0, batida: 0, grunhido: 2,
      nuvens: pNuvens, gas: 0, gatilhos: [], inicial: 1, anuncio: 0, vistos: {},
      possui: ARMAS.map(function (a, i) { return demo ? i < 4 : i === 0; }), fx: pFx, lojaAberta: false, naArmaria: false, lojaFoco: 0, lojaMsg: '',
      /* roguelite da partida */
      perk: { gelo: 0, rico: 0, aura: 0, pente: 0 }, xp: 0, nivel: 1, perkPend: 0, perkAberto: false, perkOpcoes: [], tAura: 0,
      /* conquistas de partida */
      tiros: 0, acertos: 0, armasKill: {}, nArmasKill: 0,
      /* mira automática: trava de alvo com histerese (id do zumbi, tempo travado, tempo fora de alcance/visada, idade p/ detectar slot reaproveitado) */
      aimLock: { id: -1, t: 0, fora: 0, idade: 0 }
    };
    J = {
      x: INICIO.x, y: INICIO.y, ang: 0, vida: 100, vidaMax: 100, semDano: 0, arma: 0,
      recuo: 0, trocaT: 0, fireCd: 0, recarga: 0, recargaTotal: 0, movendo: false, passo: 0, empX: 0, empY: 0, empT: 0,
      granadas: demo ? 0 : Math.max(1, Math.round(2 * dif.munIni)), granCd: 0,
      molotovs: demo ? 0 : Math.max(1, Math.round(1 * dif.munIni)), minas: demo ? 0 : Math.max(1, Math.round(1 * dif.munIni)),
      escudo: 0, escudoT: 0, fogoT: 0, fogoAcc: 0,
      stam: 100, stamT: 0, exausto: false, correndo: false, magMult: 1, trocaTot: TROCA_TEMPO
    };
    if (!demo) { J.vidaMax = Math.round(100 * LEG.hpMult()); J.vida = J.vidaMax; J.magMult = LEG.capMun(); }
    pDrops.n = 0; pFx.n = 0; pNuvens.n = 0; pTexto.n = 0; pFogoZ.n = 0; pRastro.n = 0; pMinas.n = 0;
    queima.fill(0); rastroT.fill(0); blastN = 0;      /* limpa referências do jogo anterior (sem vazamento) */
    S.dual = [];
    ARMAS.forEach(function (a, i) { if (a.dual) aplicarDual(i, false); });
    LIM = ARMAS.map(function (a) { return { resMax: limResMax(a), resIni: Math.round(a.resIni * dif.munIni * (demo ? 1 : LEG.capMun())) }; });
    armaEst = ARMAS.map(function (a, i) { return { mag: S.possui[i] ? penteMax(i) : 0, res: S.possui[i] ? Math.min(LIM[i].resIni, LIM[i].resMax) : 0 }; });
    goreLimpar();
    atualizarCustosEstacoes();
    IN = IN || { mx: 0, my: 0, correr: false, teclas: {}, atirar: false, miraBotao: null, mouse: null, mouseAtivo: false };
    IN.atirar = false; IN.miraBotao = null; IN.mx = 0; IN.my = 0;
  }

  /* =====================  MOTOR (WASM com reserva em JS)  ===================== */
  function b64ParaBytes(b64) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function carregarMotor() {
    return new Promise(function (resolve) {
      function usarJS(nota) {
        var s = window.createSimJS();
        sim = s; V = s.views(); simTipo = 'js'; simNota = nota || '';
        resolve();
      }
      if (!window.WebAssembly || !window.SIM_WASM_B64) { usarJS('WebAssembly indisponível'); return; }
      try {
        WebAssembly.instantiate(b64ParaBytes(window.SIM_WASM_B64), {}).then(function (r) {
          var ex = r.instance.exports;
          var mem = ex.memory;
          var MAXZ = ex.layout(0), ZS = ex.layout(1), MAXB = ex.layout(2), BS = ex.layout(3), MAXE = ex.layout(4), ES = ex.layout(5), MAXG = ex.layout(6), GS = ex.layout(7);
          var zp = ex.zPtr(), bp = ex.bPtr(), ep = ex.ePtr(), gp = ex.gPtr();
          var vistas = {
            Z: new Float64Array(mem.buffer, zp, MAXZ * ZS),
            B: new Float64Array(mem.buffer, bp, MAXB * BS),
            E: new Float64Array(mem.buffer, ep, MAXE * ES),
            G: new Float64Array(mem.buffer, gp, MAXG * GS)
          };
          var api = Object.assign({}, ex);   /* o objeto de exports é congelado; copiamos para anexar views() */
          api.views = function () {
            if (vistas.Z.buffer !== mem.buffer) {   /* a memória cresceu: recria as vistas */
              vistas.Z = new Float64Array(mem.buffer, zp, MAXZ * ZS);
              vistas.B = new Float64Array(mem.buffer, bp, MAXB * BS);
              vistas.E = new Float64Array(mem.buffer, ep, MAXE * ES);
              vistas.G = new Float64Array(mem.buffer, gp, MAXG * GS);
            }
            return vistas;
          };
          sim = api; V = api.views(); simTipo = 'wasm';
          resolve();
        }).catch(function (e) { usarJS('falha ao iniciar o WASM'); });
      } catch (e) { usarJS('falha ao iniciar o WASM'); }
    });
  }
  var ZS = 30, BS = 12, ES = 9, MAXZ = 160, MAXB = 160, MAXG = 32, GS = 14;   /* confirmados contra sim.layout() ao carregar */

  function prepararMundo() {
    gerarCenario();                                   /* obstáculos novos a cada partida (e a cada demo do menu) */
    sim.reset((Date.now() & 0xffffff) + 1);
    sim.setBounds(MUNDO.p, MUNDO.p, MUNDO.w - MUNDO.p, MUNDO.h - MUNDO.p);
    reconstruirObstaculosSim();
    sim.setPlayer(J.x, J.y, 14);
    sim.setInstaKill(0);
    sim.setAI(dif.ia);
    if (cv && view.pxr) construirEstatico(true);      /* camada estática com o cenário novo */
  }

  /* =====================  RODADAS  ===================== */
  function totalRodada(n) { return Math.round((6 + 2.8 * (n - 1) + 0.12 * (n - 1) * (n - 1)) * dif.qtd); }
  function hpBase(n) { return (n <= 9 ? 55 + (n - 1) * 30 : 295 * Math.pow(1.075, n - 9)) * dif.hp; }
  function velBase(n) { return (48 + Math.min(n, 28) * 3.2) * dif.vel; }
  function limiteVivos(n) { return Math.min(40, Math.round((10 + n * 2) * dif.vivos)); }
  function intervaloSpawn(n) { return Math.max(0.35, 1.5 - n * 0.06) * dif.intervalo; }
  /* quantos tanques entram na rodada: a partir de dif.tanque.de, a cada dif.tanque.cada rodadas; 2 tanques nas rodadas avançadas */
  function tanquesDaRodada(n) {
    var t = dif.tanque;
    if (n < t.de || (n - t.de) % t.cada !== 0) return 0;
    return n >= t.de + t.cada * 3 ? 2 : 1;
  }
  var SETORES = ['ALFA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECO', 'FOXTROT', 'GOLF', 'HOTEL'];

  /* ---- inflação progressiva (Modo Insano): todo preço da Armaria e das estações sobe a cada rodada iniciada ---- */
  /* PreçoFinal = PreçoBase × (1 + (Rodada − 1) × dif.escalaPreco). Rodada 1 paga o preço-base; a taxa por rodada cresce com a dificuldade. */
  function inflacao() { return 1 + Math.max(0, (S ? S.rodada : 1) - 1) * (dif.escalaPreco || 0); }
  function atualizarCustosEstacoes() {
    var dsc = MV.Meta.tem('r07') ? 0.85 : 1;
    ESTACOES[0].custo = arred(dif.custoMun * inflacao() * dsc); ESTACOES[1].custo = arred(dif.custoMed * inflacao() * dsc);
  }
  function iniciarRodada(n) {
    S.rodada = n;
    atualizarCustosEstacoes();
    if (!demo) {
      Meta.max('rodadaMax', n); if (dif.id === 'insano') Meta.max('insanoRodada', n);
      LEG.max('rodadaMax', n); LEG.checar();
      S.tiros = 0; S.acertos = 0; S.armasKill = {}; S.nArmasKill = 0;       /* precisão e "armas diferentes" valem por rodada/onda */
      S.limpa = true;
      if (reposicionarEstacoes() && n > 1) Som.postos();
      if (Meta.tem('r06')) { J.escudo = ESCUDO_MAX; J.escudoT = ESCUDO_TEMPO; }
    }
    /* especiais garantidos: fila de tipos (3 corredor / 5 tóxico) que serão forçados no spawn desta rodada */
    S.espFila = [];
    if (dif.especiais) { var ne = Math.min(7, 1 + ((n - 1) >> 1)); for (var qe = 0; qe < ne; qe++) { var rq = Math.random(); S.espFila.push(rq < 0.4 ? 3 : (rq < 0.75 ? 5 : 6)); } }
    var nT = tanquesDaRodada(n);
    S.aSpawnar = totalRodada(n) + nT;
    S.inicial = S.aSpawnar;
    S.gatilhos = nT === 2 ? [0.65, 0.3] : (nT === 1 ? [0.5] : []);
    S.tSpawn = 3.2;
    S.fase = 'ativa';
    S.vistos = {};
    mostrarBanner('RODADA ' + n, 'SETOR DE COMBATE ' + SETORES[(n - 1) % SETORES.length] + ' · ' + fmtNum(S.aSpawnar) + ' INFECTADOS DETECTADOS');
    Som.rodada();
    /* o sangue velho vai escurecendo */
    decalCtx.save(); decalCtx.globalCompositeOperation = 'destination-out'; decalCtx.fillStyle = 'rgba(0,0,0,.35)'; decalCtx.fillRect(0, 0, decalCv.width, decalCv.height); decalCtx.restore();
    if (!demo) { Meta.checar(); salvarAuto(); }
  }

  function terminarRodada() {
    S.fase = 'intervalo';
    S.tFase = 10;
    var reforco = dif.bonus > 0;
    mostrarAviso(reforco ? 'SETOR LIMPO · REFORÇOS RECEBIDOS' : 'SETOR LIMPO · SEM REFORÇOS', reforco ? '#a3d05c' : '#e8b630');
    Som.fimRodada();
    if (S.limpa) Meta.inc('rodadasLimpas');
    Meta.ganharXp('forca', 10); Meta.checar(); salvarAuto();
    if (!demo) {                                                  /* legado: onda concluída + precisão da onda (≥ 30 tiros e ≥ 85%) */
      LEG.inc('ondas');
      if (S.tiros >= 30 && Math.min(S.acertos, S.tiros) / S.tiros >= 0.85) LEG.marcar('a4');
      LEG.checar(); LEG.salvar();
    }
    for (var i = 0; i < ARMAS.length; i++) if (S.possui[i]) armaEst[i].res = Math.min(LIM[i].resMax, armaEst[i].res + ARMAS[i].pente * dif.bonus);
    if (dif.bonus > 0 && J.granadas < GRANADA.max) J.granadas++;
    avisoHud.arma = null;
  }

  /* sorteia o tipo do próximo infectado comum/especial desta rodada */
  function sortearTipo(rodada) {
    var r = Math.random();
    var pCorredor = rodada < 3 ? 0 : Math.min(0.2, (0.05 + (rodada - 3) * 0.02) * dif.esp);
    var pToxico = rodada < 4 ? 0 : Math.min(0.14, (0.04 + (rodada - 4) * 0.012) * dif.esp);
    var pBomber = rodada < 4 ? 0 : Math.min(0.12, (0.03 + (rodada - 4) * 0.01) * dif.esp);
    if (r < pCorredor) return 3;
    if (r < pCorredor + pToxico) return 5;
    if (r < pCorredor + pToxico + pBomber) return 6;
    var pVeloz = rodada < 3 ? 0 : Math.min(0.5, (rodada - 2) * 0.06);
    var pBruto = rodada < 5 ? 0 : Math.min(0.16, (rodada - 4) * 0.022);
    r = Math.random();
    if (r < pBruto) return 2;
    if (r < pBruto + pVeloz) return 1;
    return 0;
  }

  var candJan = [];   /* reutilizado a cada spawn (sem alocação) */
  function gerarZumbi(rodada, tipoForcado) {
    /* janelas longe do jogador */
    var cand = candJan, longe = null, md = -1; cand.length = 0;
    for (var i = 0; i < JANELAS.length; i++) {
      var jn = JANELAS[i], d = hip(jn.x - J.x, jn.y - J.y);
      if (d > 520) cand.push(jn);
      if (d > md) { md = d; longe = jn; }
    }
    var jan = cand.length ? cand[(Math.random() * cand.length) | 0] : longe;
    var x = jan.x, y = jan.y, off = rand(-30, 30), margem = 34 + (tipoForcado === 4 ? 10 : 0);
    if (jan.lado === 'c') { y = MUNDO.p + margem; x += off; }
    else if (jan.lado === 'b') { y = MUNDO.h - MUNDO.p - margem; x += off; }
    else if (jan.lado === 'e') { x = MUNDO.p + margem; y += off; }
    else { x = MUNDO.w - MUNDO.p - margem; y += off; }

    var tipo = tipoForcado != null ? tipoForcado : sortearTipo(rodada);
    var hp = hpBase(rodada), vel = velBase(rodada) * rand(0.9, 1.1), raio = TIPOS[tipo].raio, dano = 20 * dif.dano;
    if (tipo === 1) { hp *= 0.7; vel = Math.min(vel * 1.5, 205 * dif.vel); dano = 15 * dif.dano; }
    else if (tipo === 2) { hp *= 3.2; vel *= 0.72; dano = 35 * dif.dano; }
    else if (tipo === 3) { hp *= 0.85; vel = Math.min(vel * 1.35, 190 * dif.vel); dano = 18 * dif.dano; }          /* o dano real vem do bote (x1,6) */
    else if (tipo === 4) { hp = Math.max(900, hp * 11); vel = Math.max(40, vel * 0.62); dano = 58 * dif.dano; }     /* devastador e lento */
    else if (tipo === 5) { hp *= 1.6; vel *= 0.55; dano = 0; }                                                       /* o dano vem da explosão */
    else if (tipo === 6) { hp *= 0.9; vel = Math.min(vel * 1.12, 170 * dif.vel); dano = 0; }                         /* Bomber: corre atrás de você; o dano vem da explosão */
    if (!demo && LEG.pesadeloAtivo()) { hp *= 1.3; vel *= 1.1; }                                                      /* Modo Pesadelo: inimigos 30% mais duros e 10% mais rápidos */
    var idx = sim.spawnZombie(x, y, Math.round(hp), vel, raio, tipo, Math.round(dano));
    if (idx >= 0) {
      jan.brilho = 1;
      for (var k = 0; k < 8; k++) particula(3, x, y, rand(-50, 50), rand(-50, 50), rand(0.4, 0.9), rand(1.5, 3.5));
      if (!demo && tipo >= 3 && !S.vistos[tipo]) {
        S.vistos[tipo] = true;
        var msg = tipo === 4 ? 'ALERTA: TANQUE BLINDADO DETECTADO' : (tipo === 3 ? 'ATENÇÃO: CORREDOR DETECTADO' : (tipo === 6 ? 'ATENÇÃO: BOMBER · EXPLODE EM 1,5 s' : 'ATENÇÃO: INFECTADO TÓXICO DETECTADO'));
        mostrarAviso(msg, COR_TIPO[tipo]);
        Som.alerta(tipo);
      }
    }
    return idx >= 0;
  }

  /* =====================  PARTÍCULAS E TEXTOS  ===================== */
  /* tipos: 0 sangue escuro, 1 sangue vivo, 2 faísca, 3 terra, 4 cápsula, 5 fumaça */
  function criarParticulas() {
    P = { n: MAXP, x: new Float32Array(MAXP), y: new Float32Array(MAXP), vx: new Float32Array(MAXP), vy: new Float32Array(MAXP), vida: new Float32Array(MAXP), max: new Float32Array(MAXP), tam: new Float32Array(MAXP), tipo: new Uint8Array(MAXP), prox: 0 };
  }
  function particula(tipo, x, y, vx, vy, vida, tam) {
    var i = P.prox; P.prox = (P.prox + 1) % MAXP;
    P.x[i] = x; P.y[i] = y; P.vx[i] = vx; P.vy[i] = vy; P.vida[i] = vida; P.max[i] = vida; P.tam[i] = tam; P.tipo[i] = tipo;
  }
  function sangue(x, y, dx, dy, qtd, vel) {
    for (var i = 0; i < qtd; i++) {
      var a = Math.atan2(dy, dx) + rand(-0.7, 0.7), v = rand(0.3, 1) * vel;
      particula(Math.random() < 0.55 ? 0 : 1, x, y, Math.cos(a) * v, Math.sin(a) * v, rand(0.25, 0.7), rand(1.3, 3.2));
    }
  }
  /* mancha permanente: vai para o canvas de gore (não some entre rodadas) */
  function mancha(x, y, r, a) {
    var g = goreCtx; if (!g) return;
    g.setTransform(goreEsc, 0, 0, goreEsc, 0, 0);
    for (var i = 0, n = 4 + ((r / 6) | 0); i < n; i++) {
      var rr = r * rand(0.25, 0.7), ox = rand(-r, r) * 0.8, oy = rand(-r, r) * 0.8;
      g.fillStyle = Math.random() < 0.7 ? 'rgba(88,8,12,' + a + ')' : 'rgba(130,14,18,' + a * 0.8 + ')';
      g.beginPath(); g.ellipse(x + ox, y + oy, rr, rr * rand(0.6, 1), rand(0, TAU), 0, TAU); g.fill();
    }
  }
  /* =====================  ROGUELITE DA PARTIDA: XP, NÍVEL E PERKS  =====================
   * Cada abate rende XP (por tipo). Ao subir de nível o jogo congela e mostra 3 perks sorteados; os escolhidos acumulam (stacks) até o fim da partida. */
  function xpParaNivel(n) { return Math.round(60 + 45 * (n - 1) + 6 * (n - 1) * (n - 1)); }
  function ganharXpRun(tz) {
    S.xp += XP_TIPO[tz] * (demo ? 1 : LEG.xpMult());
    while (S.xp >= xpParaNivel(S.nivel)) { S.xp -= xpParaNivel(S.nivel); S.nivel++; S.perkPend++; }
  }
  var PERKS = [
    { id: 'gelo', nome: 'TIROS CONGELANTES', cor: '#7fd4ff', ico: 'M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7',
      desc: function (n) { return 'Cada acerto tem ' + Math.round(Math.min(0.6, 0.15 + 0.08 * n) * 100) + '% de chance de congelar o alvo: 40% mais lento por 2 s.'; } },
    { id: 'rico', nome: 'RICOCHETE', cor: '#ffd23a', ico: 'M3 19L11 6l3 8 7-9',
      desc: function (n) { return Math.round(Math.min(0.6, 0.2 + 0.1 * n) * 100) + '% de chance de a bala quicar na primeira parede e atingir de novo.'; } },
    { id: 'aura', nome: 'AURA INCENDIÁRIA', cor: '#ff7a2a', ico: 'M12 2c2 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-4 3-7 1 2 2 2 3-4z',
      desc: function (n) { return 'Fogo constante num raio de ' + (90 + 18 * n) + ' px ao seu redor: ' + (7 + 4 * n) + ' de dano por segundo nos zumbis próximos.'; } },
    { id: 'pente', nome: 'PENTE ESTENDIDO', cor: '#a3d05c', ico: 'M7 3h10v18H7zM7 8h10M7 13h10',
      desc: function (n) { return '+25% de capacidade de munição (acumulativo). Enche o pente da arma na hora.'; } }
  ];
  function abrirPerks() {
    if (S.perkAberto || demo || estado !== 'jogando') return;
    var ids = [0, 1, 2, 3], op = [];
    while (op.length < 3) op.push(ids.splice((Math.random() * ids.length) | 0, 1)[0]);
    S.perkOpcoes = op; S.perkAberto = true; resetEntrada(); mostrarPrompt(null);
    var h = '<h2>NÍVEL ' + S.nivel + '</h2><p class="perkSub">ESCOLHA UMA MELHORIA' + (MV.Gamepad.ativo ? ' · D-PAD + A' : ' · TOQUE OU TECLAS 1 / 2 / 3') + '</p><div class="perkLista">';
    for (var k = 0; k < op.length; k++) {
      var pk = PERKS[op[k]], n = S.perk[pk.id];
      h += '<button type="button" class="perkCard" data-perk="' + k + '" style="--c:' + pk.cor + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + pk.ico + '"/></svg>' +
        '<b>' + pk.nome + '</b><em>' + (n ? 'NÍVEL ' + n + ' → ' + (n + 1) : 'NOVO') + '</em><span>' + pk.desc(n) + '</span><kbd>' + (k + 1) + '</kbd></button>';
    }
    el.perksGrade.innerHTML = h + '</div>';
    el.perks.hidden = false; Som.perk();
    var bs = el.perksGrade.querySelectorAll('.perkCard');
    for (var q = 0; q < bs.length; q++) bs[q].addEventListener('click', function (e) { escolherPerk(+e.currentTarget.getAttribute('data-perk')); });
  }
  function escolherPerk(k) {
    if (!S.perkAberto) return;
    var pk = PERKS[S.perkOpcoes[k]]; if (!pk) return;
    S.perk[pk.id]++;
    if (pk.id === 'pente') {
      var antes = penteMax(J.arma);
      J.magMult = (demo ? 1 : LEG.capMun()) * (1 + 0.25 * S.perk.pente);
      armaEst[J.arma].mag += penteMax(J.arma) - antes;                      /* ganho imediato na arma equipada */
      for (var i = 0; i < ARMAS.length; i++) if (i !== J.arma && S.possui[i] && !ARMAS[i].semRecarga) LIM[i].resMax = limResMax(ARMAS[i]);
      atualizarArmaHud(true);
    }
    S.perkAberto = false; S.perkPend = Math.max(0, S.perkPend - 1); el.perks.hidden = true;
    lastT = performance.now(); Som.coleta();
    mostrarAviso(pk.nome + ' · NÍVEL ' + S.perk[pk.id], pk.cor);
  }
  function atualizarPerks(dt) {                                              /* efeitos contínuos (Aura Incendiária) */
    if (demo || estado !== 'jogando' || S.perk.aura <= 0) return;
    var n = S.perk.aura - 1, raio = 90 + 18 * n, dps = 7 + 4 * n, Zv = V.Z, i, o;
    S.tAura -= dt;
    var tick = S.tAura <= 0; if (tick) S.tAura = 0.25;
    for (i = 0; i < 6; i++) if (Math.random() < dt * 14) { var a = rand(0, TAU), rr = raio * Math.sqrt(Math.random()); particula(7, J.x + Math.cos(a) * rr, J.y + Math.sin(a) * rr, rand(-10, 10), rand(-50, -20), rand(0.25, 0.5), rand(2, 4)); }
    if (!tick) return;
    for (i = 0; i < MAXZ; i++) {
      o = i * ZS; if (Zv[o] < 0.5 || Zv[o + 12] < 0.6) continue;
      if (hip(Zv[o + 1] - J.x, Zv[o + 2] - J.y) < raio + Zv[o + 6]) sim.damageZ(i, dps * 0.25);
    }
  }
  /* toasts de conquista do Legado + salvamento periódico (independente do slot de campanha) */
  var filaLeg = [], legT = 0, legSalvar = 0;
  LEG.onConquista = function (c) { filaLeg.push(c); if (el && el.skinGrupo) atualizarSkinsLock(); };
  function bombearToast(dt) {
    if (toastT > 0) { toastT -= dt; if (toastT <= 0) { toastT = 0; if (!fila.length && !filaLeg.length) el.toastConq.hidden = true; } }
    if (toastT <= 0 && el.toastConq) {
      if (filaLeg.length) {
        var c = filaLeg.shift();
        el.toastConq.innerHTML = '<small>LEGADO · ' + (c.cat === 'A' ? 'INICIAL' : 'AVANÇADA') + '</small><b>' + c.nome + '</b><span>+' + fmtNum(c.pc) + ' PC · ' + c.bonusTxt + '</span>';
        el.toastConq.style.setProperty('--c', c.cat === 'A' ? '#e8b630' : '#ff4d4d'); el.toastConq.hidden = true; void el.toastConq.offsetWidth; el.toastConq.hidden = false;
        toastT = 4.2; Som.conquista();
      } else if (fila.length) proximoToast();
    }
    legT -= dt; legSalvar -= dt;
    if (legT <= 0) { legT = 0.5; LEG.checar(); }
    if (legSalvar <= 0) { legSalvar = 10; LEG.salvar(); }
  }

  /* =====================  GORE  =====================
   * · goreCv: canvas offscreen do tamanho do mundo (escala 1.0; 0.6 em aparelho com pouca memória). Recebe manchas, poças, cadáveres e partes
   *   paradas UMA vez e nunca é redesenhado: o custo por quadro é um único drawImage recortado na janela visível => FPS intacto.
   * · pParte: pool (64) das partes do corpo em voo (cabeça / braços / pernas). Ao parar, são "assadas" no goreCv e persistem para sempre.
   * · Tudo some só quando começa uma NOVA partida (goreLimpar). */
  var goreCv = null, goreCtx = null, goreEsc = 1;
  var pParte = new Pool(64, function () { return { x: 0, y: 0, vx: 0, vy: 0, rot: 0, vr: 0, parte: 0, tipo: 0, esc: 1, t: 0 }; });
  var pCadBomb = new Pool(12, function () { return { x: 0, y: 0, rot: 0, t: 0, esc: 1 }; });     /* Bombers mortos com o pavio ainda aceso */
  var dismT = new Float32Array(256), crawlX = new Float32Array(256), crawlY = new Float32Array(256);
  var goreOrc = 14;                                                                               /* orçamento de jorros por quadro */
  var HEAVY_IDS = { m16: 1, escopeta: 1 };
  var BOMB_R = 118;                                                                               /* raio da explosão do Bomber (igual ao sim.c) */
  function criarGore() {
    var lowMem = (navigator.deviceMemory && navigator.deviceMemory <= 2) || (MV.lite === true);
    goreEsc = lowMem ? 0.6 : 1;
    goreCv = document.createElement('canvas'); goreCv.width = Math.round(MUNDO.w * goreEsc); goreCv.height = Math.round(MUNDO.h * goreEsc);
    goreCtx = goreCv.getContext('2d');
  }
  function goreLimpar() {
    if (goreCtx) { goreCtx.setTransform(1, 0, 0, 1, 0, 0); goreCtx.clearRect(0, 0, goreCv.width, goreCv.height); }
    pParte.n = 0; pCadBomb.n = 0; dismT.fill(0); crawlX.fill(0); crawlY.fill(0);
  }
  function goreG() { goreCtx.setTransform(goreEsc, 0, 0, goreEsc, 0, 0); return goreCtx; }
  function assarParte(p) {
    if (!goreCtx) return;
    var g = goreG();
    Gore.poca(g, p.x, p.y, 9 * p.esc, Gore.corSangue(p.tipo), 0.4);
    Gore.desenharParte(g, p.parte, p.tipo, p.esc, p.rot, p.x, p.y);
  }
  function novaParte(parte, tipo, x, y, vx, vy, esc) {
    if (pParte.n >= pParte.a.length) assarParte(pParte.a[0]);          /* cheio: grava a mais antiga antes de reciclar (nada some) */
    var p = pParte.add();
    p.parte = parte; p.tipo = tipo; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.esc = esc; p.rot = rand(0, TAU); p.vr = rand(-16, 16); p.t = 0;
  }
  function assarCadaver(x, y, tz, mask, rot, raio, poca) {
    if (!goreCtx || !sprites) return;
    var g = goreG();
    Gore.poca(g, x, y, raio * poca, Gore.corSangue(tz), 0.5);
    var cs = Gore.corpo(sprites, tz, mask & 7), w = raio / 14 * sprites.U;
    g.save(); g.translate(x, y); g.rotate(rot); g.drawImage(cs, -w / 2, -w / 2, w, w); g.restore();
  }
  function jorroSangue(x, y, dx, dy, intens, tz) {
    if (!goreCtx || goreOrc <= 0) return;
    goreOrc--; Gore.jorro(goreG(), x, y, dx, dy, intens, Gore.corSangue(tz));
  }
  /* tag do tiro: bits 0-4 = arma+1, 32 crítico, 64 ricochete armado, 128 já ricocheteou; 100 explosão, 101 fogo, 102 autodetonação */
  function ehTiro(tag) { return tag > 0 && tag !== 100 && tag !== 101 && tag !== 102; }
  function armaDaTag(tag) { return ehTiro(tag) ? (tag & 31) - 1 : -1; }

  /* perda de membro SEM morte (acerto crítico, arma pesada ou explosão): braço ou perna. Pernas viram rastejador (colisão ajustada no WASM). */
  function tentarMembro(idx, dano, explosao, dirx, diry) {
    var Zv = V.Z, o = idx * ZS;
    if (idx < 0 || idx >= MAXZ || Zv[o] < 0.5 || S.t < dismT[idx]) return;
    var hpM = Zv[o + 4], chance = explosao ? 1 : clamp(0.4 + 0.6 * dano / (0.5 * hpM), 0.4, 1);
    if (Math.random() > chance) return;
    var mask = Zv[o + 27] | 0, livres = [];
    if (!(mask & 2)) livres.push(2); if (!(mask & 4)) livres.push(4); if (!(mask & 8)) livres.push(8);
    if (!livres.length) return;
    var m = livres[(Math.random() * livres.length) | 0], tz = Zv[o + 11] | 0, rr = Zv[o + 6], x = Zv[o + 1], y = Zv[o + 2];
    dismT[idx] = S.t + 0.35;
    sim.dismember(idx, m);
    var l = hip(dirx, diry) || 1, a = Math.atan2(diry, dirx) + rand(-0.8, 0.8), v = rand(130, 300);
    novaParte(m === 2 ? 1 : (m === 4 ? 2 : 3), tz, x, y, Math.cos(a) * v, Math.sin(a) * v, rr / 14);
    jorroSangue(x, y, dirx / l, diry / l, 1.1, tz);
    sangue(x, y, dirx, diry, 8, 220);
    if (m === 8) { crawlX[idx] = x; crawlY[idx] = y; }
    Som.desmembrar();
  }
  /* membros arrancados NA MORTE (crítico / escopeta / M16 / explosão). Devolve a máscara perdida agora (1 cabeça, 2 braço E, 4 braço D, 8 pernas). */
  function gorarMorte(x, y, tz, rr, maskPrev, tag, dirx, diry) {
    var expl = tag === 100, crit = ehTiro(tag) && (tag & 32), w = armaDaTag(tag), heavy = w >= 0 && ARMAS[w] && HEAVY_IDS[ARMAS[w].id];
    if (!expl && !crit && !heavy) return 0;
    var chance = expl ? 1 : Math.min(1, 0.4 + (crit ? 0.3 : 0) + (heavy ? 0.3 : 0));
    if (Math.random() > chance) return 0;
    var livres = [];
    if (!(maskPrev & 1)) livres.push(1); if (!(maskPrev & 2)) livres.push(2); if (!(maskPrev & 4)) livres.push(4); if (!(maskPrev & 8)) livres.push(8);
    var qtd = Math.min(livres.length, expl ? 2 + (Math.random() < 0.5 ? 1 : 0) : 1 + (Math.random() < 0.35 ? 1 : 0)), perdido = 0, l = hip(dirx, diry) || 1;
    for (var k = 0; k < qtd; k++) {
      var j = (Math.random() * livres.length) | 0, m = livres.splice(j, 1)[0];
      perdido |= m;
      var a = expl ? rand(0, TAU) : Math.atan2(diry, dirx) + rand(-0.9, 0.9), v = rand(150, expl ? 460 : 340);
      novaParte(m === 1 ? 0 : (m === 2 ? 1 : (m === 4 ? 2 : 3)), tz, x, y, Math.cos(a) * v, Math.sin(a) * v, rr / 14);
    }
    return perdido;
  }
  function atualizarGore(dt) {
    goreOrc = 14;
    var i, p, f, g;
    for (i = pParte.n - 1; i >= 0; i--) {
      p = pParte.a[i]; p.t += dt;
      f = Math.exp(-4.2 * dt); p.vx *= f; p.vy *= f; p.vr *= Math.exp(-3 * dt);
      var nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
      if (!pontoLivre(nx, p.y, 2)) { p.vx *= -0.35; nx = p.x; }
      if (!pontoLivre(p.x, ny, 2)) { p.vy *= -0.35; ny = p.y; }
      p.x = nx; p.y = ny; p.rot += p.vr * dt;
      var v = hip(p.vx, p.vy);
      if (v > 40 && Math.random() < dt * 40) particula(0, p.x, p.y, rand(-20, 20), rand(-20, 20), rand(0.2, 0.45), rand(1.4, 2.6));
      if (v > 30 && goreCtx && Math.random() < dt * 24) {
        g = goreG(); g.fillStyle = 'rgba(' + Gore.corSangue(p.tipo) + ',.5)'; g.beginPath(); g.ellipse(p.x, p.y, 2.4, 1.7, rand(0, TAU), 0, TAU); g.fill();
      }
      if (v < 14 || p.t > 1.6) { assarParte(p); pParte.rem(i); }
    }
    for (i = 0; i < pCadBomb.n; i++) pCadBomb.a[i].t += dt;
    var Zv = V.Z;
    for (i = 0; i < MAXZ; i++) {                                         /* rastejadores deixam rastro de sangue */
      var o = i * ZS; if (Zv[o] < 0.5 || Zv[o + 26] < 0.5 || !goreCtx) continue;
      var dx = Zv[o + 1] - crawlX[i], dy = Zv[o + 2] - crawlY[i];
      if (dx * dx + dy * dy > 196) {
        if (crawlX[i] !== 0) Gore.rastro(goreG(), Zv[o + 1], Zv[o + 2], Math.atan2(dy, dx), Gore.corSangue(Zv[o + 11] | 0));
        crawlX[i] = Zv[o + 1]; crawlY[i] = Zv[o + 2];
      }
    }
  }
  /* partes em voo e Bombers com pavio aceso (desenhados no chão, sob os infectados) */
  function desenharGoreDinamico(x0, y0, x1, y1) {
    var i, p;
    for (i = 0; i < pParte.n; i++) {
      p = pParte.a[i]; if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      Gore.desenharParte(ctx, p.parte, p.tipo, p.esc, p.rot, p.x, p.y);
    }
    for (i = 0; i < pCadBomb.n; i++) {
      var b = pCadBomb.a[i]; if (b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1) continue;
      var w = b.esc * sprites.U;
      ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.drawImage(Gore.corpo(sprites, 6, 0), -w / 2, -w / 2, w, w); ctx.restore();
      var pisca = Math.sin(b.t * (12 + b.t * 16)) > 0, k = clamp(b.t / 1.5, 0, 1);
      ctx.strokeStyle = 'rgba(255,70,40,' + (0.25 + 0.3 * k) + ')'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
      ctx.beginPath(); ctx.arc(b.x, b.y, BOMB_R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      if (pisca && sprAura) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.8; ctx.drawImage(sprAura, b.x - 34, b.y - 34, 68, 68); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
    }
  }

  function atualizarParticulas(dt) {
    for (var i = 0; i < MAXP; i++) {
      if (P.vida[i] <= 0) continue;
      P.vida[i] -= dt;
      var f = Math.exp(-(P.tipo[i] === 4 ? 4 : 5) * dt);
      P.vx[i] *= f; P.vy[i] *= f;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt;
      if (P.vida[i] <= 0 && P.tipo[i] <= 1 && Math.random() < 0.5) mancha(P.x[i], P.y[i], P.tam[i] * 1.4, 0.5);
    }
    for (var k = pTexto.n - 1; k >= 0; k--) {
      var t = pTexto.a[k]; t.vida -= dt; t.y -= 38 * dt;
      if (t.vida <= 0) pTexto.rem(k);
    }
  }
  function flutuante(x, y, txt, cor, tam) {
    var t = pTexto.add();
    t.x = x + rand(-8, 8); t.y = y - 10; t.txt = txt; t.cor = cor; t.tam = tam || 16; t.vida = 0.9; t.max = 0.9;
  }

  /* =====================  HUD / UI  ===================== */
  var el = {};
  function cacheUI() {
    var ids = ['hud', 'controles', 'menu', 'pausa', 'fim', 'erro', 'vidaNum', 'vidaBarra', 'painelVida', 'rodadaNum', 'restam', 'pontosNum', 'painelPontos',
      'armaNome', 'armaTipo', 'armaPath', 'munMag', 'munRes', 'recargaBarra', 'slots', 'efeitos', 'aviso', 'prompt', 'promptTxt', 'promptBarra', 'banner', 'bannerTitulo', 'bannerSub', 'dica',
      'btnJogar', 'btnComoJogar', 'ajuda', 'recorde', 'btnPausa', 'btnContinuar', 'btnReiniciar', 'btnSom', 'btnTela', 'btnMenu', 'btnMenu2', 'btnDeNovo', 'motorPausa',
      'fimRodada', 'fimPontos', 'fimAbates', 'fimTempo', 'fimRecorde', 'fimNivel', 'condicao', 'chefe', 'chefeNome', 'chefeBarra', 'faixa', 'nivelGrupo', 'nivelDesc', 'stickZona', 'stickBase', 'stickKnob', 'btnAtirar', 'btnRecarregar', 'btnTrocar', 'painelArma', 'erroTxt', 'loja', 'lojaGrade', 'lojaPontos', 'lojaMsg', 'lojaDica', 'btnLojaFechar', 'btnLoja', 'btnGranada', 'granNum', 'rngDeadzone', 'dzVal', 'btnCorrer', 'miraZona', 'stamBarra', 'config', 'btnConfig', 'btnConfigMenu', 'btnConfigHud', 'btnConfigVoltar', 'btnAuto', 'rngLuz', 'luzVal', 'rngEscala', 'escVal', 'btnVibrar', 'vibDesc', 'rngZoom', 'zoomVal', 'btnZoomMenos', 'btnZoomMais', 'padCfg', 'padStatus', 'btnPerfil', 'padLinhas', 'padDiag', 'btnPadReset', 'molNum', 'minaNum', 'btnMolotov', 'btnMina', 'btnCreditos', 'creditos', 'btnCreditosVoltar', 'skinGrupo', 'perks', 'perksGrade', 'nivelRun', 'xpBarra', 'painelXp', 'btnLegado', 'painelLegado', 'legLista', 'legPC', 'btnLegVoltar', 'rngShake', 'shakeVal', 'btnNoite', 'rngEscalaStick', 'escStickVal', 'btnEscP', 'btnEscM', 'btnEscG',
      'btnTelaMenu', 'btnHistoria', 'btnConquistas', 'btnRecompensas', 'historia', 'btnHNovo', 'btnHCarregar', 'btnHVoltar', 'telaSlots', 'slotsTitulo', 'slotsDesc', 'slotsLista', 'btnSlotsVoltar', 'confirma', 'confirmaTxt', 'btnConfirmaSim', 'btnConfirmaNao', 'painelMeta', 'metaTitulo', 'metaResumo', 'metaLista', 'btnMetaVoltar', 'slotAtivo', 'toastConq', 'btnFimCarregar'];
    for (var i = 0; i < ids.length; i++) el[ids[i]] = $(ids[i]);
    el.slotSpans = el.slots.querySelectorAll('span');
  }
  function mostrarAviso(txt, cor) {
    var e = el.aviso; e.hidden = true; void e.offsetWidth;
    e.textContent = txt; e.style.setProperty('--c', cor || '#e8b630'); e.hidden = false;
  }
  function mostrarBanner(t, s) {
    var e = el.banner; e.hidden = true; void e.offsetWidth;
    el.bannerTitulo.textContent = t; el.bannerSub.textContent = s || ''; e.hidden = false;
  }
  function atualizarArmaHud(forcar) {
    var a = ARMAS[J.arma], st = armaEst[J.arma];
    var chave = J.arma + ':' + st.mag + ':' + st.res + ':' + J.granadas + ':' + J.molotovs + ':' + J.minas + ':' + S.possui.join('');
    if (!forcar && avisoHud.arma === chave) return;
    if (!avisoHud.arma || avisoHud.arma.split(':')[0] !== String(J.arma) || forcar) {
      el.armaNome.textContent = a.nome; el.armaTipo.textContent = a.tipo;
      el.armaPath.setAttribute('d', MV.Sprites.ICONES_ARMA[J.arma]);
      for (var i = 0; i < el.slotSpans.length; i++) { el.slotSpans[i].classList.toggle('ativo', i === J.arma); el.slotSpans[i].classList.toggle('bloq', !S.possui[i]); }
    }
    el.granNum.textContent = demo ? '∞' : J.granadas;
    el.btnGranada.classList.toggle('vazio', !demo && J.granadas <= 0);
    el.molNum.textContent = demo ? '∞' : J.molotovs; el.minaNum.textContent = demo ? '∞' : J.minas;
    el.btnMolotov.classList.toggle('vazio', !demo && J.molotovs <= 0); el.btnMina.classList.toggle('vazio', !demo && J.minas <= 0);
    el.btnMolotov.setAttribute('data-n', demo ? '∞' : J.molotovs); el.btnMina.setAttribute('data-n', demo ? '∞' : J.minas); el.btnGranada.setAttribute('data-n', demo ? '∞' : J.granadas);
    avisoHud.arma = chave;
    el.munMag.textContent = demo ? '∞' : st.mag;
    el.munRes.textContent = demo ? '∞' : (a.semRecarga ? '—' : st.res);
    el.munMag.parentNode.classList.toggle('vazio', !demo && st.mag === 0);
  }
  function atualizarHud() {
    var v = Math.max(0, Math.ceil(J.vida));
    if (avisoHud.vida !== v) {
      avisoHud.vida = v;
      el.vidaNum.textContent = v;
      var p = clamp(J.vida / J.vidaMax, 0, 1);
      el.vidaBarra.style.transform = 'scaleX(' + p.toFixed(3) + ')';
      el.vidaBarra.style.setProperty('--cor', p > 0.5 ? '#a3d05c' : (p > 0.25 ? '#ffb13b' : '#ff4d4d'));
      el.painelVida.classList.toggle('baixa', p <= 0.3);
      var cond = p <= 0.3 ? 'CONDIÇÃO CRÍTICA' : (p <= 0.6 ? 'FERIDO' : 'ESTÁVEL');
      el.condicao.textContent = cond; el.condicao.className = 'condicao ' + (p <= 0.3 ? 'crit' : (p <= 0.6 ? 'fer' : 'ok'));
    }
    atualizarChefe();
    var xpk = S.nivel + ':' + Math.round(S.xp / xpParaNivel(S.nivel) * 100);
    if (avisoHud.xp !== xpk && el.xpBarra) { avisoHud.xp = xpk; el.nivelRun.textContent = 'NV ' + S.nivel; el.xpBarra.style.transform = 'scaleX(' + clamp(S.xp / xpParaNivel(S.nivel), 0, 1).toFixed(3) + ')'; }
    if (avisoHud.rod !== S.rodada) { avisoHud.rod = S.rodada; el.rodadaNum.textContent = S.rodada; }
    var rest = S.aSpawnar + sim.aliveCount();
    if (avisoHud.rest !== rest) { avisoHud.rest = rest; el.restam.textContent = rest; }
    var pt = Math.floor(S.pontos);
    if (avisoHud.pts !== pt) {
      avisoHud.pts = pt; el.pontosNum.textContent = fmtNum(pt);
      var pp = el.painelPontos; pp.classList.remove('pulso'); void pp.offsetWidth; pp.classList.add('pulso');
    }
    atualizarArmaHud(false);
    var sp = Math.round(J.stam);
    if (avisoHud.stam !== sp || avisoHud.exa !== J.exausto) {
      avisoHud.stam = sp; avisoHud.exa = J.exausto;
      el.stamBarra.style.transform = 'scaleX(' + (J.stam / 100).toFixed(3) + ')';
      el.stamBarra.parentNode.classList.toggle('exausto', J.exausto);
    }
    var podeLoja = podeAbrirLoja() && !S.lojaAberta;
    if (el.btnLoja.hidden === podeLoja) el.btnLoja.hidden = !podeLoja;
    if (J.recarga > 0) {
      el.recargaBarra.parentNode.classList.add('on');
      el.recargaBarra.style.transform = 'scaleX(' + (1 - J.recarga / J.recargaTotal).toFixed(3) + ')';
    } else if (avisoHud.recOn) { el.recargaBarra.parentNode.classList.remove('on'); }
    avisoHud.recOn = J.recarga > 0;
    atualizarEfeitosHud();
  }
  /* barra de vida do tanque (estilo chefe) */
  function atualizarChefe() {
    var Zv = V.Z, melhor = -1;
    for (var i = 0; i < MAXZ; i++) { var o = i * ZS; if (Zv[o] > 0.5 && Zv[o + 11] === 4) { melhor = o; break; } }
    if (melhor < 0) { if (!el.chefe.hidden) el.chefe.hidden = true; return; }
    if (el.chefe.hidden) el.chefe.hidden = false;
    var p = clamp(Zv[melhor + 3] / Zv[melhor + 4], 0, 1);
    el.chefeBarra.style.transform = 'scaleX(' + p.toFixed(3) + ')';
    var enf = p < 0.999;
    if (avisoHud.enf !== enf) { avisoHud.enf = enf; el.chefeNome.textContent = enf ? 'TANQUE ENFURECIDO' : 'TANQUE · BLINDADO'; el.chefe.classList.toggle('enf', enf); }
  }
  /* chips dos buffs ativos (cor = identidade do buff, borda = raridade); reescreve o HTML só quando algo muda */
  function atualizarEfeitosHud() {
    var E = S.efeitos, chave = Math.ceil(E.insta) + ':' + Math.ceil(E.dobro) + ':' + Math.ceil(E.fogo) + ':' + Math.ceil(E.boom) + ':' + Math.ceil(J.escudo) + ':' + (J.fogoT > 0 ? 1 : 0);
    if (avisoHud.efeitos === chave) return;
    avisoHud.efeitos = chave;
    var html = '';
    function chip(nome, tipo, p, extra) { return '<div class="efeito rar' + DROPS[tipo].rar + '" style="--c:' + DROPS[tipo].cor + ';--p:' + clamp(p, 0, 1).toFixed(2) + '">' + nome + (extra || '') + '<i></i></div>'; }
    if (E.insta > 0) html += chip('ABATE INSTANTÂNEO', 1, E.insta / BUFF_TEMPO);
    if (E.dobro > 0) html += chip('RECOMPENSA 2×', 2, E.dobro / BUFF_TEMPO);
    if (E.fogo > 0) html += chip('BALAS INCENDIÁRIAS', 4, E.fogo / BUFF_TEMPO);
    if (E.boom > 0) html += chip('BALAS EXPLOSIVAS', 5, E.boom / BUFF_TEMPO);
    if (J.escudo > 0) html += chip('ESCUDO', 3, J.escudo / ESCUDO_MAX, ' · ' + Math.ceil(J.escudo));
    if (J.fogoT > 0) html += '<div class="efeito" style="--c:#ff5a2a;--p:' + clamp(J.fogoT / 3, 0, 1).toFixed(2) + '">EM CHAMAS<i></i></div>';
    el.efeitos.innerHTML = html;
  }
  function mostrarPrompt(txt, erro, prog) {
    var p = el.prompt;
    if (!txt) { if (!p.hidden) p.hidden = true; return; }
    if (p.hidden) p.hidden = false;
    if (avisoHud.promptTxt !== txt) { avisoHud.promptTxt = txt; el.promptTxt.textContent = txt; }
    p.classList.toggle('erro', !!erro);
    el.promptBarra.style.setProperty('--p', String(prog || 0));
  }

  /* =====================  AÇÕES DO JOGADOR  ===================== */
  function trocarArma(i, dir) {
    if (estado !== 'jogando' && !demo) return;
    var n = ARMAS.length;
    if (i === undefined) {                       /* próxima (ou anterior) arma que o jogador possui */
      for (var k = 1; k <= n; k++) { var c = (J.arma + (dir || 1) * k + n * 8) % n; if (S.possui[c]) { i = c; break; } }
      if (i === undefined) return;
    }
    if (i === J.arma || !S.possui[i]) return;
    J.arma = i; J.recarga = 0; J.trocaTot = J.trocaT = TROCA_TEMPO * (demo ? 1 : LEG.trocaMult()); J.fireCd = 0.05;
    Som.trocar();
    atualizarArmaHud(true);
    el.recargaBarra.parentNode.classList.remove('on');
  }
  function iniciarRecarga(auto) {
    var a = ARMAS[J.arma], st = armaEst[J.arma];
    if (J.recarga > 0 || J.trocaT > 0) return;
    if (a.semRecarga) {                                   /* Mini Gun: pente único; só a Armaria enche de novo */
      if (!demo && st.mag < penteMax(J.arma)) { Som.vazio(); mostrarAvisoCurto(st.mag <= 0 ? 'MINI GUN VAZIA · COMPRE UMA RECARGA NA ARMARIA' : 'MINI GUN NÃO RECARREGA EM COMBATE'); }
      return;
    }
    var pm = penteMax(J.arma);
    if (st.mag >= pm || st.res <= 0) { if (!auto && st.res <= 0 && st.mag < pm) Som.vazio(); return; }
    J.recarga = J.recargaTotal = a.recarga * MV.Meta.recarga(MV.Meta.nivel('tiro')) * (demo ? 1 : LEG.recargaMult());
    Som.recarga(J.recargaTotal);
  }
  function finalizarRecarga() {
    var a = ARMAS[J.arma], st = armaEst[J.arma];
    var falta = penteMax(J.arma) - st.mag, leva = Math.min(falta, st.res);
    st.mag += leva; st.res -= leva;
    atualizarArmaHud(true);
  }
  /* uma bala: dano com crítico (2×) / Berserker, tag p/ eventos (arma, crítico, ricochete) escrita no buffer */
  function disparar1(ox, oy, dx, dy, vel, a, tag, perfExtra, chCrit, berserk) {
    if (!demo) S.tiros++;
    var crit = chCrit > 0 && Math.random() < chCrit, dano = a.dano * berserk * (crit ? 2 : 1);
    var idx = sim.fireBullet(ox, oy, dx, dy, vel, dano, a.alc / a.vel, a.perf + perfExtra, a.knock);
    tag |= crit ? 32 : 0; if (tag === 100 || tag === 101 || tag === 102) tag &= ~64;     /* nunca colidir com as tags de explosão/fogo */
    if (idx >= 0) V.B[idx * BS + 11] = tag;
    return idx;
  }
  function atirar(ang) {
    var a = ARMAS[J.arma], st = armaEst[J.arma];
    if (!demo && !(dif.id === 'insano' && MV.Meta.tem('r11'))) st.mag--;
    if (!demo) MV.Meta.ganharXp('tiro', 0.5);
    var esp = a.esp * (J.correndo ? 1.8 : (J.movendo ? 1.35 : 1)) * (demo ? 1 : LEG.precisaoMult());
    var ang2 = ang + (Math.random() - 0.5) * 2 * esp;
    var perfExtra = demo ? 0 : LEG.perfurar();
    var chCrit = demo ? 0 : LEG.chanceCritica();
    var berserk = (!demo && LEG.berserk()) ? 1 + 0.005 * Math.max(0, 100 - 100 * J.vida / J.vidaMax) : 1;
    var tagBase = (J.arma + 1) | (S.perk.rico > 0 && Math.random() < Math.min(0.6, 0.2 + 0.1 * (S.perk.rico - 1)) ? 64 : 0);

    var c = Math.cos(ang2), s = Math.sin(ang2);
    var lado = 3.2;
    if (S.dual[J.arma]) { S.lado = -(S.lado || 1); lado = 8 * S.lado; J.mao = S.lado; }       /* duplas: alterna a arma que dispara */
    var ox = J.x + Math.cos(ang) * a.comp + Math.cos(ang + 1.5708) * lado, oy = J.y + Math.sin(ang) * a.comp + Math.sin(ang + 1.5708) * lado;
    if (a.proj) {                                           /* leitão explosivo: projétil pesado, voa reto e explode no primeiro contato */
      sim.launchHeavy(1, ox, oy, c * a.vel, s * a.vel, 0, 0, a.alc / a.vel, a.dano, a.raio);
      for (var q = 0; q < 10; q++) particula(5, J.x - Math.cos(ang) * 10, J.y - Math.sin(ang) * 10, -Math.cos(ang) * rand(60, 260) + rand(-60, 60), -Math.sin(ang) * rand(60, 260) + rand(-60, 60), rand(0.4, 0.9), rand(4, 8));
    } else if (a.pellets) {                                 /* escopeta: balins espalhados de modo uniforme no cone, com um pouco de sorte */
      for (var p = 0; p < a.pellets; p++) {
        var t = a.pellets > 1 ? (p / (a.pellets - 1) - 0.5) * 2 : 0;
        var aa = ang2 + t * a.cone * 0.85 + (Math.random() - 0.5) * a.cone * 0.3;
        disparar1(ox, oy, Math.cos(aa), Math.sin(aa), a.vel * (0.9 + Math.random() * 0.2), a, tagBase, perfExtra, chCrit, berserk);
      }
    } else {
      disparar1(ox, oy, c, s, a.vel, a, tagBase, perfExtra, chCrit, berserk);
    }
    J.recuo = a.recuo; S.brilhoTiro = 0.06;
    var tr = a.shake !== undefined ? a.shake : a.tremor * 0.35;
    tremor.amp = Math.min(Math.max(2.6, tr), tremor.amp + tr);
    Som.tiro(J.arma);
    if (a.vib) { MV.Gamepad.vibrar(a.vib[0], a.vib[1], a.vib[2]); if (a.vib[0] >= 0.1) vibrarTela(Math.round(a.vib[0] * 250)); }   /* só armas pesadas vibram o aparelho */
    /* cápsula ejetada para a direita da arma (a escopeta solta cartuchos maiores; o lança-porcos não solta nada) */
    if (!a.proj) {
      var ca = ang + 1.5708 + rand(-0.5, 0.3);
      particula(4, J.x + Math.cos(ang) * 10, J.y + Math.sin(ang) * 10, Math.cos(ca) * rand(60, 130), Math.sin(ca) * rand(60, 130), rand(0.35, 0.6), 2);
    }
    particula(5, ox, oy, Math.cos(ang) * 20, Math.sin(ang) * 20, 0.3, 4);
    if (!demo && st.mag === 0 && !a.semRecarga) { if (st.res > 0) setTimeout(function () { if (estado === 'jogando') iniciarRecarga(true); }, 120); atualizarArmaHud(true); }
  }

  /* granada de fragmentação: arremesso em arco. O percurso total (voo + quiques + rolagem) vale ≈ 1,0 × a velocidade horizontal;
   usamos 1/0,85 para o primeiro pouso cair um pouco antes do alvo (mira trava no alvo, entre 160 e 460) */
  function lancarGranada() {
    if (demo || estado !== 'jogando' || S.lojaAberta) return;
    if (J.granCd > 0) return;
    if (J.granadas <= 0) { Som.vazio(); mostrarAvisoCurto('SEM GRANADAS · COMPRE NA ARMARIA'); return; }
    var dist = 340;
    if (J.temAlvo) dist = clamp(hip(J.alvoX - J.x, J.alvoY - J.y), 160, 460);
    var v = dist / 0.85, c = Math.cos(J.ang), s = Math.sin(J.ang);
    sim.launchHeavy(2, J.x + c * 18, J.y + s * 18, c * v, s * v, 14, GRANADA.vz, GRANADA.pavio, GRANADA.dano, GRANADA.raio);
    J.granadas--; J.granCd = GRANADA.cd; J.recuo = 3;
    Som.granadaPino();
    MV.Gamepad.vibrar(0.08, 0.2, 0.3);
    atualizarArmaHud(true);
  }


  /* =====================  RODADA 6: FOGO, MOLOTOV, MINAS, BARRIS, RASTRO TÓXICO  =====================
   * Tudo roda no JS por cima da simulação: o WASM só fornece damageZ (dano direto), blastAt (dano em área) e o projétil tipo 4 (molotov).
   * Estruturas com tamanho fixo (Pools / typed arrays) => nenhuma alocação durante a partida. */

  /* ---- explosões em área em fila (balas explosivas): executadas depois do laço de eventos para não mexer no buffer enquanto é lido ---- */
  function enfileirarBlast(x, y, r, dmg, kb) {
    if (blastN >= 32) return;
    var o = blastN * 6; blastQ[o] = x; blastQ[o + 1] = y; blastQ[o + 2] = r; blastQ[o + 3] = dmg; blastQ[o + 4] = kb; blastN++;
  }
  function drenarBlasts() {
    var n = blastN; blastN = 0;
    for (var k = 0; k < n; k++) {
      var o = k * 6, x = blastQ[o], y = blastQ[o + 1], r = blastQ[o + 2];
      sim.blastAt(x, y, r, blastQ[o + 3], blastQ[o + 4]);
      explosaoLeve(x, y, r);
      danoBarrisArea(x, y, r, 40);
    }
  }
  /* explosão pequena (bala explosiva): sem dano ao jogador */
  function explosaoLeve(x, y, r) {
    Som.estouro();
    var f = S.fx.add(); f.x = x; f.y = y; f.r = r; f.t = 0; f.max = 0.28; f.tp = 2;
    var i;
    for (i = 0; i < 7; i++) { var a = rand(0, TAU), v = rand(60, 240); particula(2, x, y, Math.cos(a) * v, Math.sin(a) * v, rand(0.12, 0.3), rand(1.8, 3)); }
    for (i = 0; i < 4; i++) particula(7, x + rand(-6, 6), y + rand(-6, 6), rand(-40, 40), rand(-60, -10), rand(0.25, 0.5), rand(3, 6));
    tremor.amp = Math.min(6, tremor.amp + 0.8);
  }

  /* ---- fogo ---- */
  function acender(i, dur) { if (i >= 0 && i < 256 && queima[i] < dur) queima[i] = dur; }
  function acenderJogador(dur) {
    if (demo || estado !== 'jogando') return;
    if (J.fogoT <= 0) { mostrarAviso('VOCÊ ESTÁ EM CHAMAS!', '#ff5a2a'); Som.chiado(); }
    J.fogoT = Math.max(J.fogoT, dur);
  }
  function zonaFogo(x, y, r, dur) {
    var f = pFogoZ.add(); f.x = x; f.y = y; f.r = r; f.t = dur; f.max = dur;
    Som.molotov();
    queimadura(x, y, r * 0.9);
    tremor.amp = Math.min(8, tremor.amp + 2);
    for (var i = 0; i < 14; i++) { var a = rand(0, TAU), v = rand(40, 200); particula(7, x, y, Math.cos(a) * v, Math.sin(a) * v, rand(0.3, 0.7), rand(3, 6)); }
    for (i = 0; i < 6; i++) particula(2, x, y, rand(-160, 160), rand(-160, 160), rand(0.15, 0.3), rand(2, 3.5));   /* cacos de vidro */
  }
  function pontoLivre(x, y, m) {                /* ponto fora de obstáculos/barris e dentro do mapa */
    if (x < MUNDO.p + m || y < MUNDO.p + m || x > MUNDO.w - MUNDO.p - m || y > MUNDO.h - MUNDO.p - m) return false;
    var i, o;
    for (i = 0; i < OBST.length; i++) { o = OBST[i]; if (x > o.x - m && x < o.x + o.w + m && y > o.y - m && y < o.y + o.h + m) return false; }
    for (i = 0; i < BARRIS.length; i++) { o = BARRIS[i]; if (o.vivo && Math.abs(x - o.x) < 16 + m && Math.abs(y - o.y) < 16 + m) return false; }
    return true;
  }
  function lancarMolotov() {
    if (demo || estado !== 'jogando' || S.lojaAberta) return;
    if (S.molCd > 0) return;
    if (J.molotovs <= 0) { Som.vazio(); mostrarAvisoCurto('SEM MOLOTOVS · COMPRE NA ARMARIA'); return; }
    var dist = 320;
    if (J.temAlvo) dist = clamp(hip(J.alvoX - J.x, J.alvoY - J.y), 150, 430);
    var c = Math.cos(J.ang), s = Math.sin(J.ang);
    for (var k = 0; k < 14 && dist > 70 && !pontoLivre(J.x + c * dist, J.y + s * dist, 6); k++) dist -= 24;   /* não cai dentro de paredes */
    var v = dist / MOLOTOV.voo;
    if (sim.launchHeavy(4, J.x + c * 18, J.y + s * 18, c * v, s * v, 0, 0, MOLOTOV.voo, 0, MOLOTOV.raio) < 0) return;
    J.molotovs--; S.molCd = MOLOTOV.cd; J.recuo = 3;
    Som.granadaPino();
    MV.Gamepad.vibrar(0.06, 0.2, 0.2);
    atualizarArmaHud(true);
  }
  /* ---- minas ---- */
  function plantarMina() {
    if (demo || estado !== 'jogando' || S.lojaAberta || S.minaCd > 0) return;
    if (J.minas <= 0) { Som.vazio(); mostrarAvisoCurto('SEM MINAS · COMPRE NA ARMARIA'); return; }
    if (pMinas.n >= 8) { mostrarAvisoCurto('LIMITE DE 8 MINAS ATIVAS'); return; }
    var m = pMinas.add(); m.x = J.x - Math.cos(J.ang) * 18; m.y = J.y - Math.sin(J.ang) * 18; m.arm = MINA.armar; m.t = 0;
    J.minas--; S.minaCd = 0.5;
    Som.minaPlantada();
    flutuante(m.x, m.y - 14, 'MINA ARMANDO...', '#ffd23a', 13);
    atualizarArmaHud(true);
  }
  function detonarMina(k) {
    var m = pMinas.a[k], x = m.x, y = m.y;
    pMinas.rem(k);
    S.tMina = 0.35; S.multiT = 0.6; S.multiN = 0;
    sim.blastAt(x, y, MINA.raio, MINA.dano, 80);
    explosaoPesada(x, y, MINA.raio, 2);
    zonaFogoPequena(x, y);
  }
  function zonaFogoPequena(x, y) { var f = pFogoZ.add(); f.x = x; f.y = y; f.r = 40; f.t = 2; f.max = 2; }

  /* ---- barris de gasolina ---- */
  function danificarBarrilEm(x, y, d) {
    for (var i = 0; i < BARRIS.length; i++) {
      var b = BARRIS[i];
      if (b.vivo && Math.abs(x - b.x) <= 19 && Math.abs(y - b.y) <= 19) { b.hp -= d; b.flash = 0.12; if (b.hp <= 0 && b.estoura < 0) b.estoura = 0.05; return; }
    }
  }
  function danoBarrisArea(x, y, r, d) {
    for (var i = 0; i < BARRIS.length; i++) {
      var b = BARRIS[i];
      if (b.vivo && b.estoura < 0 && hip(b.x - x, b.y - y) < r + 14) { b.hp -= d; if (b.hp <= 0) b.estoura = 0.12 + Math.random() * 0.12; }   /* reação em cadeia com pequeno atraso */
    }
  }
  function reconstruirObstaculosSim() {
    sim.clearObstacles();
    var i;
    for (i = 0; i < OBST.length; i++) sim.addObstacle(OBST[i].x, OBST[i].y, OBST[i].w, OBST[i].h);
    for (i = 0; i < BARRIS.length; i++) if (BARRIS[i].vivo) sim.addObstacle(BARRIS[i].x - 16, BARRIS[i].y - 16, 32, 32);
  }
  function explodirBarril(b) {
    b.vivo = false; b.estoura = -1;
    reconstruirObstaculosSim();
    S.tBarril = 0.45; S.multiT = 0.7; S.multiN = 0;
    sim.blastAt(b.x, b.y, 200, 420, 70);
    explosaoPesada(b.x, b.y, 200, 1);
    var f = pFogoZ.add(); f.x = b.x; f.y = b.y; f.r = 62; f.t = 4.5; f.max = 4.5;
    for (var i = 0; i < 10; i++) particula(7, b.x + rand(-12, 12), b.y + rand(-12, 12), rand(-90, 90), rand(-120, -20), rand(0.5, 1), rand(4, 8));
    mancha(b.x, b.y, 36, 0.4);
  }

  /* ---- laço dos extras (antes de sim.update; os eventos gerados aqui são processados no mesmo quadro) ---- */
  function atualizarExtras(dt) {
    if (estado !== 'jogando' || demo) return;
    var Zv = V.Z, i, o, k, zx, zy;
    S.boomN = 0;
    if (S.molCd > 0) S.molCd -= dt;
    if (S.minaCd > 0) S.minaCd -= dt;
    if (S.escudoFx > 0) S.escudoFx -= dt;
    S.tickFogo -= dt; var tick = S.tickFogo <= 0; if (tick) S.tickFogo += 0.25;
    S.noRastro = false;

    /* zonas de fogo */
    for (k = pFogoZ.n - 1; k >= 0; k--) {
      var fz = pFogoZ.a[k]; fz.t -= dt;
      if (fz.t <= 0) { pFogoZ.rem(k); continue; }
      if (Math.random() < dt * 40 * (fz.r / 100)) { var a = rand(0, TAU), rr = Math.sqrt(Math.random()) * fz.r * 0.9; particula(7, fz.x + Math.cos(a) * rr, fz.y + Math.sin(a) * rr, rand(-8, 8), rand(-70, -30), rand(0.4, 0.8), rand(3, 7)); }
      if (Math.random() < dt * 6) particula(5, fz.x + rand(-fz.r, fz.r) * 0.6, fz.y + rand(-fz.r, fz.r) * 0.6, rand(-10, 10), rand(-40, -15), rand(0.8, 1.4), rand(7, 12));
      for (i = 0; i < MAXZ; i++) {
        o = i * ZS; if (Zv[o] < 0.5) continue;
        if (hip(Zv[o + 1] - fz.x, Zv[o + 2] - fz.y) < fz.r + Zv[o + 6] * 0.5) {
          acender(i, 3);
          if (tick) { sim.damageZ(i, MOLOTOV.dps * 0.25); S.tFogo = 0.5; }
        }
      }
      if (hip(J.x - fz.x, J.y - fz.y) < fz.r * 0.8) acenderJogador(2.5);
    }
    /* zumbis: chamas (DoT), contágio e rastro tóxico */
    for (i = 0; i < MAXZ; i++) {
      o = i * ZS;
      if (Zv[o] < 0.5) { queima[i] = 0; rastroT[i] = 0; continue; }
      zx = Zv[o + 1]; zy = Zv[o + 2];
      if (queima[i] > 0) {
        queima[i] -= dt;
        if (tick) S.tFogo = 0.5;
        if (tick && sim.damageZ(i, FOGO_DPS * 0.25) === 2) { queima[i] = 0; continue; }
        if (hip(zx - J.x, zy - J.y) < Zv[o + 6] + 14 + 8) acenderJogador(3);       /* contágio: inimigo em chamas encostou no jogador */
      }
      if ((Zv[o + 11] | 0) === 5 && Zv[o + 12] >= 0.8) {
        rastroT[i] -= dt;
        if (rastroT[i] <= 0) { rastroT[i] = 0.22; var rt = pRastro.add(); rt.x = zx; rt.y = zy; rt.t = 7; rt.max = 7; }
      }
    }
    /* o rastro envelhece e machuca só quem PISA nele */
    for (k = pRastro.n - 1; k >= 0; k--) {
      var rs = pRastro.a[k]; rs.t -= dt;
      if (rs.t <= 0) { pRastro.rem(k); continue; }
      if (hip(J.x - rs.x, J.y - rs.y) < 20) S.noRastro = true;
    }
    if (S.noRastro) { danoDireto(12 * dif.dano * dt); if (Math.random() < dt * 2) flutuante(J.x, J.y - 22, 'TÓXICO!', '#9ad43a', 14); }
    /* jogador em chamas */
    if (J.fogoT > 0) {
      J.fogoT -= dt;
      danoDireto(7 * dif.dano * dt);
      if (Math.random() < dt * 22) particula(7, J.x + rand(-7, 7), J.y + rand(-7, 7), rand(-14, 14), rand(-70, -30), rand(0.3, 0.55), rand(2.5, 4.5));
      S.dano = Math.max(S.dano, 0.28);
    }
    /* minas */
    for (k = pMinas.n - 1; k >= 0; k--) {
      var mn = pMinas.a[k]; mn.t += dt;
      if (mn.arm > 0) { mn.arm -= dt; continue; }
      for (i = 0; i < MAXZ; i++) {
        o = i * ZS; if (Zv[o] < 0.5 || Zv[o + 12] < 0.8) continue;
        var dx = Zv[o + 1] - mn.x, dy = Zv[o + 2] - mn.y, rr2 = MINA.gatilho + Zv[o + 6];
        if (dx * dx + dy * dy < rr2 * rr2) { detonarMina(k); break; }
      }
    }
    /* barris: contagem para estourar */
    for (i = 0; i < BARRIS.length; i++) {
      var br = BARRIS[i];
      if (!br.vivo) continue;
      if (br.flash > 0) br.flash -= dt;
      if (br.estoura >= 0) { br.estoura -= dt; if (br.estoura <= 0) explodirBarril(br); }
      else if (br.hp < 22 && Math.random() < dt * 10) particula(5, br.x + rand(-5, 5), br.y + rand(-5, 5), rand(-10, 10), rand(-40, -15), rand(0.6, 1.1), rand(5, 9));
    }
    /* chamas visuais nos zumbis incendiados */
    for (i = 0; i < MAXZ; i++) if (queima[i] > 0 && Math.random() < dt * 16) { o = i * ZS; particula(7, Zv[o + 1] + rand(-5, 5), Zv[o + 2] + rand(-5, 5), rand(-14, 14), rand(-65, -25), rand(0.3, 0.55), rand(2.5, 4.5)); }
  }

  /* =====================  ATUALIZAÇÃO  ===================== */
  var LIMITE_MIRA = 560;

  function atualizarJogador(dt) {
    /* movimento */
    var gp = MV.Gamepad;
    var mx = IN.mx, my = IN.my;
    if (gp.ativo && (gp.mx || gp.my)) { mx = gp.mx; my = gp.my; }
    var kx = (IN.teclas.d || IN.teclas.arrowright ? 1 : 0) - (IN.teclas.a || IN.teclas.arrowleft ? 1 : 0);
    var ky = (IN.teclas.s || IN.teclas.arrowdown ? 1 : 0) - (IN.teclas.w || IN.teclas.arrowup ? 1 : 0);
    if (kx || ky) { var kl = hip(kx, ky); mx = kx / kl; my = ky / kl; }
    var m = hip(mx, my);
    if (m > 1) { mx /= m; my /= m; m = 1; }
    /* corrida tática: Shift / botão CORRER (direita) / clique no analógico esquerdo; gasta estamina e só volta a correr com 25% */
    var quer = m > 0.05 && (IN.correr || IN.teclas.shift || (gp.ativo && gp.correr));
    if (J.exausto && J.stam >= 25) J.exausto = false;       /* (insano: sai da exaustão ao comprar energia) */
    var corre = quer && J.stam > 0 && !J.exausto && !demo;
    var stamInf = MV.Meta.tem('r08') && dif.id !== 'insano';
    if (corre) { MV.Meta.inc('corridaSeg', dt); MV.Meta.ganharXp('corrida', dt * 2); }
    if (corre && stamInf) { J.stam = 100; J.stamT = 0.7; }
    else if (corre) { J.stam = Math.max(0, J.stam - 26 * (dif.stamDreno || 1) * dt); J.stamT = 0.7; if (J.stam <= 0) J.exausto = true; }
    else if (dif.stamRegen !== false) { J.stamT -= dt; if (J.stamT <= 0) J.stam = Math.min(100, J.stam + (m > 0.05 ? 14 : 26) * dt); }   /* insano: sem regeneração (só comprando na Armaria) */
    J.correndo = corre;
    var vel = 178 * m * (corre ? 1.55 : 1) * (S.gas > 0.2 ? 0.72 : 1) * MV.Meta.velocidade(MV.Meta.nivel('corrida')) * (demo ? 1 : LEG.velMult());
    J.movendo = m > 0.05;
    var px0 = J.x, py0 = J.y;
    if (!demo || estado === 'jogando') {
      if (J.movendo) { sim.movePlayer(mx / (m || 1) * vel * dt, my / (m || 1) * vel * dt); J.passo += vel * dt; }
      if (J.empT > 0) { J.empT -= dt; sim.movePlayer(J.empX * dt, J.empY * dt); }   /* empurrão do tanque */
      J.x = sim.getPX(); J.y = sim.getPY();
      if (!demo && estado === 'jogando') { var dm = hip(J.x - px0, J.y - py0); if (dm < 60) LEG.inc('unid', dm); }      /* Maratonista: distância percorrida */
    }

    /* mira */
    var manual = null;
    if (IN.miraBotao !== null) manual = IN.miraBotao;
    else if (gp.ativo && gp.mira !== null) manual = gp.mira;
    else if (IN.mouseAtivo && IN.mouse) manual = Math.atan2(IN.mouse.y - (J.y), IN.mouse.x - (J.x));
    /* Histerese de mira: o alvo travado só é solto se morrer, se ficar > LIMITE_MIRA (ou sem linha de tiro) por mais de 0,25 s,
       ou se o jogador arrastar com intenção clara (toque > 60 px / analógico firme). Ruído pequeno com autoAim ligado é ignorado. */
    var alvo = -1, L = S.aimLock, auto = cfg.autoAim || demo;
    if (auto) {
      var Zl = V.Z;
      if (L.id >= 0) {
        var ol = L.id * ZS, vivo = Zl[ol] > 0.5 && Zl[ol + 12] >= L.idade;      /* idade menor = slot reaproveitado por outro zumbi */
        if (vivo) {
          L.idade = Zl[ol + 12];
          var dl = hip(Zl[ol + 1] - J.x, Zl[ol + 2] - J.y);
          if (dl > LIMITE_MIRA || sim.losBlocked(J.x, J.y, Zl[ol + 1], Zl[ol + 2])) L.fora += dt; else L.fora = 0;
          if (L.fora > 0.25) vivo = false;
        }
        if (!vivo) { L.id = -1; L.t = 0; L.fora = 0; }
      }
      if (L.id < 0) {
        var nv = sim.nearestVisible(J.x, J.y, LIMITE_MIRA);
        if (nv >= 0) { L.id = nv; L.t = 0; L.fora = 0; L.idade = Zl[nv * ZS + 12]; }
      } else L.t += dt;
      var intencao = (IN.miraBotao !== null && IN.miraDist > MIRA_INTENCAO_PX) || (gp.ativo && gp.mira !== null && gp.miraMag >= 0.6) || (IN.miraBotao === null && !(gp.ativo && gp.mira !== null) && manual !== null);
      if (L.id >= 0 && manual !== null && intencao) { L.id = -1; L.t = 0; L.fora = 0; }          /* o jogador assumiu a mira */
      else if (L.id >= 0) alvo = L.id;
    } else if (L.id >= 0) { L.id = -1; L.t = 0; L.fora = 0; }
    if (alvo >= 0 && !demo && !(IN.miraBotao === null && !(gp.ativo && gp.mira !== null))) manual = null;   /* só toque/analógico: o mouse continua mandando */                                     /* ruído de dedo/analógico não derruba o alvo travado */
    var desejado = null;
    if (manual !== null) desejado = manual;
    else if (alvo >= 0) {
      var o = alvo * ZS, Zv = V.Z;
      var ax = Zv[o + 1], ay = Zv[o + 2];
      var arma = ARMAS[J.arma];
      var tt = hip(ax - J.x, ay - J.y) / arma.vel;
      var vz = Zv[o + 12] >= 0.6 ? Zv[o + 5] : 0;
      ax += Zv[o + 7] * vz * tt * 0.9; ay += Zv[o + 8] * vz * tt * 0.9;
      desejado = Math.atan2(ay - J.y, ax - J.x);
      J.alvoX = Zv[o + 1]; J.alvoY = Zv[o + 2];
    } else if (J.movendo) desejado = Math.atan2(my, mx);
    J.temAlvo = alvo >= 0 && manual === null;
    if (desejado !== null) J.ang += angDif(J.ang, desejado) * (1 - Math.exp(-26 * dt));

    /* armas */
    if (J.recuo > 0) J.recuo = Math.max(0, J.recuo - 28 * dt);
    if (J.trocaT > 0) J.trocaT -= dt;
    if (J.fireCd > 0) J.fireCd -= dt;
    if (J.granCd > 0) J.granCd -= dt;
    if (S.brilhoTiro > 0) S.brilhoTiro -= dt;
    if (J.recarga > 0) { J.recarga -= dt; if (J.recarga <= 0) { J.recarga = 0; finalizarRecarga(); } }
    var a = ARMAS[J.arma], st = armaEst[J.arma];
    if (demo && estado !== 'jogando') { /* o bot do menu troca de arma de tempos em tempos */
      S.estTempo += dt; if (S.estTempo > 7) { S.estTempo = 0; trocarArma(); }
    }
    var disparar = (IN.atirar || (gp.ativo && gp.fogo && !S.lojaAberta) || (demo && estado !== 'jogando' && alvo >= 0));
    if (disparar && J.trocaT <= 0 && J.recarga <= 0) {
      if (st.mag > 0 || demo) {
        if (J.fireCd <= 0) {
          atirar(J.ang);
          J.fireCd += 1 / (a.cad * MV.Meta.cadencia(MV.Meta.nivel('tiro')));
          if (J.fireCd < -0.05) J.fireCd = 0;
        }
      } else if (J.fireCd <= 0) {
        if (st.res > 0) iniciarRecarga(true); else { Som.vazio(); J.fireCd = 0.4; mostrarPrompt(null); mostrarAvisoCurto('SEM MUNIÇÃO · PEÇA REFORÇOS'); }
      }
    }
    if (J.fireCd < -0.1) J.fireCd = -0.1;

    /* regeneração de vida */
    if (!demo) {
      J.semDano += dt;
      if (J.semDano > dif.regenAtraso && J.vida < J.vidaMax) J.vida = Math.min(J.vidaMax, J.vida + dif.regen * dt);
    }
  }
  var ultimoAvisoCurto = 0;
  function mostrarAvisoCurto(t) {
    var agora = performance.now();
    if (agora - ultimoAvisoCurto < 1500) return;
    ultimoAvisoCurto = agora; mostrarAviso(t, '#ff6a70');
  }

  function atualizarEstacoes(dt) {
    var dentro = null;
    S.naArmaria = false;
    for (var i = 0; i < ESTACOES.length; i++) {
      var e = ESTACOES[i];
      if (e.cd > 0) e.cd -= dt;
      if (e.novo > 0) e.novo -= dt;
      if (hip(J.x - e.x, J.y - e.y) < e.r + 8) dentro = e;
    }
    if (!dentro || S.lojaAberta) { S.compra = 0; S.estacaoAtual = null; mostrarPrompt(null); return; }
    if (dentro.id === 'armaria') {
      S.naArmaria = true; S.estacaoAtual = dentro;
      mostrarPrompt(MV.Gamepad.ativo ? 'ARMARIA · PRESSIONE A OU VIEW' : 'ARMARIA · TOQUE EM LOJA (OU TECLA E)', false, 0);
      return;
    }
    if (S.estacaoAtual !== dentro) { S.estacaoAtual = dentro; S.compra = 0; }
    var e2 = dentro, desnecessario = false;
    if (e2.id === 'municao') {
      desnecessario = true;
      for (var k = 0; k < ARMAS.length; k++) if (S.possui[k] && !ARMAS[k].semRecarga && (armaEst[k].res < LIM[k].resMax || armaEst[k].mag < penteMax(k))) desnecessario = false;
    } else desnecessario = J.vida >= J.vidaMax - 0.5;
    if (e2.cd > 0) { mostrarPrompt(e2.nome + ' · REQUISITADO', false, 1); return; }
    if (desnecessario) { mostrarPrompt(e2.id === 'municao' ? 'ARSENAL COMPLETO' : 'INTEGRIDADE TOTAL', false, 0); S.compra = 0; return; }
    if (S.pontos < e2.custo) { mostrarPrompt('PONTOS INSUFICIENTES · ' + e2.nome + ' (' + fmtNum(e2.custo) + ')', true, 0); S.compra = 0; return; }
    S.compra += dt;
    mostrarPrompt('SEGURE PARA REQUISITAR · ' + e2.nome + ' (' + fmtNum(e2.custo) + ')', false, S.compra / 0.7);
    if (S.compra >= 0.7) {
      S.pontos -= e2.custo; S.compra = 0; e2.cd = 2;
      Som.compra();
      if (e2.id === 'municao') { reabastecer(); MV.Meta.inc('reabast'); mostrarAviso('REFORÇOS: MUNIÇÃO MÁXIMA', '#e8b630'); }
      else { J.vida = J.vidaMax; MV.Meta.inc('curas'); mostrarAviso('ATENDIMENTO MÉDICO CONCLUÍDO', '#a3d05c'); }
    }
  }
  function reabastecer() {
    for (var i = 0; i < ARMAS.length; i++) if (S.possui[i] && !ARMAS[i].semRecarga) { armaEst[i].mag = penteMax(i); armaEst[i].res = LIM[i].resMax; }   /* Mini Gun só enche na Armaria */
    J.recarga = 0; atualizarArmaHud(true);
  }

  function atualizarDrops(dt) {
    for (var i = S.drops.n - 1; i >= 0; i--) {
      var d = S.drops.a[i]; d.t += dt;
      if (d.t > 22) { S.drops.rem(i); continue; }
      if (!demo && estado === 'jogando') {                      /* ímã de itens: raio base 70 px (+35% com Inimigo do Perigo) */
        var dd = hip(J.x - d.x, J.y - d.y), rim = 70 * LEG.imaMult();
        if (dd < rim && dd > 1) { var vm = 120 + 220 * (1 - dd / rim); d.x += (J.x - d.x) / dd * vm * dt; d.y += (J.y - d.y) / dd * vm * dt; }
      }
      if (!demo && hip(J.x - d.x, J.y - d.y) < 30) {
        S.drops.rem(i); Som.coleta(); MV.Meta.inc('buffs'); LEG.inc('drops');
        if (d.tipo === 0) { reabastecer(); mostrarAviso('SUPRIMENTOS: MUNIÇÃO MÁXIMA', '#e8b630'); }
        else if (d.tipo === 1) { S.efeitos.insta = BUFF_TEMPO; sim.setInstaKill(1); mostrarAviso('MUNIÇÃO PERFURANTE: ABATE INSTANTÂNEO', '#ff5a5a'); }
        else if (d.tipo === 2) { S.efeitos.dobro = BUFF_TEMPO; mostrarAviso('RECOMPENSA EM DOBRO', '#5ee7ff'); }
        else if (d.tipo === 3) { J.escudo = ESCUDO_MAX; J.escudoT = ESCUDO_TEMPO; mostrarAviso('ESCUDO ATIVO · ABSORVE ' + ESCUDO_MAX + ' DE DANO', '#6fb6ff'); }
        else if (d.tipo === 4) { S.efeitos.fogo = BUFF_TEMPO; mostrarAviso('BALAS INCENDIÁRIAS', '#ff8a2a'); }
        else { S.efeitos.boom = BUFF_TEMPO; mostrarAviso('BALAS EXPLOSIVAS', '#ffd23a'); }
        if (DROPS[d.tipo].rar >= 2) { tremor.amp = Math.min(8, tremor.amp + 3); flutuante(J.x, J.y - 26, RARIDADES[DROPS[d.tipo].rar].nome, RARIDADES[DROPS[d.tipo].rar].cor, 18); }
      }
    }
    if (S.efeitos.insta > 0) { S.efeitos.insta -= dt; if (S.efeitos.insta <= 0) { S.efeitos.insta = 0; sim.setInstaKill(0); } }
    if (S.efeitos.dobro > 0) { S.efeitos.dobro = Math.max(0, S.efeitos.dobro - dt); }
    if (S.efeitos.fogo > 0) S.efeitos.fogo = Math.max(0, S.efeitos.fogo - dt);
    if (S.efeitos.boom > 0) S.efeitos.boom = Math.max(0, S.efeitos.boom - dt);
    if (J.escudoT > 0) { J.escudoT -= dt; if (J.escudoT <= 0) { J.escudo = 0; J.escudoT = 0; } }
  }

  function ganharPontos(n) { if (!demo) { var g = n * (S.efeitos.dobro > 0 ? 2 : 1); S.pontos += g; MV.Meta.inc('pontosTot', g); } }

  /* Processa os eventos da simulação. Explosões geradas aqui dentro (balas explosivas) acrescentam novos eventos (abates, acertos):
   * por isso há até 4 passadas, cada uma só sobre os eventos novos. */
  function processarEventos() {
    var n = sim.eventCount();
    if (!n && !blastN) return;
    var ini = 0, passadas = 0;
    for (var pe = 0; pe < n; pe++) { var oe = pe * ES; if (V.E[oe] === 7 && (V.E[oe + 5] | 0) === 2) { S.tGran = 0.35; S.multiT = 0.5; S.multiN = 0; } }
    do {
      procEv(ini, n);
      ini = n;
      if (blastN) { drenarBlasts(); n = sim.eventCount(); }
    } while (ini < n && ++passadas < 4);
    sim.clearEvents();
  }
  function procEv(ini, n) {
    var Ev = V.E;
    for (var i = ini; i < n; i++) {
      var o = i * ES, tipo = Ev[o], x = Ev[o + 1], y = Ev[o + 2], a = Ev[o + 3], b = Ev[o + 4], c = Ev[o + 5];
      if (tipo === 14) {                        /* acerto de BALA (c = índice do zumbi): balas incendiárias / explosivas */
        if (!demo) {
          var zi14 = c | 0, tg14 = Ev[o + 7] | 0, zo14 = zi14 * ZS;
          S.acertos++;
          if (S.perk.gelo > 0 && V.Z[zo14] > 0.5 && Math.random() < Math.min(0.6, 0.15 + 0.08 * (S.perk.gelo - 1))) {       /* Tiros Congelantes: 40% mais lento por 2 s */
            sim.slowZ(zi14, 2);
            for (var kg = 0; kg < 5; kg++) particula(8, x, y, rand(-70, 70), rand(-70, 70), rand(0.3, 0.6), rand(1.5, 3));
          }
          if (ehTiro(tg14) && V.Z[zo14] > 0.5) {                                                                              /* ainda vivo: crítico ou arma pesada pode arrancar um membro */
            var w14 = armaDaTag(tg14), crit14 = (tg14 & 32) !== 0, pesada = w14 >= 0 && ARMAS[w14] && HEAVY_IDS[ARMAS[w14].id];
            if (crit14 || pesada) tentarMembro(zi14, (w14 >= 0 ? ARMAS[w14].dano : 20) * (crit14 ? 2 : 1), false, V.Z[zo14 + 1] - J.x, V.Z[zo14 + 2] - J.y);
          }
          if (S.efeitos.fogo > 0) acender(c | 0, 4);
          if (S.efeitos.boom > 0 && S.boomN < 5) { S.boomN++; enfileirarBlast(x, y, 62, 38, 22); }
        }
      } else if (tipo === 13) {                 /* molotov caiu: zona de fogo */
        zonaFogo(x, y, a, MOLOTOV.dur);
      } else if (tipo === 1) {                  /* acerto */
        ganharPontos(PONTOS_ACERTO);
        sangue(x, y, a, b, 3, 160);
        var zi1 = Ev[o + 6] | 0, tg1 = Ev[o + 7] | 0;
        jorroSangue(x, y, a, b, tg1 === 100 ? 1.2 : 0.35, zi1 >= 0 && zi1 < MAXZ ? (V.Z[zi1 * ZS + 11] | 0) : 0);
        if (!demo && tg1 === 100 && zi1 >= 0 && zi1 < MAXZ) tentarMembro(zi1, 0, true, V.Z[zi1 * ZS + 1] - x, V.Z[zi1 * ZS + 2] - y);   /* explosão: sempre pode mutilar */
        Som.acerto();
      } else if (tipo === 2) {                  /* abate */
        var tz = c | 0, zi2 = Ev[o + 6] | 0, tag2 = Ev[o + 7] | 0, auto2 = tag2 === 102;     /* auto2: Bomber que se autodetonou (sem crédito) */
        var pts = auto2 ? 0 : Math.round(TIPOS[tz].pts * ((!demo && LEG.pesadeloAtivo()) ? 1.5 : 1)), grande = tz === 2 || tz === 4;
        var zo2 = zi2 * ZS, mk2 = (zi2 >= 0 && zi2 < MAXZ) ? (V.Z[zo2 + 27] | 0) : 0, rr2 = (zi2 >= 0 && zi2 < MAXZ) ? V.Z[zo2 + 6] : TIPOS[tz].raio;
        if (pts) ganharPontos(pts);
        if (!demo && !auto2) {
          registrarAbate(tz);
          S.abates++; LEG.inc('abates'); ganharXpRun(tz);
          var w2 = armaDaTag(tag2);
          if (w2 >= 0 && !S.armasKill[w2]) { S.armasKill[w2] = 1; if (++S.nArmasKill >= 4) LEG.marcar('a3'); }
          flutuante(x, y, '+' + pts * (S.efeitos.dobro > 0 ? 2 : 1), S.efeitos.dobro > 0 ? '#5ee7ff' : '#e8b630', grande ? 24 : 17);
        }
        sangue(x, y, a, b, tz === 4 ? 40 : (grande ? 22 : 14), tz === 4 ? 300 : 230);
        if (!auto2) {
          var rot2 = (zi2 >= 0 && zi2 < MAXZ) ? angVisZ[zi2] : rand(0, TAU), perd = gorarMorte(x, y, tz, rr2, mk2, tag2, a, b);
          jorroSangue(x, y, a, b, tz === 4 ? 2 : (grande ? 1.4 : 1) + (perd ? 0.5 : 0), tz);
          mancha(x, y, tz === 4 ? 70 : (grande ? 40 : 26), 0.55);
          if (tz === 6) { var bc = pCadBomb.add(); bc.x = x; bc.y = y; bc.rot = rot2; bc.t = 0; bc.esc = rr2 / 14; }      /* Bomber morto: o pavio continua aceso até explodir */
          else if (!(tag2 === 100 && ((perd & 1 ? 1 : 0) + (perd & 2 ? 1 : 0) + (perd & 4 ? 1 : 0) + (perd & 8 ? 1 : 0)) >= 3)) assarCadaver(x, y, tz, mk2 | perd, rot2, rr2, grande ? 1.7 : 1.15);
          else Gore.poca(goreG(), x, y, rr2 * 2.2, Gore.corSangue(tz), 0.6);
        }
        Som.morte(tz);
        if (tz === 4) { tremor.amp = Math.min(10, tremor.amp + 5); if (!demo) mostrarAviso('TANQUE ELIMINADO', '#a3d05c'); }
        if (!demo && !auto2 && (tz === 4 || S.drops.n < 3) && Math.random() < Math.min(1, dif.drop * DROP_CHANCE_TIPO[tz] * LEG.dropMult())) {
          var dr = S.drops.add(); dr.x = x; dr.y = y; dr.tipo = tz === 4 ? 0 : sortearDrop(tz); dr.t = 0;       /* o chefe sempre deixa suprimentos... */
          if (tz === 4) { var dr2 = S.drops.add(); dr2.x = x + 30; dr2.y = y + 6; dr2.tipo = sortearDrop(tz); dr2.t = 0; }   /* ...e um item sorteado com bônus de raridade */
        }
      } else if (tipo === 3) {                  /* infectado acertou o jogador */
        if (!demo || estado === 'jogando') danoNoJogador(a, x, y, c | 0);
      } else if (tipo === 5) {                  /* corredor se preparando para o bote */
        Som.chiado();
        if (!demo) flutuante(x, y - 14, '!', '#ffd23a', 26);
      } else if (tipo === 6) {                  /* explosão tóxica */
        explosaoToxica(x, y, a);
      } else if (tipo === 7) {                  /* explosão pesada: leitão (c=1) ou granada (c=2) */
        if ((c | 0) === 2) S.tGran = 0.35;
        explosaoPesada(x, y, a, c | 0);
      } else if (tipo === 9) {                  /* cuspe ácido do tóxico caiu: nuvem de gás no ponto */
        Som.cuspe();
        novaNuvem(x, y, a, 4.0);
        for (var kc = 0; kc < 10; kc++) particula(6, x, y, rand(-90, 90), rand(-90, 90), rand(0.6, 1.3), rand(7, 14));
        mancha(x, y, 30, 0.3);
      } else if (tipo === 10) {                 /* rugido do tanque em fúria: onda vermelha e bônus de velocidade na horda */
        Som.rugido();
        var fr = S.fx.add(); fr.x = x; fr.y = y; fr.r = a; fr.t = 0; fr.max = 0.9; fr.tp = 3;
        tremor.amp = Math.min(16, tremor.amp + 9);
        if (!demo) mostrarAviso('TANQUE EM FÚRIA', '#ff2a2a');
        MV.Gamepad.vibrar(0.4, 0.4, 0.9);
      } else if (tipo === 11) {                 /* insano: comum ESQUIVOU do tiro */
        flutuante(x, y - 8, 'ESQUIVOU', '#9fd6ff', 13);
        Som.esquiva();
        for (var ke = 0; ke < 4; ke++) particula(3, x, y, rand(-70, 70), rand(-70, 70), rand(0.2, 0.4), rand(1.2, 2.4));
      } else if (tipo === 12) {                 /* insano: comum se AUTOCUROU */
        flutuante(x, y - 8, '+VIDA', '#7dff7a', 13);
        for (var kh = 0; kh < 3; kh++) particula(6, x, y, rand(-20, 20), rand(-45, -15), rand(0.4, 0.8), rand(4, 8));
      } else if (tipo === 15) {                 /* Bomber explodiu (a = raio) */
        explosaoBomber(x, y, a);
      } else if (tipo === 16) {                 /* pavio do Bomber aceso (a = tempo) */
        Som.pavio();
        if (!demo) flutuante(x, y - 16, '!!', '#ff4a2a', 26);
      } else if (tipo === 17) {                 /* Bruto: pancada em área (a = raio, c = dano) */
        golpeBruto(x, y, a, c);
      } else if (tipo === 8) {                  /* quique da granada */
        Som.quique();
        for (var kq = 0; kq < 3; kq++) particula(3, x, y, rand(-60, 60), rand(-60, 60), rand(0.2, 0.4), rand(1.2, 2.2));
      } else if (tipo === 4) {                  /* bala na parede */
        for (var k = 0; k < 4; k++) particula(2, x, y, -a * rand(40, 150) + rand(-80, 80), -b * rand(40, 150) + rand(-80, 80), rand(0.12, 0.3), 1.6);
        if (!demo) {
          danificarBarrilEm(x, y, 16);                                           /* barris de gasolina levam tiros */
          if (S.efeitos.boom > 0 && S.boomN < 5) { S.boomN++; enfileirarBlast(x, y, 62, 38, 22); }
        }
      }
    }
  }

  /* explosão do lança-porcos / granada: o dano em área nos zumbis já foi aplicado no WASM; aqui ficam os efeitos e o dano ao jogador */
  function explosaoPesada(x, y, raio, tp) {
    var grande = tp === 1;
    Som.explosaoPesada(tp);
    var d = hip(J.x - x, J.y - y), prox = clamp(1 - d / 900, 0.25, 1);
    tremor.amp = Math.min(22, tremor.amp + (grande ? 16 : 10) * prox);
    var fxo = S.fx.add(); fxo.x = x; fxo.y = y; fxo.r = raio; fxo.t = 0; fxo.max = grande ? 0.75 : 0.55; fxo.tp = tp;
    var i;
    for (i = 0; i < 26; i++) { var a1 = rand(0, TAU), v1 = rand(120, grande ? 460 : 380); particula(2, x, y, Math.cos(a1) * v1, Math.sin(a1) * v1, rand(0.2, 0.55), rand(2, 4)); }
    for (i = 0; i < 16; i++) { var a2 = rand(0, TAU), v2 = rand(30, 190); particula(5, x, y, Math.cos(a2) * v2, Math.sin(a2) * v2, rand(0.9, 1.8), rand(7, 15)); }
    for (i = 0; i < 18; i++) { var a3 = rand(0, TAU), v3 = rand(80, 340); particula(3, x, y, Math.cos(a3) * v3, Math.sin(a3) * v3, rand(0.4, 0.9), rand(2, 4.5)); }
    if (grande) for (i = 0; i < 16; i++) { var a4 = rand(0, TAU), v4 = rand(120, 420); particula(1, x, y, Math.cos(a4) * v4, Math.sin(a4) * v4, rand(0.45, 0.95), rand(3, 6)); }
    queimadura(x, y, raio * (grande ? 0.85 : 0.7));
    if (grande) mancha(x, y, 60, 0.5);
    if (!demo) danoBarrisArea(x, y, raio, 100);
    if (estado === 'jogando' && !demo && d < raio + 10) {
      var f = 1 - d / (raio + 10);
      danoNoJogador(Math.round((grande ? 55 : 45) * f * dif.dano) + 4, x, y, 6);
      var l = d || 1; J.empX = (J.x - x) / l * 520 * f; J.empY = (J.y - y) / l * 520 * f; J.empT = 0.18;
    }
    MV.Gamepad.vibrar(grande ? 0.55 : 0.4, 0.6 * prox, 1.0 * prox);
    if (prox > 0.3) vibrarTela(grande ? [60, 30, 40] : 45);
  }
  /* Bomber: explosão grande. O dano nos outros infectados já foi aplicado no WASM (areaDamage); aqui: efeitos, estilhaços do corpo e dano ao jogador */
  function explosaoBomber(x, y, raio) {
    Som.explosaoPesada(2);
    var d = hip(J.x - x, J.y - y), prox = clamp(1 - d / 900, 0.25, 1), i;
    tremor.amp = Math.min(20, tremor.amp + 11 * prox);
    var fxo = S.fx.add(); fxo.x = x; fxo.y = y; fxo.r = raio; fxo.t = 0; fxo.max = 0.55; fxo.tp = 2;
    for (i = 0; i < 22; i++) { var a1 = rand(0, TAU), v1 = rand(120, 380); particula(2, x, y, Math.cos(a1) * v1, Math.sin(a1) * v1, rand(0.2, 0.5), rand(2, 4)); }
    for (i = 0; i < 12; i++) { var a2 = rand(0, TAU), v2 = rand(30, 190); particula(5, x, y, Math.cos(a2) * v2, Math.sin(a2) * v2, rand(0.9, 1.7), rand(7, 14)); }
    for (i = 0; i < 20; i++) { var a3 = rand(0, TAU), v3 = rand(90, 360); particula(1, x, y, Math.cos(a3) * v3, Math.sin(a3) * v3, rand(0.4, 0.9), rand(2, 4.5)); }
    queimadura(x, y, raio * 0.7); mancha(x, y, 56, 0.55);
    for (i = pCadBomb.n - 1; i >= 0; i--) if (hip(pCadBomb.a[i].x - x, pCadBomb.a[i].y - y) < 10) { pCadBomb.rem(i); break; }      /* o corpo se desfaz em pedaços */
    var ps = [0, 1, 2, 3];
    for (i = 0; i < 4; i++) { var aa = rand(0, TAU), vv = rand(220, 460); novaParte(ps[i], 6, x, y, Math.cos(aa) * vv, Math.sin(aa) * vv, 1); }
    jorroSangue(x, y, 1, 0, 2, 6); jorroSangue(x, y, -1, 0.3, 1.6, 6);
    if (!demo) danoBarrisArea(x, y, raio, 100);
    if (estado === 'jogando' && !demo && d < raio + 10) {
      var f = 1 - d / (raio + 10);
      danoNoJogador(Math.round(52 * f * dif.dano) + 4, x, y, 6);
      var l = d || 1; J.empX = (J.x - x) / l * 520 * f; J.empY = (J.y - y) / l * 520 * f; J.empT = 0.18;
    }
    MV.Gamepad.vibrar(0.5, 0.6 * prox, 1.0 * prox);
    if (prox > 0.3) vibrarTela([50, 25, 40]);
  }
  /* Bruto: pancada em área (anel de poeira + tremor); o jogador só leva se estiver dentro do raio */
  function golpeBruto(x, y, raio, dano) {
    Som.golpe();
    var fr = S.fx.add(); fr.x = x; fr.y = y; fr.r = raio; fr.t = 0; fr.max = 0.42; fr.tp = 3;
    for (var i = 0; i < 12; i++) { var a = rand(0, TAU), v = rand(60, 200); particula(3, x + Math.cos(a) * raio * 0.5, y + Math.sin(a) * raio * 0.5, Math.cos(a) * v, Math.sin(a) * v, rand(0.3, 0.6), rand(1.4, 3)); }
    var d = hip(J.x - x, J.y - y);
    tremor.amp = Math.min(14, tremor.amp + 4 * clamp(1 - d / 500, 0.2, 1));
    if (estado === 'jogando' && !demo && d < raio + 14) danoNoJogador(dano, x, y, 2);
  }
  function queimadura(x, y, r) {
    var g = decalCtx; g.save(); g.scale(0.5, 0.5);
    var gr = g.createRadialGradient(x, y, r * 0.1, x, y, r);
    gr.addColorStop(0, 'rgba(8,6,4,.78)'); gr.addColorStop(0.6, 'rgba(14,10,6,.45)'); gr.addColorStop(1, 'rgba(14,10,6,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); g.restore();
  }

  /* nuvem tóxica: a explosão em si (dano nos outros infectados) já foi calculada no WASM; aqui ficam os efeitos e o dano ao jogador */
  function explosaoToxica(x, y, raio) {
    Som.explosao();
    tremor.amp = Math.min(12, tremor.amp + 6);
    for (var i = 0; i < 26; i++) {
      var a = rand(0, TAU), v = rand(40, 200);
      particula(6, x, y, Math.cos(a) * v, Math.sin(a) * v, rand(1.1, 2.4), rand(10, 22));
    }
    for (i = 0; i < 12; i++) { var b = rand(0, TAU), w = rand(80, 260); particula(2, x, y, Math.cos(b) * w, Math.sin(b) * w, rand(0.15, 0.4), 2); }
    mancha(x, y, 46, 0.35);
    novaNuvem(x, y, raio * 0.95, 5.5);
    if (estado === 'jogando') {
      var d = hip(J.x - x, J.y - y);
      if (d < raio + 12) danoNoJogador(Math.round(34 * dif.dano * (1 - 0.6 * Math.min(1, d / (raio + 12)))), x, y, 5);
    }
  }
  /* rastro de fumaça/faísca dos leitões e brilho das explosões */
  function atualizarProjeteis(dt) {
    var Gv = V.G;
    for (var i = 0; i < MAXG; i++) {
      var o = i * GS;
      if (Gv[o] < 0.5) continue;
      if (Gv[o + 8] === 1) {
        particula(5, Gv[o + 1] - Gv[o + 3] * 0.012, Gv[o + 2] - Gv[o + 4] * 0.012, rand(-18, 18), rand(-18, 18), rand(0.35, 0.7), rand(3, 6));
        if (Math.random() < 0.7) particula(2, Gv[o + 1], Gv[o + 2], -Gv[o + 3] * 0.1 + rand(-50, 50), -Gv[o + 4] * 0.1 + rand(-50, 50), rand(0.12, 0.28), rand(2, 3));
      } else if (Gv[o + 8] === 4) {
        if (Math.random() < dt * 50) particula(7, Gv[o + 1], Gv[o + 2] - Gv[o + 5] * 0.5, rand(-20, 20), rand(-20, 20), rand(0.2, 0.4), rand(2.5, 4));
      } else if (Gv[o + 8] === 3) {
        if (Math.random() < dt * 30) particula(6, Gv[o + 1], Gv[o + 2] - Gv[o + 5] * 0.5, rand(-12, 12), rand(-12, 12), 0.5, 4);
      } else if (Math.random() < dt * 20) {
        particula(5, Gv[o + 1], Gv[o + 2] - Gv[o + 5] * 0.35, rand(-10, 10), rand(-20, -6), 0.4, 3);
      }
    }
    for (var k = S.fx.n - 1; k >= 0; k--) { S.fx.a[k].t += dt; if (S.fx.a[k].t >= S.fx.a[k].max) S.fx.rem(k); }
  }
  function novaNuvem(x, y, r, dur) { var n = S.nuvens.add(); n.x = x; n.y = y; n.r = r; n.t = dur; n.max = dur; n.fase = rand(0, TAU); }
  function atualizarNuvens(dt) {
    var dentro = false;
    for (var i = S.nuvens.n - 1; i >= 0; i--) {
      var n = S.nuvens.a[i]; n.t -= dt;
      if (n.t <= 0) { S.nuvens.rem(i); continue; }
      if (Math.random() < dt * 9) { var a = rand(0, TAU), rr = rand(0, n.r * 0.85); particula(6, n.x + Math.cos(a) * rr, n.y + Math.sin(a) * rr, rand(-14, 14), rand(-22, -6), rand(1.2, 2), rand(9, 18)); }
      if (estado === 'jogando' && hip(J.x - n.x, J.y - n.y) < n.r) dentro = true;
    }
    if (S.noRastro) dentro = true;                       /* pisando no rastro tóxico também intoxica */
    if (dentro) {
      S.gas = Math.min(1, S.gas + dt * 3);
      danoDireto(9 * dif.dano * dt);
    } else S.gas = Math.max(0, S.gas - dt * 1.5);
  }

  /* escudo: absorve dano antes da vida. Devolve o dano que sobrou (0 se o escudo absorveu tudo) */
  function absorverEscudo(d) {
    if (J.escudo <= 0 || d <= 0) return d;
    var a = Math.min(J.escudo, d);
    J.escudo -= a; S.escudoFx = 0.3;
    if (J.escudo <= 0) { J.escudo = 0; J.escudoT = 0; mostrarAviso('ESCUDO ROMPIDO', '#6fb6ff'); }
    return d - a;
  }
  /* dano contínuo (fogo, gás, rastro): passa pelo escudo e não gera empurrão/gemido */
  function vidaInfinita() { var M = MV.Meta; return dif.id === 'insano' ? M.tem('r10') : M.tem('r09'); }
  function danoDireto(d) {
    if (estado !== 'jogando' || demo) return;
    d = absorverEscudo(d * MV.Meta.danoRecebido(MV.Meta.nivel('forca')));
    if (d <= 0) return;
    S.limpa = false; MV.Meta.ganharXp('forca', d * 0.15);
    if (vidaInfinita()) return;
    J.vida -= d; J.semDano = 0;
    if (J.vida <= 0) { J.vida = 0; fimDeJogo(); }
  }
  function danoNoJogador(d, x, y, tipo) {
    if (estado !== 'jogando') return;
    var bruto = d, nF = MV.Meta.nivel('forca');
    d = absorverEscudo(d * MV.Meta.danoRecebido(nF));
    S.limpa = false; MV.Meta.ganharXp('forca', bruto * 0.5);
    if (!vidaInfinita()) { J.vida -= d; J.semDano = 0; }
    S.dano = d > 0 ? 1 : 0.35;
    aplicarTensao(bruto, d);
    if (nF > 1) empurrarHorda(70 + nF * 8, 14 + (nF - 1) * 5);          /* Força: o golpe sofrido empurra a horda ao redor */
    if (S.lojaAberta) { fecharLoja(); mostrarAviso('ARMARIA FECHADA: SOB ATAQUE', '#ff6a70'); }
    MV.Gamepad.vibrar(0.18, 0.5, 0.8);
    tremor.amp = Math.min(14, tremor.amp + (tipo === 4 ? 11 : 7));
    if (tipo === 4 || tipo === 3 || tipo === 2) {                 /* empurrão: tanque forte, bruto médio, corredor leve */
      var dx = J.x - x, dy = J.y - y, l = hip(dx, dy) || 1, f = tipo === 4 ? 620 : (tipo === 2 ? 430 : 300);
      J.empX = dx / l * f; J.empY = dy / l * f; J.empT = tipo === 4 ? 0.22 : (tipo === 2 ? 0.16 : 0.12);
    }
    Som.golpe(); Som.tensao(Math.min(1, 0.4 + bruto / 60));
    if (d > 0) sangue(J.x, J.y, J.x - x, J.y - y, 6, 150);
    vibrarTela(35);
    if (J.vida <= 0) { J.vida = 0; fimDeJogo(); }
  }
  /* empurra para longe do jogador os infectados num raio (kb em unidades de mundo; tanque quase não se move) */
  function empurrarHorda(raio, kb) {
    var Zv = V.Z;
    for (var i = 0; i < MAXZ; i++) {
      var o = i * ZS; if (Zv[o] < 0.5) continue;
      var dx = Zv[o + 1] - J.x, dy = Zv[o + 2] - J.y, d = hip(dx, dy);
      if (d >= raio || d < 1e-3) continue;
      var f = kb * (1 - d / raio) * ((Zv[o + 11] | 0) === 4 ? 0.2 : 1);
      Zv[o + 1] += dx / d * f; Zv[o + 2] += dy / d * f;
    }
  }
  /* efeitos de ansiedade ao ser ferido: vinheta que pulsa como batimento, distorção do quadro, tremor forte */
  function aplicarTensao(bruto, d) {
    S.tens = Math.max(S.tens || 0, Math.min(4.5, 2.2 + bruto / 25));
    tremor.amp = Math.min(20, tremor.amp + 6 + Math.min(8, bruto / 8));
    if (cv) { cv.classList.remove('distorce'); void cv.offsetWidth; cv.classList.add('distorce'); }
  }

  function atualizarRodadas(dt) {
    if (demo && estado !== 'jogando') {
      S.tSpawn -= dt;
      if (S.tSpawn <= 0) { S.tSpawn = 0.8; if (sim.aliveCount() < 9) gerarZumbi(6); }
      return;
    }
    var vivos = sim.aliveCount();
    if (S.fase === 'ativa') {
      S.tSpawn -= dt;
      /* spawn fracionado (time-slicing): no máximo 2 criações por quadro; o atraso acumulado (quadro longo) é pago nos quadros seguintes */
      for (var orc = 0, nv = vivos; orc < 2 && S.aSpawnar > 0 && S.tSpawn <= 0 && nv < limiteVivos(S.rodada) + (S.gatilhos.length ? 4 : 0); orc++) {
        var tanque = S.gatilhos.length && S.aSpawnar <= S.inicial * S.gatilhos[0];
        if (tanque) S.gatilhos.shift();
        /* insano: os especiais garantidos entram espalhados (≈ a cada 4º spawn, e os que sobrarem nos últimos spawns) */
        var forcado = tanque ? 4 : undefined;
        if (forcado === undefined && S.espFila && S.espFila.length && (S.aSpawnar <= S.espFila.length || (S.aSpawnar % 4 === 0))) forcado = S.espFila.shift();
        if (gerarZumbi(S.rodada, forcado)) { S.aSpawnar--; nv++; } else if (forcado !== undefined && forcado !== 4 && S.espFila) S.espFila.unshift(forcado);
        S.tSpawn += intervaloSpawn(S.rodada);
      }
      if (S.tSpawn < -0.5) S.tSpawn = -0.5;
      if (S.aSpawnar === 0 && vivos === 0) terminarRodada();
    } else if (S.fase === 'intervalo') {
      S.tFase -= dt;
      if (S.tFase <= 0) iniciarRodada(S.rodada + 1);
    }
    /* faixa de status: contagem entre rodadas */
    var faixaTxt = S.fase === 'intervalo' ? 'SETOR LIMPO · PRÓXIMA ONDA EM ' + Math.max(0, Math.ceil(S.tFase)) + 's' : '';
    if (avisoHud.faixa !== faixaTxt) { avisoHud.faixa = faixaTxt; el.faixa.textContent = faixaTxt; el.faixa.hidden = !faixaTxt; }
    /* grunhidos ambientes */
    S.grunhido -= dt;
    if (S.grunhido <= 0 && vivos > 0) {
      S.grunhido = rand(1.2, 3);
      var Zv = V.Z, melhor = 99999;
      for (var i = 0; i < MAXZ; i++) { var o = i * ZS; if (Zv[o] > 0.5) { var d = hip(Zv[o + 1] - J.x, Zv[o + 2] - J.y); if (d < melhor) melhor = d; } }
      if (melhor < 700) Som.grunhido(clamp(1 - melhor / 750, 0.2, 1));
    }
  }

  /* Tremor de câmera suave: soma de senos em baixa frequência, em vez de um número aleatório novo a cada quadro.
   * O sorteio por quadro parecia "chuvisco" (a imagem pulava de posição 60 vezes por segundo, ao atirar e ao tomar dano). */
  function atualizarTremor(dt) {
    tremor.amp = Math.max(0, tremor.amp - 14 * dt);
    tremor.fase = (tremor.fase || 0) + dt;
    var f = tremor.fase * 26;
    var ks = cfg.shake / 100;                               /* intensidade configurável (0–150%) */
    tremor.x = ks * tremor.amp * (Math.sin(f) * 0.6 + Math.sin(f * 2.31 + 1.7) * 0.4);
    tremor.y = ks * tremor.amp * (Math.cos(f * 1.13 + 0.4) * 0.6 + Math.sin(f * 1.87 + 3.1) * 0.4);
  }
  function atualizar(dt) {
    S.t += dt; S.dtVis = dt;
    if (estado === 'jogando') S.tempo += dt;
    atualizarJogador(dt);
    if (estado === 'jogando') { atualizarEstacoes(dt); atualizarDrops(dt); atualizarExtras(dt); atualizarNuvens(dt); }
    else if (S.nuvens.n) atualizarNuvens(dt);
    atualizarRodadas(dt);
    sim.setPlayer(J.x, J.y, 14);
    /* pressão do jogador (recarregando, sem munição ou ferido): a IA difícil ataca nesses momentos */
    var pres = 0.1;
    if (!demo) {
      var stA = armaEst[J.arma];
      if (J.recarga > 0 || stA.mag === 0) pres = 0.8; else if (J.vida < J.vidaMax * 0.4) pres = 0.7; else if (J.vida < J.vidaMax * 0.7) pres = 0.4;
    }
    sim.setPlayerState(Math.cos(J.ang), Math.sin(J.ang), pres);
    var t0 = performance.now();
    sim.update(dt);
    perf.simAcc += performance.now() - t0; perf.simN++;
    if (perf.simN >= 30) { perf.sim = perf.simAcc / perf.simN; perf.simAcc = 0; perf.simN = 0; }
    processarEventos();
    atualizarGore(dt);
    atualizarPerks(dt);
    bombearToast(dt);
    atualizarProjeteis(dt);
    atualizarParticulas(dt);
    if (S.dano > 0) S.dano = Math.max(0, S.dano - dt * 1.6);
    if (S.tens > 0) S.tens = Math.max(0, S.tens - dt);
    if (estado === 'jogando' && !demo) atualizarMeta(dt);
    atualizarTremor(dt);
    for (var i = 0; i < JANELAS.length; i++) if (JANELAS[i].brilho > 0) JANELAS[i].brilho -= dt * 1.5;
    /* batimentos com pouca vida */
    if (estado === 'jogando' && J.vida < 30) { S.batida -= dt; if (S.batida <= 0) { S.batida = 0.9; Som.batida(); } }
    /* câmera */
    var k = 1 - Math.exp(-9 * dt);
    cam.x += (J.x - cam.x) * k; cam.y += (J.y - cam.y) * k;
    var vw = view.w / view.zoom, vh = view.h / view.zoom;
    cam.x = vw >= MUNDO.w ? MUNDO.w / 2 : clamp(cam.x, vw / 2, MUNDO.w - vw / 2);
    cam.y = vh >= MUNDO.h ? MUNDO.h / 2 : clamp(cam.y, vh / 2, MUNDO.h - vh / 2);
    if (estado === 'jogando') {
      atualizarHud();
      if (S.dica > 0) { S.dica -= dt; if (S.dica <= 0) { el.dica.style.opacity = '0'; setTimeout(function () { el.dica.hidden = true; }, 700); } }
    }
  }

  /* =====================  RENDERIZAÇÃO  ===================== */
  var COR_OBST = {
    concreto: { base: '#454b4d', topo: '#5a6164', borda: '#2a2f31' },
    container: { base: '#6e2c28', topo: '#843a34', borda: '#3a1513' },
    caixote: { base: '#5b4429', topo: '#725533', borda: '#2f2112' },
    carro: { base: '#4a4f45', topo: '#5c6256', borda: '#1f231d' },
    sacos: { base: '#6b5d3e', topo: '#85744c', borda: '#3a3220' }
  };
  function desenharObstaculos() {
    var i, o, c;
    ctx.fillStyle = 'rgba(0,0,0,.38)';
    for (i = 0; i < OBST.length; i++) { o = OBST[i]; ctx.fillRect(o.x + 7, o.y + 9, o.w, o.h); }
    for (i = 0; i < OBST.length; i++) {
      o = OBST[i]; c = COR_OBST[o.t];
      ctx.fillStyle = c.base; ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = c.topo; ctx.fillRect(o.x + 4, o.y + 4, o.w - 8, o.h - 8);
      ctx.strokeStyle = c.borda; ctx.lineWidth = 2; ctx.strokeRect(o.x + 1, o.y + 1, o.w - 2, o.h - 2);
      ctx.beginPath();
      if (o.t === 'container') {
        var horiz = o.w >= o.h;
        for (var k = 12; k < (horiz ? o.w : o.h) - 6; k += 14) { if (horiz) { ctx.moveTo(o.x + k, o.y + 5); ctx.lineTo(o.x + k, o.y + o.h - 5); } else { ctx.moveTo(o.x + 5, o.y + k); ctx.lineTo(o.x + o.w - 5, o.y + k); } }
        ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(o.x + 4, o.y + 4, o.w - 8, 4);
      } else if (o.t === 'caixote') {
        ctx.moveTo(o.x + 6, o.y + 6); ctx.lineTo(o.x + o.w - 6, o.y + o.h - 6); ctx.moveTo(o.x + o.w - 6, o.y + 6); ctx.lineTo(o.x + 6, o.y + o.h - 6);
        ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3; ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 2; ctx.strokeRect(o.x + 7, o.y + 7, o.w - 14, o.h - 14);
      } else if (o.t === 'carro') {                         /* carcaça de carro vista de cima: capô, para-brisas, rodas, ferrugem */
        ctx.save(); ctx.translate(o.x + o.w / 2, o.y + o.h / 2);
        var hz = o.w >= o.h; if (!hz) ctx.rotate(Math.PI / 2);
        var L = Math.max(o.w, o.h), W = Math.min(o.w, o.h);
        ctx.fillStyle = '#1a1d19'; ctx.fillRect(-L * 0.36, -W / 2 - 3, 22, 7); ctx.fillRect(L * 0.18, -W / 2 - 3, 22, 7); ctx.fillRect(-L * 0.36, W / 2 - 4, 22, 7); ctx.fillRect(L * 0.18, W / 2 - 4, 22, 7);
        ctx.fillStyle = '#6a6f62'; ctx.fillRect(-L / 2 + 5, -W / 2 + 5, L - 10, W - 10);
        ctx.fillStyle = '#1b2623'; ctx.fillRect(L * 0.08, -W / 2 + 9, L * 0.22, W - 18); ctx.fillRect(-L * 0.34, -W / 2 + 9, L * 0.16, W - 18);
        ctx.strokeStyle = 'rgba(200,230,220,.35)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(L * 0.1, -W / 2 + 12); ctx.lineTo(L * 0.22, W / 2 - 14); ctx.moveTo(L * 0.18, -W / 2 + 10); ctx.lineTo(L * 0.14, 0); ctx.stroke();
        ctx.fillStyle = 'rgba(120,52,20,.55)'; ctx.beginPath(); ctx.ellipse(-L * 0.12, -W * 0.18, 16, 9, 0.4, 0, TAU); ctx.ellipse(L * 0.38, W * 0.2, 12, 7, -0.3, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(L * 0.32, -W / 2 + 5); ctx.lineTo(L * 0.32, W / 2 - 5); ctx.moveTo(-L * 0.2, -W / 2 + 5); ctx.lineTo(-L * 0.2, W / 2 - 5); ctx.stroke();
        ctx.restore();
      } else if (o.t === 'sacos') {                         /* sacos de areia empilhados */
        var hs = o.w >= o.h, nb = Math.floor((hs ? o.w : o.h) / 26);
        for (var sb = 0; sb < nb; sb++) for (var fila = 0; fila < 2; fila++) {
          var bx = hs ? o.x + 4 + sb * 26 + (fila ? 10 : 0) : o.x + 4 + fila * 22, by = hs ? o.y + 4 + fila * 22 : o.y + 4 + sb * 26 + (fila ? 10 : 0);
          ctx.fillStyle = (sb + fila) % 2 ? '#8a7a52' : '#7a6c46'; ctx.strokeStyle = 'rgba(30,24,12,.7)'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.ellipse(bx + 12, by + 10, 12, 9, 0, 0, TAU); ctx.fill(); ctx.stroke();
          ctx.strokeStyle = 'rgba(30,24,12,.35)'; ctx.beginPath(); ctx.moveTo(bx + 5, by + 10); ctx.lineTo(bx + 19, by + 10); ctx.stroke();
        }
      } else {
        var h2 = o.w >= o.h;
        for (var q = 20; q < (h2 ? o.w : o.h) - 10; q += 40) { if (h2) { ctx.moveTo(o.x + q, o.y + 4); ctx.lineTo(o.x + q, o.y + o.h - 4); } else { ctx.moveTo(o.x + 4, o.y + q); ctx.lineTo(o.x + o.w - 4, o.y + q); } }
        ctx.strokeStyle = 'rgba(0,0,0,.25)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(o.x + 4, o.y + 4, o.w - 8, 3);
      }
    }
  }

  /* adereços decorativos (camada estática, desenhados uma vez): variações geradas por semente `v` de cada item */
  function desenharProps() {
    for (var i = 0; i < PROPS.length; i++) {
      var p = PROPS[i], sd = p.v || 1;
      function rn() { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.scale(p.s, p.s);
      var k;
      if (p.t === 'pneus') {
        for (k = 0; k < 3; k++) {
          var ox = k * 9 - 9 + rn() * 3, oy = (k % 2) * 9 - 4;
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(ox + 2, oy + 3, 10, 0, TAU); ctx.fill();
          ctx.fillStyle = '#15171a'; ctx.beginPath(); ctx.arc(ox, oy, 10, 0, TAU); ctx.fill();
          ctx.fillStyle = '#3a3d41'; ctx.beginPath(); ctx.arc(ox, oy, 5.4, 0, TAU); ctx.fill();
          ctx.fillStyle = '#0c0d0f'; ctx.beginPath(); ctx.arc(ox, oy, 3.2, 0, TAU); ctx.fill();
        }
      } else if (p.t === 'poca') {
        ctx.fillStyle = 'rgba(6,8,8,.55)';
        for (k = 0; k < 4; k++) { ctx.beginPath(); ctx.ellipse(rn() * 14 - 7, rn() * 10 - 5, 8 + rn() * 14, 5 + rn() * 8, rn() * 3, 0, TAU); ctx.fill(); }
        ctx.strokeStyle = 'rgba(90,120,140,.18)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.ellipse(0, 0, 12, 7, 0.3, 0.2, 2.4); ctx.stroke();
      } else if (p.t === 'entulho') {
        for (k = 0; k < 7; k++) {
          var ex = rn() * 30 - 15, ey = rn() * 22 - 11, er = 3 + rn() * 5;
          ctx.fillStyle = k % 2 ? '#4a4d4f' : '#5b5e5c'; ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1;
          ctx.beginPath(); for (var q = 0; q < 5; q++) { var qa = q / 5 * TAU + rn(), qr = er * (0.7 + rn() * 0.5); ctx.lineTo(ex + Math.cos(qa) * qr, ey + Math.sin(qa) * qr); } ctx.closePath(); ctx.fill(); ctx.stroke();
        }
      } else if (p.t === 'cones') {
        for (k = 0; k < 2; k++) {
          var cx2 = k * 22 - 8, cy2 = rn() * 8 - 4;
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(cx2 + 2, cy2 + 2, 8, 0, TAU); ctx.fill();
          ctx.fillStyle = '#d9631f'; ctx.beginPath(); ctx.arc(cx2, cy2, 7.5, 0, TAU); ctx.fill();
          ctx.fillStyle = '#e8e6df'; ctx.beginPath(); ctx.arc(cx2, cy2, 5, 0, TAU); ctx.fill();
          ctx.fillStyle = '#d9631f'; ctx.beginPath(); ctx.arc(cx2, cy2, 2.6, 0, TAU); ctx.fill();
        }
      } else if (p.t === 'placa') {
        ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(-13, -9, 28, 20);
        ctx.fillStyle = '#7d1f1d'; ctx.fillRect(-14, -10, 28, 20);
        ctx.fillStyle = '#c9c6bb'; ctx.fillRect(-10, -3, 20, 6);
        ctx.fillStyle = '#4a4d4f'; ctx.fillRect(14, -2, 22, 4);
      } else if (p.t === 'lixo') {
        for (k = 0; k < 3; k++) {
          var lx = rn() * 16 - 8, ly = rn() * 12 - 6;
          ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(lx + 2, ly + 3, 9, 7, 0, 0, TAU); ctx.fill();
          ctx.fillStyle = '#16181a'; ctx.beginPath(); ctx.ellipse(lx, ly, 9, 7, rn(), 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.ellipse(lx - 2, ly - 2, 3, 2, 0, 0, TAU); ctx.fill();
        }
      } else {                                              /* ossadas */
        ctx.strokeStyle = '#c9bfa4'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-10, -4); ctx.lineTo(8, 3); ctx.moveTo(-6, 5); ctx.lineTo(10, -5); ctx.moveTo(-2, -9); ctx.lineTo(1, 9); ctx.stroke();
        ctx.fillStyle = '#d6ccb0'; ctx.beginPath(); ctx.arc(11, -2, 4, 0, TAU); ctx.fill(); ctx.fillStyle = '#15130e'; ctx.fillRect(10, -3.4, 1.6, 1.8); ctx.fillRect(10, 0.2, 1.6, 1.8);
      }
      ctx.restore();
    }
  }
  /* camada estática: obstáculos + paredes são desenhados UMA vez num canvas e depois só recortados e copiados a cada quadro */
  var estCv = null, estCtx = null, estEsc = 1, estaticoRender = false;
  function construirEstatico(forcar) {
    var lite = document.documentElement.classList.contains('lite');
    var esc = clamp(view.zoom * view.pxr, 0.6, lite ? 0.9 : 1.25);
    if (estCv && !forcar && Math.abs(esc - estEsc) < 0.04) return;
    if (!estCv) { estCv = document.createElement('canvas'); estCtx = estCv.getContext('2d'); }
    estCv.width = Math.round(MUNDO.w * esc); estCv.height = Math.round(MUNDO.h * esc);
    estEsc = estCv.width / MUNDO.w;
    estCtx.setTransform(estEsc, 0, 0, estEsc, 0, 0);
    var c0 = ctx; ctx = estCtx; estaticoRender = true;
    desenharProps(); desenharObstaculos(); desenharParedes();
    estaticoRender = false; ctx = c0;
  }
  function desenharEstatico(x0, y0, x1, y1) {
    var sx = clamp(x0, 0, MUNDO.w), sy = clamp(y0, 0, MUNDO.h), ex = clamp(x1, 0, MUNDO.w), ey = clamp(y1, 0, MUNDO.h);
    if (ex <= sx || ey <= sy) return;
    ctx.drawImage(estCv, sx * estEsc, sy * estEsc, (ex - sx) * estEsc, (ey - sy) * estEsc, sx, sy, ex - sx, ey - sy);
  }
  function desenharBrilhoJanelas() {
    var p = MUNDO.p, W = MUNDO.w, H = MUNDO.h;
    for (var i = 0; i < JANELAS.length; i++) {
      var j = JANELAS[i], br = j.brilho || 0;
      if (br <= 0) continue;
      var h = j.lado === 'c' || j.lado === 'b', gw = 120;
      var bx = h ? j.x - gw / 2 : (j.lado === 'e' ? 0 : W - p), by = h ? (j.lado === 'c' ? 0 : H - p) : j.y - gw / 2;
      ctx.fillStyle = 'rgba(224,38,47,' + (br * 0.45).toFixed(2) + ')'; ctx.fillRect(bx, by, h ? gw : p, h ? p : gw);
    }
  }
  function desenharParedes(x0, y0, x1, y1) {
    var p = MUNDO.p, W = MUNDO.w, H = MUNDO.h;
    ctx.fillStyle = '#242927';
    ctx.fillRect(-200, -200, W + 400, 200 + p); ctx.fillRect(-200, H - p, W + 400, 200 + p);
    ctx.fillRect(-200, -200, 200 + p, H + 400); ctx.fillRect(W - p, -200, 200 + p, H + 400);
    /* sombra interna */
    var g = ctx.createLinearGradient(0, p, 0, p + 26); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(p, p, W - 2 * p, 26);
    g = ctx.createLinearGradient(0, H - p, 0, H - p - 26); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(p, H - p - 26, W - 2 * p, 26);
    g = ctx.createLinearGradient(p, 0, p + 26, 0); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(p, p, 26, H - 2 * p);
    g = ctx.createLinearGradient(W - p, 0, W - p - 26, 0); g.addColorStop(0, 'rgba(0,0,0,.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(W - p - 26, p, 26, H - 2 * p);
    /* tijolos e aresta */
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.beginPath();
    for (var y = 12; y < p; y += 14) { ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.moveTo(0, H - y); ctx.lineTo(W, H - y); }
    for (var x = 12; x < p; x += 14) { ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.moveTo(W - x, 0); ctx.lineTo(W - x, H); }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(190,255,214,.18)'; ctx.lineWidth = 2; ctx.strokeRect(p, p, W - 2 * p, H - 2 * p);
    /* janelas barricadas */
    for (var i = 0; i < JANELAS.length; i++) {
      var j = JANELAS[i], h = j.lado === 'c' || j.lado === 'b', gw = 120, gt = p;
      var bx = h ? j.x - gw / 2 : (j.lado === 'e' ? 0 : W - p), by = h ? (j.lado === 'c' ? 0 : H - p) : j.y - gw / 2;
      var bw = h ? gw : p, bh = h ? p : gw;
      ctx.fillStyle = '#060707'; ctx.fillRect(bx, by, bw, bh);
      var br = estaticoRender ? 0 : Math.max(0, j.brilho || 0);
      if (br > 0) { ctx.fillStyle = 'rgba(224,38,47,' + (br * 0.45).toFixed(2) + ')'; ctx.fillRect(bx, by, bw, bh); }
      ctx.fillStyle = '#6b4f2f'; ctx.strokeStyle = '#2b1d0e'; ctx.lineWidth = 1.5;
      for (var t = 0; t < 3; t++) {
        ctx.save();
        if (h) { ctx.translate(bx + bw / 2, by + 9 + t * 11); ctx.rotate((t - 1) * 0.07); ctx.fillRect(-bw / 2 - 4, -4, bw + 8, 8); ctx.strokeRect(-bw / 2 - 4, -4, bw + 8, 8); }
        else { ctx.translate(bx + 9 + t * 11, by + bh / 2); ctx.rotate((t - 1) * 0.07); ctx.fillRect(-4, -bh / 2 - 4, 8, bh + 8); ctx.strokeRect(-4, -bh / 2 - 4, 8, bh + 8); }
        ctx.restore();
      }
    }
  }

  /* brilhos radiais pré-renderizados por cor (antes: um gradiente novo por posto/suprimento a cada quadro) */
  /* sprites radiais em cache (antes: createRadialGradient + 2~3 addColorStop por efeito a cada quadro). A opacidade variável vira globalAlpha. */
  var sprFogoZ = null, sprNuvem = null, sprExpl = null;
  function criarSprRad(stops) {
    var c = document.createElement('canvas'); c.width = c.height = 128; var g = c.getContext('2d');
    var gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return c;
  }
  var brilhos = {}, pathArmaria = null;
  function brilhoCor(cor, alfa) {
    var k = cor + alfa; if (brilhos[k]) return brilhos[k];
    var c = document.createElement('canvas'); c.width = c.height = 128; var g = c.getContext('2d');
    var gr = g.createRadialGradient(64, 64, 8, 64, 64, 64); gr.addColorStop(0, hexA(cor, alfa)); gr.addColorStop(1, hexA(cor, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return (brilhos[k] = c);
  }
  function desenharEstacoes() {
    for (var i = 0; i < ESTACOES.length; i++) {
      var e = ESTACOES[i], pulso = 0.5 + 0.5 * Math.sin(S.t * 3 + i);
      ctx.save(); ctx.translate(e.x, e.y);
      var rb = e.r + 20; ctx.drawImage(brilhoCor(e.cor, 0.22), -rb, -rb, rb * 2, rb * 2);
      if (e.novo > 0) { var fn = (5 - e.novo) % 1; ctx.strokeStyle = hexA(e.cor, (1 - fn) * 0.8 * clamp(e.novo, 0, 1)); ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, e.r + 10 + fn * 90, 0, TAU); ctx.stroke(); }
      ctx.strokeStyle = hexA(e.cor, 0.5 + pulso * 0.3); ctx.lineWidth = 3; ctx.setLineDash([14, 10]); ctx.lineDashOffset = -S.t * 18;
      ctx.beginPath(); ctx.arc(0, 0, e.r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(8,12,10,.8)'; ctx.beginPath(); ctx.arc(0, 0, e.r - 10, 0, TAU); ctx.fill();
      ctx.strokeStyle = e.cor; ctx.fillStyle = e.cor; ctx.lineWidth = 3; ctx.lineCap = 'round';
      if (e.id === 'armaria') {
        ctx.save(); ctx.scale(0.62, 0.62); ctx.translate(-32, -13);
        ctx.fill(pathArmaria || (pathArmaria = new Path2D(MV.Sprites.ICONES_ARMA[2]))); ctx.restore();
      } else if (e.id === 'municao') {
        for (var k = -1; k <= 1; k++) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(k * 10 - 3.5, -13, 7, 24, 3) : ctx.rect(k * 10 - 3.5, -13, 7, 24); ctx.fill(); }
      } else {
        ctx.fillRect(-4, -15, 8, 30); ctx.fillRect(-15, -4, 30, 8);
      }
      if (S.estacaoAtual === e && S.compra > 0) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(0, 0, e.r + 7, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(S.compra / 0.7, 0, 1)); ctx.stroke();
      }
      ctx.font = '700 17px Rajdhani, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = e.cor;
      ctx.fillText(e.nome, 0, -e.r - 12);
      ctx.fillStyle = '#e9f1ea'; ctx.font = '700 15px Rajdhani, system-ui, sans-serif';
      ctx.fillText(e.id === 'armaria' ? 'LOJA DE ARMAS' : fmtNum(e.custo) + ' PONTOS', 0, e.r + 22);
      ctx.restore();
    }
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* =====================  BUFFS, RARIDADE E DROPS  =====================
   * Índice = tipo do drop. Raridade 0 comum · 1 raro · 2 muito raro · 3 super raro.
   * A raridade sorteada depende de: pesos-base × (1 + bônus)^nível, onde bônus = dif.raro + bônus do tipo de infectado abatido
   * (tanque/bruto/tóxico/corredor dão mais chance dos níveis altos). */
  var DROPS = [
    { cor: '#e8b630', sig: 'MAX', nome: 'MUNIÇÃO', rar: 0 },
    { cor: '#ff5a5a', sig: 'KO', nome: 'ABATE INSTANTÂNEO', rar: 2 },
    { cor: '#5ee7ff', sig: '2×', nome: 'RECOMPENSA 2×', rar: 1 },
    { cor: '#6fb6ff', sig: 'ESC', nome: 'ESCUDO', rar: 1 },
    { cor: '#ff8a2a', sig: 'FOGO', nome: 'BALAS INCENDIÁRIAS', rar: 2 },
    { cor: '#ffd23a', sig: 'BOOM', nome: 'BALAS EXPLOSIVAS', rar: 3 }
  ];
  var RARIDADES = [
    { nome: 'COMUM', cor: '#cfd8c6', peso: 60 }, { nome: 'RARO', cor: '#5ee7ff', peso: 28 },
    { nome: 'MUITO RARO', cor: '#c06bff', peso: 10 }, { nome: 'SUPER RARO', cor: '#ffb000', peso: 2 }
  ];
  var DROP_CHANCE_TIPO = [1, 1.1, 2, 1.8, 99, 1.6, 1.4];     /* multiplicador da chance de largar algo, por tipo de infectado */
  var DROP_RARO_TIPO = [0, 0.1, 0.45, 0.3, 1.2, 0.3, 0.2];   /* bônus de raridade por tipo (tanque = chefe) */
  var ESCUDO_MAX = 80, ESCUDO_TEMPO = 30, BUFF_TEMPO = 25;
  /* sorteia o tipo de drop considerando a dificuldade atual e o infectado abatido */
  function sortearDrop(tz) {
    var b = 1 + dif.raro + DROP_RARO_TIPO[tz], w = [], soma = 0, k;
    for (k = 0; k < 4; k++) { w[k] = RARIDADES[k].peso * Math.pow(b, k); soma += w[k]; }
    var r = Math.random() * soma, nivel = 0;
    for (k = 0; k < 4; k++) { if (r < w[k]) { nivel = k; break; } r -= w[k]; }
    var cand = [];
    for (k = 0; k < DROPS.length; k++) if (DROPS[k].rar === nivel) cand.push(k);
    return cand[(Math.random() * cand.length) | 0];
  }
  function desenharDrops() {
    for (var i = 0; i < S.drops.n; i++) {
      var d = S.drops.a[i], df = DROPS[d.tipo];
      if (d.t > 16 && ((d.t * 6) | 0) % 2 === 0) continue;
      var bob = Math.sin(S.t * 4 + i) * 3;
      ctx.save(); ctx.translate(d.x, d.y + bob);
      ctx.drawImage(brilhoCor(df.cor, 0.5), -40, -40, 80, 80);
      ctx.fillStyle = '#0b100d'; ctx.strokeStyle = df.cor; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(0, 0, 17, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = df.cor; ctx.font = '700 16px Rajdhani, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(df.sig, 0, 1);
      ctx.restore();
    }
    ctx.textBaseline = 'alphabetic';
  }

  /* rastro tóxico, zonas de fogo (base), minas e barris (dinâmicos: podem sumir) */
  function desenharExtrasChao(x0, y0, x1, y1) {
    var i, k;
    for (i = 0; i < pRastro.n; i++) {
      var r = pRastro.a[i]; if (r.x < x0 || r.x > x1 || r.y < y0 || r.y > y1) continue;
      var a = clamp(r.t / r.max * 1.4, 0, 1);
      ctx.fillStyle = 'rgba(110,170,30,' + (a * 0.42).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(r.x, r.y, 15 + (1 - a) * 4, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(190,240,70,' + (a * 0.28).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(r.x - 2, r.y - 2, 7, 0, TAU); ctx.fill();
    }
    for (i = 0; i < pFogoZ.n; i++) {
      var f = pFogoZ.a[i], fa = clamp(f.t / f.max * 2, 0, 1);
      if (!sprFogoZ) sprFogoZ = criarSprRad([[0.03, 'rgba(255,170,60,.55)'], [0.7, 'rgba(220,70,20,.3)'], [1, 'rgba(120,20,0,0)']]);
      ctx.globalAlpha = fa; ctx.drawImage(sprFogoZ, f.x - f.r, f.y - f.r, f.r * 2, f.r * 2); ctx.globalAlpha = 1;
    }
    for (i = 0; i < pMinas.n; i++) {
      var m = pMinas.a[i]; if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.arc(m.x + 2, m.y + 3, 11, 0, TAU); ctx.fill();
      ctx.fillStyle = '#2b2f26'; ctx.strokeStyle = '#0b0d09'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(m.x, m.y, 10.5, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#3d4234'; ctx.beginPath(); ctx.arc(m.x, m.y, 6.4, 0, TAU); ctx.fill();
      var armada = m.arm <= 0, piscar = armada ? (Math.sin(S.t * 6 + i) > 0.55) : (((m.arm * 8) | 0) % 2 === 0);
      ctx.fillStyle = armada ? (piscar ? '#ff3a3a' : '#5a1212') : (piscar ? '#ffd23a' : '#4a3a0a'); ctx.beginPath(); ctx.arc(m.x, m.y, 2.6, 0, TAU); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(m.x - 9, m.y); ctx.lineTo(m.x - 5, m.y); ctx.moveTo(m.x + 5, m.y); ctx.lineTo(m.x + 9, m.y); ctx.stroke();
    }
    for (i = 0; i < BARRIS.length; i++) {
      var b = BARRIS[i]; if (!b.vivo || b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1) continue;
      ctx.fillStyle = 'rgba(0,0,0,.4)'; ctx.beginPath(); ctx.ellipse(b.x + 4, b.y + 5, 17, 15, 0, 0, TAU); ctx.fill();
      var dano = b.hp < 40 ? 1 - b.hp / 40 : 0, cl = b.flash > 0 ? '#ffffff' : '#b3241c';
      ctx.fillStyle = cl; ctx.strokeStyle = '#2a0907'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(b.x, b.y, 16, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(30,6,4,.55)'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(b.x, b.y, 12.5, 0, TAU); ctx.stroke(); ctx.beginPath(); ctx.arc(b.x, b.y, 7.5, 0, TAU); ctx.stroke();
      ctx.fillStyle = '#7d1812'; ctx.beginPath(); ctx.arc(b.x, b.y, 5.2, 0, TAU); ctx.fill();
      ctx.fillStyle = '#ffd23a'; ctx.beginPath(); ctx.moveTo(b.x, b.y - 4); ctx.quadraticCurveTo(b.x + 4, b.y - 1, b.x + 1.5, b.y + 3.6); ctx.quadraticCurveTo(b.x - 4, b.y + 2, b.x - 1.5, b.y - 1); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.beginPath(); ctx.arc(b.x - 6, b.y - 6, 4, 0, TAU); ctx.fill();
      if (dano > 0) { ctx.strokeStyle = 'rgba(0,0,0,' + (0.3 + dano * 0.5).toFixed(2) + ')'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(b.x - 10, b.y - 3); ctx.lineTo(b.x - 2, b.y + 2); ctx.lineTo(b.x + 3, b.y + 9); ctx.moveTo(b.x + 8, b.y - 8); ctx.lineTo(b.x + 3, b.y - 1); ctx.stroke(); }
    }
  }
  /* brilho de fogo (aditivo) sobre zumbis incendiados, o jogador em chamas e as zonas de fogo; bolha do escudo */
  function desenharFogoCima(x0, y0, x1, y1) {
    var Zv = V.Z, i, o;
    if (!sprFogo) return;
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < MAXZ; i++) {
      if (queima[i] <= 0) continue;
      o = i * ZS; if (Zv[o] < 0.5) continue;
      var zx = Zv[o + 1], zy = Zv[o + 2]; if (zx < x0 || zx > x1 || zy < y0 || zy > y1) continue;
      var rr = Zv[o + 6] * 2.6 * (0.9 + 0.2 * Math.sin(S.t * 18 + i)); ctx.globalAlpha = clamp(queima[i], 0, 1) * 0.75;
      ctx.drawImage(sprFogo, zx - rr, zy - rr, rr * 2, rr * 2);
    }
    for (i = 0; i < pFogoZ.n; i++) {
      var f = pFogoZ.a[i], fr = f.r * 1.15 * (0.95 + 0.08 * Math.sin(S.t * 12 + i));
      ctx.globalAlpha = clamp(f.t / f.max * 1.6, 0, 0.7); ctx.drawImage(sprFogo, f.x - fr, f.y - fr, fr * 2, fr * 2);
    }
    if (J.fogoT > 0) { ctx.globalAlpha = 0.8; ctx.drawImage(sprFogo, J.x - 34, J.y - 34, 68, 68); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (J.escudo > 0 && estado === 'jogando') {                      /* bolha do escudo: some aos poucos e acende ao absorver dano */
      var pe = J.escudo / ESCUDO_MAX, pulso = 0.5 + 0.5 * Math.sin(S.t * 5);
      ctx.lineWidth = 2.4; ctx.strokeStyle = 'rgba(111,182,255,' + (0.35 + 0.25 * pulso + S.escudoFx).toFixed(2) + ')';
      ctx.fillStyle = 'rgba(111,182,255,' + (0.06 + 0.1 * pe + S.escudoFx * 0.5).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(J.x, J.y, 22 + pulso * 1.5, 0, TAU); ctx.fill(); ctx.stroke();
    }
  }

  var angVisZ = new Float32Array(256), angIni = new Uint8Array(256);   /* ângulo suavizado por zumbi (sem alocação por quadro) */
  function desenharZumbis(x0, y0, x1, y1) {
    var Zv = V.Z, i, o, U = sprites.U;
    /* sombras */
    ctx.fillStyle = 'rgba(0,0,0,.33)';
    for (i = 0; i < MAXZ; i++) {
      o = i * ZS; if (Zv[o] < 0.5) continue;
      var zx = Zv[o + 1], zy = Zv[o + 2];
      if (zx < x0 || zx > x1 || zy < y0 || zy > y1) continue;
      var r = Zv[o + 6];
      ctx.beginPath(); ctx.ellipse(zx + 3, zy + 4, r * 0.95, r * 0.8, 0, 0, TAU); ctx.fill();
    }
    for (i = 0; i < MAXZ; i++) {
      o = i * ZS; if (Zv[o] < 0.5) continue;
      zx = Zv[o + 1]; zy = Zv[o + 2];
      if (zx < x0 || zx > x1 || zy < y0 || zy > y1) continue;
      var tipo = Zv[o + 11] | 0, rr = Zv[o + 6], idade = Zv[o + 12];
      var angAlvo = Math.atan2(Zv[o + 8], Zv[o + 7]), av = angVisZ[i];
      if (idade < 0.1 || av === 0 && !angIni[i]) { av = angAlvo; angIni[i] = 1; }
      if (idade < 0.1) angIni[i] = 1;
      av += Math.atan2(Math.sin(angAlvo - av), Math.cos(angAlvo - av)) * (1 - Math.exp(-14 * (S.dtVis || 0.016)));   /* só visual: a direção real da IA não muda */
      angVisZ[i] = av;
      var fase = S.t * (2.2 + Zv[o + 5] * 0.035) + i * 0.7;
      var ang = av + (Zv[o + 15] > 0 ? 0 : Math.sin(fase * 6.2832 / 2) * 0.1);       /* cambaleia: ombros oscilam no passo */
      var fr;
      if (tipo === 3 && Zv[o + 17] === 1) fr = 5;                 /* corredor agachado, prestes a saltar */
      else if (tipo === 3 && Zv[o + 17] === 2) fr = 6;            /* em pleno bote */
      else if (Zv[o + 15] > 0) fr = 4;
      else fr = ((S.t * (2.2 + Zv[o + 5] * 0.035) + i * 0.7) | 0) & 3;
      var mk = Zv[o + 27] | 0, rast = Zv[o + 26] > 0.5, lenta = Zv[o + 29] > 0, lista;
      if (mk & 7) { var setM = MV.Sprites.membro(sprites, tipo, mk & 7); lista = Zv[o + 9] > 0 ? setM.flash[tipo] : setM.normal[tipo]; }     /* sem cabeça/braços */
      else lista = Zv[o + 9] > 0 ? sprites.flash[tipo] : sprites.normal[tipo];
      if (rast && fr < 4) fr = ((S.t * 1.4 + i * 0.7) | 0) & 3;       /* rastejador se arrasta devagar */
      var tam = rr / 14 * U, esc = 1, alfa = 1;
      if (lenta) { ctx.fillStyle = 'rgba(130,205,255,.26)'; ctx.beginPath(); ctx.arc(zx, zy, rr * 1.2, 0, TAU); ctx.fill(); }
      if (tipo === 6 && Zv[o + 17] > 0.5) {                          /* Bomber com o pavio aceso: raio da explosão encolhe até zero */
        var kb = clamp(Zv[o + 28] / 1.5, 0, 1), pb = Math.sin(S.t * 28) > 0;
        ctx.strokeStyle = 'rgba(255,' + (pb ? 150 : 60) + ',40,' + (0.35 + 0.4 * (1 - kb)) + ')'; ctx.lineWidth = 2; ctx.setLineDash([8, 8]);
        ctx.beginPath(); ctx.arc(zx, zy, BOMB_R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.arc(zx, zy, BOMB_R * (1 - kb), 0, TAU); ctx.stroke();
      }
      if (tipo === 5) esc = 1 + 0.05 * Math.sin(S.t * 5 + i);      /* o tóxico "respira" */
      /* anel colorido no chão: identifica os especiais de longe */
      if (tipo >= 3 && idade > 0.4) {
        var pl = 0.5 + 0.5 * Math.sin(S.t * 5 + i);
        ctx.strokeStyle = hexA(COR_TIPO[tipo], 0.35 + 0.3 * pl); ctx.lineWidth = tipo === 4 ? 3 : 2;
        ctx.beginPath(); ctx.arc(zx, zy, rr + 5 + pl * 2, 0, TAU); ctx.stroke();
        if (tipo === 3 && Zv[o + 17] === 1) { ctx.strokeStyle = 'rgba(255,210,58,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(zx, zy, rr + 14, 0, TAU); ctx.stroke(); }
      }
      if (tipo === 4 && Zv[o + 3] < Zv[o + 4] && sprAura) {                /* aura vermelha pulsante do tanque em fúria */
        var ar = rr * (2.6 + 0.25 * Math.sin(S.t * 9));
        ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.55 + 0.25 * Math.sin(S.t * 9);
        ctx.drawImage(sprAura, zx - ar, zy - ar, ar * 2, ar * 2);
        ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      }
      if (idade < 0.6) { var u = idade / 0.6; esc *= 0.55 + 0.45 * u; alfa = u; ctx.fillStyle = 'rgba(70,56,40,' + (0.5 * (1 - u)) + ')'; ctx.beginPath(); ctx.arc(zx, zy, rr * (1.6 - 0.4 * u), 0, TAU); ctx.fill(); }
      ctx.save();
      ctx.translate(zx, zy); ctx.rotate(ang);
      if (alfa < 1) ctx.globalAlpha = alfa;
      var w = tam * esc;
      if (rast) { ctx.scale(0.95, 0.78); ctx.translate(-w * 0.04, 0); }                                              /* sem pernas: corpo baixo, rente ao chão */
      if (Zv[o + 15] > 0) { var lunge = Math.sin(clamp(Zv[o + 15], 0, 1) * 3.1416) * 0.12; ctx.translate(w * lunge * 0.5, 0); ctx.scale(1 + lunge, 1 - lunge * 0.6); }   /* ataque: estica para a frente */
      else ctx.scale(1 + Math.abs(Math.sin(fase * 3.1416)) * 0.035, 1);               /* passada: leve compressão/estiramento */
      ctx.drawImage(lista[fr], -w / 2, -w / 2, w, w);
      ctx.restore();
      var hp = Zv[o + 3], hm = Zv[o + 4];
      if (hp < hm && idade > 0.6 && tipo !== 4) {              /* o tanque tem a barra grande no HUD */
        var bw = rr * 1.8;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(zx - bw / 2, zy - rr - 9, bw, 3.5);
        ctx.fillStyle = hp / hm > 0.4 ? '#c9d86a' : '#ff5a4a'; ctx.fillRect(zx - bw / 2, zy - rr - 9, bw * clamp(hp / hm, 0, 1), 3.5);
      }
    }
  }

  function desenharNuvens() {
    for (var i = 0; i < S.nuvens.n; i++) {
      var n = S.nuvens.a[i], vida = n.t / n.max, a = clamp(vida * 1.6, 0, 1) * 0.28, pul = 1 + 0.03 * Math.sin(S.t * 3 + i);
      if (!sprNuvem) sprNuvem = criarSprRad([[0.1, 'rgb(150,200,50)'], [0.7, 'rgba(110,160,40,.7)'], [1, 'rgba(90,130,30,0)']]);
      ctx.globalAlpha = a; ctx.drawImage(sprNuvem, n.x - n.r * pul, n.y - n.r * pul, n.r * pul * 2, n.r * pul * 2); ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(190,230,80,' + a * 1.4 + ')'; ctx.lineWidth = 2; ctx.setLineDash([10, 12]); ctx.lineDashOffset = -S.t * 12;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  /* =====================  SKINS (soldados-zumbi): 2 homens e 2 mulheres  =====================
   * Cada skin é só uma paleta + tipo de cabeça; pintarSoldado desenha o mesmo corpo vetorial em qualquer contexto (jogo e pré-visualização do menu). */
  var SKINS = [
    { nome: 'SGT. CARVALHO', sexo: 'HOMEM', fem: false, pele: '#8fa07a', peleEsc: '#6c7c5a', farda: '#34402f', fardaEsc: '#232b21', braco: '#41503e', mochila: '#2b3329', tira: '#8a7650', cab: 'capacete', capac: '#4b5a3a', capacEsc: '#3a472d', olho: '#ff3a30' },
    { nome: 'CB. FERREIRA', sexo: 'HOMEM', fem: false, pele: '#9aa58c', peleEsc: '#738068', farda: '#6b5a3a', fardaEsc: '#4a3d26', braco: '#7a6842', mochila: '#4a3d26', tira: '#c9b57a', cab: 'bandana', capac: '#8a2a22', capacEsc: '#5a1a16', olho: '#ffd23a' },
    { nome: 'TEN. SILVA', sexo: 'MULHER', fem: true, pele: '#a3b095', peleEsc: '#7b8870', farda: '#262c33', fardaEsc: '#171b20', braco: '#2f3740', mochila: '#1d2227', tira: '#5d7a8a', cab: 'rabo', cabelo: '#2a1810', capac: '#c24a2a', capacEsc: '#7a2c18', olho: '#6dff7a' },
    { nome: 'SD. MOREIRA', sexo: 'MULHER', fem: true, pele: '#8d9a85', peleEsc: '#68745f', farda: '#56595a', fardaEsc: '#3b3e3f', braco: '#62676a', mochila: '#34373a', tira: '#a9a9a0', cab: 'bone', cabelo: '#c8b890', capac: '#3f4a52', capacEsc: '#2a343b', olho: '#ff9a2a' },
    { nome: 'CAMUFLAGEM DIGITAL BLUE', sexo: 'HOMEM', fem: false, pele: '#8fa07a', peleEsc: '#6c7c5a', farda: '#2f4a6b', fardaEsc: '#1d3048', braco: '#3a5a82', mochila: '#1f2f45', tira: '#8fb3d9', cab: 'capacete', capac: '#35567e', capacEsc: '#233a57', olho: '#5ec8ff', trava: 'skinAzul' }
  ];
  function skinLivre(i) { var s = SKINS[i]; return !!s && (!s.trava || LEG.tem(s.trava)); }
  var dualDraw = false, animFase = 0, animBotas = false;
  /* desenha só a arma (reutilizada para a 2ª arma no modo duplo) */
  function pintarArma(g, arma, gx, comp, rc, rec) {
    g.fillStyle = '#16191b'; g.strokeStyle = '#050606'; g.lineWidth = 1;
    if (arma === 0) { g.fillRect(gx + 4, -2.2, comp - 8 - rc, 4.4); g.fillStyle = '#2b3033'; g.fillRect(gx + 4, -2.2, comp - 14, 2); }
    else if (arma === 1) { g.fillRect(gx + 2, -2.8, comp - 6 - rc, 5.6); g.fillStyle = '#2b3033'; g.fillRect(gx + 2, -2.8, comp - 14, 2.2); g.fillStyle = '#16191b'; g.fillRect(gx + 12, 2, 4, 6); g.fillRect(gx - 4, -2, 8, 4); }
    else if (arma === 2) { g.fillRect(gx - 4, -3, 9, 6); g.fillRect(gx + 4, -2.6, comp - 4 - rc, 5.2); g.fillStyle = '#2b3033'; g.fillRect(gx + 4, -2.6, comp - 14, 2); g.fillStyle = '#16191b'; g.fillRect(gx + 14, 2, 4, 7); g.fillStyle = '#3a2f22'; g.fillRect(gx + 4 + comp - 10, -1.2, 9, 2.4); }
    else if (arma === 3) {                       /* escopeta: cano longo, bomba (pump) e coronha */
      g.fillRect(gx - 6, -3.2, 11, 6.4); g.fillStyle = '#3a2f22'; g.fillRect(gx - 8, -2.6, 7, 5.2);
      g.fillStyle = '#16191b'; g.fillRect(gx + 4, -2.4, comp - 4 - rc, 4.8); g.fillStyle = '#2b3033'; g.fillRect(gx + 4, -2.4, comp - 10, 1.8);
      g.fillStyle = '#4a3a28'; g.fillRect(gx + 14 - rec * 4, -3.6, 11, 7.2);
    } else if (arma === 6) {                     /* mini uzi: corpo curto, empunhadura e carregador longo */
      g.fillRect(gx + 2, -2.6, comp - 2 - rc, 5.2); g.fillStyle = '#2b3033'; g.fillRect(gx + 2, -2.6, comp - 8, 1.8);
      g.fillStyle = '#16191b'; g.fillRect(gx + 6, 2.4, 3.2, 8); g.fillRect(gx + 13, 2.4, 3, 4); g.fillStyle = '#4a4f55'; g.fillRect(gx + comp - 3 - rc, -1.2, 4, 2.4);
    } else if (arma === 5) {                     /* mini gun: cinco canos giratórios, caixa de munição e alça */
      g.fillStyle = '#23282b'; g.fillRect(gx - 4, -5, 12, 10); g.fillStyle = '#16191b'; g.fillRect(gx + 6, -4.2, comp - 6 - rc, 8.4);
      g.fillStyle = '#3a4045'; for (var gk = -3; gk <= 3; gk += 1.5) g.fillRect(gx + 10, gk - 0.45, comp - 10 - rc, 0.9);
      g.fillStyle = '#5a6168'; g.fillRect(gx + comp - 6 - rc, -4.6, 3, 9.2); g.fillStyle = '#3f4f33'; g.fillRect(gx - 8, 3, 9, 7);
    } else {                                       /* lança-porcos: tubo verde apoiado no ombro, boca larga */
      g.fillStyle = '#3f4f33'; g.fillRect(gx - 8, -4.4, comp + 4 - rc, 8.8);
      g.fillStyle = '#2b3724'; g.fillRect(gx - 8, -4.4, 10, 8.8); g.fillRect(gx + comp - 8 - rc, -5.4, 7, 10.8);
      g.fillStyle = '#16191b'; g.fillRect(gx + 10, 4.4, 5, 6); g.fillStyle = '#a14a55'; g.fillRect(gx + comp - 1 - rc, -2.2, 3, 4.4);
    }
  }
  /* desenha o soldado já transladado/rotacionado em g. arma = índice da arma; rc recuo; trocando/rec animações; flash = clarão do tiro */
  function pintarSoldado(g, sk, arma, rc, trocando, rec, flash) {
    var a = ARMAS[arma];
    if (animBotas) {                             /* botas alternando ao andar (só visual; hitbox e velocidade não mudam) */
      var bs = Math.sin(animFase) * 6;
      g.fillStyle = '#1a1d1a'; g.strokeStyle = '#050606'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(bs, -5.5, 5, 3, 0, 0, TAU); g.fill(); g.stroke();
      g.beginPath(); g.ellipse(-bs, 5.5, 5, 3, 0, 0, TAU); g.fill(); g.stroke();
    }
    /* mochila */
    g.fillStyle = sk.mochila; g.strokeStyle = '#0a0d0b'; g.lineWidth = 1.2;
    g.fillRect(-14, -8, 8, 16); g.strokeRect(-14, -8, 8, 16);
    /* arma */
    var gx = 8 - rc - trocando * 0.5 - rec * 3, comp = a.comp;
    var dual = dualDraw && (arma === IDX_PISTOLA || arma === IDX_UZI);
    if (dual) { g.save(); g.translate(0, -7.5); pintarArma(g, arma, gx + (S.mao > 0 ? 0 : -rc * 0.5), comp, S.mao > 0 ? 0 : rc * 0.5, rec); g.restore(); g.save(); g.translate(0, 7.5); pintarArma(g, arma, gx, comp, rc, rec); g.restore(); }
    else pintarArma(g, arma, gx, comp, rc, rec);
    /* braços */
    var sx = 2, off = arma === 0 ? 1 : 2.6;
    var ax1 = gx + comp * 0.52, ay1 = -off, ax2 = gx + 7, ay2 = off;
    if (dual) { ax1 = ax2 = gx + comp * 0.4; ay1 = -7.5; ay2 = 7.5; }
    g.strokeStyle = '#0a0d0b'; g.lineWidth = 6.6;
    g.beginPath(); g.moveTo(sx, -8.5); g.lineTo(ax1, ay1); g.moveTo(sx, 8.5); g.lineTo(ax2, ay2); g.stroke();
    g.strokeStyle = sk.braco; g.lineWidth = 5.2;
    g.beginPath(); g.moveTo(sx, -8.5); g.lineTo(ax1, ay1); g.moveTo(sx, 8.5); g.lineTo(ax2, ay2); g.stroke();
    g.fillStyle = sk.pele;
    g.beginPath(); g.arc(ax1 + 1, ay1, 2.7, 0, TAU); g.arc(dual ? ax2 + 1 : gx + 8, ay2, 2.7, 0, TAU); g.fill();
    /* tronco */
    g.fillStyle = sk.farda; g.strokeStyle = '#0a0d0b'; g.lineWidth = 1.3;
    g.beginPath(); g.ellipse(0, 0, sk.fem ? 7 : 8, sk.fem ? 12 : 13, 0, 0, TAU); g.fill(); g.stroke();
    g.fillStyle = sk.fardaEsc; g.fillRect(-3, -9, 6, 4); g.fillRect(-3, 5, 6, 4);
    g.strokeStyle = sk.tira; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-5, -10); g.lineTo(4, 10); g.stroke();
    /* ferimentos de soldado-zumbi: manchas de sangue e manga rasgada */
    g.fillStyle = 'rgba(140,8,12,.7)'; g.beginPath(); g.ellipse(-1, -7, 3.2, 2.2, 0.4, 0, TAU); g.ellipse(2, 6.5, 2.4, 1.8, -0.3, 0, TAU); g.fill();
    g.fillStyle = sk.peleEsc; g.fillRect(gx + 6, 6.2, 4, 2.4);
    /* cabeça */
    g.fillStyle = sk.pele; g.strokeStyle = '#0a0d0b'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(1, 0, 7, 0, TAU); g.fill(); g.stroke();
    if (sk.cab === 'capacete') {
      g.beginPath(); g.arc(0, 0, 6.8, 0, TAU); g.fillStyle = sk.capac; g.fill(); g.stroke();
      g.fillStyle = sk.capacEsc; g.beginPath(); g.arc(-1.2, 0, 4.2, 0, TAU); g.fill();
    } else if (sk.cab === 'bandana') {                 /* careca com lenço vermelho */
      g.fillStyle = sk.capac; g.fillRect(-2.5, -7, 4.2, 14); g.strokeStyle = '#0a0d0b'; g.lineWidth = 0.8; g.strokeRect(-2.5, -7, 4.2, 14);
      g.beginPath(); g.moveTo(-2.5, 0); g.lineTo(-10, -3.5); g.lineTo(-8.5, 1); g.lineTo(-10.5, 4); g.closePath(); g.fill(); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,.4)'; g.lineWidth = 1; g.beginPath(); g.moveTo(3, -4); g.lineTo(5, 0); g.stroke();   /* cicatriz */
    } else if (sk.cab === 'rabo') {                    /* cabelo preso em rabo de cavalo + faixa */
      var bal = Math.sin(S.t * 7) * 1.6 + (rec ? 0 : 0);
      g.fillStyle = sk.cabelo; g.strokeStyle = '#0a0d0b'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(-9.5, bal, 6.4, 3, bal * 0.05, 0, TAU); g.fill(); g.stroke();
      g.beginPath(); g.arc(-0.6, 0, 6.9, Math.PI * 0.42, Math.PI * 1.58); g.lineTo(-0.6, 0); g.fill();
      g.beginPath(); g.arc(0, 0, 6.6, 0, TAU); g.fill(); g.stroke();
      g.fillStyle = sk.capac; g.fillRect(1.6, -6.4, 2.6, 12.8);
      g.fillStyle = sk.pele; g.beginPath(); g.ellipse(4.2, 0, 3, 5, 0, -Math.PI / 2, Math.PI / 2); g.fill();
    } else {                                           /* boné com cabelo curto */
      g.fillStyle = sk.cabelo; g.beginPath(); g.ellipse(-6, 0, 4, 5.4, 0, 0, TAU); g.fill();
      g.fillStyle = sk.capac; g.strokeStyle = '#0a0d0b'; g.lineWidth = 1;
      g.beginPath(); g.arc(0, 0, 6.6, 0, TAU); g.fill(); g.stroke();
      g.fillRect(4, -4.4, 7, 8.8); g.strokeRect(4, -4.4, 7, 8.8);
      g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(-1, 0, 3.6, 0, TAU); g.fill();
    }
    /* olhos brilhantes (zumbi): aditivos, cor própria de cada skin */
    g.globalCompositeOperation = 'lighter'; g.fillStyle = sk.olho;
    g.beginPath(); g.arc(5.4, -2.3, 1.5, 0, TAU); g.arc(5.4, 2.3, 1.5, 0, TAU); g.fill();
    g.globalAlpha = 0.35; g.beginPath(); g.arc(5.4, -2.3, 3.2, 0, TAU); g.arc(5.4, 2.3, 3.2, 0, TAU); g.fill(); g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    /* clarão do tiro */
    if (flash) {
      var fx = gx + comp + 2 - rc, fl = 9 + Math.random() * 7;
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(255,214,120,.95)';
      g.beginPath();
      for (var k = 0; k < 8; k++) { var aa = k / 8 * TAU, rr = k % 2 ? fl * 0.4 : fl; g.lineTo(fx + Math.cos(aa) * rr * (k % 2 ? 1 : 1.5), Math.sin(aa) * rr); }
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(fx, 0, 4, 0, TAU); g.fill();
      g.globalCompositeOperation = 'source-over';
    }
  }
  var solCv = document.createElement('canvas'), solCtx = null;
  solCv.width = solCv.height = 96; solCtx = solCv.getContext('2d');
  function desenharJogador() {
    var a = ARMAS[J.arma];
    var x = J.x, y = J.y;
    /* só a APARÊNCIA é suavizada: J.ang (mira/tiro) continua exato. Gira pelo caminho mais curto com amortecimento exponencial. */
    if (J.angVis === undefined || !isFinite(J.angVis)) J.angVis = J.ang;
    var dA = Math.atan2(Math.sin(J.ang - J.angVis), Math.cos(J.ang - J.angVis));
    J.angVis += dA * (1 - Math.exp(-22 * (S.dtVis || 0.016)));
    var andando = J.movendo && estado === 'jogando';
    var fase = J.passo * 0.085, balanco = andando ? Math.sin(fase) * 0.07 : Math.sin(S.t * 1.6) * 0.012;      /* ombros balançam ao andar; respiração parada */
    var respira = 1 + (andando ? Math.abs(Math.sin(fase)) * 0.025 : Math.sin(S.t * 1.6) * 0.012);
    var ferido = clamp(S.dano, 0, 1);
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(x + 3, y + 4, 15, 13, 0, 0, TAU); ctx.fill();
    var rc = J.recuo, trocando = J.trocaT > 0 ? Math.sin(clamp(J.trocaT / TROCA_TEMPO, 0, 1) * Math.PI) * 5 : 0;
    var rec = J.recarga > 0 ? Math.sin((1 - J.recarga / J.recargaTotal) * Math.PI) : 0;
    dualDraw = !!(S.dual && S.dual[J.arma]); animFase = fase; animBotas = andando;
    var skin = (skinLivre(cfg.skin) && SKINS[cfg.skin]) || SKINS[0];
    if (ferido > 0.08 && solCtx) {                /* ao ser ferido: o soldado é pintado num cartão pequeno e tingido de vermelho (flash) */
      solCtx.setTransform(1, 0, 0, 1, 0, 0); solCtx.clearRect(0, 0, 96, 96);
      solCtx.translate(48, 48); solCtx.rotate(J.angVis + balanco); solCtx.scale(respira, respira); solCtx.lineCap = 'round'; solCtx.lineJoin = 'round';
      pintarSoldado(solCtx, skin, J.arma, rc, trocando, rec, S.brilhoTiro > 0);
      solCtx.setTransform(1, 0, 0, 1, 0, 0); solCtx.globalCompositeOperation = 'source-atop'; solCtx.fillStyle = 'rgba(255,40,30,' + (ferido * 0.65).toFixed(2) + ')'; solCtx.fillRect(0, 0, 96, 96); solCtx.globalCompositeOperation = 'source-over';
      ctx.drawImage(solCv, x - 48, y - 48);
    } else {
      ctx.translate(x, y); ctx.rotate(J.angVis + balanco); ctx.scale(respira, respira);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      pintarSoldado(ctx, skin, J.arma, rc, trocando, rec, S.brilhoTiro > 0);
    }
    dualDraw = false; animBotas = false;
    ctx.restore();

    /* mira a laser e retículo no alvo */
    if (estado === 'jogando') {
      ctx.save();
      var lx = x + Math.cos(J.ang) * 60, ly = y + Math.sin(J.ang) * 60, ex = x + Math.cos(J.ang) * 210, ey = y + Math.sin(J.ang) * 210;
      var lg = ctx.createLinearGradient(lx, ly, ex, ey);
      if (LEG.tem('laser')) {                                   /* Primeira Sangria: mira laser vermelha de verdade (+5% de precisão) */
        ex = x + Math.cos(J.ang) * 520; ey = y + Math.sin(J.ang) * 520;
        lg = ctx.createLinearGradient(lx, ly, ex, ey); lg.addColorStop(0, 'rgba(255,40,40,.85)'); lg.addColorStop(1, 'rgba(255,40,40,.05)');
        ctx.strokeStyle = lg; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.fillStyle = 'rgba(255,60,60,.5)'; ctx.beginPath(); ctx.arc(ex, ey, 2.4, 0, TAU); ctx.fill();
      } else {
      lg.addColorStop(0, 'rgba(255,70,70,.45)'); lg.addColorStop(1, 'rgba(255,70,70,0)');
      ctx.strokeStyle = lg; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(ex, ey); ctx.stroke(); }
      if (J.temAlvo) {
        var rx = J.alvoX, ry = J.alvoY, ra = 16 + Math.sin(S.t * 8) * 1.5;
        ctx.strokeStyle = 'rgba(255,80,80,.85)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(rx, ry, ra, 0, TAU); ctx.moveTo(rx - ra - 5, ry); ctx.lineTo(rx - ra + 5, ry); ctx.moveTo(rx + ra - 5, ry); ctx.lineTo(rx + ra + 5, ry); ctx.moveTo(rx, ry - ra - 5); ctx.lineTo(rx, ry - ra + 5); ctx.moveTo(rx, ry + ra - 5); ctx.lineTo(rx, ry + ra + 5); ctx.stroke();
      }
      ctx.restore();
    }
  }

  function desenharBalas() {
    var Bv = V.B, i, o, n = 0;
    ctx.strokeStyle = 'rgba(255,230,160,.95)'; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
    ctx.beginPath();
    for (i = 0; i < MAXB; i++) {
      o = i * BS; if (Bv[o] < 0.5) continue;
      ctx.moveTo(Bv[o + 1] - Bv[o + 3] * 0.028, Bv[o + 2] - Bv[o + 4] * 0.028); ctx.lineTo(Bv[o + 1], Bv[o + 2]); n++;
    }
    if (n) ctx.stroke();
    desenharPesados();
  }
  /* leitão explosivo e granada (sprites procedurais simples; a Etapa 2 troca por modelos vetoriais completos) */
  function desenharPesados() {
    var Gv = V.G;
    for (var i = 0; i < MAXG; i++) {
      var o = i * GS;
      if (Gv[o] < 0.5) continue;
      var x = Gv[o + 1], y = Gv[o + 2];
      if (Gv[o + 8] === 1) {
        var ang = Math.atan2(Gv[o + 4], Gv[o + 3]), pern = Math.sin(S.t * 40 + i) * 3;
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.fillStyle = '#e59aa4'; ctx.strokeStyle = '#6b2430'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.ellipse(0, 0, 11, 7, 0, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#d27d8a'; ctx.beginPath(); ctx.arc(10, 0, 4.4, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#6b2430'; ctx.fillRect(12, -2.2, 1.3, 1.4); ctx.fillRect(12, 0.8, 1.3, 1.4);
        ctx.fillStyle = '#e59aa4'; ctx.beginPath(); ctx.moveTo(6, -6); ctx.lineTo(9, -10); ctx.lineTo(11, -5); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#4b5a3a'; ctx.beginPath(); ctx.arc(-1, 0, 5.4, Math.PI * 0.55, Math.PI * 1.45, true); ctx.fill();
        ctx.strokeStyle = '#6b2430'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-4, 6); ctx.lineTo(-6 + pern, 9); ctx.moveTo(2, 6); ctx.lineTo(4 - pern, 9); ctx.moveTo(-4, -6); ctx.lineTo(-6 - pern, -9); ctx.moveTo(2, -6); ctx.lineTo(4 + pern, -9); ctx.stroke();
        ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,170,60,.85)';
        ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(-22 - Math.random() * 8, -3); ctx.lineTo(-22 - Math.random() * 8, 3); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (Gv[o + 8] === 4) {                   /* molotov: garrafa girando com pavio em chamas */
        var zm = Gv[o + 5];
        ctx.fillStyle = 'rgba(0,0,0,' + (0.34 - Math.min(0.2, zm / 300)) + ')'; ctx.beginPath(); ctx.ellipse(x + 2, y + 3, 6, 4, 0, 0, TAU); ctx.fill();
        ctx.save(); ctx.translate(x, y - zm * 0.5); ctx.rotate(S.t * 14 + i);
        ctx.fillStyle = '#3f7a42'; ctx.strokeStyle = '#0f2411'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.ellipse(0, 0, 5.5, 3.6, 0, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillRect(4, -1.4, 5, 2.8); ctx.fillStyle = '#e8dcc0'; ctx.fillRect(8, -1.8, 3, 3.6);
        ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = 'rgba(255,170,50,.9)';
        ctx.beginPath(); ctx.arc(12, 0, 3.4 + Math.random() * 2, 0, TAU); ctx.fill();
        ctx.restore();
      } else if (Gv[o + 8] === 3) {                   /* glóbulo de ácido */
        var za = Gv[o + 5];
        ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(x, y + 2, 6, 4, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = '#9ad43a'; ctx.strokeStyle = '#37501a'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(x, y - za * 0.5, 6 + Math.sin(S.t * 30) * 0.8, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.fillStyle = 'rgba(230,255,160,.8)'; ctx.beginPath(); ctx.arc(x - 2, y - za * 0.5 - 2, 2, 0, TAU); ctx.fill();
      } else {
        var z = Gv[o + 5];
        ctx.fillStyle = 'rgba(0,0,0,' + (0.38 - Math.min(0.2, z / 200)) + ')'; ctx.beginPath(); ctx.ellipse(x + 2, y + 3, 6, 4.5, 0, 0, TAU); ctx.fill();
        ctx.save(); ctx.translate(x, y - z * 0.45); ctx.rotate(S.t * 9 + i);
        ctx.fillStyle = '#4c5a36'; ctx.strokeStyle = '#141a10'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.ellipse(0, 0, 6.4, 7.6, 0, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(6, 0); ctx.moveTo(0, -7); ctx.lineTo(0, 7); ctx.stroke();
        ctx.fillStyle = '#9aa38a'; ctx.fillRect(-2.2, -10, 4.4, 3.4);
        if (Gv[o + 7] < 0.6 && ((S.t * 14) | 0) % 2 === 0) { ctx.fillStyle = '#ff3030'; ctx.beginPath(); ctx.arc(0, -11, 2, 0, TAU); ctx.fill(); }
        ctx.restore();
      }
    }
    /* bolas de fogo e onda de choque */
    for (var k = 0; k < S.fx.n; k++) {
      var f = S.fx.a[k], u = f.t / f.max, r = f.r * (0.25 + 0.85 * Math.min(1, u * 1.6));
      if (f.tp === 3) {                                          /* rugido: só um anel vermelho que se expande */
        ctx.strokeStyle = 'rgba(255,40,30,' + (0.7 * (1 - u)) + ')'; ctx.lineWidth = 5 * (1 - u) + 1;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.1 + u), 0, TAU); ctx.stroke();
        continue;
      }
      ctx.globalCompositeOperation = 'lighter';
      if (!sprExpl) sprExpl = criarSprRad([[0.03, 'rgba(255,240,190,.95)'], [0.35, 'rgba(255,150,40,.7)'], [1, 'rgba(160,40,10,0)']]);
      ctx.globalAlpha = 1 - u; ctx.drawImage(sprExpl, f.x - r, f.y - r, r * 2, r * 2); ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = 'rgba(255,230,180,' + (0.6 * (1 - u)) + ')'; ctx.lineWidth = 3 * (1 - u) + 1;
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.2 + u * 1.05), 0, TAU); ctx.stroke();
    }
  }

  var COR_PART = ['rgba(92,10,14,', 'rgba(170,22,28,', 'rgba(255,214,120,', 'rgba(112,92,68,', 'rgba(217,164,65,', 'rgba(190,190,190,', 'rgba(140,190,50,', 'rgba(255,150,40,', 'rgba(170,225,255,'];
  function desenharParticulas(x0, y0, x1, y1) {
    for (var t = 0; t < 9; t++) {
      var cor = COR_PART[t];
      ctx.globalCompositeOperation = t === 7 ? 'lighter' : 'source-over';
      for (var i = 0; i < MAXP; i++) {
        if (P.vida[i] <= 0 || P.tipo[i] !== t) continue;
        var x = P.x[i], y = P.y[i];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        var a = clamp(P.vida[i] / P.max[i] * 1.6, 0, 1), s = P.tam[i];
        if (t === 2) { ctx.fillStyle = cor + a + ')'; ctx.fillRect(x - s / 2, y - s / 2, s * 1.6, s * 0.8); continue; }
        if (t === 5) s *= 1 + (1 - a) * 2;
        ctx.fillStyle = cor + (t === 6 ? a * 0.22 : (t === 5 ? a * 0.35 : a)) + ')';
        if (t === 4) ctx.fillRect(x - 1.6, y - 0.9, 3.2, 1.8); else { ctx.beginPath(); ctx.arc(x, y, t === 7 ? s * (0.5 + a * 0.6) : s, 0, TAU); ctx.fill(); }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function desenharTextos() {
    ctx.textAlign = 'center';
    for (var i = 0; i < pTexto.n; i++) {
      var t = pTexto.a[i], a = clamp(t.vida / t.max * 1.5, 0, 1);
      ctx.globalAlpha = a; ctx.font = '700 ' + t.tam + 'px Rajdhani, system-ui, sans-serif';
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText(t.txt, t.x, t.y);
      ctx.fillStyle = t.cor; ctx.fillText(t.txt, t.x, t.y);
    }
    ctx.globalAlpha = 1;
  }

  function desenharIndicadores() {
    var Zv = V.Z, W = view.w, H = view.h, z = view.zoom, margem = 20, cx = W / 2, cy = H / 2;
    var n = 0;
    for (var i = 0; i < MAXZ && n < 14; i++) {
      var o = i * ZS; if (Zv[o] < 0.5) continue;
      var sx = (Zv[o + 1] - cam.x) * z + cx, sy = (Zv[o + 2] - cam.y) * z + cy;
      if (sx > -6 && sx < W + 6 && sy > -6 && sy < H + 6) continue;
      var dx = sx - cx, dy = sy - cy, d = hip(dx, dy) / z;
      if (d > 900) continue;
      var k = Math.min((cx - margem) / Math.abs(dx || 1e-6), (cy - margem) / Math.abs(dy || 1e-6));
      var ix = cx + dx * k, iy = cy + dy * k, a = Math.atan2(dy, dx);
      var tpI = Zv[o + 11] | 0, esp = tpI >= 3, sc = esp ? 1.5 : 1;
      ctx.fillStyle = COR_TIPO[tpI];
      ctx.globalAlpha = clamp(1.15 - d / 900, esp ? 0.55 : 0.25, 0.95);
      ctx.save(); ctx.translate(ix, iy); ctx.rotate(a); ctx.scale(sc, sc);
      ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(-5, -6); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
      ctx.restore(); n++;
    }
    ctx.globalAlpha = 1;
  }

  /* =====================  ILUMINAÇÃO  =====================
   * Camada de escuridão em meia resolução: preenche tudo de escuro e "fura" (destination-out) a luz ambiente, o cone da lanterna e
   * as luzes de explosão/disparo; depois pinta as sombras projetadas pelos obstáculos. Os sprites de luz são pré-renderizados. */
  var sprFogo = null;
  var luzCv = null, luzCtx = null, sprLuz = null, sprCone = null, sprNevoa = null, sprAura = null, sprOlhos = [];
  var ESCURO = 0.94;
  function mkCanvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function criarSpritesLuz() {
    var c, g, x;
    sprFogo = mkCanvas(64, 64); x = sprFogo.getContext('2d');
    g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,230,140,.95)'); g.addColorStop(0.35, 'rgba(255,140,40,.6)'); g.addColorStop(1, 'rgba(160,30,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    sprLuz = mkCanvas(256, 256); x = sprLuz.getContext('2d');
    g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.95)'); g.addColorStop(0.7, 'rgba(255,255,255,.45)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    sprCone = mkCanvas(256, 256); x = sprCone.getContext('2d');          /* cone apontando para +x, ponta em (0,128), com bordas suaves (camadas aninhadas) */
    g = x.createLinearGradient(0, 0, 256, 0);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.55, 'rgba(255,255,255,.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.globalAlpha = 0.24;
    for (var i = 0; i < 8; i++) { var fr = 1 - i * 0.09; x.beginPath(); x.moveTo(0, 128); x.lineTo(256, 128 - 128 * fr); x.lineTo(256, 128 + 128 * fr); x.closePath(); x.fill(); }
    sprNevoa = mkCanvas(128, 128); x = sprNevoa.getContext('2d');
    g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(150,165,170,.55)'); g.addColorStop(1, 'rgba(150,165,170,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    sprAura = mkCanvas(128, 128); x = sprAura.getContext('2d');
    g = x.createRadialGradient(64, 64, 8, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,30,20,0)'); g.addColorStop(0.45, 'rgba(255,30,20,.55)'); g.addColorStop(0.75, 'rgba(255,60,30,.25)'); g.addColorStop(1, 'rgba(255,30,20,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    var cores = ['255,50,40', '255,50,40', '255,50,40', '255,210,60', '255,30,20', '170,255,60', '255,110,40'];
    for (var t = 0; t < cores.length; t++) {
      c = mkCanvas(32, 32); x = c.getContext('2d');
      g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(0.25, 'rgba(' + cores[t] + ',.95)'); g.addColorStop(1, 'rgba(' + cores[t] + ',0)');
      x.fillStyle = g; x.fillRect(0, 0, 32, 32); sprOlhos.push(c);
    }
  }
  /* insano: a lanterna tem só 40% da capacidade (raio e comprimento do cone × dif.luz) */
  function raioLuz() { var v = cfg.luz / 100; return (90 + 1310 * v * v) * (dif.luz || 1) * (MV.Meta.tem('r05') ? 1.25 : 1); }
  function compCone() { return (460 + 440 * (cfg.luz / 100)) * (dif.luz || 1) * (MV.Meta.tem('r05') ? 1.25 : 1); }

  /* sombras: para cada aresta do obstáculo voltada PARA LONGE do jogador, projeta um quadrilátero para trás */
  function sombraAresta(lc, ax, ay, bx, by, nx, ny) {
    var mx = (ax + bx) / 2 - J.x, my = (ay + by) / 2 - J.y;
    if (nx * mx + ny * my <= 0) return;
    var da = hip(ax - J.x, ay - J.y) || 1, db = hip(bx - J.x, by - J.y) || 1, L = 1800;
    lc.beginPath(); lc.moveTo(ax, ay); lc.lineTo(bx, by);
    lc.lineTo(bx + (bx - J.x) / db * L, by + (by - J.y) / db * L); lc.lineTo(ax + (ax - J.x) / da * L, ay + (ay - J.y) / da * L);
    lc.closePath(); lc.fill();
  }
  /* ILUMINAÇÃO NOTURNA: camada tingida de azul-noite aplicada com 'multiply' (a luz da lanterna/fogo/explosões "fura" a tinta),
   * e um facho quente aditivo que acompanha J.ang. Roda em meia resolução; só quando a escuridão está ativa e a opção NOITE está ligada. */
  var noiteCv = null, noiteCtx = null, sprConeQ = null;
  function desenharNoite(x0, y0, x1, y1) {
    if (!cfg.noite || cfg.luz >= 100 || !luzCv || !sprCone || document.documentElement.classList.contains('lite')) return;
    if (!noiteCv || noiteCv.width !== luzCv.width || noiteCv.height !== luzCv.height) { noiteCv = mkCanvas(luzCv.width, luzCv.height); noiteCtx = noiteCv.getContext('2d'); }
    var nc = noiteCtx, z = view.zoom * view.pxr, k = luzCv.width / cv.width, sc = z * k, i;
    var ex = Math.round((view.w / 2 - cam.x * view.zoom + tremor.x) * view.pxr) * k, ey = Math.round((view.h / 2 - cam.y * view.zoom + tremor.y) * view.pxr) * k;
    nc.globalCompositeOperation = 'source-over'; nc.setTransform(1, 0, 0, 1, 0, 0);
    nc.fillStyle = 'rgb(138,158,214)'; nc.fillRect(0, 0, noiteCv.width, noiteCv.height);
    nc.setTransform(sc, 0, 0, sc, ex, ey); nc.globalCompositeOperation = 'destination-out';
    var R = raioLuz() * 0.5, Lc = compCone();       /* a tinta fria cobre a penumbra em volta; só o facho, o fogo e as explosões a anulam */
    nc.drawImage(sprLuz, J.x - R, J.y - R, R * 2, R * 2);
    nc.save(); nc.translate(J.x, J.y); nc.rotate(J.ang); nc.drawImage(sprCone, 0, -Lc * 0.495, Lc, Lc * 0.99); nc.restore();
    for (i = 0; i < pFogoZ.n; i++) { var fz = pFogoZ.a[i]; nc.globalAlpha = 0.9; nc.drawImage(sprLuz, fz.x - fz.r * 1.6, fz.y - fz.r * 1.6, fz.r * 3.2, fz.r * 3.2); }
    for (i = 0; i < S.fx.n; i++) { var f = S.fx.a[i]; if (f.tp === 3) continue; nc.globalAlpha = clamp(1 - f.t / f.max, 0, 1); nc.drawImage(sprLuz, f.x - f.r * 1.9, f.y - f.r * 1.9, f.r * 3.8, f.r * 3.8); }
    nc.globalAlpha = 1;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(noiteCv, 0, 0, cv.width, cv.height);
    ctx.restore();
  }
  function desenharFacho() {                                                  /* facho quente da lanterna, seguindo a mira */
    if (!cfg.noite || cfg.luz >= 100 || !sprCone || document.documentElement.classList.contains('lite')) return;
    if (!sprConeQ) {
      sprConeQ = mkCanvas(sprCone.width, sprCone.height); var q = sprConeQ.getContext('2d');
      q.drawImage(sprCone, 0, 0); q.globalCompositeOperation = 'source-in'; q.fillStyle = 'rgb(255,214,150)'; q.fillRect(0, 0, sprConeQ.width, sprConeQ.height);
    }
    var Lc = compCone() + Math.sin(S.t * 13) * 3;
    ctx.save(); ctx.translate(J.x, J.y); ctx.rotate(J.ang);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.2;
    ctx.drawImage(sprConeQ, 0, -Lc * 0.495, Lc, Lc * 0.99);
    ctx.restore();
  }
  function desenharLuz(x0, y0, x1, y1) {
    if (cfg.luz >= 100 || !luzCv) return;
    var lc = luzCtx, z = view.zoom * view.pxr, k = luzCv.width / cv.width, sc = z * k;
    var ex = Math.round((view.w / 2 - cam.x * view.zoom + tremor.x) * view.pxr) * k, ey = Math.round((view.h / 2 - cam.y * view.zoom + tremor.y) * view.pxr) * k;
    lc.globalCompositeOperation = 'source-over'; lc.setTransform(1, 0, 0, 1, 0, 0);
    var cor = 'rgba(3,5,4,' + ESCURO + ')';
    lc.fillStyle = cor; lc.fillRect(0, 0, luzCv.width, luzCv.height);
    lc.setTransform(sc, 0, 0, sc, ex, ey);
    lc.globalCompositeOperation = 'destination-out';
    var R = raioLuz(), Lc = compCone() + Math.sin(S.t * 13) * 3, tg = 0.495;
    lc.drawImage(sprLuz, J.x - R, J.y - R, R * 2, R * 2);
    lc.save(); lc.translate(J.x, J.y); lc.rotate(J.ang);
    lc.drawImage(sprCone, 0, -Lc * tg, Lc, Lc * tg * 2);
    lc.restore();
    var i;
    for (i = 0; i < ESTACOES.length; i++) {                                    /* postos brilham de longe */
      var e = ESTACOES[i];
      if (e.x < x0 || e.x > x1 || e.y < y0 || e.y > y1) continue;
      lc.globalAlpha = 0.7; lc.drawImage(sprLuz, e.x - 110, e.y - 110, 220, 220);
    }
    for (i = 0; i < S.drops.n; i++) { var d = S.drops.a[i]; lc.globalAlpha = 0.85; lc.drawImage(sprLuz, d.x - 70, d.y - 70, 140, 140); }
    for (i = 0; i < pFogoZ.n; i++) { var fz = pFogoZ.a[i]; lc.globalAlpha = 0.9; lc.drawImage(sprLuz, fz.x - fz.r * 1.6, fz.y - fz.r * 1.6, fz.r * 3.2, fz.r * 3.2); }     /* o fogo ilumina */
    for (i = 0; i < pRastro.n; i++) { var rz = pRastro.a[i]; lc.globalAlpha = 0.5; lc.drawImage(sprLuz, rz.x - 34, rz.y - 34, 68, 68); }                             /* rastro tóxico brilha */
    for (i = 0; i < pMinas.n; i++) { var mz = pMinas.a[i]; lc.globalAlpha = 0.6; lc.drawImage(sprLuz, mz.x - 26, mz.y - 26, 52, 52); }
    for (i = 0; i < MAXZ; i++) if (queima[i] > 0) { var oz = i * ZS, Zq = V.Z; if (Zq[oz] > 0.5) { lc.globalAlpha = 0.8; lc.drawImage(sprLuz, Zq[oz + 1] - 62, Zq[oz + 2] - 62, 124, 124); } }
    if (J.fogoT > 0) { lc.globalAlpha = 0.9; lc.drawImage(sprLuz, J.x - 90, J.y - 90, 180, 180); }
    lc.globalAlpha = 1;
    lc.globalCompositeOperation = 'source-over'; lc.fillStyle = cor;           /* sombras dos obstáculos, projetadas a partir do jogador */
    for (i = 0; i < OBST.length; i++) {
      var o = OBST[i];
      if (o.x > x1 || o.x + o.w < x0 || o.y > y1 || o.y + o.h < y0) continue;
      sombraAresta(lc, o.x, o.y, o.x + o.w, o.y, 0, -1); sombraAresta(lc, o.x + o.w, o.y, o.x + o.w, o.y + o.h, 1, 0);
      sombraAresta(lc, o.x + o.w, o.y + o.h, o.x, o.y + o.h, 0, 1); sombraAresta(lc, o.x, o.y + o.h, o.x, o.y, -1, 0);
    }
    lc.globalCompositeOperation = 'destination-out';                           /* luzes que ignoram sombras: clarão do tiro e explosões */
    if (S.brilhoTiro > 0) { lc.globalAlpha = 0.9; lc.drawImage(sprLuz, J.x - 170, J.y - 170, 340, 340); }
    for (i = 0; i < S.fx.n; i++) { var f = S.fx.a[i]; if (f.tp === 3) continue; lc.globalAlpha = clamp(1 - f.t / f.max, 0, 1); lc.drawImage(sprLuz, f.x - f.r * 1.9, f.y - f.r * 1.9, f.r * 3.8, f.r * 3.8); }
    lc.globalAlpha = 1; lc.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(luzCv, 0, 0, cv.width, cv.height);
    ctx.restore();
  }
  /* neblina: manchas suaves e lentas, desenhadas ANTES da escuridão (então só aparecem onde há luz) */
  function desenharNevoa() {
    if (!sprNevoa) return;
    var vw = view.w / view.zoom, vh = view.h / view.zoom;
    ctx.globalAlpha = 0.12;
    for (var i = 0; i < 6; i++) {
      var nx = cam.x + Math.sin(S.t * 0.07 + i * 1.9) * vw * 0.4, ny = cam.y + Math.cos(S.t * 0.05 + i * 2.3) * vh * 0.4, tam = 420 + i * 50;
      ctx.drawImage(sprNevoa, nx - tam / 2, ny - tam / 2, tam, tam);
    }
    ctx.globalAlpha = 1;
  }
  /* olhos brilhantes: aparecem no escuro (depois da camada de escuridão); mais fortes fora da luz */
  function desenharOlhos(x0, y0, x1, y1) {
    if (!sprOlhos.length) return;
    var Zv = V.Z, v = cfg.luz / 100, R = raioLuz(), Lc = compCone(), ca = Math.cos(J.ang), sa = Math.sin(J.ang);
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < MAXZ; i++) {
      var o = i * ZS;
      if (Zv[o] < 0.5 || Zv[o + 12] < 0.6) continue;
      var zx = Zv[o + 1], zy = Zv[o + 2];
      if (zx < x0 || zx > x1 || zy < y0 || zy > y1) continue;
      var tp = Zv[o + 11] | 0, rr = Zv[o + 6], hx = Zv[o + 7], hy = Zv[o + 8];
      var fur = tp === 4 && Zv[o + 3] < Zv[o + 4];
      var dx = zx - J.x, dy = zy - J.y, d = hip(dx, dy) || 1;
      var lit = v >= 0.995 || d < R * 0.75 || (d < Lc && (dx * ca + dy * sa) / d > 0.9);
      ctx.globalAlpha = fur ? 1 : (lit ? 0.5 : 0.95);
      var s = fur ? rr * 0.55 : 3 + rr * 0.12, fx = zx + hx * rr * 0.55, fy = zy + hy * rr * 0.55, lx = -hy * rr * 0.3, ly = hx * rr * 0.3, spr = sprOlhos[tp];
      ctx.drawImage(spr, fx + lx - s, fy + ly - s, s * 2, s * 2);
      ctx.drawImage(spr, fx - lx - s, fy - ly - s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }

  function desenhar() {
    var W = view.w, H = view.h, z = view.zoom, px = view.pxr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#050706'; ctx.fillRect(0, 0, cv.width, cv.height);
    var tx = tremor.x, ty = tremor.y;
    /* o deslocamento é arredondado para pixels inteiros do dispositivo: com a câmera em posição fracionária, a textura do chão
     * e as bordas dos sprites são reamostradas a cada quadro e "tremem" (cintilação) enquanto o personagem anda */
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(z * px, 0, 0, z * px, Math.round((W / 2 - cam.x * z + tx) * px), Math.round((H / 2 - cam.y * z + ty) * px));
    var vw = W / z, vh = H / z, x0 = cam.x - vw / 2 - 60, y0 = cam.y - vh / 2 - 60, x1 = cam.x + vw / 2 + 60, y1 = cam.y + vh / 2 + 60;

    ctx.fillStyle = chao; ctx.fillRect(MUNDO.p - 2, MUNDO.p - 2, MUNDO.w - 2 * MUNDO.p + 4, MUNDO.h - 2 * MUNDO.p + 4);
    if (goreCv) {                                                    /* sangue/cadáveres persistentes: só a janela visível, um drawImage */
      var gs = goreEsc, gx0 = Math.max(0, x0 + 60), gy0 = Math.max(0, y0 + 60), gx1 = Math.min(MUNDO.w, x1 - 60), gy1 = Math.min(MUNDO.h, y1 - 60);
      if (gx1 > gx0 && gy1 > gy0) ctx.drawImage(goreCv, gx0 * gs, gy0 * gs, (gx1 - gx0) * gs, (gy1 - gy0) * gs, gx0, gy0, gx1 - gx0, gy1 - gy0);
    }
    ctx.drawImage(decalCv, 0, 0, decalCv.width, decalCv.height, 0, 0, MUNDO.w, MUNDO.h);        /* só marcas de queimadura (somem a cada rodada) */
    desenharGoreDinamico(x0, y0, x1, y1);
    desenharEstacoes();
    desenharEstatico(x0, y0, x1, y1);
    desenharBrilhoJanelas();
    desenharNuvens();
    desenharDrops();
    desenharExtrasChao(x0, y0, x1, y1);
    desenharZumbis(x0, y0, x1, y1);
    desenharJogador();
    desenharFogoCima(x0, y0, x1, y1);
    desenharBalas();
    desenharParticulas(x0, y0, x1, y1);
    desenharNevoa();
    desenharNoite(x0, y0, x1, y1);
    desenharLuz(x0, y0, x1, y1);
    desenharFacho();
    desenharOlhos(x0, y0, x1, y1);
    desenharTextos();

    /* luz do tiro */
    if (S.brilhoTiro > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(brilhoCor('#ffbe5a', 0.3), J.x - 230, J.y - 230, 460, 460);
      ctx.globalCompositeOperation = 'source-over';
    }

    /* camadas de tela */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(vinheta, 0, 0, cv.width, cv.height);
    var baixa = estado === 'jogando' && J.vida < 30 ? (0.25 + 0.2 * Math.sin(S.t * 6)) * (1 - J.vida / 30) * 2 : 0;
    var vermelho = Math.max(S.dano * 0.85, baixa);
    if (vermelho > 0.01) { ctx.globalAlpha = clamp(vermelho, 0, 1); ctx.drawImage(vinhetaDano, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1; }
    if (S.tens > 0.02) { var pl = 0.5 + 0.5 * Math.sin(S.t * 10); ctx.globalAlpha = clamp(S.tens / 3, 0, 1) * (0.22 + 0.5 * pl); ctx.drawImage(vinhetaDano, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1; }
    if (S.gas > 0.01) { ctx.globalAlpha = clamp(S.gas, 0, 1) * 0.9; ctx.drawImage(vinhetaGas, 0, 0, cv.width, cv.height); ctx.globalAlpha = 1; }
    ctx.setTransform(px, 0, 0, px, 0, 0);
    if (estado === 'jogando') desenharIndicadores();
  }

  /* =====================  TELA / REDIMENSIONAMENTO  ===================== */
  function criarCamadas() {
    var w = Math.max(2, (cv.width / 3) | 0), h = Math.max(2, (cv.height / 3) | 0);
    vinheta = document.createElement('canvas'); vinheta.width = w; vinheta.height = h;
    var g = vinheta.getContext('2d');
    var r = hip(w, h) / 2;
    var gr = g.createRadialGradient(w / 2, h / 2, r * 0.28, w / 2, h / 2, r * 1.02);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.65, 'rgba(0,0,0,.34)'); gr.addColorStop(1, 'rgba(0,0,0,.82)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    luzCv = mkCanvas(Math.max(2, (cv.width * 0.5) | 0), Math.max(2, (cv.height * 0.5) | 0)); luzCtx = luzCv.getContext('2d');
    vinhetaGas = document.createElement('canvas'); vinhetaGas.width = w; vinhetaGas.height = h;
    var gg = vinhetaGas.getContext('2d');
    var gz = gg.createRadialGradient(w / 2, h / 2, r * 0.15, w / 2, h / 2, r * 0.95);
    gz.addColorStop(0, 'rgba(120,170,30,.18)'); gz.addColorStop(1, 'rgba(120,170,30,.62)');
    gg.fillStyle = gz; gg.fillRect(0, 0, w, h);
    vinhetaDano = document.createElement('canvas'); vinhetaDano.width = w; vinhetaDano.height = h;
    g = vinhetaDano.getContext('2d');
    gr = g.createRadialGradient(w / 2, h / 2, r * 0.3, w / 2, h / 2, r * 0.95);
    gr.addColorStop(0, 'rgba(160,0,0,0)'); gr.addColorStop(1, 'rgba(190,10,16,.85)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  }
  var sprCache = {}, chaoCache = {}, nivelSpr = 0, resPend = false;
  function ajustarSprites() {
    var nivel = MV.Sprites.escolherNivel(view.zoom * view.pxr);
    if (nivel === nivelSpr) return;
    nivelSpr = nivel;
    for (var kk in sprCache) if (+kk !== nivel) delete sprCache[kk];      /* libera da memória os níveis de sprite que não estão em uso */
    for (kk in chaoCache) if (+kk !== nivel) delete chaoCache[kk];
    sprites = sprCache[nivel] || (sprCache[nivel] = MV.Sprites.criarZumbis(nivel));
    chao = chaoCache[nivel] || (chaoCache[nivel] = MV.Sprites.criarChao(ctx, nivel));
  }
  /* zoom efetivo = zoom automático pela tela × ajuste do jogador (60–160%). Seguro em tempo real. */
  function zoomFinal() { return clamp((view.zoomBase || 1) * cfg.zoom / 100, 0.4, 2.6); }
  /* aplica o zoom da câmera imediatamente: recalcula sprites/camada estática e redesenha (inclusive com o jogo pausado) */
  function aplicarZoom() {
    view.zoom = zoomFinal();
    ajustarSprites(); construirEstatico();
    if (sim && S) { V = sim.views ? sim.views() : V; desenhar(); }
  }
  function redimensionarAgora() {
    resPend = false;
    var w = app.clientWidth || window.innerWidth, h = app.clientHeight || window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2) * view.escala;
    var cw = Math.max(2, Math.round(w * dpr)), ch = Math.max(2, Math.round(h * dpr));
    if (cw === cv.width && ch === cv.height && w === view.w && h === view.h) return;   /* nada mudou: não zera o canvas à toa */
    view.w = w; view.h = h; view.dpr = dpr;
    cv.width = cw; cv.height = ch;            /* redimensionar zera o canvas; por isso redesenhamos logo abaixo */
    view.pxr = cv.width / w;
    view.zoomBase = clamp(Math.min(w, h) / 520, 0.55, 1.6);
    view.zoom = zoomFinal();
    ajustarSprites();
    construirEstatico();
    criarCamadas();
    if (sim && S) { V = sim.views ? sim.views() : V; desenhar(); }   /* sem isso, a tela fica preta até o próximo quadro (e para sempre na pausa) */
  }
  /* vários eventos disparam ao girar o aparelho; juntamos tudo em uma única realocação por quadro */
  function redimensionar() {
    if (resPend) return;
    resPend = true; requestAnimationFrame(redimensionarAgora);
  }

  /* qualidade adaptativa: reduz a resolução se o aparelho não acompanhar */
  var qual = { lento: 0, rapido: 0 };
  function adaptarQualidade(ms) {
    perf.quadro += (ms - perf.quadro) * 0.05;
    if (estado !== 'jogando' && !demo) return;
    if (perf.quadro > 26) { qual.lento += ms / 1000; qual.rapido = 0; } else { qual.lento = Math.max(0, qual.lento - ms / 2000); }
    if (qual.lento > 2.5) {
      qual.lento = 0;
      if (!document.documentElement.classList.contains('lite')) document.documentElement.classList.add('lite');
      else if (view.escala > 0.6) { view.escala = Math.max(0.6, view.escala * 0.85); redimensionar(); }
    }
  }

  /* =====================  ENTRADA  ===================== */
  var stick = { id: null, ox: 0, oy: 0, raio: 50 };
  function configurarEntrada() {
    var zona = el.stickZona, base = el.stickBase, knob = el.stickKnob;
    function posBaseOriginal() { base.style.left = ''; base.style.top = ''; base.style.bottom = ''; }
    zona.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || stick.id !== null || estado !== 'jogando' || S.lojaAberta) return;
      Som.iniciar();
      stick.id = e.pointerId;
      try { zona.setPointerCapture(e.pointerId); } catch (er) { }
      var r = app.getBoundingClientRect(), bs = base.offsetWidth;
      stick.raio = bs / 2;
      stick.ox = clamp(e.clientX - r.left, bs / 2 + 8, r.width * 0.52 - 8);
      stick.oy = clamp(e.clientY - r.top, bs / 2 + 8, r.height - bs / 2 - 8);
      base.style.left = (stick.ox - bs / 2) + 'px'; base.style.top = (stick.oy - bs / 2) + 'px'; base.style.bottom = 'auto';
      base.classList.add('on'); knob.style.transform = '';
      moverStick(e);
    });
    function moverStick(e) {
      var r = app.getBoundingClientRect();
      var dx = e.clientX - r.left - stick.ox, dy = e.clientY - r.top - stick.oy;
      var l = hip(dx, dy), max = stick.raio;
      var kx = dx, ky = dy;
      if (l > max) { kx = dx / l * max; ky = dy / l * max; }
      knob.style.transform = 'translate(' + kx + 'px,' + ky + 'px)';
      var m = Math.min(1, l / max);
      if (m < 0.12) { IN.mx = 0; IN.my = 0; return; }
      m = (m - 0.12) / 0.88;
      IN.mx = dx / l * m; IN.my = dy / l * m;
    }
    zona.addEventListener('pointermove', function (e) { if (e.pointerId === stick.id) moverStick(e); });
    function soltarStick(e) {
      if (e.pointerId !== stick.id) return;
      stick.id = null; IN.mx = 0; IN.my = 0; base.classList.remove('on'); knob.style.transform = ''; posBaseOriginal();
    }
    zona.addEventListener('pointerup', soltarStick); zona.addEventListener('pointercancel', soltarStick);

    /* botão ATIRAR: segurar atira (mira automática); arrastar mira manualmente */
    var fogo = el.btnAtirar, fogoId = null, centro = { x: 0, y: 0 };
    fogo.addEventListener('pointerdown', function (e) {
      if (fogoId !== null || estado !== 'jogando' || S.lojaAberta) return;
      Som.iniciar(); e.preventDefault();
      fogoId = e.pointerId; try { fogo.setPointerCapture(e.pointerId); } catch (er) { }
      var r = fogo.getBoundingClientRect(); centro.x = r.left + r.width / 2; centro.y = r.top + r.height / 2;
      IN.atirar = true; IN.miraBotao = null; fogo.classList.add('on');
    });
    fogo.addEventListener('pointermove', function (e) {
      if (e.pointerId !== fogoId) return;
      var dx = e.clientX - centro.x, dy = e.clientY - centro.y;
      IN.miraDist = hip(dx, dy);
      if (IN.miraDist > 26) IN.miraBotao = Math.atan2(dy, dx); else IN.miraBotao = null;
    });
    function soltarFogo(e) { if (e.pointerId !== fogoId) return; fogoId = null; IN.atirar = false; IN.miraBotao = null; fogo.classList.remove('on'); }
    fogo.addEventListener('pointerup', soltarFogo); fogo.addEventListener('pointercancel', soltarFogo);

    function botao(b, fn) {
      b.addEventListener('pointerdown', function (e) { if (estado !== 'jogando') return; e.preventDefault(); Som.iniciar(); fn(); b.classList.add('on'); });
      var off = function () { b.classList.remove('on'); };
      b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
    }
    /* CORRER (lado direito): mantém pressionado; com autoAim desligado a zona de mira arrasta o ângulo de tiro */
    var corrId = null;
    el.btnCorrer.addEventListener('pointerdown', function (e) {
      if (corrId !== null || estado !== 'jogando' || S.lojaAberta) return;
      e.preventDefault(); Som.iniciar(); corrId = e.pointerId; try { el.btnCorrer.setPointerCapture(e.pointerId); } catch (er) { }
      IN.correr = true; el.btnCorrer.classList.add('on');
    });
    function soltarCorrer(e) { if (e.pointerId !== corrId) return; corrId = null; IN.correr = false; el.btnCorrer.classList.remove('on'); }
    el.btnCorrer.addEventListener('pointerup', soltarCorrer); el.btnCorrer.addEventListener('pointercancel', soltarCorrer);
    var miraId = null;
    function angDoToque(e) {
      var r = app.getBoundingClientRect();
      var sx = (J.x - cam.x) * view.zoom + view.w / 2, sy = (J.y - cam.y) * view.zoom + view.h / 2;
      IN.miraDist = hip(e.clientY - r.top - sy, e.clientX - r.left - sx);       /* distância do toque ao soldado: > 60 px = intenção de mirar à mão */
      return Math.atan2(e.clientY - r.top - sy, e.clientX - r.left - sx);
    }
    el.miraZona.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' || miraId !== null || estado !== 'jogando' || S.lojaAberta) return;
      Som.iniciar(); miraId = e.pointerId; try { el.miraZona.setPointerCapture(e.pointerId); } catch (er) { }
      IN.miraBotao = angDoToque(e);
    });
    el.miraZona.addEventListener('pointermove', function (e) { if (e.pointerId === miraId) IN.miraBotao = angDoToque(e); });
    function soltarMira(e) { if (e.pointerId !== miraId) return; miraId = null; IN.miraBotao = null; }
    el.miraZona.addEventListener('pointerup', soltarMira); el.miraZona.addEventListener('pointercancel', soltarMira);
    botao(el.btnRecarregar, function () { iniciarRecarga(false); });
    botao(el.btnTrocar, function () { trocarArma(); });
    botao(el.btnGranada, function () { lancarGranada(); });
    botao(el.btnMolotov, function () { lancarMolotov(); });
    botao(el.btnMina, function () { plantarMina(); });
    el.btnLoja.addEventListener('click', function () { if (podeAbrirLoja()) abrirLoja(); });

    /* mouse e teclado (computador) */
    app.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var r = app.getBoundingClientRect();
      IN.mouse = { x: (e.clientX - r.left - view.w / 2) / view.zoom + cam.x, y: (e.clientY - r.top - view.h / 2) / view.zoom + cam.y };
      IN.mouseAtivo = true;
    });
    app.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0 || estado !== 'jogando' || S.lojaAberta) return;
      if (e.target.closest && e.target.closest('button')) return;
      Som.iniciar(); IN.atirar = true; IN.mouseAtivo = true;
      var r = app.getBoundingClientRect();
      IN.mouse = { x: (e.clientX - r.left - view.w / 2) / view.zoom + cam.x, y: (e.clientY - r.top - view.h / 2) / view.zoom + cam.y };
    });
    window.addEventListener('pointerup', function (e) { if (e.pointerType === 'mouse') IN.atirar = false; });
    window.addEventListener('keydown', function (e) {
      var k = e.key.toLowerCase();
      if (estado === 'jogando' && S.perkAberto) {                /* escolha de perk: teclas 1 / 2 / 3 */
        if (k === '1' || k === '2' || k === '3') escolherPerk(+k - 1);
        e.preventDefault(); return;
      }
      if (estado === 'jogando' && S.lojaAberta) {                /* a loja captura o teclado */
        if (k === 'escape' || k === 'e' || k === 'b') fecharLoja();
        else if (k === 'arrowleft' || k === 'a') moverFocoLoja(-1, 0); else if (k === 'arrowright' || k === 'd') moverFocoLoja(1, 0);
        else if (k === 'arrowup' || k === 'w') moverFocoLoja(0, -1); else if (k === 'arrowdown' || k === 's') moverFocoLoja(0, 1);
        else if (k === 'enter' || k === ' ') acaoLoja('principal'); else if (k === 'm') acaoLoja('mun'); else if (k === 'n') acaoLoja('dual');
        e.preventDefault(); return;
      }
      if (k === 'escape' || k === 'p') { if (estado === 'jogando') pausar(); else if (estado === 'pausa') continuar(); return; }
      if (estado !== 'jogando') return;
      if (k === 'r') iniciarRecarga(false);
      else if (k === 'q' || k === 'tab') { e.preventDefault(); trocarArma(); }
      else if (k === '1') trocarArma(0); else if (k === '2') trocarArma(1); else if (k === '3') trocarArma(2); else if (k === '4') trocarArma(3); else if (k === '5') trocarArma(4);
      else if (k === 'g') lancarGranada();
      else if (k === 'f') lancarMolotov();
      else if (k === 'c') plantarMina();
      else if (k === 'e' || k === 'b') { if (podeAbrirLoja()) abrirLoja(); }
      else if (k === ' ') { e.preventDefault(); IN.atirar = true; }
      IN.teclas[k] = true;
      if (k.indexOf('arrow') === 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { var k = e.key.toLowerCase(); IN.teclas[k] = false; if (k === ' ') IN.atirar = false; });
    window.addEventListener('wheel', function (e) { if (estado === 'jogando' && !S.lojaAberta) trocarArma(); }, { passive: true });
    app.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (estado === 'jogando') pausar();
        cancelAnimationFrame(rafId); Som.suspender();   /* para o laço e o áudio por completo enquanto estiver oculto */
      } else {
        lastT = performance.now(); proxQuadro = 0; cancelAnimationFrame(rafId); rafId = requestAnimationFrame(quadro);
      }
    });
    window.addEventListener('blur', function () { if (estado === 'jogando') pausar(); });
    window.addEventListener('resize', redimensionar);
    window.addEventListener('orientationchange', function () { setTimeout(redimensionar, 120); });
    if (window.ResizeObserver) new ResizeObserver(function () { redimensionar(); }).observe(app);
  }

  /* =====================  LOJA DE ARMAS  =====================
   * Acesso: entre rodadas (fase 'intervalo', de qualquer lugar) ou sobre a ARMARIA (zona segura no mapa), mesmo em combate.
   * Em combate o tempo desacelera para 12% e a loja fecha sozinha se o jogador levar dano.
   * Itens: as 5 armas e a granada (consumível, até 6). Cada cartão tem COMPRAR/EQUIPAR e reposição de MUNIÇÃO. */
  function fatorPreco() { return dif.custoMun / 500 * inflacao() * (MV.Meta.tem('r07') ? 0.85 : 1); }   /* base da dificuldade × inflação do insano */
  function arred(n) { return Math.round(n / 10) * 10; }
  function precoArma(i) { return arred(ARMAS[i].preco * fatorPreco()); }
  function precoDual(i) { return arred(ARMAS[i].dual.preco * fatorPreco()); }
  function precoMun(i) { return arred(ARMAS[i].precoMun * fatorPreco()); }
  function precoEnergia() { return arred(300 * fatorPreco()); }
  function itensLoja() { return ARMAS.length + CONSUM.length + (dif.stamRegen === false ? 1 : 0); }   /* armas + consumíveis (+ energia no insano) */
  function precoGranada() { return arred(GRANADA.preco * fatorPreco()); }
  function precoMolotov() { return arred(MOLOTOV.preco * fatorPreco()); }
  function precoMina() { return arred(MINA.preco * fatorPreco()); }
  /* consumíveis da Armaria (cartões depois das armas). campo = contador no objeto do jogador J */
  var ICONE_MOLOTOV = 'M29 1h7v5l3 3.5V22a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 26 22V9.5l3-3.5z M31 11v9h3v-9z';
  var ICONE_MINA = 'M10 20a22 9 0 0 1 44 0z M30 5h4v6h-4z M23 12.5l2-2.5 M41 12.5l-2-2.5';
  var CONSUM = [
    { id: 'granada', obj: GRANADA, campo: 'granadas', icone: function () { return MV.Sprites.ICONE_GRANADA; }, preco: precoGranada, ok: 'GRANADA ADQUIRIDA' },
    { id: 'molotov', obj: MOLOTOV, campo: 'molotovs', icone: function () { return ICONE_MOLOTOV; }, preco: precoMolotov, ok: 'MOLOTOV ADQUIRIDO' },
    { id: 'mina', obj: MINA, campo: 'minas', icone: function () { return ICONE_MINA; }, preco: precoMina, ok: 'MINA ADQUIRIDA' }
  ];
  function consumDe(i) { var k = i - ARMAS.length; return k >= 0 && k < CONSUM.length ? CONSUM[k] : null; }
  function podeAbrirLoja() { return estado === 'jogando' && !demo && (S.fase === 'intervalo' || S.naArmaria); }

  function abrirLoja() {
    if (!podeAbrirLoja() || S.lojaAberta) return;
    S.lojaAberta = true; resetEntrada(); mostrarPrompt(null);
    S.lojaFoco = J.arma; S.lojaMsg = '';
    el.loja.hidden = false; el.btnLoja.hidden = true;
    Som.trocar();
    renderLoja();
  }
  function fecharLoja() {
    if (!S || !S.lojaAberta) return;
    S.lojaAberta = false; el.loja.hidden = true; lastT = performance.now();
  }
  function msgLoja(txt, erro) { S.lojaMsg = txt; S.lojaErro = !!erro; el.lojaMsg.textContent = txt; el.lojaMsg.classList.toggle('erro', !!erro); }

  function linhaEst(rot, txt, v) { return '<div><dt>' + rot + '</dt><dd>' + txt + '</dd><i style="--v:' + v.toFixed(2) + '"></i></div>'; }
  /* cartão do estimulante (só no Modo Insano): única forma de recuperar a energia da corrida */
  function cartaoEnergia(i) {
    var cheia = J.stam >= 99.5, cls = 'item' + (S.lojaFoco === i ? ' foco' : '');
    return '<article class="' + cls + '" data-i="' + i + '">' +
      '<div class="itemTopo"><svg viewBox="0 0 64 26" aria-hidden="true"><path d="M34 1 L21 15 H30 L26 25 L43 10 H34 Z"/></svg><div class="itemNome"><b>ESTIMULANTE</b><small>RECARGA DE ENERGIA</small></div><span class="tag">ENERGIA ' + Math.round(J.stam) + '%</span></div>' +
      '<p class="desc">No modo Insano a energia não se regenera. Restaura a barra de corrida por completo.</p>' +
      '<dl class="est">' + linhaEst('ENERGIA', Math.round(J.stam) + '%', J.stam / 100) + '</dl>' +
      '<div class="itemBtns"><button class="btn primario" data-acao="principal"' + (cheia ? ' disabled' : '') + '>' + (cheia ? 'ENERGIA CHEIA' : 'COMPRAR · ' + fmtNum(precoEnergia())) + '</button></div></article>';
  }
  function cartaoLoja(i) {
    if (i === ARMAS.length + CONSUM.length) return cartaoEnergia(i);
    var cs = consumDe(i), gr = !!cs, a = gr ? cs.obj : ARMAS[i];
    var possui = gr ? J[cs.campo] > 0 : S.possui[i], equipada = !gr && J.arma === i;
    var cls = 'item' + (possui ? ' posse' : '') + (equipada ? ' equipada' : '') + (S.lojaFoco === i ? ' foco' : '');
    var path = gr ? cs.icone() : MV.Sprites.ICONES_ARMA[i];
    var tag = gr ? ('ESTOQUE ' + J[cs.campo] + '/' + a.max) : (equipada ? 'EQUIPADA' : (possui ? 'NA MOCHILA' : 'BLOQUEADA'));
    var temDual = !gr && a.dual, dualOn = temDual && S.dual[i];
    var prim, sec = '';
    if (gr) {
      prim = J[cs.campo] >= a.max ? 'ESTOQUE CHEIO' : 'COMPRAR +1 · ' + fmtNum(cs.preco());
    } else if (!possui && a.exclusiva) prim = 'RESGATE EM RECOMPENSAS';
    else if (!possui) prim = precoArma(i) === 0 ? 'EQUIPAR' : 'COMPRAR · ' + fmtNum(precoArma(i));
    else if (equipada) prim = 'EQUIPADA';
    else prim = 'EQUIPAR';
    if (!gr && possui) {
      var st = armaEst[i], cheia = a.semRecarga ? st.mag >= penteMax(i) : st.res >= LIM[i].resMax;
      if (temDual) sec += dualOn ? '<button class="btn mini" disabled>2ª ARMA ADQUIRIDA</button>' : '<button class="btn mini destaque" data-acao="dual">COMPRAR 2ª ' + (i === IDX_PISTOLA ? 'PISTOLA' : 'MINI UZI') + ' · ' + fmtNum(precoDual(i)) + '</button>';
      if (a.semRecarga) sec += '<button class="btn mini destaque" data-acao="mun"' + (cheia ? ' disabled' : '') + '>' + (cheia ? 'PENTE CHEIO' : 'RECARGA CHEIA · ' + fmtNum(precoMun(i))) + '</button>';
      else sec += '<button class="btn mini" data-acao="mun"' + (cheia ? ' disabled' : '') + '>' + (cheia ? 'MUNIÇÃO CHEIA' : 'MUNIÇÃO · ' + fmtNum(precoMun(i))) + '</button>';
    }
    var municao = gr ? '' : (possui ? '<span class="itemMun">' + armaEst[i].mag + (a.semRecarga ? ' / ' + penteMax(i) : ' / ' + armaEst[i].res) + '</span>' : '');
    var desab = (gr && J[cs.campo] >= a.max) || equipada;
    return '<article class="' + cls + '" data-i="' + i + '">' +
      '<div class="itemTopo"><svg viewBox="0 0 64 26" aria-hidden="true"><path d="' + path + '"/></svg><div class="itemNome"><b>' + a.nome + '</b><small>' + a.tipo + '</small></div><span class="tag">' + tag + '</span></div>' +
      '<p class="desc">' + a.desc + '</p>' +
      '<dl class="est">' + linhaEst('DANO', a.exib.dano, a.barra[0]) + linhaEst('CADÊNCIA', a.exib.cad, a.barra[1]) + linhaEst('ALCANCE', a.exib.alc, a.barra[2]) + linhaEst('PENTE', a.exib.pente, a.barra[3]) + '</dl>' +
      '<div class="itemBtns"><button class="btn primario" data-acao="principal"' + (desab ? ' disabled' : '') + '>' + prim + '</button>' + sec + municao + '</div></article>';
  }
  function renderLoja() {
    var html = '';
    for (var i = 0; i < itensLoja(); i++) html += cartaoLoja(i);
    el.lojaGrade.innerHTML = html;
    el.lojaPontos.textContent = fmtNum(S.pontos);
    el.lojaMsg.textContent = S.lojaMsg || ''; el.lojaMsg.classList.toggle('erro', !!S.lojaErro);
    el.lojaDica.textContent = 'PREÇOS +' + Math.round((dif.escalaPreco || 0) * 100) + '% POR RODADA · ' + (MV.Gamepad.ativo ? 'D-PAD / ANALÓGICO NAVEGA · A COMPRA OU EQUIPA · Y MUNIÇÃO · RB 2ª ARMA · B FECHA' : 'TOQUE NOS BOTÕES · SETAS NAVEGAM · ENTER COMPRA/EQUIPA · M MUNIÇÃO · N 2ª ARMA · ESC FECHA');
    var f = el.lojaGrade.querySelector('.item.foco');
    if (f && f.scrollIntoView) { try { f.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { } }
  }
  function colunasLoja() {
    var cards = el.lojaGrade.children, n = 0;
    if (!cards.length) return 1;
    var top = cards[0].offsetTop;
    while (n < cards.length && cards[n].offsetTop === top) n++;
    return Math.max(1, n);
  }
  function moverFocoLoja(dx, dy) {
    var total = itensLoja(), cols = colunasLoja(), f = S.lojaFoco;
    if (dx) f = clamp(f + dx, 0, total - 1);
    if (dy) { var nf = f + dy * cols; if (nf >= 0 && nf < total) f = nf; else if (dy > 0 && f < total - 1 && Math.floor(f / cols) < Math.floor((total - 1) / cols)) f = total - 1; }
    if (f !== S.lojaFoco) { S.lojaFoco = f; Som.trocar(); renderLoja(); }
  }
  function acaoLoja(acao) {
    var pts0 = S.pontos;
    acaoLojaInterna(acao);
    if (S.pontos < pts0) { MV.Meta.inc('compras'); MV.Meta.checar(); }
  }
  function acaoLojaInterna(acao) {
    var i = S.lojaFoco, cs = consumDe(i), gr = !!cs;
    if (i === ARMAS.length + CONSUM.length) {                       /* estimulante (insano) */
      if (acao !== 'principal') return;
      if (J.stam >= 99.5) { msgLoja('ENERGIA JÁ ESTÁ CHEIA', true); Som.vazio(); }
      else if (S.pontos < precoEnergia()) { msgLoja('PONTOS INSUFICIENTES (' + fmtNum(precoEnergia()) + ')', true); Som.vazio(); }
      else { S.pontos -= precoEnergia(); J.stam = 100; J.exausto = false; Som.compra(); msgLoja('ENERGIA RESTAURADA'); }
    } else if (gr) {
      if (acao !== 'principal') return;
      if (J[cs.campo] >= cs.obj.max) { msgLoja('ESTOQUE CHEIO (' + cs.obj.max + ')', true); Som.vazio(); }
      else if (S.pontos < cs.preco()) { msgLoja('PONTOS INSUFICIENTES (' + fmtNum(cs.preco()) + ')', true); Som.vazio(); }
      else { S.pontos -= cs.preco(); J[cs.campo]++; Som.compra(); msgLoja(cs.ok); atualizarArmaHud(true); }
    } else if (acao === 'principal') {
      if (!S.possui[i] && ARMAS[i].exclusiva) { msgLoja('EXCLUSIVA: RESGATE EM RECOMPENSAS (MENU)', true); Som.vazio(); }
      else if (!S.possui[i]) {
        if (S.pontos < precoArma(i)) { msgLoja('PONTOS INSUFICIENTES (' + fmtNum(precoArma(i)) + ')', true); Som.vazio(); }
        else {
          S.pontos -= precoArma(i); S.possui[i] = true;
          armaEst[i].mag = penteMax(i); armaEst[i].res = LIM[i].resIni;
          trocarArma(i); Som.compra(); msgLoja(ARMAS[i].nome + ' ADQUIRIDA E EQUIPADA'); atualizarArmaHud(true);
        }
      } else if (J.arma !== i) { trocarArma(i); msgLoja(ARMAS[i].nome + ' EQUIPADA'); }
    } else if (acao === 'dual') {
      var ar = ARMAS[i];
      if (!ar.dual || !S.possui[i]) { msgLoja('ADQUIRA A ARMA PRIMEIRO', true); Som.vazio(); }
      else if (S.dual[i]) { msgLoja('VOCÊ JÁ USA AS DUAS', true); Som.vazio(); }
      else if (S.pontos < precoDual(i)) { msgLoja('PONTOS INSUFICIENTES (' + fmtNum(precoDual(i)) + ')', true); Som.vazio(); }
      else {
        S.pontos -= precoDual(i); aplicarDual(i, true);
        armaEst[i].mag = penteMax(i); armaEst[i].res = Math.min(LIM[i].resMax, armaEst[i].res + Math.round(ar.base.pente));
        trocarArma(i); Som.compra(); msgLoja(ar.nome + ' · MODO DUPLO ATIVADO'); atualizarArmaHud(true);
      }
    } else if (acao === 'mun') {
      if (!S.possui[i]) { msgLoja('ADQUIRA A ARMA PRIMEIRO', true); return; }
      var st = armaEst[i];
      if (ARMAS[i].semRecarga) {                                  /* Mini Gun: só um pente cheio de 2000 tiros, comprado inteiro aqui */
        if (st.mag >= penteMax(i)) { msgLoja('O PENTE JÁ ESTÁ CHEIO', true); Som.vazio(); }
        else if (S.pontos < precoMun(i)) { msgLoja('PONTOS INSUFICIENTES (' + fmtNum(precoMun(i)) + ')', true); Som.vazio(); }
        else { S.pontos -= precoMun(i); st.mag = penteMax(i); Som.compra(); msgLoja('MINI GUN: PENTE CHEIO (' + penteMax(i) + ' TIROS)'); atualizarArmaHud(true); }
        renderLoja(); return;
      }
      if (st.res >= LIM[i].resMax) { msgLoja('MUNIÇÃO JÁ ESTÁ CHEIA', true); Som.vazio(); }
      else if (S.pontos < precoMun(i)) { msgLoja('PONTOS INSUFICIENTES (' + fmtNum(precoMun(i)) + ')', true); Som.vazio(); }
      else { S.pontos -= precoMun(i); st.res = LIM[i].resMax; Som.compra(); msgLoja('MUNIÇÃO REPOSTA: ' + ARMAS[i].nome); atualizarArmaHud(true); }
    }
    renderLoja();
  }

  /* botões do controle (bordas de descida vindas do GamepadManager) */
  function aoBotaoPad(n) {
    if (estado === 'intro') { MV.Intro.botao(n); return; }
    var tn = telaNav();
    if (tn && !(estado === 'jogando' && tn === el.menu)) { navegarPad(tn, n); return; }       /* menus, pausa, config, créditos, campanha, fim de jogo */
    if (estado !== 'jogando') return;
    if (S.perkAberto) return;
    if (S.lojaAberta) {
      if (n === 'cima') moverFocoLoja(0, -1); else if (n === 'baixo') moverFocoLoja(0, 1);
      else if (n === 'esq') moverFocoLoja(-1, 0); else if (n === 'dir') moverFocoLoja(1, 0);
      else if (n === 'a') acaoLoja('principal'); else if (n === 'y' || n === 'x') acaoLoja('mun'); else if (n === 'rb') acaoLoja('dual');
      else if (n === 'b' || n === 'view') fecharLoja();
      return;
    }
    if (n === 'y' || n === 'dir') trocarArma(undefined, 1);
    else if (n === 'esq') trocarArma(undefined, -1);
    else if (n === 'lb' || n === 'lt') lancarGranada();
    else if (n === 'cima' || n === 'r3') lancarMolotov();
    else if (n === 'baixo') plantarMina();
    else if (n === 'rb' || n === 'b') iniciarRecarga(false);
    else if (n === 'view' || (n === 'a' && S.naArmaria)) { if (podeAbrirLoja()) abrirLoja(); }
    else if (n === 'menu') pausar();
  }

  /* =====================  FLUXO DE TELAS  ===================== */
  function mostrar(tela) {
    el.menu.hidden = tela !== 'menu'; el.pausa.hidden = tela !== 'pausa'; el.fim.hidden = tela !== 'fim';
    var jogo = tela === 'jogo' || tela === 'pausa' || tela === 'fim';
    el.hud.hidden = !jogo; el.controles.hidden = !jogo;
  }
  function resetEntrada() {
    IN.atirar = false; IN.miraBotao = null; IN.mx = 0; IN.my = 0; IN.teclas = {}; IN.correr = false; stick.id = null;
    el.stickBase.classList.remove('on'); el.stickKnob.style.transform = ''; el.stickBase.style.left = ''; el.stickBase.style.top = ''; el.stickBase.style.bottom = '';
  }
  /* INTRO: estado 'intro' = nem simulação (WASM) nem mundo são atualizados/desenhados; só o #intro (intro.js) fica na tela.
   * O callback roda uma vez, ao fim das 4 telas ou ao pular, e é ele que chama novoJogo(). */
  function comIntro(cb) {
    if (!MV.Intro) { cb(); return; }
    estado = 'intro'; resetEntrada(); Som.ambiente(false); mostrar('intro');
    MV.Intro.tocar(cb);
  }
  function entrarMenu() {
    salvarAuto();
    estado = 'menu'; demo = true;
    novoEstado(); prepararMundo(); limparCamadas();
    J.x = INICIO.x; J.y = INICIO.y; S.tSpawn = 0.5;
    Som.silencio = true;
    atualizarRecorde();
    resetEntrada(); mostrar('menu'); fecharOverlays(); atualizarSlotAtivo();
    Som.ambiente(false);
  }
  function atualizarRecorde() {
    var rec = lerRecorde();
    el.recorde.textContent = rec ? 'MELHOR REGISTRO (' + dif.nome + '): RODADA ' + rec.rodada + ' · ' + fmtNum(rec.pontos) + ' PTS' : '';
  }
  function escolherDif(id) {
    if (!DIFS[id]) return;
    dif = DIFS[id]; guardar('mv_dif', id);
    var bs = el.nivelGrupo.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) { var on = bs[i].getAttribute('data-dif') === id; bs[i].classList.toggle('ativo', on); bs[i].setAttribute('aria-checked', on ? 'true' : 'false'); }
    el.nivelDesc.textContent = DESC_DIF[id];
    atualizarRecorde();
  }
  var DESC_DIF = {
    facil: 'Inimigos fracos, lentos e que causam menos dano. Suprimentos em abundância.',
    normal: 'Equilíbrio padrão de dano, velocidade e quantidade de infectados.',
    dificil: 'Inimigos rápidos, resistentes e letais. Suprimentos escassos e mais especiais.',
    insano: 'Zumbis duros e inteligentes que esquivam e se curam. Especiais em toda rodada, lanterna a 40%, energia só na Armaria e preços que sobem a cada rodada.'
  };
  function limparCamadas() {
    decalCtx.clearRect(0, 0, decalCv.width, decalCv.height);
    goreLimpar();
    for (var i = 0; i < MAXP; i++) P.vida[i] = 0;
    pTexto.n = 0;
    for (i = 0; i < JANELAS.length; i++) JANELAS[i].brilho = 0;
    for (i = 0; i < ESTACOES.length; i++) ESTACOES[i].cd = 0;
    tremor.amp = 0;
  }
  function novoJogo(ck) {
    ck = ck && ck.possui ? ck : null;
    Som.iniciar(); Som.silencio = false;
    demo = false; estado = 'jogando';
    fecharOverlays(); fila.length = 0; toastT = 0; el.toastConq.hidden = true;
    novoEstado(); prepararMundo(); limparCamadas();
    if (ck) aplicarCk(ck);
    aplicarBonusPerfil(!ck, ck);
    Meta.inc('partidas');
    avisoHud = {};
    cam.x = J.x; cam.y = J.y;
    mostrar('jogo'); resetEntrada();
    atualizarArmaHud(true);
    el.aviso.hidden = true; el.prompt.hidden = true; el.efeitos.innerHTML = '';
    el.dica.hidden = false; el.dica.style.opacity = '1';
    el.dica.textContent = window.matchMedia('(pointer: coarse)').matches
      ? 'ANALÓGICO MOVE · SEGURE ATIRAR · CORRER (DIREITA) GASTA ENERGIA'
      : 'WASD MOVE · SHIFT CORRE · MOUSE MIRA E ATIRA · R RECARREGA · Q TROCA';
    S.dica = 9;
    Som.ambiente(true);
    iniciarRodada(ck ? clamp(ck.rodada | 0, 1, 999) : 1);
    el.btnSom.textContent = 'SOM: ' + (Som.ligado ? 'LIGADO' : 'DESLIGADO');
  }
  function pausar() {
    if (estado !== 'jogando' || S.perkAberto) return;
    el.config.hidden = true;
    fecharLoja();
    salvarAuto();
    estado = 'pausa'; resetEntrada(); mostrar('pausa');
    el.motorPausa.textContent = 'NÍVEL ' + dif.nome + ' · ' + textoMotor() + ' · simulação ' + perf.sim.toFixed(2).replace('.', ',') + ' ms/quadro';
    el.btnSom.textContent = 'SOM: ' + (Som.ligado ? 'LIGADO' : 'DESLIGADO');
    Som.ambiente(false);
  }
  function continuar() {
    if (estado !== 'pausa') return;
    estado = 'jogando'; mostrar('jogo'); Som.ambiente(true); Som.retomar(); lastT = performance.now();
  }
  function lerRecorde() { try { return JSON.parse(ler('mv_recorde_' + dif.id)); } catch (e) { return null; } }
  function fimDeJogo() {
    estado = 'fim'; resetEntrada();
    Som.fim(); Som.ambiente(false);
    if (!demo) { LEG.max('rodadaMax', S.rodada); LEG.checar(); LEG.salvar(true); }
    if (Meta.slot) { Meta.checar(); Meta.salvar(undefined, { rodadaMax: Meta.stat('rodadaMax') }); }
    S.dano = 1;
    var rec = lerRecorde(), novo = !rec || S.rodada > rec.rodada || (S.rodada === rec.rodada && S.pontos > rec.pontos);
    if (novo) guardar('mv_recorde_' + dif.id, JSON.stringify({ rodada: S.rodada, pontos: Math.floor(S.pontos) }));
    setTimeout(function () {
      if (estado !== 'fim') return;
      el.fimRodada.textContent = S.rodada; el.fimNivel.textContent = dif.nome + ' · ' + dif.patente;
      el.fimPontos.textContent = fmtNum(S.pontos); el.fimAbates.textContent = fmtNum(S.abates);
      var seg = Math.floor(S.tempo); el.fimTempo.textContent = Math.floor(seg / 60) + ':' + ('0' + (seg % 60)).slice(-2);
      el.fimRecorde.textContent = novo ? 'NOVO RECORDE NO NÍVEL ' + dif.nome + '!' : (rec ? 'Melhor registro: rodada ' + rec.rodada + ' · ' + fmtNum(rec.pontos) + ' pts' : '');
      var sv = Meta.slot && Meta.ler(Meta.slot); el.btnFimCarregar.hidden = !(sv && sv.ck);
      mostrar('fim');
    }, 1500);
  }
  function textoMotor() { return simTipo === 'wasm' ? 'Motor de física: WebAssembly' : 'Motor de física: JavaScript (modo de compatibilidade)'; }

  /* seletor de skin do menu: 4 botões com pré-visualização do soldado (mesma rotina de desenho do jogo) */
  function montarSkins() {
    var h = '', i;
    for (i = 0; i < SKINS.length; i++) h += '<button type="button" role="radio" data-skin="' + i + '" aria-checked="false" aria-label="' + SKINS[i].nome + '"><canvas width="64" height="64"></canvas><small>' + SKINS[i].nome + '</small></button>';
    el.skinGrupo.innerHTML = h;
    var bs = el.skinGrupo.querySelectorAll('button');
    for (i = 0; i < bs.length; i++) {
      var g = bs[i].querySelector('canvas').getContext('2d');
      g.save(); g.translate(30, 34); g.scale(1.9, 1.9); g.rotate(-0.45); g.lineCap = 'round'; g.lineJoin = 'round';
      pintarSoldado(g, SKINS[i], 1, 0, 0, 0, false);
      g.restore();
      bs[i].addEventListener('click', function (e) { escolherSkin(+e.currentTarget.getAttribute('data-skin')); });
    }
    escolherSkin(cfg.skin, true);
    atualizarSkinsLock();
  }
  /* skins bloqueadas pela conquista aparecem desativadas com um cadeado até o desbloqueio */
  function atualizarSkinsLock() {
    if (!el.skinGrupo) return;
    var bs = el.skinGrupo.querySelectorAll('button');
    for (var k = 0; k < bs.length; k++) {
      var livre = skinLivre(k); bs[k].disabled = !livre; bs[k].classList.toggle('bloq', !livre);
      var sm = bs[k].querySelector('small'); if (sm) sm.textContent = livre ? SKINS[k].nome : 'BLOQUEADA';
    }
    if (!skinLivre(cfg.skin)) escolherSkin(0, true);
  }
  function escolherSkin(i, semSalvar) {
    i = clamp(i | 0, 0, SKINS.length - 1); if (!skinLivre(i)) i = 0;
    cfg.skin = i;
    if (!semSalvar) salvarCfg();
    var bs = el.skinGrupo.querySelectorAll('button');
    for (var k = 0; k < bs.length; k++) { var on = k === cfg.skin; bs[k].classList.toggle('ativo', on); bs[k].setAttribute('aria-checked', on ? 'true' : 'false'); }
  }
  var atualizarPadUI = null;   /* definida em configurarBotoes (painel de mapeamento do controle) */
  function configurarBotoes() {
    el.btnJogar.addEventListener('click', function () { Meta.sair(); atualizarSlotAtivo(); comIntro(function () { novoJogo(); }); });          /* partida rápida: sem save */
    el.btnDeNovo.addEventListener('click', function () { novoJogo(); });
    el.btnReiniciar.addEventListener('click', function () { novoJogo(); });
    el.btnComoJogar.addEventListener('click', function () { el.ajuda.hidden = !el.ajuda.hidden; el.btnComoJogar.textContent = el.ajuda.hidden ? 'BRIEFING' : 'FECHAR BRIEFING'; });
    var bsDif = el.nivelGrupo.querySelectorAll('button');
    for (var q = 0; q < bsDif.length; q++) bsDif[q].addEventListener('click', function (e) { escolherDif(e.currentTarget.getAttribute('data-dif')); });
    escolherDif(dif.id);
    el.btnPausa.addEventListener('click', pausar);
    function atualizarCfgUI() {
      el.btnAuto.textContent = cfg.autoAim ? 'LIGADA' : 'DESLIGADA'; el.btnAuto.classList.toggle('ativo', cfg.autoAim); el.btnAuto.setAttribute('aria-pressed', cfg.autoAim ? 'true' : 'false');
      el.rngLuz.value = cfg.luz; el.luzVal.textContent = cfg.luz + '%';
      el.rngShake.value = cfg.shake; el.shakeVal.textContent = cfg.shake + '%';
      el.btnNoite.textContent = cfg.noite ? 'LIGADA' : 'DESLIGADA'; el.btnNoite.classList.toggle('ativo', cfg.noite); el.btnNoite.setAttribute('aria-pressed', cfg.noite ? 'true' : 'false');
      el.rngEscala.value = cfg.escala; el.escVal.textContent = cfg.escala + '%';
      el.rngEscalaStick.value = cfg.escalaStick; el.escStickVal.textContent = cfg.escalaStick + '%';
    }
    function redesenharPausa() { if (estado === 'pausa' && sim) { V = sim.views(); desenhar(); } }
    function abrirConfig() { atualizarCfgUI(); atualizarVibUI(); atualizarZoomUI(); atualizarPadLinhas(); el.config.hidden = false; }
    el.btnConfig.addEventListener('click', abrirConfig); el.btnConfigMenu.addEventListener('click', abrirConfig);
    el.btnConfigHud.addEventListener('click', function () { if (estado === 'jogando') { pausar(); abrirConfig(); } });
    el.btnConfigVoltar.addEventListener('click', function () { pararCaptura(); el.config.hidden = true; });
    el.btnAuto.addEventListener('click', function () { cfg.autoAim = !cfg.autoAim; salvarCfg(); atualizarCfgUI(); });
    el.rngShake.addEventListener('input', function () { cfg.shake = +el.rngShake.value; el.shakeVal.textContent = cfg.shake + '%'; salvarCfg(); });
    el.btnNoite.addEventListener('click', function () { cfg.noite = !cfg.noite; salvarCfg(); atualizarCfgUI(); redesenharPausa(); });
    el.rngLuz.addEventListener('input', function () { cfg.luz = +el.rngLuz.value; el.luzVal.textContent = cfg.luz + '%'; salvarCfg(); redesenharPausa(); });
    el.rngEscala.addEventListener('input', function () { cfg.escala = +el.rngEscala.value; el.escVal.textContent = cfg.escala + '%'; aplicarEscalaTouch(); salvarCfg(); });
    el.rngEscalaStick.addEventListener('input', function () { cfg.escalaStick = +el.rngEscalaStick.value; el.escStickVal.textContent = cfg.escalaStick + '%'; aplicarEscalaTouch(); salvarCfg(); });
    /* predefinições de tamanho (botões e analógico juntos); o painel fica translúcido para ver o efeito ao vivo */
    function predef(v) { return function () { cfg.escala = v; cfg.escalaStick = v; aplicarEscalaTouch(); salvarCfg(); atualizarCfgUI(); }; }
    el.btnEscP.addEventListener('click', predef(75)); el.btnEscM.addEventListener('click', predef(100)); el.btnEscG.addEventListener('click', predef(130));
    /* créditos */
    ligarCampanha();
    el.btnCreditos.addEventListener('click', function () { if (window.MVCreditos) window.MVCreditos.verificar(); el.creditos.hidden = false; });
    el.btnCreditosVoltar.addEventListener('click', function () { el.creditos.hidden = true; });
    montarSkins();
    /* ---- vibração ---- */
    function atualizarVibUI() {
      el.btnVibrar.disabled = !VIBRACAO_OK && !MV.Gamepad.conectado;
      el.btnVibrar.textContent = cfg.vibrar ? 'LIGADA' : 'DESLIGADA'; el.btnVibrar.classList.toggle('ativo', cfg.vibrar); el.btnVibrar.setAttribute('aria-pressed', cfg.vibrar ? 'true' : 'false');
      el.vibDesc.textContent = VIBRACAO_OK ? 'Vibra o aparelho (e o controle) em dano, explosões e armas pesadas.' : 'Este navegador não suporta vibração do aparelho (comum no iOS). A vibração do controle continua disponível.';
    }
    el.btnVibrar.addEventListener('click', function () { cfg.vibrar = !cfg.vibrar; salvarCfg(); aplicarVibracao(); atualizarVibUI(); if (cfg.vibrar) { vibrarTela([40, 40, 40]); MV.Gamepad.vibrar(0.15, 0.4, 0.4); } });
    /* ---- zoom da câmera em tempo real ---- */
    function atualizarZoomUI() { el.rngZoom.value = cfg.zoom; el.zoomVal.textContent = cfg.zoom + '%'; }
    function mudarZoom(v) { cfg.zoom = clamp(Math.round(v / 5) * 5, 60, 160); atualizarZoomUI(); salvarCfg(); aplicarZoom(); }
    el.rngZoom.addEventListener('input', function () { mudarZoom(+el.rngZoom.value); });
    el.btnZoomMenos.addEventListener('click', function () { mudarZoom(cfg.zoom - 10); });
    el.btnZoomMais.addEventListener('click', function () { mudarZoom(cfg.zoom + 10); });
    /* ---- mapeamento do controle ---- */
    var PERFIL_TXT = { auto: 'AUTO', padrao: 'PADRÃO', alt: 'ALTERNATIVO' }, PG = MV.Gamepad;
    var EIXOS = ['mx', 'my', 'rx', 'ry'];
    /* monta as linhas uma vez: uma por botão lógico + uma por eixo; "REMAPEAR" liga a captura do próximo botão/eixo */
    function montarPadLinhas() {
      var h = '', i, n;
      for (i = 0; i < PG.NOMES.length; i++) { n = PG.NOMES[i]; h += '<div class="padLinha" data-n="' + n + '"><b>' + PG.ROTULO[n] + '</b><span>' + PG.DESCR[n] + '<i></i></span><button class="btn" data-tipo="botao">REMAPEAR</button></div>'; }
      for (i = 0; i < EIXOS.length; i++) { n = EIXOS[i]; h += '<div class="padLinha eixo" data-n="' + n + '"><b>' + (i < 2 ? 'ESQ' : 'DIR') + '</b><span>' + PG.ROT_EIXO[n] + '<i></i></span><button class="btn" data-tipo="eixo">REMAPEAR</button></div>'; }
      el.padLinhas.innerHTML = h;
    }
    function atualizarPadLinhas() {
      var ls = el.padLinhas.children;
      for (var i = 0; i < ls.length; i++) { var n = ls[i].getAttribute('data-n'), eixo = ls[i].classList.contains('eixo'); ls[i].querySelector('i').textContent = eixo ? PG.textoEixo(n) : PG.textoLigacao(n); }
      el.btnPerfil.textContent = PERFIL_TXT[PG.perfil()];
    }
    function pararCaptura() { PG.cancelarCaptura(); var e = el.padLinhas.querySelector('.esperando'); if (e) { e.classList.remove('esperando'); e.querySelector('button').textContent = 'REMAPEAR'; } }
    el.padLinhas.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button[data-tipo]') : null; if (!b) return;
      var linha = b.parentNode, n = linha.getAttribute('data-n'), tipo = b.getAttribute('data-tipo');
      var jaEsperando = linha.classList.contains('esperando'); pararCaptura(); if (jaEsperando) return;
      if (!PG.conectado) { el.padStatus.textContent = 'Conecte o controle e aperte qualquer botão antes de remapear.'; return; }
      linha.classList.add('esperando'); b.textContent = tipo === 'eixo' ? 'MOVA O ANALÓGICO…' : 'APERTE O BOTÃO…';
      PG.capturar(tipo, function (v) {
        if (tipo === 'eixo') PG.definirEixo(n, v); else PG.definirLigacao(n, v);
        linha.classList.remove('esperando'); b.textContent = 'REMAPEAR'; atualizarPadLinhas();
      });
    });
    el.btnPerfil.addEventListener('click', function () { var o = ['auto', 'padrao', 'alt']; PG.definirPerfil(o[(o.indexOf(PG.perfil()) + 1) % 3]); atualizarPadLinhas(); });
    el.btnPadReset.addEventListener('click', function () { pararCaptura(); PG.restaurarPadrao(); atualizarPadLinhas(); });
    montarPadLinhas();
    /* atualizado ~4×/s pelo laço enquanto o painel de controle está aberto: status + diagnóstico ao vivo (ajuda a descobrir o layout real do controle) */
    var tDiag = 0;
    atualizarPadUI = function (dt) {
      tDiag -= dt; if (tDiag > 0) return; tDiag = 0.25;
      var d = PG.diagnostico();
      el.padStatus.classList.toggle('on', !!d);
      el.padStatus.textContent = d ? 'Conectado: ' + d.id : 'Nenhum controle detectado. Conecte e aperte qualquer botão.';
      el.padDiag.textContent = d ? 'mapping: ' + d.mapping + ' · perfil em uso: ' + d.perfil + '\nbotões: ' + d.nBotoes + ' · eixos: ' + d.nEixos + '\npressionados: [' + d.botoes.join(', ') + ']\neixos: [' + d.eixos.join(', ') + ']' : 'Sem dados.';
    };
    atualizarCfgUI();
    atualizarVibUI(); atualizarZoomUI(); atualizarPadLinhas(); aplicarVibracao();
    el.rngDeadzone.value = Math.round(MV.Gamepad.deadzone * 100); el.dzVal.textContent = el.rngDeadzone.value + '%';
    el.rngDeadzone.addEventListener('input', function () { MV.Gamepad.definirDeadzone(el.rngDeadzone.value / 100); el.dzVal.textContent = el.rngDeadzone.value + '%'; });
    el.btnLojaFechar.addEventListener('click', fecharLoja);
    el.lojaGrade.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.item') : null;
      if (!card) return;
      S.lojaFoco = +card.getAttribute('data-i');
      var b = e.target.closest('button[data-acao]');
      if (b) acaoLoja(b.getAttribute('data-acao')); else renderLoja();
    });
    el.btnContinuar.addEventListener('click', continuar);
    el.btnMenu.addEventListener('click', entrarMenu);
    el.btnMenu2.addEventListener('click', entrarMenu);
    el.btnSom.addEventListener('click', function () { Som.iniciar(); var l = Som.alternar(); el.btnSom.textContent = 'SOM: ' + (l ? 'LIGADO' : 'DESLIGADO'); });
    /* TELA CHEIA + orientação horizontal. A trava de orientação só é aceita pelos navegadores com a página em tela cheia (e após um gesto do usuário):
       tentamos nos dois momentos e ignoramos erros (iOS/desktop não suportam). */
    var telaOk = !!(document.fullscreenEnabled && document.documentElement.requestFullscreen) && !/iPhone|iPad|iPod/.test(navigator.userAgent);
    function travarPaisagem() {
      try { var o = screen.orientation; if (o && o.lock) { var p = o.lock('landscape'); if (p && p.catch) p.catch(function () { }); } } catch (e) { }
    }
    function alternarTela() {
      try {
        if (document.fullscreenElement) { document.exitFullscreen(); }
        else { var r = document.documentElement.requestFullscreen(); if (r && r.then) r.then(travarPaisagem, function () { }); else travarPaisagem(); }
      } catch (e) { }
    }
    function rotuloTela() {
      var tx = document.fullscreenElement ? 'SAIR DA TELA CHEIA' : 'TELA CHEIA';
      el.btnTela.textContent = tx; el.btnTelaMenu.textContent = tx;
    }
    if (telaOk) {
      el.btnTela.hidden = false; el.btnTelaMenu.hidden = false;
      el.btnTela.addEventListener('click', alternarTela); el.btnTelaMenu.addEventListener('click', alternarTela);
      document.addEventListener('fullscreenchange', function () { rotuloTela(); if (document.fullscreenElement) travarPaisagem(); else { try { screen.orientation && screen.orientation.unlock && screen.orientation.unlock(); } catch (e) { } } });
    }
    travarPaisagem();                                                    /* funciona direto em PWAs instalados e alguns navegadores móveis */
    var primeiroToque = function () { travarPaisagem(); document.removeEventListener('pointerdown', primeiroToque, true); };
    document.addEventListener('pointerdown', primeiroToque, true);
  }

  /* =====================  LOOP  ===================== */
  var rafId = 0, proxQuadro = 0;
  function quadro(agora) {
    rafId = requestAnimationFrame(quadro);
    if (document.hidden) return;                       /* aba minimizada: nenhum cálculo nem desenho */
    if (agora < proxQuadro - 1.5) return;              /* trava em ≈60 FPS: telas de 90/120/144 Hz pulam quadros (economiza bateria) */
    proxQuadro = Math.max(proxQuadro + 16.667, agora);
    var dt = (agora - lastT) / 1000; lastT = agora;
    if (!(dt > 0)) return;
    var ms = dt * 1000;
    if (dt > 0.1) dt = 0.1;
    MV.Gamepad.navStick = estado !== 'jogando' || (S && (S.lojaAberta || S.perkAberto)) || !!(el.config && !el.config.hidden);
    navAtualizar();
    MV.Gamepad.atualizar(dt);
    if (MV.Gamepad.scrollY) { var tl = telaNav(), ls = tl && tl.querySelector('.metaLista'); if (ls) ls.scrollTop += MV.Gamepad.scrollY * 700 * dt; }
    if (atualizarPadUI && el.config && !el.config.hidden && el.padCfg.open) atualizarPadUI(dt);
    if (estado === 'jogando' && !S.lojaAberta && !S.perkAberto && S.perkPend > 0 && !demo) abrirPerks();
    if (estado === 'jogando' && S.perkAberto) { S.t += dt; }                       /* escolha de perk: tempo totalmente parado */
    else if (estado === 'jogando' && S.lojaAberta) {          /* loja aberta: tempo parado entre rodadas, quase parado em combate (na armaria) */
      var esc = S.fase === 'intervalo' ? 0 : 0.12;
      if (esc > 0) atualizar(dt * esc); else { S.t += dt; atualizarTremor(dt); }
    } else if (estado === 'jogando' || estado === 'menu') {
      /* passo fixo adaptativo: quadros lentos (>25 ms) são divididos em até 4 subpassos iguais → física/colisão sem "teletransporte" através de paredes */
      var sub = Math.min(4, Math.ceil(dt / 0.025)), h = dt / sub;
      for (var q = 0; q < sub; q++) atualizar(h);
    } else if (estado === 'fim') {
      S.t += dt; atualizarParticulas(dt); atualizarTremor(dt);
      if (S.dano > 0.35) S.dano -= dt * 0.3;
    }
    if (estado !== 'pausa' && estado !== 'intro') { V = sim.views ? sim.views() : V; desenhar(); }
    if (estado !== 'intro') adaptarQualidade(ms);
  }

  function iniciar() {
    app = $('app'); cv = $('cv'); cacheUI();
    /* sem "desynchronized": esse modo pula a sincronia com o compositor e causa rasgos (tearing) e cintilação em alguns aparelhos */
    ctx = cv.getContext('2d', { alpha: false });
    decalCv = document.createElement('canvas'); decalCv.width = MUNDO.w / 2; decalCv.height = MUNDO.h / 2; decalCtx = decalCv.getContext('2d');
    criarGore();
    criarParticulas(); criarSpritesLuz();
    novoEstado();
    redimensionarAgora();
    configurarBotoes(); configurarEntrada();
    MV.Gamepad.onBotao = aoBotaoPad;
    MV.Gamepad.onAtivoMudou = function (ativo) { if (ativo) { IN.mouseAtivo = false; IN.atirar = false; } if (S && S.lojaAberta) renderLoja(); };
    carregarMotor().then(function () {
      V = sim.views();
      MAXZ = sim.layout(0); ZS = sim.layout(1); MAXB = sim.layout(2); BS = sim.layout(3); ES = sim.layout(5); MAXG = sim.layout(6); GS = sim.layout(7);
      entrarMenu();
      lastT = performance.now();
      rafId = requestAnimationFrame(quadro);
    });
  }


  /* =====================  RODADA 7 · PROGRESSO PERMANENTE  =====================
   * Save de 3 slots (meta.js), habilidades, conquistas, recompensas, estações aleatórias e navegação por controle em todos os menus. */
  var Meta = MV.Meta;
  var fila = [];            /* toasts de conquista pendentes */

  /* ---- estatísticas em tempo real (chamadas pelos eventos da simulação) ---- */
  function registrarAbate(tz) {
    Meta.inc('abates'); Meta.ganharXp('tiro', 2);
    if (tz === 4) Meta.inc('tanques'); else if (tz === 5) Meta.inc('toxicos'); else if (tz === 3) Meta.inc('corredores');
    if (S.tGran > 0) Meta.inc('granadaKills');
    if (S.tMina > 0) Meta.inc('minaKills');
    if (S.tBarril > 0) Meta.inc('barrilKills');
    if (S.tFogo > 0) Meta.inc('fogoKills');
    if (S.multiT > 0) { S.multiN++; Meta.max('multiKill', S.multiN); }
  }
  function atualizarMeta(dt) {
    if (S.tGran > 0) S.tGran -= dt; if (S.tMina > 0) S.tMina -= dt; if (S.tBarril > 0) S.tBarril -= dt; if (S.tFogo > 0) S.tFogo -= dt; if (S.multiT > 0) S.multiT -= dt;
    if (!Meta.slot) return;
    Meta.perfil.tempo += dt;
    S.tChk = (S.tChk || 0) - dt;
    if (S.tChk <= 0) {
      S.tChk = 0.5;
      var n = 0; for (var i = 0; i < S.possui.length; i++) if (S.possui[i]) n++;
      Meta.max('armasMax', n); Meta.checar();
    }
  }
  var toastT = 0;
  function proximoToast() {
    var c = fila.shift();
    if (!c) { el.toastConq.hidden = true; toastT = 0; return; }
    var r = Meta.RARIDADES[c.rar];
    el.toastConq.innerHTML = '<small>CONQUISTA DESBLOQUEADA · ' + r.nome + '</small><b>' + c.nome + '</b><span>+' + c.pts + ' PONTOS</span>';
    el.toastConq.style.setProperty('--c', r.cor); el.toastConq.hidden = true; void el.toastConq.offsetWidth; el.toastConq.hidden = false;
    toastT = 3.6; Som.conquista();
  }
  Meta.onConquista = function (c) { fila.push(c); if (toastT <= 0 && el.toastConq) proximoToast(); salvarAuto(); };
  Meta.onNivel = function (k, n) { if (estado === 'jogando') { mostrarAviso('HABILIDADE ' + Meta.HAB[k].nome + ' · NÍVEL ' + n, '#e8b630'); Som.coleta(); } };

  /* ---- save state ---- */
  function coletarCk() {
    return { rodada: S.rodada, pontos: Math.floor(S.pontos), abates: S.abates, tempo: S.tempo, dif: dif.id, possui: S.possui.slice(), arma: J.arma,
      armas: armaEst.map(function (e) { return { mag: e.mag, res: e.res }; }), granadas: J.granadas, molotovs: J.molotovs, minas: J.minas,
      vida: Math.round(J.vida), stam: Math.round(J.stam), dual: S.dual.slice() };
  }
  function salvarAuto() {
    if (!Meta.slot || demo || !S || (estado !== 'jogando' && estado !== 'pausa')) return;
    Meta.salvar(coletarCk(), { rodada: S.rodada, pontos: Math.floor(S.pontos), dif: dif.id, rodadaMax: Meta.stat('rodadaMax') });
  }
  /* aplica o checkpoint sobre o estado recém-criado (novoEstado) */
  function aplicarCk(ck) {
    var n = ARMAS.length, i, num = function (v, d, a, b) { v = +v; return isFinite(v) ? clamp(v, a, b) : d; };
    S.pontos = num(ck.pontos, 0, 0, 1e9); S.abates = num(ck.abates, 0, 0, 1e9); S.tempo = num(ck.tempo, 0, 0, 1e9);
    for (i = 0; i < n; i++) if (ARMAS[i].dual && ck.dual && ck.dual[i]) aplicarDual(i, true);
    for (i = 0; i < n; i++) {
      S.possui[i] = i === 0 || !!(ck.possui && ck.possui[i]);
      var a = ck.armas && ck.armas[i] || {};
      armaEst[i].mag = S.possui[i] ? num(a.mag, penteMax(i), 0, penteMax(i)) : 0;
      armaEst[i].res = S.possui[i] ? num(a.res, LIM[i].resIni, 0, LIM[i].resMax) : 0;
    }
    J.arma = S.possui[ck.arma | 0] ? clamp(ck.arma | 0, 0, n - 1) : 0;
    J.granadas = num(ck.granadas, 0, 0, GRANADA.max); J.molotovs = num(ck.molotovs, 0, 0, MOLOTOV.max); J.minas = num(ck.minas, 0, 0, MINA.max);
  }
  /* bônus permanentes das recompensas; "novo" = início de campanha (não reaplica pontos/itens ao carregar) */
  function aplicarBonusPerfil(novo, ck) {
    if (!Meta.slot) return;
    if (Meta.tem('r03')) J.vidaMax += 25;
    J.vida = ck ? clamp(+ck.vida || J.vidaMax, 1, J.vidaMax) : J.vidaMax;
    if (ck) J.stam = clamp(+ck.stam || 100, 0, 100);
    if (Meta.tem('r12')) {                                         /* Mini Gun: sempre na mochila */
      var m = IDX_MINI;
      if (!S.possui[m]) { S.possui[m] = true; armaEst[m].mag = penteMax(m); armaEst[m].res = LIM[m].resIni; }
    }
    if (novo) {
      if (Meta.tem('r01')) S.pontos += 1000;
      if (Meta.tem('r02')) { J.granadas = Math.min(GRANADA.max, J.granadas + 2); J.molotovs = Math.min(MOLOTOV.max, J.molotovs + 1); J.minas = Math.min(MINA.max, J.minas + 1); }
    }
  }

  /* ---- estações em locais aleatórios a cada horda ---- */
  function pontoLivreEstacao(x, y, r) {
    var i;
    for (i = 0; i < OBST.length; i++) if (tocaCirculo(OBST[i], 36, x, y, r + 24)) return false;
    for (i = 0; i < BARRIS.length; i++) if (BARRIS[i].vivo && hip(BARRIS[i].x - x, BARRIS[i].y - y) < r + 60) return false;
    for (i = 0; i < JANELAS.length; i++) if (hip(JANELAS[i].x - x, JANELAS[i].y - y) < 280) return false;
    return true;
  }
  /* sorteia 3 posições (≥ 520 px entre si, longe de paredes/obstáculos/janelas) e valida a conectividade por flood-fill; 14 tentativas, senão mantém as antigas */
  function reposicionarEstacoes() {
    var antigas = ESTACOES.map(function (e) { return { x: e.x, y: e.y }; }), t, i, k, ok;
    var mx = MUNDO.p + 140, my = MUNDO.p + 140;
    for (t = 0; t < 14; t++) {
      ok = true;
      for (i = 0; i < ESTACOES.length && ok; i++) {
        var e = ESTACOES[i], achou = false;
        for (k = 0; k < 90 && !achou; k++) {
          var x = rand(mx, MUNDO.w - mx), y = rand(my, MUNDO.h - my), longe = true;
          for (var q = 0; q < i; q++) if (hip(ESTACOES[q].x - x, ESTACOES[q].y - y) < 520) longe = false;
          if (longe && pontoLivreEstacao(x, y, e.r)) { e.x = x; e.y = y; achou = true; }
        }
        if (!achou) ok = false;
      }
      if (ok && cenarioConectado(OBST)) {
        for (i = 0; i < ESTACOES.length; i++) { ESTACOES[i].novo = 5; ESTACOES[i].cd = 0; }
        return true;
      }
    }
    for (i = 0; i < ESTACOES.length; i++) { ESTACOES[i].x = antigas[i].x; ESTACOES[i].y = antigas[i].y; }
    return false;
  }

  /* ---- telas de campanha ---- */
  var slotsModo = 'novo', confirmaFn = null;
  function fmtTempoTotal(seg) { seg = Math.floor(seg || 0); var h = Math.floor(seg / 3600), m = Math.floor(seg % 3600 / 60); return (h ? h + 'h ' : '') + ('0' + m).slice(-2) + 'min'; }
  function fmtData(ts) { var d = new Date(ts); function z(n) { return ('0' + n).slice(-2); } return z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()); }
  function fecharOverlays() {
    ['historia', 'telaSlots', 'confirma', 'painelMeta', 'creditos'].forEach(function (k) { if (el[k]) el[k].hidden = true; });
  }
  function atualizarSlotAtivo() {
    el.slotAtivo.hidden = !Meta.slot;
    el.slotAtivo.textContent = Meta.slot ? 'SAVE ATIVO · SLOT ' + Meta.slot : '';
  }
  function abrirSlots(modo) {
    slotsModo = modo;
    el.slotsTitulo.textContent = modo === 'novo' ? 'NOVO JOGO' : 'CARREGAR JOGO';
    el.slotsDesc.textContent = modo === 'novo' ? 'Escolha o slot da campanha. Um slot ocupado pede confirmação antes de ser sobrescrito.' : 'Escolha um save para continuar de onde parou.';
    renderSlots(); el.historia.hidden = true; el.telaSlots.hidden = false;
  }
  function renderSlots() {
    var h = '';
    for (var i = 1; i <= Meta.N_SLOTS; i++) {
      var s = Meta.ler(i), ocupado = !!s, ok = modoOk(s);
      var corpo;
      if (!s) corpo = '<b>SLOT ' + i + '</b><small>VAZIO</small>';
      else {
        var inf = s.info || {}, d = DIFS[inf.dif] ? DIFS[inf.dif].nome : '—';
        corpo = '<b>SLOT ' + i + ' · ' + d + '</b><small>RODADA ' + (s.ck ? s.ck.rodada : (inf.rodada || 1)) + ' · ' + fmtNum(inf.pontos || 0) + ' PTS · RECORDE R' + (inf.rodadaMax || 0) + '</small>' +
          '<small>TEMPO ' + fmtTempoTotal(s.perfil && s.perfil.tempo) + ' · ' + fmtData(s.atual) + '</small>';
      }
      h += '<div class="slotLinha"><button class="btn slot' + (ocupado ? ' ocupado' : '') + '" data-slot="' + i + '"' + (ok ? '' : ' disabled') + '>' + corpo + '</button>' +
        (slotsModo === 'carregar' && ocupado ? '<button class="btn mini apagar" data-apagar="' + i + '" aria-label="Apagar slot ' + i + '">APAGAR</button>' : '') + '</div>';
    }
    el.slotsLista.innerHTML = h;
  }
  function modoOk(s) { return slotsModo === 'novo' ? true : !!(s && s.ck); }
  function pedirConfirma(titulo, txt, fn) {
    el.confirma.querySelector('h2').textContent = titulo; el.confirmaTxt.textContent = txt; confirmaFn = fn; el.confirma.hidden = false;
  }
  function escolherSlot(i) {
    var s = Meta.ler(i);
    if (slotsModo === 'novo') {
      var iniciar = function () { Meta.novoSlot(i, { info: { rodada: 1, pontos: 0, dif: dif.id, rodadaMax: 0 } }); fecharOverlays(); comIntro(function () { novoJogo(); }); };
      if (s) pedirConfirma('SOBRESCREVER SAVE?', 'O SLOT ' + i + ' JÁ TEM UMA CAMPANHA (RODADA ' + (s.ck ? s.ck.rodada : 1) + '). TODO O PROGRESSO DELE SERÁ PERDIDO.', iniciar);
      else iniciar();
    } else if (s && s.ck) {
      var ld = Meta.carregarSlot(i); fecharOverlays();
      if (DIFS[ld.ck.dif]) escolherDif(ld.ck.dif);
      novoJogo(ld.ck);
    }
  }
  function apagarSlot(i) {
    pedirConfirma('APAGAR SAVE?', 'O SLOT ' + i + ' SERÁ APAGADO PARA SEMPRE.', function () { if (Meta.slot === i) Meta.sair(); Meta.apagar(i); renderSlots(); atualizarSlotAtivo(); });
  }
  /* painel Conquistas · Recompensas · Habilidades */
  /* ---- LEGADO: conquistas permanentes + árvore de metaprogressão ---- */
  var abaLeg = 'conq';
  function abrirLegado(aba) { abaLeg = aba || abaLeg; renderLegado(); el.painelLegado.hidden = false; }
  function renderLegado() {
    var bs = el.painelLegado.querySelectorAll('[data-leg]'), i, h = '';
    for (i = 0; i < bs.length; i++) { var on = bs[i].getAttribute('data-leg') === abaLeg; bs[i].classList.toggle('ativo', on); bs[i].setAttribute('aria-selected', on ? 'true' : 'false'); }
    el.legPC.textContent = fmtNum(LEG.pc);
    if (abaLeg === 'conq') {
      var cats = { A: 'CATEGORIA A · INICIAIS', B: 'CATEGORIA B · AVANÇADAS' }, ult = '';
      for (i = 0; i < LEG.CONQUISTAS.length; i++) {
        var c = LEG.CONQUISTAS[i], ok = !!LEG.conq[c.id], p = LEG.progresso(c), atual = LEG.stat(c.stat);
        if (c.cat !== ult) { ult = c.cat; h += '<h3 class="legCat">' + cats[c.cat] + '</h3>'; }
        var txt = c.fmt === 'km' ? LEG.fmtKm(Math.min(atual, c.meta)) + ' / ' + LEG.fmtKm(c.meta) + ' km' : (c.modo === 'ev' ? (ok ? 'CONCLUÍDA' : 'EM ANDAMENTO') : fmtNum(Math.min(atual, c.meta)) + ' / ' + fmtNum(c.meta));
        h += '<article class="legConq' + (ok ? ' ok' : '') + '"><div class="legTopo"><b>' + c.nome + '</b><span class="legPc">+' + fmtNum(c.pc) + ' PC</span></div>' +
          '<p>' + c.desc + '</p><p class="legBonus">' + c.bonusTxt + '</p>' +
          '<div class="barra legBarra"><i style="transform:scaleX(' + (ok ? 1 : p).toFixed(3) + ')"></i></div><small>' + (ok ? 'DESBLOQUEADA' : txt) + '</small></article>';
      }
      if (LEG.tem('pesadelo')) h += '<button type="button" class="btn ' + (LEG.pesadelo ? 'ativo' : '') + '" data-pesadelo="1">MODO PESADELO: ' + (LEG.pesadelo ? 'LIGADO' : 'DESLIGADO') + ' · +50% XP e PONTOS · INIMIGOS +30% HP / +10% VEL.</button>';
    } else {
      for (i = 0; i < LEG.ARVORE.length; i++) {
        var t = LEG.ARVORE[i], n = LEG.niv(t.id), max = t.custo.length, custo = LEG.custoProx(t.id), pips = '';
        for (var k = 0; k < max; k++) pips += '<i class="' + (k < n ? 'on' : '') + '"></i>';
        var pode = n < max && LEG.pc >= custo;
        h += '<article class="legNo' + (n >= max ? ' max' : '') + '"><div class="legTopo"><b>' + t.nome + '</b><span class="legPc">NÍVEL ' + n + '/' + max + '</span></div>' +
          '<p>' + t.por + '</p><div class="pips">' + pips + '</div><p class="legBonus">ATUAL: ' + (n ? t.ef(n) : 'nenhum') + '</p>' +
          '<button type="button" class="btn ' + (pode ? 'destaque' : '') + '" data-comprar="' + t.id + '"' + (n >= max || !pode ? ' disabled' : '') + '>' + (n >= max ? 'NÍVEL MÁXIMO' : 'COMPRAR · ' + fmtNum(custo) + ' PC') + '</button></article>';
      }
    }
    el.legLista.innerHTML = h;
  }
  var abaMeta = 'conq';
  function abrirMeta(aba) {
    if (!Meta.slot) {                                 /* sem save ativo: usa o mais recente */
      var melhor = 0, t = 0;
      for (var i = 1; i <= Meta.N_SLOTS; i++) { var s = Meta.ler(i); if (s && s.atual > t) { t = s.atual; melhor = i; } }
      if (melhor) { Meta.carregarSlot(melhor); atualizarSlotAtivo(); }
    }
    abaMeta = aba || abaMeta; renderMeta(); el.painelMeta.hidden = false;
  }
  function renderMeta() {
    var h = '', i, M = Meta, bs = el.painelMeta.querySelectorAll('.aba');
    for (i = 0; i < bs.length; i++) { var on = bs[i].getAttribute('data-aba') === abaMeta; bs[i].classList.toggle('ativo', on); bs[i].setAttribute('aria-selected', on ? 'true' : 'false'); }
    if (!M.slot) {
      el.metaResumo.textContent = 'NENHUM SAVE ATIVO · ABRA HISTÓRIA > NOVO JOGO PARA COMEÇAR A PROGREDIR.';
      el.metaLista.innerHTML = ''; return;
    }
    var P = M.perfil;
    if (abaMeta === 'conq') {
      var tot = 0, un = 0; for (i = 0; i < M.CONQUISTAS.length; i++) { tot++; if (P.conq[M.CONQUISTAS[i].id]) un++; }
      el.metaResumo.textContent = 'SLOT ' + M.slot + ' · ' + un + '/' + tot + ' CONQUISTAS · ' + M.pontosGanhos() + ' PONTOS GANHOS';
      for (i = 0; i < M.CONQUISTAS.length; i++) {
        var c = M.CONQUISTAS[i], r = M.RARIDADES[c.rar], got = !!P.conq[c.id], v = Math.min(M.stat(c.stat), c.meta);
        h += '<article class="meta' + (got ? ' ok' : '') + '" style="--c:' + r.cor + '"><div class="mTopo"><b>' + c.nome + '</b><span class="tag">' + r.nome + ' · ' + c.pts + '</span></div><p>' + c.desc + '</p>' +
          '<div class="mBarra"><i style="width:' + Math.round(v / c.meta * 100) + '%"></i></div><small>' + (got ? 'DESBLOQUEADA ' + fmtData(P.conq[c.id]) : fmtNum(v) + ' / ' + fmtNum(c.meta)) + '</small></article>';
      }
    } else if (abaMeta === 'recomp') {
      el.metaResumo.textContent = 'PONTOS DE CONQUISTA DISPONÍVEIS: ' + M.pontosDisponiveis() + ' (GANHOS ' + M.pontosGanhos() + ' · GASTOS ' + M.pontosGastos() + ')';
      for (i = 0; i < M.RECOMPENSAS.length; i++) {
        var q = M.RECOMPENSAS[i], rq = M.RARIDADES[q.rar], tem = !!P.resg[q.id], pode = !tem && M.pontosDisponiveis() >= q.custo;
        h += '<article class="meta' + (tem ? ' ok' : '') + '" style="--c:' + rq.cor + '"><div class="mTopo"><b>' + q.nome + '</b><span class="tag">' + rq.nome + '</span></div><p>' + q.desc + '</p>' +
          '<button class="btn mini resgatar" data-resg="' + q.id + '"' + (pode ? '' : ' disabled') + '>' + (tem ? 'RESGATADA' : 'RESGATAR · ' + q.custo + ' PTS') + '</button></article>';
      }
    } else {
      el.metaResumo.textContent = 'HABILIDADES PERMANENTES · NÍVEL 1 A 10 · SLOT ' + M.slot;
      ['tiro', 'forca', 'corrida'].forEach(function (k) {
        var H = M.HAB[k], xp = P.xp[k], nv = M.nivelDeXp(xp), pr = Math.round(M.progressoXp(xp) * 100);
        h += '<article class="meta hab" style="--c:#a6ff00"><div class="mTopo"><b>' + H.nome + '</b><span class="tag">NÍVEL ' + nv + ' / 10</span></div><p>' + H.desc + '</p>' +
          '<div class="mBarra"><i style="width:' + (nv >= 10 ? 100 : pr) + '%"></i></div><small>' + H.efeito(nv) + ' · ' + (nv >= 10 ? 'NÍVEL MÁXIMO' : 'XP ' + Math.floor(xp) + ' / ' + M.LIMIARES[nv - 1]) + '</small><small>' + H.ganho + '</small></article>';
      });
    }
    el.metaLista.innerHTML = h;
  }

  /* =====================  NAVEGAÇÃO POR CONTROLE EM TODAS AS TELAS  =====================
   * Antes, na pausa qualquer botão só "retomava". Agora cada tela tem foco próprio: D-pad/analógico movem o foco (por geometria),
   * A aciona, B/Menu volta (o botão marcado com data-voltar), esquerda/direita ajustam barras (range). */
  var NAV_TELAS = ['perks', 'confirma', 'painelLegado', 'config', 'creditos', 'painelMeta', 'telaSlots', 'historia', 'pausa', 'fim', 'menu'];
  var navTela = '', navEl = null;
  function telaNav() {
    for (var i = 0; i < NAV_TELAS.length; i++) { var t = el[NAV_TELAS[i]]; if (t && !t.hidden) return t; }
    return null;
  }
  function focaveis(t) {
    var l = t.querySelectorAll('button, input[type=range], summary'), r = [];
    for (var i = 0; i < l.length; i++) { var e = l[i]; if (!e.disabled && !e.hidden && e.offsetParent !== null && !(e.closest && e.closest('[hidden]'))) r.push(e); }
    return r;
  }
  function limparFoco() { var a = document.querySelectorAll('.padFoco'); for (var i = 0; i < a.length; i++) a[i].classList.remove('padFoco'); }
  function definirFoco(e) {
    limparFoco(); navEl = e;
    if (e) { e.classList.add('padFoco'); if (e.scrollIntoView) { try { e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (x) { } } }
  }
  /* chamada a cada quadro: ao abrir/trocar de tela com o controle ativo, destaca o botão principal */
  function navAtualizar() {
    var pad = MV.Gamepad.ativo, t = telaNav();
    if (!pad || !t || (estado === 'jogando' && !S.lojaAberta && t === el.menu)) { if (navEl) { limparFoco(); navEl = null; navTela = ''; } return; }
    if (S && S.lojaAberta && !S.perkAberto) return;
    var lista = focaveis(t);
    if (t.id !== navTela || !navEl || lista.indexOf(navEl) < 0) {
      navTela = t.id;
      var ini = t.querySelector('.primario:not([disabled])') || lista[0];
      definirFoco(lista.indexOf(ini) >= 0 ? ini : lista[0] || null);
    }
  }
  function moverFoco(t, dir) {
    var lista = focaveis(t); if (!lista.length) return;
    if (!navEl || lista.indexOf(navEl) < 0) { definirFoco(lista[0]); return; }
    var r0 = navEl.getBoundingClientRect(), cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2, melhor = null, pior = 1e9;
    for (var i = 0; i < lista.length; i++) {
      var e = lista[i]; if (e === navEl) continue;
      var r = e.getBoundingClientRect(), ex = r.left + r.width / 2, ey = r.top + r.height / 2, dx = ex - cx, dy = ey - cy, prim, perp;
      if (dir === 'baixo') { prim = dy; perp = Math.abs(dx); } else if (dir === 'cima') { prim = -dy; perp = Math.abs(dx); }
      else if (dir === 'dir') { prim = dx; perp = Math.abs(dy); } else { prim = -dx; perp = Math.abs(dy); }
      if (prim < 4) continue;
      var sc = prim + perp * 2.2; if (sc < pior) { pior = sc; melhor = e; }
    }
    if (melhor) { definirFoco(melhor); Som.trocar(); }
  }
  function navegarPad(t, n) {
    if (t.id !== navTela || !navEl) navAtualizar();
    if (n === 'lb' || n === 'rb') {                                   /* LB/RB: alternam as abas (Legado, Arquivo do Soldado) */
      var abas = t.querySelectorAll('.aba');
      if (abas.length) {
        var ix = 0; for (var q = 0; q < abas.length; q++) if (abas[q].classList.contains('ativo')) ix = q;
        abas[(ix + (n === 'rb' ? 1 : abas.length - 1)) % abas.length].click(); Som.trocar(); navEl = null; navAtualizar(); return;
      }
    }
    if (n === 'cima' || n === 'baixo' || n === 'esq' || n === 'dir') {
      if (navEl && navEl.type === 'range' && (n === 'esq' || n === 'dir')) {
        var st = +navEl.step || 1, v = +navEl.value + (n === 'dir' ? st : -st);
        navEl.value = clamp(v, +navEl.min, +navEl.max); navEl.dispatchEvent(new Event('input', { bubbles: true })); return;
      }
      moverFoco(t, n); return;
    }
    if (n === 'a') { if (navEl) { if (navEl.tagName === 'SUMMARY' && navEl.parentNode) navEl.parentNode.open = !navEl.parentNode.open; else navEl.click(); } return; }
    if (n === 'b' || n === 'menu') {
      if (t.id === 'pausa' && n === 'menu') { continuar(); return; }
      var v2 = t.querySelector('[data-voltar]:not([disabled])'); if (v2 && v2.offsetParent !== null) v2.click();
    }
  }

  /* ---- ligações dos botões da campanha ---- */
  function ligarCampanha() {
    el.btnHistoria.addEventListener('click', function () { el.historia.hidden = false; });
    el.btnHVoltar.addEventListener('click', function () { el.historia.hidden = true; });
    el.btnHNovo.addEventListener('click', function () { abrirSlots('novo'); });
    el.btnHCarregar.addEventListener('click', function () { abrirSlots('carregar'); });
    el.btnSlotsVoltar.addEventListener('click', function () { el.telaSlots.hidden = true; el.historia.hidden = false; });
    el.slotsLista.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b || b.disabled) return;
      if (b.hasAttribute('data-apagar')) apagarSlot(+b.getAttribute('data-apagar')); else if (b.hasAttribute('data-slot')) escolherSlot(+b.getAttribute('data-slot'));
    });
    el.btnConfirmaSim.addEventListener('click', function () { var f = confirmaFn; confirmaFn = null; el.confirma.hidden = true; if (f) f(); });
    el.btnConfirmaNao.addEventListener('click', function () { confirmaFn = null; el.confirma.hidden = true; });
    el.btnConquistas.addEventListener('click', function () { abrirMeta('conq'); });
    el.btnLegado.addEventListener('click', function () { abrirLegado(); });
    el.btnLegVoltar.addEventListener('click', function () { el.painelLegado.hidden = true; LEG.salvar(true); });
    el.painelLegado.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b || b.disabled) return;
      if (b.hasAttribute('data-leg')) { abaLeg = b.getAttribute('data-leg'); renderLegado(); return; }
      if (b.hasAttribute('data-pesadelo')) { LEG.alternarPesadelo(); Som.trocar(); renderLegado(); return; }
      if (b.hasAttribute('data-comprar')) {
        var r = LEG.comprar(b.getAttribute('data-comprar'));
        if (r === 'ok') { Som.compra(); Som.conquista(); } else Som.vazio();
        var y = el.legLista.scrollTop; renderLegado(); el.legLista.scrollTop = y;
      }
    });
    el.btnRecompensas.addEventListener('click', function () { abrirMeta('recomp'); });
    el.btnMetaVoltar.addEventListener('click', function () { el.painelMeta.hidden = true; });
    el.painelMeta.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.hasAttribute('data-aba')) { abaMeta = b.getAttribute('data-aba'); renderMeta(); return; }
      if (b.hasAttribute('data-resg') && !b.disabled) {
        var r = Meta.resgatar(b.getAttribute('data-resg'));
        if (r === 'ok') { Som.compra(); Som.conquista(); Meta.salvar(); renderMeta(); }
        else Som.vazio();
      }
    });
    el.btnFimCarregar.addEventListener('click', function () {
      var s = Meta.slot && Meta.ler(Meta.slot); if (!s || !s.ck) return;
      var ld = Meta.carregarSlot(Meta.slot); if (DIFS[ld.ck.dif]) escolherDif(ld.ck.dif); novoJogo(ld.ck);
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) salvarAuto(); });
    window.addEventListener('pagehide', function () { salvarAuto(); LEG.salvar(true); });
    atualizarSlotAtivo();
  }

  MV.depurar = {
    get cfg() { return cfg; }, iniciarRodada: iniciarRodada, precoMun: precoMun, ESTACOES: ESTACOES, raioLuz: raioLuz, compCone: compCone, ARMAS_N: ARMAS.length, get dif() { return dif; }, gerarCenario: gerarCenario, cenarioConectado: function () { return cenarioConectado(OBST); }, get OBST() { return OBST; }, viewZoom: function () { return view.zoom; }, vibrarTela: vibrarTela, get Gamepad() { return MV.Gamepad; }, get Pools() { return { t: pTexto, fx: pFx, n: pNuvens, d: pDrops }; },
    get BARRIS() { return BARRIS; }, lancarMolotov: lancarMolotov, plantarMina: plantarMina, danificarBarrilEm: danificarBarrilEm, sortearDrop: sortearDrop, absorverEscudo: absorverEscudo,
    get S() { return S; }, get J() { return J; }, get IN() { return IN; }, get sim() { return sim; }, get perf() { return perf; },
    get estado() { return estado; }, novoJogo: novoJogo, pausar: pausar, continuar: continuar, entrarMenu: entrarMenu,
    get tipo() { return simTipo; }, ARMAS: ARMAS, armaEst: function () { return armaEst; }, trocarArma: trocarArma, gerarZumbi: gerarZumbi, abrirLoja: function () { abrirLoja(); }, fecharLoja: function () { fecharLoja(); }, lancarGranada: lancarGranada, acaoLoja: function (a) { acaoLoja(a); }, aoBotaoPad: function (n) { aoBotaoPad(n); }, get ESTACOES() { return ESTACOES; }, get GRANADA() { return GRANADA; }, precoArma: function (i) { return precoArma(i); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})(window.MV = window.MV || {});
