/*
 * sim.c : núcleo de simulação do jogo "Inferno dos mortos".
 *
 * Compilado para WebAssembly com clang (wasm32, sem libc). Ele cuida do que pesa
 * no loop do jogo: IA dos zumbis (perseguição, separação, desvio de obstáculos),
 * física das balas (varredura em sub-passos) e colisões (grade espacial).
 *
 * O JavaScript só lê/escreve nos buffers de memória linear exportados (zPtr, bPtr, ePtr),
 * sem copiar nada. Existe uma versão equivalente em JS (sim-js.js) usada como fallback;
 * ambas rodam o mesmo algoritmo, na mesma ordem de operações.
 *
 * Sem trigonometria de propósito: o módulo trabalha só com vetores de direção.
 */

typedef double f64;
typedef int i32;
typedef unsigned int u32;

#define EXP(n) __attribute__((export_name(n)))

#define MAXZ 160
#define ZS 30
#define MAXB 160
#define BS 12
#define MAXG 32
#define GS 14
#define MAXE 256
#define ES 9
#define MAXF 16          /* pavios de bombeiros-cadáver pendentes */
#define MAXO 32
#define CELL 48.0
#define GW 64
#define GH 48

#define RISE 0.6          /* segundos que o zumbi leva para sair do chão */
#define BOOM_R 125.0      /* raio da explosão do infectado tóxico */
#define BOOM_DMG 150.0    /* dano da explosão nos outros zumbis (cai com a distância) */
#define BOMB_R 118.0      /* raio da explosão do Bomber */
#define BOMB_DMG 135.0    /* dano da explosão do Bomber nos outros zumbis */
#define BOMB_FUSE 1.5     /* pavio do Bomber (ao chegar perto ou ao morrer) */
#define BRUTE_R 96.0      /* raio do golpe em área do Brute */
#define COS_ST 0.62160997 /* cos(0.9 rad) */
#define SIN_ST 0.78332691 /* sin(0.9 rad) */

/*
 * Zumbi (ZS campos): 0 ativo, 1 x, 2 y, 3 vida, 4 vida máx, 5 velocidade, 6 raio,
 * 7 dirX, 8 dirY, 9 flash de dano, 10 recarga do ataque, 11 tipo, 12 idade,
 * 13 lado do desvio (+1/-1), 14 tempo de desvio, 15 animação de ataque, 16 dano,
 * 17 estado da habilidade (corredor: 0 normal, 1 preparo, 2 bote, 3 recuperação),
 * 18 tempo no estado, 19/20 direção do bote, 21 recarga da habilidade,
 * 22 papel, 23 fatia, 24 bônus do rugido, 25 habilidade,
 * 26 rastejador (1 = sem pernas), 27 máscara de membros perdidos (1 cabeça, 2 braço E, 4 braço D, 8 pernas),
 * 28 pavio do Bomber (s), 29 lentidão (s restantes; velocidade ×0,6)
 *
 * Tipos: 0 Walker (comum), 1 veloz, 2 Brute (lento, muita vida, golpe em ÁREA), 3 Runner (corredor: bote, ataques rápidos),
 *   4 tanque (blindado), 5 tóxico (explode), 6 Bomber (pavio de 1,5 s ao chegar perto ou ao morrer, depois explode)
 *
 * Bala (BS campos): 0 ativa, 1 x, 2 y, 3 vx, 4 vy, 5 dano, 6 vida, 7 perfurações, 8/9 últimos alvos, 10 knockback,
 *   11 etiqueta (o JS escreve: bits 0-15 índice da arma+1, 32 crítico, 64 ricochete armado; a simulação põe 128 depois do ricochete)
 *
 * Projétil pesado (GS campos): 0 ativo, 1 x, 2 y, 3 vx, 4 vy, 5 altura z, 6 vz, 7 tempo (vida/pavio),
 *   8 tipo (1 leitão explosivo, 2 granada de fragmentação), 9 dano da explosão, 10 raio, 11 quiques, 13 reservado
 *
 * Evento (ES campos): tipo, x, y, a, b, c, idx (zumbi, ou -1), tag (origem do dano: etiqueta da bala, 100 explosão, 101 fogo, 102 autodetonação), aux
 *   1 acerto  (a,b = direção da bala, c = dano)
 *   2 abate   (a,b = direção da bala, c = tipo do zumbi)
 *   3 dano ao jogador (a = dano, c = tipo do zumbi)
 *   4 bala na parede (a,b = direção)
 *   5 corredor se preparando para o bote (alerta sonoro)
 *   6 explosão tóxica (a = raio); o dano em área nos zumbis já foi aplicado aqui dentro
 *   7 explosão pesada (a = raio, c = 1 leitão / 2 granada); dano em área e estilhaços já aplicados
 *   8 quique da granada (obstáculo ou chão)
 *   15 explosão do Bomber (a = raio); 16 Bomber acendeu o pavio (a = tempo); 17 golpe em área do Brute (a = raio, c = dano)
 *   no abate (2) de um Bomber, aux = pavio restante: o cadáver explode depois desse tempo (evento 15)
 */
static f64 Z[MAXZ * ZS];
static f64 B[MAXB * BS];
static f64 G[MAXG * GS];
static f64 E[MAXE * ES];
static f64 FU[MAXF * 3];          /* pavios pendentes de Bombers mortos: x, y, tempo restante */
static i32 nFu = 0;
static f64 O[MAXO * 4];
static i32 gHead[GW * GH];
static i32 gNext[MAXZ];

static i32 nObs = 0;
static i32 nEv = 0;
static f64 px = 0, py = 0, pr = 14;
static f64 minX = 0, minY = 0, maxX = 2400, maxY = 1800;
static i32 insta = 0;
static u32 seed = 12345u;

static f64 rnd(void) {
  seed = seed * 1664525u + 1013904223u;
  return seed / 4294967296.0;
}

static f64 sq(f64 v) { return __builtin_sqrt(v); }

static void evx(f64 t, f64 x, f64 y, f64 a, f64 b, f64 c, f64 idx, f64 tag, f64 aux) {
  if (nEv >= MAXE) return;
  f64 *e = &E[nEv * ES];
  e[0] = t; e[1] = x; e[2] = y; e[3] = a; e[4] = b; e[5] = c; e[6] = idx; e[7] = tag; e[8] = aux;
  nEv++;
}
static void ev(f64 t, f64 x, f64 y, f64 a, f64 b, f64 c) { evx(t, x, y, a, b, c, -1.0, 0.0, 0.0); }

