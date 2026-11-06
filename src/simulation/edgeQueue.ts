/**
 * Physical admission control for one directed passage (door, stair entry, narrow corridor).
 *
 * Long-run flow is limited to the passage's `capacityPerSecond` (people/s). A small token bucket
 * lets people who are physically side by side enter together (burst = people abreast).
 *
 * Two regimes:
 * - orderly (competitiveness 0, a rehearsed drill): first-in, first-out — nobody overtakes.
 * - competitive: an optional behavioural scenario. Position, urgency and an available gap
 *   determine admission (see `tryAdmitCompetitive`); it is not a claim about every emergency.
 *   Controlled bottleneck experiments motivate intermittent flow and possible increases under
 *   limited pressure (Nicolas et al. 2017; Haghani et al. 2019; Pastor et al. 2015). The gains,
 *   probabilities and Pareto parameters below are modelling assumptions, not values calibrated
 *   against this school, and cannot establish real-world evacuation performance.
 */
export interface EdgeQueueState {
  /** Directed key: `${edgeId}|${fromNodeId}`. */
  key: string;
  edgeId: string;
  capacityPerSecond: number;
  burst: number;
  tokens: number;
  lastRefillAt: number;
  /** FIFO of waiting agent ids. */
  waiting: number[];
  /** Total admissions, for audits. */
  entries: number;
  /** Earliest time at which the next person can enter, derived for planners/UI. */
  nextEntryTime: number;
  /** 0 = orderly FIFO, 1 = highly competitive crowd at the mouth. */
  competitiveness: number;
  /** Passage width (m), used for the clogging probability. */
  width: number;
  /** Nobody gets through before this time (an arch of bodies jammed in the opening). */
  clogUntil: number;
  /** Number of clogs formed (metrics). */
  clogs: number;
  /** Total seconds the opening was jammed. */
  cloggedSeconds: number;
}

/** Assumed potential flow gain; actual flow also loses time to clogs and physical queues. */
export function competitiveFlowGain(competitiveness: number, width: number): number {
  const c = Math.max(0, Math.min(1, competitiveness));
  // Wider openings let pushing people slip through two abreast; very narrow ones barely gain.
  const gain = width < 0.75 ? 0.08 : width < 1.0 ? 0.2 : 0.26;
  return 1 + gain * c;
}

/** Chance that a passage jams right after one admission when the mouth is crowded. */
export function clogProbability(competitiveness: number, width: number, contenders: number): number {
  const c = Math.max(0, Math.min(1, competitiveness));
  if (c <= 0 || contenders < 3) return 0;
  const base = width < 0.75 ? 0.1 : width < 1.0 ? 0.06 : width < 1.6 ? 0.03 : 0.012;
  // More bodies pressing on the opening make arches more likely (saturates at ~10 contenders).
  return base * c * Math.min(1, contenders / 10);
}

/** Heavy-tailed jam duration (Pareto, α = 2.2: mean ≈ 0.9 s, rare jams of several seconds). */
export function clogDuration(u: number): number {
  const minimum = 0.5;
  const alpha = 2.2;
  return Math.min(8, minimum * Math.pow(Math.max(1e-6, 1 - u), -1 / alpha));
}

