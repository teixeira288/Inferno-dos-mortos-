/*
 * sim-js.js : versão em JavaScript puro do núcleo de simulação (mesma API do sim.c).
 * Só é usada se o navegador não suportar WebAssembly (ou se o carregamento do .wasm falhar).
 * O algoritmo e a ordem das operações são idênticos ao sim.c; o script tools/diff-test.mjs
 * compara os dois bit a bit.
 */
(function (root) {
  'use strict';
  function createSimJS() {
    var MAXZ = 160, ZS = 30, MAXB = 160, BS = 12, MAXG = 32, GS = 14, MAXE = 256, ES = 9, MAXO = 32, MAXF = 16;
    var CELL = 48.0, GW = 64, GH = 48;
    var BOOM_R = 125.0, BOOM_DMG = 150.0, BOMB_R = 118.0, BOMB_DMG = 135.0, BOMB_FUSE = 1.5, BRUTE_R = 96.0;
    var RISE = 0.6, COS_ST = 0.62160997, SIN_ST = 0.78332691;

    var Z = new Float64Array(MAXZ * ZS);
    var B = new Float64Array(MAXB * BS);
    var G = new Float64Array(MAXG * GS);
    var E = new Float64Array(MAXE * ES);
    var FU = new Float64Array(MAXF * 3);      /* pavios pendentes de Bombers mortos: x, y, tempo restante */
    var nFu = 0;
    var O = new Float64Array(MAXO * 4);
    var gHead = new Int32Array(GW * GH);
    var gNext = new Int32Array(MAXZ);

    var nObs = 0, nEv = 0;
    var px = 0, py = 0, pr = 14;
    var minX = 0, minY = 0, maxX = 2400, maxY = 1800;
    var insta = 0;
    var seed = 12345 >>> 0;
    var qx = 0, qy = 0;

    function rnd() {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296.0;
    }
    var sq = Math.sqrt;

    function evx(t, x, y, a, b, c, idx, tag, aux) {
      if (nEv >= MAXE) return;
      var o = nEv * ES;
      E[o] = t; E[o + 1] = x; E[o + 2] = y; E[o + 3] = a; E[o + 4] = b; E[o + 5] = c; E[o + 6] = idx; E[o + 7] = tag; E[o + 8] = aux;
      nEv++;
    }
    function ev(t, x, y, a, b, c) { evx(t, x, y, a, b, c, -1.0, 0.0, 0.0); }
    function clampi(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function cellX(x) { return clampi((x / CELL) | 0, 0, GW - 1); }
    function cellY(y) { return clampi((y / CELL) | 0, 0, GH - 1); }

    function buildGrid() {
      for (var i = 0; i < GW * GH; i++) gHead[i] = -1;
      for (i = 0; i < MAXZ; i++) {
        var o = i * ZS;
        if (Z[o] < 0.5) continue;
        var c = cellY(Z[o + 2]) * GW + cellX(Z[o + 1]);
        gNext[i] = gHead[c];
        gHead[c] = i;
      }
    }

    function pushOutRect(r, ox, oy, w, h) {
      var x = qx, y = qy;
      var cx = x < ox ? ox : (x > ox + w ? ox + w : x);
      var cy = y < oy ? oy : (y > oy + h ? oy + h : y);
      var dx = x - cx, dy = y - cy;
      var d2 = dx * dx + dy * dy;
      if (d2 >= r * r) return 0;
      if (d2 > 1e-9) {
        var d = sq(d2);
        var k = (r - d) / d;
        qx = x + dx * k;
        qy = y + dy * k;
        return 1;
      }
      var l = x - ox, rr = ox + w - x, t = y - oy, b = oy + h - y;
      var m = l, ax = 0;
      if (rr < m) { m = rr; ax = 1; }
      if (t < m) { m = t; ax = 2; }
      if (b < m) { m = b; ax = 3; }
      if (ax === 0) qx = ox - r;
      else if (ax === 1) qx = ox + w + r;
      else if (ax === 2) qy = oy - r;
      else qy = oy + h + r;
      return 1;
    }

    function segBlocked(x1, y1, x2, y2) {
      var dx = x2 - x1, dy = y2 - y1;
      for (var k = 0; k < nObs; k++) {
        var ox = O[k * 4], oy = O[k * 4 + 1], w = O[k * 4 + 2], h = O[k * 4 + 3];
        var t0 = 0, t1 = 1;
        var adx = dx < 0 ? -dx : dx;
        var inv, ta, tb, s;
        if (adx < 1e-12) {
          if (x1 < ox || x1 > ox + w) continue;
        } else {
          inv = 1.0 / dx;
          ta = (ox - x1) * inv; tb = (ox + w - x1) * inv;
          if (ta > tb) { s = ta; ta = tb; tb = s; }
          if (ta > t0) t0 = ta;
          if (tb < t1) t1 = tb;
          if (t0 > t1) continue;
        }
        var ady = dy < 0 ? -dy : dy;
        if (ady < 1e-12) {
          if (y1 < oy || y1 > oy + h) continue;
        } else {
          inv = 1.0 / dy;
          ta = (oy - y1) * inv; tb = (oy + h - y1) * inv;
          if (ta > tb) { s = ta; ta = tb; tb = s; }
          if (ta > t0) t0 = ta;
          if (tb < t1) t1 = tb;
          if (t0 > t1) continue;
        }
        return 1;
      }
      return 0;
    }

    /* efeitos da morte: o tóxico explode na hora; o Bomber deixa um pavio (o que restava, ou 1,5 s) e explode depois */
    function deathAux(o) {
      if ((Z[o + 11] | 0) !== 6) return 0.0;
      return Z[o + 17] > 0.5 ? (Z[o + 28] > 0 ? Z[o + 28] : 0.0) : BOMB_FUSE;
    }
    function deathEffects(o, aux) {
      var tp = Z[o + 11] | 0;
      if (tp === 5) explode(Z[o + 1], Z[o + 2], BOOM_R, BOOM_DMG, 30.0);
      else if (tp === 6) {
        if (nFu < MAXF) { FU[nFu * 3] = Z[o + 1]; FU[nFu * 3 + 1] = Z[o + 2]; FU[nFu * 3 + 2] = aux; nFu++; }
        else explodeBomber(Z[o + 1], Z[o + 2]);
      }
    }
    /* dano em área nos zumbis (cai até 50% na borda). Zumbis tóxicos atingidos explodem em cadeia. */
    function areaDamage(x, y, r, dmg, kb) {
      for (var i = 0; i < MAXZ; i++) {
        var o = i * ZS;
        if (Z[o] < 0.5) continue;
        var dx = Z[o + 1] - x, dy = Z[o + 2] - y;
        var d = sq(dx * dx + dy * dy);
        var alc = r + Z[o + 6];
        if (d >= alc) continue;
        var dm = dmg * (1.0 - 0.5 * (d / alc));
        var l = d < 1e-6 ? 1.0 : d;
        var ex = d < 1e-6 ? 0.0 : dx / l, ey = d < 1e-6 ? 1.0 : dy / l;
        if (insta) Z[o + 3] = 0; else Z[o + 3] -= dm;
        Z[o + 9] = 0.09;
        if (Z[o + 3] <= 0) {
          Z[o] = 0;
          var axx = deathAux(o);
          evx(2, Z[o + 1], Z[o + 2], ex, ey, Z[o + 11], i, 100.0, axx);
          deathEffects(o, axx);
        } else {
          evx(1, Z[o + 1], Z[o + 2], ex, ey, dm, i, 100.0, 0.0);
          if (kb > 0) {
            var kk = kb * (1.0 - d / alc);
            if ((Z[o + 11] | 0) === 4) kk *= 0.2;
            Z[o + 1] += ex * kk; Z[o + 2] += ey * kk;
          }
        }
      }
    }
    function explode(x, y, r, dmg, kb) {
      ev(6, x, y, r, 0, 5);
      areaDamage(x, y, r, dmg, kb);
    }
    function explodeBomber(x, y) {
      ev(15, x, y, BOMB_R, 0, 6);
      areaDamage(x, y, BOMB_R, BOMB_DMG, 60.0);
    }

    function launchH(tipo, x, y, vx, vy, z, vz, tempo, dmg, raio) {
      for (var i = 0; i < MAXG; i++) {
        var g = i * GS;
        if (G[g] > 0.5) continue;
        G[g] = 1; G[g + 1] = x; G[g + 2] = y; G[g + 3] = vx; G[g + 4] = vy; G[g + 5] = z; G[g + 6] = vz; G[g + 7] = tempo;
        G[g + 8] = tipo; G[g + 9] = dmg; G[g + 10] = raio; G[g + 11] = 0; G[g + 12] = tipo === 4 ? tempo : 0; G[g + 13] = 0;
        return i;
      }
      return -1;
    }
    var DC = [1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905,0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583];
    var DS = [0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583,1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905];
    var aiLvl = 1, rearGo = 1, nVan = 0, aiPress = 0, pfx = 1, pfy = 0;
    var insane = 0, pvInit = 0, pvx = 0, pvy = 0, lpx = 0, lpy = 0;   /* modo insano (ver sim.c) */
    var rox = 0, roy = 0;
    function rot24(x, y, k) {
      k = k % 24; if (k < 0) k += 24;
      var c = DC[k], sn = DS[k];
      rox = x * c - y * sn; roy = x * sn + y * c;
    }
    function director() {
      nVan = 0;
      for (var i = 0; i < MAXZ; i++) { var o = i * ZS; if (Z[o] > 0.5 && (Z[o + 22] | 0) !== 2) nVan++; }
      if (aiLvl === 0) rearGo = 1;
      else if (aiLvl === 1) rearGo = (nVan <= 3 || aiPress > 0.6) ? 1 : 0;
      else rearGo = (nVan <= 2 || aiPress > 0.35) ? 1 : 0;
    }

    function stepZombies(dt) {
      for (var i = 0; i < MAXZ; i++) {
        var o = i * ZS;
        if (Z[o] < 0.5) continue;
        var r = Z[o + 6];
        Z[o + 12] += dt;
        if (Z[o + 9] > 0) Z[o + 9] -= dt;
        if (Z[o + 10] > 0) Z[o + 10] -= dt;
        if (Z[o + 15] > 0) Z[o + 15] -= dt;
        if (Z[o + 14] > 0) Z[o + 14] -= dt;
        if (Z[o + 29] > 0) Z[o + 29] -= dt;
        if (insane && (Z[o + 11] | 0) === 0 && Z[o + 12] >= RISE && Z[o + 3] < Z[o + 4] * 0.75 && rnd() < 0.45 * dt) {
          Z[o + 3] += Z[o + 4] * 0.1; if (Z[o + 3] > Z[o + 4]) Z[o + 3] = Z[o + 4];
          ev(12, Z[o + 1], Z[o + 2], 0, 0, 0);
        }

        var dx = px - Z[o + 1], dy = py - Z[o + 2];
        var d = sq(dx * dx + dy * dy);
        if (d < 1e-6) d = 1e-6;
        var ux = dx / d, uy = dy / d;
        var role = Z[o + 22] | 0;
        var holdD = 0;
        if (aiLvl > 0 && Z[o + 12] >= RISE) {
          var Rr = aiLvl === 2 ? 150.0 : 190.0;
          var ttx = px, tty = py, alt = 0;
          if (role === 1 && d > 140.0) {
            rot24(-pfx, -pfy, Z[o + 23] | 0);
            ttx = px + rox * Rr; tty = py + roy * Rr; alt = 1;
          } else if (role === 0 && aiLvl === 2 && d > 260.0) {
            rot24(pfx, pfy, Z[o + 23] | 0);
            ttx = px + rox * Rr * 1.4; tty = py + roy * Rr * 1.4; alt = 1;
          }
          if (alt) {
            var eex = ttx - Z[o + 1], eey = tty - Z[o + 2];
            var ee = sq(eex * eex + eey * eey);
            if (ee > 50.0) { ux = eex / ee; uy = eey / ee; }
          } else if (insane && d > 90.0) {
            var lead = d / (Z[o + 5] + 60.0);
            if (lead > 0.8) lead = 0.8;
            ttx = px + pvx * lead; tty = py + pvy * lead;
            var eex2 = ttx - Z[o + 1], eey2 = tty - Z[o + 2];
            var ee2 = sq(eex2 * eex2 + eey2 * eey2);
            if (ee2 > 30.0) { ux = eex2 / ee2; uy = eey2 / ee2; }
          }
          if (role === 2 && !rearGo && Z[o + 12] < 25.0) holdD = aiLvl === 2 ? 330.0 : 260.0;
        }
        if (aiLvl > 0 && Z[o + 12] >= RISE && (Z[o + 17] | 0) === 0 && (Z[o + 11] | 0) !== 4) {
          var sepx = 0, sepy = 0;
          var scx = cellX(Z[o + 1]), scy = cellY(Z[o + 2]);
          for (var sgy = scy - 1; sgy <= scy + 1; sgy++) {
            if (sgy < 0 || sgy >= GH) continue;
            for (var sgx = scx - 1; sgx <= scx + 1; sgx++) {
              if (sgx < 0 || sgx >= GW) continue;
              for (var sj = gHead[sgy * GW + sgx]; sj >= 0; sj = gNext[sj]) {
                if (sj === i) continue;
                var so = sj * ZS;
                if (Z[so] < 0.5) continue;
                var fqx = Z[o + 1] - Z[so + 1], fqy = Z[o + 2] - Z[so + 2];
                var cm = r + Z[so + 6] + 18.0;
                var q2 = fqx * fqx + fqy * fqy;
                if (q2 < cm * cm && q2 > 1e-6) { var qd = sq(q2); var w = (cm - qd) / cm; sepx += fqx / qd * w; sepy += fqy / qd * w; }
              }
            }
          }
          var mx2 = ux + sepx * 1.1, my2 = uy + sepy * 1.1;
          if (role === 0 && d > 200.0) {
            var lat = (((Z[o + 23] | 0) % 5 + 5) % 5 - 2.0) * 0.12;
            mx2 += -uy * lat; my2 += ux * lat;
          }
          var ml = sq(mx2 * mx2 + my2 * my2);
          if (ml > 1e-6) { ux = mx2 / ml; uy = my2 / ml; }
        }
        if (Z[o + 14] > 0) {
          var s = Z[o + 13] * SIN_ST;
          var nx = ux * COS_ST - uy * s;
          var ny = ux * s + uy * COS_ST;
          ux = nx; uy = ny;
        }
        var k = (aiLvl === 0 ? 4.0 : (insane ? 16.0 : 10.0)) * dt;
        if (k > 1) k = 1;
        var hx = Z[o + 7] + (ux - Z[o + 7]) * k;
        var hy = Z[o + 8] + (uy - Z[o + 8]) * k;
        var hl = sq(hx * hx + hy * hy);
        if (hl < 1e-6) { hx = ux; hy = uy; hl = 1.0; }
        hx /= hl; hy /= hl;
        Z[o + 7] = hx; Z[o + 8] = hy;

        var tp = Z[o + 11] | 0;
        var spd = Z[o + 5];
        var canMove = 1;
        if (Z[o + 24] > 0) { Z[o + 24] -= dt; spd *= 1.3; }
        if (Z[o + 29] > 0) spd *= 0.6;
        if (tp === 4 && Z[o + 3] < Z[o + 4]) {
          if (Z[o + 25] < 0.5) {
            Z[o + 25] = 1.0; Z[o + 21] = 0.5;
            ev(10, Z[o + 1], Z[o + 2], 320.0, 0, 0);
            for (var q = 0; q < MAXZ; q++) {
              var oo = q * ZS;
              if (q === i || Z[oo] < 0.5) continue;
              var bbx = Z[oo + 1] - Z[o + 1], bby = Z[oo + 2] - Z[o + 2];
              if (bbx * bbx + bby * bby < 320.0 * 320.0) Z[oo + 24] = 6.0;
            }
          }
          spd *= 1.7;
        }
        if (tp === 5) {
          if (Z[o + 25] > 0) Z[o + 25] -= dt;
          if (aiLvl > 0 && Z[o + 12] >= RISE && Z[o + 25] <= 0 && d > 200.0 && d < 430.0 && (rearGo || role !== 2) && (aiPress > 0.3 || aiLvl === 2) && !segBlocked(Z[o + 1], Z[o + 2], px, py)) {
            Z[o + 25] = aiLvl === 2 ? 4.5 : 8.0;
            var gi = launchH(3.0, Z[o + 1], Z[o + 2], dx / 0.9, dy / 0.9, 0, 0, 0.9, 0, 95.0);
            if (gi >= 0) G[gi * GS + 12] = 0.9;
          }
        }
        var hunter = Z[o + 26] < 0.5 && ((tp === 3) || (tp === 4 && Z[o + 25] > 0.5));
        if (hunter) {
          if (Z[o + 21] > 0) Z[o + 21] -= dt;
          var st = Z[o + 17] | 0;
          var wind = tp === 4 ? 0.5 : (aiLvl === 0 ? 0.7 : (aiLvl === 1 ? 0.4 : 0.28));
          var lsp = tp === 4 ? 430.0 : 560.0, lt = tp === 4 ? 0.6 : 0.5, rec = tp === 4 ? 1.0 : 0.7;
          var cdv = tp === 4 ? 3.5 : (aiLvl === 2 ? (aiPress > 0.5 ? 1.6 : 2.4) : (aiLvl === 1 ? 3.0 : 4.0));
          var rmin = tp === 4 ? 120.0 : 90.0, rmax = tp === 4 ? 380.0 : ((aiLvl >= 1 && aiPress > 0.5) ? 420.0 : 320.0);
          if (st === 0) {
            if (Z[o + 12] >= RISE && Z[o + 21] <= 0 && d < rmax && d > rmin) {
              Z[o + 17] = 1; Z[o + 18] = wind; canMove = 0;
              ev(5, Z[o + 1], Z[o + 2], 0, 0, Z[o + 11]);
            }
          } else if (st === 1) {
            canMove = 0;
            Z[o + 18] -= dt;
            if (Z[o + 18] <= 0) { Z[o + 17] = 2; Z[o + 18] = lt; Z[o + 19] = dx / d; Z[o + 20] = dy / d; }
          } else if (st === 2) {
            Z[o + 18] -= dt;
            spd = lsp; hx = Z[o + 19]; hy = Z[o + 20]; Z[o + 7] = hx; Z[o + 8] = hy;
            if (Z[o + 18] <= 0) { Z[o + 17] = 3; Z[o + 18] = rec; Z[o + 21] = cdv; }
          } else {
            canMove = 0;
            Z[o + 18] -= dt;
            if (Z[o + 18] <= 0) Z[o + 17] = 0;
          }
        }

        var reach = r + pr + 4.0;
        var x = Z[o + 1], y = Z[o + 2];
        if (Z[o + 12] >= RISE && d > reach && canMove && !(holdD > 0 && d <= holdD)) {
          var mv = spd * dt;
          var room = d - reach;
          if (mv > room) mv = room;
          x += hx * mv;
          y += hy * mv;
        }

        var cx = cellX(x), cy = cellY(y);
        for (var gy = cy - 1; gy <= cy + 1; gy++) {
          if (gy < 0 || gy >= GH) continue;
          for (var gx = cx - 1; gx <= cx + 1; gx++) {
            if (gx < 0 || gx >= GW) continue;
            for (var j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
              if (j === i) continue;
              var p = j * ZS;
              if (Z[p] < 0.5) continue;
              var sx = x - Z[p + 1], sy = y - Z[p + 2];
              var rr = r + Z[p + 6];
              var s2 = sx * sx + sy * sy;
              if (s2 < rr * rr) {
                if (s2 < 1e-6) {
                  x += (i < j) ? 0.5 : -0.5;
                } else {
                  var sd = sq(s2);
                  var ov = (rr - sd) / sd * 0.3;
                  x += sx * ov;
                  y += sy * ov;
                }
              }
            }
          }
        }

        var hit = 0, hcx = 0, hcy = 0;
        qx = x; qy = y;
        for (var q = 0; q < nObs; q++) {
          var ox = O[q * 4], oy = O[q * 4 + 1], w = O[q * 4 + 2], h = O[q * 4 + 3];
          if (pushOutRect(r, ox, oy, w, h)) {
            if (!hit) { hcx = ox + w * 0.5; hcy = oy + h * 0.5; }
            hit = 1;
          }
        }
        x = qx; y = qy;
        if (hit && Z[o + 14] <= 0) {
          var ax = hcx - Z[o + 1], ay = hcy - Z[o + 2];
          var cr = ax * dy - ay * dx;
          Z[o + 13] = cr > 0 ? 1.0 : -1.0;
          Z[o + 14] = 0.5;
        }

        if (x < minX + r) x = minX + r;
        if (x > maxX - r) x = maxX - r;
        if (y < minY + r) y = minY + r;
        if (y > maxY - r) y = maxY - r;

        var ddx = px - x, ddy = py - y;
        var dd2 = ddx * ddx + ddy * ddy;
        var minD = r + pr;
        if (dd2 < minD * minD) {
          var dd0 = sq(dd2);
          if (dd0 < 1e-6) {
            x -= minD;
          } else {
            var push = (minD - dd0) / dd0;
            x -= ddx * push;
            y -= ddy * push;
          }
        }
        Z[o + 1] = x; Z[o + 2] = y;

        ddx = px - x; ddy = py - y;
        var dd = sq(ddx * ddx + ddy * ddy);
        if (tp === 5) {
          if (Z[o + 12] >= RISE && dd <= reach + 4.0) {
            Z[o] = 0;
            explode(x, y, BOOM_R, BOOM_DMG, 30.0);
          }
        } else if (tp === 6) {
          if (Z[o + 12] >= RISE) {
            if ((Z[o + 17] | 0) === 0) {
              if (dd <= reach + 38.0) { Z[o + 17] = 1; Z[o + 28] = BOMB_FUSE; evx(16, x, y, BOMB_FUSE, 0, 6, i, 0.0, 0.0); }
            } else {
              Z[o + 28] -= dt;
              if (Z[o + 28] <= 0) { Z[o] = 0; evx(2, x, y, 0, 0, 6, i, 102.0, 0.0); explodeBomber(x, y); }
            }
          }
        } else if (Z[o + 12] >= RISE && dd <= reach + 2.0 + (tp === 2 ? 24.0 : 0.0) && Z[o + 10] <= 0) {
          Z[o + 10] = tp === 4 ? (Z[o + 25] > 0.5 ? 0.85 : 1.6) : (tp === 3 ? 0.6 : (tp === 2 ? 1.5 : 1.0));
          Z[o + 15] = 0.35;
          var dm = Z[o + 16];
          if ((tp === 3 || tp === 4) && (Z[o + 17] | 0) === 2) { dm *= tp === 4 ? 1.4 : 1.6; Z[o + 17] = 3; Z[o + 18] = tp === 4 ? 1.0 : 0.7; Z[o + 21] = tp === 4 ? 3.5 : 3.0; }
          if (tp === 2) evx(17, x, y, BRUTE_R, 0, dm, i, 0.0, 0.0);
          else ev(3, x, y, dm, 0, Z[o + 11]);
        }
      }
    }

    function stepBullets(dt) {
      for (var i = 0; i < MAXB; i++) {
        var o = i * BS;
        if (B[o] < 0.5) continue;
        var sp = sq(B[o + 3] * B[o + 3] + B[o + 4] * B[o + 4]);
        var dirx = B[o + 3] / sp, diry = B[o + 4] / sp;
        var n = ((sp * dt / 12.0) | 0) + 1;
        var sdt = dt / n;
        for (var s = 0; s < n; s++) {
          B[o + 1] += B[o + 3] * sdt;
          B[o + 2] += B[o + 4] * sdt;
          B[o + 6] -= sdt;
          var x = B[o + 1], y = B[o + 2];
          if (x < minX || x > maxX || y < minY || y > maxY) {
            var cxp = x < minX ? minX : (x > maxX ? maxX : x), cyp = y < minY ? minY : (y > maxY ? maxY : y);
            var tg0 = B[o + 11] | 0;
            if ((tg0 & 64) && !(tg0 & 128)) {
              if (x < minX || x > maxX) B[o + 3] = -B[o + 3];
              if (y < minY || y > maxY) B[o + 4] = -B[o + 4];
              B[o + 1] = cxp; B[o + 2] = cyp; B[o + 11] = tg0 | 128;
              dirx = B[o + 3] / sp; diry = B[o + 4] / sp;
              ev(4, cxp, cyp, dirx, diry, 0);
              continue;
            }
            B[o] = 0;
            ev(4, cxp, cyp, dirx, diry, 0);
            break;
          }
          var wall = 0, wq = 0;
          for (var q = 0; q < nObs; q++) {
            var ox = O[q * 4], oy = O[q * 4 + 1];
            if (x >= ox && x <= ox + O[q * 4 + 2] && y >= oy && y <= oy + O[q * 4 + 3]) { wall = 1; wq = q; break; }
          }
          if (wall) {
            var tg1 = B[o + 11] | 0;
            if ((tg1 & 64) && !(tg1 & 128)) {
              var qx0 = x - B[o + 3] * sdt, qy0 = y - B[o + 4] * sdt;
              var wx = O[wq * 4], wy = O[wq * 4 + 1], ww = O[wq * 4 + 2], wh = O[wq * 4 + 3];
              if (qx0 < wx || qx0 > wx + ww) B[o + 3] = -B[o + 3];
              else if (qy0 < wy || qy0 > wy + wh) B[o + 4] = -B[o + 4];
              else { B[o + 3] = -B[o + 3]; B[o + 4] = -B[o + 4]; }
              B[o + 1] = qx0; B[o + 2] = qy0; B[o + 11] = tg1 | 128;
              dirx = B[o + 3] / sp; diry = B[o + 4] / sp;
              ev(4, qx0, qy0, dirx, diry, 0);
              continue;
            }
            B[o] = 0;
            ev(4, x, y, dirx, diry, 0);
            break;
          }
          var cx = cellX(x), cy = cellY(y);
          var done = 0;
          for (var gy = cy - 1; gy <= cy + 1 && !done; gy++) {
            if (gy < 0 || gy >= GH) continue;
            for (var gx = cx - 1; gx <= cx + 1 && !done; gx++) {
              if (gx < 0 || gx >= GW) continue;
              for (var j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
                var p = j * ZS;
                if (Z[p] < 0.5) continue;
                if (B[o + 8] === j + 1 || B[o + 9] === j + 1) continue;
                var ex = x - Z[p + 1], ey = y - Z[p + 2];
                var rr = Z[p + 6] + 3.0;
                if (ex * ex + ey * ey < rr * rr) {
                  if (insane && (Z[p + 11] | 0) === 0 && rnd() < 0.2) {
                    Z[p + 14] = 0.35;
                    ev(11, Z[p + 1], Z[p + 2], dirx, diry, 0);
                    B[o + 9] = B[o + 8]; B[o + 8] = j + 1;
                    continue;
                  }
                  var dmg = B[o + 5];
                  var tagb = B[o + 11] | 0;
                  evx(14, x, y, dirx, diry, j, j, tagb, 0.0);
                  if (insta) Z[p + 3] = 0; else Z[p + 3] -= dmg;
                  Z[p + 9] = 0.09;
                  var kn = B[o + 10];
                  if ((Z[p + 11] | 0) === 4) kn *= 0.15;
                  Z[p + 1] += dirx * kn;
                  Z[p + 2] += diry * kn;
                  if (Z[p + 3] <= 0) {
                    Z[p] = 0;
                    var axb = deathAux(p);
                    evx(2, Z[p + 1], Z[p + 2], dirx, diry, Z[p + 11], j, tagb, axb);
                    deathEffects(p, axb);
                  } else {
                    evx(1, x, y, dirx, diry, dmg, j, tagb, 0.0);
                  }
                  if (B[o + 7] > 0) {
                    B[o + 7] -= 1;
                    B[o + 9] = B[o + 8];
                    B[o + 8] = j + 1;
                  } else {
                    B[o] = 0;
                    done = 1;
                    break;
                  }
                }
              }
            }
          }
          if (done) break;
          if (B[o + 6] <= 0) { B[o] = 0; break; }
        }
      }
    }

    function fireB(x, y, dx, dy, speed, dmg, life, pierce, knock) {
      for (var i = 0; i < MAXB; i++) {
        var o = i * BS;
        if (B[o] > 0.5) continue;
        B[o] = 1; B[o + 1] = x; B[o + 2] = y; B[o + 3] = dx * speed; B[o + 4] = dy * speed;
        B[o + 5] = dmg; B[o + 6] = life; B[o + 7] = pierce; B[o + 8] = 0; B[o + 9] = 0; B[o + 10] = knock; B[o + 11] = 0;
        return i;
      }
      return -1;
    }
    var SH_C = [1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905,0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583];
    var SH_S = [0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583,1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905];

    function explodeHeavy(x, y, r, dmg, tipo) {
      ev(7, x, y, r, 0, tipo);
      areaDamage(x, y, r, dmg, tipo === 1 ? 110.0 : 70.0);
      if (tipo === 2) {
        for (var k = 0; k < 24; k++) {
          var life = 0.2 + rnd() * 0.18;
          fireB(x + SH_C[k] * 6.0, y + SH_S[k] * 6.0, SH_C[k], SH_S[k], 950.0, 38.0, life, 1.0, 8.0);
        }
      }
    }

    function stepHeavy(dt) {
      for (var i = 0; i < MAXG; i++) {
        var g = i * GS;
        if (G[g] < 0.5) continue;
        var tp = G[g + 8] | 0;
        if (tp === 1) {
          var sp = sq(G[g + 3] * G[g + 3] + G[g + 4] * G[g + 4]);
          var n = ((sp * dt / 12.0) | 0) + 1;
          var sdt = dt / n;
          for (var s = 0; s < n; s++) {
            G[g + 1] += G[g + 3] * sdt; G[g + 2] += G[g + 4] * sdt; G[g + 7] -= sdt;
            var x = G[g + 1], y = G[g + 2];
            var boom = 0;
            if (x < minX || x > maxX || y < minY || y > maxY) boom = 1;
            for (var q = 0; q < nObs && !boom; q++) {
              var ox = O[q * 4], oy = O[q * 4 + 1];
              if (x >= ox && x <= ox + O[q * 4 + 2] && y >= oy && y <= oy + O[q * 4 + 3]) boom = 1;
            }
            if (!boom) {
              var cx = cellX(x), cy = cellY(y);
              for (var gy = cy - 1; gy <= cy + 1 && !boom; gy++) {
                if (gy < 0 || gy >= GH) continue;
                for (var gx = cx - 1; gx <= cx + 1 && !boom; gx++) {
                  if (gx < 0 || gx >= GW) continue;
                  for (var j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
                    var z = j * ZS;
                    if (Z[z] < 0.5) continue;
                    var ex = x - Z[z + 1], ey = y - Z[z + 2];
                    var rr = Z[z + 6] + 8.0;
                    if (ex * ex + ey * ey < rr * rr) { boom = 1; break; }
                  }
                }
              }
            }
            if (G[g + 7] <= 0) boom = 1;
            if (boom) {
              G[g] = 0;
              var bx = G[g + 1] < minX ? minX : (G[g + 1] > maxX ? maxX : G[g + 1]);
              var by = G[g + 2] < minY ? minY : (G[g + 2] > maxY ? maxY : G[g + 2]);
              explodeHeavy(bx, by, G[g + 10], G[g + 9], 1);
              break;
            }
          }
        } else if (tp === 3 || tp === 4) {
          G[g + 7] -= dt;
          G[g + 1] += G[g + 3] * dt; G[g + 2] += G[g + 4] * dt;
          var uu = 1.0 - G[g + 7] / G[g + 12];
          G[g + 5] = 240.0 * uu * (1.0 - uu);
          if (G[g + 7] <= 0) {
            G[g] = 0;
            var sbx = G[g + 1] < minX ? minX : (G[g + 1] > maxX ? maxX : G[g + 1]);
            var sby = G[g + 2] < minY ? minY : (G[g + 2] > maxY ? maxY : G[g + 2]);
            ev(tp === 3 ? 9 : 13, sbx, sby, G[g + 10], 0, 0);
          }
        } else {
          G[g + 7] -= dt;
          G[g + 6] -= 1400.0 * dt;
          G[g + 5] += G[g + 6] * dt;
          G[g + 1] += G[g + 3] * dt; G[g + 2] += G[g + 4] * dt;
          if (G[g + 5] <= 0) {
            G[g + 5] = 0;
            if (G[g + 6] < -120.0) {
              G[g + 6] = -G[g + 6] * 0.42; G[g + 3] *= 0.72; G[g + 4] *= 0.72; G[g + 11] += 1;
              ev(8, G[g + 1], G[g + 2], 0, 0, 0);
            } else G[g + 6] = 0;
            var fr = 1.0 - 5.0 * dt;
            if (fr < 0) fr = 0;
            G[g + 3] *= fr; G[g + 4] *= fr;
          }
          qx = G[g + 1]; qy = G[g + 2];
          for (var q2 = 0; q2 < nObs; q2++) {
            if (pushOutRect(5.0, O[q2 * 4], O[q2 * 4 + 1], O[q2 * 4 + 2], O[q2 * 4 + 3])) {
              var nx = qx - G[g + 1], ny = qy - G[g + 2];
              var nl = sq(nx * nx + ny * ny);
              if (nl > 1e-9) {
                nx /= nl; ny /= nl;
                var dp = G[g + 3] * nx + G[g + 4] * ny;
                if (dp < 0) { G[g + 3] -= 1.5 * dp * nx; G[g + 4] -= 1.5 * dp * ny; }
              }
              G[g + 1] = qx; G[g + 2] = qy;
              ev(8, G[g + 1], G[g + 2], 0, 0, 0);
            }
          }
          if (G[g + 1] < minX + 5.0) { G[g + 1] = minX + 5.0; if (G[g + 3] < 0) G[g + 3] = -G[g + 3] * 0.5; }
          if (G[g + 1] > maxX - 5.0) { G[g + 1] = maxX - 5.0; if (G[g + 3] > 0) G[g + 3] = -G[g + 3] * 0.5; }
          if (G[g + 2] < minY + 5.0) { G[g + 2] = minY + 5.0; if (G[g + 4] < 0) G[g + 4] = -G[g + 4] * 0.5; }
          if (G[g + 2] > maxY - 5.0) { G[g + 2] = maxY - 5.0; if (G[g + 4] > 0) G[g + 4] = -G[g + 4] * 0.5; }
          var contato = 0;
          if (G[g + 5] < 28.0) {
            var cx2 = cellX(G[g + 1]), cy2 = cellY(G[g + 2]);
            for (var gy2 = cy2 - 1; gy2 <= cy2 + 1 && !contato; gy2++) {
              if (gy2 < 0 || gy2 >= GH) continue;
              for (var gx2 = cx2 - 1; gx2 <= cx2 + 1 && !contato; gx2++) {
                if (gx2 < 0 || gx2 >= GW) continue;
                for (var j2 = gHead[gy2 * GW + gx2]; j2 >= 0; j2 = gNext[j2]) {
                  var z2 = j2 * ZS;
                  if (Z[z2] < 0.5) continue;
                  var ex2 = G[g + 1] - Z[z2 + 1], ey2 = G[g + 2] - Z[z2 + 2];
                  var rr2 = Z[z2 + 6] + 6.0;
                  if (ex2 * ex2 + ey2 * ey2 < rr2 * rr2) { contato = 1; break; }
                }
              }
            }
          }
          if (G[g + 7] <= 0 || contato) {
            G[g] = 0;
            explodeHeavy(G[g + 1], G[g + 2], G[g + 10], G[g + 9], 2);
          }
        }
      }
    }

    function stepFuses(dt) {
      for (var i = 0; i < nFu;) {
        FU[i * 3 + 2] -= dt;
        if (FU[i * 3 + 2] <= 0) {
          var fx = FU[i * 3], fy = FU[i * 3 + 1];
          nFu--;
          FU[i * 3] = FU[nFu * 3]; FU[i * 3 + 1] = FU[nFu * 3 + 1]; FU[i * 3 + 2] = FU[nFu * 3 + 2];
          explodeBomber(fx, fy);
        } else i++;
      }
    }

    var api = {
      kind: 'js',
      reset: function (s) {
        Z.fill(0); B.fill(0); G.fill(0);
        nEv = 0; nFu = 0; insta = 0; pvInit = 0; seed = s >>> 0;
      },
      clearObstacles: function () { nObs = 0; },
      addObstacle: function (x, y, w, h) {
        if (nObs >= MAXO) return -1;
        O[nObs * 4] = x; O[nObs * 4 + 1] = y; O[nObs * 4 + 2] = w; O[nObs * 4 + 3] = h;
        return nObs++;
      },
      setBounds: function (a, b, c, d) { minX = a; minY = b; maxX = c; maxY = d; },
      setPlayer: function (x, y, r) { px = x; py = y; pr = r; },
      setInstaKill: function (v) { insta = v | 0; },
      getPX: function () { return px; },
      getPY: function () { return py; },
      movePlayer: function (dx, dy) {
        px += dx; py += dy;
        for (var it = 0; it < 3; it++) {
          qx = px; qy = py;
          for (var q = 0; q < nObs; q++) pushOutRect(pr, O[q * 4], O[q * 4 + 1], O[q * 4 + 2], O[q * 4 + 3]);
          px = qx; py = qy;
          if (px < minX + pr) px = minX + pr;
          if (px > maxX - pr) px = maxX - pr;
          if (py < minY + pr) py = minY + pr;
          if (py > maxY - pr) py = maxY - pr;
        }
      },
      spawnZombie: function (x, y, hp, speed, radius, type, dmg) {
        for (var i = 0; i < MAXZ; i++) {
          var o = i * ZS;
          if (Z[o] > 0.5) continue;
          var dx = px - x, dy = py - y;
          var d = sq(dx * dx + dy * dy);
          if (d < 1e-6) d = 1.0;
          Z[o] = 1; Z[o + 1] = x; Z[o + 2] = y; Z[o + 3] = hp; Z[o + 4] = hp; Z[o + 5] = speed; Z[o + 6] = radius;
          Z[o + 7] = dx / d; Z[o + 8] = dy / d; Z[o + 9] = 0; Z[o + 10] = 0.6; Z[o + 11] = type; Z[o + 12] = 0;
          Z[o + 13] = rnd() < 0.5 ? 1.0 : -1.0; Z[o + 14] = 0; Z[o + 15] = 0; Z[o + 16] = dmg;
          Z[o + 17] = 0; Z[o + 18] = 0; Z[o + 19] = 0; Z[o + 20] = 0; Z[o + 21] = 1.0;
          Z[o + 26] = 0; Z[o + 27] = 0; Z[o + 28] = 0; Z[o + 29] = 0;
          var r1 = rnd(), r2 = rnd(), ty = type | 0, rl = 0;
          if (aiLvl > 0) {
            if (ty === 2 || ty === 4 || ty === 5) rl = 2;
            else if (ty === 6) rl = 0;
            else if (ty === 3) rl = 1;
            else if (r1 < (aiLvl === 2 ? 0.45 : 0.25)) rl = 1;
          }
          Z[o + 22] = rl;
          Z[o + 23] = rl === 1 ? ((r2 * 9.0) | 0) - 4 : ((r2 * 24.0) | 0);
          Z[o + 24] = 0; Z[o + 25] = ty === 5 ? 2.0 : 0.0;
          return i;
        }
        return -1;
      },
      fireBullet: function (x, y, dx, dy, speed, dmg, life, pierce, knock) {
        return fireB(x, y, dx, dy, speed, dmg, life, pierce, knock);
      },
      launchHeavy: function (tipo, x, y, vx, vy, z, vz, tempo, dmg, raio) { return launchH(tipo, x, y, vx, vy, z, vz, tempo, dmg, raio); },
      setAI: function (n) { aiLvl = n | 0; insane = 0; if (aiLvl >= 3) { aiLvl = 2; insane = 1; } },
      setPlayerState: function (fx, fy, p) { pfx = fx; pfy = fy; aiPress = p; },
      update: function (dt) {
        if (dt > 0.05) dt = 0.05;
        if (insane) {
          if (!pvInit) { lpx = px; lpy = py; pvx = 0; pvy = 0; pvInit = 1; }
          else if (dt > 1e-6) { pvx += ((px - lpx) / dt - pvx) * 0.2; pvy += ((py - lpy) / dt - pvy) * 0.2; lpx = px; lpy = py; }
        }
        buildGrid();
        director();
        stepZombies(dt);
        buildGrid();
        stepBullets(dt);
        stepHeavy(dt);
        stepFuses(dt);
      },
      nearestVisible: function (x, y, range) {
        var best = -1, bd = range * range;
        for (var i = 0; i < MAXZ; i++) {
          var o = i * ZS;
          if (Z[o] < 0.5 || Z[o + 12] < 0.5) continue;
          var dx = Z[o + 1] - x, dy = Z[o + 2] - y;
          var d2 = dx * dx + dy * dy;
          if (d2 < bd) {
            if (!segBlocked(x, y, Z[o + 1], Z[o + 2])) { bd = d2; best = i; }
          }
        }
        return best;
      },
      explodeAt: function (x, y, r, dmg) { explode(x, y, r, dmg, 30.0); },
      damageZ: function (idx, dmg) {
        var i = idx | 0;
        if (i < 0 || i >= MAXZ) return 0;
        var o = i * ZS;
        if (Z[o] < 0.5) return 0;
        Z[o + 3] -= dmg;
        Z[o + 9] = 0.09;
        if (Z[o + 3] <= 0) {
          Z[o] = 0;
          var axd = deathAux(o);
          evx(2, Z[o + 1], Z[o + 2], 0, -1, Z[o + 11], i, 101.0, axd);
          deathEffects(o, axd);
          return 2;
        }
        return 1;
      },
      /* arranca membros (1 cabeça, 2 braço E, 4 braço D, 8 pernas): sem pernas vira rastejador (raio -30%, velocidade 40%, sem bote) */
      dismember: function (idx, mask) {
        var i = idx | 0;
        if (i < 0 || i >= MAXZ) return 0;
        var o = i * ZS;
        if (Z[o] < 0.5) return 0;
        var had = Z[o + 27] | 0, m = mask | 0, add = m & ~had;
        if (!add) return 0;
        Z[o + 27] = had | add;
        if ((add & 8) && Z[o + 26] < 0.5) {
          Z[o + 26] = 1.0; Z[o + 6] *= 0.7; Z[o + 5] *= 0.4;
          var tp = Z[o + 11] | 0;
          if (tp === 3 || tp === 4) { Z[o + 17] = 0; Z[o + 18] = 0; }
        }
        if (((had | add) & 6) === 6 && (had & 6) !== 6) Z[o + 16] *= 0.5;
        return 1;
      },
      slowZ: function (idx, dur) {
        var i = idx | 0;
        if (i < 0 || i >= MAXZ) return;
        var o = i * ZS;
        if (Z[o] < 0.5) return;
        if (dur > Z[o + 29]) Z[o + 29] = dur;
      },
      blastAt: function (x, y, r, dmg, kb) { areaDamage(x, y, r, dmg, kb); },
      layout: function (w) { return [MAXZ, ZS, MAXB, BS, MAXE, ES, MAXG, GS][w] || 0; },
      losBlocked: function (x1, y1, x2, y2) { return segBlocked(x1, y1, x2, y2); },
      aliveCount: function () {
        var n = 0;
        for (var i = 0; i < MAXZ; i++) if (Z[i * ZS] > 0.5) n++;
        return n;
      },
      eventCount: function () { return nEv; },
      clearEvents: function () { nEv = 0; },
      views: function () { return { Z: Z, B: B, E: E, G: G }; }
    };
    return api;
  }
  root.createSimJS = createSimJS;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createSimJS: createSimJS };
})(typeof window !== 'undefined' ? window : globalThis);
