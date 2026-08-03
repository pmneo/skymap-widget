export interface ObservatoryInfo {
  latitude: number;
  longitude: number;
  terrainCorrectAz: number;
  terrainCorrectAlt: number;
  hasTerrain: boolean;
}

export interface ArtificialHorizonRegion {
  label: string;
  points: { az: number; alt: number }[];
}

/** One entry in the palette picker — either a real public HiPS survey (`builtin`, an ID Aladin's
 * own CDS registry already knows) or a custom HiPS tree at `custom.url` (resolved relative to
 * wherever the app is hosted — see buildImageSurvey). */
export interface SurveyOption {
  id: string;
  label: string;
  builtin?: string;
  custom?: { url: string; frame: string; order: number };
}

export interface AstrobinFootprintBase {
  title: string;
  hash: string;
  url: string;
  thumbnailUrl: string;
}

/** The backend prefers real corner RA/Dec pairs (AstroBin's own advanced-plate-solve output) when
 * available — that sidesteps rotation-angle sign/handedness guessing entirely, which turned out to
 * be genuinely ambiguous (both the raw "basic" orientation field and a fixed basic-vs-advanced
 * preference were each confirmed wrong on different real images). `corners` is only absent for
 * images that were never advanced-solved, the rarer case. */
export type AstrobinFootprint = AstrobinFootprintBase & (
  | { corners: [number, number][]; ra?: undefined }
  | { corners?: undefined; ra: number; dec: number; widthDeg: number; heightDeg: number; orientationDeg: number }
);

export interface AstrobinImageDetail {
  title: string;
  url: string;
  date: string | null;
}

/** One constellation's stick-figure line art — several independent strokes (`lines`), each a
 * sequence of [ra,dec] vertices (degrees, J2000) to connect in order. Loaded from a static asset
 * rather than a VizieR cone search: unlike NGC/Sh2, "which stars to connect for Orion" isn't an
 * astronomical measurement with a canonical catalog, it's an artistic convention — this app bundles
 * the widely-reused HYG-derived stick figures from ofrohn/d3-celestial (BSD-licensed,
 * https://github.com/ofrohn/d3-celestial), converted from its GeoJSON (lon in [-180,180), i.e. RA
 * mirrored into a signed range) to plain RA-in-[0,360) at public/constellations/lines.json. */
export interface ConstellationLineFeature {
  id: string;
  lines: [number, number][][];
}

/** One constellation's official IAU boundary polygon (Delporte 1930) — unlike the stick figures
 * above, this *is* a fixed astronomical definition, but VizieR's own machine-readable edition
 * (VI/49) is raw boundary *segments* shared between neighboring constellations, not one closed
 * polygon per constellation ready to draw — reassembling that from scratch isn't worth it when
 * ofrohn/d3-celestial already ships the same Delporte data pre-assembled into one closed ring per
 * constellation. Converted the same way as the lines, to bounds.json alongside it. */
export interface ConstellationBoundaryFeature {
  id: string;
  polygon: [number, number][];
}
