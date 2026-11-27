/** The control panel's layouts, and how its bottom sheet snaps. */
import { useMediaQuery } from "../hooks/useMediaQuery";

/**
 * "card": a floating card in the top right corner; "sheet": a bottom sheet, on
 * narrow (portrait phone) screens; "drawer": a full-height drawer on the right,
 * on short (landscape phone) screens.
 */
export type PanelLayout = "card" | "sheet" | "drawer";

/** Screens this narrow get the bottom sheet. */
export const SHEET_QUERY = "(max-width: 640px)";
/** Screens this short get the drawer, which wins over the sheet: a sheet needs height. */
export const DRAWER_QUERY = "(max-height: 500px)";

/** The layout for a screen that matches `SHEET_QUERY` (`narrow`) and `DRAWER_QUERY` (`short`). */
export function panelLayout(narrow: boolean, short: boolean): PanelLayout {
  if (short) {
    return "drawer";
  }
  return narrow ? "sheet" : "card";
}

/** The layout for this screen, kept up to date. */
export function usePanelLayout(): PanelLayout {
  return panelLayout(useMediaQuery(SHEET_QUERY), useMediaQuery(DRAWER_QUERY));
}

/** A release faster than this, in px/s, opens or closes the sheet whichever way it was moving. */
export const FLICK_VELOCITY = 400;

/**
 * Whether a sheet let go of while `openness` of the way open (0 collapsed, 1
 * expanded), moving at `velocity` px/s (positive while opening), snaps open.
 * A flick goes the way it was moving; a slow release goes to the nearer end.
 */
export function snapSheet(openness: number, velocity: number): boolean {
  if (Math.abs(velocity) >= FLICK_VELOCITY) {
    return velocity > 0;
  }
  return openness >= 0.5;
}
