import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getJobStateLabel, type SchedulerJob } from './scheduler';
import { imageUrl, fetchAutoStretch, DEFAULT_STRETCH, type StretchSettings } from './imageApi';
import { altAzToRaDec, raDecToAltAz, getLocalSiderealTime } from './coordinates';
import { isValidLocation } from './horizonApi';
import { createConcurrencyLimiter } from './concurrencyLimit';
import type { SkyMapDataSource } from './dataSource';
import type {
  ObservatoryInfo, ArtificialHorizonRegion, AstrobinFootprint, SurveyOption,
  ConstellationLineFeature, ConstellationBoundaryFeature,
} from './types';
import './SkyMap.css';

// Aladin Lite v3 is loaded via <script> in index.html, not bundled — it ships no official types.
declare global {
  interface Window {
    A: any;
  }
}

/** The parallactic angle — the angle at a sky point between the direction to the north celestial
 * pole and the direction to the zenith, standard spherical-astronomy formula (e.g. Meeus,
 * "Astronomical Algorithms" ch.14). Feeding `-parallacticAngleDeg(...)` into aladin.setRotation()
 * turns Aladin's default celestial-north-up view into a zenith-up one, frame by frame — see the
 * "Zenith lock" checkbox and its own effect below. */
function parallacticAngleDeg(raDeg: number, decDeg: number, latDeg: number, lonDeg: number, dateMs: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const lstHours = getLocalSiderealTime(dateMs, lonDeg);
  let haDeg = lstHours * 15 - raDeg;
  haDeg = ((haDeg % 360) + 360) % 360;
  if (haDeg > 180) haDeg -= 360;
  const ha = toRad(haDeg);
  const dec = toRad(decDeg);
  const lat = toRad(latDeg);
  const q = Math.atan2(Math.sin(ha), Math.cos(dec) * Math.tan(lat) - Math.sin(dec) * Math.cos(ha));
  return toDeg(q);
}

/** Standard tangent-plane (gnomonic/TAN) coordinates of (ra,dec) relative to a projection center
 * (ra0,dec0), in degrees — flat there even though RA/Dec itself isn't, which is what makes it
 * useful as an interpolation space (see tangentPlaneCenter and computeFootprintMesh below).
 * Standard formula, e.g. Calabretta & Greisen 2002 ("Representations of celestial coordinates in
 * FITS"), eq. for the gnomonic (TAN) projection. */
function gnomonicXiEta(raDeg: number, decDeg: number, ra0Deg: number, dec0Deg: number): [number, number] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const ra = toRad(raDeg);
  const dec = toRad(decDeg);
  const ra0 = toRad(ra0Deg);
  const dec0 = toRad(dec0Deg);
  const cosc = Math.sin(dec0) * Math.sin(dec) + Math.cos(dec0) * Math.cos(dec) * Math.cos(ra - ra0);
  const xi = (Math.cos(dec) * Math.sin(ra - ra0)) / cosc;
  const eta = (Math.cos(dec0) * Math.sin(dec) - Math.sin(dec0) * Math.cos(dec) * Math.cos(ra - ra0)) / cosc;
  return [toDeg(xi), toDeg(eta)];
}

/** Inverse of gnomonicXiEta: recovers (ra,dec) from tangent-plane offsets (xi,eta, in degrees)
 * relative to a projection center (ra0,dec0). Standard TAN-projection inverse (Calabretta &
 * Greisen 2002). */
function invGnomonic(xiDeg: number, etaDeg: number, ra0Deg: number, dec0Deg: number): [number, number] {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const xi = toRad(xiDeg);
  const eta = toRad(etaDeg);
  const ra0 = toRad(ra0Deg);
  const dec0 = toRad(dec0Deg);
  const rho = Math.hypot(xi, eta);
  if (rho === 0) return [ra0Deg, dec0Deg];
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(dec0) + (eta * Math.sin(c) * Math.cos(dec0)) / rho);
  const ra = ra0 + Math.atan2(xi * Math.sin(c), rho * Math.cos(dec0) * Math.cos(c) - eta * Math.sin(dec0) * Math.sin(c));
  return [((toDeg(ra) % 360) + 360) % 360, toDeg(dec)];
}

// The true rectangle center is the midpoint of the TL-BR diagonal — but only in the tangent
// (xi,eta) plane, not in plain RA/Dec: naive (a+b)/2 on RA/Dec breaks across the RA=0/360 wrap
// (common near a celestial pole, where a modest physical FOV can span most of the RA range), and
// is measurably off even after unwrapping, since RA/Dec isn't a flat coordinate system. Fixed by
// projecting the TL/BR corners relative to one of them (an arbitrary nearby reference), averaging
// *there* (a flat plane, so plain averaging is correct), then inverting back to RA/Dec.
function tangentPlaneCenter(aDeg: [number, number], cDeg: [number, number]): [number, number] {
  const [xiA, etaA] = gnomonicXiEta(aDeg[0], aDeg[1], aDeg[0], aDeg[1]);
  const [xiC, etaC] = gnomonicXiEta(cDeg[0], cDeg[1], aDeg[0], aDeg[1]);
  return invGnomonic((xiA + xiC) / 2, (etaA + etaC) / 2, aDeg[0], aDeg[1]);
}

/** Shared by a single grid/loop pass — counts how many projection calls actually threw (as
 * opposed to legitimately returning null for an off-screen point), so a caller whose whole grid
 * came back empty can tell "nothing here is on-screen right now" apart from "the WebGL texture
 * state was transiently broken for this entire attempt" and retry only the latter (see
 * terrainDebounceRef's retry loop). */
interface ProjectionStats { exceptions: number; }

/** aladin.world2pix/pix2world don't just return null for a point their current projection can't
 * handle (already handled everywhere below) — under some internal states (observed alongside a
 * "Tex image ... incurring lazy initialization" WebGL warning, so likely a HiPS tile texture not
 * fully ready yet, typically right after a zoom/pan brings new tiles into view) they throw
 * outright instead ("can't access property Symbol.iterator, i is undefined"), which none of our
 * own null-checks can catch since the exception happens inside Aladin's own code before it ever
 * returns. Every call site here goes through these wrappers so one bad projection this redraw
 * can't ever take down the whole grid/loop it's part of. */
function safeWorld2Pix(aladin: any, ra: number, dec: number, stats?: ProjectionStats): [number, number] | null {
  try {
    return aladin.world2pix(ra, dec) ?? null;
  }
  catch {
    if (stats) stats.exceptions++;
    return null;
  }
}

function safePix2World(aladin: any, x: number, y: number, stats?: ProjectionStats): [number, number] | null {
  try {
    return aladin.pix2world(x, y) ?? null;
  }
  catch {
    if (stats) stats.exceptions++;
    return null;
  }
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9V4h5" />
      <path d="M15 4h5v5" />
      <path d="M20 15v5h-5" />
      <path d="M9 20H4v-5" />
    </svg>
  );
}

function CompressIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 4v5H4" />
      <path d="M15 4v5h5" />
      <path d="M20 15h-5v5" />
      <path d="M4 15h5v5" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" fill="currentColor" stroke="none" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function CrosshairIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="6" />
      <line x1="12" y1="1" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="23" />
      <line x1="1" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="23" y2="12" />
    </svg>
  );
}

function ZenithIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="9" />
      <path d="M12 8v8" />
      <path d="M8.5 11.5 12 8l3.5 3.5" />
    </svg>
  );
}

function LastImageIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="m3 16 5-5 4 4 3-3 6 6" />
    </svg>
  );
}

function GalaxyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 12C15 9 20 9.5 20 6" />
      <path d="M12 12C9 15 4 14.5 4 18" />
      <path d="M12 12C16 13.5 17 18 13 20" />
      <path d="M12 12C8 10.5 7 6 11 4" />
    </svg>
  );
}

function NebulaIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 17a3.5 3.5 0 0 1-1-6.86 4.5 4.5 0 0 1 8.6-2.3A4 4 0 0 1 19 12a3.5 3.5 0 0 1-.5 5H6.5Z" />
      <circle cx="9" cy="14" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14" cy="15" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GalleryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="6" width="15" height="14" rx="2" />
      <path d="M3 15V5a2 2 0 0 1 2-2h10" />
      <circle cx="11.5" cy="11.5" r="1.3" fill="currentColor" stroke="none" />
      <path d="m6 18 3.5-4 3 3 2.5-3 4 3.5" />
    </svg>
  );
}

function ViewfinderIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8V5a2 2 0 0 1 2-2h3" />
      <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
      <path d="M3 16v3a2 2 0 0 0 2 2h3" />
      <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function HorizonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M2 17h20" />
      <path d="M5 17a7 7 0 0 1 14 0" />
      <line x1="12" y1="3" x2="12" y2="5" />
      <line x1="5.6" y1="6.6" x2="7" y2="8" />
      <line x1="18.4" y1="6.6" x2="17" y2="8" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-1.2.9-2a1.6 1.6 0 0 1 1.1-2.7H16a5 5 0 0 0 5-5c0-4.6-4-8.3-9-8.3Z" />
      <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="10.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TerrainIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m2 18 5-8 3.5 4L15 6l7 12Z" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  );
}

function ConstellationLinesIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 6 12 4 19 9 14 14 7 18 14 14" />
      <circle cx="5" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="4" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="9" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="14" cy="14" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="7" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ConstellationBoundsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M4 8 10 4 20 7 18 17 8 19 3 14Z" strokeDasharray="3 2" />
    </svg>
  );
}

function OpenTargetsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

/** Icon-only replacement for the old checkbox+label toggles — same on/off semantics, `active`
 * driven by `data-active` (styled in index.css) rather than a native checkbox appearance, since an
 * icon has no built-in checked state to show. */
function IconToggleButton({
  active, onToggle, disabled, title, icon,
}: {
  active: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      className="sky-map-icon-button"
      data-active={active ? 'true' : undefined}
      aria-pressed={active}
      disabled={disabled}
      onClick={onToggle}
      title={title}
      aria-label={title}
    >
      {icon}
    </button>
  );
}

/** The Horizon simulation's own fast forward/back stepper (see its +/- buttons below) — "1 month"
 * is a real calendar-month step (see stepHorizonTime), not a fixed 30-day increment, since repeated
 * fixed-length steps would drift the day-of-month; the others are exact, unambiguous durations. */
type HorizonStep = { label: string } & ({ kind: 'ms'; ms: number } | { kind: 'month' });
const HORIZON_STEPS: HorizonStep[] = [
  { label: '1 min', kind: 'ms', ms: 60_000 },
  { label: '5 min', kind: 'ms', ms: 5 * 60_000 },
  { label: '30 min', kind: 'ms', ms: 30 * 60_000 },
  { label: '1 hour', kind: 'ms', ms: 60 * 60_000 },
  { label: '1 day', kind: 'ms', ms: 24 * 60 * 60_000 },
  { label: '1 month', kind: 'month' },
];

function stepHorizonTime(current: number, step: HorizonStep, direction: 1 | -1): number {
  if (step.kind === 'month') {
    const d = new Date(current);
    d.setMonth(d.getMonth() + direction);
    return d.getTime();
  }
  return current + direction * step.ms;
}

function formatVisibilityDateTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatVisibilityText(vw: VisibilityWindow): string {
  switch (vw.kind) {
    case 'always':
      return 'Always above the horizon at this date';
    case 'never':
      return 'Never above the horizon at this date';
    case 'window': {
      const rise = formatVisibilityDateTime(vw.riseMs);
      const set = formatVisibilityDateTime(vw.setMs);
      if (vw.relation === 'current') return `Visible now — ${rise} to ${set}`;
      if (vw.relation === 'future') return `Not visible now — next window ${rise} to ${set}`;
      return `Not visible now — already set, was ${rise} to ${set}`;
    }
    case 'unknown':
    default:
      return '';
  }
}

const VISIBILITY_CHART_WIDTH = 300;
const VISIBILITY_CHART_HEIGHT = 90;
const VISIBILITY_CHART_ALT_MIN = -30;
const VISIBILITY_CHART_ALT_MAX = 90;

/** Altitude-vs-time chart for the Planning FOV target: its own altitude curve, the effective
 * horizon at whatever azimuth it's at at that moment (see effectiveHorizonAltDeg — not flat,
 * since an artificial horizon varies with azimuth as the target moves through the sky over the
 * day), the current simulated time, and the visible window (see findVisibilityWindow)
 * highlighted. Y-axis is clamped to [-30°, 90°] rather than the full ±90° range — the interesting
 * part is always near/above the horizon, and a target that's 80° below it doesn't need its own
 * vertical space to communicate "nowhere close to visible". */
