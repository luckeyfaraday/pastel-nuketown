/* =====================================================================
   PASTEL NUKETOWN — characters: chunky cartoon bots, animated by hand
   No skeletons, no clips: a few pivots driven by speed / aim / state.
   ===================================================================== */

/* proportions — the hitboxes in 30-physics.js reference HIT, keep in sync */
const CH = {
  legTop: 0.74, torsoTop: 1.40, headC: 1.60, headR: 0.235,
  shoulder: 1.28, armLen: 0.50, hipW: 0.115, legW: 0.155
};

/* =====================================================================
   THE THREE PURCHASABLE CHARACTERS
   Each id is its own creature, not a recolour: a fox, a knight in plate and
   a little robot. Hit detection is analytic (30-physics.js castRayActors:
   sphere at HIT.headY 1.60 r .30, capsule r HIT.bodyR .36) and reads no
   mesh, so shape is free — but a character that is bigger or smaller than
   the default is a character that lies about where the bullets go. So every
   one of them is built inside the DEFAULT'S OWN ENVELOPE:

     measured by characters.test.js, gun excluded, in metres
                        default   fox    knight  robot
       height            1.890   1.890   1.890   1.890
       max |x|           0.388   0.388   0.388   0.388  (the arms, all four)
       max |x| no arms   0.282   0.270   0.285   0.282
       forward  -z       0.350   0.350   0.330   0.315
       rearward +z       0.257   0.245   0.245   0.246
       max radial        0.433   0.398   0.399   0.398
       torso half-width  0.250   0.255   0.250   0.250
       torso half-depth  0.255   0.245   0.245   0.246
       head half-width   0.265   0.265   0.265   0.265

   Nothing reaches further than the default in any horizontal direction, so
   nobody is seen around a corner first; and nothing is thinner than it
   either — every torso still fills the r=.36 capsule about as well as the
   default's does, so hits keep landing where they look like they land.
   Head mass stays centred on the sphere at y 1.60 in all four. (The one
   place the default is bigger is its cap brim, which owns both its -.350
   forward reach and its .433 diagonal; a helm and a snout reach nearly as
   far, a visor stops 3.5 cm short. None of it is torso mass.)

   Team readability: the jersey (colors.body / colors.trim) keeps the torso
   core and the sleeves on every character — the two biggest surfaces you
   read at range — plus the knight's pauldrons and the thighs the fox and
   the robot do not armour. A skin only owns what makes it that creature: head,
   ears, tail, plate, shell. characters.test.js measures the jersey's share
   of that surface and holds it above half — it comes out at torso/arms
   56%/59% for the fox, 64%/56% for the knight and 59%/56% for the robot.
   ===================================================================== */
const CHARACTER_SKINS = {
  'char-midnight': {
    name: 'Midnight',
    col: { shell: 0x8f9bd6, deep: 0x5f679c, dark: 0x3d3856,
           glow: 0xa9f5e4, lens: 0x2f2b44 }
  },
  'char-sherbetfox': {
    name: 'Sherbet Fox',
    col: { fur: 0xf6a768, deep: 0xdd8352, cream: 0xfff2d6,
           nose: 0x574a66, eye: 0xfffdf8, pupil: 0x4a3f5c, mouth: 0xe8a0a8 }
  },
  'char-cloudknight': {
    name: 'Cloud Knight',
    col: { plate: 0xf7fbff, shade: 0xc6dcf0, gold: 0xffd9a8,
           visor: 0x40395a, glow: 0xa9ecff }
  }
};

/* Every character is the same seven pivots (torso, head, two legs, two arms,
   gun) so the hand animation in animateCharacter drives all of them, and so
   nine of them on a phone still cost what one costs today: a skin swaps the
   four builders below, it never adds a mesh. Anything that has to follow a
   limb — a pauldron, a paw — is built into that limb's own builder. */
