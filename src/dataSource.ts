import type { SchedulerJob } from './scheduler';
import type {
  ObservatoryInfo, ArtificialHorizonRegion, AstrobinFootprint, AstrobinImageDetail, SurveyOption,
} from './types';

/** Everything SkyMapCard needs that's specific to *where it's deployed* — a live KStarsCluster
 * backend today, potentially a static JSON config dump (no live backend at all) for a future
 * public site. Deliberately narrow: NGC/Sh2 (Aladin's own live VizieR cone search), the
 * constellation lines/boundaries (static assets bundled with the component itself), and the "last
 * image" overlay (shared app-wide image infrastructure, not sky-map-specific) all work identically
 * in any deployment already and so aren't part of this interface — see the SkyMapCard.tsx call
 * sites for each of those instead. */
export interface SkyMapDataSource {
  getObservatoryInfo(): Promise<ObservatoryInfo>;
  getArtificialHorizon(): Promise<ArtificialHorizonRegion[]>;
  /** Only meaningful once getObservatoryInfo()'s hasTerrain is true. */
  getTerrainImageUrl(): string;
  getAstrobinFootprints(): Promise<AstrobinFootprint[]>;
  getAstrobinImageDetail(hash: string): Promise<AstrobinImageDetail>;
  /** The "open targets" overlay's Ekos-off path — see isOpenSchedulerJob's own comment in
   * SkyMapCard.tsx for why every job returned here counts as open by construction. */
  getScheduleFileJobs(): Promise<SchedulerJob[]>;
  /** The palette picker's own list — static config, not a fetch, but still deployment-specific:
   * every custom entry's URL only makes sense relative to wherever its own HiPS tiles actually
   * live (see buildImageSurvey in SkyMapCard.tsx, which resolves it relative to the current
   * origin). */
  getSurveys(): SurveyOption[];
}