function VisibilityChart({
  samples, centerMs, window: visWindow,
}: {
  samples: VisibilitySample[];
  centerMs: number;
  window: VisibilityWindow;
}) {
  if (samples.length === 0) return null;
  const t0 = samples[0].ms;
  const t1 = samples[samples.length - 1].ms;
  const x = (t: number) => ((t - t0) / (t1 - t0 || 1)) * VISIBILITY_CHART_WIDTH;
  const y = (alt: number) => {
    const clamped = Math.max(VISIBILITY_CHART_ALT_MIN, Math.min(VISIBILITY_CHART_ALT_MAX, alt));
    const span = VISIBILITY_CHART_ALT_MAX - VISIBILITY_CHART_ALT_MIN;
    return VISIBILITY_CHART_HEIGHT * (1 - (clamped - VISIBILITY_CHART_ALT_MIN) / span);
  };
  const path = (key: 'altDeg' | 'horizonAltDeg') => samples
    .map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(s.ms).toFixed(1)} ${y(s[key]).toFixed(1)}`)
    .join(' ');

  return (
    <svg
      className="sky-map-visibility-chart"
      viewBox={`0 0 ${VISIBILITY_CHART_WIDTH} ${VISIBILITY_CHART_HEIGHT}`}
      width={VISIBILITY_CHART_WIDTH}
      height={VISIBILITY_CHART_HEIGHT}
    >
      {visWindow.kind === 'window' && (
        <rect
          className="sky-map-visibility-chart-window"
          x={x(visWindow.riseMs)}
          y={0}
          width={Math.max(0, x(visWindow.setMs) - x(visWindow.riseMs))}
          height={VISIBILITY_CHART_HEIGHT}
        />
      )}
      <line className="sky-map-visibility-chart-zero" x1={0} y1={y(0)} x2={VISIBILITY_CHART_WIDTH} y2={y(0)} />
      <path className="sky-map-visibility-chart-horizon" d={path('horizonAltDeg')} fill="none" />
      <path className="sky-map-visibility-chart-alt" d={path('altDeg')} fill="none" />
      <line
        className="sky-map-visibility-chart-now"
        x1={x(centerMs)}
        y1={0}
        x2={x(centerMs)}
        y2={VISIBILITY_CHART_HEIGHT}
      />
    </svg>
  );
}

interface Props {
  /** Where observatory info, artificial horizon, the terrain image, AstroBin footprints, and the
   * "open targets" schedule-file jobs come from — a live KStarsCluster backend today, potentially
   * a static JSON config dump for a future public-site deployment. See dataSource.ts. */
  dataSource: SkyMapDataSource;
  mountCoords?: { ra: number; dec: number };
  activeJob: SchedulerJob | null;
  jobs?: SchedulerJob[];
  ekosReady?: boolean;
  fov?: { widthArcmin: number; heightArcmin: number };
  pa?: number;
  lastImageFilename?: string;
  /** Whether this deployment's dataSource.getScheduleFileJobs() is backed by a real Ekos/.esl
   * scheduler at all — defaults to true (KStarsCluster's own case) since that's the only deployment
   * this existed for originally. A public site with no such backend (astro-homepage's dataSource
   * always resolves it to []) sets this false so the button doesn't dangle uselessly, same reasoning
   * as gating "Follow mount"/"Show last image" on mountCoords/lastImageFilename being passed at all. */
  supportsOpenTargets?: boolean;
}

/** Four corners of a centerRa/centerDec-centered rectangle, widthDeg x heightDeg, rotated by paDeg
 * (East of North). dx/dy are tangent-plane (xi,eta) offsets from the center (see invGnomonic),
 * not flat RA/Dec degrees — a real spherical rotation around the center rather than a small-angle
 * flat approximation, so this stays correct arbitrarily close to (or exactly at) a celestial pole.
 * An earlier version instead divided the RA offset by cos(dec) to approximate the same thing,
 * which is only valid for a small FOV far from the pole: near the pole cos(dec) collapses toward
 * 0, blowing up that division, and a mount/Planning FOV rectangle centered near the pole rendered
 * as a triangle (or two) instead of a rectangle — confirmed by reproducing a slew through the pole
 * and inspecting the resulting corners. dx is flipped (+dx = West, not East) for the live-capture
 * callers (mount/Planning FOV) — verified empirically against Ekos's own `pa`: RA increases to the
 * left on an unmirrored equatorial display, so a plain +East-is-right offset rendered the overlay
 * image mirrored left-right; xi has the same "increasing = East" sign as a plain RA offset (see
 * gnomonicXiEta), so the same flip applies here too.
 *
 * `mirrored` exists because AstroBin's own "orientation" convention (used for footprints without
 * an Advanced Plate Solving corner solution — see footprintCorners) turned out to need the *other*
 * sign here, not the one Ekos's `pa` needs. Confirmed live against real basic-solve-only images at
 * two very different orientation angles: with the Ekos-derived sign, the rendered footprint was a
 * left-right mirror of the true photo in each case (checked directly against the true photo's own
 * asymmetric detail — a nebula-edge notch in one case, a companion object's position in the other,
 * both landing on the wrong side) — flipping this one sign for that caller fixed both, without
 * touching the live-capture overlay's own (already-correct) convention. This isn't a per-user optics
 * quirk: it's that Advanced-solve footprints get their real per-corner RA/Dec straight from AstroBin (so
 * whatever the image's actual parity is comes along for free, see footprintCorners), while a
 * basic solve gives us only a single scalar orientation angle with no parity information at all —
 * we have to pick a sign ourselves, and this is the one that actually matches AstroBin's convention. */
function fovCorners(
  centerRa: number, centerDec: number, widthDeg: number, heightDeg: number, paDeg: number,
  mirrored: boolean = false,
): [number, number][] {
  const paRad = (paDeg * Math.PI) / 180;
  const halfW = (mirrored ? -1 : 1) * widthDeg / 2;
  const halfH = heightDeg / 2;
  const offsets: [number, number][] = [[halfW, -halfH], [-halfW, -halfH], [-halfW, halfH], [halfW, halfH]];
  return offsets.map(([dx, dy]) => {
    const rx = dx * Math.cos(paRad) - dy * Math.sin(paRad);
    const ry = dx * Math.sin(paRad) + dy * Math.cos(paRad);
    return invGnomonic(rx, ry, centerRa, centerDec);
  });
}

interface ScreenRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angleRad: number;
}

/** Projects a sky-registered rectangle (world corners in [top-left, top-right, bottom-right,
 * bottom-left] winding order) to screen-space pixels — center, size, and rotation — shared by
 * both the DOM-positioned "last image" overlay (positionFootprintImage below) and the
 * canvas-drawn AstroBin footprints (drawAstrobinFootprints).
 *
 * `extraHalfTurn` exists because the two callers need opposite answers to the same question, and
 * there's no way to derive it from the corners alone: the live-capture caller's corners come from
 * fovCorners() using Ekos's own `pa`, which (empirically) needs a +180° correction to stop the
 * actual photo rendering upside down; AstroBin's corners are real solved RA/Dec per corner
 * (verified against a named object's true catalog position landing exactly where its pixel
 * position predicts), and adding that same +180° there just rotates a correct answer into a wrong
 * one — confirmed the hard way when it flipped every AstroBin footprint 180°, not just the
 * one-off mirrored-solve cases the corners were adopted to fix in the first place. */
function computeScreenRect(aladin: any, corners: [number, number][], extraHalfTurn: boolean): ScreenRect | null {
  const projected = corners.map(([ra, dec]) => safeWorld2Pix(aladin, ra, dec));
  // world2pix returns null/undefined for points its current projection can't map (e.g. an
  // AstroBin footprint on the opposite side of the sky from wherever the view happens to be) —
  // rather than crashing the whole redraw() (which would also skip the live FOV overlay below
  // it), just leave this one unrendered until it's somewhere projectable.
  if (projected.some((p) => !p)) return null;
  const px = projected as [number, number][];
  const cx = (px[0][0] + px[2][0]) / 2;
  const cy = (px[0][1] + px[2][1]) / 2;
  const w = Math.hypot(px[1][0] - px[0][0], px[1][1] - px[0][1]);
  const h = Math.hypot(px[2][0] - px[1][0], px[2][1] - px[1][1]);
  const angleRad = Math.atan2(px[1][1] - px[0][1], px[1][0] - px[0][0]) + (extraHalfTurn ? Math.PI : 0);
  return { cx, cy, w, h, angleRad };
}

/** Positions a plain screen-space <img> over a sky-registered rectangle via computeScreenRect —
 * the technique the live "last image" overlay uses, since Aladin's own image layers need real
 * HiPS/WCS tiling, which a one-off JPEG thumbnail doesn't have. AstroBin's own footprints use to
 * use this too (one absolutely-positioned <img> each), until there got to be enough of them that
 * a canvas (see drawAstrobinFootprints) was worth the switch — see the SkyMapCard performance
 * discussion for why. */
function positionFootprintImage(img: HTMLElement, aladin: any, corners: [number, number][], extraHalfTurn: boolean) {
  const rect = computeScreenRect(aladin, corners, extraHalfTurn);
  if (!rect) {
    img.style.display = 'none';
    return;
  }
  img.style.display = 'block';
  img.style.width = `${rect.w}px`;
  img.style.height = `${rect.h}px`;
  img.style.left = `${rect.cx}px`;
  img.style.top = `${rect.cy}px`;
  img.style.marginLeft = `${-rect.w / 2}px`;
  img.style.marginTop = `${-rect.h / 2}px`;
  img.style.transform = `rotate(${(rect.angleRad * 180) / Math.PI}deg)`;
}

const FOLLOW_MOUNT_KEY = 'skymap.followMount';
const ZENITH_LOCK_KEY = 'skymap.zenithLock';
const PROJECTION_KEY = 'skymap.projection';
const SURVEY_KEY = 'skymap.surveyId';
const SHOW_LAST_IMAGE_KEY = 'skymap.showLastImage';
const SHOW_NGC_KEY = 'skymap.showNgc';
const SHOW_SH2_KEY = 'skymap.showSh2';
const SHOW_ASTROBIN_KEY = 'skymap.showAstrobin';
const SHOW_HORIZON_KEY = 'skymap.showHorizon';
const SHOW_TERRAIN_KEY = 'skymap.showTerrain';
const SHOW_GRID_KEY = 'skymap.showGrid';
const SHOW_CONSTELLATION_LINES_KEY = 'skymap.showConstellationLines';
const SHOW_CONSTELLATION_BOUNDS_KEY = 'skymap.showConstellationBounds';
const SHOW_OPEN_TARGETS_KEY = 'skymap.showOpenTargets';
const HORIZON_STEP_INDEX_KEY = 'skymap.horizonStepIndex';
// Global, not per-deployment/username — this is "where the visitor's browser is", which stays the
// same regardless of whose gallery they're currently looking at, unlike the real observatory data.
const MANUAL_LOCATION_KEY = 'skymap.manualLocation';
// Real width is CSS-defined (see .sky-map-astrobin-popover); the height is only an estimate since
// the actual rendered height depends on title wrapping and isn't known until after it paints —
// good enough for clamping the popover to stay on-screen without needing a post-paint measurement.
const ASTROBIN_POPOVER_WIDTH = 220;
const ASTROBIN_POPOVER_HEIGHT_ESTIMATE = 140;
// How far the mouse can move between down and up before a click is treated as a drag instead —
// see astrobinMouseDownRef.
const ASTROBIN_DRAG_CLICK_THRESHOLD_PX = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
const PLANNING_FOV_ENABLED_KEY = 'skymap.planningFov.enabled';
const PLANNING_FOV_SENSOR_WIDTH_KEY = 'skymap.planningFov.sensorWidthPx';
const PLANNING_FOV_SENSOR_HEIGHT_KEY = 'skymap.planningFov.sensorHeightPx';
const PLANNING_FOV_PIXEL_SIZE_KEY = 'skymap.planningFov.pixelSizeUm';
const PLANNING_FOV_FOCAL_LENGTH_KEY = 'skymap.planningFov.focalLengthMm';
const PLANNING_FOV_ROTATION_KEY = 'skymap.planningFov.rotationDeg';
const VIEW_KEY = 'skymap.view';
const DEFAULT_FOV_DEG = 180;
const DEFAULT_TARGET = '24 00 00.00 +59 59 60.0';
// ASI2600MM Pro (6248x4176, 3.76µm) — just a starting point for the calculator below, not tied
// to whatever camera is actually connected.
const DEFAULT_SENSOR_WIDTH_PX = 6248;
const DEFAULT_SENSOR_HEIGHT_PX = 4176;
const DEFAULT_PIXEL_SIZE_UM = 3.76;
const DEFAULT_FOCAL_LENGTH_MM = 418;
const ARCMIN_PER_RADIAN = (180 / Math.PI) * 60;

/** Small-angle FOV approximation (accurate well beyond any real camera/focal-length combo):
 * sensor dimension in mm, divided by focal length, is the angle in radians. */
function sensorFovArcmin(pixels: number, pixelSizeUm: number, focalLengthMm: number): number {
  if (focalLengthMm <= 0) return 0;
  const sensorMm = (pixels * pixelSizeUm) / 1000;
  return (sensorMm / focalLengthMm) * ARCMIN_PER_RADIAN;
}

/** Sinnott's NGC 2000.0 (~13000 NGC/IC objects) and Sharpless's Sh2 HII-region catalogue
 * (313 objects) — both small enough to load whole in one VizieR cone search rather than
 * re-querying as the view pans/zooms, so a 180° radius (the whole sky, from any center) is
 * fetched once per toggle-on and then just shown/hidden from then on. */
const NGC_VIZIER_CAT = 'VII/118/ngc2000';
const SH2_VIZIER_CAT = 'VII/20/catalog';
const OVERLAY_CATALOG_RADIUS_DEG = 180;

// Both catalogs' size columns are confirmed (via each ReadMe) to be a single largest-dimension
// value in arcmin, not a proper major/minor ellipse — a circle of that diameter is the closest
// honest approximation available, and it's already a lot more real than a fixed-size marker.
// Objects with no recorded size (common for faint/small NGC entries) still get a small circle
// rather than nothing, since a boundary that vanishes for "unknown size" reads as a bug.
const MIN_BOUNDARY_RADIUS_DEG = 0.015;

function sizeArcminToRadiusDeg(sizeArcmin: string | undefined): number {
  const value = parseFloat(sizeArcmin ?? '');
  if (!Number.isFinite(value) || value <= 0) return MIN_BOUNDARY_RADIUS_DEG;
  return Math.max(MIN_BOUNDARY_RADIUS_DEG, value / 2 / 60);
}

/** Builds a circle-per-source graphic overlay sized by each source's real angular diameter,
 * alongside (not instead of) the small click-for-details catalog marker `cat` already carries —
 * the marker gives a precise, clickable center point; this overlay is the actual boundary. */
function buildBoundaryOverlay(aladin: any, cat: any, sizeField: string, color: string, name: string): any {
  const overlay = window.A.graphicOverlay({ name, color, lineWidth: 1 });
  aladin.addOverlay(overlay);
  cat.getSources().forEach((source: any) => {
    const radiusDeg = sizeArcminToRadiusDeg(source.data?.[sizeField]);
    overlay.add(window.A.circle(source.ra, source.dec, radiusDeg));
  });
  return overlay;
}

async function fetchConstellationLines(): Promise<ConstellationLineFeature[]> {
  const res = await fetch('/constellations/lines.json');
  if (!res.ok) throw new Error(`constellation lines request failed: ${res.status}`);
  return res.json();
}

async function fetchConstellationBounds(): Promise<ConstellationBoundaryFeature[]> {
  const res = await fetch('/constellations/bounds.json');
  if (!res.ok) throw new Error(`constellation bounds request failed: ${res.status}`);
  return res.json();
}

/** One open A.polyline per stroke (not one closed shape per constellation — most constellations'
 * stick figures are a small tree/branching structure of strokes, not a single loop). */
function buildConstellationLinesOverlay(aladin: any, features: ConstellationLineFeature[]): any {
  const overlay = window.A.graphicOverlay({ name: 'Constellation lines', color: '#94a3b8', lineWidth: 1 });
  aladin.addOverlay(overlay);
  features.forEach((feature) => {
    feature.lines.forEach((line) => overlay.add(window.A.polyline(line)));
  });
  return overlay;
}

function buildConstellationBoundsOverlay(aladin: any, features: ConstellationBoundaryFeature[]): any {
  const overlay = window.A.graphicOverlay({
    name: 'Constellation boundaries', color: '#64748b', lineWidth: 1, lineDash: [4, 4],
  });
  aladin.addOverlay(overlay);
  features.forEach((feature) => overlay.add(window.A.polygon(feature.polygon)));
  return overlay;
}

/** Inverse of fovCorners' rotation: given a point's world RA/DEC, is it inside the
 * centerRa/centerDec-centered, widthDeg x heightDeg rectangle rotated by paDeg? Used to turn a
 * SIMBAD cone search (necessarily circular) into an accurate "inside this rectangle" test. */
function isInsideFov(
  centerRa: number, centerDec: number, objRa: number, objDec: number,
  widthDeg: number, heightDeg: number, paDeg: number,
): boolean {
  const paRad = (paDeg * Math.PI) / 180;
  const cosDec = Math.max(0.01, Math.cos((centerDec * Math.PI) / 180));
  const rx = (objRa - centerRa) * cosDec;
  const ry = objDec - centerDec;
  const dx = rx * Math.cos(paRad) + ry * Math.sin(paRad);
  const dy = -rx * Math.sin(paRad) + ry * Math.cos(paRad);
  return Math.abs(dx) <= widthDeg / 2 && Math.abs(dy) <= heightDeg / 2;
}

/** SIMBAD's own object-type taxonomy (https://simbad.cds.unistra.fr/guide/otypes.htx) files
 * planetary nebulae and Herbig-Haro objects under "stars" and puts star clusters in their own
 * "sets of stars" branch — neither reads as "a star" or "a galaxy" to an imager, so this is a
 * hand-picked allowlist of `otype` label values (not a blanket category exclusion) covering
 * every nebula/cloud/remnant/cluster type plus their named sub-regions, and nothing else.
 * Maps each to a short human-readable label for display, since the raw otype strings are terse
 * SIMBAD internal labels (e.g. "SNRemnant", "PoC"). */
const INTERESTING_OTYPES: Record<string, string> = {
  HIIReg: 'HII region',
  PlanetaryNeb: 'Planetary nebula',
  GalNeb: 'Nebula',
  DarkNeb: 'Dark nebula',
  RefNeb: 'Reflection nebula',
  SNRemnant: 'Supernova remnant',
  MolCld: 'Molecular cloud',
  Cloud: 'Cloud',
  StarFormingReg: 'Star forming region',
  ISM: 'Interstellar medium',
  ComGlob: 'Cometary globule',
  HVCld: 'High-velocity cloud',
  Bubble: 'Bubble',
  denseCore: 'Dense core',
  Filament: 'Filament',
  Globule: 'Globule',
  HIshell: 'Shell',
  HerbigHaroObj: 'Herbig-Haro object',
  'Cluster*': 'Star cluster',
  OpenCluster: 'Open cluster',
  GlobCluster: 'Globular cluster',
  Association: 'Association of stars',
  PartofCloud: 'Part of cloud/nebula',
  Region: 'Region',
};

/** SIMBAD conesearch results ("distance" is degrees from the search center) filtered to
 * INTERESTING_OTYPES and to the true rotated rectangle (the conesearch itself is a circle sized
 * to comfortably cover the rectangle's corners, so it over-fetches at the edges), then sorted by
 * distance from the FOV center so the most relevant hits are first. */
function findFovObjects(
  sources: any[], centerRa: number, centerDec: number, widthDeg: number, heightDeg: number, paDeg: number,
): SimbadFovObject[] {
  return sources
    .map((s) => s.data)
    .filter((d) => d.otype in INTERESTING_OTYPES)
    .filter((d) => isInsideFov(centerRa, centerDec, parseFloat(d.ra), parseFloat(d.dec), widthDeg, heightDeg, paDeg))
    .map((d) => ({
      // SIMBAD prefixes proper/common names with "NAME " to mark the identifier type — real for
      // its own catalog but just noise for display or for searching other sites by name.
      name: String(d.main_id).replace(/\s+/g, ' ').trim().replace(/^NAME\s+/, ''),
      typeLabel: INTERESTING_OTYPES[d.otype],
      ra: parseFloat(d.ra),
      dec: parseFloat(d.dec),
      sizeArcmin: parseFloat(d.galdim_majaxis),
      distanceArcmin: parseFloat(d.distance) * 60,
    }))
    .sort((a, b) => a.distanceArcmin - b.distanceArcmin);
}

interface SimbadFovObject {
  name: string;
  typeLabel: string;
  ra: number;
  dec: number;
  sizeArcmin: number;
  distanceArcmin: number;
}

function astrobinSearchUrl(name: string): string {
  return `https://www.astrobin.com/search/?q=${encodeURIComponent(name)}`;
}

/** f.corners (Advanced Plate Solving) are real per-corner RA/Dec straight from AstroBin, so the
 * image's actual parity comes along with them for free — no assumption needed. Without that (a
 * basic solve, just center + size + a single orientation angle, no parity info at all), fovCorners
 * needs `mirrored: true` here specifically — see its own comment for why this is AstroBin's
 * convention, not the same sign the live-capture overlay's Ekos `pa` needs. */
function footprintCorners(f: AstrobinFootprint): [number, number][] {
  return f.corners ?? fovCorners(f.ra, f.dec, f.widthDeg, f.heightDeg, f.orientationDeg, true);
}

/** Great-circle angular separation between two sky points, in degrees (haversine formula) — used
 * only for the cheap "is this footprint anywhere near the current view" pre-filter below, not for
 * anything that needs to account for the current projection (that's what world2pix is for). Orders
 * of magnitude cheaper than a real projection call, which is the whole point: with a gallery in the
 * hundreds, computeScreenRect's 4 world2pix calls per footprint (measured ~2000 calls/frame, ~2ms,
 * during a real pan with this gallery) run for every footprint on every redraw, most of which are
 * nowhere near the current view and were always going to be thrown away by the existing screen-
 * bounds check further down — this lets most of them skip that work entirely. */
function angularSeparationDeg(ra1Deg: number, dec1Deg: number, ra2Deg: number, dec2Deg: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dPhi = toRad(dec2Deg - dec1Deg);
  const dLambda = toRad(ra2Deg - ra1Deg);
  const sinDPhi2 = Math.sin(dPhi / 2);
  const sinDLambda2 = Math.sin(dLambda / 2);
  const phi1 = toRad(dec1Deg);
  const phi2 = toRad(dec2Deg);
  const h = sinDPhi2 * sinDPhi2 + Math.cos(phi1) * Math.cos(phi2) * sinDLambda2 * sinDLambda2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(h))) * 180) / Math.PI;
}

/** A rough (not tangent-plane-exact — doesn't need to be, see angularSeparationDeg's own comment)
 * center and angular half-diagonal "radius" for the pre-filter below. Plain (a+b)/2 on the two
 * diagonal corners, unwrapped across the RA=0/360 seam the same way tangentPlaneCenter's own
 * comment describes — off by a similar small fraction of a degree near a pole, negligible next to
 * the generous margin the pre-filter already applies. */
function footprintCenterAndRadiusDeg(f: AstrobinFootprint): { ra: number; dec: number; radiusDeg: number } {
  if (!f.corners) {
    return { ra: f.ra, dec: f.dec, radiusDeg: Math.hypot(f.widthDeg, f.heightDeg) / 2 };
  }
  const [ra0, dec0] = f.corners[0];
  let ra2 = f.corners[2][0];
  if (ra2 - ra0 > 180) ra2 -= 360;
  else if (ra0 - ra2 > 180) ra2 += 360;
  const dec2 = f.corners[2][1];
  return {
    ra: ((ra0 + ra2) / 2 + 360) % 360,
    dec: (dec0 + dec2) / 2,
    radiusDeg: angularSeparationDeg(ra0, dec0, f.corners[2][0], dec2) / 2,
  };
}

/** Independent, non-world2pix estimate of how large (in screen px) a footprint's own real angular
 * size should project to under the view's current FOV — pure spherical trig plus the container's
 * pixels-per-degree scale. Deliberately NOT derived from any world2pix call (unlike rect.w/h or a
 * mesh's own bounding span): confirmed live (RA 13h45m26.97s, DEC -63°43'47.4" under MOL) that both
 * of those can *already* be corrupted by the exact same projection breakdown this is meant to
 * catch — rect.h alone was 2.9x the container's own height there, so using it as the "how big
 * should this actually be" baseline would have meant trusting the very thing that's broken. */
function expectedFootprintDiagonalPx(f: AstrobinFootprint, aladin: any, containerW: number, containerH: number): number {
  const { radiusDeg } = footprintCenterAndRadiusDeg(f);
  const [fovX, fovY] = aladin.getFov();
  const fovDiagDeg = Math.hypot(fovX, fovY);
  if (!(fovDiagDeg > 0)) return Math.max(containerW, containerH);
  const pxPerDeg = Math.hypot(containerW, containerH) / fovDiagDeg;
  return radiusDeg * 2 * pxPerDeg;
}

/** Shoelace formula on the footprint's own corners, treating RA/Dec as planar — inaccurate as a
 * real deg² figure (no cos(dec) scaling, breaks near the RA=0/360 wrap) but every image in this
 * gallery is a few degrees across at most, so it's more than good enough to rank "which of these
 * two is the wider shot" for z-ordering below. */
function footprintAreaDeg2(f: AstrobinFootprint): number {
  if (!f.corners) return f.widthDeg * f.heightDeg;
  const pts = f.corners;
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Screen-space geometry of one drawn footprint, recomputed every redraw() and consumed by
 * hitTestAstrobinFootprint below — a canvas has no DOM nodes of its own to hang hover/click
 * listeners off, so hit-testing has to be done by hand against this list instead. */
interface AstrobinHitRect extends ScreenRect {
  footprint: AstrobinFootprint;
  hidden: boolean;
}

const ASTROBIN_GEAR_SIZE = 20;
const ASTROBIN_GEAR_MARGIN = 2;

/** Point-in-rotated-rectangle test: rotate the query point into the rectangle's own local
 * (unrotated) frame around its center, then it's a plain axis-aligned bounds check. */
function pointInRotatedRect(px: number, py: number, r: ScreenRect): [number, number] {
  const dx = px - r.cx;
  const dy = py - r.cy;
  const localX = dx * Math.cos(r.angleRad) + dy * Math.sin(r.angleRad);
  const localY = -dx * Math.sin(r.angleRad) + dy * Math.cos(r.angleRad);
  return [localX, localY];
}

/** The gear button's local position within its (hidden) footprint's own rotated frame — top-right
 * corner inset by ASTROBIN_GEAR_MARGIN, matching the old CSS `top: 2px; right: 2px`. Shared by the
 * draw and hit-test code so they can't drift apart. */
function astrobinGearCenter(r: ScreenRect): [number, number] {
  return [r.w / 2 - ASTROBIN_GEAR_MARGIN - ASTROBIN_GEAR_SIZE / 2, -r.h / 2 + ASTROBIN_GEAR_MARGIN + ASTROBIN_GEAR_SIZE / 2];
}

/** The rect's own bottom-right corner in screen space — not just cx+w/2,cy+h/2, since the box is
 * rotated and "bottom-right" has to mean whichever of its four corners is actually furthest
 * down-and-right on screen, not a corner that rotates along with the image itself (a popover
 * anchored to a rotating corner would swing around as the footprint's rotation angle carries it
 * — the whole point here is a stable anchor). */
function screenRectBottomRight(r: ScreenRect): [number, number] {
  const hw = r.w / 2;
  const hh = r.h / 2;
  const cos = Math.cos(r.angleRad);
  const sin = Math.sin(r.angleRad);
  const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [dx, dy] of corners) {
    maxX = Math.max(maxX, r.cx + dx * cos - dy * sin);
    maxY = Math.max(maxY, r.cy + dx * sin + dy * cos);
  }
  return [maxX, maxY];
}

/** Iterates hit rects in reverse (later entries paint on top — see drawAstrobinFootprints) so the
 * topmost thing under the cursor wins. Hidden footprints only expose their small gear button —
 * the canvas equivalent of the old wrapper's `pointer-events: none` — so the rest of their (still
 * wide-field-sized) box doesn't shadow whatever's underneath. */
function hitTestAstrobinFootprint(x: number, y: number, rects: AstrobinHitRect[]): { footprint: AstrobinFootprint; onGear: boolean } | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    const [localX, localY] = pointInRotatedRect(x, y, r);
    if (r.hidden) {
      const [gx, gy] = astrobinGearCenter(r);
      if (Math.abs(localX - gx) <= ASTROBIN_GEAR_SIZE / 2 && Math.abs(localY - gy) <= ASTROBIN_GEAR_SIZE / 2) {
        return { footprint: r.footprint, onGear: true };
      }
      continue;
    }
    if (Math.abs(localX) <= r.w / 2 && Math.abs(localY) <= r.h / 2) {
      return { footprint: r.footprint, onGear: false };
    }
  }
  return null;
}

// Shared by every getAstrobinImage call below (module-level, not per-render) — a gallery with a
// few dozen simultaneously-visible footprints (see drawAstrobinFootprints' own comment) used to
// fire one `new Image().src = url` per footprint at once, easily blowing past the browser's
// 6-connections-per-origin limit on its own. 4 rather than the full 6 (or the old 3): these share
// the same origin as the HiPS tile proxy and every other API call this component makes, so this
// leaves some of that per-origin budget free for those instead of thumbnails claiming all of it —
// each slot only frees once its own fetch's body has fully downloaded and become a Blob (see
// createConcurrencyLimiter), not just once headers arrive, so this is also a cap on simultaneous
// in-flight downloads, not just requests-issued.
const astrobinThumbnailLimiter = createConcurrencyLimiter(4);

/** Loaded once per thumbnailUrl and reused across redraws/frames — plain Image objects rather than
 * DOM <img> elements, since these are only ever drawImage()'d onto the canvas, never inserted.
 * Keyed by thumbnailUrl rather than hash: despite AstrobinFootprintBase's type saying hash is a
 * plain string, real API responses send `hash: null` for a real share of images (confirmed on a
 * live gallery: 66 of 238 footprints, all with distinct thumbnails) — every one of those collapsed
 * into the *same* Map entry keyed by the literal string "null", so whichever of those 66 images
 * happened to load first got drawn for all the others too, and which one won that race varied
 * between loads. thumbnailUrl has no such problem (confirmed unique across the same gallery).
 * Fetched (through the limiter above) rather than assigned straight to img.src, and handed a blob:
 * URL once ready: this requires thumbnailUrl to be a same-origin (or at least CORS-permissive)
 * URL — both this package's consumers proxy it through their own backend rather than linking
 * straight to AstroBin's CDN, see astro-homepage's /api/image-cache and KStarsCluster's own
 * AstrobinProxyServlet#serveThumbnail. onSettled fires (and triggers a redraw) whether the load
 * succeeded or failed, so a broken thumbnail can't leave the loading gate stuck open forever. */
function getAstrobinImage(
  cache: Map<string, HTMLImageElement>,
  f: AstrobinFootprint,
  onLoadStart: (key: string) => void,
  onSettled: (key: string) => void,
): HTMLImageElement {
  const key = f.thumbnailUrl;
  let img = cache.get(key);
  if (img) return img;

  img = new Image();
  cache.set(key, img);
  onLoadStart(key);
  const settle = () => onSettled(key);

  astrobinThumbnailLimiter(() =>
    fetch(f.thumbnailUrl).then((res) => {
      if (!res.ok) throw new Error(`thumbnail fetch failed: ${res.status}`);
      return res.blob();
    }),
  )
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      img!.onload = settle;
      img!.onerror = settle;
      img!.src = url;
    })
    .catch(settle);

  return img;
}

/** Redraws the gear/settings icon by hand instead of rasterizing the old SVG — same geometry (8
 * teeth around a ring, viewBox 24x24 centered at 12,12), just emitted as canvas path calls
 * directly at whatever scale the button needs, rather than loading yet another image
 * asynchronously for something this simple. */
