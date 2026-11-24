/**
 * Canvas UI: title, HUD, groove meter, chain counter, pause menu with 3-2-1, game-over card,
 * medals, next-goal line, phase banner, tutorial prompts, toasts, portrait hint, canvas buttons.
 * Owner: UI engineer. Paint primitives live in ui-paint.ts.
 *
 * Contract:
 *  - createUI({ standalone }) once per game. layout(view) on every resize; update(state, realDt)
 *    and draw(ctx, state) once per frame AFTER renderer.draw (ctx is in the base logical transform).
 *  - READ-ONLY on state. UI-private animation state (logo bounce, count-up, button press, hint
 *    timer, cached strings/measurements) lives in this closure. Numbers are drawn digit by digit
 *    (tabular, no string building per frame); strings derived from state are rebuilt / re-measured
 *    only when their source value changes (event time).
 *  - UI scale: everything is authored in "UI px" and multiplied by K (logical u per UI px).
 *    K = max(1, 0.75 / view.s) capped by viewW / 520 and viewH / 500, so text stays legible on
 *    phones (portrait 390x844: K ~ 1.46) and the game's own scale carries it on desktops.
 *  - Buttons: one preallocated UiButton per ButtonId, rects in LOGICAL units, every rect at least
 *    UI.buttonMinCss CSS px (= 48 / view.s logical) and inside the safe area. Visibility per mode:
 *      title:    sound, motion                      (toggle pills, top-right)
 *      playing:  pause, sound                       (round icons, top-right)
 *      paused:   resume, restart, sound, motion     (menu rows; none during the 3-2-1 countdown)
 *      dying:    none
 *      gameover: sound (top-right), copy (standalone only, in the card)
 *    Rects are recomputed only when the view version, the mode or the countdown flag changes.
 *    hitTest(state, lx, ly) re-syncs from state (it can be called between frames from input
 *    handlers) and returns the id or null. Keyboard shortcuts cover every button.
 *  - Next build (state.standalone false): the top-left UI.domLinkClearW x domLinkClearH CSS px box
 *    is kept clear on title / paused / gameover (DOM "Back to site" link) and the bottom ~28 CSS px
 *    on title (DOM footer).
 *  - Font: FONT_STACK, bold, light fill over a 4 u (x K) dark stroke.
 *  - Reduced motion (state.save.reducedMotion): transitions become fades, nothing flashes or
 *    bounces (logo letters glow on the beat instead of hopping).
 *  - Tutorial pills (slam / boing / hold / drum) sit above their anchor with a tail pointing at it,
 *    inside the safe view (8 CSS px), below the HUD, never over Toto or his chain counter (parked
 *    beside him when there is no room above). SLAM / BOING anchored on Toto follow him.
 *  - TOTOTO TIME entry banner from fever.introT (pop 0 -> 1.3 -> 1, fade out by 1.25 s, white
 *    flash for 0.08 s; fade only in reduced motion); the chain counter hides for its first 0.6 s.
 *  - Tall portrait (cssH / cssW > 1.3): pause panel + game-over card centred at 52 % of the height.
 *    The card never covers the top-right sound button. The rotate hint shows once per page load.
 */
import {
  CHAIN_HUES,
  DEATH,
  FEVER,
  GOALS,
  GROOVE,
  GROUND_Y,
  MEDALS,
  MULT_COLORS,
  PAL,
  POWERUP,
  UI,
  UI_TEXT,
} from './config';
import type { ButtonId, GameMode, Medal, ReadState, UiApi, UiButton, ViewMetrics } from './types';
import { hueIndex, medalFor } from './state';
import type { Seg } from './ui-paint';
import {
  COL,
  TAU,
  circle,
  clamp01,
  drawMedal,
  drawNum,
  drawSegs,
  easeInCubic,
  easeOutBack,
  easeOutBounce,
  easeOutCubic,
  easeOutElastic,
  fmtInt,
  fontPx,
  iconArrow,
  iconCheck,
  iconCopy,
  iconDrum,
  iconFlag,
  iconMagnet,
  iconMango,
  iconMotion,
  iconMud,
  iconNote,
  iconPause,
  iconPlay,
  iconRestart,
  iconRotate,
  iconSpeaker,
  iconStomp,
  keycap,
  makeNumFont,
  measureNumFont,
  measureSegs,
  mixHex,
  numWidth,
  outlined,
  richLine,
  rrect,
  starPath,
  sticker,
  toggleSwitch,
} from './ui-paint';