static i32 clampi(i32 v, i32 lo, i32 hi) { return v < lo ? lo : (v > hi ? hi : v); }

static i32 cellX(f64 x) { return clampi((i32)(x / CELL), 0, GW - 1); }
static i32 cellY(f64 y) { return clampi((i32)(y / CELL), 0, GH - 1); }

static void buildGrid(void) {
  for (i32 i = 0; i < GW * GH; i++) gHead[i] = -1;
  for (i32 i = 0; i < MAXZ; i++) {
    f64 *z = &Z[i * ZS];
    if (z[0] < 0.5) continue;
    i32 c = cellY(z[2]) * GW + cellX(z[1]);
    gNext[i] = gHead[c];
    gHead[c] = i;
  }
}

/* empurra um círculo para fora de um retângulo; devolve 1 se houve correção */
static i32 pushOutRect(f64 *x, f64 *y, f64 r, f64 ox, f64 oy, f64 w, f64 h) {
  f64 cx = *x < ox ? ox : (*x > ox + w ? ox + w : *x);
  f64 cy = *y < oy ? oy : (*y > oy + h ? oy + h : *y);
  f64 dx = *x - cx, dy = *y - cy;
  f64 d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return 0;
  if (d2 > 1e-9) {
    f64 d = sq(d2);
    f64 k = (r - d) / d;
    *x += dx * k;
    *y += dy * k;
    return 1;
  }
  f64 l = *x - ox, rr = ox + w - *x, t = *y - oy, b = oy + h - *y;
  f64 m = l;
  i32 ax = 0;
  if (rr < m) { m = rr; ax = 1; }
  if (t < m) { m = t; ax = 2; }
  if (b < m) { m = b; ax = 3; }
  if (ax == 0) *x = ox - r;
  else if (ax == 1) *x = ox + w + r;
  else if (ax == 2) *y = oy - r;
  else *y = oy + h + r;
  return 1;
}

