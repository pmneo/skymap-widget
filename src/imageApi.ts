/** PixInsight ScreenTransferFunction convention — all in [0,1]. midtones=0.5 is neutral (linear).
 *  Backs SkyMapCard's "last image" overlay (only relevant to a deployment with a live capture
 *  backend serving these two relative routes — e.g. KStarsCluster's own dashboard; a
 *  lastImageFilename prop is simply never passed by a deployment without one). */
export interface StretchSettings {
  shadows: number;
  midtones: number;
  highlights: number;
}

export const DEFAULT_STRETCH: StretchSettings = { shadows: 0, midtones: 0.5, highlights: 1 };

export function imageUrl(filename: string, maxDim: number, stretch: StretchSettings): string {
  const params = new URLSearchParams({
    file: filename,
    maxDim: String(maxDim),
    shadows: String(stretch.shadows),
    midtones: String(stretch.midtones),
    highlights: String(stretch.highlights),
  });
  return `/images/thumb?${params.toString()}`;
}

export async function fetchAutoStretch(filename: string, strong: boolean): Promise<StretchSettings> {
  const params = new URLSearchParams({ file: filename, strong: String(strong) });
  const res = await fetch(`/images/autostretch?${params.toString()}`);
  return res.json();
}