function unit01(key: string, n: number): number {
  let h = 2166136261 ^ n;
  for (let index = 0; index < key.length; index += 1) h = Math.imul(h ^ key.charCodeAt(index), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function createEdgeQueue(key: string, edgeId: string, capacityPerSecond: number, width: number, now: number, competitiveness = 0): EdgeQueueState {
  const safeWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const c = Math.max(0, Math.min(1, competitiveness));
  const base = Number.isFinite(capacityPerSecond) && capacityPerSecond > 0 ? capacityPerSecond : 1;
  const abreast = Math.max(1, Math.min(4, Math.floor(safeWidth / 0.6)));
  // In a pushing crowd one more body squeezes through together with the people abreast.
  const burst = abreast + (c >= 0.3 && safeWidth >= 0.75 ? 1 : 0);
  return {
    key, edgeId, capacityPerSecond: base * competitiveFlowGain(c, safeWidth), burst, tokens: burst, lastRefillAt: now,
    waiting: [], entries: 0, nextEntryTime: now, competitiveness: c, width: safeWidth, clogUntil: -Infinity, clogs: 0, cloggedSeconds: 0,
  };
}

export function refillEdgeQueue(queue: EdgeQueueState, now: number) {
  // While jammed nothing flows and no capacity is banked.
  if (now < queue.clogUntil) { queue.lastRefillAt = now; queue.nextEntryTime = queue.clogUntil; return; }
  if (queue.lastRefillAt < queue.clogUntil) {
    // The arch has just given way: the person at its front pops through at once (the jam time
    // itself is lost — that is what makes narrow doors gain nothing from pushing).
    queue.lastRefillAt = queue.clogUntil;
    queue.tokens = Math.max(queue.tokens, 1);
  }
  const elapsed = Math.max(0, now - queue.lastRefillAt);
  if (elapsed > 0) {
    queue.tokens = Math.min(queue.burst, queue.tokens + elapsed * queue.capacityPerSecond);
    queue.lastRefillAt = now;
  }
  queue.nextEntryTime = queue.tokens >= 1 ? now : now + (1 - queue.tokens) / queue.capacityPerSecond;
}

/** Expected wait (s) for someone joining the back of this queue now. */
export function expectedQueueWait(queue: EdgeQueueState | undefined, now: number): number {
  if (!queue) return 0;
  const jam = Math.max(0, queue.clogUntil - now);
  const elapsed = Math.max(0, now - Math.max(queue.lastRefillAt, queue.clogUntil));
  const tokens = jam > 0 ? 0 : Math.min(queue.burst, queue.tokens + elapsed * queue.capacityPerSecond);
  return jam + Math.max(0, (queue.waiting.length + 1 - tokens) / queue.capacityPerSecond);
}

/**
 * Attempt admission for `agentId`. Returns true when the person may enter now. People who are
 * not at the head of the FIFO wait even if a token exists, preventing queue jumping.
 */
export function tryAdmit(queue: EdgeQueueState, agentId: number, now: number, atEntrance: (id: number) => boolean = () => true): boolean {
  refillEdgeQueue(queue, now);
  const position = queue.waiting.indexOf(agentId);
  // Only people physically at the entrance can step in; among them, first come first served
  // (a "zipper" where several lines merge, without anyone walking through the people in front).
  let admit = queue.tokens >= 1 && atEntrance(agentId);
  if (admit) {
    // Count people ahead who are also at the entrance, stopping as soon as they use up the tokens.
    const free = Math.floor(queue.tokens);
    let ahead = 0;
    const end = position < 0 ? queue.waiting.length : position;
    for (let index = 0; index < end && ahead < free; index += 1) if (atEntrance(queue.waiting[index])) ahead += 1;
    admit = ahead < free;
  }
  if (admit) {
    if (position >= 0) queue.waiting.splice(position, 1);
    queue.tokens -= 1;
    queue.entries += 1;
    refillEdgeQueue(queue, now);
    return true;
  }
  if (position < 0) queue.waiting.push(agentId);
  return false;
}

/**
 * Competitive admission (no line). `rank` is this person's place among the people physically at
 * the mouth right now, ordered by how hard they press forward (closeness to the opening, personal
 * pushiness, stress, momentary luck) — computed by the caller. The `free` best-placed people get
 * through when capacity allows; after a crowded admission the opening may jam for a moment.
 * Returns true when the person passes now.
 */
export function tryAdmitCompetitive(queue: EdgeQueueState, agentId: number, now: number, rank: number | null, contenders: number): boolean {
  refillEdgeQueue(queue, now);
  const position = queue.waiting.indexOf(agentId);
  const free = Math.floor(queue.tokens);
  if (rank !== null && free >= 1 && rank < free && now >= queue.clogUntil) {
    if (position >= 0) queue.waiting.splice(position, 1);
    queue.tokens -= 1;
    queue.entries += 1;
    const p = clogProbability(queue.competitiveness, queue.width, contenders);
    if (p > 0 && unit01(queue.key, queue.entries * 2) < p) {
      const duration = clogDuration(unit01(queue.key, queue.entries * 2 + 1));
      queue.clogUntil = now + duration;
      queue.clogs += 1;
      queue.cloggedSeconds += duration;
      queue.tokens = Math.min(queue.tokens, 0);
    }
    refillEdgeQueue(queue, now);
    return true;
  }
  if (position < 0) queue.waiting.push(agentId);
  return false;
}

/** Wait in line without consuming capacity (used when there is no free space to step into). */
export function joinQueue(queue: EdgeQueueState, agentId: number) {
  if (!queue.waiting.includes(agentId)) queue.waiting.push(agentId);
}

/** Remove an agent from the FIFO (reroute, incapacitation, reset). Returns true if it was queued. */
export function leaveQueue(queue: EdgeQueueState | undefined, agentId: number): boolean {
  if (!queue) return false;
  const position = queue.waiting.indexOf(agentId);
  if (position < 0) return false;
  queue.waiting.splice(position, 1);
  return true;
}
