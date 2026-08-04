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
   town's own — deepened, not replaced: blush paper and gold leaf, cobalt
   glaze, berry glass, aqua ribbon, caramel rattan. Every skin keeps a wide
   value range (a bright metal against a dark grip), stays clear of the
   mitten tones (0xffe0c8 / 0xfff8f0) so the gun separates from the hands
   holding it, and stays clear of near-black, which belongs to a harsher
   game than this one. skins.test.js enforces all of it.

   Each skin is a different KIND of object rather than a repainted gun, and
   the class silhouette is what survives the change: magazine-forward and
   stubby for the SMG, wide-fronted and heavy for the shotgun, long and lean
   under a raised sight line for the rifle.

   What makes them a different kind of object rather than the same outline
   with more blocks bolted on is that none of them is built from axis-aligned
   boxes. prism() turns a solid about a pivot and tapers one end away, so a
   fold, a curved spout, a barley twist and a drawn glass point are all
   drawable; and quad() takes a colour per corner, so a face can ramp instead
   of sitting flat. A folded sheet of paper, a glazed pot and a rod of blown
   glass are all read from the way light runs across a curve or a crease —
   which is a gradient — so that is where the material lives. */

/* A part's own colour, lit at one end of an axis and shaded at the other:
   the ramp that makes a face read as a surface rather than a painted plane.
   Two multipliers rather than two hexes, so a highlight always belongs to
   the part it highlights and a palette edit carries through every face. */
function skinRamp(hex, hi, lo, axis) {
  return { axis: axis || 'y', from: Cx(hex, hi), to: Cx(hex, lo) };
}

