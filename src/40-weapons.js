/* =====================================================================
   PASTEL NUKETOWN — weapons & the first-person viewmodel
   The viewmodel lives in its own scene/camera pair rendered after a
   depth clear, which is how it stays out of walls without clipping.
   ===================================================================== */

const WEAPONS = [
  {
    id: 'smg', name: 'BUBBLEGUN', icon: '🫧',
    mag: 30, reserve: 180, dmg: 15, headMul: 1.9, rpm: 720, auto: true,
    spread: 0.021, spreadMove: 0.030, pellets: 1, reload: 1.55, range: 90,
    kick: 0.016, kickRot: 0.030, speed: 1.0,
    col: { body: 0xffb7c5, accent: 0xb8f2d8, metal: 0xe9e2f2, grip: 0x6b5f80 },
    flash: 0xffd9e8, tracer: 0xffb7c5, projectile: 'bubble'
  },
  {
    id: 'shotgun', name: 'MARSHMALLOW', icon: '🍡',
    mag: 7, reserve: 42, dmg: 13, headMul: 1.35, rpm: 95, auto: false,
    spread: 0.075, spreadMove: 0.088, pellets: 9, reload: 2.3, range: 34,
    kick: 0.055, kickRot: 0.105, speed: 0.94,
    col: { body: 0xffefa8, accent: 0xff9aa2, metal: 0xe9e2f2, grip: 0xd8a97a },
    flash: 0xffd8b0, tracer: 0xffc79a, projectile: 'mallow'
  },
  {
    id: 'rifle', name: 'LOLLIPOP', icon: '🍭',
    mag: 10, reserve: 60, dmg: 52, headMul: 2.2, rpm: 165, auto: false,
    spread: 0.004, spreadMove: 0.030, pellets: 1, reload: 1.9, range: 140,
    kick: 0.040, kickRot: 0.075, speed: 0.92,
    col: { body: 0xd4c5f9, accent: 0xa8dcf0, metal: 0xe9e2f2, grip: 0x6b5f80 },
    flash: 0xc9e8ff, tracer: 0xbcd8ff, projectile: 'dart'
  }
];
const WBY = {}; WEAPONS.forEach(w => WBY[w.id] = w);

/* Weapon cosmetics live beside the simulation records but never replace
   them. A skin owns the whole *look* of the viewmodel — palette, effect
   colours and geometry — and none of its behaviour, so it can make a gun
   feel like a different toy without quietly introducing a fourth weapon
   with different damage, timing or ammunition.

   Three of the fields below are geometry rather than colour:

     build(B, P)  draws the gun's boxes instead of the default silhouette
     hands        where the mitten hands grab the new shape
     muzzle       [x, y, z] where the flash leaves the new barrel

   They are deliberately NOT in weaponForSkin's copy list. Everything the
   simulation ever reads goes through that function, and it still copies
   only col/flash/tracer; these three are read by buildGunMesh alone, which
   runs in vmScene after a depth clear and touches no hitbox, no spread and
   no timing. A skin can therefore reshape the gun without being able to
   reach a gameplay value even by accident.

   Colours are 24-bit 0xRRGGBB — six digits, never eight. The palette is the
   town's own — deepened, not replaced: candy rose, caramel enamel, berry
   lacquer, brass and gold leaf, pistachio. Every skin keeps a wide value
   range (a bright metal against a dark grip), stays clear of the mitten
   tones (0xffe0c8 / 0xfff8f0) so the gun separates from the hands holding
   it, and stays clear of near-black, which belongs to a harsher game than
   this one. skins.test.js enforces all of it.

   Each skin is a different KIND of object rather than a repainted gun, and
   the class silhouette is what survives the change: magazine-forward and
   stubby for the SMG, wide-fronted and heavy for the shotgun, long and lean
   under a raised sight line for the rifle. */