export interface UiOptions {
  standalone: boolean;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const BUTTON_IDS: ReadonlyArray<ButtonId> = ['pause', 'sound', 'motion', 'resume', 'restart', 'copy'];
const BTN_LABEL: { [K in ButtonId]: string } = {
  pause: 'Pause',
  sound: 'Sound',
  motion: 'Reduced motion',
  resume: 'Resume',
  restart: 'Restart',
  copy: 'Copy score',
};
const I_PAUSE = 0;
const I_SOUND = 1;
const I_MOTION = 2;
const I_RESUME = 3;
const I_RESTART = 4;
const I_COPY = 5;

/** Button visual styles. */
const ST_ROUND = 0;
const ST_PILL = 1;
const ST_ROW = 2;
const ST_CARD = 3;

const MULT_STR: ReadonlyArray<string> = ['', '×1', '×2', '×3', '×4', '×5'];
const COUNT_STR: ReadonlyArray<string> = ['', '1', '2', '3'];
const COUNT_COL: ReadonlyArray<string> = [COL.text, COL.green, COL.warm, COL.red];
const MEDAL_NAME: { [K in Medal]: string } = { none: 'NO MEDAL', bronze: 'BRONZE', silver: 'SILVER', gold: 'GOLD' };
const MEDAL_TEXT_COL: { [K in Medal]: string } = {
  none: COL.dimmer,
  bronze: '#F2B07E',
  silver: '#E6ECF5',
  gold: '#FFD34D',
};

const S_X = 'x';
const S_M = ' m';
const S_BEST = 'BEST';
const S_NEW_BEST_HUD = 'NEW BEST!';
const S_GROOVE = 'GROOVE';
const S_SCORE = 'SCORE';
const S_NEXT_GOAL = 'NEXT GOAL';
const S_GOAL_DONE = 'GOAL DONE';
const S_ALL_GOALS = 'Every goal complete!';
const S_DISTANCE = 'DISTANCE';
const S_CHAIN = 'BEST CHAIN';
const S_MANGOES = 'MANGOES';
const S_STOMPS = 'STOMPS';
const S_NEW = 'NEW';
const S_BEST_BANG = 'BEST!';
const S_KEYS = 'P / Esc resume  ·  R restart  ·  M mute';
const S_GOAL_PREFIX = 'GOAL';

/** Real seconds the card takes to drop in, and when the count-up starts. */
const CARD_IN = 0.55;
const COUNT_START = 0.35;

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createUI(opts: UiOptions): UiApi {
  const standalone = !!opts.standalone;

  /* ---------------- buttons ---------------- */
  const buttons: UiButton[] = [];
  const bStyle: number[] = [];
  /** Pill labels shrunk to fit their pill (phones: pills are >= 48 CSS px tall, text scales by K). Built once per layout/size. */
  const pillFont: string[] = [];
  const pillFitW: number[] = [];
  const pillFitGen: number[] = [];
  /** Real s since the button was last pressed (press squish). */
  const bPress: number[] = [];
  /** Animated switch position 0..1 (sound / motion toggles). */
  const bSwitch: number[] = [];
  for (let i = 0; i < BUTTON_IDS.length; i++) {
    const id = BUTTON_IDS[i];
    buttons.push({ id, x: 0, y: 0, w: 0, h: 0, label: BTN_LABEL[id], visible: false });
    pillFont.push('');
    pillFitW.push(-1);
    pillFitGen.push(-1);
    bStyle.push(ST_ROUND);
    bPress.push(99);
    bSwitch.push(0);
  }

  /* ---------------- rich text (per instance: widths are measured per scale) ---------------- */
  const how1 = richLine(UI_TEXT.howTo1, COL.text);
  const how2Full = richLine(UI_TEXT.howTo2, COL.text);
  const sepIdx = UI_TEXT.howTo2.indexOf(' · ');
  const how2a = richLine(sepIdx >= 0 ? UI_TEXT.howTo2.substring(0, sepIdx) : UI_TEXT.howTo2, COL.text);
  const how2b = richLine(sepIdx >= 0 ? UI_TEXT.howTo2.substring(sepIdx + 3) : '', COL.text);
  const tutSlamTouch = richLine(UI_TEXT.tutSlam, COL.ink);
  const tutSlamKey = richLine(UI_TEXT.tutSlamKey, COL.ink);
  const tutBoingTouch = richLine(UI_TEXT.tutBoing, COL.ink);
  const tutBoingKey = richLine(UI_TEXT.tutBoingKey, COL.ink);
  const tutHoldTouch = richLine(UI_TEXT.tutHold, COL.ink);
  const tutHoldKey = richLine(UI_TEXT.tutHoldKey, COL.ink);
  const tutDrum = richLine(UI_TEXT.tutDrum, COL.ink);
  // On the light tutorial pill keywords need darker tones to read well.
  darkenKeywords(tutSlamTouch);
  darkenKeywords(tutSlamKey);
  darkenKeywords(tutBoingTouch);
  darkenKeywords(tutBoingKey);
  darkenKeywords(tutHoldTouch);
  darkenKeywords(tutHoldKey);
  darkenKeywords(tutDrum);

  /* ---------------- logo ---------------- */
  const logoText = UI_TEXT.logo;
  const letters: string[] = [];
  /** 0 = first word (HIPPO), 1 = second word (TOTOTO). */
  const letterWord: number[] = [];
  /** Index of the letter within its word. */
  const letterIdx: number[] = [];
  const letterX: number[] = [];
  const letterRow: number[] = [];
  const letterW100: number[] = [];
  const letterFillTop: string[] = [];
  const letterFillBot: string[] = [];
  const letterGrad: (CanvasGradient | null)[] = [];
  {
    let word = 0;
    let wi = 0;
    for (let i = 0; i < logoText.length; i++) {
      const ch = logoText.charAt(i);
      if (ch === ' ') {
        word = 1;
        wi = 0;
        continue;
      }
      letters.push(ch);
      letterWord.push(word);
      letterIdx.push(wi);
      letterX.push(0);
      letterRow.push(0);
      letterW100.push(0);
      const base = word === 0 ? '#FFE2B8' : CHAIN_HUES[wi % CHAIN_HUES.length];
      letterFillTop.push(word === 0 ? '#FFFFFF' : mixHex(base, '#FFFFFF', 0.45));
      letterFillBot.push(base);
      letterGrad.push(null);
      wi++;
    }
  }
  const nLetters = letters.length;

  /* ---------------- view-derived ---------------- */
  let vw = 760;
  let vh = 540;
  let s = 1;
  let K = 1;
  let M = 16;
  let minBtn = 48;
  let sL = 0;
  let sR = 0;
  let sT = 0;
  let sB = 0;
  let portrait = false;
  /** Tall portrait (cssH / cssW > 1.3): cards centre at 52 % of the height, in thumb reach. */
  let tall = false;
  let heroX = 167;
  let offsetY = 0;
  let domW = 0;
  let domH = 0;
  let viewVersion = -1;
  /** Bumped by layout(): fonts/measurements/derived positions must be rebuilt. */
  let layoutGen = 0;
  let measuredGen = -1;

  /* ---------------- fonts (built in layout) ---------------- */
  let F_SUB = '';
  let F_HOW = '';
  let F_START = '';
  let F_LABEL = '';
  let F_SMALL = '';
  let F_PILL = '';
  let F_ROW = '';
  let F_BANNER = '';
  let F_TOAST = '';
  let F_TUT_BIG = '';
  let F_TUT = '';
  let F_PAUSED = '';
  let F_COUNT = '';
  let F_MULT = '';
  let F_X = '';
  let F_HINT = '';
  let F_LOGO = '';
  let F_TITLE_LBL = '';
  let F_GOAL_TITLE = '';
  let F_FEVER = '';
  let F_FEVER_BIG = '';
  let feverBigSize = 60;
  let feverBigGrad: CanvasGradient | null = null;
  // card (scaled by ck)
  let F_CAPTION = '';
  let F_CARD_LABEL = '';
  let F_CARD_LINE = '';
  let F_STAT_LABEL = '';
  let F_RETRY = '';
  let F_NEWBEST = '';
  let F_MEDAL_NAME = '';
  let F_MEDAL_SUB = '';
  let F_GOAL = '';
  let F_COPY = '';
  const NF_SCORE = makeNumFont();
  const NF_DIST = makeNumFont();
  const NF_BEST = makeNumFont();
  const NF_CHAIN = makeNumFont();
  const NF_TITLE_BEST = makeNumFont();
  const NF_CARD_SCORE = makeNumFont();
  const NF_STAT = makeNumFont();

  /* ---------------- measured widths / derived layout ---------------- */
  let logoSize = 60;
  let logoTwoRows = false;
  let logoRowW0 = 0;
  let logoRowW1 = 0;
  let how1W = 0;
  let how2FullW = 0;
  let how2aW = 0;
  let how2bW = 0;
  let howWrap = false;
  let wX = 0; // 'x' width (chain)
  let wM = 0; // ' m' width (HUD distance)
  let wBestLbl = 0;
  let wTitleBestLbl = 0;
  let wStatM = 0;
  let wStatX = 0;
  let wMultMax = 0;
  let wSub = 0;
  let feverLblW = 0;
  const feverChars: string[] = [];
  const feverCharW: number[] = [];
  for (let i = 0; i < UI_TEXT.fever.length; i++) {
    feverChars.push(UI_TEXT.fever.charAt(i));
    feverCharW.push(0);
  }

  // title layout
  let tLogoBase0 = 0;
  let tLogoBase1 = 0;
  let tSubY = 0;
  let tHowY = 0;
  let tHowH = 0;
  let tHowW = 0;
  let tStartY = 0;
  let tStartW = 0;
  let tStartH = 0;
  let tBestY = 0;
  let tGoalY = 0;
  let tBlockCx = 0;
  let tLogoCx = 0;
  let titleTogglesBottom = false;
  /** Max logo letter hop height (u), so hops stay inside the reserved bounce room. */
  let tHopMax = 20;

  // HUD layout
  let hudX = 0;
  let hudScoreBase = 0;
  let hudLine2Base = 0;
  let hudIconsY = 0;
  let gx = 0;
  let gy = 0;
  let gW = 0;
  let gH = 0;
  let bannerY = 0;
  let toastY = 0;
  let grooveGrad: CanvasGradient | null = null;
  let feverGrad: CanvasGradient | null = null;

  // pause panel
  let pnX = 0;
  let pnY = 0;
  let pnW = 0;
  let pnH = 0;
  let pnGrid = false;

  // card (card-local units are "card px"; logical = cardX/Y + local * ck)
  const CARD_W = 460;
  let cardW = CARD_W;
  let cardH = 0;
  let ck = 1;
  let cardX = 0;
  let cardY = 0;
  let cRetryY = 0;
  let cCopyY = 0;
  let cCopyH = 0;

  /* ---------------- per-mode button layout key ---------------- */
  let keyMode: GameMode | '' = '';
  let keyCountdown = false;
  let keyVersion = -1;

  /* ---------------- animation state ---------------- */
  let lastMode: GameMode | '' = '';
  let hudAlpha = 0;
  let grooveDisp = 0;
  let lastScore = 0;
  let scoreBumpT = 99;
  let lastMult = 1;
  let multPopT = 99;
  let lastChain = 0;
  let chainShown = 0;
  let chainPopT = 99;
  let chainFadeT = 99;
  let lastShield = false;
  let shieldPopT = 99;
  let shieldLostT = 99;
  let lastMagnet = false;
  let magnetPopT = 99;
  let lastFever = false;
  let feverBurstT = 99;
  let grooveFullT = 99;
  let hintState = 0; // 0 not shown, 1 showing, 2 done
  let hintT = 0;
  let pauseAnimT = 0;
  let lastBestHud = false;
  let bestHudT = 99;
  let lastRunTime = 0;

  /* ---------------- cached event-time strings ---------------- */
  let pauseInfo = '';
  let capLine0 = '';
  let capLine1 = '';
  let capSource = '';
  let capGen = -1;
  let gapLine = '';
  let gapColor: string = COL.dim;
  let medalSub = '';
  let goalLine0 = '';
  let goalLine1 = '';
  let bannerText = '';
  let bannerW = 0;
  let bannerGen = -1;
  let toastText = '';
  let toastW = 0;
  let toastGen = -1;
  let tutKey = '';
  let tutW = 0;
  let tutGen = -1;
  let tutSegs: Seg[] = tutSlamTouch;
  let titleGoalIndex = -1;
  let titleGoalText = '';
  let titleGoalW = 0;
  let titleGoalGen = -1;
  let wGoalPrefix = 0;

  /* ================================================================ */
  /* Layout                                                            */
  /* ================================================================ */

  function layout(view: ViewMetrics): void {
    vw = view.viewW;
    vh = view.viewH;
    s = view.s > 0 ? view.s : 1;
    sL = view.safeL;
    sR = view.safeR;
    sT = view.safeT;
    sB = view.safeB;
    portrait = view.portrait;
    tall = view.cssH > view.cssW * 1.3;
    heroX = view.heroX;
    offsetY = view.offsetY;
    viewVersion = view.version;
    minBtn = UI.buttonMinCss / s;
    let k = 0.75 / s;
    if (k < 1) k = 1;
    if (k > vw / 520) k = vw / 520;
    if (k > vh / 500) k = vh / 500;
    K = k;
    M = UI.margin * K;
    domW = standalone ? 0 : UI.domLinkClearW / s;
    domH = standalone ? 0 : UI.domLinkClearH / s;
    buildFonts();
    layoutGen++;
    keyVersion = -1;
  }

  function buildFonts(): void {
    F_SUB = fontPx(25 * K, '900');
    F_HOW = fontPx(18 * K, '700');
    F_START = fontPx(25 * K, '900');
    F_LABEL = fontPx(11.5 * K, '800');
    F_SMALL = fontPx(15 * K, '700');
    F_PILL = fontPx(16 * K, '800');
    F_ROW = fontPx(19 * K, '800');
    F_BANNER = fontPx(23 * K, '900');
    F_TOAST = fontPx(17 * K, '800');
    F_TUT_BIG = fontPx(34 * K, '900');
    F_TUT = fontPx(17 * K, '900');
    F_PAUSED = fontPx(46 * K, '900');
    F_COUNT = fontPx(150 * K, '900');
    F_MULT = fontPx(17 * K, '900');
    F_X = fontPx(24 * K, '900');
    F_HINT = fontPx(17 * K, '800');
    F_TITLE_LBL = fontPx(14 * K, '800');
    F_GOAL_TITLE = fontPx(15 * K, '700');
    F_FEVER = fontPx(19 * K, '900');
  }

  function buildCardFonts(): void {
    F_CAPTION = fontPx(18 * ck, 'italic 700');
    F_CARD_LABEL = fontPx(12 * ck, '800');
    F_CARD_LINE = fontPx(16 * ck, '800');
    F_STAT_LABEL = fontPx(10.5 * ck, '800');
    F_RETRY = fontPx(23 * ck, '900');
    F_NEWBEST = fontPx(15 * ck, '900');
    F_MEDAL_NAME = fontPx(16 * ck, '900');
    F_MEDAL_SUB = fontPx(12.5 * ck, '700');
    F_GOAL = fontPx(15 * ck, '800');
    F_COPY = fontPx(16 * ck, '800');
  }

  /** Card geometry: independent of text measurement so hitTest works before any draw. */
  function computeCard(): void {
    const availW = (vw - sL - sR - 2 * M) / K;
    cardW = availW < CARD_W ? availW : CARD_W;
    const base = 20 + 46 + 8 + 16 + 62 + 24 + 12 + 84 + 10 + 66 + 12 + 54;
    cRetryY = base - 54;
    let topLimit = sT + M * 0.6;
    const bottomLimit = vh - sB - M * 0.6;
    const cardLeftFull = vw / 2 - (cardW * K) / 2;
    if (!standalone && cardLeftFull < sL + domW) topLimit = sT + domH + 6 * K;
    // never under / over the top-right sound button
    const btn = Math.max(minBtn, 46 * K);
    const cardRightMax = Math.max(vw / 2 + (cardW * K) / 2, portrait ? 0 : heroX + 58 + cardW * K);
    if (cardRightMax > vw - sR - M - btn - 6 * K) topLimit = Math.max(topLimit, sT + 16 * K + btn);
    let bottom = bottomLimit;
    const aboveToto = GROUND_Y + offsetY - 150;
    if (portrait && !tall && aboveToto - topLimit >= cardBaseH(base) * K && aboveToto < bottom) bottom = aboveToto;
    const avail = bottom - topLimit;
    cCopyH = 46;
    ck = K;
    // two passes: the copy button must stay a full-size hit target after scaling
    for (let pass = 0; pass < 3; pass++) {
      let h = base;
      if (standalone) {
        h += 10;
        cCopyY = h;
        h += cCopyH;
      }
      h += 18;
      cardH = h;
      ck = cardH * K > avail ? avail / cardH : K;
      if (!standalone || cCopyH * ck >= minBtn - 0.01) break;
      cCopyH = minBtn / ck;
    }
    cardX = vw / 2 - (cardW * ck) / 2;
    if (!portrait) {
      // landscape: keep Toto's dizzy sit visible left of the card when there is room
      const minLeft = heroX + 58;
      const maxLeft = vw - sR - M * 0.6 - cardW * ck;
      if (cardX < minLeft) cardX = minLeft < maxLeft ? minLeft : Math.max(cardX, maxLeft);
    }
    let y = (tall ? vh * 1.04 : topLimit + bottom) / 2 - (cardH * ck) / 2;
    if (y > bottom - cardH * ck) y = bottom - cardH * ck;
    if (y < topLimit) y = topLimit;
    cardY = y;
    buildCardFonts();
  }

  function cardBaseH(base: number): number {
    return base + (standalone ? 10 + 46 : 0) + 18;
  }

  function computePausePanel(): void {
    const rowH = Math.max(minBtn, 52 * K);
    const gap = 10 * K;
    const pad = 22 * K;
    const header = 104 * K;
    const maxW = vw - sL - sR - 2 * M;
    let w = 380 * K;
    if (w > maxW) w = maxW;
    let h = pad + header + 4 * rowH + 3 * gap + pad;
    let topLimit = sT + M;
    const bottomLimit = vh - sB - M - 26 * K; // keyboard hint line below
    pnGrid = false;
    if (h > bottomLimit - topLimit) {
      pnGrid = true;
      w = 600 * K;
      if (w > maxW) w = maxW;
      h = pad + header + 2 * rowH + gap + pad;
    }
    const left = vw / 2 - w / 2;
    if (!standalone && left < sL + domW) topLimit = Math.max(topLimit, sT + domH + 6 * K);
    let y = (tall ? vh * 1.04 : topLimit + bottomLimit) / 2 - h / 2;
    if (y > bottomLimit - h) y = bottomLimit - h;
    if (y < topLimit) y = topLimit;
    pnX = left;
    pnY = y;
    pnW = w;
    pnH = h;
    // rows
    const rx = pnX + pad;
    const ry = pnY + pad + header;
    const rw = pnW - 2 * pad;
    const ids = PAUSE_ROW_ORDER;
    for (let r = 0; r < ids.length; r++) {
      const b = buttons[ids[r]];
      bStyle[ids[r]] = ST_ROW;
      if (pnGrid) {
        const cw = (rw - gap) / 2;
        b.x = rx + (r % 2) * (cw + gap);
        b.y = ry + Math.floor(r / 2) * (rowH + gap);
        b.w = cw;
      } else {
        b.x = rx;
        b.y = ry + r * (rowH + gap);
        b.w = rw;
      }
      b.h = rowH;
    }
  }

  function placeTopRightRound(i: number, slot: number): void {
    const size = Math.max(minBtn, 46 * K);
    const b = buttons[i];
    b.w = size;
    b.h = size;
    b.x = vw - sR - M - size - slot * (size + 10 * K);
    b.y = sT + 10 * K;
    bStyle[i] = ST_ROUND;
  }

  /**
   * Title toggles. Landscape: two pills at the top-right (side by side when they fit, else
   * stacked). Portrait: a row in the soil under the ground line (the sky is the logo's), above the
   * DOM footer; stacked there when a row does not fit; top-right again if the soil is too thin.
   */
  function placeTitleToggles(): void {
    const h = Math.max(minBtn, 42 * K);
    let w = 244 * K;
    const gap = 10 * K;
    const right = vw - sR - M;
    const bs = buttons[I_SOUND];
    const bm = buttons[I_MOTION];
    bStyle[I_SOUND] = ST_PILL;
    bStyle[I_MOTION] = ST_PILL;
    titleTogglesBottom = false;
    if (portrait) {
      const soilTop = GROUND_Y + offsetY + 34 * K;
      const soilBot = vh - sB - (standalone ? M : 28 / s + 8 * K);
      const rowW = Math.min(w, (vw - sL - sR - 2 * M - gap) / 2);
      const rowFits = rowW >= 200 * K;
      const need = rowFits ? h : 2 * h + gap;
      if (soilBot - soilTop >= need) {
        titleTogglesBottom = true;
        const y0 = (soilTop + soilBot) / 2 - need / 2;
        if (rowFits) {
          w = rowW;
          bs.x = vw / 2 - gap / 2 - w;
          bm.x = vw / 2 + gap / 2;
          bs.y = y0;
          bm.y = y0;
        } else {
          bs.x = vw / 2 - w / 2;
          bm.x = bs.x;
          bs.y = y0;
          bm.y = y0 + h + gap;
        }
        bs.w = w;
        bs.h = h;
        bm.w = w;
        bm.h = h;
        return;
      }
    }
    const side = 2 * w + gap + domW + sL + 2 * M <= vw;
    bs.w = w;
    bs.h = h;
    bm.w = w;
    bm.h = h;
    if (side) {
      bm.x = right - w;
      bs.x = bm.x - gap - w;
      bs.y = sT + 10 * K;
      bm.y = bs.y;
    } else {
      bs.x = right - w;
      bm.x = right - w;
      bs.y = sT + 10 * K;
      bm.y = bs.y + h + gap * 0.8;
    }
  }

  function placeCopy(): void {
    const b = buttons[I_COPY];
    const w = 200;
    b.w = w * ck;
    b.h = cCopyH * ck;
    b.x = cardX + ((cardW - w) / 2) * ck;
    b.y = cardY + cCopyY * ck;
    bStyle[I_COPY] = ST_CARD;
  }

  function syncButtons(state: ReadState): void {
    if (state.view.version !== viewVersion) layout(state.view);
    const mode = state.mode;
    const cd = state.pause.countdown > 0;
    if (mode === keyMode && cd === keyCountdown && viewVersion === keyVersion) return;
    keyMode = mode;
    keyCountdown = cd;
    keyVersion = viewVersion;
    for (let i = 0; i < buttons.length; i++) buttons[i].visible = false;
    switch (mode) {
      case 'title':
        placeTitleToggles();
        buttons[I_SOUND].visible = true;
        buttons[I_MOTION].visible = true;
        break;
      case 'playing':
        placeTopRightRound(I_PAUSE, 0);
        placeTopRightRound(I_SOUND, 1);
        buttons[I_PAUSE].visible = true;
        buttons[I_SOUND].visible = true;
        break;
      case 'paused':
        if (!cd) {
          computePausePanel();
          buttons[I_RESUME].visible = true;
          buttons[I_RESTART].visible = true;
          buttons[I_SOUND].visible = true;
          buttons[I_MOTION].visible = true;
        }
        break;
      case 'gameover':
        computeCard();
        placeTopRightRound(I_SOUND, 0);
        buttons[I_SOUND].visible = true;
        if (standalone) {
          placeCopy();
          buttons[I_COPY].visible = true;
        }
        break;
      default:
        break;
    }
  }

  /* ================================================================ */
  /* Measurement (needs a ctx: done lazily in draw after a layout)      */
  /* ================================================================ */

  function ensureMeasured(ctx: CanvasRenderingContext2D, state: ReadState): void {
    if (measuredGen === layoutGen) return;
    measuredGen = layoutGen;
    measureNumFont(ctx, NF_SCORE, 42 * K, '900');
    measureNumFont(ctx, NF_DIST, 21 * K, '900');
    measureNumFont(ctx, NF_BEST, 15 * K, '800');
    measureNumFont(ctx, NF_CHAIN, 38 * K, '900');
    measureNumFont(ctx, NF_TITLE_BEST, 22 * K, '900');
    ctx.font = F_X;
    wX = ctx.measureText(S_X).width;
    ctx.font = F_SMALL;
    wM = ctx.measureText(S_M).width;
    ctx.font = F_LABEL;
    wBestLbl = ctx.measureText(S_BEST).width;
    ctx.font = F_TITLE_LBL;
    wTitleBestLbl = ctx.measureText(S_BEST).width;
    wGoalPrefix = ctx.measureText(S_GOAL_PREFIX).width;
    ctx.font = F_MULT;
    wMultMax = ctx.measureText(MULT_STR[5]).width;
    ctx.font = F_SUB;
    wSub = ctx.measureText(UI_TEXT.subtitle).width;
    ctx.font = F_FEVER;
    feverLblW = 0;
    for (let i = 0; i < feverChars.length; i++) {
      feverCharW[i] = ctx.measureText(feverChars[i]).width;
      feverLblW += feverCharW[i];
    }
    // TOTOTO TIME entry banner: even its 1.3x overshoot (plus outline) stays within 86 % of the width
    ctx.font = fontPx(100, '900');
    const fw100 = ctx.measureText(UI_TEXT.fever).width;
    feverBigSize = Math.min(80 * K, (vw * 0.86 * 100) / (1.3 * (fw100 + 15)));
    F_FEVER_BIG = fontPx(feverBigSize, '900');
    const fHalf = (fw100 * feverBigSize) / 200;
    feverBigGrad = ctx.createLinearGradient(-fHalf, 0, fHalf, 0);
    for (let i = 0; i < CHAIN_HUES.length; i++) feverBigGrad.addColorStop(i / (CHAIN_HUES.length - 1), CHAIN_HUES[i]);
    measureLogo(ctx);
    // how-to lines: shrink the font when even the wrapped lines would not fit the panel (narrow phones)
    for (let pass = 0; pass < 2; pass++) {
      ctx.font = F_HOW;
      how1W = measureSegs(ctx, how1);
      how2FullW = measureSegs(ctx, how2Full);
      how2aW = measureSegs(ctx, how2a);
      how2bW = measureSegs(ctx, how2b);
      const need = Math.max(how1W, how2aW, how2bW);
      const room = vw - sL - sR - 2 * M - 36 * K;
      if (need <= room) break;
      F_HOW = fontPx((18 * K * room) / need, '700');
    }
    ctx.font = F_START;
    tStartW = ctx.measureText(UI_TEXT.start).width + 56 * K;
    tStartH = 46 * K;
    computeTitle(ctx);
    computeHud(ctx);
    // card + pause geometry and fonts depend on K; re-measure their text
    computeCard();
    measureNumFont(ctx, NF_CARD_SCORE, 58 * ck, '900');
    measureNumFont(ctx, NF_STAT, 23 * ck, '900');
    ctx.font = F_CARD_LINE;
    wStatM = ctx.measureText(S_M).width;
    wStatX = ctx.measureText(S_X).width;
    computePausePanel();
    keyVersion = -1;
    syncButtons(state);
  }

  /** Logo letter widths at 100 px (per 100 px: tracking 4, word space 34). */
  const LOGO_TRACK = 4;
  const LOGO_SPACE = 34;
  let logoRow0_100 = 0;
  let logoRow1_100 = 0;

  function measureLogo(ctx: CanvasRenderingContext2D): void {
    ctx.font = fontPx(100, '900');
    let row0 = 0;
    let row1 = 0;
    for (let i = 0; i < nLetters; i++) {
      letterW100[i] = ctx.measureText(letters[i]).width;
      if (letterWord[i] === 0) row0 += letterW100[i] + (letterIdx[i] > 0 ? LOGO_TRACK : 0);
      else row1 += letterW100[i] + (letterIdx[i] > 0 ? LOGO_TRACK : 0);
    }
    logoRow0_100 = row0;
    logoRow1_100 = row1;
    const availW = vw - sL - sR - 2 * M;
    const single = row0 + LOGO_SPACE + row1;
    // Two rows whenever a single row would get small (portrait phones).
    const sizeSingle = Math.min(86 * K, (availW * 0.92 * 100) / single);
    const sizeDouble = Math.min(128 * K, (availW * 0.9 * 100) / Math.max(row0, row1));
    logoTwoRows = portrait || sizeSingle < 58 * K;
    applyLogoSize(ctx, logoTwoRows ? sizeDouble : sizeSingle);
  }

  /** Letter positions, font and gradients for a logo size. Measure time only. */
  function applyLogoSize(ctx: CanvasRenderingContext2D, size: number): void {
    const track = LOGO_TRACK;
    const space = LOGO_SPACE;
    const row0 = logoRow0_100;
    const row1 = logoRow1_100;
    const single = row0 + space + row1;
    logoSize = size;
    const f = logoSize / 100;
    F_LOGO = fontPx(logoSize, '900');
    logoRowW0 = row0 * f;
    logoRowW1 = row1 * f;
    // letter centres relative to the logo centre
    if (logoTwoRows) {
      let x0 = -logoRowW0 / 2;
      let x1 = -logoRowW1 / 2;
      for (let i = 0; i < nLetters; i++) {
        const w = letterW100[i] * f;
        if (letterWord[i] === 0) {
          if (letterIdx[i] > 0) x0 += track * f;
          letterX[i] = x0 + w / 2;
          letterRow[i] = 0;
          x0 += w;
        } else {
          if (letterIdx[i] > 0) x1 += track * f;
          letterX[i] = x1 + w / 2;
          letterRow[i] = 1;
          x1 += w;
        }
      }
    } else {
      const total = single * f;
      let x = -total / 2;
      for (let i = 0; i < nLetters; i++) {
        const w = letterW100[i] * f;
        if (letterIdx[i] > 0) x += track * f;
        else if (letterWord[i] === 1) x += space * f;
        letterX[i] = x + w / 2;
        letterRow[i] = 0;
        x += w;
      }
    }
    // vertical gradients in letter-local space (baseline at 0, cap top ~ -0.73 size)
    for (let i = 0; i < nLetters; i++) {
      const g = ctx.createLinearGradient(0, -logoSize * 0.74, 0, 0);
      g.addColorStop(0, letterFillTop[i]);
      g.addColorStop(0.55, letterFillBot[i]);
      g.addColorStop(1, letterFillBot[i]);
      letterGrad[i] = g;
    }
  }

  function computeTitle(ctx: CanvasRenderingContext2D): void {
    for (let pass = 0; pass < 2; pass++) {
      const over = layoutTitle();
      if (over <= 0) break;
      // still overflowing with compressed gaps: shrink the logo (never below 70 %)
      const logoH = (logoTwoRows ? logoSize * 1.79 : logoSize * 0.73) + logoSize * 0.1;
      const f = Math.max(0.7, (logoH - over) / logoH);
      applyLogoSize(ctx, logoSize * f);
    }
  }

  /** Vertical title layout; returns how far the content overflows its region (<= 0: fits). */
  function layoutTitle(): number {
    const cap = logoSize * 0.73;
    let bounceRoom = logoSize * (portrait ? 0.16 : 0.2);
    const rowGap = logoSize * 1.06;
    const logoH = (logoTwoRows ? cap + rowGap : cap) + logoSize * 0.1;
    // how-to panel: 2 lines, or 3 when line 2 must wrap
    const howPad = 14 * K;
    const lh = 25 * K;
    const maxHowW = vw - sL - sR - 2 * M - 2 * howPad;
    howWrap = how2FullW > maxHowW;
    tHowW = Math.max(how1W, howWrap ? Math.max(how2aW, how2bW) : how2FullW) + 2 * howPad + 8 * K;
    tHowH = (howWrap ? 3 : 2) * lh + 2 * howPad - 6 * K;
    const subH = 28 * K;
    const bestH = 30 * K;
    const goalH = 22 * K;
    let g1 = 16 * K;
    let g2 = 20 * K;
    let g3 = 22 * K;
    let g4 = 16 * K;

    // region: below the top bar (toggles / DOM link), above Toto
    const groundY = GROUND_Y + offsetY;
    const bm = buttons[I_MOTION];
    placeTitleToggles();
    let top = sT + M * 0.5;
    if (!titleTogglesBottom) top = Math.max(buttons[I_SOUND].y + buttons[I_SOUND].h, bm.y + bm.h) + 8 * K;
    if (!standalone) top = Math.max(top, sT + domH + 4 * K);
    let bottom: number;
    if (portrait) bottom = groundY - 200;
    else bottom = groundY - 8 * K;
    if (!standalone) bottom = Math.min(bottom, vh - sB - 28 / s);
    const fixed = logoH + subH + tHowH + tStartH + bestH + goalH;
    const gaps = bounceRoom + g1 + g2 + g3 + g4;
    const avail = bottom - top;
    if (fixed + gaps > avail) {
      const gs = Math.max(0.35, (avail - fixed) / gaps);
      bounceRoom *= gs;
      g1 *= gs;
      g2 *= gs;
      g3 *= gs;
      g4 *= gs;
    }
    const total = bounceRoom + logoH + g1 + subH + g2 + tHowH + g3 + tStartH + g4 + bestH + goalH;
    tHopMax = Math.max(bounceRoom + logoSize * 0.06, logoSize * 0.08);
    let y = top + Math.max(0, (bottom - top - total) * 0.42);
    y += bounceRoom;
    tLogoBase0 = y + cap;
    tLogoBase1 = tLogoBase0 + rowGap;
    y += logoH + g1;
    tSubY = y + subH * 0.5;
    y += subH + g2;
    tHowY = y;
    y += tHowH + g3;
    tStartY = y + tStartH / 2;
    y += tStartH + g4;
    tBestY = y + bestH / 2;
    y += bestH;
    tGoalY = y + goalH / 2;

    tLogoCx = (sL + vw - sR) / 2;
    // keep the lower block clear of Toto bouncing on his drum (landscape)
    let half = tHowW / 2;
    if (tStartW / 2 > half) half = tStartW / 2;
    if (half < 150 * K) half = 150 * K;
    let cx = tLogoCx;
    const totoRight = heroX + 46;
    const totoTop = groundY - 190;
    if (!portrait && tHowY + tHowH > totoTop && cx - half < totoRight + 14 * K) {
      cx = totoRight + 14 * K + half;
      const maxCx = vw - sR - M - half;
      if (cx > maxCx) cx = maxCx;
    }
    tBlockCx = cx;
    return total - avail;
  }

  function computeHud(ctx: CanvasRenderingContext2D): void {
    hudX = sL + M;
    const top = sT + 10 * K;
    hudScoreBase = top + 36 * K;
    hudLine2Base = hudScoreBase + 25 * K;
    hudIconsY = hudLine2Base + 24 * K;
    const btn = Math.max(minBtn, 46 * K);
    const soundX = vw - sR - M - 2 * btn - 10 * K;
    gH = UI.grooveH * K;
    gW = Math.min(UI.grooveMaxW * K, UI.grooveFrac * vw);
    const leftR = hudX + numWidth(NF_SCORE, 9999999, true) + wMultMax + 26 * K;
    gx = vw / 2 - gW / 2;
    gy = top + 20 * K;
    if (gx < leftR + 12 * K || gx + gW > soundX - 12 * K) {
      const avail = soundX - leftR - 24 * K;
      if (avail >= 150 * K) {
        if (gW > avail) gW = avail;
        gx = (leftR + soundX) / 2 - gW / 2;
      } else {
        // second row (portrait phones): centred under the top bar
        gy = sT + 10 * K + btn + 30 * K;
        const maxW = vw - sL - sR - 2 * M;
        if (gW > maxW) gW = maxW;
        gx = vw / 2 - gW / 2;
      }
    }
    bannerY = Math.max(gy + gH + 44 * K, hudIconsY + 14 * K);
    toastY = vh - sB - 58 * K;
    grooveGrad = ctx.createLinearGradient(gx, 0, gx + gW, 0);
    grooveGrad.addColorStop(0, PAL.grooveA);
    grooveGrad.addColorStop(1, PAL.grooveB);
    feverGrad = ctx.createLinearGradient(gx, 0, gx + gW, 0);
    for (let i = 0; i < CHAIN_HUES.length; i++) feverGrad.addColorStop(i / (CHAIN_HUES.length - 1), CHAIN_HUES[i]);
  }

  /* ================================================================ */
  /* Update                                                            */
  /* ================================================================ */

  function onModeEnter(state: ReadState, mode: GameMode, prev: GameMode | ''): void {
    if (mode === 'paused') {
      pauseAnimT = 0;
      pauseInfo = fmtInt(state.run.score) + ' pts  ·  ' + Math.floor(state.run.distance) + ' m';
    } else if (mode === 'gameover') {
      buildSummaryStrings(state);
    } else if (mode === 'playing' && prev !== 'paused') {
      resetRunAnim();
    }
  }

  function resetRunAnim(): void {
    lastScore = 0;
    lastMult = 1;
    lastChain = 0;
    chainShown = 0;
    chainFadeT = 99;
    chainPopT = 99;
    lastShield = false;
    lastMagnet = false;
    shieldLostT = 99;
    lastFever = false;
    grooveDisp = 0;
    lastBestHud = false;
    bestHudT = 99;
  }

  function buildSummaryStrings(state: ReadState): void {
    const sm = state.summary;
    if (sm.newBest) {
      gapLine = 'New best by ' + fmtInt(sm.bestBy) + '!';
      gapColor = COL.gold;
    } else if (sm.shortBy > 0) {
      gapLine = 'Only ' + fmtInt(sm.shortBy) + ' m short of your best';
      gapColor = COL.dim;
    } else {
      gapLine = 'Best: ' + fmtInt(state.save.best);
      gapColor = COL.dim;
    }
    switch (sm.medal) {
      case 'none':
        medalSub = 'Bronze at ' + fmtInt(MEDALS.bronze);
        break;
      case 'bronze':
        medalSub = 'Silver at ' + fmtInt(MEDALS.silver);
        break;
      case 'silver':
        medalSub = 'Gold at ' + fmtInt(MEDALS.gold);
        break;
      default:
        medalSub = 'Top of the herd!';
        break;
    }
    if (sm.goalDone) {
      goalLine0 = sm.goalDoneText;
      goalLine1 = sm.goalText !== '' ? 'Next: ' + sm.goalText : S_ALL_GOALS;
    } else {
      goalLine0 = sm.goalText !== '' ? sm.goalText : S_ALL_GOALS;
      goalLine1 = '';
    }
    capGen = -1; // caption wrap is measured in draw
  }

  function update(state: ReadState, realDt: number): void {
    syncButtons(state);
    const dt = realDt > 0.1 ? 0.1 : realDt < 0 ? 0 : realDt;
    const mode = state.mode;
    if (mode !== lastMode) {
      const prev = lastMode;
      lastMode = mode;
      onModeEnter(state, mode, prev);
    }
    for (let i = 0; i < bPress.length; i++) if (bPress[i] < 99) bPress[i] += dt;
    // toggle switches ease toward their state
    const sndOn = state.save.muted ? 0 : 1;
    const motOn = state.save.reducedMotion ? 1 : 0;
    bSwitch[I_SOUND] += (sndOn - bSwitch[I_SOUND]) * Math.min(1, dt * 16);
    bSwitch[I_MOTION] += (motOn - bSwitch[I_MOTION]) * Math.min(1, dt * 16);

    const inRun = mode === 'playing' || mode === 'dying';
    const hudTarget = inRun ? 1 : 0;
    const rate = dt / 0.25;
    if (hudAlpha < hudTarget) hudAlpha = Math.min(hudTarget, hudAlpha + rate);
    else if (hudAlpha > hudTarget) hudAlpha = Math.max(hudTarget, hudAlpha - rate);
    if (mode === 'paused') pauseAnimT += dt;

    const r = state.run;
    if (r.time < lastRunTime - 0.25) resetRunAnim(); // restart from the pause menu
    lastRunTime = r.time;
    if (inRun) {
      // score bump on chunky gains
      if (r.score - lastScore >= 10) scoreBumpT = 0;
      lastScore = r.score;
      if (r.multiplier !== lastMult) {
        if (r.multiplier > lastMult) multPopT = 0;
        lastMult = r.multiplier;
      }
      if (r.chain > lastChain) {
        chainPopT = 0;
        chainShown = r.chain;
        chainFadeT = 99;
      } else if (r.chain === 0 && lastChain > 0) {
        chainFadeT = 0;
      } else if (r.chain > 0) {
        chainShown = r.chain;
      }
      lastChain = r.chain;
      const h = state.hero;
      if (h.shield && !lastShield) shieldPopT = 0;
      if (!h.shield && lastShield) shieldLostT = 0;
      lastShield = h.shield;
      const mag = h.magnetT > 0;
      if (mag && !lastMagnet) magnetPopT = 0;
      lastMagnet = mag;
      const fev = state.fever.active;
      if (fev && !lastFever) feverBurstT = 0;
      lastFever = fev;
      const target = fev ? 100 : r.groove;
      grooveDisp += (target - grooveDisp) * Math.min(1, dt * 10);
      if (!fev && r.groove >= GROOVE.flashAbove) grooveFullT += dt;
      else grooveFullT = 0;
      const bestNow = state.save.best > 0 && r.score > state.save.best;
      if (bestNow && !lastBestHud) bestHudT = 0;
      lastBestHud = bestNow;
      if (mode === 'playing' && portrait && hintState === 0 && !portraitHintShown) {
        portraitHintShown = true;
        hintState = 1;
        hintT = 0;
      }
    }
    if (scoreBumpT < 99) scoreBumpT += dt;
    if (multPopT < 99) multPopT += dt;
    if (chainPopT < 99) chainPopT += dt;
    if (chainFadeT < 99) chainFadeT += dt;
    if (shieldPopT < 99) shieldPopT += dt;
    if (shieldLostT < 99) shieldLostT += dt;
    if (magnetPopT < 99) magnetPopT += dt;
    if (feverBurstT < 99) feverBurstT += dt;
    if (bestHudT < 99) bestHudT += dt;
    if (hintState === 1) {
      if (mode === 'playing') hintT += dt;
      // once per page load: a run that ends (or a rotation) mid-hint does not bring it back
      const over = hintT >= UI.portraitHintDur || state.run.time > UI.portraitHintDur + 2;
      if (over || !portrait || mode === 'gameover' || mode === 'title') hintState = 2;
    }
  }

  /* ================================================================ */
  /* Draw helpers                                                      */
  /* ================================================================ */

  /** Common text state: light fill over dark stroke. */
  function ink(ctx: CanvasRenderingContext2D, lw: number): void {
    ctx.strokeStyle = COL.ink;
    ctx.lineWidth = lw;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
  }

  function pressScale(i: number): number {
    const t = bPress[i];
    if (t >= 0.18) return 1;
    return 1 - 0.1 * Math.sin((t / 0.18) * Math.PI);
  }

  function drawButtonIcon(
    ctx: CanvasRenderingContext2D,
    i: number,
    cx: number,
    cy: number,
    r: number,
    state: ReadState,
  ): void {
    switch (i) {
      case I_PAUSE:
        iconPause(ctx, cx, cy, r, COL.text);
        break;
      case I_SOUND:
        iconSpeaker(ctx, cx, cy, r, COL.text, state.save.muted);
        break;
      case I_MOTION:
        iconMotion(ctx, cx, cy, r, COL.text, state.save.reducedMotion);
        break;
      case I_RESUME:
        iconPlay(ctx, cx, cy, r, COL.text);
        break;
      case I_RESTART:
        iconRestart(ctx, cx, cy, r, COL.text);
        break;
      case I_COPY:
        iconCopy(ctx, cx, cy, r, COL.text);
        break;
      default:
        break;
    }
  }

  function drawButtons(ctx: CanvasRenderingContext2D, state: ReadState, alpha: number): void {
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (!b.visible) continue;
      const st = bStyle[i];
      const sc = pressScale(i);
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.scale(sc, sc);
      if (st === ST_ROUND) {
        // drawn disc a bit inside the (>= 48 CSS px) hit rect
        // the drawn disc fills the (>= 48 CSS px) hit rect
        const dr = Math.min(b.w, b.h) / 2 - 1 / s;
        circle(ctx, 0, 2 * K, dr);
        ctx.fillStyle = COL.ink;
        ctx.fill();
        circle(ctx, 0, 0, dr);
        ctx.fillStyle = COL.track;
        ctx.fill();
        ctx.lineWidth = 2.5 * K;
        ctx.strokeStyle = COL.trackEdge;
        ctx.stroke();
        drawButtonIcon(ctx, i, 0, 0, dr * 0.62, state);
      } else {
        const w = b.w;
        const h = b.h;
        const x = -w / 2;
        const y = -h / 2;
        const primary = i === I_RESUME;
        sticker(
          ctx,
          x,
          y,
          w,
          h,
          h / 2,
          3 * K,
          primary ? COL.accent : st === ST_PILL ? COL.track : COL.btn,
          primary ? COL.ink : COL.btnEdge,
          2.5 * K,
        );
        // top shine (subtle on dark buttons)
        rrect(ctx, x + h * 0.4, y + 3.5 * K, w - h * 0.8, h * 0.16, h * 0.08);
        ctx.fillStyle = primary ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.07)';
        ctx.fill();
        const iconR = (st === ST_ROW ? 13 : 12) * K;
        // Pills keep the icon in the design-size cap even when the hit rect is taller (phones).
        const ix = x + (st === ST_PILL ? Math.min(h, 42 * K) : h) * 0.5 + 4 * K;
        drawButtonIcon(ctx, i, ix, 0, iconR, state);
        const tx = ix + iconR + 12 * K;
        if (st === ST_PILL) {
          if (pillFitGen[i] !== layoutGen || pillFitW[i] !== w) {
            // event-time (once per layout / size): shrink the label if it would run into the switch
            pillFitGen[i] = layoutGen;
            pillFitW[i] = w;
            ctx.font = F_PILL;
            const right = i === I_SOUND || i === I_MOTION ? x + w - 54 * K - 8 * K : x + w - 14 * K;
            const lw = ctx.measureText(b.label).width;
            const avail = right - tx;
            pillFont[i] = lw > avail && lw > 0 ? fontPx(Math.max(10 * K, (16 * K * avail) / lw), '800') : F_PILL;
          }
          ctx.font = pillFont[i];
        } else {
          ctx.font = st === ST_ROW ? F_ROW : F_COPY;
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COL.text;
        if (primary) {
          ink(ctx, 4 * K);
          outlined(ctx, b.label, tx, 1 * K);
        } else {
          ctx.fillText(b.label, tx, 1 * K);
        }
        if (i === I_SOUND || i === I_MOTION) {
          const sw = 42 * K;
          const sh = 24 * K;
          toggleSwitch(ctx, x + w - sw - 12 * K, -sh / 2, sw, sh, bSwitch[i]);
        }
      }
      ctx.restore();
    }
  }

