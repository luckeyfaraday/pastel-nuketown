# Terminal — map design & blockout

Design doc for the second map. Reference: Call of Duty MW3 (2023) *Terminal*, itself a
remaster of the MW2 (2009) map. This is a pastel reinterpretation, not a copy — the goal
is that someone who has played Terminal recognises the *shape* of the fight, not the
airport.

Status: **blockout spec, not yet built.** Geometry lands in a new map module once the
multi-map registry (`feat/multi-map-registry`) is merged.

---

## 1. What we are actually copying

Terminal is a three-lane map with an asymmetric silhouette. The six named zones:

| Zone | Role in the fight |
|---|---|
| Security | West spawn. Small, low cover, fast fights. Office overlooks the plane. |
| Lower Lounge | North spawn. Snack-bar cover, glass wall onto the apron, escalators up. |
| Shopping / Hallway | Largest interior. Check-in counters, windows to apron. |
| Dining / Burger Town | Upper level. The defensive perch, overlooks Dining and Shopping. |
| Apron | Open tarmac. Freight containers are the only cover. |
| Plane | Chokepoint linking apron and interior. Three exits. |

The thing worth stealing is not the airport — it is that **the three lanes run parallel
and cross at only four places.** That is what stops it collapsing into a deathball.

## 2. Coordinate frame

Same conventions as `mapspec.js`: Y up, metres, axis-aligned AABBs for collision.

```
bounds  x [-40, 40]   z [-26, 26]        80 x 52 m   (Nuketown is 60 x 40)
levels  [0, 3.3]
actor   radius 0.38, height 1.8, eye 1.62, step 0.55   (unchanged — shared contract)
```

X is the long axis (terminal frontage). Z is depth: interior at −Z, apron at +Z.

### 2.1 The one-level trick

Everything upstairs sits at **y = 3.3**, the same `F1` Nuketown already uses:

- mezzanine / Upper Lounge / Burger Town floor
- jet bridge deck
- **plane cabin floor**
- **top of a stacked pair of freight containers** (1.65 m each → 3.30 exactly)

So `levels: [0, 3.3]` — two levels, not three. This matters more than it looks:

- Nav grid stays cheap. `bots.js:104` builds a 0.85 m grid over bounds × levels.
  Nuketown = 70×47×2 ≈ 6.6k cells. Terminal at two levels ≈ 94×61×2 ≈ **11.5k (1.7×)**.
  A third level would have made it 2.6×, on a map that also has to run on phones.
- Bots can actually contest the upper lane, including the container tops and the plane.
  A lane bots never visit is a lane that feels broken in a mostly-bot lobby.
- `supported()` in `bots.js` matches platforms to a level within 0.08 m, so the 1.65 m
  container height is load-bearing. Do not round it to 1.6.

Getting up is all jumps, no ramps: ground → single container (1.65) → stacked pair (3.30).
Escalators and the rear airstairs are the only walkable climbs.

## 3. Plan view

```
        x=-40      -24        -8         +8        +24       x=+40
  z=-26  ┌───────────────────────────────────────────────────────┐
         │              back-of-house wall (perimeter)           │
  z=-22  │ ┌─────────┐ ┌───────────────────────┐ ┌─────────────┐ │
         │ │ SECURITY│ │  SHOPPING / HALLWAY   │ │LOWER LOUNGE │ │
  z=-16  │ │  ▣ ▣    │ │  ▓▓▓ check-in ▓▓▓     │ │  snack bar  │ │
         │ │ ┌────┐  │ │                       │ │   ▓▓▓       │ │
  z=-12  │ │ │offc│  │ │      ╱ escalator      │ │  ╱ escalator│ │
         │ └─┴────┴──┘ └───────────────────────┘ └─────────────┘ │
  z= -9  │ ═══════════ GLASS FRONTAGE ═══════════════════════════ │
  z= -6  │      ▪ svc      ░ shatter ░      ┃jet┃    ▄ maint ▄   │
         │      door                        ┃brdg┃    shed       │
  z= -2  ├───────────────────────────────────╂──────────────────┤
         │                                   ┃                   │
  z=  0  │            A P R O N              ┃                   │
         │       ▩▩        ▩▩▩               ▼                   │
  z= +6  │      containers    ▩▩      ┌──────────────┐           │
         │                            │   wing       │           │
  z=+12  │  ◤tail ══════════ F U S E L A G E ═══════════ nose◢   │
         │                            │   wing       │           │
  z=+20  │       ▩▩▩          ▩▩      └──────────────┘           │
  z=+26  └───────────────────────────────────────────────────────┘
```

### 3.1 The three lanes