const DEFAULT_PARTS = {
  torso(B, p) {
    B.box([-0.235, CH.legTop - 0.06, -0.145], [0.235, CH.torsoTop, 0.145], p.cB, { top: p.cTop });
    B.box([-0.245, CH.torsoTop - 0.10, -0.155], [0.245, CH.torsoTop, 0.155], p.cT);        // collar
    B.box([-0.165, CH.legTop + 0.10, 0.145], [0.165, CH.torsoTop - 0.12, 0.255], p.cD);    // backpack
    B.box([-0.10, CH.legTop + 0.16, -0.16], [0.10, CH.legTop + 0.30, -0.145], p.cT);       // chest badge
    B.box([-0.25, CH.legTop - 0.10, -0.15], [0.25, CH.legTop + 0.02, 0.15], p.cT);         // belt
  },
  head(B, p) {
    const r = CH.headR;
    B.box([-r, -r, -r], [r, r, r], p.skin, { top: p.skinTop });
    B.box([-r - 0.022, r - 0.03, -r - 0.022], [r + 0.022, r + 0.055, r + 0.022], p.cT);   // cap
    B.box([-r - 0.02, r - 0.055, -r - 0.115], [r + 0.02, r + 0.012, -r + 0.01], p.cT);    // brim
    for (const s of [-1, 1]) {                                                            // eyes
      B.box([s * 0.075 - 0.048, -0.015, -r - 0.012], [s * 0.075 + 0.048, 0.075, -r + 0.01], C(0xfffdf8));
      B.box([s * 0.075 - 0.024, 0.005, -r - 0.024], [s * 0.075 + 0.024, 0.052, -r - 0.006], C(0x4a3f5c));
    }
    B.box([-0.055, -0.115, -r - 0.014], [0.055, -0.085, -r + 0.005], C(0xe8a0a8));       // mouth
    B.box([-r - 0.03, -0.06, -0.05], [-r, 0.03, 0.05], p.skin);                          // ears
    B.box([r, -0.06, -0.05], [r + 0.03, 0.03, 0.05], p.skin);
  },
  leg(B, p) {
    B.box([-CH.legW, -CH.legTop + 0.10, -0.10], [CH.legW, 0, 0.10], p.cD);
    B.box([-CH.legW - 0.012, -CH.legTop, -0.145], [CH.legW + 0.012, -CH.legTop + 0.14, 0.115], p.boot);
  },
  arm(B, p) {
    B.box([-0.088, -CH.armLen + 0.10, -0.088], [0.088, 0, 0.088], p.cB);
    B.box([-0.075, -CH.armLen + 0.06, -0.075], [0.075, -CH.armLen + 0.14, 0.075], p.cT);   // cuff
    B.box([-0.082, -CH.armLen, -0.082], [0.082, -CH.armLen + 0.075, 0.082], p.skin);       // mitt
  }
};

/* ---------------------------------------------------------------------
   SHERBET FOX — a fox standing where the person was.
   The read is snout + tall ears + brush tail: the muzzle takes the head's
   forward volume the cap's brim used to (-.350, exactly the default), the
   ears take its height (1.890, exactly the default), and the tail sweeps up
   the back inside the backpack's old rear volume (+.245 against +.255).
   Legs are digitigrade — thigh, angled shank, long paw — which changes the
   walk's silhouette without moving a single pivot.
   --------------------------------------------------------------------- */
const FOX_PARTS = {
  torso(B, p) {
    const a = p.a;
    B.box([-0.235, CH.legTop - 0.06, -0.145], [0.235, CH.torsoTop, 0.145], p.cB, { top: p.cTop });
    B.box([-0.25, CH.legTop - 0.10, -0.15], [0.25, CH.legTop + 0.04, 0.15], p.cT);        // belt
    B.box([-0.09, CH.legTop + 0.12, -0.156], [0.09, CH.torsoTop - 0.16, -0.145], p.cT);   // jersey placket
    /* Chest fluff + neck ruff: the fur reads as fur where it meets the head,
       but stops at the collar line so the jersey keeps the whole chest. */
    B.box([-0.255, CH.torsoTop - 0.11, -0.165], [0.255, CH.torsoTop, 0.165], a.cream);
    B.box([-0.13, CH.torsoTop - 0.30, -0.175], [0.13, CH.torsoTop - 0.08, -0.145], a.cream);
    B.box([-0.20, CH.torsoTop - 0.05, -0.15], [0.20, CH.torsoTop + 0.045, 0.15], a.fur);  // shoulders
    /* Brush tail, three tapering blocks rising up the back. Rearmost face
       +.245, inside the default backpack's +.255; widest corner is
       sqrt(.135^2 + .245^2) = .280 radial, under HIT.bodyR = .36. */
    B.box([-0.135, CH.legTop - 0.04, 0.135], [0.135, CH.legTop + 0.20, 0.245], a.fur);
    B.box([-0.125, CH.legTop + 0.16, 0.145], [0.105, CH.legTop + 0.42, 0.24], a.fur);
    B.box([-0.105, CH.legTop + 0.38, 0.15], [0.075, CH.legTop + 0.56, 0.23], a.cream);
  },
  head(B, p) {
    const a = p.a;
    /* Skull is wider than it is tall — a fox's head, not a cube. Corner
       radial sqrt(.215^2 + .205^2) = .297, matching the default's .303. */
    B.box([-0.215, -0.185, -0.145], [0.215, 0.165, 0.205], a.fur, { top: Cx(0xf6a768, 1.04) });
    B.box([-0.19, -0.20, -0.12], [0.19, -0.13, 0.17], a.deep);                            // jaw shade
    // muzzle: two steps out to the nose, tip at -.350 = the default brim
    B.box([-0.105, -0.165, -0.29], [0.105, -0.015, -0.135], a.cream);
    B.box([-0.072, -0.15, -0.335], [0.072, -0.045, -0.285], a.cream);
    B.box([-0.056, -0.135, -0.35], [0.056, -0.06, -0.32], a.nose);                        // nose
    B.box([-0.038, -0.168, -0.30], [0.038, -0.148, -0.24], a.mouth);                      // mouth
    for (const s of [-1, 1]) {                                                            // eyes
      B.box([s * 0.115 - 0.055, 0.0, -0.16], [s * 0.115 + 0.055, 0.085, -0.14], a.eye);
      B.box([s * 0.115 - 0.028, 0.018, -0.172], [s * 0.115 + 0.028, 0.066, -0.152], a.pupil);
      // cheek ruff, flaring back behind the eye — .265 wide, the same as the default's ears
      B.box([s * 0.24 - 0.025, -0.145, -0.015], [s * 0.24 + 0.025, 0.085, 0.155], a.cream);
      /* Ears: the skull stops at +.165 so that three tapering steps of ear
         stand 12 cm clear of it, leaning outward as they rise to +.290 —
         i.e. 1.890, the default cap's exact height. Widest face |x| = .220. */
      B.box([s * 0.135 - 0.085, 0.075, -0.055], [s * 0.135 + 0.085, 0.205, 0.09], a.fur);
      B.box([s * 0.155 - 0.06, 0.195, -0.04], [s * 0.155 + 0.06, 0.255, 0.075], a.fur);
      B.box([s * 0.17 - 0.035, 0.245, -0.025], [s * 0.17 + 0.035, 0.29, 0.06], a.deep);
      B.box([s * 0.14 - 0.05, 0.10, -0.065], [s * 0.14 + 0.05, 0.25, -0.05], a.cream);
    }
  },
  leg(B, p) {
    const a = p.a;
    B.box([-CH.legW, -0.30, -0.075], [CH.legW, 0.02, 0.125], p.cD);                       // thigh
    B.box([-0.115, -0.60, -0.115], [0.115, -0.27, 0.085], a.fur);                         // shank
    B.box([-0.125, -0.66, -0.10], [0.125, -0.56, 0.06], a.deep);                          // hock
    B.box([-0.135, -CH.legTop, -0.195], [0.135, -0.60, 0.065], a.fur);                    // paw
    B.box([-0.135, -CH.legTop, -0.195], [0.135, -0.685, -0.105], a.cream);                // toes
  },
  arm(B, p) {
    const a = p.a;
    B.box([-0.088, -CH.armLen + 0.075, -0.088], [0.088, 0.015, 0.088], p.cB);             // jersey sleeve
    B.box([-0.078, -CH.armLen + 0.055, -0.078], [0.078, -CH.armLen + 0.145, 0.078], a.cream); // fur cuff
    B.box([-0.085, -CH.armLen, -0.085], [0.085, -CH.armLen + 0.08, 0.085], a.fur);        // paw
    B.box([-0.085, -CH.armLen, -0.085], [0.085, -CH.armLen + 0.03, 0.0], a.cream);        // pads
  }
};

