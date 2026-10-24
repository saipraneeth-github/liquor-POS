export class PackQuantityEngine {
  /**
   * Convert number of cases to total bottles.
   * e.g. 10.5 cases of 12-pack = 126 bottles.
   */
  static casesToBottles(cases: number, packQuantity: number): number {
    if (!packQuantity || packQuantity <= 0) return 0;
    return Math.floor(cases * packQuantity);
  }

  /**
   * Convert number of bottles to cases.
   * e.g. 126 bottles of 12-pack = 10.5 cases.
   */
  static bottlesToCases(bottles: number, packQuantity: number): number {
    if (!packQuantity || packQuantity <= 0) return 0;
    return bottles / packQuantity;
  }
}