const WEAPON_SKINS = {
  /* FOLDED PAPER CRANE — origami, held. Every surface is a folded sheet:
     the receiver is two gables meeting at a printed gold crease, the wings
     are creased panels standing up off the back, the neck runs down to a
     head with a beak drawn to a single point, and the tail fans up and back
     where a stock would be. Blush washi outside, indigo on the reverse of
     every fold, gold leaf along the cut edges.

     Nothing here is a box. Paper has no flat colour — it has a bright edge
     at the fold and a dark one in the valley, which is why every panel
     carries a ramp rather than a tint; that ramp is the entire difference
     between folded paper and a pink brick.

     Compact and magazine-forward survives intact: the crane's folded keel
     hangs forward and low, raked ahead of the trigger hand, exactly where a
     magazine reads from across a street. */
  'smg-cottoncloud': {
    weapon: 'smg', name: 'Folded Paper Crane',
    col: { body: 0xef8fae, accent: 0x8c7ad6, metal: 0xf2c96e, grip: 0x6b5a86 },
    flash: 0xffc078, tracer: 0xf49ac2,
    muzzle: [0, 0.020, -0.638],
    hands: [[0, -0.120, 0.098], [0, -0.108, -0.178]],
    build(B, P) {
      const { body, acc, met, grip, c } = P;

      // ---- receiver: two gables meeting at the fold, i.e. one folded sheet
      B.prism([-0.070, -0.036, -0.300], [0.070, 0.062, 0.150], body, {
        taperAxis: 'y', taper: [0.30, 0.92], taperEnd: 'max',
        gradient: skinRamp(c.body, 1.20, 0.70)
      });
      B.prism([-0.070, -0.108, -0.284], [0.070, -0.036, 0.132], body, {
        taperAxis: 'y', taper: [0.34, 0.90], taperEnd: 'min',
        gradient: skinRamp(c.body, 0.94, 0.60)
      });
      // the gold-leaf cut edge along the seam where the two folds meet
      B.prism([-0.074, -0.043, -0.286], [0.074, -0.029, 0.134], met, {
        gradient: skinRamp(c.metal, 1.16, 0.84)
      });
      // indigo shows on the reverse of the fold, at the open rear of the sheet
      B.prism([-0.062, -0.070, 0.140], [0.062, 0.048, 0.176], acc, {
        taperAxis: 'z', taper: [0.86, 0.80], taperEnd: 'max',
        gradient: skinRamp(c.accent, 1.14, 0.62)
      });

      /* ---- wings: creased panels stood up off the back, swept and tapered.
         The sheet is dyed on one side only, so the ramp runs between two
         different colours rather than two shades of one — indigo down in the
         valley of the fold, blush out at the lit tip. */
      for (const s of [1, -1]) {
        const x0 = s > 0 ? 0.014 : -0.126, x1 = s > 0 ? 0.126 : -0.014;
        B.prism([x0, 0.042, -0.130], [x1, 0.058, 0.230], acc, {
          rot: [0, -0.30 * s, 1.02 * s], pivot: [0.014 * s, 0.050, 0.020],
          taperAxis: 'x', taper: [0.44, 0.32], taperEnd: s > 0 ? 'max' : 'min',
          gradient: { axis: 'y', from: Cx(c.accent, 0.78), to: Cx(c.body, 1.16) }
        });
      }

      // ---- neck, head, beak: the beak tapers to a single point, and that
      // point is the muzzle. A cone is not something box() could ever draw.
      B.prism([-0.028, -0.006, -0.442], [0.028, 0.054, -0.236], body, {
        rot: [0.18, 0, 0], pivot: [0, 0.024, -0.236],
        taperAxis: 'z', taper: [0.64, 0.70], taperEnd: 'min',
        gradient: skinRamp(c.body, 1.14, 0.72)
      });
      B.prism([-0.030, -0.014, -0.516], [0.030, 0.048, -0.418], body, {
        gradient: skinRamp(c.body, 1.10, 0.66)
      });
      B.prism([-0.026, 0.044, -0.500], [0.026, 0.086, -0.440], acc, {
        taperAxis: 'y', taper: [0.30, 0.44], taperEnd: 'max',
        gradient: skinRamp(c.accent, 1.24, 0.66)
      });                                                                    // folded crest
      B.prism([-0.023, -0.004, -0.638], [0.023, 0.040, -0.502], met, {
        taperAxis: 'z', taper: 0, taperEnd: 'min',
        gradient: { axis: 'z', from: Cx(c.metal, 1.28), to: Cx(c.metal, 0.74) }
      });                                                                    // beak

      // ---- the folded keel, raked forward and low: the magazine read
      const keel = { rot: [0.20, 0, 0], pivot: [0, -0.040, -0.130] };
      B.prism([-0.048, -0.246, -0.240], [0.048, -0.040, -0.020], acc,
        Object.assign({
          taperAxis: 'y', taper: [0.62, 0.78], taperEnd: 'min',
          gradient: skinRamp(c.accent, 1.08, 0.54)
        }, keel));
      B.prism([-0.054, -0.272, -0.222], [0.054, -0.240, -0.038], met,
        Object.assign({ gradient: skinRamp(c.metal, 1.12, 0.78) }, keel));
      B.prism([-0.050, -0.150, -0.256], [0.050, -0.062, -0.208], body,
        Object.assign({ gradient: skinRamp(c.body, 1.12, 0.66) }, keel));     // folded toe

      // ---- tail: a fan that widens and thins as it lifts, standing in for
      // the stock without ever stopping being a tail
      B.prism([-0.050, -0.004, 0.130], [0.050, 0.068, 0.310], body, {
        rot: [-0.34, 0, 0], pivot: [0, 0.032, 0.130],
        taperAxis: 'z', taper: [1.12, 0.46], taperEnd: 'max',
        gradient: { axis: 'z', from: Cx(c.body, 1.16), to: Cx(c.accent, 0.90) }
      });
      B.prism([-0.050, 0.020, 0.296], [0.050, 0.050, 0.312], met, {
        rot: [-0.34, 0, 0], pivot: [0, 0.032, 0.130],
        taperAxis: 'z', taper: [1.10, 0.50], taperEnd: 'max',
        gradient: skinRamp(c.metal, 1.16, 0.76)
      });                                                                    // gilt tail edge

      // ---- handle: another fold, in the indigo of the paper's reverse
      B.prism([-0.042, -0.218, 0.052], [0.042, -0.010, 0.172], grip, {
        rot: [0.14, 0, 0], pivot: [0, -0.010, 0.112],
        taperAxis: 'y', taper: [0.74, 0.92], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.36, 0.74)
      });
      B.prism([-0.046, -0.088, 0.048], [0.046, -0.052, 0.176], met, {
        rot: [0.14, 0, 0], pivot: [0, -0.010, 0.112],
        gradient: skinRamp(c.metal, 1.10, 0.80)
      });                                                                    // gold band
    }
  },
  /* COBALT WILLOW TEAPOT — glazed porcelain and gilt, off a different shelf
     entirely. The receiver is a thrown pot: a belly that swells out of a
     narrow foot and draws back in at the shoulder, a domed lid with a
     faceted gold finial, and a gilt band round the equator. The mouth is a
     poured spout that lifts and flares to a gold-rimmed lip, and the stock
     is the pot's handle — a real open loop you can see the street through.

     Glaze is the whole material argument. A curved glazed surface is dark
     where it turns away and bright along the shoulder, so every part of the
     pot ramps from one to the other; the taper supplies the curve and the
     ramp supplies the glaze, and neither alone would read as porcelain.

     Wide and heavy-fronted is untouched: the pot is the fattest receiver of
     the three, and the spout lip is the widest thing on any of them at
     0.28 across. That flare IS the scattergun read — nothing may narrow it. */
  'shotgun-toastedmallow': {
    weapon: 'shotgun', name: 'Cobalt Willow Teapot',
    col: { body: 0x7885dd, accent: 0xa8baf0, metal: 0xf5cf7a, grip: 0x8a6444 },
    flash: 0xffd489, tracer: 0x97a9f0,
    muzzle: [0, 0.058, -0.612],
    hands: [[0, -0.115, 0.128], [0, -0.150, -0.190]],
    build(B, P) {
      const { body, acc, met, grip, c } = P;

      // ---- the thrown pot: out of the foot, round the belly, in at the
      // shoulder. Two tapers back to back is a profile, not a box.
      B.prism([-0.104, -0.132, -0.300], [0.104, -0.010, 0.130], body, {
        taperAxis: 'y', taper: [0.58, 0.72], taperEnd: 'min',
        gradient: skinRamp(c.body, 1.02, 0.56)
      });
      B.prism([-0.104, -0.010, -0.300], [0.104, 0.098, 0.130], body, {
        taperAxis: 'y', taper: [0.70, 0.84], taperEnd: 'max',
        gradient: skinRamp(c.body, 1.26, 0.86)
      });
      B.prism([-0.109, -0.021, -0.306], [0.109, 0.001, 0.136], met, {
        gradient: skinRamp(c.metal, 1.18, 0.80)
      });                                                                    // gilt equator
      // painted panels, the willow the thing is named for
      for (const s of [1, -1]) {
        const x0 = s > 0 ? 0.100 : -0.113, x1 = s > 0 ? 0.113 : -0.100;
        B.prism([x0, -0.076, -0.170], [x1, 0.042, 0.020], acc, {
          taperAxis: 'x', taper: [0.86, 0.82], taperEnd: s > 0 ? 'max' : 'min',
          gradient: skinRamp(c.accent, 1.16, 0.72)
        });
      }
      B.prism([-0.068, -0.156, -0.248], [0.068, -0.126, 0.074], grip, {
        taperAxis: 'y', taper: [0.94, 0.94], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.30, 0.84)
      });                                                                    // foot ring

      // ---- lid and finial. The finial is a cube turned an eighth turn, so
      // it stands as a gold diamond and not another little box.
      B.prism([-0.078, 0.098, -0.238], [0.078, 0.110, 0.078], met, {
        gradient: skinRamp(c.metal, 1.20, 0.88)
      });
      B.prism([-0.072, 0.110, -0.228], [0.072, 0.158, 0.068], body, {
        taperAxis: 'y', taper: [0.28, 0.32], taperEnd: 'max',
        gradient: skinRamp(c.body, 1.32, 0.94)
      });
      B.prism([-0.026, 0.152, -0.106], [0.026, 0.200, -0.054], met, {
        rot: [0, 0.785, 0],
        gradient: skinRamp(c.metal, 1.26, 0.82)
      });

      // ---- the spout: it lifts as it pours and flares to a gilt lip
      const lift = { rot: [0.16, 0, 0], pivot: [0, 0.009, -0.275] };
      B.prism([-0.072, -0.040, -0.436], [0.072, 0.058, -0.275], body,
        Object.assign({
          taperAxis: 'z', taper: [1.30, 1.22], taperEnd: 'min',
          gradient: skinRamp(c.body, 1.12, 0.70)
        }, lift));
      const pour = { rot: [0.30, 0, 0], pivot: [0, 0.009, -0.425] };
      B.prism([-0.100, -0.060, -0.576], [0.100, 0.078, -0.425], body,
        Object.assign({
          taperAxis: 'z', taper: [1.36, 1.20], taperEnd: 'min',
          gradient: skinRamp(c.body, 1.24, 0.76)
        }, pour));
      B.prism([-0.140, -0.072, -0.606], [0.140, 0.092, -0.560], met,
        Object.assign({
          taperAxis: 'z', taper: [1.02, 1.02], taperEnd: 'min',
          gradient: skinRamp(c.metal, 1.24, 0.78)
        }, pour));                                                           // lip, 0.28 across
      B.prism([-0.108, -0.052, -0.596], [0.108, 0.070, -0.566], acc,
        Object.assign({ gradient: skinRamp(c.accent, 1.10, 0.58) }, pour));  // glazed throat
      B.prism([-0.015, 0.076, -0.548], [0.015, 0.112, -0.508], met,
        Object.assign({
          taperAxis: 'y', taper: [0.34, 0.60], taperEnd: 'max',
          gradient: skinRamp(c.metal, 1.28, 0.86)
        }, pour));                                                           // gilt bead sight

      // ---- the handle, which is the stock. The stock is the nearest and
      // largest thing on screen in first person, so it wears the glaze, and
      // the caramel rattan stays a wrap rather than a slab.
      const up = { rot: [-0.36, 0, 0], pivot: [0, 0.087, 0.080] };
      B.prism([-0.050, 0.062, 0.080], [0.050, 0.112, 0.292], body,
        Object.assign({ gradient: skinRamp(c.body, 1.22, 0.84) }, up));
      for (const z of [0.150, 0.232]) {
        B.prism([-0.053, 0.058, z], [0.053, 0.116, z + 0.030], grip,
          Object.assign({ gradient: skinRamp(c.grip, 1.34, 0.86) }, up));    // rattan wrap
      }
      B.prism([-0.048, -0.030, 0.296], [0.048, 0.176, 0.362], body, {
        rot: [0.20, 0, 0], pivot: [0, 0.073, 0.330],
        taperAxis: 'z', taper: [0.92, 1.00], taperEnd: 'max',
        gradient: skinRamp(c.body, 1.14, 0.68)
      });                                                                    // the bend
      B.prism([-0.046, -0.062, 0.150], [0.046, -0.012, 0.330], body, {
        rot: [0.26, 0, 0], pivot: [0, -0.037, 0.330],
        gradient: skinRamp(c.body, 0.98, 0.62)
      });                                                                    // lower arm
      B.prism([-0.052, -0.074, 0.336], [0.052, 0.004, 0.372], met, {
        rot: [0.26, 0, 0], pivot: [0, -0.037, 0.330],
        gradient: skinRamp(c.metal, 1.16, 0.78)
      });                                                                    // gilt ferrule

      // ---- trigger grip and the warming stand the front hand rides on
      B.prism([-0.046, -0.202, 0.068], [0.046, -0.020, 0.192], grip, {
        rot: [0.16, 0, 0], pivot: [0, -0.020, 0.130],
        taperAxis: 'y', taper: [0.80, 0.90], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.36, 0.78)
      });
      B.prism([-0.050, -0.084, 0.062], [0.050, -0.046, 0.196], met, {
        rot: [0.16, 0, 0], pivot: [0, -0.020, 0.130],
        gradient: skinRamp(c.metal, 1.12, 0.82)
      });
      B.prism([-0.062, -0.190, -0.292], [0.062, -0.104, -0.088], grip, {
        taperAxis: 'y', taper: [0.78, 0.88], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.28, 0.74)
      });
      B.prism([-0.070, -0.152, -0.302], [0.070, -0.126, -0.078], met, {
        gradient: skinRamp(c.metal, 1.14, 0.84)
      });
    }
  },
  /* TWISTED GLASS CANE — a Victorian glass friendship cane, drawn out on a
     rod and twisted while it was still soft. The whole gun is one shaft: six
     segments, each rolled a third of a turn past the one behind it, so the
     inked corners wind down the length as a barley twist and an aqua ribbon
     spirals through the berry glass with them. It ends in a collar turned on
     the diagonal and a tip drawn to a point; a gathered gob of glass hangs
     under the middle with the drip still on it, and the stock is the cane's
     crook — back, up, over and down again.

     A twist is the one thing an axis-aligned box could not fake at any block
     count, and it is what makes this glass rather than a purple tube. The
     glass tones stay deep on purpose: a pale rod is the failure the pale
     surfaces of this town punish, and berry is what survives being seen
     against a cream porch.

     Long and lean under a raised sight line, exactly as before: the sight is
     a glass rail on two pillars, with a diamond blade up front and a notch at
     the back, and you look along it. */
  'rifle-berryswirl': {
    weapon: 'rifle', name: 'Twisted Glass Cane',
    col: { body: 0xb865a6, accent: 0x74c9d2, metal: 0xd9c4f2, grip: 0x6d5288 },
    flash: 0xf5a8e4, tracer: 0xd47ad4,
    muzzle: [0, 0.010, -0.965],
    hands: [[0, -0.105, 0.150], [0, -0.030, -0.300]],
    build(B, P) {
      const { body, acc, met, grip, c } = P;
      const AX = 0.010;                                    // the shaft's axis

      /* ---- the twist. Each segment carries the phase of the one behind it
         plus about a third of a turn, and the ribbon rides the same rotation,
         so it winds instead of running straight. The ribbon is drawn without
         ink: six segments of inked outline is the twist, and inking the
         ribbon as well turns a spiral into a scribble at viewmodel scale. */
      const SEG = 6, LEN = 0.170;
      for (let i = 0; i < SEG; i++) {
        const z0 = -0.900 + i * LEN, z1 = z0 + LEN;
        const spin = { rot: [0, 0, i * 0.55], pivot: [0, AX, 0] };
        const w = 0.038 + i * 0.0022;                      // thickens toward the hand
        B.prism([-w, AX - w, z0], [w, AX + w, z1], body,
          Object.assign({ gradient: skinRamp(c.body, 1.26, 0.58) }, spin));
        for (const s of [1, -1]) {
          const x0 = s > 0 ? w - 0.008 : -(w + 0.013), x1 = s > 0 ? w + 0.013 : -(w - 0.008);
          B.prism([x0, AX - 0.013, z0 + 0.006], [x1, AX + 0.013, z1 - 0.006], acc,
            Object.assign({ noEdge: true, gradient: skinRamp(c.accent, 1.24, 0.66) }, spin));
        }
      }

      // ---- the drawn tip: a collar on the diagonal, then glass pulled to a
      // point. taper 0 is a cone, and a cone is where the flash leaves.
      B.prism([-0.046, AX - 0.046, -0.906], [0.046, AX + 0.046, -0.856], acc, {
        rot: [0, 0, 0.785], pivot: [0, AX, -0.881],
        gradient: skinRamp(c.accent, 1.28, 0.62)
      });
      B.prism([-0.030, AX - 0.028, -0.965], [0.030, AX + 0.028, -0.896], met, {
        taperAxis: 'z', taper: 0.30, taperEnd: 'min',
        gradient: { axis: 'z', from: Cx(c.metal, 1.28), to: Cx(c.body, 0.90) }
      });

      // ---- the sight line: rail on two pillars, diamond blade, rear notch
      for (const z of [-0.318, 0.032]) {
        B.prism([-0.015, AX + 0.028, z], [0.015, 0.092, z + 0.048], met, {
          taperAxis: 'y', taper: [0.66, 0.66], taperEnd: 'max',
          gradient: skinRamp(c.metal, 1.18, 0.70)
        });
      }
      B.prism([-0.021, 0.092, -0.328], [0.021, 0.118, 0.098], met, {
        gradient: skinRamp(c.metal, 1.22, 0.78)
      });
      B.prism([-0.032, 0.110, -0.360], [0.032, 0.174, -0.330], acc, {
        rot: [0, 0, 0.785], pivot: [0, 0.142, -0.345],
        gradient: skinRamp(c.accent, 1.30, 0.62)
      });                                                                    // blade
      for (const s of [1, -1]) {
        const x0 = s > 0 ? 0.013 : -0.040, x1 = s > 0 ? 0.040 : -0.013;
        B.prism([x0, 0.118, 0.062], [x1, 0.166, 0.096], acc, {
          taperAxis: 'y', taper: [0.70, 0.84], taperEnd: 'max',
          gradient: skinRamp(c.accent, 1.22, 0.66)
        });
      }                                                                      // notch
      B.prism([-0.034, 0.112, -0.166], [0.034, 0.176, -0.102], body, {
        rot: [0, 0, 0.785], pivot: [0, 0.144, -0.134],
        gradient: { axis: 'y', from: Cx(c.body, 0.72), to: Cx(c.metal, 1.22) }
      });                                                                    // glass bead

      // ---- the gathered gob, with the drip still hanging off it
      B.prism([-0.044, -0.196, -0.086], [0.044, -0.006, 0.086], grip, {
        taperAxis: 'y', taper: [0.42, 0.50], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.44, 0.76)
      });
      B.prism([-0.020, -0.248, -0.038], [0.020, -0.190, 0.038], body, {
        taperAxis: 'y', taper: 0, taperEnd: 'min',
        gradient: skinRamp(c.body, 1.14, 0.56)
      });

      // ---- fore collar, turned on the diagonal, where the front hand sits
      B.prism([-0.056, AX - 0.052, -0.372], [0.056, AX + 0.052, -0.246], met, {
        rot: [0, 0, 0.785], pivot: [0, AX, -0.309],
        gradient: skinRamp(c.metal, 1.24, 0.60)
      });
      B.prism([-0.046, AX - 0.042, -0.384], [0.046, AX + 0.042, -0.366], acc, {
        rot: [0, 0, 0.785], pivot: [0, AX, -0.309],
        gradient: skinRamp(c.accent, 1.20, 0.70)
      });

      // ---- grip
      B.prism([-0.044, -0.206, 0.098], [0.044, -0.010, 0.214], grip, {
        rot: [0.12, 0, 0], pivot: [0, -0.010, 0.156],
        taperAxis: 'y', taper: [0.76, 0.88], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.42, 0.74)
      });
      B.prism([-0.048, -0.092, 0.094], [0.048, -0.048, 0.218], acc, {
        rot: [0.12, 0, 0], pivot: [0, -0.010, 0.156],
        gradient: skinRamp(c.accent, 1.16, 0.72)
      });

      // ---- the crook: back, up, over and down again, the way a cane ends
      B.prism([-0.042, -0.024, 0.110], [0.042, 0.062, 0.368], body, {
        rot: [-0.13, 0, 0], pivot: [0, 0.019, 0.110],
        taperAxis: 'z', taper: [0.90, 0.86], taperEnd: 'max',
        gradient: skinRamp(c.body, 1.22, 0.66)
      });
      B.prism([-0.038, 0.030, 0.348], [0.038, 0.152, 0.424], body, {
        rot: [0.36, 0, 0], pivot: [0, 0.058, 0.352],
        taperAxis: 'y', taper: [0.90, 0.94], taperEnd: 'max',
        gradient: skinRamp(c.body, 1.30, 0.78)
      });
      B.prism([-0.036, -0.070, 0.404], [0.036, 0.066, 0.468], grip, {
        rot: [0.22, 0, 0], pivot: [0, 0.000, 0.418],
        taperAxis: 'y', taper: [0.70, 0.80], taperEnd: 'min',
        gradient: skinRamp(c.grip, 1.36, 0.74)
      });
      /* The shoulder end is the nearest and largest face on screen, so it
         wears the deep plum: the pale glass that suits a rail this close to
         the lens is the tone that disappears into the mitten holding it. */
      B.prism([-0.046, -0.078, 0.452], [0.046, 0.096, 0.492], grip, {
        taperAxis: 'z', taper: [0.86, 0.86], taperEnd: 'max',
        gradient: { axis: 'y', from: Cx(c.grip, 0.86), to: Cx(c.body, 1.10) }
      });                                                                    // shoulder end
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