/* ---------------------------------------------------------------------
   CLOUD KNIGHT — a suit of plate with nobody's face in it.
   The helm replaces the head entirely: no skin, no eyes, a dark visor slit
   with a cold glow behind it, and a crest that takes the cap's height
   (1.890). The jersey survives as a tabard down the front and a short cape
   at the back, which is what keeps nine knights apart at range. The cuisses
   ride on the legs and the pauldrons on the arms, so plate follows the limb
   it belongs to instead of clipping through it.
   --------------------------------------------------------------------- */
const KNIGHT_PARTS = {
  torso(B, p) {
    const a = p.a;
    B.box([-0.235, CH.legTop - 0.06, -0.145], [0.235, CH.torsoTop, 0.145], p.cB, { top: p.cTop });
    B.box([-0.25, CH.torsoTop - 0.14, -0.16], [0.25, CH.torsoTop, 0.16], a.plate);        // gorget
    B.box([-0.235, CH.torsoTop - 0.155, -0.155], [0.235, CH.torsoTop - 0.115, 0.155], a.shade);
    // side plates: 1.5 cm proud of the jersey, so |x| .250 against the default collar's .245
    for (const s of [-1, 1]) {
      B.box([s * 0.2425 - 0.0075, CH.legTop + 0.10, -0.13], [s * 0.2425 + 0.0075, CH.torsoTop - 0.16, 0.13], a.plate);
    }
    B.box([-0.075, CH.legTop + 0.02, -0.157], [0.075, CH.torsoTop - 0.08, -0.145], p.cT); // tabard stripe
    B.box([-0.065, CH.legTop + 0.30, -0.168], [0.065, CH.legTop + 0.42, -0.152], a.gold); // heraldry
    B.box([-0.25, CH.legTop - 0.10, -0.155], [0.25, CH.legTop + 0.03, 0.155], p.cT);      // belt
    B.box([-0.07, CH.legTop - 0.085, -0.166], [0.07, CH.legTop + 0.015, -0.15], a.gold);  // buckle
    /* Cape in the team trim: the largest rear surface on the character and
       the reason a knight still reads as your colour from behind. Rearmost
       face +.245 against the default backpack's +.255. */
    B.box([-0.215, CH.legTop + 0.24, 0.145], [0.215, CH.torsoTop - 0.055, 0.215], p.cT);
    B.box([-0.235, CH.legTop + 0.12, 0.15], [0.235, CH.legTop + 0.30, 0.245], p.cT);
    B.box([-0.235, CH.torsoTop - 0.10, 0.14], [0.235, CH.torsoTop - 0.02, 0.20], a.plate); // cape clasp
  },
  head(B, p) {
    const a = p.a;
    /* Helm. Same volume the head + cap occupied: |x| max .265 (cheek wings)
       against the default ear's .265, front -.325 against the brim's -.350. */
    B.box([-0.225, -0.20, -0.215], [0.225, 0.20, 0.215], a.plate, { top: Cx(0xf7fbff, 1.03) });
    B.box([-0.235, 0.115, -0.225], [0.235, 0.185, 0.225], a.shade);                       // crown band
    B.box([-0.195, -0.245, -0.19], [0.195, -0.185, 0.18], a.shade);                       // chin
    B.box([-0.185, -0.06, -0.245], [0.185, 0.05, -0.20], a.visor);                        // visor slit
    for (const s of [-1, 1])                                                              // the cold light behind it
      B.box([s * 0.095 - 0.038, -0.035, -0.255], [s * 0.095 + 0.038, 0.025, -0.235], a.glow);
    B.box([-0.032, -0.055, -0.25], [0.032, 0.13, -0.205], a.shade);                       // nasal bar
    /* Beaked bascinet: the muzzle under the visor is what carries the helm
       forward to -.330, just inside the default cap brim's -.350. */
    B.box([-0.115, -0.225, -0.30], [0.115, -0.05, -0.185], a.plate);
    B.box([-0.085, -0.20, -0.325], [0.085, -0.075, -0.29], a.plate);
    for (const s of [-1, 1])                                                              // breath slots
      B.box([s * 0.045 - 0.018, -0.185, -0.33], [s * 0.045 + 0.018, -0.095, -0.30], a.visor);
    for (const s of [-1, 1])                                                              // cheek wings
      B.box([s * 0.245 - 0.02, -0.135, -0.09], [s * 0.245 + 0.02, 0.09, 0.115], a.shade);
    /* Crest, front to back over the crown, topping out at +.290 = 1.890. */
    B.box([-0.048, 0.19, -0.165], [0.048, 0.255, 0.165], a.gold);
    B.box([-0.034, 0.245, -0.10], [0.034, 0.29, 0.13], a.gold);
    B.box([-0.034, 0.13, 0.19], [0.034, 0.255, 0.245], a.gold);                           // crest tail
  },
  leg(B, p) {
    const a = p.a;
    B.box([-CH.legW, -CH.legTop + 0.10, -0.10], [CH.legW, 0, 0.10], p.cD);                // jersey hose
    B.box([-0.17, -0.16, -0.125], [0.17, 0.03, 0.125], a.plate);                          // cuisse
    B.box([-0.16, -0.20, -0.115], [0.16, -0.145, 0.115], a.shade);
    B.box([-0.155, -0.44, -0.115], [0.155, -0.30, 0.115], a.plate);                       // knee cop + greave
    B.box([-0.14, -0.60, -0.11], [0.14, -0.42, 0.11], a.shade);
    B.box([-CH.legW - 0.012, -CH.legTop, -0.175], [CH.legW + 0.012, -CH.legTop + 0.135, 0.115], a.plate); // sabaton
    B.box([-CH.legW - 0.012, -CH.legTop, -0.175], [CH.legW + 0.012, -CH.legTop + 0.05, -0.10], a.shade);
  },
  arm(B, p, isRight) {
    const a = p.a;
    B.box([-0.088, -CH.armLen + 0.14, -0.088], [0.088, 0.02, 0.088], p.cB);               // jersey sleeve
    /* Pauldron: it grows upward over the shoulder rather than outward, so the
       arm's reach stays the default's — |x| .388, corner radial .398. It is
       painted in the team's trim, which is what a knight's livery would be
       and what keeps two knights on two teams apart from the side. */
    const x0 = isRight ? -0.05 : -0.088, x1 = isRight ? 0.088 : 0.05;
    B.box([x0, -0.115, -0.095], [x1, 0.10, 0.095], p.cT);
    B.box([x0 + 0.012, 0.085, -0.078], [x1 - 0.012, 0.15, 0.078], a.shade);
    B.box([-0.082, -0.30, -0.082], [0.082, -0.22, 0.082], a.shade);                       // couter
    B.box([-0.085, -CH.armLen + 0.045, -0.085], [0.085, -CH.armLen + 0.15, 0.085], a.plate); // gauntlet
    B.box([-0.082, -CH.armLen, -0.082], [0.082, -CH.armLen + 0.075, 0.082], a.shade);     // fist
  }
};

