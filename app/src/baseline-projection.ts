type ElementLike = { id: string; isDeleted?: boolean }
type TraceLike = { kind: string; element: { id: string } }

/**
 * A round has two different projections:
 *
 * - the process projection contains only evidence created or changed in this
 *   round; and
 * - the final snapshot is the user-visible canvas state at the end of it.
 *
 * Never use the process projection to render the final snapshot. Doing so
 * drops the existing diagram when a person annotates a prior round.
 */
export function projectFinalSnapshotElements<T extends ElementLike>(elements: readonly T[]) {
  return elements.filter((element) => !element.isDeleted)
}

/**
 * The baseline declaration describes what existed when a round began; its
 * included count must describe what survives in the exported round. Never
 * let a deleted background image remain in evidence merely because it was a
 * baseline image at timestamp zero.
 */
export function projectLiveRoundElementIds(
  elements: readonly ElementLike[],
  trace: readonly TraceLike[],
  baselineImageIds: ReadonlySet<string>,
) {
  const liveIds = new Set(elements.filter((element) => !element.isDeleted).map((element) => element.id))
  const includedIds = new Set(trace
    .filter((event) => event.kind !== 'delete' && liveIds.has(event.element.id))
    .map((event) => event.element.id))
  for (const id of baselineImageIds) {
    if (liveIds.has(id)) includedIds.add(id)
  }
  return includedIds
}

export function countIncludedBaselineObjects(baselineObjectIds: ReadonlySet<string>, exportedIds: ReadonlySet<string>) {
  return [...baselineObjectIds].filter((id) => exportedIds.has(id)).length
}
