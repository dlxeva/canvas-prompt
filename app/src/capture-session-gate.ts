import type { Locale } from './locale'

export type CaptureWorkspace = 'canvas' | 'artifact-review'

export function captureSwitchBlockMessage(workspace: CaptureWorkspace, busy: boolean, locale: Locale): string | null {
  if (!busy) return null
  if (locale === 'zh') {
    return workspace === 'canvas'
      ? '当前自由推演仍在记录或整理，请先结束本轮，再进入交互审阅。'
      : '当前交互审阅仍在记录或整理，请先结束本轮，再返回自由推演。'
  }
  return workspace === 'canvas'
    ? 'Freeform is still recording or finalizing. Finish this round before opening Interactive Review.'
    : 'Interactive Review is still recording or finalizing. Finish this round before returning to Freeform.'
}