/* ---------------------------------------------------------------------
   MIDNIGHT — a small toy robot in the team's colours.
   No face at all: a wraparound visor with one mint light behind it, a
   crown antenna to the default's exact height (1.890), and a vent pack on
   the back where the default's satchel was (+.235 against +.255). The
   chassis is jersey-painted, the shell is the store card's own indigo.
   --------------------------------------------------------------------- */
const ROBOT_PARTS = {
  torso(B, p) {
    const a = p.a;
    B.box([-0.235, CH.legTop - 0.06, -0.145], [0.235, CH.torsoTop, 0.145], p.cB, { top: p.cTop });
    B.box([-0.25, CH.torsoTop - 0.12, -0.155], [0.25, CH.torsoTop, 0.155], a.deep);       // shoulder yoke
    for (const s of [-1, 1])                                                              // chassis rails
      B.box([s * 0.2425 - 0.0075, CH.legTop + 0.06, -0.135], [s * 0.2425 + 0.0075, CH.torsoTop - 0.14, 0.135], a.shell);
    B.box([-0.10, CH.legTop + 0.30, -0.16], [0.10, CH.legTop + 0.48, -0.145], a.shell);   // core housing
    B.box([-0.062, CH.legTop + 0.325, -0.172], [0.062, CH.legTop + 0.455, -0.155], a.glow); // core light
    B.box([-0.235, CH.legTop + 0.20, -0.152], [0.235, CH.legTop + 0.245, 0.152], p.cD);   // panel seam
    B.box([-0.25, CH.legTop - 0.10, -0.15], [0.25, CH.legTop + 0.04, 0.15], p.cT);        // hip band
    B.box([-0.175, CH.legTop - 0.14, -0.12], [0.175, CH.legTop - 0.02, 0.12], p.cD);      // waist actuator
    /* Vent pack, two stacks either side of the spine. Rearmost +.245,
       inside the default backpack's +.255; corner sqrt(.20^2 + .245^2) =
       .316, against the default backpack corner's .303. */
    for (const s of [-1, 1]) {
      B.box([s * 0.13 - 0.07, CH.legTop + 0.10, 0.14], [s * 0.13 + 0.07, CH.torsoTop - 0.10, 0.245], a.deep);
      B.box([s * 0.13 - 0.042, CH.legTop + 0.16, 0.235], [s * 0.13 + 0.042, CH.torsoTop - 0.18, 0.246], a.glow);
    }
  },
  head(B, p) {
    const a = p.a;
    /* Rounded chassis head: a low box with a stepped dome, so the mass sits
       on the hit sphere at 1.60 and the antenna, not the skull, reaches the
       default's 1.890. */
    B.box([-0.215, -0.185, -0.20], [0.215, 0.15, 0.20], a.shell, { top: Cx(0x8f9bd6, 1.05) });
    B.box([-0.175, 0.14, -0.165], [0.175, 0.225, 0.165], a.deep);                         // dome
    B.box([-0.20, -0.075, -0.245], [0.20, 0.07, -0.185], a.lens);                         // visor, front
    for (const s of [-1, 1])                                                              // visor, wrapping the sides
      B.box([s * 0.2275 - 0.0175, -0.06, -0.20], [s * 0.2275 + 0.0175, 0.055, 0.075], a.lens);
    B.box([-0.125, -0.045, -0.255], [0.125, 0.038, -0.238], a.glow);                      // eye light
    B.box([-0.20, 0.055, -0.255], [0.20, 0.115, -0.195], a.deep);                         // brow
    /* The lens housing is the only thing on this head that leaves the visor
       plane; at -.310 it stops 4 cm inside the default cap brim's -.350. */
    B.box([-0.058, -0.03, -0.30], [0.058, 0.045, -0.235], a.shell);
    B.box([-0.04, -0.015, -0.31], [0.04, 0.03, -0.29], a.lens);
    B.box([-0.022, -0.005, -0.315], [0.022, 0.018, -0.305], a.glow);
    B.box([-0.16, -0.185, -0.215], [0.16, -0.10, -0.185], a.deep);                        // chin vent
    B.box([-0.09, -0.175, -0.222], [0.09, -0.12, -0.20], a.dark);
    for (const s of [-1, 1]) {                                                            // ear pods
      B.box([s * 0.2375 - 0.0275, -0.10, -0.02], [s * 0.2375 + 0.0275, 0.07, 0.13], a.deep);
      B.box([s * 0.2575 - 0.0075, -0.06, 0.02], [s * 0.2575 + 0.0075, 0.03, 0.09], a.glow);
    }
    B.box([-0.022, 0.215, 0.0], [0.022, 0.255, 0.045], a.dark);                           // antenna
    B.box([-0.045, 0.245, -0.02], [0.045, 0.29, 0.07], a.glow);
  },
  leg(B, p) {
    const a = p.a;
    B.box([-0.10, -0.11, -0.09], [0.10, 0.02, 0.09], a.dark);                             // hip joint
    B.box([-CH.legW, -0.36, -0.095], [CH.legW, -0.07, 0.10], p.cD);                       // jersey thigh
    B.box([-0.115, -0.44, -0.125], [0.115, -0.33, 0.105], a.shell);                       // knee
    B.box([-0.12, -0.63, -0.095], [0.12, -0.42, 0.095], a.deep);                          // shin
    B.box([-0.125, -0.65, -0.10], [0.125, -0.56, -0.075], a.glow);                        // shin light
    B.box([-CH.legW - 0.012, -CH.legTop, -0.185], [CH.legW + 0.012, -CH.legTop + 0.125, 0.075], a.shell); // foot
    B.box([-0.10, -CH.legTop, 0.06], [0.10, -CH.legTop + 0.09, 0.14], a.deep);            // heel
  },
  arm(B, p) {
    const a = p.a;
    B.box([-0.088, -CH.armLen + 0.19, -0.088], [0.088, 0.02, 0.088], p.cB);               // jersey upper arm
    B.box([-0.088, -0.02, -0.088], [0.088, 0.065, 0.088], a.dark);                        // shoulder bolt
    B.box([-0.082, -0.28, -0.082], [0.082, -0.20, 0.082], a.shell);                       // elbow ring
    B.box([-0.078, -CH.armLen + 0.055, -0.078], [0.078, -0.255, 0.078], p.cB);            // forearm
    B.box([-0.085, -CH.armLen, -0.085], [0.085, -CH.armLen + 0.08, 0.085], a.shell);      // gripper
    B.box([-0.085, -CH.armLen + 0.022, -0.03], [0.085, -CH.armLen + 0.042, 0.03], a.dark);
  }
};