  /* ================================================================ */
  /* Title                                                             */
  /* ================================================================ */

  function drawTitle(ctx: CanvasRenderingContext2D, state: ReadState): void {
    const reduced = state.save.reducedMotion;
    const t = state.modeT;
    const now = state.clock.now;
    const m = state.music;
    const beat = m.beat;
    const bp = m.beatPhase;
    const bar = ((beat % 4) + 4) % 4;

    /* --- logo --- */
    ctx.font = F_LOGO;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    const S = logoSize;
    for (let i = 0; i < nLetters; i++) {
      const word = letterWord[i];
      const wi = letterIdx[i];
      const intro = t - 0.15 - i * 0.065;
      if (intro <= 0) continue;
      let alpha = 1;
      let dy = 0;
      let sx = 1;
      let sy = 1;
      let rot = 0;
      let glow = 0;
      if (reduced) {
        alpha = clamp01(intro / 0.35);
      } else if (intro < 0.6) {
        const e = easeOutBounce(intro / 0.6);
        dy = -(1 - e) * (S * 1.6 + 40 * K);
        alpha = clamp01(intro * 10);
        sy = 1 + (1 - e) * 0.18;
        sx = 1 - (1 - e) * 0.1;
      }
      // to-to-TO rhythm: TO pairs hop on beats 0, 1, 2 (the third higher); HIPPO waves on beat 3
      let hopBeat: number;
      let delay: number;
      let amp: number;
      if (word === 1) {
        const pair = Math.floor(wi / 2);
        hopBeat = pair;
        delay = (wi % 2) * 0.09;
        amp = pair === 2 ? 0.3 : 0.18;
      } else {
        hopBeat = 3;
        delay = wi * 0.07;
        amp = 0.1;
      }
      if (intro >= 0.6 && bar === hopBeat) {
        const p = bp - delay;
        if (p > 0) {
          if (reduced) {
            if (p < 0.5) glow = Math.sin((p / 0.5) * Math.PI);
          } else if (p < 0.42) {
            const q = p / 0.42;
            const hgt = Math.sin(q * Math.PI);
            let hop = amp * S;
            const cap = (tHopMax * amp) / 0.3;
            if (hop > cap) hop = cap;
            dy = -hgt * hop;
            sy = 1 + hgt * 0.07;
            sx = 1 - hgt * 0.04;
            rot = (wi % 2 === 0 ? -1 : 1) * hgt * 0.07;
          } else if (p < 0.64) {
            const q = Math.sin(((p - 0.42) / 0.22) * Math.PI);
            sy = 1 - q * 0.13;
            sx = 1 + q * 0.09;
          }
        }
      }
      const lx = tLogoCx + letterX[i];
      const ly = letterRow[i] === 0 ? tLogoBase0 : tLogoBase1;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(lx, ly + dy);
      ctx.rotate(rot);
      ctx.scale(sx, sy);
      const ch = letters[i];
      // extrusion
      ctx.fillStyle = COL.ink;
      ctx.lineWidth = S * 0.15;
      ctx.strokeStyle = COL.ink;
      ctx.strokeText(ch, 0, S * 0.075);
      ctx.fillText(ch, 0, S * 0.075);
      ctx.strokeText(ch, 0, 0);
      const g = letterGrad[i];
      ctx.fillStyle = g !== null ? g : letterFillBot[i];
      ctx.fillText(ch, 0, 0);
      if (glow > 0) {
        ctx.globalAlpha = alpha * glow * 0.55;
        ctx.fillStyle = COL.white;
        ctx.fillText(ch, 0, 0);
      }
      ctx.restore();
    }

    /* --- subtitle with bobbing notes --- */
    const subA = reduced ? clamp01((t - 0.6) / 0.4) : clamp01((t - 0.9) / 0.3);
    if (subA > 0) {
      ctx.globalAlpha = subA;
      ctx.font = F_SUB;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ink(ctx, 5 * K);
      ctx.fillStyle = COL.gold;
      const subDy = reduced ? 0 : (1 - easeOutBack((t - 0.9) / 0.35)) * 10 * K;
      outlined(ctx, UI_TEXT.subtitle, tLogoCx, tSubY + subDy);
      const sw = wSub;
      const bob = reduced ? 0 : Math.sin(bp * TAU) * 3 * K;
      iconNote(ctx, tLogoCx - sw / 2 - 22 * K, tSubY - 2 * K + bob, 11 * K, CHAIN_HUES[3]);
      iconNote(ctx, tLogoCx + sw / 2 + 20 * K, tSubY - 2 * K - bob, 11 * K, CHAIN_HUES[2]);
      ctx.globalAlpha = 1;
    }

    /* --- how-to panel --- */
    const howA = reduced ? clamp01((t - 0.8) / 0.4) : clamp01((t - 1.1) / 0.3);
    if (howA > 0) {
      ctx.globalAlpha = howA;
      const x = tBlockCx - tHowW / 2;
      rrect(ctx, x, tHowY, tHowW, tHowH, 16 * K);
      ctx.fillStyle = COL.panel;
      ctx.fill();
      ctx.lineWidth = 2 * K;
      ctx.strokeStyle = 'rgba(199,210,254,0.28)';
      ctx.stroke();
      ctx.font = F_HOW;
      ctx.textBaseline = 'middle';
      ink(ctx, 4 * K);
      const lh = 25 * K;
      const y0 = tHowY + 14 * K + lh / 2 - 3 * K;
      drawSegs(ctx, how1, tBlockCx - how1W / 2, y0, true);
      if (howWrap) {
        drawSegs(ctx, how2a, tBlockCx - how2aW / 2, y0 + lh, true);
        drawSegs(ctx, how2b, tBlockCx - how2bW / 2, y0 + 2 * lh, true);
      } else {
        drawSegs(ctx, how2Full, tBlockCx - how2FullW / 2, y0 + lh, true);
      }
      ctx.globalAlpha = 1;
    }

    /* --- start prompt --- */
    const stA = reduced ? clamp01((t - 1.0) / 0.4) : clamp01((t - 1.3) / 0.3);
    if (stA > 0) {
      const pulse = 1 - bp;
      const p3 = pulse * pulse * pulse;
      const sc = reduced ? 1 : 1 + 0.06 * p3;
      ctx.save();
      ctx.globalAlpha = stA * (reduced ? 0.8 + 0.2 * Math.sin(now * 2.2) : 1);
      ctx.translate(tBlockCx, tStartY);
      ctx.scale(sc, sc);
      sticker(ctx, -tStartW / 2, -tStartH / 2, tStartW, tStartH, tStartH / 2, 4 * K, COL.accent, COL.ink, 3 * K);
      rrect(ctx, -tStartW / 2 + 16 * K, -tStartH / 2 + 4 * K, tStartW - 32 * K, tStartH * 0.26, tStartH * 0.13);
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fill();
      ctx.font = F_START;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ink(ctx, 5 * K);
      ctx.fillStyle = COL.text;
      outlined(ctx, UI_TEXT.start, 0, 1.5 * K);
      ctx.restore();
    }

    /* --- best + medal, next goal --- */
    const bA = reduced ? clamp01((t - 1.1) / 0.4) : clamp01((t - 1.45) / 0.3);
    if (bA > 0) {
      ctx.globalAlpha = bA;
      const best = state.save.best;
      if (best > 0) {
        const medal = medalFor(best);
        const mr = 13 * K;
        const nw = numWidth(NF_TITLE_BEST, best, true);
        const gap = 8 * K;
        const total = mr * 2 + gap + wTitleBestLbl + gap + nw;
        let x = tBlockCx - total / 2;
        drawMedal(ctx, x + mr, tBestY - 2 * K, mr, medal, 0);
        x += mr * 2 + gap;
        ctx.font = F_TITLE_LBL;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ink(ctx, 4 * K);
        ctx.fillStyle = COL.dim;
        outlined(ctx, S_BEST, x, tBestY + 6 * K);
        x += wTitleBestLbl + gap;
        ink(ctx, 5 * K);
        ctx.fillStyle = COL.text;
        drawNum(ctx, NF_TITLE_BEST, best, x, tBestY + 8 * K, 0, true, true);
      }
      drawTitleGoal(ctx, state);
      ctx.globalAlpha = 1;
    }
  }