const WEAPON_SKINS = {
  /* COTTON CLOUD — a fairground candy-floss spinner. The gun is a little
     brass-and-enamel machine off a seaside pier: a striped awning over the
     housing, a spinning floss bowl slung forward-low where the magazine
     was, a hand crank on the right, and a paper cone at the front with the
     spun sugar still gathering on it. No stock, just a paddle handle — so
     it stays short, round and fast in the hands. */
  'smg-cottoncloud': {
    weapon: 'smg', name: 'Cotton Cloud',
    col: { body: 0xff8fb4, accent: 0x9fe8c8, metal: 0xf5c86e, grip: 0x7a6390 },
    flash: 0xffd0e8, tracer: 0xff8fb4,
    muzzle: [0, 0.018, -0.655],
    hands: [[0, -0.115, 0.085], [0, -0.085, -0.300]],
    build(B, P) {
      const { body, acc, met, grip, c } = P;
      const floss = C(0xffc4e2);   // spun sugar, the same pink as the town's blossom
      B.box([-0.058, -0.030, -0.24], [0.058, 0.070, 0.16], body, { top: Cx(c.body, 1.06) });
      // striped awning — the fairground tell, and the gun's top line
      B.box([-0.072, 0.070, -0.22], [0.072, 0.104, 0.06], acc);
      B.box([-0.078, 0.104, -0.20], [0.078, 0.120, 0.04], Cx(c.accent, 1.08));
      B.box([-0.030, 0.066, -0.23], [0.030, 0.124, 0.07], body);            // awning stripe
      B.box([-0.026, 0.120, -0.16], [0.026, 0.156, -0.13], met);            // brass ring sight
      // floss bowl: slung forward and low, so the gun still reads mag-forward
      B.box([-0.084, -0.180, -0.230], [0.084, -0.020, -0.030], met, { top: Cx(c.metal, 1.08) });
      B.box([-0.092, -0.140, -0.245], [0.092, -0.080, -0.015], acc);        // bowl rim band
      B.box([-0.072, -0.216, -0.210], [0.072, -0.180, -0.050], Cx(c.metal, 0.86)); // bowl taper
      B.box([0.092, -0.135, -0.150], [0.116, -0.090, -0.110], Cx(c.metal, 1.12)); // crank boss
      B.box([0.104, -0.190, -0.145], [0.124, -0.120, -0.115], met);         // crank arm
      // paper cone: four widening steps, the floss gathering past the lip
      B.box([-0.034, -0.010, -0.36], [0.034, 0.046, -0.24], met);           // spout neck
      B.box([-0.046, -0.022, -0.44], [0.046, 0.058, -0.36], body);
      B.box([-0.060, -0.036, -0.51], [0.060, 0.072, -0.44], acc);
      B.box([-0.074, -0.050, -0.56], [0.074, 0.086, -0.51], Cx(c.body, 1.10)); // cone lip
      B.box([-0.052, -0.028, -0.60], [0.052, 0.064, -0.555], floss);
      B.box([-0.034, 0.002, -0.63], [0.034, 0.048, -0.60], Cx(0xffc4e2, 1.06));
      B.box([-0.062, 0.000, -0.14], [0.062, 0.040, -0.06], acc);            // ticket plate
      B.box([-0.044, -0.215, 0.030], [0.044, -0.010, 0.140], grip);         // paddle handle
      B.box([-0.052, -0.245, 0.020], [0.052, -0.205, 0.150], Cx(c.grip, 1.32));
      B.box([-0.050, -0.010, 0.160], [0.050, 0.062, 0.200], met);           // brass cap, no stock
    }
  },
  /* TOASTED MALLOW — a little mint-enamel camp stove in brass. Pot-bellied
     and riveted, with a hinged fire door on the side, a chimney stub standing
     in for the bead sight, a walnut bellows slung underneath as the fore-end,
     and a wide flared mouth with a mallow toasting in it. Fat, front-heavy
     and short: everything a scattergun silhouette is made of. The cool
     enamel is what keeps the warm mallow at the mouth reading as the focus,
     and what separates it from the butter-and-coral gun underneath. */
  'shotgun-toastedmallow': {
    weapon: 'shotgun', name: 'Toasted Mallow',
    col: { body: 0x6fd6ae, accent: 0xf2a04e, metal: 0xf7d98a, grip: 0x8a6a52 },
    flash: 0xffc07a, tracer: 0xffa85e,
    muzzle: [0, 0.006, -0.640],
    hands: [[0, -0.100, 0.130], [0, -0.185, -0.200]],
    build(B, P) {
      const { body, acc, met, grip, c } = P;
      const mallow = C(0xf7c98a);   // a mallow held over the fire a moment too long
      B.box([-0.086, -0.086, -0.30], [0.086, 0.078, 0.16], body, { top: Cx(c.body, 1.08) });
      B.box([-0.094, -0.096, -0.22], [0.094, 0.086, -0.17], met);           // rivet hoop
      B.box([-0.094, -0.096, -0.02], [0.094, 0.086, 0.03], met);            // rivet hoop
      B.box([-0.100, -0.050, -0.15], [-0.086, 0.046, -0.05], acc);          // fire door
      B.box([-0.108, -0.020, -0.12], [-0.100, 0.012, -0.08], Cx(c.metal, 1.14)); // door knob
      B.box([0.086, -0.050, -0.15], [0.100, 0.046, -0.05], acc);            // maker's plate
      B.box([-0.026, 0.078, -0.20], [0.026, 0.150, -0.14], met);            // chimney stub
      B.box([-0.036, 0.150, -0.21], [0.036, 0.172, -0.13], Cx(c.metal, 1.10)); // stack cap
      // the mouth: four steps out to 0.26 wide. This flare IS the scattergun
      // read, so nothing may be added that narrows or fills it.
      B.box([-0.080, -0.060, -0.40], [0.080, 0.062, -0.30], met, { top: Cx(c.metal, 1.06) });
      B.box([-0.098, -0.078, -0.47], [0.098, 0.080, -0.40], Cx(c.metal, 1.02));
      B.box([-0.118, -0.096, -0.53], [0.118, 0.098, -0.47], acc);
      B.box([-0.130, -0.108, -0.565], [0.130, 0.110, -0.53], Cx(c.accent, 1.10)); // lip
      B.box([-0.086, -0.070, -0.60], [0.086, 0.074, -0.545], mallow);       // mallow
      B.box([-0.060, -0.046, -0.63], [0.060, 0.050, -0.60], Cx(0xf7c98a, 0.86)); // toasted tip
      // bellows fore-end: three folds so the leather concertina reads
      B.box([-0.070, -0.150, -0.30], [0.070, -0.080, -0.10], Cx(c.grip, 1.34));
      B.box([-0.078, -0.146, -0.28], [0.078, -0.116, -0.25], grip);
      B.box([-0.078, -0.146, -0.21], [0.078, -0.116, -0.18], grip);
      B.box([-0.078, -0.146, -0.14], [0.078, -0.116, -0.11], grip);
      B.box([-0.048, -0.190, 0.080], [0.048, -0.010, 0.190], grip);         // wooden grip
      /* The stock is the nearest and largest thing on screen in first
         person, so it wears the enamel, not the wood. Walnut that big at
         that distance is a brown slab across the bottom of the view. */
      B.box([-0.058, 0.000, 0.160], [0.058, 0.086, 0.380], body, { top: Cx(c.body, 1.10) });
      B.box([-0.034, 0.086, 0.200], [0.034, 0.104, 0.350], Cx(c.grip, 1.42)); // walnut cheek strip
      B.box([-0.064, -0.010, 0.365], [0.064, 0.096, 0.410], met);           // brass butt plate
    }
  },
  /* BERRY SWIRL — a berry-lacquer brass spyglass. The scope is an actual
     draw-tube telescope, three segments widening toward a gold objective
     bell, standing on two turned pillars; the barrel is a slim lacquered
     tube ringed in gold leaf and finished with a petal aperture, and the
     stock is a thin curved shoulder rest. Long, lean, and unmistakably an
     instrument for hitting one thing a long way off. */
  'rifle-berryswirl': {
    weapon: 'rifle', name: 'Berry Swirl',
    col: { body: 0xd88ab8, accent: 0xf2c96e, metal: 0xdcc8ec, grip: 0x6e5480 },
    flash: 0xf0c0ff, tracer: 0xd486d8,
    muzzle: [0, 0.022, -0.930],
    hands: [[0, -0.100, 0.165], [0, -0.045, -0.300]],
    build(B, P) {
      const { body, acc, met, grip, c } = P;
      B.box([-0.044, -0.026, -0.34], [0.044, 0.058, 0.22], body, { top: Cx(c.body, 1.06) });
      B.box([-0.048, -0.030, -0.26], [0.048, 0.062, -0.23], acc);           // gold-leaf inlay
      B.box([-0.048, -0.030, 0.10], [0.048, 0.062, 0.13], acc);             // gold-leaf inlay
      // slim lacquered barrel, ringed twice, ending in a four-petal aperture
      B.box([-0.024, 0.000, -0.66], [0.024, 0.044, -0.34], met);
      B.box([-0.020, 0.004, -0.86], [0.020, 0.040, -0.66], Cx(c.metal, 1.06));
      B.box([-0.030, -0.004, -0.55], [0.030, 0.048, -0.52], acc);
      B.box([-0.028, -0.002, -0.72], [0.028, 0.046, -0.69], acc);
      B.box([-0.038, 0.014, -0.905], [0.038, 0.030, -0.86], acc);
      B.box([-0.010, -0.014, -0.905], [0.010, 0.058, -0.86], Cx(c.accent, 1.12));
      // draw-tube telescope on turned pillars — the raised sight line, and
      // the taper front-to-back is what makes it a spyglass and not a scope
      B.box([-0.018, 0.058, -0.22], [0.018, 0.108, -0.17], met);            // front pillar
      B.box([-0.018, 0.058, 0.02], [0.018, 0.108, 0.07], met);              // rear pillar
      // the draws alternate deep berry and porcelain — that banding is the
      // swirl the skin is named for, and it stops the long top line from
      // becoming one flat berry slab at viewmodel distance
      B.box([-0.026, 0.108, 0.03], [0.026, 0.152, 0.13], Cx(c.body, 0.82)); // eyepiece draw
      B.box([-0.034, 0.104, -0.10], [0.034, 0.160, 0.03], Cx(c.metal, 1.02)); // middle draw
      B.box([-0.044, 0.098, -0.26], [0.044, 0.168, -0.10], Cx(c.body, 0.82)); // objective draw
      B.box([-0.050, 0.094, -0.30], [0.050, 0.172, -0.26], acc);            // objective bell
      B.box([-0.046, 0.100, -0.315], [0.046, 0.166, -0.30], C(0xd8f2ff));   // front lens
      B.box([-0.030, 0.112, 0.13], [0.030, 0.148, 0.145], C(0xd8f2ff));     // eyepiece lens
      B.box([-0.032, -0.170, -0.055], [0.032, -0.020, 0.060], Cx(c.body, 0.92)); // magazine
      B.box([-0.036, -0.190, -0.045], [0.036, -0.160, 0.050], acc);         // gold floor plate
      B.box([-0.042, -0.195, 0.115], [0.042, -0.005, 0.215], grip);
      B.box([-0.046, -0.070, 0.120], [0.046, -0.030, 0.215], acc);          // gold grip band
      B.box([-0.038, 0.020, 0.22], [0.038, 0.070, 0.46], body);             // shoulder rest
      B.box([-0.030, -0.070, 0.30], [0.030, -0.020, 0.46], Cx(c.metal, 1.02)); // porcelain lower rail
      B.box([-0.040, 0.070, 0.26], [0.040, 0.094, 0.42], Cx(c.body, 1.10)); // cheek
      B.box([-0.042, -0.080, 0.44], [0.042, 0.086, 0.48], Cx(c.body, 1.08)); // shoulder pad
      B.box([-0.046, -0.010, 0.435], [0.046, 0.026, 0.485], acc);           // gold cap band
    }
  }
};