const SKIN_PARTS = {
  'char-midnight': ROBOT_PARTS,
  'char-sherbetfox': FOX_PARTS,
  'char-cloudknight': KNIGHT_PARTS
};

function partMesh(build, withLines) {
  const B = new GeoBuilder();
  build(B);
  const g = new THREE.Group();
  const m = B.mesh(); g.add(m);
  if (withLines) { const l = B.lines(0.5); if (l) g.add(l); }
  return g;
}

/* An unknown, absent, null, non-string — or inherited, e.g. 'constructor' —
   id is not an error: the player just gets the default character. */
function characterSkin(skinId) {
  if (typeof skinId !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(CHARACTER_SKINS, skinId)
    ? CHARACTER_SKINS[skinId] : null;
}

function buildCharacter(colors, skinId) {
  const cosmetic = characterSkin(skinId);
  const parts = cosmetic ? SKIN_PARTS[skinId] : DEFAULT_PARTS;
  const body = colors.body, trim = colors.trim;
  const p = {
    cB: C(body), cT: C(trim), cD: Cx(body, 0.9), cTop: Cx(body, 1.05),
    skin: C(0xffe0c8), skinTop: Cx(0xffe0c8, 1.03), boot: C(0x6b5f80), a: {}
  };
  if (cosmetic) for (const k in cosmetic.col) p.a[k] = C(cosmetic.col[k]);

  const root = new THREE.Group();          // origin at the feet
  const hips = new THREE.Group();
  root.add(hips);

  // ---- torso ----
  const torso = partMesh(B => parts.torso(B, p), true);
  hips.add(torso);

  // ---- head ----
  const headPiv = new THREE.Group();
  headPiv.position.set(0, CH.headC, 0);
  const head = partMesh(B => parts.head(B, p), true);
  headPiv.add(head);
  hips.add(headPiv);

  // ---- limbs ----
  const mkLeg = () => partMesh(B => parts.leg(B, p), false);
  const mkArm = (isRight) => partMesh(B => parts.arm(B, p, isRight), false);

  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-CH.hipW, CH.legTop, 0); legL.add(mkLeg());
  legR.position.set( CH.hipW, CH.legTop, 0); legR.add(mkLeg());
  hips.add(legL, legR);

  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.30, CH.shoulder, 0); armL.add(mkArm(false));
  armR.position.set( 0.30, CH.shoulder, 0); armR.add(mkArm(true));
  hips.add(armL, armR);

  // ---- third-person gun, parented to the right arm ----
  const gun = partMesh(B => {
    B.box([-0.045, -0.045, -0.36], [0.045, 0.045, 0.10], C(0xe9e2f2));
    B.box([-0.030, -0.020, -0.52], [0.030, 0.028, -0.36], C(0xd6cee6));
    B.box([-0.038, -0.16, -0.10], [0.038, -0.035, 0.02], p.cT);
    B.box([-0.036, 0.045, -0.20], [0.036, 0.070, 0.02], p.cT);
    B.box([-0.040, -0.02, 0.10], [0.040, 0.055, 0.26], C(0xe9e2f2));
  }, false);
  gun.position.set(0, -CH.armLen + 0.02, -0.10);
  gun.rotation.x = -Math.PI / 2;   // barrel down the arm and out of the mitt
  armR.add(gun);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.54);
  gun.add(muzzle);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  return { root, hips, torso, headPiv, legL, legR, armL, armR, gun, muzzle };
}

