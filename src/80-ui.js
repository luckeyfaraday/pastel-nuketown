/* =====================================================================
   PASTEL NUKETOWN — HUD, killfeed, scoreboard, screens
   ===================================================================== */
const $ = id => document.getElementById(id);
const elHp = $('hpbar'), elHpN = $('hpnum'), elAmmo = $('acount'), elWName = $('wname');
const elReload = $('reloading'), elSlots = $('wslots').children;
const elScore = $('tScore'), elLead = $('tLead'), elGoal = $('tGoal');
const elFeed = $('feed'), elHint = $('hint'), elBoard = $('board'), elBoardBody = $('boardBody');
const elHitmark = $('hitmark'), elDmg = $('dmg'), elHeal = $('heal');
const elCross = { u: $('cU'), d: $('cD'), l: $('cL'), r: $('cR') };

let crossSpread = 8, crossPunch = 0, hitmarkT = 0, dmgFlash = 0, healFlash = 0;

function uiScore(a) { return G.mode === 'kc' ? (a.confirms || 0) : a.kills; }
function uiTarget() { return G.mode === 'kc' ? CFG.confirmsToWin : CFG.killsToWin; }

/* Where the scoreboard lives when no full-screen card is up. */
const boardHome = elBoard.parentNode;
function restoreBoard() {
  if (elBoard.parentNode !== boardHome) boardHome.appendChild(elBoard);
  elBoard.classList.remove('on');
}
const damageDirs = [];

function updateHUD() {
  const p = G.player;
  if (!p) return;
  const f = clamp(p.health / p.maxHealth, 0, 1);
  elHp.style.width = (f * 100) + '%';
  elHp.classList.toggle('low', f <= 0.35);
  elHpN.textContent = String(Math.max(0, Math.ceil(p.health)));

  /* The weapon card belongs to whoever the camera does. Through a killcam the
     gun on screen is the killer's, and a card still counting your own
     magazine next to it is a straight contradiction. Ammo and reserve are
     replicated per actor, so a guest is reading their real magazine and not a
     guess. Everything else on the HUD stays yours — health and score are
     about you, and you being dead is the whole context. */
  const gunOwner = KILLCAM.shown || p;
  const w = WBY[gunOwner.weapon];
  elWName.textContent = w.name;
  elAmmo.innerHTML = gunOwner.ammo + '<small>/' + gunOwner.reserve + '</small>';
  elAmmo.classList.toggle('empty', gunOwner.ammo === 0);
  /* PRESS R is an instruction, and there is nothing you can do about somebody
     else's empty magazine. The line names whose gun this is instead, which is
     also what stops the borrowed card from reading as your own. */
  elReload.textContent = KILLCAM.shown
    ? (gunOwner.reloadT > 0 ? 'RELOADING' : gunOwner.name)
    : (p.reloadT > 0 ? 'RELOADING' : (p.ammo === 0 ? 'PRESS R' : ''));

  const order = ['smg', 'shotgun', 'rifle'];
  for (let i = 0; i < elSlots.length; i++) elSlots[i].classList.toggle('on', order[i] === gunOwner.weapon);

  elScore.textContent = String(uiScore(p));
  elGoal.textContent = String(uiTarget());
  let lead = G.actors[0];
  for (const a of G.actors) if (uiScore(a) > uiScore(lead)) lead = a;
  elLead.textContent = uiScore(lead) > 0 ? (lead.isPlayer ? 'YOU' : lead.name) : '—';
}