function drawGearButton(ctx: CanvasRenderingContext2D, gx: number, gy: number, size: number) {
  const half = size / 2;
  ctx.save();
  ctx.translate(gx, gy);
  ctx.fillStyle = 'rgba(15, 17, 26, 0.85)';
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1;
  ctx.fillRect(-half, -half, size, size);
  ctx.strokeRect(-half, -half, size, size);

  const s = (size * 0.7) / 24;
  ctx.fillStyle = '#22d3ee';
  for (let deg = 0; deg < 360; deg += 45) {
    ctx.save();
    ctx.rotate((deg * Math.PI) / 180);
    ctx.fillRect(-1.5 * s, -11.5 * s, 3 * s, 5 * s);
    ctx.restore();
  }
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(0, 0, 7 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 2.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// 4x4 (16-cell, 32-triangle) mesh per footprint — enough to make the curvature a real WCS
// reprojection would show visible at these field sizes, cheap enough that even a few dozen
// simultaneously-visible footprints (the realistic case — off-screen ones are already filtered
// out by drawAstrobinFootprints before this runs) stays well under a frame budget.
const ASTROBIN_MESH_GRID_SIZE = 4;

/** Bilinearly interpolates within the sky-tangent-plane (xi,eta) coordinates of a footprint's 4
 * corners — flat there even though RA/Dec itself isn't, same reasoning as tangentPlaneCenter's own
 * comment — then projects each interpolated point to screen via world2pix. An NxN grid built this
 * way closely tracks the true curve a real per-pixel WCS reprojection would show for a field this
 * small, without needing Aladin's own image-layer pipeline at all (registering every footprint as
 * its own Aladin image layer scales O(n²) with the total registered count and becomes unusable
 * past ~50 simultaneous layers; this scales with however many are on screen right now times a
 * fixed 32 triangles, however large the gallery gets). Returns null wholesale only if the
 * tangent-plane center itself is degenerate; individual unprojectable grid points (e.g. right at
 * an all-sky projection's edge) instead leave a null hole in the returned grid, which
 * drawImageMesh/drawMeshOutline skip over rather than failing the whole footprint. */
function computeFootprintMesh(
  aladin: any, corners: [number, number][], gridSize: number,
): ([number, number] | null)[][] | null {
  const [ra0, dec0] = tangentPlaneCenter(corners[0], corners[2]);
  if (!Number.isFinite(ra0) || !Number.isFinite(dec0)) return null;
  const [xiTL, etaTL] = gnomonicXiEta(corners[0][0], corners[0][1], ra0, dec0);
  const [xiTR, etaTR] = gnomonicXiEta(corners[1][0], corners[1][1], ra0, dec0);
  const [xiBR, etaBR] = gnomonicXiEta(corners[2][0], corners[2][1], ra0, dec0);
  const [xiBL, etaBL] = gnomonicXiEta(corners[3][0], corners[3][1], ra0, dec0);

  const mesh: ([number, number] | null)[][] = [];
  for (let j = 0; j <= gridSize; j++) {
    const v = j / gridSize;
    const row: ([number, number] | null)[] = [];
    for (let i = 0; i <= gridSize; i++) {
      const u = i / gridSize;
      const xi = xiTL * (1 - u) * (1 - v) + xiTR * u * (1 - v) + xiBR * u * v + xiBL * (1 - u) * v;
      const eta = etaTL * (1 - u) * (1 - v) + etaTR * u * (1 - v) + etaBR * u * v + etaBL * (1 - u) * v;
      const [ra, dec] = invGnomonic(xi, eta, ra0, dec0);
      row.push(safeWorld2Pix(aladin, ra, dec));
    }
    mesh.push(row);
  }
  return mesh;
}

/** Widest horizontal/vertical spread across every projected point in the mesh (nulls skipped).
 * drawImageMesh's own per-cell maxSpanPx guard only catches a *sudden* jump between two adjacent
 * grid points — it does nothing for a distortion that instead drifts a little at a time, cell by
 * cell, across an entire row (confirmed under MOL near a different pole-adjacent declination than
 * the single-corner-jump case: every individual cell stayed under the per-cell threshold, yet the
 * row's points crept all the way from one edge of the canvas to the other, painting a thin sliver
 * stretched across nearly the full width). Checking the mesh's overall bounding box catches that
 * case too — a real small footprint's projected mesh never approaches canvas-sized extent even
 * under heavy curvature, so a mesh that does is symptomatic of the same underlying projection
 * breakdown regardless of whether it shows up as one big jump or many small ones. */
function meshBoundingSpan(mesh: ([number, number] | null)[][], gridSize: number): { spanX: number; spanY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j <= gridSize; j++) {
    for (let i = 0; i <= gridSize; i++) {
      const p = mesh[j][i];
      if (!p) continue;
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return { spanX: maxX - minX, spanY: maxY - minY };
}

/** The unique affine transform mapping source triangle (sx0,sy0)/(sx1,sy1)/(sx2,sy2) onto
 * destination triangle (dx0,dy0)/(dx1,dy1)/(dx2,dy2), as the 6 values ctx.transform expects —
 * solved directly via Cramer's rule rather than a general matrix library, since it's always
 * exactly this one 3x3 system. Returns null for a source triangle with ~zero area (would require
 * dividing by ~0) rather than producing a garbage transform. */
function triangleAffine(
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  dx0: number, dy0: number, dx1: number, dy1: number, dx2: number, dy2: number,
): [number, number, number, number, number, number] | null {
  const denom = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(denom) < 1e-9) return null;
  const a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / denom;
  const b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / denom;
  const c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / denom;
  const d = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / denom;
  const e = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / denom;
  const f = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / denom;
  return [a, b, c, d, e, f];
}

/** Clips to one destination triangle and draws `img` through the affine transform that maps the
 * corresponding source-pixel triangle onto it — canvas 2D has no single-call perspective/bilinear
 * warp, so a mesh is only ever drawn one flat (but small, so imperceptibly non-planar) triangle at
 * a time. Silently skips a degenerate triangle (see triangleAffine) rather than throwing. */
function drawTexturedTriangle(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number,
  d0: [number, number], d1: [number, number], d2: [number, number],
) {
  const m = triangleAffine(sx0, sy0, sx1, sy1, sx2, sy2, d0[0], d0[1], d1[0], d1[1], d2[0], d2[1]);
  if (!m) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0[0], d0[1]);
  ctx.lineTo(d1[0], d1[1]);
  ctx.lineTo(d2[0], d2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(...m);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/** Draws `img` warped onto `mesh` (see computeFootprintMesh) — each grid cell split into 2
 * triangles sharing the p00/p11 diagonal, each textured independently. A cell with any null
 * (unprojectable) corner is skipped entirely rather than drawn with a made-up point. */
function drawImageMesh(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement,
  mesh: ([number, number] | null)[][], gridSize: number,
  maxSpanPx: number,
) {
  const { naturalWidth, naturalHeight } = img;
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const p00 = mesh[j][i];
      const p10 = mesh[j][i + 1];
      const p11 = mesh[j + 1][i + 1];
      const p01 = mesh[j + 1][i];
      if (!p00 || !p10 || !p11 || !p01) continue;
      // Belt-and-suspenders against the same azimuthal-projection edge the pre-filter in
      // drawAstrobinFootprints already guards against (see its own comment): a legitimate mesh
      // cell never spans anywhere close to the whole visible canvas, so a cell whose own corners
      // are farther apart than that is a sign world2pix stopped varying smoothly here, not a
      // real (if extreme) piece of curvature — skip it rather than paint a degenerate triangle
      // across most of the sky.
      const xs = [p00[0], p10[0], p11[0], p01[0]];
      const ys = [p00[1], p10[1], p11[1], p01[1]];
      if (Math.max(...xs) - Math.min(...xs) > maxSpanPx || Math.max(...ys) - Math.min(...ys) > maxSpanPx) continue;
      const sx0 = (i / gridSize) * naturalWidth;
      const sx1 = ((i + 1) / gridSize) * naturalWidth;
      const sy0 = (j / gridSize) * naturalHeight;
      const sy1 = ((j + 1) / gridSize) * naturalHeight;
      drawTexturedTriangle(ctx, img, sx0, sy0, sx1, sy0, sx0, sy1, p00, p10, p01);
      drawTexturedTriangle(ctx, img, sx1, sy0, sx1, sy1, sx0, sy1, p10, p11, p01);
    }
  }
}

/** Traces the mesh's own outer boundary — the true (slightly curved) edge a real reprojection
 * would show — instead of a straight-sided rectangle. Walks all four sides of the grid in order;
 * a null (unprojectable) point just breaks that one segment rather than the whole outline. */
function drawMeshOutline(ctx: CanvasRenderingContext2D, mesh: ([number, number] | null)[][], gridSize: number) {
  ctx.beginPath();
  let started = false;
  const step = (p: [number, number] | null) => {
    if (!p) { started = false; return; }
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else { ctx.lineTo(p[0], p[1]); }
  };
  for (let i = 0; i <= gridSize; i++) step(mesh[0][i]);
  for (let j = 1; j <= gridSize; j++) step(mesh[j][gridSize]);
  for (let i = gridSize - 1; i >= 0; i--) step(mesh[gridSize][i]);
  for (let j = gridSize - 1; j >= 0; j--) step(mesh[j][0]);
  ctx.stroke();
}

// GPU rasterization of the same mesh drawImageMesh draws with Canvas2D — fills every pixel of a
// triangle exactly once by construction, so two triangles sharing an edge can't show the faint
// seam Canvas2D's independent per-call clip()+drawImage() sometimes leaves along mesh-cell
// boundaries (confirmed live: neither a bigger clip-path overlap nor
// globalCompositeOperation='copy' fixed it there — see drawTexturedTriangle's own comment). Same
// technique Aladin itself uses to rasterize its own HiPS tiles. Validated first in
// SkyMapCard3D.tsx's standalone WebGL PoC before being folded in here as drawOneAstrobinFootprint's
// preferred path, with drawImageMesh kept as the fallback for a browser/GPU that can't give us a
// WebGL context at all (see the `webgl` param below).
const ASTROBIN_WEBGL_VERTEX_SHADER = `
  attribute vec2 aPosition;
  attribute vec2 aTexCoord;
  uniform vec2 uResolution;
  varying vec2 vTexCoord;
  void main() {
    vec2 clip = (aPosition / uResolution) * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    vTexCoord = aTexCoord;
  }
`;

const ASTROBIN_WEBGL_FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 vTexCoord;
  uniform sampler2D uTexture;
  uniform float uOpacity;
  void main() {
    vec4 texColor = texture2D(uTexture, vTexCoord);
    gl_FragColor = vec4(texColor.rgb, texColor.a * uOpacity);
  }
`;

function createAstrobinShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`AstroBin WebGL shader compile failed: ${info}`);
  }
  return shader;
}

function createAstrobinProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vs = createAstrobinShader(gl, gl.VERTEX_SHADER, ASTROBIN_WEBGL_VERTEX_SHADER);
  const fs = createAstrobinShader(gl, gl.FRAGMENT_SHADER, ASTROBIN_WEBGL_FRAGMENT_SHADER);
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`AstroBin WebGL program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

/** Index buffer for an NxN cell grid — same p00/p10/p01 + p10/p11/p01 diagonal split as
 * drawImageMesh's own triangulation, so switching a footprint between the WebGL and Canvas2D path
 * (see the `webgl` fallback below) never changes which diagonal a cell is split on. Depends only on
 * gridSize, never on where a mesh's vertices actually project to — built once and reused for every
 * footprint and every redraw. */
function buildAstrobinMeshIndices(gridSize: number): Uint16Array {
  const indices: number[] = [];
  const stride = gridSize + 1;
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const p00 = j * stride + i;
      const p10 = j * stride + (i + 1);
      const p01 = (j + 1) * stride + i;
      const p11 = (j + 1) * stride + (i + 1);
      indices.push(p00, p10, p01, p10, p11, p01);
    }
  }
  return new Uint16Array(indices);
}

/** Same (u,v) for every footprint regardless of where it projects to on screen — built once and
 * reused, only the position buffer needs recomputing per redraw. u=i/N/v=j/N matches
 * drawImageMesh's own sx=(i/N)*naturalWidth/sy=(j/N)*naturalHeight source-pixel mapping directly —
 * v=0 lands on the image's own top row the same way sy=0 does there, with texture upload left
 * un-flipped (see getOrCreateAstrobinTexture's own comment for why FLIP_Y_WEBGL is wrong here). */
function buildAstrobinMeshTexCoords(gridSize: number): Float32Array {
  const coords: number[] = [];
  const stride = gridSize + 1;
  for (let j = 0; j < stride; j++) {
    for (let i = 0; i < stride; i++) {
      coords.push(i / gridSize, j / gridSize);
    }
  }
  return new Float32Array(coords);
}

/** Everything created once (Aladin-init-time, see the AstroBin WebGL setup effect) and reused
 * across every redraw/footprint — only `textures` and the position buffer's own contents change
 * per-frame. Absent (drawOneAstrobinFootprint gets `null`) when the browser hands back no WebGL
 * context at all, in which case that function falls back to the Canvas2D drawImageMesh path. */
interface AstrobinGl {
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  indexBuffer: WebGLBuffer;
  texCoordBuffer: WebGLBuffer;
  positionBuffer: WebGLBuffer;
  indexCount: number;
  textures: Map<string, WebGLTexture>;
}

/** Flattens a computeFootprintMesh grid into the Float32Array drawFootprintImageWebGL needs, or
 * null if any grid point is unprojectable — same belt-and-suspenders reasoning as
 * computeFootprintMesh itself returning null wholesale rather than drawing a mesh with made-up
 * points: a WebGL index buffer's triangle connectivity is fixed up front, unlike drawImageMesh's
 * per-cell skip, so there's no equivalent of "skip just this one cell" here. */
function meshToPositions(mesh: ([number, number] | null)[][], gridSize: number): Float32Array | null {
  const stride = gridSize + 1;
  const positions = new Float32Array(stride * stride * 2);
  for (let j = 0; j < stride; j++) {
    for (let i = 0; i < stride; i++) {
      const p = mesh[j][i];
      if (!p) return null;
      const idx = (j * stride + i) * 2;
      positions[idx] = p[0];
      positions[idx + 1] = p[1];
    }
  }
  return positions;
}

/** Uploaded once per thumbnailUrl and reused across redraws — mirrors getAstrobinImage's own
 * cache-by-key reasoning. Textures straight from the already-loaded HTMLImageElement (getAstrobinImage
 * already fetched it through the concurrency limiter and decoded it into that Image), so this needs
 * no fetch/blob/createImageBitmap step of its own the way a from-scratch WebGL loader would. Only
 * ever called once `imageReady` (img.complete && naturalWidth > 0) is true. */
function getOrCreateAstrobinTexture(
  gl: WebGLRenderingContext, cache: Map<string, WebGLTexture>, key: string, img: HTMLImageElement,
): WebGLTexture {
  let texture = cache.get(key);
  if (texture) return texture;
  texture = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // NOT flipped — confirmed live (comparing a landscape/comet shot's own left-right handedness,
  // road vs. comet-tail direction, against the real photo) that UNPACK_FLIP_Y_WEBGL=true mirrors
  // every footprint vertically instead of matching drawImageMesh's own sy=(j/N)*naturalHeight,
  // which needs no flip at all since Canvas2D's source-pixel Y already runs top-to-bottom, same
  // direction computeFootprintMesh's own v does. Left this comment instead of just quietly fixing
  // it, since the "obvious" WebGL convention (this flag is *supposed* to make top-left-origin
  // texcoords act intuitive) turned out backwards for how this specific texture is sampled.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  cache.set(key, texture);
  return texture;
}

/** Draws one footprint's mesh-warped image via WebGL — the seam-free replacement for
 * drawImageMesh. cssWidth/cssHeight are the *CSS*-pixel container size (matching the CSS-pixel
 * units `positions` already carries, straight from world2pix), not the canvas's own (possibly
 * devicePixelRatio-scaled) backing-store size — gl.viewport is what maps clip space onto the full
 * backing store regardless, so feeding it the CSS size here keeps this resolution-independent. */
function drawFootprintImageWebGL(
  webgl: AstrobinGl, texture: WebGLTexture, positions: Float32Array, opacity: number,
  cssWidth: number, cssHeight: number,
) {
  const { gl, program, indexBuffer, texCoordBuffer, positionBuffer, indexCount } = webgl;
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, 'uResolution'), cssWidth, cssHeight);
  gl.uniform1f(gl.getUniformLocation(program, 'uOpacity'), opacity);

  const aPosition = gl.getAttribLocation(program, 'aPosition');
  const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
  gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
  gl.enableVertexAttribArray(aTexCoord);
  gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(aPosition);
  gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, 'uTexture'), 0);

  gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
}

function drawOneAstrobinFootprint(
  ctx: CanvasRenderingContext2D,
  aladin: any,
  f: AstrobinFootprint,
  rect: ScreenRect,
  hidden: boolean,
  isSelected: boolean,
  imagesCache: Map<string, HTMLImageElement>,
  onLoadStart: (key: string) => void,
  onSettled: (key: string) => void,
  containerW: number,
  containerH: number,
  // False while any footprint thumbnail in the current batch is still loading — see
  // pendingAstrobinImages below. Keeps every image in a redraw pass appearing together instead of
  // popping in one at a time as each fetch happens to finish.
  canShowImages: boolean,
  // Null when the browser handed back no WebGL context at all (see the AstroBin WebGL setup
  // effect) — drawImageMesh is the Canvas2D fallback for that case, seam and all.
  webgl: AstrobinGl | null,
) {
  const { cx, cy, w, h, angleRad } = rect;
  // rect.w/h and a mesh's own point cloud both come from world2pix, which can land a footprint's
  // corner(s) anywhere from "a single huge jump" to "a gradual smear across many mesh cells" once a
  // projection breaks down (confirmed under MOL/AIT/MER, both near a pole and at other declinations)
  // — every place below that draws straight off screen-space extents (the hidden/dashed outline
  // here, the mesh path, and the mesh-less fallback) needs a guard against that, or it paints a
  // rect/image stretched across most of the canvas. The bound itself comes from the footprint's own
  // real angular size (see expectedFootprintDiagonalPx's own comment for why not e.g. a flat
  // fraction of the canvas instead) times a generous multiplier — real curvature under a legitimate
  // projection stretches a footprint some, but nowhere near this large a multiple of its expected
  // size; a 40px floor keeps a tiny or badly-solved footprint from being held to an unreasonably
  // strict bound.
  const maxSpanPx = Math.max(expectedFootprintDiagonalPx(f, aladin, containerW, containerH) * 6, 40);
  if (hidden) {
    if (w > maxSpanPx || h > maxSpanPx) return;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);
    ctx.strokeStyle = '#22d3ee';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.setLineDash([]);
    const [gx, gy] = astrobinGearCenter(rect);
    drawGearButton(ctx, gx, gy, ASTROBIN_GEAR_SIZE);
    ctx.restore();
    return;
  }
  const img = getAstrobinImage(imagesCache, f, onLoadStart, onSettled);
  const imageReady = canShowImages && img.complete && img.naturalWidth > 0;
  // opacity applies to the image AND its outline together, matching the old CSS behavior of
  // opacity on the whole footprint element.
  ctx.globalAlpha = isSelected ? 1 : 0.8;
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 1;
  // The screen-projection curvature a mesh corrects for applies to *any* sky-registered rectangle,
  // not just real per-corner solves — the ra/dec/width/height/orientation fallback's 4 corners
  // (from fovCorners) bend under the current projection exactly the same way. Its corners come out
  // in the opposite winding order though (see computeScreenRect's own extraHalfTurn comment for
  // why), so its source-pixel (0,0) corresponds to the diagonally-opposite corner (index 2, not 0)
  // — reordering the corners array by two positions before interpolating is equivalent to that same
  // 180° correction, just expressed as a relabeling instead of an extra rotation.
  const meshCorners = f.corners ?? (([a, b, c, d]) => [c, d, a, b])(footprintCorners(f));
  // Computed regardless of imageReady: the mesh is just the sky-curvature geometry, no image
  // pixels involved (drawMeshOutline traces it, drawImageMesh separately textures it) — gating it
  // on imageReady meant the outline shown while a thumbnail is still loading was a plain
  // straight-sided rect instead of the true (slightly curved) shape, purely because texturing and
  // outlining used to be bundled behind the same condition.
  const rawMesh = computeFootprintMesh(aladin, meshCorners, ASTROBIN_MESH_GRID_SIZE);
  // A mesh whose points collectively sprawl across most of the canvas is just as broken as one
  // with a single oversized cell (see meshBoundingSpan's own comment) — discard the whole thing
  // rather than let drawImageMesh paint every individual (locally-small) cell of a row that's
  // gradually smeared from one edge of the screen to the other.
  let mesh = rawMesh;
  if (mesh) {
    const { spanX, spanY } = meshBoundingSpan(mesh, ASTROBIN_MESH_GRID_SIZE);
    if (spanX > maxSpanPx || spanY > maxSpanPx) mesh = null;
  }
  if (mesh) {
    if (imageReady) {
      const positions = webgl ? meshToPositions(mesh, ASTROBIN_MESH_GRID_SIZE) : null;
      if (webgl && positions) {
        const texture = getOrCreateAstrobinTexture(webgl.gl, webgl.textures, f.thumbnailUrl, img);
        drawFootprintImageWebGL(webgl, texture, positions, isSelected ? 1 : 0.8, containerW, containerH);
      } else {
        // No WebGL context, or a grid point went unprojectable this one frame (see
        // meshToPositions) — Canvas2D per-triangle drawing as a fallback, seam and all, rather
        // than not drawing the image at all.
        drawImageMesh(ctx, img, mesh, ASTROBIN_MESH_GRID_SIZE, maxSpanPx);
      }
    }
    drawMeshOutline(ctx, mesh, ASTROBIN_MESH_GRID_SIZE);
  } else if (w <= maxSpanPx && h <= maxSpanPx) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angleRad);
    if (imageReady) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  // else: computeFootprintMesh itself failed (e.g. tangentPlaneCenter going non-finite right at a
  // pole, matching this bug's own repro) and the mesh-less fallback's own w/h were too far gone to
  // trust either — nothing to draw this frame.
  ctx.globalAlpha = 1;
}

/** Draws every currently-projectable footprint onto a single canvas instead of one absolutely-
 * positioned DOM element each — with a couple hundred images in a gallery, that used to mean a
 * couple hundred elements getting their transform/size recomputed on every pan/zoom frame; a
 * canvas redraw touches no layout at all. `footprints` is expected pre-sorted largest-first (see
 * its fetch call site) so a wide-field shot paints under any narrower one of the same target by
 * default; `selectedUrl` — whichever footprint currently has its popover open, see
 * handleAstrobinClick — is drawn last/on top regardless of its own size, replacing the transient
 * hover-raises-z-index behavior with one that stays put until the popover actually closes.
 * Returns the screen-space geometry of everything drawn, for the caller's own hit-testing. */