/* ---- name + health plate that hovers over each bot ---- */
/* =====================================================================
   BLOB SHADOWS
   Real shadow mapping is switched off on software renderers, and without
   any contact shadow the characters read as stickers floating over the
   street. A soft dark ellipse under each actor costs one small alpha quad
   and puts them back on the ground. It also survives on GPU: it lands
   under the real shadow and just reads as ambient occlusion.
   ===================================================================== */
let BLOB_TEX = null;
function blobTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0.00, 'rgba(74,63,92,.55)');
  rg.addColorStop(0.55, 'rgba(74,63,92,.30)');
  rg.addColorStop(1.00, 'rgba(74,63,92,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}
function makeBlobShadow() {
  if (!BLOB_TEX) BLOB_TEX = blobTexture();
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: BLOB_TEX, transparent: true, depthWrite: false,
                                  fog: true, opacity: 1 })
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -5;                 // under everything else that blends
  scene.add(m);
  return m;
}
/* Drop it onto whatever surface is under the actor (street, porch, upper
   floor), and fade + spread it the higher they are — a jumping character
   should cast a big faint blob, not a hard one stuck to their boots. */
function updateBlobShadow(blob, a) {
  if (!blob) return;
  if (!a.alive && a.deathT > 1.6) { blob.visible = false; return; }
  const hit = raycastMap(a.pos.x, a.pos.y + 0.4, a.pos.z, 0, -1, 0, 9);
  const gy = hit ? (a.pos.y + 0.4 - hit.dist) : 0;
  const air = clamp(a.pos.y - gy, 0, 4);
  blob.visible = air < 3.6;
  if (!blob.visible) return;
  blob.position.set(a.pos.x, gy + 0.035, a.pos.z);
  const s = 1 + air * 0.30;
  blob.scale.set(s, s, 1);
  blob.material.opacity = (1 - air / 4.2) * (a.alive ? 1 : Math.max(0, 1 - a.deathT / 1.6));
}