function setCrosshairPunch(px) { crossPunch = Math.max(crossPunch, px); }
function updateCrosshair(dt) {
  const p = G.player;
  const spd = p ? Math.hypot(p.vel.x, p.vel.z) : 0;
  const w = p ? WBY[p.weapon] : WEAPONS[0];
  /* A semi-auto held on touch has committed its shot to the lift, so nothing
     happens on screen for as long as the thumb stays down. Draw the reticle in
     while it is armed — without it the trigger reads as not having registered. */
  const base = 7 + spd * 1.5 + (w.id === 'shotgun' ? 9 : 0) + (p && !p.onGround ? 6 : 0)
             - (IN.touchSemiArmed ? 4 : 0);
  crossPunch = Math.max(0, crossPunch - dt * 60);
  crossSpread = damp(crossSpread, base + crossPunch, 16, dt);
  const s = crossSpread;
  elCross.u.style.top = (-s - 11 + 22) + 'px'; elCross.u.style.transform = 'translateY(' + (-s) + 'px)';
  elCross.d.style.top = (22 + s) + 'px';
  elCross.l.style.left = 'calc(50% - ' + (s + 11) + 'px)';
  elCross.r.style.left = 'calc(50% + ' + s + 'px)';
  elCross.u.style.top = 'calc(50% - ' + (s + 11) + 'px)'; elCross.u.style.transform = '';
  elCross.d.style.top = 'calc(50% + ' + s + 'px)';

  if (hitmarkT > 0) {
    hitmarkT -= dt;
    elHitmark.style.opacity = String(clamp(hitmarkT / 0.22, 0, 1));
    elHitmark.style.transform = 'scale(' + (1.45 - clamp(hitmarkT / 0.22, 0, 1) * 0.45) + ')';
  } else elHitmark.style.opacity = '0';

  if (dmgFlash > 0) { dmgFlash -= dt; elDmg.style.opacity = String(clamp(dmgFlash / 0.45, 0, 1) * 0.9); }
  else elDmg.style.opacity = '0';
  if (healFlash > 0) { healFlash -= dt; elHeal.style.opacity = String(clamp(healFlash / 0.5, 0, 1) * 0.7); }
  else elHeal.style.opacity = '0';
}
function showHitmarker(head) {
  hitmarkT = 0.22;
  for (const s of elHitmark.children) s.style.background = head ? '#ffe27a' : '#ffffff';
}
function flashDamage() { dmgFlash = 0.45; }

/* ---- directional damage arrows ---- */
function addDamageDir(from) {
  const el = document.createElement('div');
  el.className = 'dind';
  $('hud').appendChild(el);
  damageDirs.push({ el, from, t: 1.1 });
  if (damageDirs.length > 5) { const d = damageDirs.shift(); d.el.remove(); }
}
function setDamageDirsCleared() { while (damageDirs.length) damageDirs.pop().el.remove(); }
function updateDamageDirs(dt) {
  const p = G.player;
  for (let i = damageDirs.length - 1; i >= 0; i--) {
    const d = damageDirs[i];
    d.t -= dt;
    if (d.t <= 0 || !p) { d.el.remove(); damageDirs.splice(i, 1); continue; }
    const ang = Math.atan2(d.from.pos.x - p.pos.x, d.from.pos.z - p.pos.z);
    const rel = angDelta(p.yaw, ang);
    d.el.style.transform = 'rotate(' + (-rel) + 'rad)';
    d.el.style.opacity = String(clamp(d.t / 1.1, 0, 1));
  }
}

/* ---- killfeed ---- */
const feedItems = [];
function addKillFeed(from, target, outcome) {
  const el = document.createElement('div');
  el.className = 'fitem';
  const w = from ? WBY[from.weapon] : null;
  const nm = (a) => {
    const s = document.createElement('b');
    s.textContent = a.isPlayer ? 'YOU' : a.name;
    s.style.color = a.isPlayer ? '#d4638f' : '#4a3f5c';
    return s;
  };
  if (outcome) {
    el.dataset.kind = 'donut-' + outcome.toLowerCase();
    const source = outcome === 'DENIED' ? target : from;
    el.appendChild(nm(source));
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '🍩';
    el.appendChild(ic);
    if (outcome !== 'DENIED' && target && target !== source) el.appendChild(nm(target));
    const label = document.createElement('b');
    label.textContent = outcome;
    label.style.color = outcome === 'CONFIRMED' ? '#258c6b' :
      (outcome === 'STOLEN' ? '#c54e7a' : '#8069b0');
    el.appendChild(label);
  } else if (from && from !== target) {
    el.appendChild(nm(from));
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = w ? w.icon : '💥';
    el.appendChild(ic);
  } else {
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = '💀';
    el.appendChild(ic);
  }
  el.appendChild(nm(target));
  elFeed.appendChild(el);
  feedItems.push({ el, t: 5.0 });
  if (feedItems.length > 5) { const f = feedItems.shift(); f.el.remove(); }
}
function updateFeed(dt) {
  for (let i = feedItems.length - 1; i >= 0; i--) {
    const f = feedItems[i];
    f.t -= dt;
    if (f.t <= 0) { f.el.remove(); feedItems.splice(i, 1); continue; }
    if (f.t < 0.6) f.el.style.opacity = String(f.t / 0.6);
  }
}