/* A cosmetic lookup is deliberately forgiving. A stale client can receive a
   newer id, and the safe result is the exact base record rather than a
   partially dressed gun or a failed render. */
function baseWeapon(w) {
  if (!w) return null;
  if (w.id && WBY[w.id]) return WBY[w.id];
  return WBY[w.weapon] || null;
}
/* The one place a skin id is validated: it must exist, it must be keyed to
   this exact weapon, and it must carry a palette. Everything cosmetic goes
   through here so a skin can never dress a gun it was not sold for. */
function skinForWeapon(w, skinId) {
  const base = baseWeapon(w);
  const skin = typeof skinId === 'string' ? WEAPON_SKINS[skinId] : null;
  if (!base || !skin || skin.weapon !== base.id || !skin.col) return null;
  return skin;
}
function weaponForSkin(w, skinId) {
  const base = baseWeapon(w);
  const skin = skinForWeapon(w, skinId);
  if (!skin) return base;
  return Object.assign({}, base, {
    col: skin.col, flash: skin.flash, tracer: skin.tracer
  });
}

/* =====================================================================
   VIEWMODEL SCENE
   ===================================================================== */
let vmScene, vmCam, vmRoot, vmGuns = {}, vmGunVariants = {}, vmHands = null, vmFlash = null, vmLight = null;

