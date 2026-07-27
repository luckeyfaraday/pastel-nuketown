/* =====================================================================
   PASTEL NUKETOWN — touch controls

   A phone has no pointer lock and no keyboard, so every input this game
   reads has to come from somewhere else. The screen is divided into two
   invisible drag zones (left = movement stick, right = look) with a
   cluster of held buttons on top of them.

   Nothing here reaches into the simulation. The stick writes the four
   movement fields of TOUCH and readLocalInput merges them, so local
   movement, the guest input packet and the host's remote step all stay
   unaware that a touchscreen exists. Firing is the one exception: it is
   an edge rather than a level, so the FIRE button goes through the same
   pressFire()/releaseFire() pair the mouse uses.

   TOUCH itself lives in 70-game.js because it is an input contract. The
   widget state below — which finger owns what, where the stick was
   drawn — is nobody else's business and stays here.
   ===================================================================== */

const TUI = {
  visible: false,            // controls currently on screen
  sens: 0.0044,              // radians per CSS pixel of look drag
  stickId: -1, lookId: -1,   // pointerIds we own, -1 when free
  stickX: 0, stickY: 0,      // stick base, in client coords
  lookX: 0, lookY: 0,        // last look sample, for deltas
  radius: 54,                // stick throw, CSS px
  bound: false,
  rotateDismissed: false,
  el: null, stick: null, nub: null, weps: [], rotate: null
};

/* Below this the thumb is resting, not steering. Rescaled past it so the
   very first pixel of real input isn't a jump to 14% speed. */
const TOUCH_DEADZONE = 0.14;
/* Pushing the stick to the top of its throw means "run", so sprint costs
   no screen space and no second thumb. Just under full so a slightly
   off-centre push still sprints. */
const TOUCH_SPRINT_AT = 0.86;
const TOUCH_NUB_R = 27;      // half the nub, for centring its transform

/* =====================================================================
   DETECTION
   ===================================================================== */
/* maxTouchPoints alone is true for touchscreen laptops, and a coarse
   pointer alone can be a TV remote, so require both — then sniff for a
   real finger as the tiebreaker for anything that lies about either. */
function touchWanted() {
  const forced = QS.get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return (navigator.maxTouchPoints || 0) > 0 &&
         !!(matchMedia && matchMedia('(pointer: coarse)').matches);
}

function initTouch() {
  TUI.el = document.getElementById('touch');
  TUI.stick = document.getElementById('tStick');
  TUI.nub = TUI.stick ? TUI.stick.firstElementChild : null;
  TUI.weps = Array.prototype.slice.call(document.querySelectorAll('#tWeps button'));
  TUI.rotate = document.getElementById('rotate');

  if (touchWanted()) { enableTouch(); return; }

  /* A hybrid laptop reports a fine pointer right up until someone puts a
     finger on the glass. Watch for exactly that, once. */
  const sniff = e => {
    if (e.pointerType !== 'touch') return;
    removeEventListener('pointerdown', sniff, true);
    enableTouch();
  };
  addEventListener('pointerdown', sniff, true);
}

function enableTouch() {
  if (TOUCH.on || !TUI.el) return;
  TOUCH.on = true;
  document.body.classList.add('touch');
  bindTouchControls();
  touchSetVisible(false);
  updateRotateNudge();
}

/* =====================================================================
   BINDING
   ===================================================================== */
function bindTouchControls() {
  if (TUI.bound) return;
  TUI.bound = true;

  document.getElementById('tMove').addEventListener('pointerdown', onStickDown);
  document.getElementById('tLook').addEventListener('pointerdown', onLookDown);

  /* Tracked on the window, not the zone: a thumb that slides out of its
     half of the screen must keep steering, and a pointerup delivered
     somewhere else must still release the control. */
  addEventListener('pointermove', onTouchMove, { passive: false });
  addEventListener('pointerup', onTouchUp);
  addEventListener('pointercancel', onTouchUp);

  touchButton('tFire', e => { claimLook(e); pressFire(); }, releaseFire);
  touchButton('tJump', () => { TOUCH.jump = true; }, () => { TOUCH.jump = false; });
  touchButton('tReload', () => {
    if (!G.player) return;
    IN.reloadSeq++;
    tryReload(G.player);
  });
  touchButton('tPause', () => { SFX.ui(); setPaused(true); });
  touchButton('tBoard', () => { SFX.ui(); setBoard(!elBoard.classList.contains('on')); });
  for (const b of TUI.weps) touchButton(b, () => switchWeapon(b.dataset.w));

  const ok = document.getElementById('rotateOk');
  if (ok) ok.addEventListener('click', () => {
    TUI.rotateDismissed = true;
    updateRotateNudge();
  });

  addEventListener('orientationchange', updateRotateNudge);
}

/* A held button, not a click: FIRE and JUMP have to report release, and a
   click event would never arrive if the thumb slid off the button first.
   Pointer capture keeps that thumb ours until it lifts. */
