export const LAYER_IDS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type LayerId = (typeof LAYER_IDS)[number];
