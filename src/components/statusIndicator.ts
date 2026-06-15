// Shared geometry for the agent status indicators (WorkingSpinner, BlockedIndicator,
// StatusDot) so the three read as one set. All are drawn in a `0 0 24 24` box and
// centered, then rendered at size-3 in the status slot.
export const CENTER = 12;
export const DOT_R = 3.25; // small dot: the center of blocked
export const RING_R = 7.5; // ring: blocked's ring + working's rotating band
export const RING_W = 1.75; // ring stroke thickness
// Idle/unknown dot: a solid disc filling up to the ring's inner edge — i.e. the
// blocked center dot plus the gap out to where the ring starts.
export const INNER_R = RING_R - RING_W / 2;
