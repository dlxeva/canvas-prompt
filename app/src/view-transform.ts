/**
 * Viewport movement is not canvas geometry.  Keep it in its own evidence
 * channel so later consumers can say that the user looked somewhere without
 * pretending that zoom or pan proves importance.
 */
export interface ViewStateSample {
  timestamp_ms: number
  zoom: number
  scroll_x: number
  scroll_y: number
}

export interface ViewTransformation {
  observation_id: string
  type: 'view_transform'
  time_range_ms: [number, number]
  kind: 'zoom' | 'pan' | 'zoom_pan'
  before: ViewStateSample
  after: ViewStateSample
  sample_count: number
  coordinate_space: 'viewport_transform'
  assertion_level: 'observation'
  interpretation_constraint: 'does_not_establish_attention_or_priority'
}

const SESSION_GAP_MS = 1_500
const MIN_CAPTURE_SCROLL_DELTA = 2
const MIN_CAPTURE_ZOOM_DELTA = 0.002
const MIN_REPORTED_SCROLL_DELTA = 16
const MIN_REPORTED_ZOOM_DELTA = 0.01

function changedBy(
  before: ViewStateSample,
  after: ViewStateSample,
  scrollThreshold: number,
  zoomThreshold: number,
) {
  return Math.abs(before.zoom - after.zoom) >= zoomThreshold
    || Math.abs(before.scroll_x - after.scroll_x) >= scrollThreshold
    || Math.abs(before.scroll_y - after.scroll_y) >= scrollThreshold
}

function materiallyChanged(before: ViewStateSample, after: ViewStateSample) {
  return changedBy(before, after, MIN_REPORTED_SCROLL_DELTA, MIN_REPORTED_ZOOM_DELTA)
}

function captureChanged(before: ViewStateSample, after: ViewStateSample) {
  return changedBy(before, after, MIN_CAPTURE_SCROLL_DELTA, MIN_CAPTURE_ZOOM_DELTA)
}

function kindFor(before: ViewStateSample, after: ViewStateSample): ViewTransformation['kind'] {
  const zoom = Math.abs(before.zoom - after.zoom) >= MIN_REPORTED_ZOOM_DELTA
  const pan = Math.abs(before.scroll_x - after.scroll_x) >= MIN_REPORTED_SCROLL_DELTA
    || Math.abs(before.scroll_y - after.scroll_y) >= MIN_REPORTED_SCROLL_DELTA
  return zoom && pan ? 'zoom_pan' : zoom ? 'zoom' : 'pan'
}

/** Coalesce a physical gesture's many app-state updates into one observation. */
export function appendViewTransformation(
  observations: ViewTransformation[],
  before: ViewStateSample,
  after: ViewStateSample,
): ViewTransformation[] {
  if (!captureChanged(before, after)) return observations
  const last = observations.at(-1)
  if (last && after.timestamp_ms - last.time_range_ms[1] <= SESSION_GAP_MS) {
    if (!materiallyChanged(last.before, after)) return observations.slice(0, -1)
    const merged: ViewTransformation = {
      ...last,
      time_range_ms: [last.time_range_ms[0], after.timestamp_ms],
      after,
      sample_count: last.sample_count + 1,
      kind: kindFor(last.before, after),
    }
    return [...observations.slice(0, -1), merged]
  }
  if (!materiallyChanged(before, after)) return observations
  return [...observations, {
    observation_id: `view_transform_${String(observations.length + 1).padStart(3, '0')}`,
    type: 'view_transform',
    time_range_ms: [before.timestamp_ms, after.timestamp_ms],
    kind: kindFor(before, after),
    before,
    after,
    sample_count: 1,
    coordinate_space: 'viewport_transform',
    assertion_level: 'observation',
    interpretation_constraint: 'does_not_establish_attention_or_priority',
  }]
}
