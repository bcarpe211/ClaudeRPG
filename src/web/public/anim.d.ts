export function isFrameA(fileIndex: number): boolean;
export function framePartner(fileIndex: number): number;
export function frameAt(nowMs: number, periodMs: number): 0 | 1;
export interface AnimationController {
  pause(): void;
  resume(): void;
  stop(): void;
  isPaused(): boolean;
}
export function start(opts?: { periodMs?: number }): AnimationController;