/* The guns are modelled at true scale (~0.9m) and then shrunk to viewmodel
   proportions. Anything sized to match the gun — the muzzle flash above all
   — must use the SAME number, or it ends up half a screen wide. */
const VM_SCALE = 0.46;

function starTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d');
  g.translate(64, 64);
  const grd = g.createRadialGradient(0, 0, 0, 0, 0, 62);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,244,200,.85)');
  grd.addColorStop(1, 'rgba(255,200,120,0)');
  g.fillStyle = grd;
  g.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU, r = i % 2 ? 22 : 62;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  g.globalCompositeOperation = 'lighter';
  g.beginPath(); g.arc(0, 0, 20, 0, TAU); g.fillStyle = 'rgba(255,255,255,.95)'; g.fill();
  return new THREE.CanvasTexture(cv);
}
let STAR_TEX = null;

/* ---- gun bodies, built from chunky boxes so they read as toys ---- */
function buildGunMesh(w, skinId) {
  const base = baseWeapon(w);
  if (!base) return null;
  const dress = skinForWeapon(w, skinId);
  const visual = weaponForSkin(w, skinId);
  const B = new GeoBuilder();
  const c = visual.col;
  const body = C(c.body), acc = C(c.accent), met = C(c.metal), grip = C(c.grip);

  /* A skin may draw its own silhouette. With no skin — or a skin that only
     repaints — this falls through to the default boxes untouched, so the
     stock guns are built exactly as they always were. */
  if (dress && dress.build) {
    dress.build(B, { body, acc, met, grip, c });
  } else if (base.id === 'smg') {
    B.box([-0.055, -0.030, -0.30], [0.055, 0.075, 0.13], body, { top: Cx(c.body, 1.05) });
    B.box([-0.038, 0.075, -0.24], [0.038, 0.098, 0.06], acc);              // top rail
    B.box([-0.030, -0.012, -0.52], [0.030, 0.048, -0.30], met);            // barrel shroud
    B.box([-0.018, 0.000, -0.60], [0.018, 0.036, -0.52], met);             // muzzle
    B.box([-0.026, 0.008, -0.615], [0.026, 0.044, -0.585], acc);           // muzzle ring
    B.box([-0.040, -0.235, -0.115], [0.040, -0.020, 0.005], acc, { top: acc });  // magazine
    B.box([-0.046, -0.255, -0.125], [0.046, -0.225, 0.015], Cx(c.accent, 0.9));
    B.box([-0.042, -0.20, 0.075], [0.042, -0.005, 0.175], grip);           // pistol grip
    B.box([-0.045, 0.0, 0.13], [0.045, 0.062, 0.30], body);                // stock
    B.box([-0.014, 0.098, -0.20], [0.014, 0.128, -0.17], met);             // front sight
    B.box([-0.020, 0.098, 0.02], [0.020, 0.126, 0.05], met);               // rear sight
    B.box([-0.058, 0.012, -0.16], [0.058, 0.040, -0.10], acc);             // side stripe
  } else if (base.id === 'shotgun') {
    B.box([-0.058, -0.020, -0.34], [0.058, 0.078, 0.16], body, { top: Cx(c.body, 1.05) });
    B.box([-0.030, 0.014, -0.70], [0.030, 0.070, -0.34], met);             // barrel
    B.box([-0.036, 0.006, -0.72], [0.036, 0.078, -0.66], acc);             // muzzle band
    B.box([-0.034, -0.052, -0.62], [0.034, 0.004, -0.16], acc);            // pump
    B.box([-0.042, -0.070, -0.50], [0.042, -0.046, -0.28], Cx(c.accent, 0.92));
    B.box([-0.030, -0.086, -0.30], [0.030, -0.014, -0.16], met);           // tube
    B.box([-0.046, -0.185, 0.085], [0.046, 0.000, 0.195], grip);           // grip
    B.box([-0.050, 0.010, 0.16], [0.050, 0.086, 0.40], body);              // stock
    B.box([-0.052, 0.086, 0.20], [0.052, 0.100, 0.36], acc);               // cheek pad
    B.box([-0.014, 0.078, -0.60], [0.014, 0.104, -0.57], met);             // bead sight
  } else {
    B.box([-0.048, -0.026, -0.40], [0.048, 0.066, 0.20], body, { top: Cx(c.body, 1.05) });
    B.box([-0.022, 0.000, -0.86], [0.022, 0.042, -0.40], met);             // long barrel
    B.box([-0.030, -0.004, -0.90], [0.030, 0.048, -0.84], acc);            // brake
    B.box([-0.038, 0.066, -0.20], [0.038, 0.090, 0.06], acc);              // rail
    B.box([-0.052, 0.090, -0.16], [0.052, 0.150, 0.04], met);              // scope body
    B.box([-0.062, 0.100, -0.17], [0.062, 0.142, -0.15], C(0xd8f2ff));     // front lens
    B.box([-0.062, 0.100, 0.04], [0.062, 0.142, 0.06], C(0xd8f2ff));       // rear lens
    B.box([-0.036, -0.175, -0.055], [0.036, -0.020, 0.055], acc);          // magazine
    B.box([-0.042, -0.190, 0.10], [0.042, -0.005, 0.20], grip);            // grip
    B.box([-0.046, 0.006, 0.20], [0.046, 0.074, 0.44], body);              // stock
    B.box([-0.030, -0.060, 0.30], [0.030, 0.006, 0.40], body);             // cheek riser
    B.box([-0.016, -0.052, -0.52], [0.016, -0.020, -0.44], met);           // bipod nub
  }

  const g = new THREE.Group();
  const mesh = B.mesh(); mesh.castShadow = false; mesh.receiveShadow = false;
  g.add(mesh);
  const ln = B.lines(0.6); if (ln) { ln.renderOrder = 2; g.add(ln); }

  /* mitten hands — cheap, and they sell the cartoon read instantly */
  const H = new GeoBuilder();
  const skin = C(0xffe0c8), cuff = C(0xfff8f0);
  const hand = (x, y, z, rot) => {
    H.box([x - 0.062, y - 0.055, z - 0.075], [x + 0.062, y + 0.062, z + 0.075], skin);
    H.box([x - 0.070, y - 0.070, z + 0.060], [x + 0.070, y + 0.070, z + 0.115], cuff);
    H.box([x - 0.030, y + 0.040, z - 0.095], [x + 0.052, y + 0.078, z + 0.010], skin);  // thumb over top
  };
  /* A reshaped gun needs the hands moved with it, or the mittens end up
     gripping thin air where the old stock or fore-end used to be. */
  if (dress && dress.hands) for (const h of dress.hands) hand(h[0], h[1], h[2]);
  else if (base.id === 'smg')       { hand(0, -0.105, 0.128); hand(0, -0.045, -0.24); }
  else if (base.id === 'shotgun') { hand(0, -0.095, 0.145); hand(0, -0.075, -0.40); }
  else                      { hand(0, -0.100, 0.155); hand(0, -0.055, -0.20); }
  const hm = H.mesh(); hm.castShadow = false;
  g.add(hm);
  const hl = H.lines(0.55); if (hl) g.add(hl);

  // muzzle marker
  const muz = new THREE.Object3D();
  /* The flash has to leave the barrel this skin actually has — a longer or
     shorter muzzle would otherwise light up inside the gun or out in front
     of nothing. */
  if (dress && dress.muzzle) muz.position.set(dress.muzzle[0], dress.muzzle[1], dress.muzzle[2]);
  else muz.position.set(0, 0.02, base.id === 'rifle' ? -0.90 : (base.id === 'shotgun' ? -0.72 : -0.62));
  g.add(muz);
  g.userData.muzzle = muz;
  // magazine part, animated during reload
  g.userData.mag = null;
  g.scale.setScalar(VM_SCALE);
  return g;
}

