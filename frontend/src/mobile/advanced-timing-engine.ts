export type AdvancedMode = 'individual' | 'individual-shoot-off' | 'team' | 'mixed' | 'team-shoot-off' | 'mixed-shoot-off';
export type Side = 'A' | 'B';
export type AdvancedPhase = 'prepare' | 'shoot' | 'stopped' | 'scoring';
type Sides = Record<Side, number>;
type Action = 'tick' | 'confirm' | 'stop' | 'score';

const rules = {
  individual: { arrowsPerSide: 3, arrowsPerTurn: 1, seconds: 20, shared: false },
  'individual-shoot-off': { arrowsPerSide: 1, arrowsPerTurn: 1, seconds: 20, shared: false },
  team: { arrowsPerSide: 6, arrowsPerTurn: 3, seconds: 120, shared: true },
  mixed: { arrowsPerSide: 4, arrowsPerTurn: 2, seconds: 80, shared: true },
  'team-shoot-off': { arrowsPerSide: 3, arrowsPerTurn: 1, seconds: 60, shared: true },
  'mixed-shoot-off': { arrowsPerSide: 2, arrowsPerTurn: 1, seconds: 40, shared: true },
} as const;

export type AdvancedTiming = {
  mode: AdvancedMode;
  firstSide: Side;
  phase: AdvancedPhase;
  turnIndex: number;
  turnStartedAt: number;
  arrowsInTurn: number;
  clockMs: Sides;
  confirmed: Sides;
};

export function startAdvanced(mode: AdvancedMode, firstSide: Side, now: number): AdvancedTiming {
  const milliseconds = rules[mode].seconds * 1000;
  return {
    mode, firstSide, phase: 'prepare', turnIndex: 0, turnStartedAt: now + 10_000,
    arrowsInTurn: 0, clockMs: { A: milliseconds, B: milliseconds }, confirmed: { A: 0, B: 0 },
  };
}

function sideForTurn(firstSide: Side, turnIndex: number): Side {
  if (turnIndex % 2 === 0) return firstSide;
  return firstSide === 'A' ? 'B' : 'A';
}

function turnCount(mode: AdvancedMode): number {
  const rule = rules[mode];
  return 2 * rule.arrowsPerSide / rule.arrowsPerTurn;
}

function endOfTurn(state: AdvancedTiming): number {
  const side = sideForTurn(state.firstSide, state.turnIndex);
  return state.turnStartedAt + state.clockMs[side];
}

function finishTurn(state: AdvancedTiming, now: number): AdvancedTiming {
  const rule = rules[state.mode];
  const side = sideForTurn(state.firstSide, state.turnIndex);
  const clockMs = { ...state.clockMs };
  if (rule.shared) clockMs[side] = Math.max(0, endOfTurn(state) - now);

  const count = turnCount(state.mode);
  let turnIndex = state.turnIndex + 1;
  while (turnIndex < count && clockMs[sideForTurn(state.firstSide, turnIndex)] === 0) turnIndex++;
  if (turnIndex >= count) {
    return { ...state, turnIndex, phase: 'stopped', clockMs: rule.shared ? clockMs : { A: 0, B: 0 } };
  }
  return { ...state, turnIndex, turnStartedAt: now, arrowsInTurn: 0, clockMs };
}

function tick(state: AdvancedTiming, now: number): { state: AdvancedTiming; signals: number[] } {
  let next = state;
  let signals: number[] = [];
  if (next.phase === 'prepare' && now >= next.turnStartedAt) {
    if (now - next.turnStartedAt < 1000) signals = [1];
    next = { ...next, phase: 'shoot' };
  }
  while (next.phase === 'shoot' && now >= endOfTurn(next)) {
    const cutoff = endOfTurn(next);
    next = finishTurn(next, cutoff);
    if (next.phase === 'stopped' && now - cutoff < 1000) signals = [2];
  }
  return { state: next, signals };
}

export function updateAdvanced(state: AdvancedTiming, action: Action, now: number): { state: AdvancedTiming; signals: number[] } {
  if (action === 'score' && state.phase === 'stopped') {
    return { state: { ...state, phase: 'scoring' }, signals: [3] };
  }

  const elapsed = tick(state, now);
  const current = elapsed.state;
  if (action === 'stop' && (current.phase === 'prepare' || current.phase === 'shoot')) {
    const clockMs = { ...current.clockMs };
    if (current.phase === 'shoot') {
      const side = sideForTurn(current.firstSide, current.turnIndex);
      clockMs[side] = Math.max(0, endOfTurn(current) - now);
    }
    return { state: { ...current, phase: 'stopped', clockMs }, signals: [2] };
  }

  // A confirmation received after a deadline cannot count for the opponent.
  if (action !== 'confirm' || state.phase !== 'shoot' || current.phase !== 'shoot' || current.turnIndex !== state.turnIndex) {
    return elapsed;
  }

  const side = sideForTurn(current.firstSide, current.turnIndex);
  const confirmed = { ...current.confirmed, [side]: current.confirmed[side] + 1 };
  const next = { ...current, confirmed, arrowsInTurn: current.arrowsInTurn + 1 };
  const continued = next.arrowsInTurn === rules[next.mode].arrowsPerTurn ? finishTurn(next, now) : next;
  return { state: continued, signals: continued.phase === 'stopped' ? [2] : [] };
}

export function advancedView(state: AdvancedTiming, now: number) {
  const rule = rules[state.mode];
  const activeSide = state.phase === 'shoot' ? sideForTurn(state.firstSide, state.turnIndex) : null;
  const seconds = {
    A: Math.ceil(state.clockMs.A / 1000),
    B: Math.ceil(state.clockMs.B / 1000),
  };
  if (activeSide) {
    seconds[activeSide] = Math.max(0, Math.ceil((endOfTurn(state) - now) / 1000));
    if (!rule.shared && state.turnIndex === turnCount(state.mode) - 1) {
      const other = activeSide === 'A' ? 'B' : 'A';
      seconds[other] = 0;
    }
  }
  return {
    seconds, activeSide,
    prepareSeconds: state.phase === 'prepare' ? Math.max(0, Math.ceil((state.turnStartedAt - now) / 1000)) : 0,
    confirmed: state.confirmed,
    arrowsPerSide: rule.arrowsPerSide,
    arrowsThisTurn: activeSide ? rule.arrowsPerTurn - state.arrowsInTurn : 0,
  };
}