  function drawTitleGoal(ctx: CanvasRenderingContext2D, state: ReadState): void {
    const gi = state.save.goalIndex;
    if (gi < 0 || gi >= GOALS.length) return;
    if (gi !== titleGoalIndex || titleGoalGen !== layoutGen) {
      titleGoalIndex = gi;
      titleGoalGen = layoutGen;
      titleGoalText = GOALS[gi].label;
      ctx.font = F_GOAL_TITLE;
      titleGoalW = ctx.measureText(titleGoalText).width;
    }
    const gap = 8 * K;
    const total = wGoalPrefix + gap + titleGoalW;
    const x = tBlockCx - total / 2;
    const y = state.save.best > 0 ? tGoalY + 4 * K : tBestY;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ink(ctx, 4 * K);
    ctx.font = F_TITLE_LBL;
    ctx.fillStyle = COL.gold;
    outlined(ctx, S_GOAL_PREFIX, x, y);
    ctx.font = F_GOAL_TITLE;
    ctx.fillStyle = COL.soft;
    outlined(ctx, titleGoalText, x + wGoalPrefix + gap, y);
  }

  /* ================================================================ */
  /* HUD                                                               */
  /* ================================================================ */

  function drawHud(ctx: CanvasRenderingContext2D, state: ReadState, a: number): void {
    const r = state.run;
    const reduced = state.save.reducedMotion;
    ctx.globalAlpha = a;
    ctx.textBaseline = 'alphabetic';

    /* score */
    let sc = 1;
    if (!reduced && scoreBumpT < 0.2) sc = 1 + 0.1 * Math.sin((scoreBumpT / 0.2) * Math.PI);
    ctx.save();
    ctx.translate(hudX, hudScoreBase - 14 * K);
    ctx.scale(sc, sc);
    ink(ctx, 5.5 * K);
    ctx.fillStyle = COL.text;
    const sw = drawNum(ctx, NF_SCORE, r.score, 0, 14 * K, 0, true, true);
    ctx.restore();

    /* multiplier badge */
    const mult = r.multiplier;
    if (mult > 1 && mult < MULT_STR.length) {
      let ms = 1;
      if (!reduced && multPopT < 0.3) ms = 1 + 0.45 * (1 - easeOutElastic(multPopT / 0.3));
      const bw = wMultMax + 16 * K;
      const bh = 24 * K;
      const bx = hudX + sw * sc + 10 * K + bw / 2;
      const by = hudScoreBase - 13 * K;
      ctx.save();
      ctx.translate(bx, by);
      ctx.scale(ms, ms);
      sticker(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2, 2.5 * K, MULT_COLORS[mult], COL.ink, 2.5 * K);
      ctx.font = F_MULT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = COL.ink;
      ctx.fillText(MULT_STR[mult], 0, 1 * K);
      ctx.restore();
      ctx.textBaseline = 'alphabetic';
    }

    /* distance + best */
    ink(ctx, 4.5 * K);
    ctx.fillStyle = COL.text;
    const dist = Math.floor(r.distance);
    const dw = drawNum(ctx, NF_DIST, dist, hudX, hudLine2Base, 0, false, true);
    ctx.font = F_SMALL;
    ctx.textAlign = 'left';
    ctx.lineWidth = 4 * K;
    outlined(ctx, S_M, hudX + dw, hudLine2Base);
    let x = hudX + dw + wM + 14 * K;
    const best = state.save.best;
    if (best > 0 && r.score > best) {
      let bs = 1;
      if (!reduced && bestHudT < 0.4) bs = 1 + 0.4 * (1 - easeOutElastic(bestHudT / 0.4));
      ctx.save();
      ctx.translate(x, hudLine2Base - 6 * K);
      ctx.scale(bs, bs);
      ctx.font = F_SMALL;
      ctx.fillStyle = COL.gold;
      ink(ctx, 4 * K);
      outlined(ctx, S_NEW_BEST_HUD, 0, 6 * K);
      ctx.restore();
    } else if (best > 0) {
      ctx.font = F_LABEL;
      ctx.fillStyle = COL.dim;
      ink(ctx, 3.5 * K);
      outlined(ctx, S_BEST, x, hudLine2Base - 1 * K);
      x += wBestLbl + 6 * K;
      ctx.fillStyle = COL.dim;
      drawNum(ctx, NF_BEST, best, x, hudLine2Base, 0, true, true);
    }

    /* power-up icons */
    let ix = hudX + 17 * K;
    const iy = hudIconsY;
    const h = state.hero;
    if (h.shield || shieldLostT < 0.4) {
      let is = 1;
      let ia = 1;
      if (h.shield) {
        if (shieldPopT < 0.35) is = reduced ? 1 : easeOutBack(shieldPopT / 0.35);
        if (reduced && shieldPopT < 0.35) ia = shieldPopT / 0.35;
      } else {
        const q = shieldLostT / 0.4;
        is = reduced ? 1 : 1 + q * 0.6;
        ia = 1 - q;
      }
      ctx.save();
      ctx.globalAlpha = a * ia;
      ctx.translate(ix, iy);
      ctx.scale(is, is);
      powerDisc(ctx, 0, COL.mud);
      iconMud(ctx, 0, -1.5 * K, 12 * K);
      ctx.restore();
      ix += 44 * K;
    }
    if (h.magnetT > 0) {
      const frac = clamp01(h.magnetT / POWERUP.magnetDur);
      let is = 1;
      if (magnetPopT < 0.35) is = reduced ? 1 : easeOutBack(magnetPopT / 0.35);
      // blink in the last 1.5 s (steady in reduced motion)
      let ia = 1;
      if (!reduced && h.magnetT < 1.5) ia = 0.55 + 0.45 * (Math.sin(state.clock.now * 18) > 0 ? 1 : 0);
      ctx.save();
      ctx.globalAlpha = a * ia;
      ctx.translate(ix, iy);
      ctx.scale(is, is);
      powerDisc(ctx, frac, COL.gold);
      iconMagnet(ctx, 0, 0, 11.5 * K);
      ctx.restore();
    }
    ctx.globalAlpha = a;

    drawGroove(ctx, state, a);
    ctx.globalAlpha = 1;
  }