/* =====================================================================
   SPAWN BUBBLE
   The gameplay job is "don't die in the first second". The look is a soap
   bubble: additive, back-faces only so it reads as a shell you see THROUGH
   rather than a solid ball, with a fresnel rim so the silhouette glows and
   the middle stays clear. Iridescence comes from shifting the rim hue with
   view angle — cheap, and it is the most overtly magical thing on screen.
   ===================================================================== */
const BUBBLE_VS = `
varying vec3 vN; varying vec3 vV;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BUBBLE_FS = `
uniform float uT; uniform float uFade;
varying vec3 vN; varying vec3 vV;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));   // fresnel rim
  float rim = pow(f, 2.2);
  // iridescent band that drifts around the shell over time
  float band = sin(f * 11.0 - uT * 2.4);
  vec3 tint = vec3(0.55 + 0.45 * sin(band + 0.0),
                   0.55 + 0.45 * sin(band + 2.1),
                   0.55 + 0.45 * sin(band + 4.2));
  vec3 col = mix(vec3(0.75, 0.90, 1.0), tint, 0.55);
  float a = (rim * 0.85 + 0.06) * uFade;
  gl_FragColor = vec4(col * a, a);
}`;
function makeBubble() {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 20, 14),
    new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VS, fragmentShader: BUBBLE_FS,
      uniforms: { uT: { value: 0 }, uFade: { value: 1 } },
      transparent: true, depthWrite: false, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, fog: false
    })
  );
  m.visible = false;
  m.renderOrder = 6;
  scene.add(m);
  return m;
}
function updateBubble(bub, a, t) {
  if (!bub) return;
  const on = a.alive && a.shield > 0;
  bub.visible = on;
  if (!on) return;
  bub.position.set(a.pos.x, a.pos.y + 0.95, a.pos.z);
  // a slow wobble so it feels like surface tension, not a hard sphere
  const w = 1 + Math.sin(t * 3.1 + a.id) * 0.035;
  bub.scale.set(w, 1 / w, w);
  bub.material.uniforms.uT.value = t;
  // pop out over the last third rather than vanishing on a frame boundary
  bub.material.uniforms.uFade.value = clamp(a.shield / (CFG.spawnShield * 0.45), 0, 1);
}
/* a ripple where a shot was absorbed */
function fxShieldHit(a, hx, hy, hz) {
  if (hx === undefined) return;
  fxRing(hx, hy, hz, hx - a.pos.x, hy - (a.pos.y + 0.95), hz - a.pos.z, C(0xbfe8ff), 0.75);
  SFX.tone(880, 620, 0.10, 0.10, 'sine', hx, hy, hz);
}

function makePlate() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 72;
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: true, fog: false
  }));
  sp.scale.set(1.5, 0.42, 1);
  sp.center.set(0.5, 0);
  return { sprite: sp, canvas: cv, tex, last: -1 };
}
function drawPlate(plate, name, hp, maxHp, color) {
  const g = plate.canvas.getContext('2d');
  g.clearRect(0, 0, 256, 72);
  g.font = '800 30px "Baloo 2", Trebuchet MS, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = '#4a3f5c'; g.lineJoin = 'round';
  g.strokeText(name, 128, 22); g.fillStyle = '#fffdf8'; g.fillText(name, 128, 22);
  const w = 190, x = (256 - w) / 2, y = 46, h = 15;
  g.fillStyle = '#4a3f5c';
  g.beginPath(); g.roundRect ? g.roundRect(x - 4, y - 4, w + 8, h + 8, 9) : g.rect(x - 4, y - 4, w + 8, h + 8); g.fill();
  g.fillStyle = '#efe3f2';
  g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, 6) : g.rect(x, y, w, h); g.fill();
  const f = clamp(hp / maxHp, 0, 1);
  g.fillStyle = f > 0.35 ? '#7fe6b4' : '#ff8fa3';
  if (f > 0.01) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w * f, h, 6) : g.rect(x, y, w * f, h); g.fill(); }
  plate.tex.needsUpdate = true;
}

/* =====================================================================
   ANIMATION — everything is driven from a handful of scalars
   ===================================================================== */
function animateCharacter(ch, a, dt, t) {
  const spd = Math.hypot(a.vel.x, a.vel.z);
  const moving = spd > 0.35;

  // --- death: topple sideways, sink, fade out ---
  if (!a.alive) {
    a.deathT += dt;
    const u = clamp(a.deathT / 0.55, 0, 1);
    ch.root.rotation.z = a.deathDir * smoothstep(u) * 1.62;
    ch.root.position.y = a.pos.y - smoothstep(clamp((a.deathT - 0.5) / 1.4, 0, 1)) * 1.1;
    const sc = 1 - smoothstep(clamp((a.deathT - 1.1) / 0.7, 0, 1));
    ch.root.scale.setScalar(Math.max(0.001, sc));
    ch.legL.rotation.x = -0.5; ch.legR.rotation.x = 0.35;
    ch.armL.rotation.z = 0.9; ch.armR.rotation.z = -1.1;
    ch.armL.rotation.x = 0.6; ch.armR.rotation.x = 0.4;
    return;
  }

  // --- spawn pop: squash-stretch overshoot ---
  ch.root.rotation.z = 0;
  ch.root.position.y = a.pos.y;
  if (a.spawnT > 0) {
    a.spawnT = Math.max(0, a.spawnT - dt);
    const u = 1 - a.spawnT / 0.45;
    const s = u < 1 ? 1 + Math.sin(u * Math.PI) * 0.28 * (1 - u) : 1;
    ch.root.scale.set(s * (2 - s), Math.pow(smoothstep(u), 0.6) * s, s * (2 - s));
  } else ch.root.scale.set(1, 1, 1);

  // --- facing: body turns toward travel, torso/head lead toward aim ---
  /* +PI: the rig models face -Z locally, engine forward is +Z (see yawFlip). */
  const moveYaw = moving ? Math.atan2(a.vel.x, a.vel.z) + Math.PI : a.bodyYaw;
  a.bodyYaw = approachAngle(a.bodyYaw, moving ? moveYaw : (a.aimYaw + Math.PI), dt * (moving ? 9 : 4.5));
  ch.root.rotation.y = a.bodyYaw;

  const lead = angDelta(a.bodyYaw, a.aimYaw + Math.PI);
  ch.hips.rotation.y = damp(ch.hips.rotation.y, clamp(lead, -1.1, 1.1) * 0.55, 12, dt);
  ch.headPiv.rotation.y = damp(ch.headPiv.rotation.y, clamp(lead, -1.3, 1.3) * 0.45, 14, dt);
  ch.headPiv.rotation.x = damp(ch.headPiv.rotation.x, clamp(a.aimPitch, -0.6, 0.6), 12, dt);

  // --- gait ---
  const stride = clamp(spd / 6.2, 0, 1.35);
  a.gait += dt * (2.0 + spd * 1.85);
  const sw = Math.sin(a.gait) * stride;
  const sw2 = Math.cos(a.gait * 2) * stride;

  if (a.onGround) {
    ch.legL.rotation.x = damp(ch.legL.rotation.x,  sw * 0.95, 20, dt);
    ch.legR.rotation.x = damp(ch.legR.rotation.x, -sw * 0.95, 20, dt);
    ch.hips.position.y = damp(ch.hips.position.y, Math.abs(sw2) * 0.035 - stride * 0.02, 16, dt);
  } else {
    ch.legL.rotation.x = damp(ch.legL.rotation.x, -0.45, 9, dt);
    ch.legR.rotation.x = damp(ch.legR.rotation.x,  0.30, 9, dt);
    ch.hips.position.y = damp(ch.hips.position.y, 0, 9, dt);
  }

  /* --- arms: raised into a firing pose when engaged, swinging otherwise ---
     The rig faces -Z, so rotating a shoulder by +X swings that arm forward,
     past +PI/2 tips it skyward. Every sign below reads from that: the fire
     pose sits just under the horizontal, aiming up adds pitch, recoil adds
     more, and the swing puts each arm opposite the leg on its own side. */
  const aimUp = a.aiming ? 1 : 0;
  a.aimBlend = damp(a.aimBlend, aimUp, 10, dt);
  const rest = sw * 0.62, restL = -sw * 0.62;
  const fireX = 1.42 + clamp(a.aimPitch, -0.7, 0.7);
  ch.armR.rotation.x = damp(ch.armR.rotation.x, lerp(rest, fireX, a.aimBlend) + a.recoil * 0.55, 16, dt);
  ch.armL.rotation.x = damp(ch.armL.rotation.x, lerp(restL, fireX - 0.12, a.aimBlend) + a.recoil * 0.35, 16, dt);
  ch.armR.rotation.z = damp(ch.armR.rotation.z, lerp(0.06, -0.30, a.aimBlend), 14, dt);
  ch.armL.rotation.z = damp(ch.armL.rotation.z, lerp(-0.06, 0.46, a.aimBlend), 14, dt);
  ch.armL.rotation.y = damp(ch.armL.rotation.y, lerp(0, 0.55, a.aimBlend), 14, dt);

  // recoil + flinch decay
  a.recoil = Math.max(0, a.recoil - dt * 6.5);
  a.flinch = Math.max(0, a.flinch - dt * 5);
  ch.hips.rotation.x = damp(ch.hips.rotation.x, stride * 0.10 + a.recoil * 0.16 + a.flinch * 0.25, 14, dt);
  ch.hips.rotation.z = damp(ch.hips.rotation.z, -a.flinch * 0.3, 12, dt);
  // idle breathe
  if (!moving) ch.hips.position.y += Math.sin(t * 1.9 + a.id) * 0.006;
}