function drawAstrobinFootprints(
  ctx: CanvasRenderingContext2D,
  aladin: any,
  footprints: AstrobinFootprint[],
  hiddenUrls: Set<string>,
  selectedUrl: string | null,
  imagesCache: Map<string, HTMLImageElement>,
  onLoadStart: (key: string) => void,
  onSettled: (key: string) => void,
  containerW: number,
  containerH: number,
  canShowImages: boolean,
  webgl: AstrobinGl | null,
): AstrobinHitRect[] {
  const rects: AstrobinHitRect[] = [];
  let selectedEntry: { footprint: AstrobinFootprint; rect: ScreenRect } | null = null;

  // Cheap pre-filter (see angularSeparationDeg's own comment) — generous on purpose (1.5x the
  // reported FOV radius plus a flat 10° buffer): the exact check a few lines down (post-world2pix,
  // against the real screen bounds) is what actually decides what's drawn, this only skips the
  // 4-world2pix-call computeScreenRect for footprints nowhere near being a candidate. Capped at
  // 180° in general (nothing on a sphere is ever farther than that) but much tighter for Aladin's
  // azimuthal projections (ZEA/SIN/STG/TAN): these stay mathematically defined out to (near) 180°,
  // but well before that the projection's own derivative blows up, so world2pix stops varying
  // smoothly with position — confirmed directly by inspecting a mesh near this boundary, where
  // adjacent grid points (a few degrees apart on the sky) landed hundreds of pixels apart on
  // screen. Rendering a footprint out there doesn't produce a recognizable (if distorted) image,
  // it produces an enormous degenerate mesh triangle that paints over most of the visible sky.
  const AZIMUTHAL_PROJECTIONS_MAX_RADIUS_DEG = 105;
  const AZIMUTHAL_PROJECTIONS = new Set(['ZEA', 'SIN', 'STG', 'TAN']);
  const [viewRa, viewDec] = aladin.getRaDec();
  const [fovX, fovY] = aladin.getFov();
  const projectionName = typeof aladin.getProjectionName === 'function' ? aladin.getProjectionName() : null;
  const maxViewRadiusDeg = projectionName && AZIMUTHAL_PROJECTIONS.has(projectionName)
    ? AZIMUTHAL_PROJECTIONS_MAX_RADIUS_DEG
    : 180;
  const viewRadiusDeg = Math.min(maxViewRadiusDeg, (Math.max(fovX, fovY) / 2) * 1.5 + 10);

  for (const footprint of footprints) {
    const { ra: fRa, dec: fDec, radiusDeg: fRadiusDeg } = footprintCenterAndRadiusDeg(footprint);
    if (angularSeparationDeg(viewRa, viewDec, fRa, fDec) > viewRadiusDeg + fRadiusDeg) continue;

    const hidden = hiddenUrls.has(footprint.url);
    const rect = computeScreenRect(aladin, footprintCorners(footprint), !footprint.corners);
    if (!rect) continue;
    // world2pix returning non-null only means "this projection can map the point somewhere" — for
    // an all-sky projection (ZEA, AIT, ...), unlike SIN's hemisphere, that's true for every point on
    // the sky, including a footprint on the opposite side of it, which still projects to *some*
    // (very far offscreen) pixel coordinate instead of null. Without this check every footprint in
    // the whole gallery got drawn on every redraw regardless of projection or view (confirmed: 254
    // draws for a 254-footprint gallery under ZEA, vs. the handful actually near the current view),
    // which is both a real performance cost and can visually place an unrelated footprint's rotated
    // rectangle back into the visible area purely from projection distortion at the extremes.
    //
    // rect.w/h can themselves already be the wraparound artifact (confirmed under MOL/AIT/MER near
    // a pole: two corners of the same small footprint project to opposite sides of the all-sky
    // ellipse, so hypot(w,h) balloons to several times the canvas). Left uncapped, halfDiag grows
    // right along with it and this filter stops filtering anything — the same maxSpanPx bound
    // drawImageMesh uses per-cell caps it here too, so a footprint this badly mis-projected is
    // culled before it ever reaches drawOneAstrobinFootprint's own (mesh-less) fallback below.
    const maxSpanPx = Math.max(containerW, containerH) * 3;
    const halfDiag = Math.min(Math.hypot(rect.w, rect.h), maxSpanPx) / 2;
    if (rect.cx < -halfDiag || rect.cx > containerW + halfDiag || rect.cy < -halfDiag || rect.cy > containerH + halfDiag) continue;
    rects.push({ footprint, hidden, ...rect });
    if (footprint.url === selectedUrl && !hidden) {
      selectedEntry = { footprint, rect };
      continue;
    }
    drawOneAstrobinFootprint(ctx, aladin, footprint, rect, hidden, false, imagesCache, onLoadStart, onSettled, containerW, containerH, canShowImages, webgl);
  }
  if (selectedEntry) {
    drawOneAstrobinFootprint(ctx, aladin, selectedEntry.footprint, selectedEntry.rect, false, true, imagesCache, onLoadStart, onSettled, containerW, containerH, canShowImages, webgl);
  }
  return rects;
}

/** AstroBin's coordinate search (RA/Dec-Koordinaten, an AstroBin Ultimate feature) encodes its
 * filter state in the `p` URL param, reverse engineered (with real Ultimate-account search URLs
 * as ground truth, and confirmed against AstroBin's own bundled JS) as:
 *   1. Build a query string via their own `toQueryString`-equivalent — each filter's value is
 *      `encodeURIComponent(JSON.stringify(...))`. RA is in *minutes of RA* (hours×60, i.e.
 *      degrees×4 — see astroUtilsService.raDegreesToMinutes: `4*l`), everything else plain degrees.
 *   2. That string is itself MessagePack-encoded as a single string value — msgpack's "str 8"
 *      format is a 0xD9 byte, a 1-byte length, then the raw UTF-8 bytes (confirmed byte-for-byte:
 *      captured URLs decompress to exactly length-N text prefixed by 0xD9,N). This step is easy to
 *      miss since it's invisible unless you inflate a real captured URL and notice the leading two
 *      "garbage" bytes are actually N and the string is exactly N bytes long.
 *   3. Deflate that (CompressionStream('deflate') produces the same zlib-wrapped stream pako.deflate
 *      does) and base64 the result.
 * Anyone without Ultimate can still open the resulting link — AstroBin just won't apply the filter
 * for them, same as manually clicking the locked option in their own UI. */
function msgpackEncodeString(str: string): Uint8Array {
  const utf8Bytes = new TextEncoder().encode(str);
  const len = utf8Bytes.length;
  let header: Uint8Array;
  if (len <= 0x1f) header = new Uint8Array([0xa0 | len]);
  else if (len <= 0xff) header = new Uint8Array([0xd9, len]);
  else if (len <= 0xffff) header = new Uint8Array([0xda, (len >> 8) & 0xff, len & 0xff]);
  else header = new Uint8Array([0xdb, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff]);
  const result = new Uint8Array(header.length + utf8Bytes.length);
  result.set(header, 0);
  result.set(utf8Bytes, header.length);
  return result;
}

async function astrobinCoordsSearchUrl(raDeg: number, decDeg: number, radiusDeg: number): Promise<string> {
  const textFilter = { value: '', matchType: 'ALL', onlySearchInTitlesAndDescriptions: false };
  const coords = { raCenter: raDeg * 4, decCenter: decDeg, radius: radiusDeg };
  const query = `text=${encodeURIComponent(JSON.stringify(textFilter))}`
    + `&coords=${encodeURIComponent(JSON.stringify(coords))}&page=1&pageSize=100`;
  const stream = new Blob([msgpackEncodeString(query) as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  let binary = '';
  new Uint8Array(buffer).forEach((b) => { binary += String.fromCharCode(b); });
  return `https://app.astrobin.com/search?p=${encodeURIComponent(btoa(binary))}`;
}

/** Decoded once (getImageData) when the Terrain panorama loads — see its own loader comment for
 * why this replaced drawing straight from the HTMLImageElement. */
interface TerrainPixelData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Columns for the downsampled az/alt lookup grid drawTerrainOverlay samples the panorama at —
 * KStars' own TerrainRenderer does the same trick (compute az/alt for every Nth screen pixel,
 * upscale/interpolate the rest) since per-pixel az/alt (one aladin.pix2world() call each) is the
 * expensive part; here the "upscale" step is just letting the browser's own smoothed drawImage
 * scale a tiny canvas up to full size. Sampling the source's own pixel array directly (see
 * TerrainPixelData) instead of one drawImage() per cell removed the per-call canvas overhead that
 * used to dominate, so this affords a much finer grid now: 280 cols × ~185 rows (~52,000
 * pix2world calls) measured at ~210ms, resolving individual roof shingles once upscaled, still
 * only paid once a pan/zoom gesture has settled (see terrainDebounceRef) — during the gesture
 * itself, TERRAIN_LIVE_SAMPLE_COLS is used instead (see its own comment for why). */
const TERRAIN_SAMPLE_COLS = 280;

/** Drawn on *every* redraw() call, not debounced — without this, the terrain layer visibly stayed
 * at its pre-gesture framing for the entire zoom/pan (however slow or fast) and only snapped to
 * the new view ~120ms after the mouse stopped, while Aladin's own WebGL view already tracked the
 * gesture live; that read as "the sky map shrinks, our overlay doesn't". Deliberately much coarser
 * than TERRAIN_SAMPLE_COLS — this one runs at the browser's actual frame rate for the whole
 * duration of a gesture, not once after it settles, so it needs to be cheap enough that a fast
 * flick of the scroll wheel never reintroduces the jank the debounced high-res pass exists to
 * avoid; the debounced pass then sharpens it once things settle, same as before. 48 cols (measured
 * ~17ms average per redraw during a continuous pan, one dropped frame in 59) is as far as this can
 * go without visibly dropping frames — TERRAIN_SAMPLE_COLS can be much higher because it only runs
 * once, debounced, not on every frame of the gesture. */
const TERRAIN_LIVE_SAMPLE_COLS = 48;

/** Reprojects the user's "Terrain" panorama (an equirectangular Az/Alt photo, see
 * ObservatoryInfo/KStarsConfig's Terrain.* keys) onto the sky map's current view for the chosen
 * simulation time — the exact inverse of how the image was meant to be read: for each screen pixel
 * (downsampled), find what RA/Dec Aladin is showing there, convert that to Alt/Az for the chosen
 * time, then sample the source photo's pixel for that Alt/Az (see KStars' own
 * terrainrenderer.cpp::getPixel, which this mirrors exactly, correction offsets included). */
function drawTerrainOverlay(
  ctx: CanvasRenderingContext2D,
  aladin: any,
  containerW: number,
  containerH: number,
  src: TerrainPixelData,
  info: ObservatoryInfo,
  dateMs: number,
  stats: ProjectionStats,
  cols: number,
) {
  const { data: srcData, width: imgW, height: imgH } = src;
  if (imgW === 0 || imgH === 0 || containerW === 0 || containerH === 0) return;

  const rows = Math.max(1, Math.round(cols * (containerH / containerW)));

  const offscreen = document.createElement('canvas');
  offscreen.width = cols;
  offscreen.height = rows;
  const octx = offscreen.getContext('2d');
  if (!octx) return;

  // Built as one plain typed-array (destData) and blitted in a single putImageData call, rather
  // than one drawImage() per sampled cell — with cols/rows in the thousands, per-call canvas
  // overhead dwarfed the actual per-pixel work (see TERRAIN_SAMPLE_COLS's comment).
  const destData = octx.createImageData(cols, rows);
  for (let j = 0; j < rows; j++) {
    const y = ((j + 0.5) / rows) * containerH;
    for (let i = 0; i < cols; i++) {
      const x = ((i + 0.5) / cols) * containerW;
      const world = safePix2World(aladin, x, y, stats);
      // Aladin returns null for a screen point outside the current projection's valid disk — but
      // right at that boundary (common when zoomed out far enough to see the whole sky at once)
      // it can instead return a "valid" array holding NaN, which !world doesn't catch and which
      // then poisons every downstream value (a single NaN array index is enough to read garbage
      // or throw — that's the reported "crashes on zoom out").
      if (!world || !Number.isFinite(world[0]) || !Number.isFinite(world[1])) continue;

      const { altDeg, azDeg } = raDecToAltAz(world[0], world[1], info.latitude, info.longitude, dateMs);
      const alt = altDeg - info.terrainCorrectAlt;
      if (alt < -90 || alt > 90) continue;

      let az = (((azDeg + info.terrainCorrectAz) % 360) + 360) % 360;
      if (az > 180) az -= 360;

      const pixX = Math.max(0, Math.min(imgW - 1, Math.round(imgW / 2 + (az / 360) * imgW)));
      const pixYFromBottom = Math.max(0, Math.min(imgH - 1, Math.round(((alt + 90) / 180) * imgH)));
      const pixY = (imgH - 1) - pixYFromBottom;
      if (!Number.isFinite(pixX) || !Number.isFinite(pixY)) continue;

      const srcIdx = (pixY * imgW + pixX) * 4;
      const destIdx = (j * cols + i) * 4;
      destData.data[destIdx] = srcData[srcIdx];
      destData.data[destIdx + 1] = srcData[srcIdx + 1];
      destData.data[destIdx + 2] = srcData[srcIdx + 2];
      destData.data[destIdx + 3] = srcData[srcIdx + 3];
    }
  }
  octx.putImageData(destData, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(offscreen, 0, 0, cols, rows, 0, 0, containerW, containerH);
}

/** Projects a closed loop of (RA, DEC) degree pairs to screen pixels via aladin.world2pix, one
 * per vertex — null wherever that vertex isn't currently projectable, exactly like the FOV
 * overlays' own computeScreenRect already handles per-corner. */
function projectLoop(
  aladin: any,
  points: [number, number][],
  stats?: ProjectionStats,
): ({ x: number; y: number } | null)[] {
  return points.map(([ra, dec]) => {
    const p = safeWorld2Pix(aladin, ra, dec, stats);
    return p ? { x: p[0], y: p[1] } : null;
  });
}

/** Strokes a closed loop of screen points, breaking into separate sub-paths wherever a vertex
 * didn't project (null) or the jump to it is implausibly large relative to the viewport (see
 * maxSegmentPx) — the loop only ever fully renders when the whole thing is in frame (e.g. zoomed
 * out to see the whole sky); otherwise whatever contiguous arc is currently visible still draws
 * correctly instead of the whole shape silently vanishing.
 *
 * Stroke-only: filling one of these sub-paths would implicitly close it with a straight line
 * straight from wherever the visible arc happens to end back to wherever it starts — for an arc
 * that's only a fraction of the true loop (the common case), that chord cuts across the screen at
 * whatever angle those two endpoints happen to define, which is exactly the "filled diagonally"
 * artifact an earlier version of this had. Regions are just outlined, not shaded, now anyway. */
function strokeHorizonLoop(
  ctx: CanvasRenderingContext2D,
  screenPoints: ({ x: number; y: number } | null)[],
  stroke: string,
  maxSegmentPx: number,
  lineWidth = 1.5,
) {
  const n = screenPoints.length;
  if (n < 2) return;

  const subpaths: { x: number; y: number }[][] = [];
  let current: { x: number; y: number }[] = [];
  let prev: { x: number; y: number } | null = null;
  // i <= n (not < n) revisits index 0 at the end, closing the loop when it stayed unbroken.
  for (let i = 0; i <= n; i++) {
    const pt = screenPoints[i % n];
    const jumpTooFar = !!(pt && prev && Math.hypot(pt.x - prev.x, pt.y - prev.y) > maxSegmentPx);
    if (!pt || jumpTooFar) {
      if (current.length > 1) subpaths.push(current);
      current = pt && jumpTooFar ? [pt] : [];
    } else {
      current.push(pt);
    }
    prev = pt;
  }
  if (current.length > 1) subpaths.push(current);

  for (const sub of subpaths) {
    ctx.beginPath();
    ctx.moveTo(sub[0].x, sub[0].y);
    for (let i = 1; i < sub.length; i++) ctx.lineTo(sub[i].x, sub[i].y);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
}

/** The four compass points, at the flat 0°-altitude horizon — reprojected in RA/Dec for the chosen
 * simulation time exactly like the horizon circle itself (see drawHorizonOverlay), since a
 * compass point's sky position drifts with sidereal time same as everything else drawn there. */
const CARDINAL_POINTS: { label: string; azDeg: number }[] = [
  { label: 'N', azDeg: 0 },
  { label: 'E', azDeg: 90 },
  { label: 'S', azDeg: 180 },
  { label: 'W', azDeg: 270 },
];

function drawCardinalPoints(
  ctx: CanvasRenderingContext2D,
  aladin: any,
  info: ObservatoryInfo,
  dateMs: number,
  stats?: ProjectionStats,
) {
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  CARDINAL_POINTS.forEach(({ label, azDeg }) => {
    const { raDeg, decDeg } = altAzToRaDec(0, azDeg, info.latitude, info.longitude, dateMs);
    const p = safeWorld2Pix(aladin, raDeg, decDeg, stats);
    if (!p) return;
    // A small dark backing square behind the letter — same reasoning as drawGearButton's own
    // translucent box — keeps it legible over a bright nebula/star field the plain orange text
    // alone would wash out against.
    ctx.fillStyle = 'rgba(15, 17, 26, 0.75)';
    ctx.fillRect(p[0] - 9, p[1] - 9, 18, 18);
    ctx.fillStyle = '#f97316';
    ctx.fillText(label, p[0], p[1]);
  });
}

/** Draws the flat geometric horizon (always available from lat/lon alone) plus any enabled
 * artificial-horizon regions, both reprojected in RA/Dec for the chosen simulation time. */
function drawHorizonOverlay(
  ctx: CanvasRenderingContext2D,
  aladin: any,
  info: ObservatoryInfo,
  regions: ArtificialHorizonRegion[],
  dateMs: number,
  containerW: number,
  containerH: number,
  stats?: ProjectionStats,
) {
  // A real jump between adjacent sample points never needs more than a fraction of the viewport
  // itself — anything longer means world2pix landed the far side of a wraparound rather than
  // somewhere actually adjacent on screen (see strokeHorizonLoop). A fixed pixel constant here
  // instead of scaling to the viewport used to make this check nearly unreachable (4000px, when
  // the canvas itself is only a few hundred px), which is exactly how the FOV-180° diagonal chord
  // (a `world2pix`-succeeds-but-lands-absurdly artifact, not a redraw failure) got through unbroken.
  const maxSegmentPx = Math.max(containerW, containerH) * 0.6;

  const flatPoints: [number, number][] = [];
  for (let az = 0; az < 360; az += 3) {
    const { raDeg, decDeg } = altAzToRaDec(0, az, info.latitude, info.longitude, dateMs);
    flatPoints.push([raDeg, decDeg]);
  }
  strokeHorizonLoop(ctx, projectLoop(aladin, flatPoints, stats), '#f97316', maxSegmentPx, 1.5);

  regions.forEach((region) => {
    const points: [number, number][] = region.points.map((p) => {
      const { raDeg, decDeg } = altAzToRaDec(p.alt, p.az, info.latitude, info.longitude, dateMs);
      return [raDeg, decDeg];
    });
    strokeHorizonLoop(ctx, projectLoop(aladin, points, stats), '#dc2626', maxSegmentPx, 1);
  });

  drawCardinalPoints(ctx, aladin, info, dateMs, stats);
}

/** One artificial-horizon region's own altitude boundary at a given azimuth, linearly interpolated
 * between whichever pair of its own points straddle that azimuth — null if this region doesn't
 * cover that azimuth at all (a region is typically an open profile over a limited az range, e.g. a
 * treeline silhouette, not a full 360° loop). */
function regionAltAtAzimuthDeg(region: ArtificialHorizonRegion, azDeg: number): number | null {
  const pts = region.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const a0 = pts[i].az;
    const a1 = pts[i + 1].az;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    if (hi <= lo || azDeg < lo || azDeg > hi) continue;
    const t = (azDeg - a0) / (a1 - a0);
    return pts[i].alt + t * (pts[i + 1].alt - pts[i].alt);
  }
  return null;
}

/** The real minimum altitude something needs to clear to count as visible at this azimuth: the
 * flat 0° geometric horizon, or higher still wherever an artificial-horizon region covers this
 * azimuth with a boundary above it — the most restrictive of any overlapping regions wins. */
function effectiveHorizonAltDeg(azDeg: number, regions: ArtificialHorizonRegion[]): number {
  let maxAlt = 0;
  for (const region of regions) {
    const alt = regionAltAtAzimuthDeg(region, azDeg);
    if (alt !== null && alt > maxAlt) maxAlt = alt;
  }
  return maxAlt;
}

const VISIBILITY_WINDOW_HOURS = 24;
const VISIBILITY_SAMPLE_MINUTES = 4;

interface VisibilitySample {
  ms: number;
  altDeg: number;
  horizonAltDeg: number;
}

/** Altitude and effective horizon (see effectiveHorizonAltDeg) for one sky point across a fixed
 * window centered on `centerMs` — the raw data both the altitude/time chart and
 * findVisibilityWindow are built from. 4-minute steps over 24h (360 samples) is fine enough to
 * place a rise/set time within a couple of minutes without resampling on every chart repaint. */
function sampleVisibility(
  raDeg: number, decDeg: number, latDeg: number, lonDeg: number, centerMs: number,
  regions: ArtificialHorizonRegion[],
): VisibilitySample[] {
  const halfSpanMs = (VISIBILITY_WINDOW_HOURS / 2) * 60 * 60_000;
  const stepMs = VISIBILITY_SAMPLE_MINUTES * 60_000;
  const samples: VisibilitySample[] = [];
  for (let t = centerMs - halfSpanMs; t <= centerMs + halfSpanMs; t += stepMs) {
    const { altDeg, azDeg } = raDecToAltAz(raDeg, decDeg, latDeg, lonDeg, t);
    samples.push({ ms: t, altDeg, horizonAltDeg: effectiveHorizonAltDeg(azDeg, regions) });
  }
  return samples;
}

type VisibilityWindow =
  | { kind: 'window'; riseMs: number; setMs: number; relation: 'current' | 'future' | 'past' }
  | { kind: 'always' }
  | { kind: 'never' }
  | { kind: 'unknown' };

/** The visibility window (see VisibilitySample) that matters right now: the one containing
 * `centerMs` if it's currently above the effective horizon, otherwise the nearest one — preferring
 * the next future window, falling back to the most recent past one only if nothing rises again
 * within the sampled range. `relation` distinguishes those three cases for the caller's own
 * wording ("visible now" vs. "next window" vs. "already set"). */
function findVisibilityWindow(samples: VisibilitySample[], centerMs: number): VisibilityWindow {
  if (samples.length === 0) return { kind: 'unknown' };
  const visible = samples.map((s) => s.altDeg > s.horizonAltDeg);
  if (visible.every(Boolean)) return { kind: 'always' };
  if (visible.every((v) => !v)) return { kind: 'never' };

  let centerIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (Math.abs(samples[i].ms - centerMs) < Math.abs(samples[centerIdx].ms - centerMs)) centerIdx = i;
  }

  function windowAround(idx: number): { riseMs: number; setMs: number } {
    let start = idx;
    while (start > 0 && visible[start - 1]) start--;
    let end = idx;
    while (end < visible.length - 1 && visible[end + 1]) end++;
    return { riseMs: samples[start].ms, setMs: samples[end].ms };
  }

  if (visible[centerIdx]) {
    return { kind: 'window', ...windowAround(centerIdx), relation: 'current' };
  }
  let idx = centerIdx;
  while (idx < visible.length && !visible[idx]) idx++;
  if (idx < visible.length) {
    return { kind: 'window', ...windowAround(idx), relation: 'future' };
  }
  idx = centerIdx;
  while (idx >= 0 && !visible[idx]) idx--;
  if (idx >= 0) {
    return { kind: 'window', ...windowAround(idx), relation: 'past' };
  }
  return { kind: 'unknown' };
}

