/** Ports of de.pmneo.kstars.utils.Coordinates' altAzToRaDec (and its exact inverse, needed to
 * sample the Terrain panorama by RA/Dec) — see that class for the astronomy background. Kept
 * client-side (rather than asking the backend for every RA/Dec<->Alt/Az conversion) since the Sky
 * Map's horizon simulation needs hundreds of these per redraw (every horizon/terrain sample
 * point), at interactive frame rates while panning/zooming. */

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Julian Date for a JS epoch-ms instant — equivalent to (and much simpler than) porting
 * Coordinates.java's Gregorian-calendar-field version, since both just compute the Julian Date of
 * the same UTC instant (2440587.5 is the JD of the Unix epoch itself). */
function getJulianDate(dateMs: number): number {
  return dateMs / 86400000 + 2440587.5;
}

/** @param longitudeDeg East positive. @returns local sidereal time in hours [0, 24). */
export function getLocalSiderealTime(dateMs: number, longitudeDeg: number): number {
  const julianDate = getJulianDate(dateMs);
  const daysSinceEpoch = julianDate - 2451545.0;
  const t = daysSinceEpoch / 36525.0;

  const gmstDeg = 280.46061837 + 360.98564736629 * daysSinceEpoch
    + 0.000387933 * t * t - (t * t * t) / 38710000.0;

  const lstDeg = ((gmstDeg + longitudeDeg) % 360.0 + 360.0) % 360.0;
  return lstDeg / 15.0;
}

/** Azimuth measured from North (0) through East (90). @returns RA/Dec in degrees. */
export function altAzToRaDec(
  altitudeDeg: number, azimuthDeg: number, latitudeDeg: number, longitudeDeg: number, dateMs: number,
): { raDeg: number; decDeg: number } {
  const alt = toRad(altitudeDeg);
  const az = toRad(azimuthDeg);
  const lat = toRad(latitudeDeg);

  // Mathematically always in [-1, 1], but floating-point rounding can push it a hair past either
  // end — Math.asin of anything outside that range is NaN, which then poisons every value derived
  // from dec for the rest of this call (and, worse, every canvas draw call it feeds into — see
  // drawTerrainOverlay's own NaN guard for why that matters more than it sounds like it should).
  const sinDec = Math.max(-1.0, Math.min(1.0, Math.sin(alt) * Math.sin(lat) + Math.cos(alt) * Math.cos(lat) * Math.cos(az)));
  const dec = Math.asin(sinDec);

  let cosHourAngle = (Math.sin(alt) - Math.sin(lat) * sinDec) / (Math.cos(lat) * Math.cos(dec));
  cosHourAngle = Math.max(-1.0, Math.min(1.0, cosHourAngle));
  let hourAngleDeg = toDeg(Math.acos(cosHourAngle));
  if (Math.sin(az) > 0) {
    hourAngleDeg = 360.0 - hourAngleDeg;
  }

  const lst = getLocalSiderealTime(dateMs, longitudeDeg);
  const raHours = (((lst - hourAngleDeg / 15.0) % 24.0) + 24.0) % 24.0;

  return { raDeg: raHours * 15, decDeg: toDeg(dec) };
}

/** The exact inverse of altAzToRaDec (same spherical triangle, roles of alt/az and dec/hour-angle
 * swapped) — verified by round-tripping alt/az through both functions. */
export function raDecToAltAz(
  raDeg: number, decDeg: number, latitudeDeg: number, longitudeDeg: number, dateMs: number,
): { altDeg: number; azDeg: number } {
  const dec = toRad(decDeg);
  const lat = toRad(latitudeDeg);

  const lst = getLocalSiderealTime(dateMs, longitudeDeg);
  let hourAngleDeg = (lst * 15 - raDeg) % 360;
  if (hourAngleDeg < 0) hourAngleDeg += 360;
  const hourAngle = toRad(hourAngleDeg);

  const sinAlt = Math.max(-1.0, Math.min(1.0, Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(hourAngle)));
  const alt = Math.asin(sinAlt);

  let cosAz = (Math.sin(dec) - Math.sin(lat) * sinAlt) / (Math.cos(lat) * Math.cos(alt));
  cosAz = Math.max(-1.0, Math.min(1.0, cosAz));
  let azDeg = toDeg(Math.acos(cosAz));
  if (Math.sin(hourAngle) > 0) {
    azDeg = 360.0 - azDeg;
  }

  return { altDeg: toDeg(alt), azDeg };
}
