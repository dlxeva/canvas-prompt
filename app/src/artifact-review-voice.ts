import type { ReviewMark } from './artifact-review-package'

export const VOICE_MARK_LOOKBACK_MS = 20_000

/**
 * Temporal proximity is only a candidate signal.  It deliberately does not
 * infer that a deictic phrase refers to this mark; the user must confirm it.
 */
export function findVoiceTargetCandidate(
  marks: ReviewMark[],
  pageNumber: number,
  voiceWindow: { startMs: number; endMs: number },
): ReviewMark | undefined {
  const earliest = Math.max(0, voiceWindow.startMs - VOICE_MARK_LOOKBACK_MS)
  return marks
    .filter((mark) => mark.pageNumber === pageNumber && mark.createdAtMs >= earliest && mark.createdAtMs <= voiceWindow.endMs)
    .sort((left, right) => right.createdAtMs - left.createdAtMs)[0]
}