/** "YYYY-MM-DDTHH:mm" in local time, the string format <input type="datetime-local"> both
 * displays and expects back — new Date(dateString) parses that same format as local time too, so
 * this round-trips through the input without any UTC conversion drift. */
function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function readStoredBoolean(key: string, defaultValue = false): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? defaultValue : raw === 'true';
  }
  catch {
    return defaultValue;
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  }
  catch {
    // storage unavailable (private browsing, quota, ...) — just don't persist
  }
}

function readStoredString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  }
  catch {
    return null;
  }
}

function writeStoredString(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  }
  catch {
    // storage unavailable (private browsing, quota, ...) — just don't persist
  }
}

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  }
  catch {
    return fallback;
  }
}

function readStoredManualLocation(): { latitude: number; longitude: number } | null {
  const raw = readStoredString(MANUAL_LOCATION_KEY);
  if (!raw) return null;
  const [latStr, lonStr] = raw.split(',');
  const latitude = Number(latStr);
  const longitude = Number(lonStr);
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

function writeStoredManualLocation(location: { latitude: number; longitude: number }) {
  writeStoredString(MANUAL_LOCATION_KEY, `${location.latitude},${location.longitude}`);
}

function writeStoredNumber(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  }
  catch {
    // storage unavailable (private browsing, quota, ...) — just don't persist
  }
}

interface StoredView {
  ra: number;
  dec: number;
  fovDeg: number;
}

function readStoredView(): StoredView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.ra === 'number' && typeof parsed.dec === 'number' && typeof parsed.fovDeg === 'number') {
      return parsed;
    }
    return null;
  }
  catch {
    return null;
  }
}

/** Called from the same positionChanged/zoomChanged listener that already drives the FOV-overlay
 * redraw — so panning/zooming the map (or "Follow mount" moving it) keeps this up to date without
 * a separate polling loop, and reloading the page resumes exactly where it was left instead of
 * always resetting to a fixed target. */
function saveCurrentView(aladin: any) {
  try {
    const [ra, dec] = aladin.getRaDec();
    const [fovDeg] = aladin.getFov();
    const view: StoredView = { ra, dec, fovDeg };
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
  }
  catch {
    // storage unavailable, or aladin not fully initialized yet — skip this save
  }
}

/** Builds the Aladin image-survey object for a survey list entry (see SkyMapDataSource.getSurveys).
 * Used both for the initial aladin()
 * call and for later switches, so the default survey never has to be swapped in after an initial
 * builtin one — that would otherwise briefly hit alasky/CDS for properties/MocServer/tiles before
 * being replaced. `A.imageHiPS` works without an aladin instance.
 * The custom URL is resolved to absolute: Aladin only recognizes it as a real HiPS location via
 * `new URL(...)`; a relative path fails that check and falls back to querying CDS's MocServer to
 * guess a matching public HiPS ID before it ever tries our proxy. */
function buildImageSurvey(survey: SurveyOption) {
  if (survey.custom) {
    const url = new URL(survey.custom.url, window.location.origin).href;
    return window.A.imageHiPS(url, {
      name: survey.label,
      cooFrame: survey.custom.frame,
      maxOrder: survey.custom.order,
      imgFormat: 'png',
    });
  }
  return survey.builtin;
}

/** "Open" = hasn't finished all its required captures yet — a live job that's already
 * JOB_COMPLETE is done, and JOB_INVALID means the scheduler itself rejected it (unreachable
 * constraints etc.), so neither is worth marking on the sky. A job freshly parsed from an .esl
 * file (see fetchScheduleFileJobs) has no run history and always comes back JOB_IDLE, which
 * passes this check same as it would for any live not-yet-finished job — there's no way (and no
 * need) to tell "not started" apart from "in progress" for a target marker. */
function isOpenSchedulerJob(job: SchedulerJob): boolean {
  const label = getJobStateLabel(job.state);
  return label !== 'JOB_COMPLETE' && label !== 'JOB_INVALID';
}

/** Small target/bullseye marker plus name label for each still-open scheduler job — same "dark
 * backing box behind the text" legibility trick as drawCardinalPoints/drawGearButton use. */
function drawOpenTargets(
  ctx: CanvasRenderingContext2D,
  aladin: any,
  targets: SchedulerJob[],
  stats?: ProjectionStats,
) {
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  targets.forEach((job) => {
    const p = safeWorld2Pix(aladin, job.targetRA * 15, job.targetDEC, stats);
    if (!p) return;
    const [x, y] = p;
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();

    const labelWidth = ctx.measureText(job.name).width;
    ctx.fillStyle = 'rgba(15, 17, 26, 0.75)';
    ctx.fillRect(x + 9, y - 8, labelWidth + 6, 16);
    ctx.fillStyle = '#4ade80';
    ctx.fillText(job.name, x + 12, y);
  });
}

