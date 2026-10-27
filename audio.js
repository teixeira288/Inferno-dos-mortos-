/* audio.js : efeitos sonoros e atmosfera sintetizados com WebAudio (nenhum arquivo de áudio). */
(function (MV) {
  'use strict';
  var ctx = null, master = null, noiseBuf = null, ligado = true, ambiente = null;
  var ultimo = { grunhido: 0, golpe: 0, acerto: 0 }, intro = null;
  var silencio = false;      /* o fundo animado do menu não faz barulho */

  function guardado() { try { return localStorage.getItem('mv_som') !== '0'; } catch (e) { return true; } }
  ligado = guardado();

  function iniciar() {
    if (ctx) { retomar(); return; }
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = ligado ? 0.6 : 0;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 6;
      master.connect(comp); comp.connect(ctx.destination);
      var n = 22050;                                  /* ruído branco de 1 s a 22 kHz (≈86 KB): um único buffer compartilhado por todos os sons */
      noiseBuf = ctx.createBuffer(1, n, n);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      retomar();
    } catch (e) { ctx = null; }
  }
  function retomar() { if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { } } }

  var vozes = 0;                                        /* limite de vozes simultâneas: evita estourar CPU/memória em rajadas */
  function liberar() { vozes--; }
  function ruido(t, dur, o) {
    if (!ctx || vozes >= 28) return;
    vozes++;
    var src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = o.tipo || 'lowpass';
    f.frequency.setValueAtTime(o.f0 || 2000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    f.Q.value = o.q || 0.8;
    var g = ctx.createGain();
    var pico = o.ganho == null ? 0.4 : o.ganho;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(pico, t + (o.ataque || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.onended = liberar;
    src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  function tom(t, dur, o) {
    if (!ctx || vozes >= 28) return;
    vozes++;
    var os = ctx.createOscillator(); os.type = o.tipo || 'sine';
    os.frequency.setValueAtTime(o.f0 || 100, t);
    if (o.f1) os.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.ganho == null ? 0.4 : o.ganho, t + (o.ataque || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    var dest = master;
    if (o.filtro) { var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.filtro; os.connect(f); f.connect(g); } else os.connect(g);
    g.connect(dest);
    os.onended = liberar;
    os.start(t); os.stop(t + dur + 0.03);
  }

  var Som = {
    iniciar: iniciar, retomar: retomar,
    suspender: function () { if (ctx && ctx.state === 'running') { try { ctx.suspend(); } catch (e) { } } },
    cuspe: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.25, { tipo: 'bandpass', f0: 1400, f1: 300, q: 1.2, ganho: 0.4 });
      tom(t, 0.2, { f0: 300, f1: 90, ganho: 0.3 });
    },
    rugido: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 1.1, { tipo: 'sawtooth', f0: 90, f1: 38, ganho: 0.45, ataque: 0.04, filtro: 500 });
      tom(t + 0.05, 1.0, { tipo: 'square', f0: 55, f1: 30, ganho: 0.25, ataque: 0.05, filtro: 300 });
      ruido(t, 0.9, { tipo: 'lowpass', f0: 900, f1: 120, ganho: 0.45 });
    },
    get ligado() { return ligado; },
    get silencio() { return silencio; }, set silencio(v) { silencio = !!v; },
    alternar: function () {
      ligado = !ligado;
      try { localStorage.setItem('mv_som', ligado ? '1' : '0'); } catch (e) { }
      if (master) master.gain.setTargetAtTime(ligado ? 0.6 : 0, ctx.currentTime, 0.02);
      return ligado;
    },
    tiro: function (arma) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (arma === 0) {          /* M1911: estalo seco */
        ruido(t, 0.09, { tipo: 'bandpass', f0: 1900, f1: 900, q: 0.9, ganho: 0.55 });
        tom(t, 0.12, { f0: 190, f1: 60, ganho: 0.55 });
      } else if (arma === 1) {   /* MP5: rápido e agudo */
        ruido(t, 0.06, { tipo: 'bandpass', f0: 2600, f1: 1200, q: 0.8, ganho: 0.4 });
        tom(t, 0.08, { f0: 160, f1: 75, ganho: 0.38 });
      } else if (arma === 3) {   /* escopeta 12: estrondo largo + bomba (pump) */
        ruido(t, 0.28, { tipo: 'lowpass', f0: 2600, f1: 260, q: 0.7, ganho: 0.9 });
        tom(t, 0.3, { f0: 110, f1: 30, ganho: 0.9 });
        ruido(t + 0.34, 0.05, { tipo: 'bandpass', f0: 1400, f1: 900, q: 2, ganho: 0.35 });
        ruido(t + 0.46, 0.05, { tipo: 'bandpass', f0: 1000, f1: 600, q: 2, ganho: 0.4 });
      } else if (arma === 6) {   /* mini uzi: estalo agudo e curto */
        ruido(t, 0.05, { tipo: 'bandpass', f0: 3200, f1: 1600, q: 0.9, ganho: 0.34 });
        tom(t, 0.07, { f0: 210, f1: 90, ganho: 0.3 });
      } else if (arma === 5) {   /* mini gun: rajada metálica curtíssima */
        ruido(t, 0.05, { tipo: 'bandpass', f0: 3000, f1: 1500, q: 0.8, ganho: 0.32 });
        tom(t, 0.07, { f0: 140, f1: 70, ganho: 0.34 });
      } else if (arma === 4) {   /* lança-porcos: foguete + guincho */
        ruido(t, 0.5, { tipo: 'bandpass', f0: 900, f1: 3200, q: 0.8, ganho: 0.5 });
        tom(t, 0.18, { f0: 140, f1: 50, ganho: 0.7 });
        tom(t + 0.05, 0.55, { tipo: 'sawtooth', f0: 900, f1: 1700, ganho: 0.14, ataque: 0.01, filtro: 2600 });
      } else {                   /* M16: estrondo grave */
        ruido(t, 0.13, { tipo: 'lowpass', f0: 3600, f1: 500, q: 0.7, ganho: 0.6 });
        tom(t, 0.16, { f0: 130, f1: 42, ganho: 0.7 });
        tom(t, 0.05, { tipo: 'square', f0: 900, f1: 300, ganho: 0.08 });
      }
    },
    vazio: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.04, { tipo: 'square', f0: 1400, f1: 900, ganho: 0.12 });
    },
    recarga: function (dur) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.05, { tipo: 'highpass', f0: 2500, ganho: 0.3 }); tom(t, 0.06, { tipo: 'square', f0: 300, f1: 160, ganho: 0.1 });
      ruido(t + dur * 0.55, 0.07, { tipo: 'bandpass', f0: 1500, q: 2, ganho: 0.35 }); tom(t + dur * 0.55, 0.08, { tipo: 'square', f0: 220, f1: 120, ganho: 0.1 });
      ruido(t + dur - 0.1, 0.06, { tipo: 'highpass', f0: 3000, ganho: 0.4 }); tom(t + dur - 0.1, 0.07, { tipo: 'square', f0: 420, f1: 200, ganho: 0.12 });
    },
    trocar: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.08, { tipo: 'bandpass', f0: 1100, q: 1.5, ganho: 0.3 });
      tom(t + 0.05, 0.06, { tipo: 'square', f0: 260, f1: 180, ganho: 0.08 });
    },
    acerto: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (t - ultimo.acerto < 0.04) return; ultimo.acerto = t;
      tom(t, 0.07, { f0: 120, f1: 55, ganho: 0.28 });
      ruido(t, 0.05, { tipo: 'lowpass', f0: 900, ganho: 0.22 });
    },
    morte: function (tipo) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (tipo === 4) {
        tom(t, 1.1, { tipo: 'sawtooth', f0: 80, f1: 26, ganho: 0.4, filtro: 500 });
        ruido(t, 0.6, { tipo: 'lowpass', f0: 1400, f1: 120, ganho: 0.5 });
        return;
      }
      tom(t, 0.35, { tipo: 'sawtooth', f0: tipo === 2 ? 90 : 150, f1: 38, ganho: 0.2, filtro: 600 });
      ruido(t, 0.18, { tipo: 'lowpass', f0: 1100, f1: 200, ganho: 0.3 });
    },
    /* membro arrancado: estalo molhado */
    desmembrar: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.16, { tipo: 'bandpass', f0: 380, q: 1.2, ganho: 0.32 });
      tom(t, 0.14, { tipo: 'sawtooth', f0: 170, f1: 55, ganho: 0.18, filtro: 500 });
    },
    /* pavio do Bomber: bipes curtos e agudos */
    pavio: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      for (var i = 0; i < 4; i++) tom(t + i * 0.3, 0.09, { tipo: 'square', f0: 1500 + i * 120, f1: 1500 + i * 120, ganho: 0.1, ataque: 0.005 });
    },
    /* intro: pad escuro e suave (fade in/out) */
    introMusica: function (ligar) {
      if (!ctx) return;
      if (!ligar) { if (intro) { var it = intro; intro = null; try { it.g.gain.setTargetAtTime(0, ctx.currentTime, 0.5); } catch (e) { } setTimeout(function () { try { it.o.forEach(function (x) { x.stop(); }); } catch (e) { } }, 2500); } return; }
      if (intro || !ligado) return;
      var g = ctx.createGain(); g.gain.value = 0; g.connect(master); g.gain.setTargetAtTime(0.32, ctx.currentTime, 1.4);
      var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 520; f.Q.value = 0.7; f.connect(g);
      var lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.09; lg.gain.value = 180; lfo.connect(lg); lg.connect(f.frequency);
      var os = [lfo], fr = [55, 82.41, 110.5, 164.8];
      for (var i = 0; i < fr.length; i++) { var o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = fr[i]; var og = ctx.createGain(); og.gain.value = 0.16 / (i + 1); o.connect(og); og.connect(f); o.start(); os.push(o); }
      lfo.start(); intro = { g: g, o: os };
    },
    /* intro: sopro suave a cada troca de tela */
    introTransicao: function () {
      if (!ctx || !ligado) return;
      var t = ctx.currentTime;
      ruido(t, 0.9, { tipo: 'lowpass', f0: 500, f1: 120, ganho: 0.1, ataque: 0.15 });
      tom(t, 0.8, { tipo: 'sine', f0: 140, f1: 70, ganho: 0.1, ataque: 0.1 });
    },
    /* nova melhoria (perk) */
    perk: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.18, { tipo: 'triangle', f0: 520, f1: 780, ganho: 0.16, ataque: 0.01 });
      tom(t + 0.12, 0.3, { tipo: 'triangle', f0: 780, f1: 1170, ganho: 0.16, ataque: 0.01 });
    },
    /* aviso sonoro quando um especial aparece */
    alerta: function (tipo) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (tipo === 6) { for (var b = 0; b < 3; b++) tom(t + b * 0.14, 0.1, { tipo: 'square', f0: 1700, f1: 1700, ganho: 0.1, ataque: 0.005 }); return; }
      if (tipo === 4) {                 /* rugido grave do tanque */
        tom(t, 1.4, { tipo: 'sawtooth', f0: 95, f1: 38, ganho: 0.45, ataque: 0.08, filtro: 420 });
        tom(t + 0.05, 1.2, { tipo: 'square', f0: 47, f1: 30, ganho: 0.25, ataque: 0.1, filtro: 200 });
        ruido(t, 1.0, { tipo: 'lowpass', f0: 600, f1: 100, ganho: 0.35, ataque: 0.1 });
      } else if (tipo === 3) {          /* grito agudo do corredor */
        tom(t, 0.5, { tipo: 'sawtooth', f0: 900, f1: 2200, ganho: 0.14, ataque: 0.02, filtro: 3500 });
        tom(t + 0.12, 0.4, { tipo: 'square', f0: 1300, f1: 700, ganho: 0.05 });
      } else {                          /* borbulhar do tóxico */
        for (var i = 0; i < 5; i++) tom(t + i * 0.09, 0.14, { f0: 150 + i * 40, f1: 320 + i * 30, ganho: 0.2, ataque: 0.01 });
        ruido(t, 0.5, { tipo: 'bandpass', f0: 500, q: 2, ganho: 0.18 });
      }
    },
    chiado: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.28, { tipo: 'sawtooth', f0: 1200, f1: 2600, ganho: 0.16, ataque: 0.01, filtro: 4000 });
      ruido(t, 0.2, { tipo: 'highpass', f0: 3500, ganho: 0.18 });
    },
    granadaPino: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.05, { tipo: 'square', f0: 2200, f1: 1500, ganho: 0.12 });
      tom(t + 0.09, 0.04, { tipo: 'square', f0: 900, f1: 600, ganho: 0.12 });
    },
    /* RODADA 6: vidro quebrando + fogo (molotov), estouro curto (bala explosiva), mina plantada e escudo */
    molotov: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.18, { tipo: 'highpass', f0: 4200, ganho: 0.3 });
      ruido(t + 0.02, 0.6, { tipo: 'lowpass', f0: 900, f1: 300, ganho: 0.35 });
      tom(t, 0.35, { tipo: 'sawtooth', f0: 160, f1: 60, ganho: 0.12 });
    },
    estouro: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.14, { tipo: 'bandpass', f0: 1800, f1: 400, q: 0.8, ganho: 0.3 });
      tom(t, 0.12, { f0: 220, f1: 70, ganho: 0.25 });
    },
    minaPlantada: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.06, { tipo: 'square', f0: 900, f1: 900, ganho: 0.1 }); tom(t + 0.12, 0.06, { tipo: 'square', f0: 1200, f1: 1200, ganho: 0.1 });
      ruido(t, 0.05, { tipo: 'highpass', f0: 2500, ganho: 0.15 });
    },
    /* insano: "vush" curto de esquiva */
    esquiva: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.12, { tipo: 'bandpass', f0: 2600, f1: 900, q: 0.9, ganho: 0.16 });
    },
    quique: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.07, { tipo: 'triangle', f0: 1700, f1: 700, ganho: 0.18 });
      ruido(t, 0.04, { tipo: 'highpass', f0: 3000, ganho: 0.12 });
    },
    explosaoPesada: function (tp) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, tp === 1 ? 1.0 : 0.8, { tipo: 'lowpass', f0: 2200, f1: 60, ganho: 1.0 });
      tom(t, tp === 1 ? 0.8 : 0.6, { f0: 90, f1: 22, ganho: 1.0 });
      if (tp === 2) ruido(t + 0.02, 0.35, { tipo: 'highpass', f0: 3500, f1: 7000, ganho: 0.3 });
      else tom(t + 0.04, 0.4, { tipo: 'sawtooth', f0: 1500, f1: 400, ganho: 0.12, filtro: 2200 });
    },
    explosao: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      ruido(t, 0.7, { tipo: 'lowpass', f0: 1800, f1: 80, ganho: 0.85 });
      tom(t, 0.5, { f0: 100, f1: 28, ganho: 0.8 });
      for (var i = 0; i < 4; i++) tom(t + 0.05 * i, 0.2, { f0: 220 + i * 60, f1: 120, ganho: 0.1 });
    },
    grunhido: function (vol) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (t - ultimo.grunhido < 0.45) return; ultimo.grunhido = t;
      var f = 70 + Math.random() * 55, dur = 0.7 + Math.random() * 0.5;
      var os = ctx.createOscillator(); os.type = 'sawtooth';
      os.frequency.setValueAtTime(f * 1.35, t);
      os.frequency.exponentialRampToValueAtTime(f * 0.75, t + dur);
      var lfo = ctx.createOscillator(); lfo.frequency.value = 6 + Math.random() * 6;
      var lg = ctx.createGain(); lg.gain.value = 9;
      lfo.connect(lg); lg.connect(os.frequency);
      var fl = ctx.createBiquadFilter(); fl.type = 'bandpass'; fl.frequency.value = 420 + Math.random() * 260; fl.Q.value = 3;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22 * vol, t + 0.12);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      os.connect(fl); fl.connect(g); g.connect(master);
      os.start(t); lfo.start(t); os.stop(t + dur + 0.05); lfo.stop(t + dur + 0.05);
    },
    golpe: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (t - ultimo.golpe < 0.1) return; ultimo.golpe = t;
      tom(t, 0.22, { f0: 90, f1: 34, ganho: 0.9 });
      ruido(t, 0.16, { tipo: 'lowpass', f0: 1400, f1: 200, ganho: 0.5 });
    },
    /* alta tensão ao ser ferido: batida de coração dupla, zumbido dissonante e gemido grave (intensidade 0..1) */
    tensao: function (forca) {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      if (t - (ultimo.tensao || 0) < 0.35) return; ultimo.tensao = t;
      var f = Math.max(0.3, Math.min(1, forca || 0.6));
      tom(t, 0.14, { f0: 62, f1: 38, ganho: 0.85 * f });
      tom(t + 0.2, 0.16, { f0: 55, f1: 34, ganho: 0.65 * f });
      tom(t, 1.1 + f * 0.6, { tipo: 'sawtooth', f0: 233, f1: 215, ganho: 0.07 * f, ataque: 0.04, filtro: 900 });
      tom(t, 1.1 + f * 0.6, { tipo: 'sawtooth', f0: 330, f1: 305, ganho: 0.05 * f, ataque: 0.04, filtro: 900 });
      ruido(t + 0.02, 0.5, { tipo: 'bandpass', f0: 420, f1: 140, q: 3, ganho: 0.18 * f });
      tom(t + 0.05, 0.6, { tipo: 'triangle', f0: 150, f1: 70, ganho: 0.22 * f, ataque: 0.05 });
    },
    postos: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      for (var i = 0; i < 3; i++) tom(t + i * 0.16, 0.12, { tipo: 'square', f0: i === 1 ? 880 : 660, f1: i === 1 ? 880 : 660, ganho: 0.08, filtro: 2200 });
      ruido(t, 0.4, { tipo: 'bandpass', f0: 1800, f1: 900, q: 1.5, ganho: 0.12 });
    },
    conquista: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime, n = [392, 523, 659, 784];
      for (var i = 0; i < n.length; i++) tom(t + i * 0.09, 0.4, { tipo: 'triangle', f0: n[i], f1: n[i], ganho: 0.16, ataque: 0.01 });
    },
    rodada: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      var notas = [110, 130.8, 164.8];
      for (var i = 0; i < notas.length; i++) {
        tom(t + i * 0.18, 2.4, { tipo: 'sawtooth', f0: notas[i], f1: notas[i] * 0.92, ganho: 0.12, ataque: 0.5, filtro: 520 });
      }
      tom(t + 0.1, 1.8, { f0: 55, f1: 40, ganho: 0.5, ataque: 0.05 });
      ruido(t, 1.6, { tipo: 'lowpass', f0: 200, f1: 1800, ganho: 0.18, ataque: 1.2 });
      tom(t + 1.3, 1.5, { f0: 880, f1: 870, ganho: 0.07, ataque: 0.01 });
    },
    fimRodada: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      [392, 330, 262].forEach(function (f, i) { tom(t + i * 0.22, 0.9, { f0: f, f1: f * 0.99, ganho: 0.16, ataque: 0.01 }); });
    },
    coleta: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      [523, 659, 784, 1046].forEach(function (f, i) { tom(t + i * 0.07, 0.25, { tipo: 'triangle', f0: f, ganho: 0.18, ataque: 0.005 }); });
    },
    compra: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.15, { tipo: 'square', f0: 1200, f1: 1200, ganho: 0.09 });
      tom(t + 0.1, 0.3, { tipo: 'square', f0: 1800, f1: 1800, ganho: 0.09 });
    },
    sirene: function () { /* alerta curto: item prestes a sumir não usa; reservado */ },
    batida: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 0.14, { f0: 70, f1: 40, ganho: 0.5 });
      tom(t + 0.2, 0.12, { f0: 62, f1: 38, ganho: 0.35 });
    },
    fim: function () {
      if (!ctx || !ligado || silencio) return;
      var t = ctx.currentTime;
      tom(t, 2.5, { tipo: 'sawtooth', f0: 196, f1: 49, ganho: 0.22, ataque: 0.05, filtro: 700 });
      tom(t, 3, { f0: 60, f1: 28, ganho: 0.6, ataque: 0.05 });
      ruido(t, 2, { tipo: 'lowpass', f0: 1500, f1: 100, ganho: 0.3 });
    },
    ambiente: function (ligar) {
      if (!ctx) return;
      if (!ligar) { if (ambiente) { try { ambiente.g.gain.setTargetAtTime(0, ctx.currentTime, 0.4); } catch (e) { } } return; }
      if (ambiente) { ambiente.g.gain.setTargetAtTime(0.5, ctx.currentTime, 0.6); return; }
      var g = ctx.createGain(); g.gain.value = 0; g.connect(master);
      g.gain.setTargetAtTime(0.5, ctx.currentTime, 1.0);
      var src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 260; f.Q.value = 1.4;
      var vento = ctx.createGain(); vento.gain.value = 0.07;
      var lfo = ctx.createOscillator(); lfo.frequency.value = 0.11;
      var lg = ctx.createGain(); lg.gain.value = 140;
      lfo.connect(lg); lg.connect(f.frequency);
      src.connect(f); f.connect(vento); vento.connect(g);
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
      o1.type = 'sine'; o2.type = 'sine'; o1.frequency.value = 48; o2.frequency.value = 50.3;
      var og = ctx.createGain(); og.gain.value = 0.05;
      o1.connect(og); o2.connect(og); og.connect(g);
      src.start(); lfo.start(); o1.start(); o2.start();
      ambiente = { g: g };
    }
  };
  MV.Som = Som;
})(window.MV = window.MV || {});