/* Keep the three ordinary guns resident for a quick first frame, but defer
   cosmetic meshes until a selection actually asks for one. Phones pay for
   every material and line buffer we keep alive, so unused paint should not
   double the viewmodel's startup footprint. */
function ensureVmGunVariant(id, skinId) {
  const base = WBY[id];
  if (!base) return null;
  if (!vmRoot) return null;
  const variants = vmGunVariants[id] || (vmGunVariants[id] = {});
  const key = skinId || 'default';
  if (!variants[key]) {
    const g = buildGunMesh(base, skinId);
    if (!g) return null;
    g.visible = false;
    vmRoot.add(g);
    variants[key] = g;
  }
  return variants[key];
}

function initViewmodel() {
  STAR_TEX = starTexture();
  vmScene = new THREE.Scene();
  /* Aspect is kept in step by syncViewSize, along with the world camera and
     the drawing buffer — the viewmodel has to agree with the scene it is
     composited over, so there is one place that measures the viewport. */
  vmCam = new THREE.PerspectiveCamera(58, viewW() / viewH(), 0.01, 8);

  vmScene.add(new THREE.HemisphereLight(C(0xffffff), C(0xd9c9e8), 0.50));
  const d = new THREE.DirectionalLight(C(0xfff4d9), 0.72); d.position.set(-0.6, 1.1, 0.9); vmScene.add(d);
  const d2 = new THREE.DirectionalLight(C(0xc8d8ff), 0.22); d2.position.set(0.9, 0.2, -0.6); vmScene.add(d2);

  vmRoot = new THREE.Group();
  vmScene.add(vmRoot);

  for (const w of WEAPONS) {
    const variants = { default: buildGunMesh(w) };
    variants.default.visible = false;
    vmRoot.add(variants.default);
    vmGunVariants[w.id] = variants;
    vmGuns[w.id] = variants.default;
  }

  // muzzle flash: additive star + tiny core + a real point light on the world
  vmFlash = new THREE.Group();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: STAR_TEX, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, color: C(0xfff0c0)
  }));
  sp.scale.set(0.5, 0.5, 1);
  vmFlash.add(sp);
  vmFlash.visible = false;
  vmRoot.add(vmFlash);

  vmLight = new THREE.PointLight(C(0xffdca8), 0, 9, 2);
  scene.add(vmLight);
}