/* ---- hint toast ---- */
let hintT = 0;
function showHint(text) { elHint.textContent = text; hintT = 2.4; }
function updateHint(dt) {
  if (hintT > 0) {
    hintT -= dt;
    const u = clamp(hintT / 0.4, 0, 1) * clamp((2.4 - hintT) / 0.25, 0, 1);
    elHint.style.opacity = String(u);
  } else elHint.style.opacity = '0';
}

/* ---- scoreboard ---- */
/* The board centres itself on the viewport, so on its own it lands right on
   top of any full-screen card. Whenever one is up, park it inside that card
   instead — checking the scores while dead is a thing players actually do. */
function setBoard(on) {
  if (on) {
    refreshBoard();
    const dead = document.getElementById('dead');
    if (!G.over && !dead.classList.contains('off')) dead.appendChild(elBoard);
    else if (!G.over && elBoard.parentNode !== boardHome) boardHome.appendChild(elBoard);
  } else if (!G.over && elBoard.parentNode !== boardHome) {
    boardHome.appendChild(elBoard);
  }
  elBoard.classList.toggle('on', on);
}
function refreshBoard() {
  const head = elBoard.querySelector && elBoard.querySelector('thead tr');
  if (head && head.children) {
    let marker = Array.from(head.children).find(th => th.dataset && th.dataset.kcConfirms);
    if (G.mode === 'kc' && !marker) {
      marker = document.createElement('th');
      marker.dataset.kcConfirms = '1';
      marker.textContent = 'Confirms';
      head.insertBefore(marker, head.children[1] || null);
    } else if (G.mode !== 'kc' && marker) {
      marker.remove();
    }
  }
  const rows = G.actors.slice().sort((a, b) =>
    uiScore(b) - uiScore(a) || b.kills - a.kills || a.deaths - b.deaths);
  elBoardBody.innerHTML = '';
  for (const a of rows) {
    const tr = document.createElement('tr');
    if (a.isPlayer) tr.className = 'me';
    const td0 = document.createElement('td');
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = '#' + a.colors.body.toString(16).padStart(6, '0');
    td0.appendChild(sw);
    td0.appendChild(document.createTextNode(a.isPlayer ? 'YOU' : a.name));
    tr.appendChild(td0);
    const values = G.mode === 'kc'
      ? [a.confirms || 0, a.kills, a.deaths, a.bestStreak]
      : [a.kills, a.deaths, a.bestStreak];
    for (const v of values) {
      const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
    }
    elBoardBody.appendChild(tr);
  }
}

/* ---- death + match-over screens ---- */
/* Both ways a local player can die converge here already, carrying the killer:
   solo and host through killActor, a guest through the snapshot that first
   reports it dead. So this is the one place the killcam has to be told, and
   the only place that cannot miss a death. */
function showDeadScreen(from) {
  $('deadBy').textContent = from && from !== G.player ? ('taken out by ' + from.name) : 'you went down';
  $('dead').classList.remove('off');
  killcamBegin(from);
  updateReportButton();
}
function hideDeadScreen() {
  $('dead').classList.add('off'); killcamEnd(); updateReportButton();
  if (!G.over) restoreBoard();
}