/* segmento (x1,y1)-(x2,y2) cruza algum obstáculo? (método das "lajes") */
static i32 segBlocked(f64 x1, f64 y1, f64 x2, f64 y2) {
  f64 dx = x2 - x1, dy = y2 - y1;
  for (i32 k = 0; k < nObs; k++) {
    f64 ox = O[k * 4], oy = O[k * 4 + 1], w = O[k * 4 + 2], h = O[k * 4 + 3];
    f64 t0 = 0, t1 = 1;
    f64 adx = dx < 0 ? -dx : dx;
    if (adx < 1e-12) {
      if (x1 < ox || x1 > ox + w) continue;
    } else {
      f64 inv = 1.0 / dx;
      f64 ta = (ox - x1) * inv, tb = (ox + w - x1) * inv;
      if (ta > tb) { f64 s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    f64 ady = dy < 0 ? -dy : dy;
    if (ady < 1e-12) {
      if (y1 < oy || y1 > oy + h) continue;
    } else {
      f64 inv = 1.0 / dy;
      f64 ta = (oy - y1) * inv, tb = (oy + h - y1) * inv;
      if (ta > tb) { f64 s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    return 1;
  }
  return 0;
}

static void explode(f64 x, f64 y, f64 r, f64 dmg, f64 kb);
static void explodeBomber(f64 x, f64 y);

/* efeitos da morte: o tóxico explode na hora; o Bomber deixa um pavio (o que restava, ou 1,5 s) e explode depois */
static f64 deathAux(f64 *z) {
  if ((i32)z[11] != 6) return 0.0;
  return z[17] > 0.5 ? (z[28] > 0 ? z[28] : 0.0) : BOMB_FUSE;
}
static void deathEffects(f64 *z, f64 aux) {
  i32 tp = (i32)z[11];
  if (tp == 5) explode(z[1], z[2], BOOM_R, BOOM_DMG, 30.0);
  else if (tp == 6) {
    if (nFu < MAXF) { FU[nFu * 3] = z[1]; FU[nFu * 3 + 1] = z[2]; FU[nFu * 3 + 2] = aux; nFu++; }
    else explodeBomber(z[1], z[2]);
  }
}

/* dano em área nos zumbis (cai até 50% na borda). Zumbis tóxicos atingidos explodem em cadeia. */
static void areaDamage(f64 x, f64 y, f64 r, f64 dmg, f64 kb) {
  for (i32 i = 0; i < MAXZ; i++) {
    f64 *z = &Z[i * ZS];
    if (z[0] < 0.5) continue;
    f64 dx = z[1] - x, dy = z[2] - y;
    f64 d = sq(dx * dx + dy * dy);
    f64 alc = r + z[6];
    if (d >= alc) continue;
    f64 dm = dmg * (1.0 - 0.5 * (d / alc));
    f64 l = d < 1e-6 ? 1.0 : d;
    f64 ex = d < 1e-6 ? 0.0 : dx / l, ey = d < 1e-6 ? 1.0 : dy / l;
    if (insta) z[3] = 0; else z[3] -= dm;
    z[9] = 0.09;
    if (z[3] <= 0) {
      z[0] = 0;
      f64 ax = deathAux(z);
      evx(2, z[1], z[2], ex, ey, z[11], (f64)i, 100.0, ax);
      deathEffects(z, ax);
    } else {
      evx(1, z[1], z[2], ex, ey, dm, (f64)i, 100.0, 0.0);
      if (kb > 0) {                                   /* onda de choque: empurra para fora (o tanque resiste) */
        f64 kk = kb * (1.0 - d / alc);
        if ((i32)z[11] == 4) kk *= 0.2;
        z[1] += ex * kk; z[2] += ey * kk;
      }
    }
  }
}
static void explode(f64 x, f64 y, f64 r, f64 dmg, f64 kb) {
  ev(6, x, y, r, 0, 5);
  areaDamage(x, y, r, dmg, kb);
}
static void explodeBomber(f64 x, f64 y) {
  ev(15, x, y, BOMB_R, 0, 6);
  areaDamage(x, y, BOMB_R, BOMB_DMG, 60.0);
}

/* ---------- IA de horda ----------
 * aiLvl 0 fácil (ataques desordenados, reação lenta) | 1 médio (flanqueio simples, retaguarda) | 2 difícil (cerco, retaguarda tática)
 * Papéis (z[22]): 0 vanguarda (escudo), 1 flanqueador (vai ao ponto cego), 2 retaguarda (fortes e especiais seguram posição)
 * z[23] fatia do anel/flanco, z[24] tempo de bônus (rugido do tanque), z[25] habilidade: cooldown do cuspe tóxico / fúria do tanque */
static const f64 DC[24] = {1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905,0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583};
static const f64 DS[24] = {0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583,1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905};
static i32 aiLvl = 1, rearGo = 1, nVan = 0;
/* MODO INSANO (setAI(3)): comporta-se como IA difícil (aiLvl 2) + perseguição preditiva (mira onde o jogador estará), esquiva de comuns e autocura */
static i32 insane = 0, pvInit = 0;
static f64 pvx = 0, pvy = 0, lpx = 0, lpy = 0;     /* velocidade suavizada do jogador e posição anterior */
static f64 aiPress = 0, pfx = 1, pfy = 0;
static i32 launchH(f64 tipo, f64 x, f64 y, f64 vx, f64 vy, f64 z, f64 vz, f64 tempo, f64 dmg, f64 raio);

static void rot24(f64 x, f64 y, i32 k, f64 *ox, f64 *oy) {
  k = k % 24; if (k < 0) k += 24;
  f64 c = DC[k], sn = DS[k];
  *ox = x * c - y * sn; *oy = x * sn + y * c;
}
/* diretor: decide, uma vez por quadro, se a retaguarda é liberada */
static void director(void) {
  nVan = 0;
  for (i32 i = 0; i < MAXZ; i++) { f64 *z = &Z[i * ZS]; if (z[0] > 0.5 && (i32)z[22] != 2) nVan++; }
  if (aiLvl == 0) rearGo = 1;
  else if (aiLvl == 1) rearGo = (nVan <= 3 || aiPress > 0.6) ? 1 : 0;
  else rearGo = (nVan <= 2 || aiPress > 0.35) ? 1 : 0;
}

static void stepZombies(f64 dt) {
  for (i32 i = 0; i < MAXZ; i++) {
    f64 *z = &Z[i * ZS];
    if (z[0] < 0.5) continue;
    f64 r = z[6];
    z[12] += dt;
    if (z[9] > 0) z[9] -= dt;
    if (z[10] > 0) z[10] -= dt;
    if (z[15] > 0) z[15] -= dt;
    if (z[14] > 0) z[14] -= dt;
    if (z[29] > 0) z[29] -= dt;
    /* insano: zumbi comum ferido pode se curar sozinho durante o combate (~0,45 chance/s, +10% da vida máxima) */
    if (insane && (i32)z[11] == 0 && z[12] >= RISE && z[3] < z[4] * 0.75 && rnd() < 0.45 * dt) {
      z[3] += z[4] * 0.1; if (z[3] > z[4]) z[3] = z[4];
      ev(12, z[1], z[2], 0, 0, 0);
    }

    f64 dx = px - z[1], dy = py - z[2];
    f64 d = sq(dx * dx + dy * dy);
    if (d < 1e-6) d = 1e-6;
    f64 ux = dx / d, uy = dy / d;
    i32 role = (i32)z[22];
    f64 holdD = 0;
    if (aiLvl > 0 && z[12] >= RISE) {
      f64 Rr = aiLvl == 2 ? 150.0 : 190.0, ox, oy, ex, ey, e;
      f64 tx = px, ty = py;
      i32 alt = 0;
      if (role == 1 && d > 140.0) {                          /* flanqueador: contorna até o ponto cego (atrás do jogador) */
        rot24(-pfx, -pfy, (i32)z[23], &ox, &oy);
        tx = px + ox * Rr; ty = py + oy * Rr; alt = 1;
      } else if (role == 0 && aiLvl == 2 && d > 260.0) {      /* cerco: a vanguarda se espalha em anel */
        rot24(pfx, pfy, (i32)z[23], &ox, &oy);
        tx = px + ox * Rr * 1.4; ty = py + oy * Rr * 1.4; alt = 1;
      }
      if (alt) {
        ex = tx - z[1]; ey = ty - z[2];
        e = sq(ex * ex + ey * ey);
        if (e > 50.0) { ux = ex / e; uy = ey / e; }
      } else if (insane && d > 90.0) {                      /* perseguição preditiva: intercepta a posição futura do jogador */
        f64 lead = d / (z[5] + 60.0);
        if (lead > 0.8) lead = 0.8;
        tx = px + pvx * lead; ty = py + pvy * lead;
        ex = tx - z[1]; ey = ty - z[2];
        e = sq(ex * ex + ey * ey);
        if (e > 30.0) { ux = ex / e; uy = ey / e; }
      }
      if (role == 2 && !rearGo && z[12] < 25.0) holdD = aiLvl == 2 ? 330.0 : 260.0;
    }
    /* flocking: separação suave entre vizinhos (evita empilhar num ponto) + abertura em leque da vanguarda (flanqueio) */
    if (aiLvl > 0 && z[12] >= RISE && (i32)z[17] == 0 && (i32)z[11] != 4) {
      f64 sepx = 0, sepy = 0;
      i32 scx = cellX(z[1]), scy = cellY(z[2]);
      for (i32 gy = scy - 1; gy <= scy + 1; gy++) {
        if (gy < 0 || gy >= GH) continue;
        for (i32 gx = scx - 1; gx <= scx + 1; gx++) {
          if (gx < 0 || gx >= GW) continue;
          for (i32 j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
            if (j == i) continue;
            f64 *o = &Z[j * ZS];
            if (o[0] < 0.5) continue;
            f64 qx = z[1] - o[1], qy = z[2] - o[2];
            f64 cm = r + o[6] + 18.0;
            f64 q2 = qx * qx + qy * qy;
            if (q2 < cm * cm && q2 > 1e-6) { f64 qd = sq(q2); f64 w = (cm - qd) / cm; sepx += qx / qd * w; sepy += qy / qd * w; }
          }
        }
      }
      f64 mx2 = ux + sepx * 1.1, my2 = uy + sepy * 1.1;
      if (role == 0 && d > 200.0) {
        f64 lat = ((f64)(((i32)z[23] % 5 + 5) % 5) - 2.0) * 0.12;
        mx2 += -uy * lat; my2 += ux * lat;
      }
      f64 ml = sq(mx2 * mx2 + my2 * my2);
      if (ml > 1e-6) { ux = mx2 / ml; uy = my2 / ml; }
    }
    if (z[14] > 0) {
      f64 s = z[13] * SIN_ST;
      f64 nx = ux * COS_ST - uy * s;
      f64 ny = ux * s + uy * COS_ST;
      ux = nx; uy = ny;
    }
    f64 k = (aiLvl == 0 ? 4.0 : (insane ? 16.0 : 10.0)) * dt;
    if (k > 1) k = 1;
    f64 hx = z[7] + (ux - z[7]) * k;
    f64 hy = z[8] + (uy - z[8]) * k;
    f64 hl = sq(hx * hx + hy * hy);
    if (hl < 1e-6) { hx = ux; hy = uy; hl = 1.0; }
    hx /= hl; hy /= hl;
    z[7] = hx; z[8] = hy;

    /* habilidades dos especiais */
    i32 tp = (i32)z[11];
    f64 spd = z[5];
    i32 canMove = 1;
    if (z[24] > 0) { z[24] -= dt; spd *= 1.3; }              /* bônus do rugido do tanque */
    if (z[29] > 0) spd *= 0.6;                               /* tiros congelantes: -40% de velocidade */
    if (tp == 4 && z[3] < z[4]) {                            /* tanque em fúria assim que sofre o primeiro dano */
      if (z[25] < 0.5) {
        z[25] = 1.0; z[21] = 0.5;
        ev(10, z[1], z[2], 320.0, 0, 0);
        for (i32 q = 0; q < MAXZ; q++) {
          f64 *o = &Z[q * ZS];
          if (q == i || o[0] < 0.5) continue;
          f64 bx = o[1] - z[1], by = o[2] - z[2];
          if (bx * bx + by * by < 320.0 * 320.0) o[24] = 6.0;
        }
      }
      spd *= 1.7;
    }
    if (tp == 5) {                                           /* tóxico: cuspe de ácido à distância quando o jogador está pressionado */
      if (z[25] > 0) z[25] -= dt;
      if (aiLvl > 0 && z[12] >= RISE && z[25] <= 0 && d > 200.0 && d < 430.0 && (rearGo || role != 2) && (aiPress > 0.3 || aiLvl == 2) && !segBlocked(z[1], z[2], px, py)) {
        z[25] = aiLvl == 2 ? 4.5 : 8.0;
        i32 gi = launchH(3.0, z[1], z[2], dx / 0.9, dy / 0.9, 0, 0, 0.9, 0, 95.0);
        if (gi >= 0) G[gi * GS + 12] = 0.9;
      }
    }
    i32 hunter = z[26] < 0.5 && ((tp == 3) || (tp == 4 && z[25] > 0.5));      /* sem pernas (rastejador) não dá o bote */
    if (hunter) {                                            /* corredor (e tanque furioso): preparo -> investida -> recuperação */
      if (z[21] > 0) z[21] -= dt;
      i32 st = (i32)z[17];
      f64 wind = tp == 4 ? 0.5 : (aiLvl == 0 ? 0.7 : (aiLvl == 1 ? 0.4 : 0.28));
      f64 lsp = tp == 4 ? 430.0 : 560.0, lt = tp == 4 ? 0.6 : 0.5, rec = tp == 4 ? 1.0 : 0.7;
      f64 cdv = tp == 4 ? 3.5 : (aiLvl == 2 ? (aiPress > 0.5 ? 1.6 : 2.4) : (aiLvl == 1 ? 3.0 : 4.0));
      f64 rmin = tp == 4 ? 120.0 : 90.0, rmax = tp == 4 ? 380.0 : ((aiLvl >= 1 && aiPress > 0.5) ? 420.0 : 320.0);
      if (st == 0) {
        if (z[12] >= RISE && z[21] <= 0 && d < rmax && d > rmin) {
          z[17] = 1; z[18] = wind; canMove = 0;
          ev(5, z[1], z[2], 0, 0, z[11]);
        }
      } else if (st == 1) {
        canMove = 0;
        z[18] -= dt;
        if (z[18] <= 0) { z[17] = 2; z[18] = lt; z[19] = dx / d; z[20] = dy / d; }
      } else if (st == 2) {
        z[18] -= dt;
        spd = lsp; hx = z[19]; hy = z[20]; z[7] = hx; z[8] = hy;
        if (z[18] <= 0) { z[17] = 3; z[18] = rec; z[21] = cdv; }
      } else {
        canMove = 0;
        z[18] -= dt;
        if (z[18] <= 0) z[17] = 0;
      }
    }

    f64 reach = r + pr + 4.0;
    f64 x = z[1], y = z[2];
    if (z[12] >= RISE && d > reach && canMove && !(holdD > 0 && d <= holdD)) {
      f64 mv = spd * dt;
      f64 room = d - reach;
      if (mv > room) mv = room;
      x += hx * mv;
      y += hy * mv;
    }

    /* separação entre zumbis (3x3 células da grade) */
    i32 cx = cellX(x), cy = cellY(y);
    for (i32 gy = cy - 1; gy <= cy + 1; gy++) {
      if (gy < 0 || gy >= GH) continue;
      for (i32 gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gx >= GW) continue;
        for (i32 j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
          if (j == i) continue;
          f64 *o = &Z[j * ZS];
          if (o[0] < 0.5) continue;
          f64 sx = x - o[1], sy = y - o[2];
          f64 rr = r + o[6];
          f64 s2 = sx * sx + sy * sy;
          if (s2 < rr * rr) {
            if (s2 < 1e-6) {
              x += (i < j) ? 0.5 : -0.5;
            } else {
              f64 sd = sq(s2);
              f64 ov = (rr - sd) / sd * 0.3;
              x += sx * ov;
              y += sy * ov;
            }
          }
        }
      }
    }

    /* obstáculos */
    i32 hit = 0;
    f64 hcx = 0, hcy = 0;
    for (i32 q = 0; q < nObs; q++) {
      f64 ox = O[q * 4], oy = O[q * 4 + 1], w = O[q * 4 + 2], h = O[q * 4 + 3];
      if (pushOutRect(&x, &y, r, ox, oy, w, h)) {
        if (!hit) { hcx = ox + w * 0.5; hcy = oy + h * 0.5; }
        hit = 1;
      }
    }
    if (hit && z[14] <= 0) {
      f64 ax = hcx - z[1], ay = hcy - z[2];
      f64 cr = ax * dy - ay * dx;
      z[13] = cr > 0 ? 1.0 : -1.0;
      z[14] = 0.5;
    }

    /* limites do mapa */
    if (x < minX + r) x = minX + r;
    if (x > maxX - r) x = maxX - r;
    if (y < minY + r) y = minY + r;
    if (y > maxY - r) y = maxY - r;

    /* não entra no jogador */
    f64 ddx = px - x, ddy = py - y;
    f64 dd2 = ddx * ddx + ddy * ddy;
    f64 minD = r + pr;
    if (dd2 < minD * minD) {
      f64 dd = sq(dd2);
      if (dd < 1e-6) {
        x -= minD;
      } else {
        f64 push = (minD - dd) / dd;
        x -= ddx * push;
        y -= ddy * push;
      }
    }
    z[1] = x; z[2] = y;

    /* ataque */
    ddx = px - x; ddy = py - y;
    f64 dd = sq(ddx * ddx + ddy * ddy);
    if (tp == 5) {                                          /* tóxico: detona ao encostar */
      if (z[12] >= RISE && dd <= reach + 4.0) {
        z[0] = 0;
        explode(x, y, BOOM_R, BOOM_DMG, 30.0);
      }
    } else if (tp == 6) {                                   /* Bomber: ao chegar perto acende o pavio (1,5 s) e explode no fim */
      if (z[12] >= RISE) {
        if ((i32)z[17] == 0) {
          if (dd <= reach + 38.0) { z[17] = 1; z[28] = BOMB_FUSE; evx(16, x, y, BOMB_FUSE, 0, 6, (f64)i, 0.0, 0.0); }
        } else {
          z[28] -= dt;
          if (z[28] <= 0) { z[0] = 0; evx(2, x, y, 0, 0, 6, (f64)i, 102.0, 0.0); explodeBomber(x, y); }
        }
      }
    } else if (z[12] >= RISE && dd <= reach + 2.0 + (tp == 2 ? 24.0 : 0.0) && z[10] <= 0) {
      z[10] = tp == 4 ? (z[25] > 0.5 ? 0.85 : 1.6) : (tp == 3 ? 0.6 : (tp == 2 ? 1.5 : 1.0));   /* furioso ataca quase 2x mais rápido; Runner ataca rápido */
      z[15] = 0.35;
      f64 dm = z[16];
      if ((tp == 3 || tp == 4) && (i32)z[17] == 2) { dm *= tp == 4 ? 1.4 : 1.6; z[17] = 3; z[18] = tp == 4 ? 1.0 : 0.7; z[21] = tp == 4 ? 3.5 : 3.0; }
      if (tp == 2) evx(17, x, y, BRUTE_R, 0, dm, (f64)i, 0.0, 0.0);       /* Brute: golpe em ÁREA (o JS aplica o dano a quem estiver no raio) */
      else ev(3, x, y, dm, 0, z[11]);
    }
  }
}

static void stepBullets(f64 dt) {
  for (i32 i = 0; i < MAXB; i++) {
    f64 *b = &B[i * BS];
    if (b[0] < 0.5) continue;
    f64 sp = sq(b[3] * b[3] + b[4] * b[4]);
    f64 dirx = b[3] / sp, diry = b[4] / sp;
    i32 n = (i32)(sp * dt / 12.0) + 1;
    f64 sdt = dt / n;
    for (i32 s = 0; s < n; s++) {
      b[1] += b[3] * sdt;
      b[2] += b[4] * sdt;
      b[6] -= sdt;
      f64 x = b[1], y = b[2];
      if (x < minX || x > maxX || y < minY || y > maxY) {
        f64 cxp = x < minX ? minX : (x > maxX ? maxX : x), cyp = y < minY ? minY : (y > maxY ? maxY : y);
        i32 tg0 = (i32)b[11];
        if ((tg0 & 64) && !(tg0 & 128)) {                  /* ricochete na primeira parede (borda do mapa) */
          if (x < minX || x > maxX) b[3] = -b[3];
          if (y < minY || y > maxY) b[4] = -b[4];
          b[1] = cxp; b[2] = cyp; b[11] = (f64)(tg0 | 128);
          dirx = b[3] / sp; diry = b[4] / sp;
          ev(4, cxp, cyp, dirx, diry, 0);
          continue;
        }
        b[0] = 0;
        ev(4, cxp, cyp, dirx, diry, 0);
        break;
      }
      i32 wall = 0, wq = 0;
      for (i32 q = 0; q < nObs; q++) {
        f64 ox = O[q * 4], oy = O[q * 4 + 1];
        if (x >= ox && x <= ox + O[q * 4 + 2] && y >= oy && y <= oy + O[q * 4 + 3]) { wall = 1; wq = q; break; }
      }
      if (wall) {
        i32 tg1 = (i32)b[11];
        if ((tg1 & 64) && !(tg1 & 128)) {                  /* ricochete na primeira parede (obstáculo): reflete pelo lado de entrada */
          f64 qx0 = x - b[3] * sdt, qy0 = y - b[4] * sdt;
          f64 wx = O[wq * 4], wy = O[wq * 4 + 1], ww = O[wq * 4 + 2], wh = O[wq * 4 + 3];
          if (qx0 < wx || qx0 > wx + ww) b[3] = -b[3];
          else if (qy0 < wy || qy0 > wy + wh) b[4] = -b[4];
          else { b[3] = -b[3]; b[4] = -b[4]; }
          b[1] = qx0; b[2] = qy0; b[11] = (f64)(tg1 | 128);
          dirx = b[3] / sp; diry = b[4] / sp;
          ev(4, qx0, qy0, dirx, diry, 0);
          continue;
        }
        b[0] = 0;
        ev(4, x, y, dirx, diry, 0);
        break;
      }
      i32 cx = cellX(x), cy = cellY(y);
      i32 done = 0;
      for (i32 gy = cy - 1; gy <= cy + 1 && !done; gy++) {
        if (gy < 0 || gy >= GH) continue;
        for (i32 gx = cx - 1; gx <= cx + 1 && !done; gx++) {
          if (gx < 0 || gx >= GW) continue;
          for (i32 j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
            f64 *z = &Z[j * ZS];
            if (z[0] < 0.5) continue;
            if (b[8] == j + 1 || b[9] == j + 1) continue;
            f64 ex = x - z[1], ey = y - z[2];
            f64 rr = z[6] + 3.0;
            if (ex * ex + ey * ey < rr * rr) {
              if (insane && (i32)z[11] == 0 && rnd() < 0.2) {   /* insano: comum esquiva o tiro (a bala atravessa sem dano) e desvia de lado um instante */
                z[14] = 0.35;
                ev(11, z[1], z[2], dirx, diry, 0);
                b[9] = b[8]; b[8] = j + 1;
                continue;
              }
              f64 dmg = b[5];
              f64 tagb = (f64)((i32)b[11]);
              evx(14, x, y, dirx, diry, (f64)j, (f64)j, tagb, 0.0);   /* acerto de BALA (com índice do zumbi): gatilho de balas explosivas/incendiárias */
              if (insta) z[3] = 0; else z[3] -= dmg;
              z[9] = 0.09;
              f64 kn = b[10];
              if ((i32)z[11] == 4) kn *= 0.15;            /* o tanque quase não se move com tiros */
              z[1] += dirx * kn;
              z[2] += diry * kn;
              if (z[3] <= 0) {
                z[0] = 0;
                f64 ax = deathAux(z);
                evx(2, z[1], z[2], dirx, diry, z[11], (f64)j, tagb, ax);
                deathEffects(z, ax);
              } else {
                evx(1, x, y, dirx, diry, dmg, (f64)j, tagb, 0.0);
              }
              if (b[7] > 0) {
                b[7] -= 1;
                b[9] = b[8];
                b[8] = j + 1;
              } else {
                b[0] = 0;
                done = 1;
                break;
              }
            }
          }
        }
      }
      if (done) break;
      if (b[6] <= 0) { b[0] = 0; break; }
    }
  }
}

EXP("reset") void reset(f64 s) {
  for (i32 i = 0; i < MAXZ * ZS; i++) Z[i] = 0;
  for (i32 i = 0; i < MAXB * BS; i++) B[i] = 0;
  for (i32 i = 0; i < MAXG * GS; i++) G[i] = 0;
  nEv = 0;
  nFu = 0;
  insta = 0;
  pvInit = 0;
  seed = (u32)s;
}
EXP("clearObstacles") void clearObstacles(void) { nObs = 0; }
EXP("addObstacle") i32 addObstacle(f64 x, f64 y, f64 w, f64 h) {
  if (nObs >= MAXO) return -1;
  O[nObs * 4] = x; O[nObs * 4 + 1] = y; O[nObs * 4 + 2] = w; O[nObs * 4 + 3] = h;
  return nObs++;
}
EXP("setBounds") void setBounds(f64 a, f64 b, f64 c, f64 d) { minX = a; minY = b; maxX = c; maxY = d; }
EXP("setPlayer") void setPlayer(f64 x, f64 y, f64 r) { px = x; py = y; pr = r; }
EXP("setInstaKill") void setInstaKill(i32 v) { insta = v; }
EXP("getPX") f64 getPX(void) { return px; }
EXP("getPY") f64 getPY(void) { return py; }

EXP("movePlayer") void movePlayer(f64 dx, f64 dy) {
  px += dx; py += dy;
  for (i32 it = 0; it < 3; it++) {
    for (i32 q = 0; q < nObs; q++)
      pushOutRect(&px, &py, pr, O[q * 4], O[q * 4 + 1], O[q * 4 + 2], O[q * 4 + 3]);
    if (px < minX + pr) px = minX + pr;
    if (px > maxX - pr) px = maxX - pr;
    if (py < minY + pr) py = minY + pr;
    if (py > maxY - pr) py = maxY - pr;
  }
}

EXP("spawnZombie") i32 spawnZombie(f64 x, f64 y, f64 hp, f64 speed, f64 radius, f64 type, f64 dmg) {
  for (i32 i = 0; i < MAXZ; i++) {
    f64 *z = &Z[i * ZS];
    if (z[0] > 0.5) continue;
    f64 dx = px - x, dy = py - y;
    f64 d = sq(dx * dx + dy * dy);
    if (d < 1e-6) d = 1.0;
    z[0] = 1; z[1] = x; z[2] = y; z[3] = hp; z[4] = hp; z[5] = speed; z[6] = radius;
    z[7] = dx / d; z[8] = dy / d; z[9] = 0; z[10] = 0.6; z[11] = type; z[12] = 0;
    z[13] = rnd() < 0.5 ? 1.0 : -1.0; z[14] = 0; z[15] = 0; z[16] = dmg;
    z[17] = 0; z[18] = 0; z[19] = 0; z[20] = 0; z[21] = 1.0;
    z[26] = 0; z[27] = 0; z[28] = 0; z[29] = 0;
    {                                                       /* papel na horda (sempre consome 2 sorteios, para manter a sequência idêntica) */
      f64 r1 = rnd(), r2 = rnd();
      i32 ty = (i32)type, role = 0;
      if (aiLvl > 0) {
        if (ty == 2 || ty == 4 || ty == 5) role = 2;
        else if (ty == 6) role = 0;
        else if (ty == 3) role = 1;
        else if (r1 < (aiLvl == 2 ? 0.45 : 0.25)) role = 1;
      }
      z[22] = role;
      z[23] = role == 1 ? (f64)((i32)(r2 * 9.0) - 4) : (f64)(i32)(r2 * 24.0);
      z[24] = 0; z[25] = ty == 5 ? 2.0 : 0.0;
    }
    return i;
  }
  return -1;
}

static i32 fireB(f64 x, f64 y, f64 dx, f64 dy, f64 speed, f64 dmg, f64 life, f64 pierce, f64 knock) {
  for (i32 i = 0; i < MAXB; i++) {
    f64 *b = &B[i * BS];
    if (b[0] > 0.5) continue;
    b[0] = 1; b[1] = x; b[2] = y; b[3] = dx * speed; b[4] = dy * speed;
    b[5] = dmg; b[6] = life; b[7] = pierce; b[8] = 0; b[9] = 0; b[10] = knock; b[11] = 0;
    return i;
  }
  return -1;
}
EXP("fireBullet") i32 fireBullet(f64 x, f64 y, f64 dx, f64 dy, f64 speed, f64 dmg, f64 life, f64 pierce, f64 knock) {
  return fireB(x, y, dx, dy, speed, dmg, life, pierce, knock);
}

/* 24 direções (a cada 15 graus) para os estilhaços: o módulo não usa trigonometria */
static const f64 SH_C[24] = {1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905,0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583};
static const f64 SH_S[24] = {0.0,0.25881905,0.5,0.70710678,0.8660254,0.96592583,1.0,0.96592583,0.8660254,0.70710678,0.5,0.25881905,0.0,-0.25881905,-0.5,-0.70710678,-0.8660254,-0.96592583,-1.0,-0.96592583,-0.8660254,-0.70710678,-0.5,-0.25881905};

/* explosão pesada: dano em área com onda de choque; a granada ainda solta 24 estilhaços em 360 graus */
static void explodeHeavy(f64 x, f64 y, f64 r, f64 dmg, i32 tipo) {
  ev(7, x, y, r, 0, (f64)tipo);
  areaDamage(x, y, r, dmg, tipo == 1 ? 110.0 : 70.0);
  if (tipo == 2) {
    for (i32 k = 0; k < 24; k++) {
      f64 life = 0.2 + rnd() * 0.18;
      fireB(x + SH_C[k] * 6.0, y + SH_S[k] * 6.0, SH_C[k], SH_S[k], 950.0, 38.0, life, 1.0, 8.0);
    }
  }
}

static void stepHeavy(f64 dt) {
  for (i32 i = 0; i < MAXG; i++) {
    f64 *g = &G[i * GS];
    if (g[0] < 0.5) continue;
    i32 tp = (i32)g[8];
    if (tp == 1) {                                          /* leitão: voo reto até bater em algo */
      f64 sp = sq(g[3] * g[3] + g[4] * g[4]);
      i32 n = (i32)(sp * dt / 12.0) + 1;
      f64 sdt = dt / n;
      for (i32 s = 0; s < n; s++) {
        g[1] += g[3] * sdt; g[2] += g[4] * sdt; g[7] -= sdt;
        f64 x = g[1], y = g[2];
        i32 boom = 0;
        if (x < minX || x > maxX || y < minY || y > maxY) boom = 1;
        for (i32 q = 0; q < nObs && !boom; q++) {
          f64 ox = O[q * 4], oy = O[q * 4 + 1];
          if (x >= ox && x <= ox + O[q * 4 + 2] && y >= oy && y <= oy + O[q * 4 + 3]) boom = 1;
        }
        if (!boom) {
          i32 cx = cellX(x), cy = cellY(y);
          for (i32 gy = cy - 1; gy <= cy + 1 && !boom; gy++) {
            if (gy < 0 || gy >= GH) continue;
            for (i32 gx = cx - 1; gx <= cx + 1 && !boom; gx++) {
              if (gx < 0 || gx >= GW) continue;
              for (i32 j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
                f64 *z = &Z[j * ZS];
                if (z[0] < 0.5) continue;
                f64 ex = x - z[1], ey = y - z[2];
                f64 rr = z[6] + 8.0;
                if (ex * ex + ey * ey < rr * rr) { boom = 1; break; }
              }
            }
          }
        }
        if (g[7] <= 0) boom = 1;
        if (boom) {
          g[0] = 0;
          f64 bx = g[1] < minX ? minX : (g[1] > maxX ? maxX : g[1]);
          f64 by = g[2] < minY ? minY : (g[2] > maxY ? maxY : g[2]);
          explodeHeavy(bx, by, g[10], g[9], 1);
          break;
        }
      }
    } else if (tp == 3 || tp == 4) {                        /* cuspe ácido (3) e molotov (4): arco simples até o ponto marcado */
      g[7] -= dt;
      g[1] += g[3] * dt; g[2] += g[4] * dt;
      f64 u = 1.0 - g[7] / g[12];
      g[5] = 240.0 * u * (1.0 - u);
      if (g[7] <= 0) {
        g[0] = 0;
        f64 bx = g[1] < minX ? minX : (g[1] > maxX ? maxX : g[1]);
        f64 by = g[2] < minY ? minY : (g[2] > maxY ? maxY : g[2]);
        ev(tp == 3 ? 9 : 13, bx, by, g[10], 0, 0);
      }
    } else {                                                /* granada: arco com gravidade, quique e pavio */
      g[7] -= dt;
      g[6] -= 1400.0 * dt;
      g[5] += g[6] * dt;
      g[1] += g[3] * dt; g[2] += g[4] * dt;
      if (g[5] <= 0) {
        g[5] = 0;
        if (g[6] < -120.0) {
          g[6] = -g[6] * 0.42; g[3] *= 0.72; g[4] *= 0.72; g[11] += 1;
          ev(8, g[1], g[2], 0, 0, 0);
        } else g[6] = 0;
        f64 fr = 1.0 - 5.0 * dt;
        if (fr < 0) fr = 0;
        g[3] *= fr; g[4] *= fr;
      }
      f64 qx2 = g[1], qy2 = g[2];
      for (i32 q = 0; q < nObs; q++) {
        if (pushOutRect(&qx2, &qy2, 5.0, O[q * 4], O[q * 4 + 1], O[q * 4 + 2], O[q * 4 + 3])) {
          f64 nx = qx2 - g[1], ny = qy2 - g[2];
          f64 nl = sq(nx * nx + ny * ny);
          if (nl > 1e-9) {
            nx /= nl; ny /= nl;
            f64 dp = g[3] * nx + g[4] * ny;
            if (dp < 0) { g[3] -= 1.5 * dp * nx; g[4] -= 1.5 * dp * ny; }
          }
          g[1] = qx2; g[2] = qy2;
          ev(8, g[1], g[2], 0, 0, 0);
        }
      }
      if (g[1] < minX + 5.0) { g[1] = minX + 5.0; if (g[3] < 0) g[3] = -g[3] * 0.5; }
      if (g[1] > maxX - 5.0) { g[1] = maxX - 5.0; if (g[3] > 0) g[3] = -g[3] * 0.5; }
      if (g[2] < minY + 5.0) { g[2] = minY + 5.0; if (g[4] < 0) g[4] = -g[4] * 0.5; }
      if (g[2] > maxY - 5.0) { g[2] = maxY - 5.0; if (g[4] > 0) g[4] = -g[4] * 0.5; }
      i32 contato = 0;
      if (g[5] < 28.0) {                                    /* baixa o bastante para acertar alguém: explode por impacto */
        i32 cx = cellX(g[1]), cy = cellY(g[2]);
        for (i32 gy = cy - 1; gy <= cy + 1 && !contato; gy++) {
          if (gy < 0 || gy >= GH) continue;
          for (i32 gx = cx - 1; gx <= cx + 1 && !contato; gx++) {
            if (gx < 0 || gx >= GW) continue;
            for (i32 j = gHead[gy * GW + gx]; j >= 0; j = gNext[j]) {
              f64 *z = &Z[j * ZS];
              if (z[0] < 0.5) continue;
              f64 ex = g[1] - z[1], ey = g[2] - z[2];
              f64 rr = z[6] + 6.0;
              if (ex * ex + ey * ey < rr * rr) { contato = 1; break; }
            }
          }
        }
      }
      if (g[7] <= 0 || contato) {
        g[0] = 0;
        explodeHeavy(g[1], g[2], g[10], g[9], 2);
      }
    }
  }
}

static i32 launchH(f64 tipo, f64 x, f64 y, f64 vx, f64 vy, f64 z, f64 vz, f64 tempo, f64 dmg, f64 raio) {
  for (i32 i = 0; i < MAXG; i++) {
    f64 *g = &G[i * GS];
    if (g[0] > 0.5) continue;
    g[0] = 1; g[1] = x; g[2] = y; g[3] = vx; g[4] = vy; g[5] = z; g[6] = vz; g[7] = tempo;
    g[8] = tipo; g[9] = dmg; g[10] = raio; g[11] = 0; g[12] = tipo == 4.0 ? tempo : 0; g[13] = 0;
    return i;
  }
  return -1;
}
EXP("launchHeavy") i32 launchHeavy(f64 tipo, f64 x, f64 y, f64 vx, f64 vy, f64 z, f64 vz, f64 tempo, f64 dmg, f64 raio) {
  return launchH(tipo, x, y, vx, vy, z, vz, tempo, dmg, raio);
}
EXP("setAI") void setAI(f64 nivel) { aiLvl = (i32)nivel; insane = 0; if (aiLvl >= 3) { aiLvl = 2; insane = 1; } }
EXP("setPlayerState") void setPlayerState(f64 fx, f64 fy, f64 pressao) { pfx = fx; pfy = fy; aiPress = pressao; }

/* pavios de Bombers mortos: explodem quando o tempo acaba (a explosão pode abater outros Bombers e encadear) */
static void stepFuses(f64 dt) {
  for (i32 i = 0; i < nFu;) {
    FU[i * 3 + 2] -= dt;
    if (FU[i * 3 + 2] <= 0) {
      f64 x = FU[i * 3], y = FU[i * 3 + 1];
      nFu--;
      FU[i * 3] = FU[nFu * 3]; FU[i * 3 + 1] = FU[nFu * 3 + 1]; FU[i * 3 + 2] = FU[nFu * 3 + 2];
      explodeBomber(x, y);
    } else i++;
  }
}

EXP("update") void update(f64 dt) {
  if (dt > 0.05) dt = 0.05;
  if (insane) {                                  /* velocidade suavizada do jogador para a perseguição preditiva */
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
}

/* zumbi visível mais próximo (sem parede no caminho); -1 se não houver */
EXP("nearestVisible") i32 nearestVisible(f64 x, f64 y, f64 range) {
  i32 best = -1;
  f64 bd = range * range;
  for (i32 i = 0; i < MAXZ; i++) {
    f64 *z = &Z[i * ZS];
    if (z[0] < 0.5 || z[12] < 0.5) continue;
    f64 dx = z[1] - x, dy = z[2] - y;
    f64 d2 = dx * dx + dy * dy;
    if (d2 < bd) {
      if (!segBlocked(x, y, z[1], z[2])) { bd = d2; best = i; }
    }
  }
  return best;
}
/* dano direto em um zumbi (fogo/DoT): sem evento de acerto, só o abate (evento 2) se morrer. Devolve 0 inexistente, 1 vivo, 2 morto */
EXP("damageZ") i32 damageZ(f64 idx, f64 dmg) {
  i32 i = (i32)idx;
  if (i < 0 || i >= MAXZ) return 0;
  f64 *z = &Z[i * ZS];
  if (z[0] < 0.5) return 0;
  z[3] -= dmg;
  z[9] = 0.09;
  if (z[3] <= 0) {
    z[0] = 0;
    f64 ax = deathAux(z);
    evx(2, z[1], z[2], 0, -1, z[11], (f64)i, 101.0, ax);
    deathEffects(z, ax);
    return 2;
  }
  return 1;
}
/* arranca membros (máscara: 1 cabeça, 2 braço esquerdo, 4 braço direito, 8 pernas). Sem pernas vira rastejador: raio 30% menor
   (colisão/acertos), velocidade 40% e sem bote. Sem os dois braços o dano corpo a corpo cai pela metade. Devolve 1 se algo mudou. */
EXP("dismember") i32 dismember(f64 idx, f64 mask) {
  i32 i = (i32)idx;
  if (i < 0 || i >= MAXZ) return 0;
  f64 *z = &Z[i * ZS];
  if (z[0] < 0.5) return 0;
  i32 had = (i32)z[27], m = (i32)mask, add = m & ~had;
  if (!add) return 0;
  z[27] = (f64)(had | add);
  if ((add & 8) && z[26] < 0.5) {
    z[26] = 1.0; z[6] *= 0.7; z[5] *= 0.4;
    i32 tp = (i32)z[11];
    if (tp == 3 || tp == 4) { z[17] = 0; z[18] = 0; }
  }
  if (((had | add) & 6) == 6 && (had & 6) != 6) z[16] *= 0.5;
  return 1;
}
/* tiros congelantes: o zumbi fica 40% mais lento durante dur segundos */
EXP("slowZ") void slowZ(f64 idx, f64 dur) {
  i32 i = (i32)idx;
  if (i < 0 || i >= MAXZ) return;
  f64 *z = &Z[i * ZS];
  if (z[0] < 0.5) return;
  if (dur > z[29]) z[29] = dur;
}
/* dano em área sem evento de explosão (o JS desenha o efeito): balas explosivas, minas, barris */
EXP("blastAt") void blastAt(f64 x, f64 y, f64 r, f64 dmg, f64 kb) { areaDamage(x, y, r, dmg, kb); }
EXP("explodeAt") void explodeAt(f64 x, f64 y, f64 r, f64 dmg) { explode(x, y, r, dmg, 30.0); }
EXP("losBlocked") i32 losBlocked(f64 x1, f64 y1, f64 x2, f64 y2) { return segBlocked(x1, y1, x2, y2); }

EXP("aliveCount") i32 aliveCount(void) {
  i32 n = 0;
  for (i32 i = 0; i < MAXZ; i++) if (Z[i * ZS] > 0.5) n++;
  return n;
}
EXP("eventCount") i32 eventCount(void) { return nEv; }
EXP("clearEvents") void clearEvents(void) { nEv = 0; }

EXP("zPtr") i32 zPtr(void) { return (i32)(unsigned long)Z; }
EXP("gPtr") i32 gPtr(void) { return (i32)(unsigned long)G; }
EXP("bPtr") i32 bPtr(void) { return (i32)(unsigned long)B; }
EXP("ePtr") i32 ePtr(void) { return (i32)(unsigned long)E; }
EXP("layout") i32 layout(i32 w) {
  switch (w) {
    case 0: return MAXZ; case 1: return ZS; case 2: return MAXB; case 3: return BS;
    case 4: return MAXE; case 5: return ES; case 6: return MAXG; case 7: return GS; default: return 0;
  }
}
