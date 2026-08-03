/** SkyMapCard's own view of a KStars Ekos scheduler job — the same shape as KStarsCluster's own
 *  src/api/types.ts SchedulerJob, factored out here since this is the one part of it SkyMapCard
 *  itself needs (the "open targets"/Planning FOV overlays). Consumers with a live scheduler (like
 *  KStarsCluster's own dashboard) should re-export this from wherever their app already defines
 *  SchedulerJob, rather than maintaining two separate copies of the shape. */
export interface SchedulerJob {
  name: string;
  altitude: number;
  completedCount: number;
  completionTime: string;
  inSequenceFocus: boolean;
  minAltitude: number;
  minMoonSeparation: number;
  pa: number;
  repeatsRemaining: number;
  repeatsRequired: number;
  sequence: string;
  sequenceCount: number;
  stage: number;
  startupTime: string;
  state: number;
  targetDEC: number;
  targetRA: number;
  fRatio: number;
}

/** Mirrors org.kde.kstars.ekos.SchedulerJob.JobState's ordinal order (SchedulerJob.java). */
const JOB_STATE_LABELS = [
  'JOB_IDLE', 'JOB_EVALUATION', 'JOB_SCHEDULED', 'JOB_BUSY',
  'JOB_ERROR', 'JOB_ABORTED', 'JOB_INVALID', 'JOB_COMPLETE',
];

export function getJobStateLabel(state: number): string {
  return JOB_STATE_LABELS[state] ?? `JOB_STATE_${state}`;
}
