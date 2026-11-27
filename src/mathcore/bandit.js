// LinUCB: choose among arms from a context vector, learning a linear payoff model per arm from
// the outcomes it observes. Each arm keeps A = lambda*I + sum(x x^T) and b = sum(r x); the
// estimate is theta = A^-1 b and the score is theta.x + alpha * sqrt(x^T A^-1 x). A^-1 is
// updated in place with the Sherman-Morrison identity, so an update costs O(d^2).
//
// Read before using this for model routing. Two 2026 studies (arXiv:2606.07587,
// arXiv:2601.07206) found learned routers level off far below the oracle and often fail to beat
// a simple baseline. The reward here must be a VERIFIED outcome (a test result), never a model's
// own judgement of itself. Wire it in shadow beside the cascade and compare before trusting it.

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export class LinUCB {
  /**
   * @param {{arms:string[], dimension:number, alpha?:number, lambda?:number}} options
   *   `alpha` scales exploration; `lambda` is the ridge term that makes A invertible from the start
   */
  constructor({ arms, dimension, alpha = 1, lambda = 1 }) {
    if (!(dimension > 0) || !(lambda > 0)) throw new RangeError("dimension and lambda must be > 0");
    this.arms = [...arms];
    this.dimension = dimension;
    this.alpha = alpha;
    /** @type {Map<string, {inverse:number[][], b:number[], pulls:number}>} */
    this.state = new Map(
      this.arms.map((arm) => [
        arm,
        {
          inverse: Array.from({ length: dimension }, (_, i) =>
            Array.from({ length: dimension }, (_, j) => (i === j ? 1 / lambda : 0)),
          ),
          b: new Array(dimension).fill(0),
          pulls: 0,
        },
      ]),
    );
  }

  #arm(arm) {
    const s = this.state.get(arm);
    if (!s) throw new RangeError(`unknown arm: ${arm}`);
    return s;
  }

  #check(x) {
    if (x.length !== this.dimension) throw new RangeError("context has the wrong dimension");
  }

  /** The current payoff estimate theta for one arm. */
  theta(arm) {
    const s = this.#arm(arm);
    return s.inverse.map((row) => dot(row, s.b));
  }

  /** Estimated payoff and exploration width for one arm in a context. */
  score(arm, x) {
    this.#check(x);
    const s = this.#arm(arm);
    const ax = s.inverse.map((row) => dot(row, x));
    const mean = dot(this.theta(arm), x);
    const width = this.alpha * Math.sqrt(Math.max(0, dot(x, ax)));
    return { mean, width, upper: mean + width };
  }

  /**
   * Pick the arm with the highest upper bound among those allowed. Ties go to the earlier arm,
   * so the choice is deterministic.
   * @param {number[]} x
   * @param {{allowed?:string[]}} [options]
   */
  choose(x, { allowed = this.arms } = {}) {
    let best = null;
    for (const arm of this.arms) {
      if (!allowed.includes(arm)) continue;
      const s = this.score(arm, x);
      if (best === null || s.upper > best.upper) best = { arm, ...s };
    }
    if (best === null) throw new RangeError("no arm is allowed");
    return best;
  }

  /** Record one verified reward for the arm that was played in context x. */
  update(arm, x, reward) {
    this.#check(x);
    if (!Number.isFinite(reward)) throw new RangeError("reward must be a finite number");
    const s = this.#arm(arm);
    const ax = s.inverse.map((row) => dot(row, x));
    const denom = 1 + dot(x, ax);
    for (let i = 0; i < this.dimension; i++)
      for (let j = 0; j < this.dimension; j++) s.inverse[i][j] -= (ax[i] * ax[j]) / denom;
    for (let i = 0; i < this.dimension; i++) s.b[i] += reward * x[i];
    s.pulls++;
  }
}
