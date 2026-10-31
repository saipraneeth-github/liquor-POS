/**
 * serving.engine.ts — Pure logic for peg / glass servings.
 * A bottle is "opened" when a peg needs more ml than the open bottle holds; the opened bottle
 * leaves stock.quantity and its ml are tracked in stock.open_ml. No DB access here.
 */

export interface MlStock {
  quantity: number;   // sealed bottles on hand
  openMl: number;     // ml left in the opened bottle
}

export interface ServingInput {
  label: string;
  volumeMl?: number | null;
  price: string;
}

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ');
}

/** Auto label for a serving: "60 ml" for pegs, "Full bottle" for whole units. */
export function defaultServingLabel(volumeMl: number | null | undefined): string {
  return volumeMl ? `${volumeMl} ml` : 'Full bottle';
}

/** Rejects empty / duplicate labels and pegs larger than the bottle. */
export function validateServings(servings: ServingInput[], bottleMl?: number | null): void {
  const seen = new Set<string>();
  for (const s of servings) {
    const label = normalizeLabel(s.label);
    if (!label) throw new Error('Serving label is required');
    const key = label.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate serving "${label}"`);
    seen.add(key);
    if (s.volumeMl != null) {
      if (!Number.isInteger(s.volumeMl) || s.volumeMl <= 0) throw new Error(`Invalid volume for "${label}"`);
      if (bottleMl && s.volumeMl > bottleMl) throw new Error(`"${label}" is larger than the ${bottleMl} ml bottle`);
    }
  }
}

/**
 * Takes `ml` out of stock. Returns the new state plus how many sealed bottles were opened,
 * or null when stock cannot cover it.
 */
export function deductMl(
  state: MlStock,
  ml: number,
  bottleMl: number,
): { state: MlStock; bottlesOpened: number } | null {
  if (ml <= 0 || bottleMl <= 0) throw new Error('ml and bottle size must be positive');
  if (state.openMl >= ml) {
    return { state: { quantity: state.quantity, openMl: state.openMl - ml }, bottlesOpened: 0 };
  }
  const shortfall = ml - state.openMl;
  const bottlesOpened = Math.ceil(shortfall / bottleMl);
  if (bottlesOpened > state.quantity) return null;
  return {
    state: { quantity: state.quantity - bottlesOpened, openMl: state.openMl + bottlesOpened * bottleMl - ml },
    bottlesOpened,
  };
}

/** Puts ml back (void of a peg sale): whole bottles worth of ml return to sealed stock. */
export function restoreMl(state: MlStock, ml: number, bottleMl: number): MlStock {
  if (ml <= 0 || bottleMl <= 0) throw new Error('ml and bottle size must be positive');
  const total = state.openMl + ml;
  return { quantity: state.quantity + Math.floor(total / bottleMl), openMl: total % bottleMl };
}

export interface MlSaleLine {
  productId: string;
  quantity: number;
  servingMl: number | null;   // null = whole unit
}

/** Splits sale lines into whole-unit counts and total ml per product. */
export function splitUnitsAndMl(lines: MlSaleLine[]): { units: Map<string, number>; ml: Map<string, number> } {
  const units = new Map<string, number>();
  const ml = new Map<string, number>();
  for (const l of lines) {
    if (l.servingMl) ml.set(l.productId, (ml.get(l.productId) ?? 0) + l.quantity * l.servingMl);
    else units.set(l.productId, (units.get(l.productId) ?? 0) + l.quantity);
  }
  return { units, ml };
}
