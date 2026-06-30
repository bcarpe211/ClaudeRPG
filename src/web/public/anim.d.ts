export function isFrameA(fileIndex: number): boolean;
export function framePartner(fileIndex: number): number;
export function frameAt(nowMs: number, periodMs: number): 0 | 1;
export function start(opts?: { periodMs?: number }): void;