export function SkyMapCard({
  dataSource, mountCoords, activeJob, jobs, ekosReady, fov, pa, lastImageFilename,
  supportsOpenTargets = true,
}: Props) {
  // Static for the component's lifetime (a deployment's palette list doesn't change at runtime),
  // so this is called once here rather than re-invoked at each of its few call sites below.
  const surveys = dataSource.getSurveys();
  const cardRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayImgRef = useRef<HTMLImageElement>(null);
  const aladinRef = useRef<any>(null);
  const mountCatalogRef = useRef<any>(null);
  const targetCatalogRef = useRef<any>(null);
  const fovOverlayRef = useRef<any>(null);
  const planningFovOverlayRef = useRef<any>(null);
  // The Planning FOV target's own diurnal path (its declination circle — every point sharing its
  // declination, at every RA) — see planningFovCenter's own comment for why this is a separate,
  // debounced overlay rather than being folded into planningFovOverlay above.
  const planningFovPathOverlayRef = useRef<any>(null);
  const ngcCatalogRef = useRef<any>(null);
  const sh2CatalogRef = useRef<any>(null);
  const ngcBoundaryRef = useRef<any>(null);
  const sh2BoundaryRef = useRef<any>(null);
  const constellationLinesOverlayRef = useRef<any>(null);
  const constellationBoundsOverlayRef = useRef<any>(null);
  // All AstroBin footprints share one canvas (see drawAstrobinFootprints) instead of one
  // absolutely-positioned DOM element each — a couple hundred images' worth of transform/size
  // recalculation on every pan/zoom frame was the actual performance cost, and canvas drawing
  // touches no layout at all.
  const astrobinCanvasRef = useRef<HTMLCanvasElement>(null);
  const astrobinImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  // WebGL layer for just the footprint *image* pixels — see drawFootprintImageWebGL's own comment
  // for why (Canvas2D mesh-seam artifact). Sits directly under astrobinCanvasRef in DOM order (see
  // the JSX below), which now only draws the mesh outline, hidden/dashed state, and gear button —
  // never the image itself when this is available. astrobinGlRef.current stays null if the
  // browser hands back no WebGL context at all; drawOneAstrobinFootprint falls back to the old
  // Canvas2D drawImageMesh in that case.
  const astrobinWebglCanvasRef = useRef<HTMLCanvasElement>(null);
  const astrobinGlRef = useRef<AstrobinGl | null>(null);
  const astrobinTexturesRef = useRef<Map<string, WebGLTexture>>(new Map());
  // Which footprint thumbnails are currently mid-fetch, keyed by thumbnailUrl (see
  // getAstrobinImage's own comment for why not hash) — a Set rather than a plain counter so a
  // stray duplicate start/settle call can't drift it out of sync. Non-empty means
  // drawOneAstrobinFootprint holds off on drawing *any* thumbnail this redraw (see canShowImages),
  // so a batch of newly-visible footprints reveals together once they're all ready instead of
  // popping in one at a time as each fetch happens to finish.
  const pendingAstrobinKeysRef = useRef<Set<string>>(new Set());
  const [pendingAstrobinCount, setPendingAstrobinCount] = useState(0);
  // Flips true (forever) the first time the pending set empties out — see canShowAstrobinImages
  // at the redraw call site below for why the "wait for the whole batch" gate only applies once.
  const hasRevealedAstrobinImagesRef = useRef(false);
  // Recomputed every redraw() call — consumed by the click handler below for hit testing, since a
  // canvas has no DOM nodes of its own to hang a click listener off.
  const astrobinHitRectsRef = useRef<AstrobinHitRect[]>([]);
  const astrobinFetchedRef = useRef(false);
  const appliedSurveyIdRef = useRef<string | null>(null);

  // Program + static buffers only need creating once — the index/texcoord buffers depend on
  // ASTROBIN_MESH_GRID_SIZE alone, never on any footprint's own data, unlike the position buffer
  // (rebuilt per footprint per redraw, see drawFootprintImageWebGL). Runs once on mount, same as
  // the Aladin-init effect above; astrobinGlRef staying null (no `webgl` object ever gets built)
  // is exactly how drawOneAstrobinFootprint's Canvas2D fallback gets exercised on a browser/GPU
  // that can't give us a WebGL context at all.
  useEffect(() => {
    const canvas = astrobinWebglCanvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl');
    if (!gl) return;
    const program = createAstrobinProgram(gl);
    const indexBuffer = gl.createBuffer()!;
    const texCoordBuffer = gl.createBuffer()!;
    const positionBuffer = gl.createBuffer()!;

    const indices = buildAstrobinMeshIndices(ASTROBIN_MESH_GRID_SIZE);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

    const texCoords = buildAstrobinMeshTexCoords(ASTROBIN_MESH_GRID_SIZE);
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

    // blendFuncSeparate, not blendFunc: with a single SRC_ALPHA/ONE_MINUS_SRC_ALPHA pair applied to
    // *both* color and alpha, drawing onto this canvas's own cleared-to-(0,0,0,0) backing buffer
    // leaves the stored alpha at uOpacity² (0.8*0.8=0.64), not uOpacity — the alpha channel gets
    // the same SRC_ALPHA weighting as color, so it's blended against a starting alpha of 0 instead
    // of just accumulated. Since this canvas's context defaults to premultipliedAlpha:true, the
    // browser then composites that too-low alpha straight onto the page, making every footprint
    // visibly dimmer than the requested opacity (confirmed live — this is what made footprint
    // opacity look like it had regressed after the WebGL rewrite, not any change to the 0.8/1
    // values themselves, which were never touched). Blending alpha via ONE/ONE_MINUS_SRC_ALPHA
    // instead (straight "over" accumulation) gives the correct result: alpha = uOpacity + 0*(1 -
    // uOpacity) = uOpacity.
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    astrobinGlRef.current = {
      gl, program, indexBuffer, texCoordBuffer, positionBuffer,
      indexCount: indices.length, textures: astrobinTexturesRef.current,
    };
  }, []);
  // The flat geometric horizon + any enabled artificial-horizon regions — plain canvas drawing
  // (drawHorizonOverlay), not Aladin's own A.polygon/graphicOverlay: Aladin's polygon renderer
  // crashes outright (TypeError reading 'x' of undefined) the moment any one vertex fails to
  // project onto the current view, which a 360°-sweep horizon loop does constantly unless the
  // whole sky happens to be in frame. world2pix() itself degrades gracefully (returns null); it's
  // only Aladin's *own* draw() that doesn't guard for that, so bypassing it avoids the crash.
  const horizonCanvasRef = useRef<HTMLCanvasElement>(null);
  // The Terrain panorama re-projection (drawTerrainOverlay) is plain canvas drawing, like the
  // AstroBin footprints, but on its own canvas layered underneath them (see index.css) rather than
  // sharing one — the two are cleared/redrawn independently and there's no reason to interleave
  // their draw calls.
  const terrainCanvasRef = useRef<HTMLCanvasElement>(null);
  const terrainImgRef = useRef<HTMLImageElement | null>(null);
  const terrainPixelDataRef = useRef<TerrainPixelData | null>(null);
  const terrainDebounceRef = useRef<number | undefined>(undefined);
  // A ref, not a `let` inside the redraw effect: that effect's own dependency list includes things
  // like mountCoords.ra/dec, which change every couple hundred ms while the mount is tracking —
  // each of those re-runs the whole effect (a fresh closure), which would reset an effect-scoped
  // `let` back to null constantly and defeat the gate below it guards. A ref survives that.
  const lastTerrainViewKeyRef = useRef<string | null>(null);
  const horizonRetryRef = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  // Persisted across reloads (see SURVEY_KEY) — falls back to surveys[0] if there's nothing
  // stored yet, or if what's stored no longer matches any of *this* deployment's own survey list
  // (e.g. the live dashboard and the public site don't offer the same palettes, and a stale id
  // from a previous survey list shouldn't silently resolve to whatever happens to sit at surveys[0]
  // without at least being a deliberate fallback rather than a coincidence).
  const [surveyId, setSurveyId] = useState(() => {
    const stored = readStoredString(SURVEY_KEY);
    return stored && surveys.some((s) => s.id === stored) ? stored : surveys[0].id;
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  // Persisted across reloads (see FOLLOW_MOUNT_KEY/SHOW_LAST_IMAGE_KEY) — both are "set once,
  // forget about it" toggles, so a reload silently reverting them is more surprising than useful.
  const [showLastImage, setShowLastImage] = useState(() => readStoredBoolean(SHOW_LAST_IMAGE_KEY));
  const [followMount, setFollowMount] = useState(() => readStoredBoolean(FOLLOW_MOUNT_KEY));
  const [zenithLock, setZenithLock] = useState(() => readStoredBoolean(ZENITH_LOCK_KEY));
  const zenithLockRef = useRef(zenithLock);
  zenithLockRef.current = zenithLock;
  const observatoryInfoRef = useRef<ObservatoryInfo | null>(null);
  const horizonTimeRef = useRef(Date.now());
  const [showNgc, setShowNgc] = useState(() => readStoredBoolean(SHOW_NGC_KEY));
  const [showSh2, setShowSh2] = useState(() => readStoredBoolean(SHOW_SH2_KEY));
  const [showGrid, setShowGrid] = useState(() => readStoredBoolean(SHOW_GRID_KEY));
  const [showConstellationLines, setShowConstellationLines] = useState(
    () => readStoredBoolean(SHOW_CONSTELLATION_LINES_KEY),
  );
  const [showConstellationBounds, setShowConstellationBounds] = useState(
    () => readStoredBoolean(SHOW_CONSTELLATION_BOUNDS_KEY),
  );
  const [showOpenTargets, setShowOpenTargets] = useState(() => readStoredBoolean(SHOW_OPEN_TARGETS_KEY));
  // Only populated when the toggle is on AND Ekos isn't up (see openTargetJobs below) — while
  // Ekos IS up, the live `jobs` prop is used directly and this stays null.
  const [diskJobs, setDiskJobs] = useState<SchedulerJob[] | null>(null);
  const targetsCanvasRef = useRef<HTMLCanvasElement>(null);
  const [showAstrobin, setShowAstrobin] = useState(() => readStoredBoolean(SHOW_ASTROBIN_KEY, true));
  const [astrobinFootprints, setAstrobinFootprints] = useState<AstrobinFootprint[] | null>(null);
  // Horizon simulation: the flat 0°-altitude circle plus (if defined) the user's own artificial
  // horizon regions and Terrain panorama, all reprojected for whatever moment horizonTime is —
  // "now" by default (planning ahead needs a moment other than the current one). Not itself
  // persisted (a stale simulated time from a past session is more confusing to reload into than
  // starting fresh at "now" every time), unlike the showHorizon/showTerrain toggles.
  const [showHorizon, setShowHorizon] = useState(() => readStoredBoolean(SHOW_HORIZON_KEY));
  const [showTerrain, setShowTerrain] = useState(() => readStoredBoolean(SHOW_TERRAIN_KEY));
  const [horizonTime, setHorizonTime] = useState(() => Date.now());
  const [horizonStepIndex, setHorizonStepIndex] = useState(() => {
    const stored = readStoredNumber(HORIZON_STEP_INDEX_KEY, 2);
    return stored >= 0 && stored < HORIZON_STEPS.length ? stored : 2;
  });
  const [observatoryInfo, setObservatoryInfo] = useState<ObservatoryInfo | null>(null);
  // A visitor-supplied fallback (typed in, or read from navigator.geolocation) for deployments
  // whose dataSource has no real location to give (see the "Set your location" prompt below) —
  // this is about the *visitor's* browser, not the account being viewed, so it isn't reset per
  // dataSource/username the way observatoryInfo itself is; it starts from whatever was last saved.
  const [manualLocation, setManualLocation] = useState<{ latitude: number; longitude: number } | null>(
    () => readStoredManualLocation(),
  );
  const effectiveObservatoryInfo = useMemo<ObservatoryInfo | null>(() => {
    if (!observatoryInfo) return null;
    if (isValidLocation(observatoryInfo) || !manualLocation) return observatoryInfo;
    return { ...observatoryInfo, latitude: manualLocation.latitude, longitude: manualLocation.longitude };
  }, [observatoryInfo, manualLocation]);
  // Kept live for the poll-loop effect below (whose closure only runs once, deps [ready]) to read
  // without needing to be in that effect's own dependency array.
  horizonTimeRef.current = horizonTime;
  observatoryInfoRef.current = effectiveObservatoryInfo;
  const [artificialHorizon, setArtificialHorizon] = useState<ArtificialHorizonRegion[]>([]);
  const [terrainImageLoaded, setTerrainImageLoaded] = useState(false);
  const observatoryFetchedRef = useRef(false);
  // Wide-field shots otherwise sit permanently on top of any narrower-focal-length footprint of
  // the same area, since they're bigger and later in z-order — "hidden" collapses one down to
  // just its outline (plus a small reveal button) so whatever's underneath becomes clickable.
  // Not persisted: it's a per-session decluttering aid, not a setting worth remembering forever.
  const [hiddenAstrobinUrls, setHiddenAstrobinUrls] = useState<Set<string>>(new Set());
  // The footprint whose popover is currently open doubles as "selected" — see drawAstrobinFootprints
  // — so it's the only one z-ordering ever raises above the rest, replacing the old ephemeral hover
  // highlight with something that stays put until you actually close the popover. Position isn't
  // tracked here — see astrobinPopoverRef below — since it has to keep tracking the footprint's own
  // on-screen corner across pans/zooms, not just wherever it was when first opened.
  const [astrobinPopover, setAstrobinPopover] = useState<{
    footprint: AstrobinFootprint; date: string | null; loading: boolean; error: boolean;
  } | null>(null);
  const astrobinPopoverRef = useRef<HTMLDivElement>(null);
  // Aladin's own panning is a plain mousedown/mousemove/mouseup drag, not native HTML5 drag — the
  // browser still fires a normal 'click' on mouseup regardless of how far the mouse moved in
  // between, so a background drag-to-pan can't be told apart from a real click by event type
  // alone. Tracked at mousedown regardless of target (a drag can end outside the sky map entirely)
  // and compared against click position in both handleAstrobinClick and the outside-click effect.
  const astrobinMouseDownRef = useRef<{ x: number; y: number } | null>(null);
  const [lastImageStretch, setLastImageStretch] = useState<StretchSettings>(DEFAULT_STRETCH);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // A user-set, equipment-independent FOV rectangle for planning framing — always centered on
  // whatever the map is currently looking at (see fovCorners' caller in redraw()), unlike the
  // live FOV rectangle above which tracks the mount and only exists once it's actually slewed
  // somewhere. Lets you pan around and preview "would this target fit?" before committing to it.
  const [planningFovEnabled, setPlanningFovEnabled] = useState(() => readStoredBoolean(PLANNING_FOV_ENABLED_KEY));
  // Width/height in arcmin are derived (see sensorFovArcmin below) from these four equipment
  // factors instead of being entered directly — matches how you'd actually plan a shot ("what
  // does my camera+scope combo see"), and updates immediately if you're comparing focal lengths.
  const [sensorWidthPx, setSensorWidthPx] = useState(() => readStoredNumber(PLANNING_FOV_SENSOR_WIDTH_KEY, DEFAULT_SENSOR_WIDTH_PX));
  const [sensorHeightPx, setSensorHeightPx] = useState(() => readStoredNumber(PLANNING_FOV_SENSOR_HEIGHT_KEY, DEFAULT_SENSOR_HEIGHT_PX));
  const [pixelSizeUm, setPixelSizeUm] = useState(() => readStoredNumber(PLANNING_FOV_PIXEL_SIZE_KEY, DEFAULT_PIXEL_SIZE_UM));
  const [focalLengthMm, setFocalLengthMm] = useState(() => readStoredNumber(PLANNING_FOV_FOCAL_LENGTH_KEY, DEFAULT_FOCAL_LENGTH_MM));
  const [planningFovRotationDeg, setPlanningFovRotationDeg] = useState(() => readStoredNumber(PLANNING_FOV_ROTATION_KEY, 0));
  // The Planning FOV's own view center (ra/dec), for the path overlay and the visibility chart —
  // deliberately its own, debounced state rather than reading aladin.getRaDec() directly from
  // those effects: the FOV rectangle itself is cheap to redraw every frame during a pan/zoom (see
  // redraw() below), but the path overlay (a ~120-point polygon) and the visibility chart (360
  // altitude samples across 24h) are not, so both only recompute once the view has settled.
  const [planningFovCenter, setPlanningFovCenter] = useState<{ ra: number; dec: number } | null>(null);
  const planningFovCenterDebounceRef = useRef<number | undefined>(undefined);
  // Not persisted — like hiddenAstrobinUrls, this is a per-session pin on a specific spot rather
  // than a durable preference, and a stale locked target reappearing on a future, unrelated
  // session would be more confusing than useful.
  const [planningFovLocked, setPlanningFovLocked] = useState(false);
  const planningFovLockedCenterRef = useRef<{ ra: number; dec: number } | null>(null);
  const [sensorConfigOpen, setSensorConfigOpen] = useState(false);
  const sensorConfigRef = useRef<HTMLDivElement>(null);
  const [locationPopoverOpen, setLocationPopoverOpen] = useState(false);
  const locationPopoverRef = useRef<HTMLDivElement>(null);
  const [manualLatDraft, setManualLatDraft] = useState(() => manualLocation?.latitude ?? 0);
  const [manualLonDraft, setManualLonDraft] = useState(() => manualLocation?.longitude ?? 0);
  const [geolocating, setGeolocating] = useState(false);
  const [geolocationError, setGeolocationError] = useState<string | null>(null);

  function applyManualLocation(latitude: number, longitude: number) {
    const location = { latitude, longitude };
    setManualLocation(location);
    writeStoredManualLocation(location);
    setGeolocationError(null);
  }

  function useBrowserGeolocation() {
    if (!navigator.geolocation) {
      setGeolocationError("Your browser doesn't support geolocation");
      return;
    }
    setGeolocating(true);
    setGeolocationError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeolocating(false);
        setManualLatDraft(pos.coords.latitude);
        setManualLonDraft(pos.coords.longitude);
        applyManualLocation(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        setGeolocating(false);
        setGeolocationError(err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'Could not determine your location');
      },
      { timeout: 10000 },
    );
  }
  const planningFovWidthArcmin = sensorFovArcmin(sensorWidthPx, pixelSizeUm, focalLengthMm);
  const planningFovHeightArcmin = sensorFovArcmin(sensorHeightPx, pixelSizeUm, focalLengthMm);
  // Recomputed only when the (already debounced) target center, the simulated time, or the
  // location/artificial-horizon data actually change — 360 altitude samples is cheap once, not
  // something worth redoing on every unrelated re-render.
  const planningFovVisibility = useMemo(() => {
    if (!planningFovEnabled || !planningFovCenter || !effectiveObservatoryInfo || !isValidLocation(effectiveObservatoryInfo)) {
      return null;
    }
    const samples = sampleVisibility(
      planningFovCenter.ra, planningFovCenter.dec,
      effectiveObservatoryInfo.latitude, effectiveObservatoryInfo.longitude, horizonTime, artificialHorizon,
    );
    return { samples, window: findVisibilityWindow(samples, horizonTime) };
  }, [planningFovEnabled, planningFovCenter, effectiveObservatoryInfo, artificialHorizon, horizonTime]);
  // On-demand (not re-queried on every pan/zoom, unlike the FOV rectangles) — a SIMBAD conesearch
  // is a real network round-trip, and "what's in this exact framing" is naturally a "I've settled
  // on a spot, now check it" action rather than something to hammer continuously while dragging.
  const [fovObjects, setFovObjects] = useState<SimbadFovObject[] | null>(null);
  const [fovObjectsLoading, setFovObjectsLoading] = useState(false);
  const [fovObjectsError, setFovObjectsError] = useState(false);
  const [fovResultsOpen, setFovResultsOpen] = useState(false);
  const fovResultsRef = useRef<HTMLDivElement>(null);

  // Same click-outside/Escape convention as the sensor-settings popup above.
  useEffect(() => {
    if (!fovResultsOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (fovResultsRef.current && !fovResultsRef.current.contains(e.target as Node)) {
        setFovResultsOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setFovResultsOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [fovResultsOpen]);

  function searchFovObjects() {
    const aladin = aladinRef.current;
    if (!aladin) return;
    setFovResultsOpen(true);
    setFovObjectsLoading(true);
    setFovObjectsError(false);
    setFovObjects(null);
    const [centerRa, centerDec] = aladin.getRaDec();
    const widthDeg = planningFovWidthArcmin / 60;
    const heightDeg = planningFovHeightArcmin / 60;
    const radiusDeg = Math.hypot(widthDeg, heightDeg) / 2;
    window.A.catalogFromSimbad(
      { ra: centerRa, dec: centerDec },
      radiusDeg,
      { limit: 500 },
      (cat: any) => {
        setFovObjects(findFovObjects(cat.getSources(), centerRa, centerDec, widthDeg, heightDeg, planningFovRotationDeg));
        setFovObjectsLoading(false);
      },
      () => {
        setFovObjectsError(true);
        setFovObjectsLoading(false);
      },
    );
  }

  function goToFovObject(obj: SimbadFovObject) {
    aladinRef.current?.gotoRaDec(obj.ra, obj.dec);
  }

  // Opens the tab synchronously (within the click's own call stack) and points it once the URL
  // is ready — CompressionStream is async, and popup blockers kill window.open() calls made after
  // an await since they no longer look like a direct response to the user's gesture.
  function openAstrobinCoordsSearch(obj: SimbadFovObject) {
    const win = window.open('', '_blank');
    const radiusDeg = Math.max(0.25, Number.isFinite(obj.sizeArcmin) ? obj.sizeArcmin / 60 / 2 : 0.25);
    astrobinCoordsSearchUrl(obj.ra, obj.dec, radiusDeg).then((url) => {
      if (win) win.location.href = url;
    });
  }

  // Closes on an outside click or Escape — there's no existing popover convention elsewhere in
  // this app to match, so this is the plain/standard version of that pattern.
  useEffect(() => {
    if (!sensorConfigOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (sensorConfigRef.current && !sensorConfigRef.current.contains(e.target as Node)) {
        setSensorConfigOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSensorConfigOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [sensorConfigOpen]);

  // Same outside-click/Escape pattern, for the "Set your location" popover below.
  useEffect(() => {
    if (!locationPopoverOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (locationPopoverRef.current && !locationPopoverRef.current.contains(e.target as Node)) {
        setLocationPopoverOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setLocationPopoverOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [locationPopoverOpen]);

  // Same outside-click/Escape pattern as sensorConfigOpen above, for the survey/palette picker's
  // own popup (see its own button below — replaces what used to be a plain <select>).
  useEffect(() => {
    if (!paletteOpen) return undefined;
    function onPointerDown(e: PointerEvent) {
      if (paletteRef.current && !paletteRef.current.contains(e.target as Node)) {
        setPaletteOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setPaletteOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [paletteOpen]);

  // Recorded on every mousedown regardless of target — a pan can start inside the sky map and end
  // outside it (or vice versa) — so both listeners below can tell a background drag-to-pan apart
  // from an actual click, which a plain 'click' listener can't do on its own (see
  // astrobinMouseDownRef). Registered on the CAPTURE phase specifically: Aladin's own mousedown
  // handler on its canvas calls stopPropagation() during the bubble phase (confirmed — a bubble-
  // phase document listener never sees it at all), which capture doesn't run into since it fires
  // top-down before the event ever reaches that handler.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      astrobinMouseDownRef.current = { x: e.clientX, y: e.clientY };
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, []);

  // Closes only on a click OUTSIDE the whole sky map (not just outside the popover panel) —
  // clicks inside it, whether on a footprint, blank sky, or the popover's own buttons, are fully
  // handled by handleAstrobinClick below; splitting it this way (rather than one pointerdown
  // listener covering everything, like the sensor-settings popup above) avoids a same-click race
  // where clicking a second footprint to switch selection would immediately undo itself. Also
  // ignores drags (see astrobinMouseDownRef) so panning the map — which can end past the sky
  // map's own edge — doesn't deselect whatever's still tracking its footprint's corner (see
  // redraw()'s positioning block).
  useEffect(() => {
    if (!astrobinPopover) return undefined;
    function onClick(e: MouseEvent) {
      const down = astrobinMouseDownRef.current;
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > ASTROBIN_DRAG_CLICK_THRESHOLD_PX) return;
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setAstrobinPopover(null);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setAstrobinPopover(null);
    }
    document.addEventListener('click', onClick);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [astrobinPopover]);

  function openAstrobinPopover(f: AstrobinFootprint) {
    setAstrobinPopover({ footprint: f, date: null, loading: true, error: false });
    dataSource.getAstrobinImageDetail(f.hash)
      .then((detail) => {
        setAstrobinPopover((prev) => (prev?.footprint.url === f.url ? { ...prev, date: detail.date, loading: false } : prev));
      })
      .catch(() => {
        setAstrobinPopover((prev) => (prev?.footprint.url === f.url ? { ...prev, loading: false, error: true } : prev));
      });
  }

  function toggleAstrobinHidden(url: string) {
    setHiddenAstrobinUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  // The canvas itself is pointer-events:none (see .sky-map-astrobin-canvas — Aladin's own
  // dragging/zooming needs the mouse events underneath it), so clicks are handled here on the
  // container instead, via bubbling, and resolved against astrobinHitRectsRef by hand.
  function handleAstrobinClick(e: React.MouseEvent) {
    // Clicks on the popover's own buttons/links bubble here too (it's a child of this same
    // container) — let them handle themselves rather than reinterpreting as a deselect-on-miss.
    if (astrobinPopoverRef.current?.contains(e.target as Node)) return;
    // A background drag to pan the map still fires a 'click' on mouseup (Aladin's panning is a
    // plain mousedown/move/up drag, not native HTML5 drag, so the browser doesn't suppress it) —
    // ignore it rather than reinterpreting wherever the drag happened to end as a select/deselect.
    const down = astrobinMouseDownRef.current;
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > ASTROBIN_DRAG_CLICK_THRESHOLD_PX) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const hit = hitTestAstrobinFootprint(e.clientX - rect.left, e.clientY - rect.top, astrobinHitRectsRef.current);
    // A hit switches (or opens) the selection outright; a miss on blank sky deselects whatever
    // was selected — both resolved by a single authoritative call here rather than racing with
    // the outside-the-whole-map listener above, which only ever fires for clicks that don't reach
    // this handler at all.
    if (hit) openAstrobinPopover(hit.footprint);
    else setAstrobinPopover(null);
  }

  useEffect(() => {
    if (!window.A || !containerRef.current) return;
    window.A.init.then(() => {
      // React Strict Mode (dev only) invokes this effect twice on the same mount without an
      // intervening real unmount — aladinRef survives that (refs, unlike state, aren't reset
      // between the two invocations), so this guard is what actually stops a second real Aladin
      // instance from being constructed in the same container. Without it, both instances' custom
      // HiPS surveys end up manipulating the same underlying wasm-bindgen objects concurrently,
      // which throws ("recursive use of an object detected") instead of just wasting work.
      if (aladinRef.current) return;
      const defaultSurvey = surveys[0];
      const savedView = readStoredView();
      const aladin = window.A.aladin(containerRef.current, {
        survey: buildImageSurvey(defaultSurvey),
        fov: savedView?.fovDeg ?? DEFAULT_FOV_DEG,
        target: savedView ? `${savedView.ra} ${savedView.dec}` : DEFAULT_TARGET,
        cooFrame: 'equatorial',
        projection: readStoredString(PROJECTION_KEY) ?? 'SIN',
        showFullscreenControl: false,
        log: false,
      });
      aladinRef.current = aladin;
      appliedSurveyIdRef.current = defaultSurvey.id;
      // Aladin's own corner button changes the projection (SIN/ZEA/AIT/...) — persist whatever the
      // user picks there the same way the view itself is persisted, so a reload doesn't silently
      // reset back to SIN.
      aladin.on('projectionChanged', (name: string) => writeStoredString(PROJECTION_KEY, name));

      // Ties every overlay this component draws (FOV rectangle, AstroBin footprints, terrain,
      // open-target markers, the popover's position) to the *exact* same render tick Aladin uses
      // for its own tiles — its View class (reached via the undocumented aladin.view, so this could
      // break on an Aladin upgrade) runs its own perpetual requestAnimationFrame loop that calls
      // drawAllOverlays() whenever `wasm.isRendering() || needRedraw` is true, right before
      // scheduling its own next frame. Without this, the poll loop below only noticed a changed
      // fov/ra/dec up to one animation frame after Aladin had already redrawn its own tiles at the
      // new position — visible as our overlays (astrobin footprints especially) briefly lagging a
      // live drag or zoom by a frame. Validated first in SkyMapCard3D.tsx's WebGL PoC (same
      // technique, much simpler component) before backporting here.
      const view = aladin.view;
      if (view && typeof view.drawAllOverlays === 'function') {
        const originalDrawAllOverlays = view.drawAllOverlays.bind(view);
        view.drawAllOverlays = (...args: unknown[]) => {
          originalDrawAllOverlays(...args);
          try {
            redrawRef.current();
          } catch {
            // Ignored — same transient post-zoom WebGL state the poll loop below guards against
            // (see its own comment); Aladin calls this again next frame regardless of what this
            // wrapper does, so a bad frame here costs at most one skipped redraw, never wedges
            // anything.
          }
        };
      }

      const mountCat = window.A.catalog({ name: 'mount', sourceSize: 20, color: '#4ade80' });
      const targetCat = window.A.catalog({ name: 'target', sourceSize: 20, color: '#f59e0b' });
      aladin.addCatalog(mountCat);
      aladin.addCatalog(targetCat);
      mountCatalogRef.current = mountCat;
      targetCatalogRef.current = targetCat;

      const fovOverlay = window.A.graphicOverlay({ name: 'Mount FOV', color: '#38bdf8', lineWidth: 2 });
      aladin.addOverlay(fovOverlay);
      fovOverlayRef.current = fovOverlay;

      // Dashed + a different hue than the live FOV overlay, so "planned framing" is never
      // mistaken for "where the camera is actually pointed right now".
      const planningFovOverlay = window.A.graphicOverlay({ name: 'Planning FOV', color: '#c084fc', lineWidth: 2, lineDash: [8, 6] });
      aladin.addOverlay(planningFovOverlay);
      planningFovOverlayRef.current = planningFovOverlay;

      // Thin/undashed so it doesn't compete visually with the FOV rectangle itself — see
      // planningFovCenter's own comment for why this is updated separately (debounced).
      const planningFovPathOverlay = window.A.graphicOverlay({ name: 'Planning FOV path', color: '#c084fc', lineWidth: 1 });
      aladin.addOverlay(planningFovPathOverlay);
      planningFovPathOverlayRef.current = planningFovPathOverlay;

      setReady(true);
    });
  }, []);

  useEffect(() => {
    if (!ready || !aladinRef.current || appliedSurveyIdRef.current === surveyId) return;
    appliedSurveyIdRef.current = surveyId;
    const survey = surveys.find((s) => s.id === surveyId) ?? surveys[0];
    aladinRef.current.setImageSurvey(buildImageSurvey(survey));
  }, [ready, surveyId]);

  useEffect(() => {
    writeStoredString(SURVEY_KEY, surveyId);
  }, [surveyId]);

  useEffect(() => {
    if (!ready || !mountCatalogRef.current) return;
    mountCatalogRef.current.removeAll();
    if (mountCoords) {
      const raDeg = mountCoords.ra * 15;
      mountCatalogRef.current.addSources([
        window.A.marker(raDeg, mountCoords.dec, {
          popupTitle: 'Mount',
          popupDesc: `RA ${mountCoords.ra.toFixed(3)}h DEC ${mountCoords.dec.toFixed(3)}°`,
        }),
      ]);
    }
  }, [ready, mountCoords?.ra, mountCoords?.dec]);

  useEffect(() => {
    if (!ready || !targetCatalogRef.current) return;
    targetCatalogRef.current.removeAll();
    if (activeJob) {
      const raDeg = activeJob.targetRA * 15;
      targetCatalogRef.current.addSources([
        window.A.marker(raDeg, activeJob.targetDEC, { popupTitle: activeJob.name, popupDesc: 'Scheduler target' }),
      ]);
    }
  }, [ready, activeJob?.name, activeJob?.targetRA, activeJob?.targetDEC]);

  // The FOV rectangle (sky-registered polygon) and the last-image screen overlay (plain CSS,
  // since Aladin's image layers need real WCS — our capture previews have none) share the same
  // corner math, recomputed whenever the mount moves, the FOV changes, or the view pans/zooms.
  // redrawRef always holds the latest closure over current props; the effect below that actually
  // registers Aladin's positionChanged/zoomChanged listeners only depends on `ready`, so it runs
  // exactly once per mount instead of re-adding a listener pair on every mountCoords/fov update
  // (roughly once a second while Ekos runs). Aladin Lite v3 has no .on() counterpart to remove a
  // listener, so re-registering on every update used to leak one more pair forever — over a
  // multi-hour session that accumulated thousands of stale callbacks on the same long-lived Aladin
  // instance, and the next positionChanged/zoomChanged (e.g. one last mount update as Ekos stops)
  // fired all of them synchronously, which was enough to freeze the tab or lose the WebGL context.
  // Only needed for the Ekos-off path (see openTargetJobs below) — refetched every time the
  // toggle turns on rather than cached like the AstroBin/NGC/Sh2 "fetch once" lazy loads
  // elsewhere: unlike those, the .esl file on disk can change between one enable and the next
  // (someone edited the schedule in KStars while the toggle happened to be off), so a stale disk
  // snapshot sitting around would be actively misleading here in a way a stale NGC catalog never is.
  useEffect(() => {
    if (!showOpenTargets || ekosReady) {
      setDiskJobs(null);
      return;
    }
    dataSource.getScheduleFileJobs().then(setDiskJobs).catch(() => setDiskJobs([]));
  }, [showOpenTargets, ekosReady]);

  // Live Ekos: use its own jobs list, filtered to what isn't finished yet. Ekos off: the jobs
  // list parsed straight off the configured .esl file (see fetchScheduleFileJobs) — every job in
  // there is "open" by construction, since a freshly-parsed file has no run history at all.
  const openTargetJobs = useMemo(() => {
    if (!showOpenTargets) return [];
    if (ekosReady) return (jobs ?? []).filter(isOpenSchedulerJob);
    return diskJobs ?? [];
  }, [showOpenTargets, ekosReady, jobs, diskJobs]);

  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    redrawRef.current = function redraw() {
      const aladin = aladinRef.current;
      const overlay = fovOverlayRef.current;
      if (!aladin || !overlay) return;

      const planningOverlay = planningFovOverlayRef.current;
      if (planningOverlay) {
        planningOverlay.removeAll();
        if (planningFovEnabled) {
          // Locked: stays wherever it was pinned (see togglePlanningFovLock) instead of following
          // the view — panning/zooming around a locked framing to check what's nearby no longer
          // drags the framing itself along.
          let centerRa: number;
          let centerDec: number;
          if (planningFovLockedCenterRef.current) {
            ({ ra: centerRa, dec: centerDec } = planningFovLockedCenterRef.current);
          } else {
            [centerRa, centerDec] = aladin.getRaDec();
            window.clearTimeout(planningFovCenterDebounceRef.current);
            planningFovCenterDebounceRef.current = window.setTimeout(() => {
              setPlanningFovCenter({ ra: centerRa, dec: centerDec });
            }, 200);
          }
          const corners = fovCorners(
            centerRa,
            centerDec,
            planningFovWidthArcmin / 60,
            planningFovHeightArcmin / 60,
            planningFovRotationDeg,
          );
          planningOverlay.add(window.A.polygon(corners));
        }
      }

      const container = containerRef.current;
      const horizonCanvas = horizonCanvasRef.current;
      if (horizonCanvas && container) {
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(container.clientWidth * dpr);
        const targetH = Math.round(container.clientHeight * dpr);
        if (horizonCanvas.width !== targetW || horizonCanvas.height !== targetH) {
          horizonCanvas.width = targetW;
          horizonCanvas.height = targetH;
          horizonCanvas.style.width = `${container.clientWidth}px`;
          horizonCanvas.style.height = `${container.clientHeight}px`;
        }
        const hctx = horizonCanvas.getContext('2d');
        if (hctx) {
          hctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          window.clearTimeout(horizonRetryRef.current);
          if (showHorizon && effectiveObservatoryInfo && isValidLocation(effectiveObservatoryInfo)) {
            const info = effectiveObservatoryInfo;
            // Same transient-WebGL-exception hazard as the terrain overlay (see its own retry
            // comment above) can leave world2pix returning null for most/all of this loop's points
            // right after a zoom/pan brings fresh HiPS tiles in — without a retry, that one bad
            // frame's (near-)empty result just sits there until some unrelated redraw (e.g. a pan)
            // happens to land outside the bad window, which reads as "the horizon froze on zoom".
            const attempt = (retriesLeft: number) => {
              const stats: ProjectionStats = { exceptions: 0 };
              hctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
              drawHorizonOverlay(
                hctx, aladin, info, artificialHorizon, horizonTime,
                container.clientWidth, container.clientHeight, stats,
              );
              if (stats.exceptions > 0 && retriesLeft > 0) {
                horizonRetryRef.current = window.setTimeout(() => attempt(retriesLeft - 1), 200);
              }
            };
            attempt(3);
          } else {
            hctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
          }
        }
      }

      const webglCanvas = astrobinWebglCanvasRef.current;
      const webgl = astrobinGlRef.current;
      if (webglCanvas && webgl && container) {
        // Same backing-store-at-devicePixelRatio reasoning as astrobinCanvasRef just below —
        // gl.viewport needs the backing-store (device-pixel) size, but drawFootprintImageWebGL's
        // own uResolution uniform stays in CSS pixels to match world2pix's own units (see its
        // comment).
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(container.clientWidth * dpr);
        const targetH = Math.round(container.clientHeight * dpr);
        if (webglCanvas.width !== targetW || webglCanvas.height !== targetH) {
          webglCanvas.width = targetW;
          webglCanvas.height = targetH;
          webglCanvas.style.width = `${container.clientWidth}px`;
          webglCanvas.style.height = `${container.clientHeight}px`;
          webgl.gl.viewport(0, 0, targetW, targetH);
        }
        webgl.gl.clear(webgl.gl.COLOR_BUFFER_BIT);
      }

      const canvas = astrobinCanvasRef.current;
      if (canvas && container) {
        // Backing store at devicePixelRatio for crisp rendering on retina displays; draw calls
        // below stay in the same CSS-pixel units world2pix() already returns (setTransform, not
        // scale, so this doesn't compound across repeated redraw() calls).
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(container.clientWidth * dpr);
        const targetH = Math.round(container.clientHeight * dpr);
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
          canvas.style.width = `${container.clientWidth}px`;
          canvas.style.height = `${container.clientHeight}px`;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
          // Only gates the *first* batch of thumbnails a session ever loads (see
          // hasRevealedAstrobinImagesRef) — once that's revealed, later footprints panned into
          // view show progressively as they load same as before; permanently withholding
          // already-loaded thumbnails every time a newly-panned-in footprint starts fetching would
          // make already-visible images flicker out and back during ordinary panning.
          const canShowAstrobinImages = hasRevealedAstrobinImagesRef.current || pendingAstrobinKeysRef.current.size === 0;
          astrobinHitRectsRef.current = showAstrobin && astrobinFootprints
            ? drawAstrobinFootprints(
              ctx, aladin, astrobinFootprints, hiddenAstrobinUrls, astrobinPopover?.footprint.url ?? null,
              astrobinImagesRef.current,
              (key) => {
                if (pendingAstrobinKeysRef.current.has(key)) return;
                pendingAstrobinKeysRef.current.add(key);
                setPendingAstrobinCount(pendingAstrobinKeysRef.current.size);
              },
              (key) => {
                pendingAstrobinKeysRef.current.delete(key);
                if (pendingAstrobinKeysRef.current.size === 0) hasRevealedAstrobinImagesRef.current = true;
                setPendingAstrobinCount(pendingAstrobinKeysRef.current.size);
                redrawRef.current();
              },
              container.clientWidth, container.clientHeight,
              canShowAstrobinImages,
              webgl,
            )
            : [];
        }

        // The popover always sits at its footprint's own bottom-right screen corner, recomputed
        // every redraw so it keeps tracking that corner across pans/zooms instead of staying
        // wherever it was when first opened. Its own DOM element is positioned imperatively here
        // (rather than via React state) for the same reason every other footprint here is —
        // this needs to update every redraw, not trigger one.
        const popoverEl = astrobinPopoverRef.current;
        if (popoverEl) {
          const selectedRect = astrobinPopover
            && astrobinHitRectsRef.current.find((r) => r.footprint.url === astrobinPopover.footprint.url);
          if (selectedRect) {
            const [brx, bry] = screenRectBottomRight(selectedRect);
            popoverEl.style.display = 'block';
            popoverEl.style.left = `${clamp(brx, 0, container.clientWidth - ASTROBIN_POPOVER_WIDTH)}px`;
            popoverEl.style.top = `${clamp(bry, 0, container.clientHeight - ASTROBIN_POPOVER_HEIGHT_ESTIMATE)}px`;
          } else {
            // The selected footprint isn't currently projectable (panned off whatever part of the
            // sky it's on) — nothing sensible to anchor to until it is again.
            popoverEl.style.display = 'none';
          }
        }
      }

      const terrainCanvas = terrainCanvasRef.current;
      if (terrainCanvas && container) {
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(container.clientWidth * dpr);
        const targetH = Math.round(container.clientHeight * dpr);
        if (terrainCanvas.width !== targetW || terrainCanvas.height !== targetH) {
          terrainCanvas.width = targetW;
          terrainCanvas.height = targetH;
          terrainCanvas.style.width = `${container.clientWidth}px`;
          terrainCanvas.style.height = `${container.clientHeight}px`;
        }
        const tctx = terrainCanvas.getContext('2d');
        if (tctx) {
          tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          if (showHorizon && showTerrain && terrainImageLoaded && terrainPixelDataRef.current && effectiveObservatoryInfo && isValidLocation(effectiveObservatoryInfo)) {
            const src = terrainPixelDataRef.current;
            const info = effectiveObservatoryInfo;

            // redraw() (and this whole effect) reruns on plenty of things that have nothing to do
            // with the terrain view — mountCoords.ra/dec updates every couple hundred ms while the
            // mount is tracking (sometimes faster than this key gate's own 120ms debounce window),
            // the resync guard's periodic onChange() tick, etc. Without this key gate, every one of
            // those redrew the terrain layer from scratch: a low-res flash immediately, then a sharp
            // redraw ~120ms later, on a view that never actually changed — which is exactly what
            // reads as "flickering between two resolutions". Marking the key seen *immediately*
            // (right here, not after the sharp pass finishes) is what actually fixes it: otherwise a
            // same-key call arriving before the 120ms debounce fires would re-enter this branch, redo
            // the live-pass flash, and cancel+reschedule the sharp pass — which at typical mountCoords
            // update rates meant the sharp pass got perpetually cancelled and never once completed. A
            // genuine pan/zoom still changes ra/dec/fov and invalidates this key, so the live+sharp
            // sequence still runs for anything that actually needs it. (lastTerrainViewKeyRef is a
            // ref, not a `let` inside this effect, precisely because the effect itself reruns this
            // often — see its own comment.)
            const [curRa, curDec] = aladin.getRaDec();
            const terrainViewKey = `${curRa},${curDec},${aladin.getFov()[0]},${container.clientWidth},${container.clientHeight},${horizonTime}`;
            if (terrainViewKey !== lastTerrainViewKeyRef.current) {
              lastTerrainViewKeyRef.current = terrainViewKey;
              window.clearTimeout(terrainDebounceRef.current);

              // Drawn every call (cheap, low-res) so the terrain visibly tracks the live gesture
              // instead of staying frozen at the pre-gesture framing until it settles — see
              // TERRAIN_LIVE_SAMPLE_COLS's own comment for the "sky map shrinks, ours doesn't" this
              // fixes. Its own exceptions are ignored: a blurry frame skipping one bad sample or two
              // isn't worth retrying when a sharper attempt is already scheduled below regardless.
              tctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
              drawTerrainOverlay(
                tctx, aladin, container.clientWidth, container.clientHeight, src, info, horizonTime,
                { exceptions: 0 }, TERRAIN_LIVE_SAMPLE_COLS,
              );

              // The high-res refinement stays debounced — walking TERRAIN_SAMPLE_COLS's much bigger
              // grid on every single animation-frame tick of a pan/zoom visibly bogged down the tab,
              // which the cheap live pass above doesn't. ~120ms after the gesture settles (same
              // window SessionTimeline's hover debounce uses) redraws it sharp.
              //
              // A zoom/pan that brings fresh HiPS tiles into view can leave Aladin's own WebGL
              // texture state transiently broken for a bit (see safePix2World's javadoc) — long
              // enough, sometimes, to still be broken when this fires. Retrying a few times instead
              // of accepting whatever this one attempt got means a zoom that lands in that window
              // doesn't leave the terrain layer stuck on the blurry live-pass version forever.
              const attempt = (retriesLeft: number) => {
                const stats: ProjectionStats = { exceptions: 0 };
                tctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
                drawTerrainOverlay(
                  tctx, aladin, container.clientWidth, container.clientHeight, src, info, horizonTime,
                  stats, TERRAIN_SAMPLE_COLS,
                );
                if (stats.exceptions > 0 && retriesLeft > 0) {
                  terrainDebounceRef.current = window.setTimeout(() => attempt(retriesLeft - 1), 250);
                }
              };
              terrainDebounceRef.current = window.setTimeout(() => attempt(3), 120);
            }
          } else {
            lastTerrainViewKeyRef.current = null;
            window.clearTimeout(terrainDebounceRef.current);
            tctx.clearRect(0, 0, container.clientWidth, container.clientHeight);
          }
        }
      }

      const targetsCanvas = targetsCanvasRef.current;
      if (targetsCanvas && container) {
        const dpr = window.devicePixelRatio || 1;
        const targetW = Math.round(container.clientWidth * dpr);
        const targetH = Math.round(container.clientHeight * dpr);
        if (targetsCanvas.width !== targetW || targetsCanvas.height !== targetH) {
          targetsCanvas.width = targetW;
          targetsCanvas.height = targetH;
          targetsCanvas.style.width = `${container.clientWidth}px`;
          targetsCanvas.style.height = `${container.clientHeight}px`;
        }
        const tgCtx = targetsCanvas.getContext('2d');
        if (tgCtx) {
          tgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
          tgCtx.clearRect(0, 0, container.clientWidth, container.clientHeight);
          if (openTargetJobs.length > 0) drawOpenTargets(tgCtx, aladin, openTargetJobs);
        }
      }

      overlay.removeAll();
      if (!mountCoords || !fov) {
        if (overlayImgRef.current) overlayImgRef.current.style.display = 'none';
        return;
      }

      const raDeg = mountCoords.ra * 15;
      const corners = fovCorners(raDeg, mountCoords.dec, fov.widthArcmin / 60, fov.heightArcmin / 60, pa ?? 0);
      overlay.add(window.A.polygon(corners));

      if (overlayImgRef.current && showLastImage && lastImageFilename) {
        positionFootprintImage(overlayImgRef.current, aladin, corners, true);
      } else if (overlayImgRef.current) {
        overlayImgRef.current.style.display = 'none';
      }
    };

    redrawRef.current();
  }, [
    mountCoords?.ra, mountCoords?.dec, fov?.widthArcmin, fov?.heightArcmin, pa, showLastImage, lastImageFilename,
    showAstrobin, astrobinFootprints, hiddenAstrobinUrls, astrobinPopover,
    planningFovEnabled, planningFovWidthArcmin, planningFovHeightArcmin, planningFovRotationDeg,
    showHorizon, showTerrain, horizonTime, effectiveObservatoryInfo, artificialHorizon, terrainImageLoaded,
    openTargetJobs,
  ]);

  useEffect(() => {
    if (!ready) return;
    const aladin = aladinRef.current;
    // Redraws themselves are now driven by the drawAllOverlays hook in the Aladin-init effect
    // above, in lockstep with Aladin's own render tick — this only needs to persist the view once
    // it's actually changed, which is genuinely poll-driven (there's no Aladin event that fires
    // once per settled pan/zoom rather than once per frame or once per throttle window).
    const onChange = () => {
      saveCurrentView(aladin);
    };

    // Aladin's own 'positionChanged'/'zoomChanged' callbacks are throttled to 100ms internally
    // (B.CALLBACKS_THROTTLE_TIME_MS in aladin.js) — and 'zoomChanged' specifically never fires at
    // all during mouse-wheel zooming, since that animates the field of view frame-by-frame without
    // ever going through the internal updateZoomState() that triggers it. Polling both fov and
    // center RA/Dec every animation frame instead tracks pan/zoom at the browser's actual refresh
    // rate rather than Aladin's throttled one, and is cheap (a few number compares) next to the
    // WebGL redraw Aladin is already doing at the same rate. (This still drives scheduleResync()
    // and saveCurrentView() below — the redraw itself no longer waits on this loop.)
    let lastFov = aladin.getFov()[0];
    let lastRaDec = aladin.getRaDec();
    let fovSettleTimer: number | undefined;

    // Aladin's own zoom-button handler can leave its rendered view visibly smaller than what
    // world2pix reports (confirmed via screenshot diffing: same FOV, same RA/Dec, sometimes a
    // full-canvas disc, sometimes a shrunken one with black margins on every side) — reachable at
    // any FOV via repeated real zoom-button clicks, not reproducible through setFov() alone.
    // Bisecting every axis by hand found it's specifically the view's declination sitting at 0°
    // (the celestial equator) at a wide FOV — landing back on dec exactly 0 breaks it again every
    // time, even after a 90° round trip; sitting a few degrees off 0 never breaks at all. But
    // rather than hard-code that one broken case, measure it directly: project two points a known
    // angular distance apart and compare the actual on-screen pixel gap to what that distance
    // should measure at the reported FOV. If Aladin's own render is desynced from what it reports,
    // this catches it regardless of which axis or FOV the next instance of this turns out to hinge
    // on, and skips the resync entirely on the (overwhelming majority of) frames where nothing is
    // actually wrong.
    function measuredGapPx(deltaDeg: number, stats?: ProjectionStats): number | null {
      const [ra, dec] = aladin.getRaDec();
      const a = safeWorld2Pix(aladin, ra, dec, stats);
      const b = safeWorld2Pix(aladin, ra, Math.max(-89, Math.min(89, dec + deltaDeg)), stats);
      if (!a || !b) return null;
      return Math.hypot(b[0] - a[0], b[1] - a[1]);
    }

    const SCALE_CHECK_DELTA_DEG = 1;
    const SCALE_CHECK_MIN_RATIO = 0.5;
    const EQUATOR_DODGE_DEG = 3;
    const MAX_RESYNC_ATTEMPTS = 4;

    // A round-trip nudge (there and immediately back) is enough to force Aladin to recompute its
    // layout in the general case, but not for the dec-0 case above — that one has to end somewhere
    // else, hence attempt > 0 dodging by a growing amount instead of undoing itself. Re-measures
    // after giving the browser a couple of real animation frames (the "let our own rendering run
    // for one more frame" this needs — a redraw fired the instant after gotoRaDec() reads Aladin's
    // pre-update state) rather than assuming any single attempt worked. onDone always fires exactly
    // once, whether or not anything actually needed fixing, so callers can track completion.
    function attemptResync(attempt: number, onDone: () => void) {
      const container = containerRef.current;
      const fov = aladin.getFov()[0];
      const expectedPx = container ? (SCALE_CHECK_DELTA_DEG / fov) * container.clientHeight : null;
      const actualPx = measuredGapPx(SCALE_CHECK_DELTA_DEG);
      const looksBroken = expectedPx != null && (actualPx == null || actualPx < expectedPx * SCALE_CHECK_MIN_RATIO);

      if (!looksBroken || attempt > MAX_RESYNC_ATTEMPTS) {
        lastRaDec = aladin.getRaDec();
        onChange();
        onDone();
        return;
      }

      const [curRa, curDec] = aladin.getRaDec();
      if (attempt === 0) {
        aladin.gotoRaDec(curRa + 0.001, curDec);
        aladin.gotoRaDec(curRa, curDec);
      }
      else {
        const dodged = curDec + EQUATOR_DODGE_DEG * attempt;
        aladin.gotoRaDec(curRa, Math.max(-89, Math.min(89, dodged)));
      }
      requestAnimationFrame(() => requestAnimationFrame(() => attemptResync(attempt + 1, onDone)));
    }

    // Debounced so a burst of clicks only pays for one resync, ~150ms after the last of them (not
    // on every tick, to avoid fighting a live drag).
    const scheduleResync = () => {
      window.clearTimeout(fovSettleTimer);
      fovSettleTimer = window.setTimeout(() => attemptResync(0, () => {}), 150);
    };

    // Clicking zoom-out again once already at the FOV ceiling (or zoom-in already at the floor)
    // re-runs Aladin's own broken layout path without moving getFov()/getRaDec() at all — the poll
    // loop below never sees a value change and so never schedules the resync above on its own, the
    // exact case a real user hammering the zoom-out button at max zoom lands in. Listening for the
    // click directly (capture phase — Aladin's own handler doesn't stop it) covers that regardless
    // of whether anything the poller can observe actually moved.
    function onZoomButtonClick(e: MouseEvent) {
      if ((e.target as HTMLElement)?.closest?.('.aladin-zoom-in, .aladin-zoom-out')) {
        scheduleResync();
      }
    }
    containerRef.current?.addEventListener('click', onZoomButtonClick, true);

    // Backstop for every other way this can happen — real usage kept finding fresh ones (dragging
    // the timeline scrollbar, some sequence of clicks past the FOV ceiling, presumably others still
    // unknown) faster than each could be isolated and special-cased individually. Rather than chase
    // the next trigger, verify continuously: piggybacked on the poll loop below (own timer, not a
    // separate setInterval) so it shares its lifecycle exactly — same cleanup, and it goes idle
    // whenever rAF does (backgrounded tab), where a setInterval would keep firing regardless.
    // guardBusy skips overlapping runs (attemptResync's own retries already span multiple animation
    // frames) rather than piling up parallel gotoRaDec calls that would fight each other.
    let guardBusy = false;
    let lastGuardCheck = performance.now();
    const GUARD_INTERVAL_MS = 600;

    // Aladin's own 'positionChanged'/'zoomChanged' callbacks are throttled to 100ms internally
    // (B.CALLBACKS_THROTTLE_TIME_MS in aladin.js) — and 'zoomChanged' specifically never fires at
    // all during mouse-wheel zooming, since that animates the field of view frame-by-frame without
    // ever going through the internal updateZoomState() that triggers it. Polling both fov and
    // center RA/Dec every animation frame instead tracks pan/zoom at the browser's actual refresh
    // rate rather than Aladin's throttled one, and is cheap (a few number compares) next to the
    // WebGL redraw Aladin is already doing at the same rate.
    let frameId = requestAnimationFrame(function poll() {
      // getFov()/getRaDec() themselves — not just the pix2world/world2pix calls inside redraw()
      // — can transiently throw right after a zoom/pan brings fresh HiPS tiles into view (same
      // "Tex image ... lazy initialization" WebGL state as safePix2World's javadoc describes).
      // Both are called unconditionally, every frame, before reaching our own try/catch-guarded
      // code — so without this wrapper, that one throw skips the reschedule below and this whole
      // polling loop (pan, zoom, every overlay) goes dead for the rest of the session, exactly
      // matching "zooming out breaks all handling until you pan": a pan is just the next
      // interaction big enough that *something* else happens to notice the view changed, not
      // anything that actually revives this loop. try/finally guarantees the reschedule always
      // happens, so a bad frame here costs at most one skipped frame, never the whole loop.
      try {
        const fov = aladin.getFov()[0];
        const [ra, dec] = aladin.getRaDec();
        if (fov !== lastFov || ra !== lastRaDec[0] || dec !== lastRaDec[1]) {
          const fovChanged = fov !== lastFov;
          lastFov = fov;
          lastRaDec = [ra, dec];
          onChange();
          if (fovChanged) scheduleResync();
        }

        // Zenith-lock: recomputed every frame the view actually has a center (cheap: one
        // setRotation() matrix update), not gated on the ra/dec-changed branch above, since the
        // parallactic angle also drifts with time alone even while the view sits still (real
        // sidereal motion) — though horizonTime here only advances when the user moves "Simulate
        // at"/clicks "Now", not on a real-time clock.
        const info = observatoryInfoRef.current;
        if (zenithLockRef.current && info && isValidLocation(info)) {
          const q = parallacticAngleDeg(ra, dec, info.latitude, info.longitude, horizonTimeRef.current);
          aladin.setRotation(-q);
        }

        const now = performance.now();
        if (!guardBusy && now - lastGuardCheck > GUARD_INTERVAL_MS) {
          lastGuardCheck = now;
          guardBusy = true;
          attemptResync(0, () => { guardBusy = false; });
        }
      }
      catch {
        // Ignored — see comment above; next frame gets another chance.
      }
      finally {
        frameId = requestAnimationFrame(poll);
      }
    });
    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(fovSettleTimer);
      containerRef.current?.removeEventListener('click', onZoomButtonClick, true);
    };
  }, [ready]);

  // Keeps the view centered on the mount as it moves, instead of a one-shot "center now" click.
  useEffect(() => {
    if (!ready || !followMount || !mountCoords || !aladinRef.current) return;
    aladinRef.current.gotoRaDec(mountCoords.ra * 15, mountCoords.dec);
  }, [ready, followMount, mountCoords?.ra, mountCoords?.dec]);

  useEffect(() => {
    writeStoredBoolean(FOLLOW_MOUNT_KEY, followMount);
  }, [followMount]);

  useEffect(() => {
    writeStoredBoolean(ZENITH_LOCK_KEY, zenithLock);
  }, [zenithLock]);

  useEffect(() => {
    writeStoredNumber(HORIZON_STEP_INDEX_KEY, horizonStepIndex);
  }, [horizonStepIndex]);

  useEffect(() => {
    writeStoredBoolean(SHOW_LAST_IMAGE_KEY, showLastImage);
  }, [showLastImage]);

  useEffect(() => {
    writeStoredBoolean(SHOW_NGC_KEY, showNgc);
  }, [showNgc]);

  useEffect(() => {
    writeStoredBoolean(SHOW_SH2_KEY, showSh2);
  }, [showSh2]);

  useEffect(() => {
    writeStoredBoolean(SHOW_GRID_KEY, showGrid);
  }, [showGrid]);

  useEffect(() => {
    writeStoredBoolean(SHOW_CONSTELLATION_LINES_KEY, showConstellationLines);
  }, [showConstellationLines]);

  useEffect(() => {
    writeStoredBoolean(SHOW_CONSTELLATION_BOUNDS_KEY, showConstellationBounds);
  }, [showConstellationBounds]);

  useEffect(() => {
    writeStoredBoolean(SHOW_OPEN_TARGETS_KEY, showOpenTargets);
  }, [showOpenTargets]);

  // Aladin's own built-in coordinate grid — no data to fetch, just its own show/hide toggle.
  // showLabels off: the RA/Dec labels on every gridline clutter a frame this small far more than
  // the lines themselves do. thickness isn't clamped to its documented default of 1 — confirmed
  // empirically down to 0.02 (still rendering, not vanishing) — so 0.1 renders visibly thinner
  // without risking the line disappearing entirely at some unverified lower value. A neutral
  // mid-gray reads as a measuring aid rather than a colored overlay competing with the sky itself.
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    aladinRef.current.setCooGrid({
      enabled: showGrid, showLabels: false, color: '#888888', thickness: 0.1,
    });
  }, [ready, showGrid]);

  useEffect(() => {
    writeStoredBoolean(SHOW_ASTROBIN_KEY, showAstrobin);
  }, [showAstrobin]);

  useEffect(() => {
    writeStoredBoolean(PLANNING_FOV_ENABLED_KEY, planningFovEnabled);
  }, [planningFovEnabled]);

  // Turning Planning FOV off and back on starts fresh (following the view again) rather than
  // silently resuming at whatever spot was locked last time — the lock is a "working on this one
  // right now" pin, not a setting that should survive the feature itself being toggled off.
  useEffect(() => {
    if (!planningFovEnabled) {
      setPlanningFovLocked(false);
      planningFovLockedCenterRef.current = null;
    }
  }, [planningFovEnabled]);

  // The Planning FOV target's diurnal path — every point sharing its declination, at every RA
  // (Earth's rotation carries the target along this exact circle over the course of a day, even
  // though its own RA/Dec never changes; what changes is which part of the circle is above the
  // horizon — see the visibility chart for that side of it). ~120 points (3° steps) is enough for
  // a visually smooth circle even right up against a pole, where it's tight and small.
  useEffect(() => {
    const overlay = planningFovPathOverlayRef.current;
    if (!overlay) return;
    overlay.removeAll();
    if (!planningFovEnabled || !planningFovCenter) return;
    const points: [number, number][] = [];
    for (let ra = 0; ra <= 360; ra += 3) points.push([ra, planningFovCenter.dec]);
    overlay.add(window.A.polygon(points));
  }, [planningFovEnabled, planningFovCenter]);

  useEffect(() => {
    writeStoredNumber(PLANNING_FOV_SENSOR_WIDTH_KEY, sensorWidthPx);
  }, [sensorWidthPx]);

  useEffect(() => {
    writeStoredNumber(PLANNING_FOV_SENSOR_HEIGHT_KEY, sensorHeightPx);
  }, [sensorHeightPx]);

  useEffect(() => {
    writeStoredNumber(PLANNING_FOV_PIXEL_SIZE_KEY, pixelSizeUm);
  }, [pixelSizeUm]);

  useEffect(() => {
    writeStoredNumber(PLANNING_FOV_FOCAL_LENGTH_KEY, focalLengthMm);
  }, [focalLengthMm]);

  useEffect(() => {
    writeStoredNumber(PLANNING_FOV_ROTATION_KEY, planningFovRotationDeg);
  }, [planningFovRotationDeg]);

  useEffect(() => {
    writeStoredBoolean(SHOW_HORIZON_KEY, showHorizon);
  }, [showHorizon]);

  useEffect(() => {
    writeStoredBoolean(SHOW_TERRAIN_KEY, showTerrain);
  }, [showTerrain]);

  // Fetched at most once, unconditionally on mount rather than gated behind showHorizon — the
  // zenith-lock toggle also needs observatoryInfo's lat/lon, and shouldn't require enabling
  // "Horizon" just to unlock it. Cheap, small, one-time fetch either way (location/artificial-
  // horizon only ever change if the user reconfigures KStars itself), same reasoning as the
  // NGC/Sh2 catalogs below.
  useEffect(() => {
    if (observatoryFetchedRef.current) return;
    observatoryFetchedRef.current = true;
    dataSource.getObservatoryInfo().then(setObservatoryInfo).catch(() => { /* no location configured — flat horizon/terrain just won't draw */ });
    dataSource.getArtificialHorizon().then(setArtificialHorizon).catch(() => { /* no artificial horizon defined — flat horizon still draws */ });
  }, []);

  // The Terrain panorama is an 8+MB image — only fetched once "Terrain photo" is actually turned
  // on (not just because Horizon is), and only if KStars has one configured at all.
  useEffect(() => {
    if (!showHorizon || !showTerrain || !observatoryInfo?.hasTerrain || terrainImgRef.current) return;
    const img = new Image();
    img.onload = () => {
      // Decoded once, here, rather than drawImage()-ing straight from the HTMLImageElement inside
      // drawTerrainOverlay's sampling loop: that was one canvas draw call per sampled grid cell
      // (tens of thousands per redraw, see TERRAIN_SAMPLE_COLS), and canvas call overhead dominated
      // over the actual per-pixel work. A single getImageData() here gives drawTerrainOverlay a
      // plain typed-array it can index directly — same-origin image, so this doesn't taint anything.
      const off = document.createElement('canvas');
      off.width = img.naturalWidth;
      off.height = img.naturalHeight;
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.drawImage(img, 0, 0);
      const { data } = octx.getImageData(0, 0, off.width, off.height);
      terrainPixelDataRef.current = { data, width: off.width, height: off.height };
      setTerrainImageLoaded(true);
    };
    img.src = dataSource.getTerrainImageUrl();
    terrainImgRef.current = img;
  }, [showHorizon, showTerrain, observatoryInfo?.hasTerrain]);

  // Both catalogs are fetched at most once (lazily, on first enable) and then just shown/hidden —
  // a 180° cone search already covers the whole sky regardless of where it's centered, so there's
  // never a reason to re-query VizieR as the view pans or zooms.
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (ngcCatalogRef.current) {
      const action = showNgc ? 'show' : 'hide';
      ngcCatalogRef.current[action]();
      ngcBoundaryRef.current?.[action]();
      return;
    }
    if (!showNgc) return;
    const aladin = aladinRef.current;
    const [ra, dec] = aladin.getRaDec();
    window.A.catalogFromVizieR(
      NGC_VIZIER_CAT,
      { ra, dec },
      OVERLAY_CATALOG_RADIUS_DEG,
      { onClick: 'showTable', shape: 'circle', sourceSize: 4, color: '#facc15', name: 'NGC/IC', limit: 20000 },
      (cat: any) => {
        ngcCatalogRef.current = cat;
        aladin.addCatalog(cat);
        ngcBoundaryRef.current = buildBoundaryOverlay(aladin, cat, 'size', '#facc15', 'NGC/IC boundaries');
      },
    );
  }, [ready, showNgc]);

  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (sh2CatalogRef.current) {
      const action = showSh2 ? 'show' : 'hide';
      sh2CatalogRef.current[action]();
      sh2BoundaryRef.current?.[action]();
      return;
    }
    if (!showSh2) return;
    const aladin = aladinRef.current;
    const [ra, dec] = aladin.getRaDec();
    window.A.catalogFromVizieR(
      SH2_VIZIER_CAT,
      { ra, dec },
      OVERLAY_CATALOG_RADIUS_DEG,
      { onClick: 'showTable', shape: 'circle', sourceSize: 4, color: '#fb7185', name: 'Sh2', limit: 1000 },
      (cat: any) => {
        sh2CatalogRef.current = cat;
        aladin.addCatalog(cat);
        sh2BoundaryRef.current = buildBoundaryOverlay(aladin, cat, 'Diam', '#fb7185', 'Sharpless (Sh2) boundaries');
      },
    );
  }, [ready, showSh2]);

  // Same "fetch once on first enable, then just show/hide" shape as NGC/Sh2 above, but the source
  // is a bundled static asset (see fetchConstellationLines) rather than a VizieR cone search.
  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (constellationLinesOverlayRef.current) {
      const action = showConstellationLines ? 'show' : 'hide';
      constellationLinesOverlayRef.current[action]();
      return;
    }
    if (!showConstellationLines) return;
    const aladin = aladinRef.current;
    fetchConstellationLines()
      .then((features) => {
        constellationLinesOverlayRef.current = buildConstellationLinesOverlay(aladin, features);
      })
      .catch(() => { /* asset unreachable — toggle stays on, nothing drawn, no retry loop */ });
  }, [ready, showConstellationLines]);

  useEffect(() => {
    if (!ready || !aladinRef.current) return;
    if (constellationBoundsOverlayRef.current) {
      const action = showConstellationBounds ? 'show' : 'hide';
      constellationBoundsOverlayRef.current[action]();
      return;
    }
    if (!showConstellationBounds) return;
    const aladin = aladinRef.current;
    fetchConstellationBounds()
      .then((features) => {
        constellationBoundsOverlayRef.current = buildConstellationBoundsOverlay(aladin, features);
      })
      .catch(() => { /* asset unreachable — toggle stays on, nothing drawn, no retry loop */ });
  }, [ready, showConstellationBounds]);

  // Fetched at most once (lazily, on first enable) from the data source — then just shown/hidden
  // via redraw()'s showAstrobin check.
  useEffect(() => {
    if (!showAstrobin || astrobinFetchedRef.current) return;
    astrobinFetchedRef.current = true;
    dataSource.getAstrobinFootprints()
      // Largest-FOV shots first (rendered first = sit at the bottom of the DOM stacking order) so a
      // wide-field footprint never sits on top of a narrower one of the same target by default —
      // hover (see the z-index rule in index.css) still lifts whichever one you're pointing at.
      .then((footprints) => [...footprints].sort((a, b) => footprintAreaDeg2(b) - footprintAreaDeg2(a)))
      .then(setAstrobinFootprints)
      // AstroBin unreachable — leave the toggle checked but nothing drawn, no retry loop. Still
      // has to leave `null` (still-loading) for an empty array (nothing to show) though, or the
      // loading bar above spins forever instead of just giving up.
      .catch(() => setAstrobinFootprints([]));
  }, [showAstrobin]);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === cardRef.current);
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement === cardRef.current) {
      document.exitFullscreen();
    } else {
      cardRef.current?.requestFullscreen();
    }
  }

  // Locking pins the framing at whatever the view center happens to be right now (captured
  // immediately, not waiting for the usual 200ms debounce — the user just asked for this exact
  // spot); unlocking clears the pin so redraw() goes back to reading aladin.getRaDec() live.
  function togglePlanningFovLock() {
    setPlanningFovLocked((locked) => {
      if (locked) {
        planningFovLockedCenterRef.current = null;
        return false;
      }
      const aladin = aladinRef.current;
      if (aladin) {
        const [ra, dec] = aladin.getRaDec();
        planningFovLockedCenterRef.current = { ra, dec };
        setPlanningFovCenter({ ra, dec });
      }
      return true;
    });
  }

  // The overlay used DEFAULT_STRETCH (a no-op linear passthrough) unconditionally, so "last
  // image" always rendered essentially unstretched instead of matching what the image strip
  // shows for the same file. Cached per filename like ImageStrip's own requests — a 404 (e.g. a
  // since-deleted file) must never be retried on every status push.
  const requestedStretchFile = useRef<string | null>(null);
  useEffect(() => {
    if (!lastImageFilename || requestedStretchFile.current === lastImageFilename) return;
    requestedStretchFile.current = lastImageFilename;
    fetchAutoStretch(lastImageFilename, false)
      .then(setLastImageStretch)
      .catch(() => { /* leave the previous stretch in place, no retry */ });
  }, [lastImageFilename]);

  return (
    <div ref={cardRef} className="sky-map-card sky-map-card--wide">
      <h3>Sky Map</h3>
      <div className="sky-map-controls">
        <div className="sky-map-palette-picker" ref={paletteRef}>
          <button
            type="button"
            className="sky-map-icon-button"
            onClick={() => setPaletteOpen((open) => !open)}
            title={`Palette: ${surveys.find((s) => s.id === surveyId)?.label ?? ''}`}
            aria-label="Choose palette"
          >
            <PaletteIcon />
          </button>
          {paletteOpen && (
            <div className="sky-map-palette-popup">
              {surveys.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="sky-map-palette-option"
                  data-active={s.id === surveyId ? 'true' : undefined}
                  onClick={() => { setSurveyId(s.id); setPaletteOpen(false); }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          className="sky-map-icon-button"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <CompressIcon /> : <ExpandIcon />}
        </button>
        {/* Unlike Zenith lock (which can still become available once observatoryInfo loads),
         * mountCoords/lastImageFilename are either passed by the caller or they structurally never
         * will be for this deployment — a permanently-disabled button is worse than no button. */}
        {mountCoords && (
          <IconToggleButton
            active={followMount}
            onToggle={() => setFollowMount((v) => !v)}
            title="Follow mount"
            icon={<CrosshairIcon />}
          />
        )}
        <IconToggleButton
          active={zenithLock}
          onToggle={() => setZenithLock((v) => !v)}
          disabled={!effectiveObservatoryInfo || !isValidLocation(effectiveObservatoryInfo)}
          title="Zenith lock — locks the view to zenith-up (Horizontal mode) instead of celestial-north-up, so the sky's actual drift during a session stays legible"
          icon={<ZenithIcon />}
        />
        {lastImageFilename && (
          <IconToggleButton
            active={showLastImage}
            onToggle={() => setShowLastImage((v) => !v)}
            title="Show last image"
            icon={<LastImageIcon />}
          />
        )}
        <IconToggleButton active={showNgc} onToggle={() => setShowNgc((v) => !v)} title="NGC/IC" icon={<GalaxyIcon />} />
        <IconToggleButton active={showSh2} onToggle={() => setShowSh2((v) => !v)} title="Sharpless (Sh2)" icon={<NebulaIcon />} />
        <IconToggleButton active={showGrid} onToggle={() => setShowGrid((v) => !v)} title="Coordinate grid" icon={<GridIcon />} />
        <IconToggleButton
          active={showConstellationLines}
          onToggle={() => setShowConstellationLines((v) => !v)}
          title="Constellation lines"
          icon={<ConstellationLinesIcon />}
        />
        <IconToggleButton
          active={showConstellationBounds}
          onToggle={() => setShowConstellationBounds((v) => !v)}
          title="Constellation boundaries"
          icon={<ConstellationBoundsIcon />}
        />
        <IconToggleButton active={showAstrobin} onToggle={() => setShowAstrobin((v) => !v)} title="My AstroBin" icon={<GalleryIcon />} />
        {supportsOpenTargets && (
          <IconToggleButton
            active={showOpenTargets}
            onToggle={() => setShowOpenTargets((v) => !v)}
            title={ekosReady ? 'Open targets — from the running Ekos scheduler' : 'Open targets — from the configured sequence file'}
            icon={<OpenTargetsIcon />}
          />
        )}
        <IconToggleButton
          active={planningFovEnabled}
          onToggle={() => setPlanningFovEnabled((v) => !v)}
          title="Planning FOV"
          icon={<ViewfinderIcon />}
        />
        <IconToggleButton active={showHorizon} onToggle={() => setShowHorizon((v) => !v)} title="Horizon" icon={<HorizonIcon />} />
      </div>
      {planningFovEnabled && (
        <div className="sky-map-planning-fov">
          <div className="sky-map-sensor-config" ref={sensorConfigRef}>
            <button
              type="button"
              className="sky-map-icon-button"
              onClick={() => setSensorConfigOpen((open) => !open)}
              title="Sensor settings"
              aria-label="Sensor settings"
            >
              <SlidersIcon />
            </button>
            {sensorConfigOpen && (
              <div className="sky-map-sensor-popup">
                <label>
                  Sensor
                  <input
                    type="number" min={1} step={1} value={sensorWidthPx}
                    onChange={(e) => setSensorWidthPx(Number(e.target.value))}
                  />
                  ×
                  <input
                    type="number" min={1} step={1} value={sensorHeightPx}
                    onChange={(e) => setSensorHeightPx(Number(e.target.value))}
                  />
                  px
                </label>
                <label>
                  Pixel size
                  <input
                    type="number" min={0.1} step={0.01} value={pixelSizeUm}
                    onChange={(e) => setPixelSizeUm(Number(e.target.value))}
                  />
                  µm
                </label>
                <label>
                  Focal length
                  <input
                    type="number" min={1} step={1} value={focalLengthMm}
                    onChange={(e) => setFocalLengthMm(Number(e.target.value))}
                  />
                  mm
                </label>
              </div>
            )}
          </div>
          <IconToggleButton
            active={planningFovLocked}
            onToggle={togglePlanningFovLock}
            title={planningFovLocked ? 'Unlock — resume following the view center' : 'Lock — pin the framing here instead of following the view center'}
            icon={<LockIcon />}
          />
          <label>
            Rotation
            <input
              type="number" step={1} value={planningFovRotationDeg}
              onChange={(e) => setPlanningFovRotationDeg(Number(e.target.value))}
            />
            °
          </label>
          <span className="sky-map-planning-fov-result">
            → {planningFovWidthArcmin.toFixed(1)}&apos; × {planningFovHeightArcmin.toFixed(1)}&apos;
            {' '}({(planningFovWidthArcmin / 60).toFixed(2)}° × {(planningFovHeightArcmin / 60).toFixed(2)}°)
          </span>
          <div className="sky-map-fov-results-anchor" ref={fovResultsRef}>
            <button type="button" className="sky-map-button" onClick={searchFovObjects} disabled={fovObjectsLoading}>
              {fovObjectsLoading ? 'Searching…' : 'Find objects in FOV'}
            </button>
            {fovResultsOpen && (
              <div className="sky-map-fov-results-popup">
                {fovObjectsError && <div className="sky-map-fov-objects-empty">SIMBAD search failed — try again</div>}
                {fovObjectsLoading && <div className="sky-map-fov-objects-empty">Searching SIMBAD…</div>}
                {fovObjects && (
                  fovObjects.length === 0 ? (
                    <div className="sky-map-fov-objects-empty">No nebulae, remnants, or clusters found in this frame</div>
                  ) : (
                    <ul className="sky-map-fov-objects">
                      {fovObjects.map((obj) => (
                        <li key={obj.name}>
                          <button type="button" className="sky-map-fov-object-goto" onClick={() => goToFovObject(obj)} title="Center on this object">
                            <span className="sky-map-fov-object-name">{obj.name}</span>
                            <span className="sky-map-fov-object-type">{obj.typeLabel}</span>
                            {Number.isFinite(obj.sizeArcmin) && (
                              <span className="sky-map-fov-object-size">{obj.sizeArcmin.toFixed(0)}&apos;</span>
                            )}
                          </button>
                          <span className="sky-map-fov-object-astrobin">
                            AstroBin:
                            <a href={astrobinSearchUrl(obj.name)} target="_blank" rel="noreferrer">Name</a>
                            <button type="button" onClick={() => openAstrobinCoordsSearch(obj)} title="AstroBin search by coordinates (requires AstroBin Ultimate)">
                              Coords
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )
                )}
              </div>
            )}
          </div>
          {planningFovCenter && (!effectiveObservatoryInfo || !isValidLocation(effectiveObservatoryInfo)) && (
            <span className="sky-map-horizon-warning">No location set — can&apos;t compute visibility (set one in the Horizon panel)</span>
          )}
          {planningFovVisibility && (
            <div className="sky-map-visibility">
              <VisibilityChart
                samples={planningFovVisibility.samples}
                centerMs={horizonTime}
                window={planningFovVisibility.window}
              />
              <span className="sky-map-visibility-text">{formatVisibilityText(planningFovVisibility.window)}</span>
            </div>
          )}
        </div>
      )}
      {showHorizon && (
        <div className="sky-map-horizon">
          <span className="sky-map-horizon-clock" title="Simulated time">
            <ClockIcon />
          </span>
          <input
            type="datetime-local"
            value={toDatetimeLocalValue(horizonTime)}
            onChange={(e) => {
              const t = new Date(e.target.value).getTime();
              if (!Number.isNaN(t)) setHorizonTime(t);
            }}
          />
          <div className="sky-map-horizon-stepper">
            <button
              type="button"
              className="sky-map-icon-button"
              onClick={() => setHorizonTime((t) => stepHorizonTime(t, HORIZON_STEPS[horizonStepIndex], -1))}
              title={`Step back ${HORIZON_STEPS[horizonStepIndex].label}`}
              aria-label="Step back"
            >
              −
            </button>
            <select
              value={horizonStepIndex}
              onChange={(e) => setHorizonStepIndex(Number(e.target.value))}
              title="Step size"
              aria-label="Step size"
            >
              {HORIZON_STEPS.map((step, i) => (
                <option key={step.label} value={i}>{step.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="sky-map-icon-button"
              onClick={() => setHorizonTime((t) => stepHorizonTime(t, HORIZON_STEPS[horizonStepIndex], 1))}
              title={`Step forward ${HORIZON_STEPS[horizonStepIndex].label}`}
              aria-label="Step forward"
            >
              +
            </button>
          </div>
          <button type="button" className="sky-map-button" onClick={() => setHorizonTime(Date.now())}>Now</button>
          {observatoryInfo?.hasTerrain && (
            <IconToggleButton
              active={showTerrain}
              onToggle={() => setShowTerrain((v) => !v)}
              title="Terrain photo"
              icon={<TerrainIcon />}
            />
          )}
          {/* Only when the dataSource itself has no real location to give — once that's true, a
           * visitor-supplied location (typed or geolocated) is the only way horizon/zenith-lock/
           * visibility become available at all, so this stays visible (as a compact readout +
           * "Change") even after manualLocation is set, rather than disappearing silently. */}
          {observatoryInfo && !isValidLocation(observatoryInfo) && (
            <div className="sky-map-location-prompt" ref={locationPopoverRef}>
              {manualLocation ? (
                <span className="sky-map-horizon-note">
                  Using your location ({manualLocation.latitude.toFixed(2)}°, {manualLocation.longitude.toFixed(2)}°)
                </span>
              ) : (
                <span className="sky-map-horizon-warning">No location set</span>
              )}
              <button type="button" className="sky-map-button" onClick={() => setLocationPopoverOpen((open) => !open)}>
                {manualLocation ? 'Change' : 'Set location'}
              </button>
              {locationPopoverOpen && (
                <div className="sky-map-location-popup">
                  <button type="button" className="sky-map-button" onClick={useBrowserGeolocation} disabled={geolocating}>
                    {geolocating ? 'Locating…' : 'Use my location'}
                  </button>
                  <label>
                    Latitude
                    <input
                      type="number" min={-90} max={90} step={0.0001} value={manualLatDraft}
                      onChange={(e) => setManualLatDraft(Number(e.target.value))}
                    />
                    °
                  </label>
                  <label>
                    Longitude
                    <input
                      type="number" min={-180} max={180} step={0.0001} value={manualLonDraft}
                      onChange={(e) => setManualLonDraft(Number(e.target.value))}
                    />
                    °
                  </label>
                  <button
                    type="button"
                    className="sky-map-button"
                    onClick={() => { applyManualLocation(manualLatDraft, manualLonDraft); setLocationPopoverOpen(false); }}
                  >
                    Set
                  </button>
                  {geolocationError && <span className="sky-map-horizon-warning">{geolocationError}</span>}
                </div>
              )}
            </div>
          )}
          {artificialHorizon.length > 0 && (
            <span className="sky-map-horizon-note">
              + {artificialHorizon.length} artificial horizon region{artificialHorizon.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}
      <div
        ref={containerRef}
        className="sky-map"
        onClick={handleAstrobinClick}
      >
        {/* Covers the whole loading lifecycle, not just thumbnails: astrobinFootprints is null
            until the footprint *list* itself has been fetched (see the effect below), which for a
            few hundred footprints is itself not instant — without this half, toggling AstroBin on
            showed nothing at all (no bar, no footprints) for that entire stretch, only starting to
            show progress once thumbnails began loading. */}
        {showAstrobin && (astrobinFootprints === null || pendingAstrobinCount > 0) && (
          <div className="sky-map-astrobin-loading" aria-hidden>
            <div className="sky-map-astrobin-loading-bar" />
          </div>
        )}
        {lastImageFilename && (
          <img
            ref={overlayImgRef}
            src={imageUrl(lastImageFilename, 600, lastImageStretch)}
            alt="Last capture"
            className="sky-map-last-image"
          />
        )}
        {/* The footprint images themselves — WebGL, seam-free (see drawFootprintImageWebGL). Sits
            directly under astrobinCanvasRef, which now only draws mesh outlines, the hidden/dashed
            state, and the gear button on top of whatever this paints (or, lacking a WebGL context,
            its own Canvas2D drawImageMesh fallback — see AstrobinGl's own comment). */}
        <canvas ref={astrobinWebglCanvasRef} className="sky-map-astrobin-webgl-canvas" />
        <canvas ref={astrobinCanvasRef} className="sky-map-astrobin-canvas" />
        <canvas ref={terrainCanvasRef} className="sky-map-terrain-canvas" />
        {/* Painted last (on top of the terrain photo and AstroBin footprints) so the horizon line
            and artificial-horizon shading are always visible, not hidden under the terrain overlay
            or a wide AstroBin footprint. */}
        <canvas ref={horizonCanvasRef} className="sky-map-horizon-canvas" />
        {/* Topmost of the plain-canvas overlays — a handful of small marker+label pairs, never
            wide enough to meaningfully hide anything underneath the way the terrain photo can. */}
        <canvas ref={targetsCanvasRef} className="sky-map-targets-canvas" />
        {astrobinPopover && (
          <div className="sky-map-astrobin-popover" ref={astrobinPopoverRef}>
            <button type="button" className="sky-map-astrobin-popover-close" onClick={() => setAstrobinPopover(null)} aria-label="Close">×</button>
            <div className="sky-map-astrobin-popover-title">{astrobinPopover.footprint.title}</div>
            <div className="sky-map-astrobin-popover-date">
              {astrobinPopover.loading ? 'Loading…' : astrobinPopover.error ? 'Failed to load date' : (astrobinPopover.date ?? 'No acquisition date')}
            </div>
            <div className="sky-map-astrobin-popover-actions">
              <a href={astrobinPopover.footprint.url} target="_blank" rel="noreferrer">Open on AstroBin</a>
              <button type="button" className="sky-map-button" onClick={() => toggleAstrobinHidden(astrobinPopover.footprint.url)}>
                {hiddenAstrobinUrls.has(astrobinPopover.footprint.url) ? 'Show' : 'Hide'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