| Lane | Z band | Character |
|---|---|---|
| Interior | −24 … −9 | Two floors, tight, lots of cover, short sightlines |
| Seam | −9 … −2 | Frontage, shed, jet bridge — the transition band |
| Apron | −2 … +24 | Open, long sightlines, container cover only |

### 3.2 The four crossings

Only four ways to change lanes. This is the whole map.

| # | Where | x | Kind |
|---|---|---|---|
| 1 | Security service door | ≈ −30 | Ground, tight, one-at-a-time |
| 2 | Shattered frontage, Shopping | ≈ −8 | Ground, wide, the "obvious" push |
| 3 | **Jet bridge → plane** | ≈ +8 | **Elevated (3.3), the signature chokepoint** |
| 4 | Lower Lounge → maintenance shed | ≈ +26 | Ground + mountable roof (3.3) |

Crossing 3 is the one to get right. You enter it from the mezzanine, walk out above the
apron, and land inside the plane — a lane that is entirely upstairs and entirely exposed
through the frontage glass on the way. High risk, high reward, and it is what makes the
plane a chokepoint rather than a prop.

## 4. Zone coordinates (blockout)

Approximate AABB envelopes. Walls `W = 0.3`, ground ceiling `H0 = 3.0`, slab `0.3`,
mezzanine `F1 = 3.3`, upper ceiling `H1 = 6.3`, roof `6.6` — same constants as Nuketown so
the shared helpers keep working.

| Zone | x | z | y | Notes |
|---|---|---|---|---|
| Security | −38 … −24 | −23 … −10 | 0 … 3.0 | Two scanner arches as waist cover |
| Kastovia office | −36 … −30 | −16 … −11 | 0 … 3.0 | Window slit onto the apron, sightline to the plane nose |
| Shopping / Hallway | −24 … +6 | −24 … −9 | 0 … 6.3 | Full height; mezzanine over the north half |
| Check-in counters | −20 … −2 | −18 … −16 | 0 … 1.15 | Waist-high, the room's spine of cover |
| Escalator (west) | −14 … −11 | −16 … −10 | 0 → 3.3 | 9 stepped boxes + a `link`, per `mapspec.js:93` |
| Mezzanine slab | −24 … +6 | −24 … −15 | 3.0 … 3.3 | Hole over the escalator |
| Burger Town | −18 … −8 | −23 … −17 | 3.3 … 6.3 | Counter at 3.3…4.25, kitchen behind |
| Lower Lounge | +6 … +30 | −23 … −9 | 0 … 3.0 | North spawn |
| Snack bar | +12 … +20 | −18 … −16.5 | 0 … 1.15 | |
| Escalator (east) | +22 … +25 | −16 … −10 | 0 → 3.3 | |
| Glass frontage | −24 … +30 | −9 … −8.7 | 0 … 6.3 | Gap at x −10…−6 (crossing 2) |
| Jet bridge | +6 … +10 | −8 … +8 | 2.6 … 4.4 | Deck at 3.3, walls to 4.4 |
| Maintenance shed | +24 … +32 | −6 … +1 | 0 … 3.3 | Roof is a platform at 3.3 |
| Apron | −40 … +40 | −2 … +24 | 0 | Flat tarmac |

### 4.1 Freight containers

The apron's only cover, and the reason it is not a shooting gallery. Unit box
**2.4 × 1.65 × 2.4 m**. Singles are a jump-up; stacked pairs top out at 3.30 and become
platforms on level 1.

Eight clusters, deliberately *not* symmetric — three near the tail (west), three near the
nose (east), two mid-apron. Mid-apron pairs must be stacked, so the long z-sightline down
the fuselage is broken at two points.

### 4.2 The plane

| Part | x | z | y |
|---|---|---|---|
| Fuselage (collision) | −12 … +26 | +9.8 … +14.2 | 2.1 … 6.5 |
| Cabin floor (platform) | −6 … +22 | +10.2 … +13.8 | 3.3 |
| Wing, port | +2 … +10 | +4 … +10 | 3.3 |
| Wing, starboard | +2 … +10 | +14 … +20 | 3.3 |
| Tailfin | −14 … −10 | +11 … +13 | 6.5 … 11.0 |
| Gear struts | −2, +18 | +12 | 0 … 2.1 |

Belly at 2.1 m leaves walkable clearance **under** the fuselage — an apron crossing that
is safe from the frontage but exposed lengthwise. That is free map, and it is the reason
to park the plane on gear rather than sit it on the tarmac.

Three exits, matching the real map:

1. **Forward door**, x ≈ +16 — the jet bridge (crossing 3)
2. **Over-wing**, x ≈ +6 — steps onto the wing, then a 3.3 m drop to the apron
3. **Rear airstairs**, x ≈ −4 — stepped boxes + a `link` down to the apron