/* =====================================================================
   VIEWMODEL ANIMATION STATE
   ===================================================================== */
const VM = {
  cur: 'smg',
  skin: null,
  visual: WBY.smg,
  recoil: 0, recoilV: 0,
  rot: 0, rotV: 0,
  bobT: 0, bob: new THREE.Vector2(),
  sway: new THREE.Vector2(),
  swayT: new THREE.Vector2(),
  swapT: 0, swapFrom: null,
  reloadT: 0, reloadDur: 0,
  flashT: 0,
  sprint: 0,
  landDip: 0
};

function vmSetWeapon(id, instant, skinId) {
  const base = WBY[id];
  if (!base) return;
  const skin = skinForWeapon(base, skinId) ? skinId : null;
  if (VM.cur === id && VM.skin === skin && !instant) return;
  VM.swapFrom = VM.cur;
  VM.cur = id;
  VM.skin = skin;
  /* Resolve the cosmetic once per weapon/skin change. Firing can happen many
     times before the next change, and allocating the same visual copy per
     bullet only creates garbage for the flash colour. */
  VM.visual = weaponForSkin(base, skin);
  VM.swapT = instant ? 0 : 0.42;
  for (const id2 in vmGunVariants)
    for (const variant in vmGunVariants[id2]) vmGunVariants[id2][variant].visible = false;
  const chosen = ensureVmGunVariant(id, skin);
  if (chosen) {
    chosen.visible = true;
    vmGuns[id] = chosen;
  }
}
function vmFire(w) {
  const base = baseWeapon(w);
  if (!base) return;
  const visual = VM.visual && VM.visual.id === base.id ? VM.visual : base;
  VM.recoilV += base.kick * 46;
  VM.rotV    += base.kickRot * 46;
  VM.flashT = 0.055;
  vmFlash.visible = true;
  vmFlash.rotation.z = rand(0, TAU);
  const s = (base.id === 'shotgun' ? rand(0.68, 0.86) : rand(0.38, 0.52)) * VM_SCALE;
  // colour in the flash, not just a white core — this is what makes the
  // three guns feel like different toys rather than one reskinned box
  vmFlash.children[0].material.color.copy(C(visual.flash || 0xfff0c0));
  vmLight.color.copy(C(visual.flash || 0xffdca8));
  vmFlash.children[0].scale.set(s, s, 1);
}
function vmStartReload(dur) { VM.reloadT = dur; VM.reloadDur = dur; }
/* Dying cancels the reload the actor was running, so the viewmodel must drop
   it too — otherwise a death mid-reload spends the new life's opening moments
   tilting the gun over to swap a magazine that is already full. */
