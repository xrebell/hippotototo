/**
 * Collision geometry shared by gameplay (collisions) and render (debug hitbox overlay).
 * COMPLETE. Owner: GAMEPLAY. Pure, allocation-free: every function writes into a caller-owned Box.
 *
 * Rules (spec §4):
 *  - Hero sprite 76 x 60, origin at FEET CENTRE (hero.x, hero.y).
 *  - Hero hurtbox 48 x 42, centred in x, bottom 4 u above the feet.
 *  - Hazard hitbox = drawn box inset 15% of its width (7.5% per side) and 8 u off the top
 *    (thorn bush: 30% / 12 u, a wider quick-tap window; see insetWFracFor / insetTopFor).
 *  - Pickup box = hurtbox expanded by 18 u on every side.
 */
import { GROUND_Y, HERO, HITBOX, PIT } from './config';
import type { Box, Entity, HeroState } from './types';

type ReadHero = Readonly<Pick<HeroState, 'x' | 'y'>>;
type ReadEntity = Readonly<Pick<Entity, 'kind' | 'x' | 'y' | 'w' | 'h'>>;

/** Hero hurtbox at the hero's current feet position. */
export function heroHurtbox(hero: ReadHero, out: Box): Box {
  out.w = HERO.hurtW;
  out.h = HERO.hurtH;
  out.x = hero.x - HERO.hurtW / 2;
  out.y = hero.y - HERO.hurtBottom - HERO.hurtH;
  return out;
}

/** Hero hurtbox for an arbitrary feet position (prediction, simArc, render interpolation). */
export function heroHurtboxAt(feetX: number, feetY: number, out: Box): Box {
  out.w = HERO.hurtW;
  out.h = HERO.hurtH;
  out.x = feetX - HERO.hurtW / 2;
  out.y = feetY - HERO.hurtBottom - HERO.hurtH;
  return out;
}

/** Pickup box (hurtbox grown by 18 u each side). */
export function heroPickupBox(hero: ReadHero, out: Box): Box {
  heroHurtbox(hero, out);
  out.x -= HERO.pickupPad;
  out.y -= HERO.pickupPad;
  out.w += HERO.pickupPad * 2;
  out.h += HERO.pickupPad * 2;
  return out;
}

/** True for kinds whose hitbox uses the hazard inset rule. */
export function isLethalKind(kind: Entity['kind']): boolean {
  return kind === 'bush' || kind === 'mound' || kind === 'hornbill' || kind === 'log';
}

/** Total width fraction a lethal kind's hitbox is inset by (split over both sides). */
export function insetWFracFor(kind: Entity['kind']): number {
  return kind === 'bush' ? HITBOX.bushInsetWFrac : HITBOX.insetWFrac;
}

/** Units a lethal kind's hitbox is inset from the top. */
export function insetTopFor(kind: Entity['kind']): number {
  return kind === 'bush' ? HITBOX.bushInsetTop : HITBOX.insetTop;
}

/**
 * Hitbox of an entity.
 *  - bush / mound / hornbill / log: drawn box inset per kind (insetWFracFor / insetTopFor):
 *    7.5% of width per side and 8 u off the top; bush 15% per side and 12 u.
 *  - pit: the deadly span [x + 6, x + w - 6], from GROUND_Y down to the mud surface.
 *  - everything else: the drawn box.
 */
export function entityHitbox(e: ReadEntity, out: Box): Box {
  if (isLethalKind(e.kind)) {
    const inset = e.w * insetWFracFor(e.kind) * 0.5;
    const top = insetTopFor(e.kind);
    out.x = e.x + inset;
    out.w = e.w - inset * 2;
    out.y = e.y + top;
    out.h = e.h - top;
    if (out.h < 1) out.h = 1;
    return out;
  }
  if (e.kind === 'pit') {
    out.x = e.x + PIT.lipInset;
    out.w = e.w - PIT.lipInset * 2;
    out.y = GROUND_Y;
    out.h = PIT.mudDepth;
    return out;
  }
  out.x = e.x;
  out.y = e.y;
  out.w = e.w;
  out.h = e.h;
  return out;
}

/** AABB overlap (touching edges do not overlap). */
export function overlaps(a: Readonly<Box>, b: Readonly<Box>): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Euclidean gap between two boxes (0 when overlapping). Near-miss clearance. */
export function boxGap(a: Readonly<Box>, b: Readonly<Box>): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0);
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Horizontal overlap of [a0, a1] and [b0, b1]. */
export function spanOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

/** Make a Box (allocation — call only at init to create scratch boxes). */
export function makeBox(): Box {
  return { x: 0, y: 0, w: 0, h: 0 };
}