/* ---- report ----
   The button reports the killer, not whoever the camera happens to be on. The
   two are the same for all but a moment: killcamActor drops the view when the
   killer dies or leaves, and a target that vanished for the three seconds
   their own respawn takes would be a button that flickered away under the
   thumb reaching for it.

   Everything about whether it can be pressed lives in netReportableId, so the
   answer is the same one the relay will give — a bot, a solo match, a player
   who already left, and yourself all come back null and the button is simply
   not there. */
function reportTarget() {
  if (!G.player || G.player.alive || G.over) return null;
  return netReportableId(KILLCAM.killer);
}

function updateReportButton() {
  const el = $('deadReport');
  if (!el) return;
  const target = reportTarget();
  el.classList.toggle('off', !target);
  if (!target) return;
  const sent = netHasReported(target);
  el.disabled = sent || NET.reportSending === target;
  const label = $('deadReportLabel');
  if (label) label.textContent = sent ? 'REPORTED' : 'REPORT AIM';
}

function initReportButton() {
  const el = $('deadReport');
  if (!el) return;
  el.addEventListener('click', () => { sendReport(); });
}

/* Two ways in, because on desktop the pointer is locked to the canvas for the
   whole death and a click never reaches the button at all. The key is the real
   control there; the button is what says the key exists. On touch there is no
   lock and the tap is the only way in. */
function sendReport() {
  const target = reportTarget();
  if (!target || netHasReported(target) || NET.reportSending) return;
  netReportPlayer(target);
  updateReportButton();
}
function updateDeadScreen() {
  if (G.player && !G.player.alive) $('deadCd').textContent = String(Math.max(1, Math.ceil(G.player.respawnT)));
  /* Every frame the card is up, because the roster can move under it: a killer
     who quits mid-respawn has to take the button with them rather than leave
     one that the relay would only refuse. */
  updateReportButton();
}
function showOverScreen(winner) {
  const rows = G.actors.slice().sort((a, b) => uiScore(b) - uiScore(a) || b.kills - a.kills);
  const place = rows.indexOf(G.player) + 1;
  $('overBig').textContent = winner.isPlayer ? 'YOU WIN!' : (winner.name + ' WINS');
  const scoreText = G.mode === 'kc' ? G.player.confirms + ' confirms' : G.player.kills + ' kills';
  $('overRank').textContent = 'You placed #' + place + ' of ' + rows.length +
    '  ·  ' + scoreText + ' / ' + G.player.deaths + ' deaths  ·  best streak ' + G.player.bestStreak;
  refreshBoard();
  const over = $('over');
  over.insertBefore(elBoard, $('again'));
  elBoard.classList.add('on');
  const again = $('again');
  if (netIsGuest()) {
    again.textContent = 'WAITING FOR HOST';
    again.disabled = true;
  } else if (netIsHost()) {
    again.textContent = 'START REMATCH';
    again.disabled = false;
  } else {
    again.textContent = 'REMATCH';
    again.disabled = false;
  }
  over.classList.remove('off');
}

/* ---- pause ---- */
function setPaused(p) {
  if (G.over) return;
  G.paused = p;
  const dead = $('dead');
  if (p && G.started) {
    netSetPauseMenu(true);
    $('title').classList.remove('off');
    $('play').textContent = 'RESUME';
    /* Pausing while dead used to soft-lock: #dead and #title share a z-index
       and #dead is later in the DOM, so the death card painted over the pause
       menu and swallowed the RESUME click. And because the sim is halted while
       paused, the respawn timer never ran either — stuck for good. Stash the
       death card for the duration; it comes back on resume if still dead. */
    if (!dead.classList.contains('off')) { dead.classList.add('off'); dead.dataset.wasUp = '1'; }
    restoreBoard();
  } else if (G.started) {
    netSetPauseMenu(false);
    $('title').classList.add('off');
    if (dead.dataset.wasUp === '1' && G.player && !G.player.alive) dead.classList.remove('off');
    delete dead.dataset.wasUp;
  }
}