function touchButton(target, onPress, onRelease) {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    if (el.classList.contains('down')) return;
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    el.classList.add('down');
    onPress(e);
  });
  const up = e => {
    if (!el.classList.contains('down')) return;
    el.classList.remove('down');
    if (onRelease) onRelease(e);
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/* =====================================================================
   MOVEMENT STICK
   ===================================================================== */
function onStickDown(e) {
  if (TUI.stickId !== -1) return;            // one thumb owns the stick
  e.preventDefault();
  TUI.stickId = e.pointerId;
  TUI.stickX = e.clientX;
  TUI.stickY = e.clientY;
  placeStick();
  TUI.stick.hidden = false;
  trackStick(e.clientX, e.clientY);
}

function placeStick() {
  TUI.stick.style.left = TUI.stickX + 'px';
  TUI.stick.style.top = TUI.stickY + 'px';
}

function trackStick(x, y) {
  let dx = x - TUI.stickX, dy = y - TUI.stickY;
  const r = Math.hypot(dx, dy), R = TUI.radius;
  /* Past the rim, drag the whole base along instead of pinning the nub.
     Without this a thumb that wanders keeps reporting full deflection in
     the original direction, which feels like the stick is stuck. */
  if (r > R) {
    const over = 1 - R / r;
    TUI.stickX += dx * over;
    TUI.stickY += dy * over;
    dx *= R / r; dy *= R / r;
    placeStick();
  }

  const nx = dx / R, ny = -dy / R;            // screen Y is down, forward is up
  const m = Math.hypot(nx, ny);
  if (m < TOUCH_DEADZONE) {
    TOUCH.strafe = TOUCH.fwd = 0;
  } else {
    const scale = Math.min(1, (m - TOUCH_DEADZONE) / (1 - TOUCH_DEADZONE)) / m;
    TOUCH.strafe = nx * scale;
    TOUCH.fwd = ny * scale;
  }
  TOUCH.sprint = TOUCH.fwd > TOUCH_SPRINT_AT;
  if (TUI.nub) TUI.nub.style.transform = 'translate(' +
    (dx - TOUCH_NUB_R).toFixed(1) + 'px,' + (dy - TOUCH_NUB_R).toFixed(1) + 'px)';
}

function releaseStick() {
  TUI.stickId = -1;
  TOUCH.strafe = TOUCH.fwd = 0;
  TOUCH.sprint = false;
  if (TUI.stick) TUI.stick.hidden = true;
  if (TUI.nub) TUI.nub.style.transform =
    'translate(' + -TOUCH_NUB_R + 'px,' + -TOUCH_NUB_R + 'px)';
}

/* =====================================================================
   LOOK
   ===================================================================== */
function onLookDown(e) {
  claimLook(e, true);
}

/* Who gets to aim, when two fingers are down and either could mean it.

   FIRE takes the look pointer only when nothing already holds it, which is
   what lets you press the trigger and slide off it to turn. A drag beginning
   in the look zone takes it unconditionally, because starting a drag there
   means nothing except "aim", while a finger parked on FIRE says nothing
   about looking at all. Without that asymmetry the common grip -- index
   finger holding FIRE still, other thumb turning -- finds look owned by a
   pointer that never moves, and aiming dies for as long as the trigger is
   held. Firing is unaffected either way; only look ownership moves.

   Seeding lookX/lookY here is not optional: onTouchMove deltas against them,
   so a claim that set the id alone would measure the first movement from
   wherever the previous drag ended and snap the view. */
function claimLook(e, steal) {
  if (TUI.lookId !== -1 && !steal) return;
  e.preventDefault();
  TUI.lookId = e.pointerId;
  TUI.lookX = e.clientX;
  TUI.lookY = e.clientY;
}

function onTouchMove(e) {
  if (e.pointerId === TUI.stickId) {
    e.preventDefault();
    trackStick(e.clientX, e.clientY);
    return;
  }
  if (e.pointerId !== TUI.lookId) return;
  e.preventDefault();
  const dx = e.clientX - TUI.lookX, dy = e.clientY - TUI.lookY;
  TUI.lookX = e.clientX;
  TUI.lookY = e.clientY;
  if (G.started && !G.paused && !G.over) applyLook(dx, dy, TUI.sens);
}

function onTouchUp(e) {
  if (e.pointerId === TUI.stickId) releaseStick();
  else if (e.pointerId === TUI.lookId) TUI.lookId = -1;
}

/* =====================================================================
   VISIBILITY
   ===================================================================== */
function updateTouchUI() {
  if (!TOUCH.on) return;
  const show = G.started && !G.paused && !G.over;
  if (show !== TUI.visible) touchSetVisible(show);
  if (show && G.player) {
    for (const b of TUI.weps) b.classList.toggle('on', b.dataset.w === G.player.weapon);
  }
  updateRotateNudge();
}

function touchSetVisible(on) {
  TUI.visible = on;
  TUI.el.hidden = !on;
  if (!on) touchReleaseAll();
}

/* Hiding the controls has to drop whatever they were holding. Otherwise
   opening the pause card mid-sprint resumes you sprinting into a wall
   with the trigger still down. */
function touchReleaseAll() {
  releaseStick();
  TUI.lookId = -1;
  TOUCH.jump = false;
  releaseFire();
  if (!TUI.el) return;
  for (const el of TUI.el.querySelectorAll('.tbtn.down')) el.classList.remove('down');
}

function updateRotateNudge() {
  if (!TUI.rotate) return;
  const portrait = innerHeight > innerWidth;
  TUI.rotate.hidden = !(TOUCH.on && portrait && !TUI.rotateDismissed);
}

/* =====================================================================
   IMMERSIVE MODE
   Called from startMatch, which on a phone runs inside the SOLO tap, so
   the user activation both of these need is still live. Both are polite
   requests: iOS Safari has no element fullscreen and orientation lock is
   desktop-optional, so failure is silent and the game plays on.
   ===================================================================== */
function touchEnterImmersive() {
  if (!TOUCH.on) return;
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      const r = el.requestFullscreen({ navigationUI: 'hide' });
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch (e) {}
  try {
    const o = screen.orientation;
    if (o && o.lock) {
      const r = o.lock('landscape');
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch (e) {}
}
