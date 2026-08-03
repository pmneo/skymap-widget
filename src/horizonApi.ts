import type { ObservatoryInfo, ArtificialHorizonRegion } from './types';

export type { ObservatoryInfo, ArtificialHorizonRegion };

/** -999/-999 is the "never configured" sentinel a SkyMapDataSource.getObservatoryInfo() should
 *  return when a deployment has no real location — SkyMapCard checks this before drawing anything
 *  location-dependent (zenith-lock, horizon, visibility charts) instead of drawing nonsense at
 *  0,0. Originally KStarsConfig.getLatitude's own sentinel; kept the same value here since it's
 *  now the interface's sentinel too, not just one backend's. */
export function isValidLocation(info: ObservatoryInfo): boolean {
  return info.latitude !== -999 && info.longitude !== -999;
}