Visually the fuselage is `ngonPrism(B,'x',…)` — already in `src/20-world.js:8` — with the
collision staying a plain AABB. Same trick the bus and truck already use.

## 5. Spawns

Terminal is asymmetric, but this game is free-for-all: `pickSpawn` (`src/30-physics.js:244`)
picks the point farthest from the nearest living threat, and there is no team logic to
balance. Asymmetry costs us nothing here.

Fourteen points, spread so no cluster is more than ~12 m from cover:

- Security: 3 (west end, x ≈ −36 … −28)
- Lower Lounge: 3 (x ≈ +12 … +28)
- Shopping: 2 (x ≈ −18, +2, both at z ≈ −20)
- Mezzanine / Burger Town: 2
- Apron west / tail: 2
- Apron east / nose: 2

Yaw faces map centre, matching the contract in `mapspec.js:190`.

## 6. New materials

The `switch (s.mat)` in `src/20-world.js:178` is the extension point. Terminal adds:

| `mat` | Treatment |
|---|---|
| `tarmac` | Flat slab, painted lead-in lines and a stand marking |
| `glass` | Pale opaque tint + heavy ink mullions (see §7) |
| `fuselage` | `ngonPrism` shell, cheatline stripe, window row |
| `wing` | Flat box, chamfered leading edge |
| `container` | `bevelBox` + strapping, like `crate` but taller and stackable |
| `counter` | Waist cover with a contrasting top surface |
| `escalator` | Stepped boxes + a moving-handrail band |
| `bridge` | Jet bridge tube, ribbed, accordion end |
| `sign` | Hanging gate signage — the interior's only vertical colour |

## 7. Open questions

1. **Glass.** The frontage is the map's signature look, but this renderer puts the whole
   world in one vertex-coloured opaque mesh — two draw calls total. Real transparency
   costs a third. Proposal: fake it, pale tint plus strong ink mullions, and spend the
   budget on a few *actual* holes in the glass where the crossings are. Cheaper and reads
   better than uniform 40% alpha.
2. **Mannequins.** Nuketown's signature prop needs a Terminal equivalent — luggage carts
   and seated passenger dummies. Same rule applies as `src/20-world.js:527`: never a
   jersey colour, or they become false targets.
3. **Wing walkability.** Spec above says walkable at 3.3 for consistency with the upper
   lane. You cannot walk the wing in the real Terminal. Consistency is probably worth more
   than fidelity here, but it is a real departure and worth a playtest before committing.

## 7a. How the map module plugs in

The multi-map registry (branch `feat/multi-map-registry`) is built and green. Terminal is a
new module registered in `map-registry.js`, exporting the same shape as `mapspec.js` plus a
`render` hook:

```js
render: {
  chunkCuts: [-24, -8, 8, 24],           // per-map now; nothing inherits Nuketown's
  buildGeometry(ctx)    { /* authoring happens here */ },
  buildDecorations(ctx) { /* luggage carts, sky */ }
}
```

`ctx` carries `map`, `builder`, `group`, `color` (`C`), `colorScale` (`Cx`), `palette`, and
`helpers` — `ngonPrism`, `arcBand`, `domeY`, `bevelBox`, `scallopEdge`, `gable`,
`windowPanel`. No engine globals, so the module stays self-contained.

Two things to remember when authoring:

- `buildDecorations` must call `buildSky(WORLD.group)` itself. Nuketown's does; a map that
  forgets it renders against an empty horizon.
- `setActiveMap(id)` disposes and rebuilds the world *and* the nav grid, and rolls back to
  the previous map if the render hook throws. A broken Terminal hook cannot strand a player
  in a half-built world — though it will throw loudly, which is what we want in development.

## 8. Rotation

**Decision: true rotation.** No picker. A match ends, the next map in the pool loads:
`NUKETOWN → TERMINAL → NUKETOWN → …`

Both maps get played, the title screen keeps the sparse Brawl-Stars-style layout it was
designed around, and the netcode stays simple — the host announces what is next, guests
adopt it. The title screen gains one non-interactive `MAP` card beside `MATCH MODE`, same
card treatment: map name, an `UP NEXT` tag, and a one-line blurb.

The wire half is already built on `feat/map-netcode`: the map id travels in the room
handshake (before any snapshot can validate positions against `MAP.bounds`), and again in
the snapshot and checkpoint so late-join and host migration stay consistent. A peer that
does not know the map is refused with `unsupported-map` rather than silently falling back
to Nuketown.

## 9. Deliberately cut

Bookstore, makeup store, the garden/hedges, the ladder to the maintenance roof, and the
baggage carousel. Terminal has more rooms than a 9-player FFA needs, and every extra
interior room is another place the fight goes quiet. Four crossings and six zones is
already more structure than Nuketown carries.
