/**
 * Public entry of the engine (framework-agnostic). Owner: GAMEPLAY.
 * The standalone build calls require('index').createGame(canvas, { standalone: true }).
 */
export { createGame } from './game';
export type { GameOptions, GameHandle, GameMode, DebugApi, DebugState } from './types';