  /** Dark disc with a remaining-time ring (frac of a full turn, clockwise from 12 o'clock). */
  function powerDisc(ctx: CanvasRenderingContext2D, frac: number, color: string): void {
    const R = 16 * K;
    circle(ctx, 0, 1.5 * K, R);
    ctx.fillStyle = COL.ink;
    ctx.fill();
    circle(ctx, 0, 0, R);
    ctx.fillStyle = '#FFF4DE';
    ctx.fill();
    ctx.lineWidth = 2.5 * K;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();
    if (frac > 0) {
      // remaining-time ring outside the disc
      ctx.beginPath();
      ctx.arc(0, 0, R + 3.5 * K, -Math.PI / 2, -Math.PI / 2 + TAU * frac);
      ctx.lineWidth = 6 * K;
      ctx.lineCap = 'round';
      ctx.strokeStyle = COL.ink;
      ctx.stroke();
      ctx.lineWidth = 3 * K;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }

  function drawGroove(ctx: CanvasRenderingContext2D, state: ReadState, a: number): void {
    const reduced = state.save.reducedMotion;
    const fev = state.fever.active;
    const now = state.clock.now;
    const bp = state.music.beatPhase;
    const frac = fev ? clamp01(state.fever.t / FEVER.duration) : clamp01(grooveDisp / GROOVE.max);
    const pulseBase = 1 - bp;
    const pulse = state.run.groove > 0 || fev ? pulseBase * pulseBase * pulseBase : 0;
    const sc = reduced ? 1 : 1 + 0.07 * pulse;
    const cx = gx + gW / 2;
    const cy = gy + gH / 2;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    ctx.translate(-cx, -cy);

    // label
    ctx.textBaseline = 'alphabetic';
    if (fev) {
      ctx.font = F_FEVER;
      ctx.textAlign = 'center';
      ink(ctx, 4.5 * K);
      const shift = reduced ? 0 : Math.floor(now * 10);
      let lx = cx - feverLblW / 2;
      for (let i = 0; i < feverChars.length; i++) {
        const w = feverCharW[i];
        const wave = reduced ? 0 : Math.sin(now * 9 - i * 0.7) * 2.5 * K;
        ctx.fillStyle = CHAIN_HUES[(i + shift) % CHAIN_HUES.length];
        outlined(ctx, feverChars[i], lx + w / 2, gy - 6 * K + wave);
        lx += w;
      }
    } else {
      ctx.font = F_LABEL;
      ctx.textAlign = 'left';
      ink(ctx, 3.5 * K);
      ctx.fillStyle = state.run.groove >= GROOVE.flashAbove ? COL.gold : COL.text;
      outlined(ctx, S_GROOVE, gx + 4 * K, gy - 6 * K);
    }

    // track
    sticker(ctx, gx, gy, gW, gH, gH / 2, 2.5 * K, COL.track, COL.ink, 3 * K);

    // fill
    const inset = 3 * K;
    const fh = gH - 2 * inset;
    const fw = (gW - 2 * inset) * frac;
    let fillA = 1;
    if (fev && state.fever.t < FEVER.warn && !reduced) fillA = Math.sin(now * TAU * 5) > -0.2 ? 1 : 0.35;
    if (fw > 1) {
      ctx.globalAlpha = a * fillA;
      rrect(ctx, gx + inset, gy + inset, fw < fh ? fh : fw, fh, fh / 2);
      const grad = fev ? feverGrad : grooveGrad;
      ctx.fillStyle = grad !== null ? grad : PAL.grooveA;
      ctx.fill();
      // shine
      rrect(
        ctx,
        gx + inset + fh * 0.3,
        gy + inset + 1 * K,
        Math.max(0, (fw < fh ? fh : fw) - fh * 0.6),
        fh * 0.32,
        fh * 0.16,
      );
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fill();
      // almost-full flash (>85%): white pulses; steady glow in reduced motion
      if (!fev && state.run.groove >= GROOVE.flashAbove) {
        if (!reduced) {
          const f = 0.5 + 0.5 * Math.sin(grooveFullT * TAU * 4);
          ctx.globalAlpha = a * f * 0.55;
          rrect(ctx, gx + inset, gy + inset, fw, fh, fh / 2);
          ctx.fillStyle = COL.white;
          ctx.fill();
        }
      }
      ctx.globalAlpha = a;
    }
    // notches at 25 / 50 / 75 %
    if (!fev) {
      ctx.strokeStyle = 'rgba(3,7,18,0.45)';
      ctx.lineWidth = 1.5 * K;
      ctx.beginPath();
      for (let q = 1; q < 4; q++) {
        const nx = gx + inset + ((gW - 2 * inset) * q) / 4;
        ctx.moveTo(nx, gy + inset + 1 * K);
        ctx.lineTo(nx, gy + gH - inset - 1 * K);
      }
      ctx.stroke();
    }
    // gold rim when nearly full
    if (!fev && state.run.groove >= GROOVE.flashAbove) {
      rrect(ctx, gx - 1.5 * K, gy - 1.5 * K, gW + 3 * K, gH + 3 * K, (gH + 3 * K) / 2);
      ctx.lineWidth = 2 * K;
      ctx.strokeStyle = COL.gold;
      ctx.stroke();
    }
    ctx.restore();

    // fever start burst ring
    if (feverBurstT < 0.6) {
      const q = feverBurstT / 0.6;
      ctx.globalAlpha = a * (1 - q);
      if (reduced) {
        rrect(ctx, gx - 4 * K, gy - 4 * K, gW + 8 * K, gH + 8 * K, (gH + 8 * K) / 2);
      } else {
        const g = 4 * K + q * 26 * K;
        rrect(ctx, gx - g, gy - g * 0.6, gW + 2 * g, gH + g * 1.2, (gH + g * 1.2) / 2);
      }
      ctx.lineWidth = 3 * K;
      ctx.strokeStyle = COL.gold;
      ctx.stroke();
      ctx.globalAlpha = a;
    }
  }

  /** TOTOTO TIME entry banner, from fever.introT (real s since the fever started). */
  function drawFeverIntro(ctx: CanvasRenderingContext2D, state: ReadState): void {
    const it = state.fever.introT;
    if (!state.fever.active || !(it < 1.25)) return;
    const reduced = state.save.reducedMotion;
    if (!reduced && it < 0.08) {
      ctx.globalAlpha = 0.5 * (1 - it / 0.08);
      ctx.fillStyle = COL.white;
      ctx.fillRect(0, 0, vw, vh);
    }
    let sc = 1;
    let alpha = it > 1 ? (1.25 - it) / 0.25 : 1;
    if (reduced) alpha = Math.min(alpha, it / 0.17);
    else if (it < 0.17) sc = 1.3 * easeOutCubic(it / 0.17);
    else if (it < 0.25) sc = 1.3 - (0.3 * (it - 0.17)) / 0.08;
    ctx.globalAlpha = clamp01(alpha);
    if (sc > 0.02) {
      const S = feverBigSize;
      const txt = UI_TEXT.fever;
      ctx.save();
      ctx.translate(vw / 2, vh * 0.3);
      ctx.scale(sc, sc);
      ctx.font = F_FEVER_BIG;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ink(ctx, S * 0.15);
      ctx.fillStyle = COL.ink;
      ctx.strokeText(txt, 0, S * 0.07);
      ctx.fillText(txt, 0, S * 0.07);
      ctx.strokeText(txt, 0, 0);
      ctx.fillStyle = feverBigGrad !== null ? feverBigGrad : COL.gold;
      ctx.fillText(txt, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function heroScreenY(state: ReadState): number {
    const h = state.hero;
    return h.prevY + (h.y - h.prevY) * state.clock.alpha + offsetY;
  }

  function drawChain(ctx: CanvasRenderingContext2D, state: ReadState, a: number): void {
    const chain = state.run.chain;
    if (state.fever.active && state.fever.introT < 0.6) return; // the TOTOTO TIME banner owns the moment
    let alpha = a;
    let lift = 0;
    let value = chain;
    if (chain <= 0) {
      if (chainFadeT >= 0.4 || chainShown <= 0) return;
      const q = chainFadeT / 0.4;
      alpha *= 1 - q;
      lift = q * 18 * K;
      value = chainShown;
    }
    const reduced = state.save.reducedMotion;
    let sc = 1;
    if (!reduced && chainPopT < 0.28) sc = 1 + 0.55 * (1 - easeOutElastic(chainPopT / 0.28));
    const color = CHAIN_HUES[hueIndex(value)];
    const nw = numWidth(NF_CHAIN, value, false);
    const total = wX + nw;
    let cx = heroX + 40 + total / 2;
    let cy = heroScreenY(state) - 84 - lift;
    const minY = sT + 30 * K;
    if (cy < minY) cy = minY;
    const maxX = vw - sR - M - total / 2;
    if (cx > maxX) cx = maxX;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.rotate(reduced ? 0 : -0.08);
    ctx.scale(sc, sc);
    ctx.textBaseline = 'alphabetic';
    ink(ctx, 6 * K);
    ctx.fillStyle = color;
    ctx.font = F_X;
    ctx.textAlign = 'left';
    outlined(ctx, S_X, -total / 2, 12 * K);
    drawNum(ctx, NF_CHAIN, value, -total / 2 + wX, 13 * K, 0, false, true);
    ctx.restore();
  }

  /* ================================================================ */
  /* Tutorial prompt, banner, toast, portrait hint                     */
  /* ================================================================ */

  function drawTutorial(ctx: CanvasRenderingContext2D, state: ReadState, a: number): void {
    const tu = state.tutorial;
    if (tu.prompt === 'none') return;
    const reduced = state.save.reducedMotion;
    const key = state.lastDevice === 'keyboard';
    const camX = state.cam.prevX + (state.cam.x - state.cam.prevX) * state.clock.alpha;
    let lx = tu.promptX - camX;
    const ly = tu.promptY + offsetY;
    const fade = clamp01(tu.promptT / 0.3);
    const pt = tu.promptT;
    const pulse = 0.5 + 0.5 * Math.sin(pt * TAU * 1.6);
    ctx.save();
    ctx.globalAlpha = a * fade * 0.94;
    if (tu.prompt === 'tap') {
      if (key) {
        const kw = 132 * K;
        const kh = 44 * K;
        if (lx < sL + M + kw / 2) lx = sL + M + kw / 2;
        if (lx > vw - sR - M - kw / 2) lx = vw - sR - M - kw / 2;
        const press = reduced ? 0 : pulse > 0.7 ? 1 : 0;
        keycap(ctx, lx, ly - kh / 2, kw, kh, press);
        ctx.font = F_TUT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = COL.ink;
        ctx.fillText(UI_TEXT.tutSpace, lx, ly - kh / 2 + kh * 0.16 - kh * 0.16 * (1 - press) + 1 * K);
        if (reduced) ctx.globalAlpha = a * fade * (0.6 + 0.4 * pulse);
        iconArrow(ctx, lx, ly + 26 * K + (reduced ? 0 : pulse * 6 * K), 16 * K, 1, COL.gold);
      } else {
        // ghost finger-tap bubble pointing at the bush
        ctx.font = F_TUT_BIG;
        const tw = tutWidth(ctx, 'tapT', UI_TEXT.tutTap, F_TUT_BIG);
        const bw = tw + 40 * K;
        const bh = 54 * K;
        if (lx < sL + M + bw / 2) lx = sL + M + bw / 2;
        if (lx > vw - sR - M - bw / 2) lx = vw - sR - M - bw / 2;
        const sc = reduced ? 1 : 1 + 0.08 * pulse;
        // tap ripples
        if (!reduced) {
          for (let k = 0; k < 2; k++) {
            const q = (pt * 1.1 + k * 0.5) % 1;
            ctx.globalAlpha = a * fade * (1 - q) * 0.7;
            circle(ctx, lx, ly + 30 * K, 6 * K + q * 26 * K);
            ctx.lineWidth = 3 * K;
            ctx.strokeStyle = COL.white;
            ctx.stroke();
          }
          ctx.globalAlpha = a * fade * 0.94;
        } else {
          ctx.globalAlpha = a * fade * (0.65 + 0.35 * pulse);
        }
        ctx.translate(lx, ly - bh / 2 - 6 * K);
        ctx.scale(sc, sc);
        // bubble with tail
        rrect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
        ctx.moveTo(-10 * K, bh / 2 - 1);
        ctx.lineTo(0, bh / 2 + 14 * K);
        ctx.lineTo(10 * K, bh / 2 - 1);
        ctx.fillStyle = 'rgba(248,250,252,0.92)';
        ctx.fill();
        ctx.lineWidth = 3.5 * K;
        ctx.strokeStyle = COL.ink;
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#E07A00';
        ctx.fillText(UI_TEXT.tutTap, 0, 2 * K);
      }
    } else {
      // Pill prompts: SLAM / BOING ride on Toto, JUMP ON THE DRUM / HOLD point at their drum / mound.
      const pr: string = tu.prompt;
      const hold = pr === 'hold';
      const segs =
        pr === 'slam'
          ? key
            ? tutSlamKey
            : tutSlamTouch
          : pr === 'boing'
            ? key
              ? tutBoingKey
              : tutBoingTouch
            : hold
              ? key
                ? tutHoldKey
                : tutHoldTouch
              : tutDrum;
      ctx.font = F_TUT;
      const tw = tutSegWidth(ctx, segs);
      const iconR = 13 * K;
      const bw = tw + iconR * 2 + 40 * K;
      const bh = 44 * K;
      const tail = 12 * K;
      const edge = 8 / s + 0.02 * bw; // 8 CSS px + the pulse
      const h = state.hero;
      const hy = heroScreenY(state);
      const onHero = tu.promptX === h.x;
      if (onHero) lx = heroX;
      const ax = lx;
      const overHero = lx - bw / 2 < heroX + 40 && lx + bw / 2 > heroX - 40;
      // Lowest body bottom that keeps the tail off Toto's head and the bubble off his chain counter.
      let clear = hy - 74 - tail;
      if ((state.run.chain > 0 || chainFadeT < 0.4) && clear > hy - 84 - 18 * K) clear = hy - 84 - 18 * K;
      // The bubble sits above its anchor (the tail tip), never over Toto, never under the HUD.
      // (The golden-mango BOING sign is centred under the mango instead.)
      let tailDir = onHero || pr !== 'boing' ? 1 : 0; // 1 = down, -1 = left (parked beside Toto)
      let bot = tailDir > 0 ? (onHero && pr === 'slam' ? hy + tu.promptY - h.y : ly) - tail : ly + bh / 2;
      if (overHero && bot > clear) bot = clear;
      let cy = bot - bh / 2;
      let minY = Math.max(sT + edge, hudIconsY + 20 * K, gy + gH + 8 * K);
      if (state.banner.text !== '' && state.banner.t < state.banner.dur) minY = Math.max(minY, bannerY + 30 * K);
      if (cy - bh / 2 < minY) {
        cy = minY + bh / 2;
        if (overHero && cy + bh / 2 > clear) {
          // too high to fit above Toto (landscape, after a drum bounce): park beside him
          lx = heroX + 44 + tail + bw / 2;
          cy = Math.max(cy, hy - 34);
          tailDir = -1;
        }
      }
      if (cy > vh - sB - edge - bh / 2) cy = vh - sB - edge - bh / 2;
      if (lx < sL + edge + bw / 2) lx = sL + edge + bw / 2;
      if (lx > vw - sR - edge - bw / 2) lx = vw - sR - edge - bw / 2;
      const sc = reduced ? 1 : 1 + 0.04 * pulse;
      if (reduced) ctx.globalAlpha = a * fade * (0.7 + 0.3 * pulse);
      ctx.translate(lx, cy);
      ctx.scale(sc, sc);
      // shadow, then body + tail as one path
      const tx = Math.max(-bw / 2 + bh / 2, Math.min(bw / 2 - bh / 2, ax - lx));
      for (let pass = 0; pass < 2; pass++) {
        const d = pass === 0 ? 3 * K : 0;
        rrect(ctx, -bw / 2, -bh / 2 + d, bw, bh, bh / 2);
        if (tailDir > 0) {
          ctx.moveTo(tx - 9 * K, bh / 2 - 1 + d);
          ctx.lineTo(tx, bh / 2 + tail + d);
          ctx.lineTo(tx + 9 * K, bh / 2 - 1 + d);
        } else if (tailDir < 0) {
          ctx.moveTo(-bw / 2 + 4 * K, d - 9 * K);
          ctx.lineTo(-bw / 2 - tail, d);
          ctx.lineTo(-bw / 2 + 4 * K, d + 9 * K);
        }
        ctx.fillStyle = pass === 0 ? COL.ink : 'rgba(248,250,252,0.94)';
        ctx.fill();
      }
      ctx.lineWidth = 3 * K;
      ctx.strokeStyle = COL.ink;
      ctx.stroke();
      const ix = -bw / 2 + 16 * K + iconR;
      if (hold) {
        // press-and-hold ring: fills over a 0.8 s loop (full and steady in reduced motion)
        const q = reduced ? 1 : (pt % 0.8) / 0.8;
        circle(ctx, ix, 0, iconR * 0.8);
        ctx.lineWidth = iconR * 0.5;
        ctx.strokeStyle = 'rgba(3,7,18,0.18)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(ix, 0, iconR * 0.8, -Math.PI / 2, -Math.PI / 2 + TAU * q);
        ctx.strokeStyle = '#D97706';
        ctx.stroke();
        circle(ctx, ix, 0, iconR * 0.3);
        ctx.fillStyle = COL.ink;
        ctx.fill();
      } else {
        const dir = pr === 'boing' ? -1 : 1;
        const bob = reduced ? 0 : (pulse - 0.5) * 4 * K * dir;
        iconArrow(ctx, ix, bob, iconR, dir, pr === 'slam' ? COL.red : COL.green);
      }
      ctx.font = F_TUT;
      ctx.textBaseline = 'middle';
      drawSegs(ctx, segs, ix + iconR + 10 * K, 1.5 * K, false);
    }
    ctx.restore();
  }

  function tutWidth(ctx: CanvasRenderingContext2D, key: string, text: string, font: string): number {
    if (key !== tutKey || tutGen !== layoutGen) {
      tutKey = key;
      tutGen = layoutGen;
      ctx.font = font;
      tutW = ctx.measureText(text).width;
    }
    return tutW;
  }

  function tutSegWidth(ctx: CanvasRenderingContext2D, segs: Seg[]): number {
    if (segs !== tutSegs || tutKey !== 'segs' || tutGen !== layoutGen) {
      tutSegs = segs;
      tutKey = 'segs';
      tutGen = layoutGen;
      tutW = measureSegs(ctx, segs);
    }
    return tutW;
  }

  function drawBanner(ctx: CanvasRenderingContext2D, state: ReadState, a: number): void {
    const bn = state.banner;
    if (bn.text === '' || bn.t >= bn.dur || bn.dur <= 0) return;
    if (bn.text !== bannerText || bannerGen !== layoutGen) {
      bannerText = bn.text;
      bannerGen = layoutGen;
      ctx.font = F_BANNER;
      bannerW = ctx.measureText(bn.text).width;
    }
    const reduced = state.save.reducedMotion;
    const tIn = 0.4;
    const tOut = 0.35;
    let alpha = 1;
    let dy = 0;
    let sc = 1;
    if (bn.t < tIn) {
      const q = bn.t / tIn;
      if (reduced) alpha = q;
      else {
        dy = -(1 - easeOutBack(q)) * 70 * K;
        alpha = clamp01(q * 3);
      }
    } else if (bn.t > bn.dur - tOut) {
      const q = (bn.t - (bn.dur - tOut)) / tOut;
      if (reduced) alpha = 1 - q;
      else {
        dy = -easeInCubic(q) * 60 * K;
        alpha = 1 - q;
        sc = 1 - q * 0.15;
      }
    }
    const w = bannerW + 52 * K;
    const h = 42 * K;
    const cx = vw / 2;
    const cy = bannerY + dy;
    ctx.save();
    ctx.globalAlpha = a * alpha;
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    // ribbon tails
    const tw = 34 * K;
    for (let i = 0; i < 2; i++) {
      const sg = i === 0 ? -1 : 1;
      const x0 = sg * (w / 2 - 10 * K);
      const x1 = sg * (w / 2 + tw);
      ctx.beginPath();
      ctx.moveTo(x0, -h / 2 + 9 * K);
      ctx.lineTo(x1, -h / 2 + 9 * K);
      ctx.lineTo(x1 - sg * 12 * K, 4 * K + (9 * K) / 2);
      ctx.lineTo(x1, h / 2 + 9 * K);
      ctx.lineTo(x0, h / 2 + 9 * K);
      ctx.closePath();
      ctx.fillStyle = '#B93A3E';
      ctx.fill();
      ctx.lineWidth = 3 * K;
      ctx.strokeStyle = COL.ink;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    sticker(ctx, -w / 2, -h / 2, w, h, 10 * K, 3 * K, COL.red, COL.ink, 3 * K);
    rrect(ctx, -w / 2 + 10 * K, -h / 2 + 4 * K, w - 20 * K, h * 0.26, h * 0.13);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fill();
    ctx.font = F_BANNER;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ink(ctx, 5 * K);
    ctx.fillStyle = COL.text;
    outlined(ctx, bn.text, 0, 1.5 * K);
    ctx.restore();
  }

  function drawToast(ctx: CanvasRenderingContext2D, state: ReadState): void {
    const to = state.toast;
    if (to.text === '' || to.t >= to.dur || to.dur <= 0) return;
    if (state.mode === 'title') return;
    if (to.text !== toastText || toastGen !== layoutGen) {
      toastText = to.text;
      toastGen = layoutGen;
      ctx.font = F_TOAST;
      toastW = ctx.measureText(to.text).width;
    }
    const reduced = state.save.reducedMotion;
    let alpha = 1;
    let dy = 0;
    if (to.t < 0.18) {
      alpha = to.t / 0.18;
      if (!reduced) dy = (1 - easeOutCubic(to.t / 0.18)) * 16 * K;
    } else if (to.t > to.dur - 0.3) alpha = (to.dur - to.t) / 0.3;
    let w = toastW + 40 * K;
    let h = 38 * K;
    let x = vw / 2;
    let y = toastY;
    if (state.mode === 'gameover') {
      const cb = buttons[I_COPY];
      if (cb.visible) {
        // morph over the Copy button: direct feedback right where the player tapped
        const bh = cb.h;
        if (w < cb.w + 6 * K) w = cb.w + 6 * K;
        if (h < bh + 6 * K) h = bh + 6 * K;
        x = cb.x + cb.w / 2;
        y = cb.y + cb.h / 2;
      } else {
        y = Math.min(toastY, cardY + cardH * ck - h / 2 - 4 * K);
      }
    }
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(x, y + dy);
    sticker(ctx, -w / 2, -h / 2, w, h, h / 2, 3 * K, COL.card, COL.accent, 2.5 * K);
    ctx.font = F_TOAST;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.text;
    ctx.fillText(to.text, 0, 1 * K);
    ctx.restore();
  }

  function drawPortraitHint(ctx: CanvasRenderingContext2D, state: ReadState): void {
    if (hintState !== 1 || state.mode !== 'playing') return;
    if (state.fever.active && state.fever.introT < 1.25) return; // the TOTOTO TIME banner's spot
    const t = hintT;
    const dur = UI.portraitHintDur;
    let alpha = 1;
    if (t < 0.3) alpha = t / 0.3;
    else if (t > dur - 0.4) alpha = (dur - t) / 0.4;
    const reduced = state.save.reducedMotion;
    ctx.font = F_HINT;
    const tw = hintWidth(ctx);
    const iconR = 18 * K;
    const w = tw + iconR * 2 + 48 * K;
    const h = 52 * K;
    const cy = Math.max(bannerY + 70 * K, vh * 0.3);
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(vw / 2, cy);
    sticker(ctx, -w / 2, -h / 2, w, h, h / 2, 3 * K, COL.card, COL.btnEdge, 2.5 * K);
    const rt = reduced ? 0 : easeOutBack(clamp01(((t * 0.8) % 1.6) / 0.6));
    iconRotate(ctx, -w / 2 + 20 * K + iconR, 0, iconR, rt);
    ctx.font = F_HINT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.text;
    ctx.fillText(UI_TEXT.portraitHint, -w / 2 + 32 * K + iconR * 2, 1 * K);
    ctx.restore();
  }

  let hintW = -1;
  let hintGen = -1;
  function hintWidth(ctx: CanvasRenderingContext2D): number {
    if (hintGen !== layoutGen) {
      hintGen = layoutGen;
      hintW = ctx.measureText(UI_TEXT.portraitHint).width;
    }
    return hintW;
  }

  /* ================================================================ */
  /* Pause + countdown                                                 */
  /* ================================================================ */

  function drawPause(ctx: CanvasRenderingContext2D, state: ReadState): void {
    const reduced = state.save.reducedMotion;
    const cd = state.pause.countdown;
    const step = UI.countdownStep;
    const total = step * UI.countdownFrom;
    // dim layer: full while the menu is up, fading out across the countdown
    let dimA = clamp01(pauseAnimT / 0.2);
    if (cd > 0) dimA = clamp01(cd / total);
    ctx.globalAlpha = dimA * 0.62;
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, vw, vh);
    ctx.globalAlpha = 1;

    if (cd > 0) {
      drawCountdown(ctx, cd, reduced);
      return;
    }

    const t = pauseAnimT;
    const q = clamp01(t / 0.28);
    let sc = 1;
    let alpha = 1;
    if (reduced) alpha = clamp01(t / 0.2);
    else {
      sc = 0.86 + 0.14 * easeOutBack(q);
      alpha = clamp01(t / 0.12);
    }
    const cx = pnX + pnW / 2;
    const cy = pnY + pnH / 2;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    ctx.translate(-cx, -cy);
    panel(ctx, pnX, pnY, pnW, pnH, 22 * K);
    ctx.font = F_PAUSED;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ink(ctx, 7 * K);
    ctx.fillStyle = COL.text;
    const pad = 22 * K;
    outlined(ctx, UI_TEXT.paused, cx, pnY + pad + 44 * K);
    ctx.font = F_SMALL;
    ctx.fillStyle = COL.dim;
    ctx.fillText(pauseInfo, cx, pnY + pad + 74 * K);
    drawButtons(ctx, state, alpha);
    ctx.restore();
    if (state.lastDevice === 'keyboard' || state.lastDevice === 'mouse') {
      ctx.globalAlpha = alpha * 0.85;
      ctx.font = F_LABEL;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ink(ctx, 3.5 * K);
      ctx.fillStyle = COL.dim;
      outlined(ctx, S_KEYS, cx, pnY + pnH + 18 * K);
      ctx.globalAlpha = 1;
    }
  }

  function drawCountdown(ctx: CanvasRenderingContext2D, cd: number, reduced: boolean): void {
    const step = UI.countdownStep;
    let n = Math.ceil(cd / step);
    if (n < 1) n = 1;
    if (n > 3) n = 3;
    const local = 1 - (cd - (n - 1) * step) / step; // 0 -> 1 within this number
    const cx = vw / 2;
    const cy = (sT + vh - sB) / 2 - 10 * K;
    let sc = 1;
    let alpha = 1;
    if (reduced) {
      alpha = local < 0.2 ? local / 0.2 : local > 0.8 ? (1 - local) / 0.2 : 1;
    } else {
      sc = local < 0.35 ? 1.7 - 0.7 * easeOutBack(local / 0.35) : 1 - (local - 0.35) * 0.12;
      alpha = local > 0.8 ? (1 - local) / 0.2 : 1;
    }
    ctx.save();
    ctx.translate(cx, cy);
    // shrinking ring
    ctx.globalAlpha = clamp01(alpha) * 0.9;
    ctx.beginPath();
    ctx.arc(0, 0, 92 * K, -Math.PI / 2, -Math.PI / 2 + TAU * (1 - local));
    ctx.lineWidth = 9 * K;
    ctx.lineCap = 'round';
    ctx.strokeStyle = COL.ink;
    ctx.stroke();
    ctx.lineWidth = 5 * K;
    ctx.strokeStyle = COUNT_COL[n];
    ctx.stroke();
    ctx.globalAlpha = clamp01(alpha);
    ctx.scale(sc, sc);
    ctx.font = F_COUNT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ink(ctx, 10 * K);
    ctx.fillStyle = COL.ink;
    ctx.fillText(COUNT_STR[n], 0, 14 * K);
    ctx.strokeText(COUNT_STR[n], 0, 6 * K);
    ctx.fillStyle = COUNT_COL[n];
    ctx.fillText(COUNT_STR[n], 0, 6 * K);
    ctx.restore();
  }

  /** Card / panel body: drop shadow, ink border, top highlight. */
  function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    rrect(ctx, x, y + 7 * K, w, h, r);
    ctx.fillStyle = 'rgba(3,7,18,0.55)';
    ctx.fill();
    rrect(ctx, x, y, w, h, r);
    ctx.fillStyle = COL.card;
    ctx.fill();
    ctx.lineWidth = 4 * K;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();
    rrect(ctx, x + 3 * K, y + 3 * K, w - 6 * K, h - 6 * K, r - 3 * K);
    ctx.lineWidth = 1.5 * K;
    ctx.strokeStyle = 'rgba(165,180,252,0.28)';
    ctx.stroke();
  }

  /* ================================================================ */
  /* Game-over card                                                    */
  /* ================================================================ */

  function measureCaption(ctx: CanvasRenderingContext2D, state: ReadState): void {
    const cap = state.summary.caption;
    if (capGen === layoutGen && cap === capSource) return;
    capGen = layoutGen;
    capSource = cap;
    ctx.font = F_CAPTION;
    const maxW = (cardW - 44) * ck;
    if (ctx.measureText(cap).width <= maxW) {
      capLine0 = cap;
      capLine1 = '';
      return;
    }
    // split at the space closest to the middle
    const mid = cap.length / 2;
    let best = -1;
    for (let i = 0; i < cap.length; i++) {
      if (cap.charAt(i) === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
    }
    if (best < 0) {
      capLine0 = cap;
      capLine1 = '';
    } else {
      capLine0 = cap.substring(0, best);
      capLine1 = cap.substring(best + 1);
    }
  }

  function drawCard(ctx: CanvasRenderingContext2D, state: ReadState): void {
    measureCaption(ctx, state);
    const sm = state.summary;
    const reduced = state.save.reducedMotion;
    const t = state.modeT;
    const now = state.clock.now;
    const u = ck;
    const W = cardW;
    const pw = W * u;
    const ph = cardH * u;
    const cx = cardX + pw / 2;

    // drop-in with overshoot (fade in reduced motion)
    let alpha = 1;
    let dy = 0;
    let rot = 0;
    let sc = 1;
    if (reduced) alpha = clamp01(t / 0.3);
    else {
      const q = clamp01(t / CARD_IN);
      const e = easeOutBack(q);
      dy = -(1 - e) * (vh * 0.55);
      rot = (1 - e) * -0.12;
      alpha = clamp01(t / 0.08);
      sc = q < 1 ? 0.92 + 0.08 * e : 1;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cardY + ph / 2 + dy);
    ctx.rotate(rot);
    ctx.scale(sc, sc);
    ctx.translate(-pw / 2, -ph / 2);

    panel(ctx, 0, 0, pw, ph, 24 * u);
    // warm header strip behind the caption
    ctx.save();
    rrect(ctx, 0, 0, pw, ph, 24 * u);
    ctx.clip();
    ctx.fillStyle = COL.cardTop;
    ctx.fillRect(0, 0, pw, (20 + 46 + 4) * u);
    ctx.restore();
    rrect(ctx, 0, 0, pw, ph, 24 * u);
    ctx.lineWidth = 4 * K;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();

    const pad = 22;
    let y = 20;
    /* caption */
    ctx.font = F_CAPTION;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.soft;
    if (capLine1 === '') ctx.fillText(capLine0, pw / 2, (y + 23) * u);
    else {
      ctx.fillText(capLine0, pw / 2, (y + 11.5) * u);
      ctx.fillText(capLine1, pw / 2, (y + 34.5) * u);
    }
    y += 46 + 8;

    /* score label + count-up */
    ctx.font = F_CARD_LABEL;
    ctx.fillStyle = COL.dimmer;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(S_SCORE, pw / 2, (y + 12) * u);
    y += 16;
    const cq = clamp01((t - COUNT_START) / UI.countUp);
    const shown = cq >= 1 ? sm.score : Math.floor(sm.score * easeOutCubic(cq));
    const done = cq >= 1;
    let scS = 1;
    const landT = t - COUNT_START - UI.countUp;
    if (!reduced && landT > 0 && landT < 0.25) scS = 1 + 0.12 * Math.sin((landT / 0.25) * Math.PI);
    ctx.save();
    ctx.translate(pw / 2, (y + 50) * u);
    ctx.scale(scS, scS);
    ink(ctx, 7 * u);
    ctx.fillStyle = sm.newBest && done ? COL.gold : COL.text;
    drawNum(ctx, NF_CARD_SCORE, shown, 0, 0, 0.5, true, true);
    ctx.restore();
    const scoreMidY = (y + 32) * u;
    y += 62;

    /* gap line */
    const gA = reduced ? clamp01(landT / 0.3) : clamp01(landT / 0.2);
    if (gA > 0) {
      ctx.globalAlpha = alpha * gA;
      ctx.font = F_CARD_LINE;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = gapColor;
      ctx.fillText(gapLine, pw / 2, (y + 10) * u);
      ctx.globalAlpha = alpha;
    }
    y += 24 + 12;

    /* stats row */
    const colW = (W - 2 * pad) / 4;
    for (let c = 0; c < 4; c++) {
      const sx = (pad + colW * (c + 0.5)) * u;
      const iy = (y + 15) * u;
      const ir = 13 * u;
      if (c === 0) iconFlag(ctx, sx, iy, ir);
      else if (c === 1) iconDrum(ctx, sx, iy, ir);
      else if (c === 2) iconMango(ctx, sx, iy, ir, false);
      else iconStomp(ctx, sx, iy, ir);
      ink(ctx, 4.5 * u);
      ctx.fillStyle = COL.text;
      ctx.textBaseline = 'alphabetic';
      const vy = (y + 58) * u;
      if (c === 0) {
        const nw = numWidth(NF_STAT, sm.distance, false);
        const tot = nw + wStatM;
        drawNum(ctx, NF_STAT, sm.distance, sx - tot / 2, vy, 0, false, true);
        ctx.font = F_CARD_LINE;
        ctx.textAlign = 'left';
        outlined(ctx, S_M, sx - tot / 2 + nw, vy);
      } else if (c === 1) {
        const nw = numWidth(NF_STAT, sm.chainBest, false);
        const tot = nw + wStatX;
        ctx.font = F_CARD_LINE;
        ctx.textAlign = 'left';
        outlined(ctx, S_X, sx - tot / 2, vy);
        drawNum(ctx, NF_STAT, sm.chainBest, sx - tot / 2 + wStatX, vy, 0, false, true);
      } else {
        drawNum(ctx, NF_STAT, c === 2 ? sm.mangoes : sm.stomps, sx, vy, 0.5, true, true);
      }
      ctx.font = F_STAT_LABEL;
      ctx.textAlign = 'center';
      ctx.fillStyle = COL.dimmer;
      ctx.fillText(c === 0 ? S_DISTANCE : c === 1 ? S_CHAIN : c === 2 ? S_MANGOES : S_STOMPS, sx, (y + 76) * u);
    }
    y += 84 + 10;

    /* divider */
    ctx.beginPath();
    ctx.moveTo(pad * u, y * u);
    ctx.lineTo((W - pad) * u, y * u);
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = 'rgba(165,180,252,0.2)';
    ctx.stroke();

    /* medal + goal row */
    const revealT = t - COUNT_START - UI.countUp - 0.05;
    const mA = reduced ? clamp01(revealT / 0.3) : 1;
    let mS = 1;
    if (!reduced) mS = revealT <= 0 ? 0 : easeOutElastic(revealT / 0.45);
    const medalCx = (pad + 28) * u;
    const medalCy = (y + 30) * u;
    if (mS > 0 && mA > 0) {
      ctx.save();
      ctx.globalAlpha = alpha * mA;
      ctx.translate(medalCx, medalCy);
      ctx.scale(mS, mS);
      const shine = reduced ? 0 : ((now * 0.45) % 1.6) / 1.0;
      drawMedal(ctx, 0, 0, 22 * u, sm.medal, shine);
      ctx.restore();
    }
    const nameA = clamp01(revealT / 0.25);
    if (nameA > 0) {
      ctx.globalAlpha = alpha * nameA;
      const nameDx = reduced ? 0 : (1 - easeOutCubic(revealT / 0.3)) * -10 * u;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = F_MEDAL_NAME;
      ink(ctx, 4 * u);
      ctx.fillStyle = MEDAL_TEXT_COL[sm.medal];
      outlined(ctx, MEDAL_NAME[sm.medal], (pad + 62) * u + nameDx, (y + 22) * u);
      ctx.font = F_MEDAL_SUB;
      ctx.fillStyle = COL.dimmer;
      ctx.fillText(medalSub, (pad + 62) * u + nameDx, (y + 42) * u);
      ctx.globalAlpha = alpha;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // goal block (right half)
    const gx0 = (W / 2 + 18) * u;
    if (sm.goalDone) {
      iconCheck(ctx, gx0 + 9 * u, (y + 16) * u, 9 * u, COL.green);
      ctx.font = F_CARD_LABEL;
      ctx.fillStyle = COL.green;
      ctx.textBaseline = 'middle';
      ctx.fillText(S_GOAL_DONE, gx0 + 24 * u, (y + 16.5) * u);
      ctx.font = F_GOAL;
      ctx.fillStyle = COL.text;
      ctx.fillText(goalLine0, gx0, (y + 36) * u);
      ctx.font = F_MEDAL_SUB;
      ctx.fillStyle = COL.dim;
      ctx.fillText(goalLine1, gx0, (y + 55) * u);
    } else {
      ctx.font = F_CARD_LABEL;
      ctx.fillStyle = COL.gold;
      ctx.fillText(S_NEXT_GOAL, gx0, (y + 18) * u);
      ctx.font = F_GOAL;
      ctx.fillStyle = COL.text;
      ctx.fillText(goalLine0, gx0, (y + 40) * u);
    }

    /* retry prompt */
    const ry = cRetryY;
    const rx = pad;
    const rw = W - 2 * pad;
    const rh = 54;
    const ready = t >= DEATH.inputLockout;
    const lockQ = clamp01(t / DEATH.inputLockout);
    let rs = 1;
    if (ready && !reduced) rs = 1 + 0.035 * Math.sin((t - DEATH.inputLockout) * TAU * 1.4);
    ctx.save();
    ctx.translate((rx + rw / 2) * u, (ry + rh / 2) * u);
    ctx.scale(rs, rs);
    const hx = (-rw / 2) * u;
    const hy = (-rh / 2) * u;
    rrect(ctx, hx, hy + 4 * u, rw * u, rh * u, (rh / 2) * u);
    ctx.fillStyle = COL.ink;
    ctx.fill();
    rrect(ctx, hx, hy, rw * u, rh * u, (rh / 2) * u);
    ctx.fillStyle = ready ? COL.accent : COL.btn;
    ctx.fill();
    if (!ready) {
      // lockout progress fill
      ctx.save();
      rrect(ctx, hx, hy, rw * u, rh * u, (rh / 2) * u);
      ctx.clip();
      ctx.fillStyle = 'rgba(129,140,248,0.45)';
      ctx.fillRect(hx, hy, rw * u * lockQ, rh * u);
      ctx.restore();
    }
    rrect(ctx, hx, hy, rw * u, rh * u, (rh / 2) * u);
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = COL.ink;
    ctx.stroke();
    rrect(ctx, hx + 18 * u, hy + 5 * u, (rw - 36) * u, rh * 0.26 * u, rh * 0.13 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fill();
    ctx.globalAlpha = alpha * (ready ? 1 : 0.55);
    iconRestart(ctx, hx + 34 * u, 0, 14 * u, COL.text);
    ctx.font = F_RETRY;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ink(ctx, 5 * u);
    ctx.fillStyle = COL.text;
    outlined(ctx, UI_TEXT.retry, 12 * u, 1.5 * u);
    ctx.restore();

    /* NEW BEST burst (after the count-up lands) */
    if (sm.newBest && landT > 0) {
      const bq = landT;
      let bs = 1;
      let ba = 1;
      if (reduced) ba = clamp01(bq / 0.3);
      else bs = easeOutElastic(bq / 0.5);
      const bx = (W - pad - 46) * u;
      const by = scoreMidY - 6 * u;
      ctx.save();
      ctx.globalAlpha = alpha * ba;
      ctx.translate(bx, by);
      ctx.scale(bs, bs);
      const spin = reduced ? 0 : now * 0.8;
      starPath(ctx, 0, 0, 30 * u, 44 * u, 12, spin);
      ctx.fillStyle = COL.ink;
      ctx.fill();
      starPath(ctx, 0, -2 * u, 28 * u, 41 * u, 12, spin);
      ctx.fillStyle = COL.gold;
      ctx.fill();
      ctx.lineWidth = 2.5 * u;
      ctx.strokeStyle = COL.ink;
      ctx.stroke();
      circle(ctx, 0, -2 * u, 25 * u);
      ctx.fillStyle = COL.red;
      ctx.fill();
      ctx.stroke();
      ctx.rotate(-0.18);
      ctx.font = F_NEWBEST;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ink(ctx, 4 * u);
      ctx.fillStyle = COL.text;
      outlined(ctx, S_NEW, 0, -10 * u);
      outlined(ctx, S_BEST_BANG, 0, 7 * u);
      ctx.restore();
    }

    ctx.restore();
  }

  /* ================================================================ */
  /* Draw orchestration                                                */
  /* ================================================================ */

  function draw(ctx: CanvasRenderingContext2D, state: ReadState): void {
    syncButtons(state);
    ensureMeasured(ctx, state);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    ctx.miterLimit = 2;
    const mode = state.mode;
    const inRun = mode === 'playing' || mode === 'dying';
    if (mode === 'title') {
      drawTitle(ctx, state);
      drawButtons(ctx, state, clamp01((state.modeT - 0.2) / 0.4));
    } else {
      if (hudAlpha > 0 && mode !== 'paused') {
        drawHud(ctx, state, hudAlpha);
        if (inRun) {
          drawChain(ctx, state, hudAlpha);
          drawTutorial(ctx, state, hudAlpha);
          drawBanner(ctx, state, hudAlpha);
          drawFeverIntro(ctx, state);
        }
      }
      if (mode === 'playing') {
        drawPortraitHint(ctx, state);
        drawButtons(ctx, state, hudAlpha);
      } else if (mode === 'paused') {
        drawPause(ctx, state);
      } else if (mode === 'gameover') {
        drawCard(ctx, state);
        drawButtons(ctx, state, clamp01(state.modeT / 0.3));
      }
    }
    drawToast(ctx, state);
    ctx.restore();
  }

  function hitTest(state: ReadState, lx: number, ly: number): ButtonId | null {
    syncButtons(state);
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (b.visible && lx >= b.x && lx <= b.x + b.w && ly >= b.y && ly <= b.y + b.h) {
        bPress[i] = 0;
        return b.id;
      }
    }
    return null;
  }

  return {
    buttons,
    layout,
    update,
    draw,
    hitTest,
  };
}

/** The portrait "Rotate for a wider view" pill shows once per page load (survives remounts). */
let portraitHintShown = false;

/** Order of the pause-menu rows (indices into the button array). */
const PAUSE_ROW_ORDER: ReadonlyArray<number> = [I_RESUME, I_RESTART, I_SOUND, I_MOTION];

/** Tutorial pills are light: swap the bright keyword colours for deeper, readable tones. */
function darkenKeywords(segs: Seg[]): void {
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i];
    if (sg.color === COL.gold) sg.color = '#D97706';
    else if (sg.color === COL.red) sg.color = '#E11D48';
    else if (sg.color === COL.green) sg.color = '#15803D';
    else if (sg.color === COL.warm) sg.color = '#C2410C';
  }
}