function vmCancelReload() { VM.reloadT = 0; VM.reloadDur = 0; }

function updateViewmodel(dt, st) {
  // recoil spring (critically-damped-ish)
  VM.recoilV += -VM.recoil * 210 * dt;  VM.recoilV *= Math.exp(-13 * dt);  VM.recoil += VM.recoilV * dt;
  VM.rotV    += -VM.rot * 190 * dt;     VM.rotV    *= Math.exp(-12 * dt);  VM.rot    += VM.rotV * dt;

  // walk bob
  const spd = Math.hypot(st.vel.x, st.vel.z);
  const moving = spd > 0.6 && st.onGround;
  VM.bobT += dt * (moving ? (5.6 + spd * 0.85) : 1.6);
  const amp = moving ? Math.min(spd / 8, 1) * 0.020 : 0.0035;
  VM.bob.x = damp(VM.bob.x, Math.cos(VM.bobT) * amp * 1.5, 14, dt);
  VM.bob.y = damp(VM.bob.y, Math.abs(Math.sin(VM.bobT)) * -amp, 14, dt);

  // sway lags the mouse
  VM.swayT.x = damp(VM.swayT.x, clamp(-st.lookDX * 0.9, -0.06, 0.06), 9, dt);
  VM.swayT.y = damp(VM.swayT.y, clamp(-st.lookDY * 0.9, -0.05, 0.05), 9, dt);
  VM.sway.x = damp(VM.sway.x, VM.swayT.x, 11, dt);
  VM.sway.y = damp(VM.sway.y, VM.swayT.y, 11, dt);

  VM.sprint = damp(VM.sprint, (st.sprinting && moving && !st.firing) ? 1 : 0, 9, dt);
  VM.landDip = damp(VM.landDip, 0, 9, dt);
  if (VM.swapT > 0) VM.swapT = Math.max(0, VM.swapT - dt);
  if (VM.reloadT > 0) VM.reloadT = Math.max(0, VM.reloadT - dt);

  const g = vmGuns[VM.cur];
  if (!g) return;

  // base hip pose
  /* Held low-right. pz must clear the gun's own stock (local z up to +0.44
     before scaling) or the breech pokes through the near plane. */
  let px = 0.155, py = -0.098, pz = -0.52;
  let rxB = -0.015, ryB = 0.055;   // slight toe-in so we read the gun's side
  let rx = rxB, ry = ryB, rz = 0;

  // swap dip
  if (VM.swapT > 0) {
    const t = VM.swapT / 0.42;               // 1 -> 0
    const dip = Math.sin(t * Math.PI) * 0.9 + t * t * 0.5;
    py -= dip * 0.30; rx += dip * 0.9; rz += dip * 0.35;
  }
  // reload: tilt the gun over, drop the mag, slap a new one in
  if (VM.reloadT > 0 && VM.reloadDur > 0) {
    const u = 1 - VM.reloadT / VM.reloadDur;              // 0 -> 1
    const swing = Math.sin(clamp(u, 0, 1) * Math.PI);
    py -= swing * 0.14; px -= swing * 0.035; pz += swing * 0.05;
    rx += swing * 0.55; rz += swing * 0.62;
    ry += Math.sin(u * Math.PI * 2) * 0.22;
  }
  // sprint: gun swings across and down
  py -= VM.sprint * 0.10; px += VM.sprint * 0.03; pz += VM.sprint * 0.02;
  ry += VM.sprint * 0.78; rx += VM.sprint * 0.34; rz -= VM.sprint * 0.30;

  // recoil + bob + sway + land dip
  /* Recoil pulls the gun toward the lens. It sits at pz -0.52, so the old
     0.9 multiplier could push it to +0.29 — behind the camera, i.e. the gun
     vanished mid-burst on the harder-kicking weapons. Keep it well clear. */
  pz = Math.min(-0.14, pz + VM.recoil * 0.16);
  py += VM.recoil * 0.30 + VM.bob.y - VM.landDip * 0.12;
  px += VM.bob.x + VM.sway.x;
  py += VM.sway.y;
  rx -= VM.rot;
  rz += VM.sway.x * 2.2 + Math.cos(VM.bobT) * 0.012;
  ry += VM.sway.x * 1.1;
  // idle breathing
  py += Math.sin(performance.now() * 0.0013) * 0.0035;

  g.position.set(px, py, pz);
  g.rotation.set(rx, ry, rz);

  // muzzle flash placement + decay
  if (VM.flashT > 0) {
    VM.flashT -= dt;
    const muz = g.userData.muzzle;
    muz.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(muz.matrixWorld);
    vmFlash.position.copy(p);
    vmFlash.visible = true;
    vmFlash.children[0].material.opacity = clamp(VM.flashT / 0.055, 0, 1);
    vmLight.intensity = clamp(VM.flashT / 0.055, 0, 1) * 2.6;
    vmLight.position.copy(camera.position);
  } else {
    vmFlash.visible = false;
    vmLight.intensity = damp(vmLight.intensity, 0, 20, dt);
  }
}
