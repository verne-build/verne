import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { ModelManager } from './model-manager'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/verne-speech-models-test'
  }
}))

type ModelManagerInternals = {
  updateState: (
    modelId: string,
    status: 'not-downloaded' | 'downloading' | 'extracting' | 'ready' | 'error',
    progress?: number,
    error?: string
  ) => void
}

describe('ModelManager progress callbacks', () => {
  it('unsubscribes progress callbacks without replacing other listeners', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verne-model-manager-'))
    try {
      const manager = new ModelManager(dir)
      const internals = manager as unknown as ModelManagerInternals
      const first = vi.fn()
      const second = vi.fn()
      const clearFirst = manager.setProgressCallback(first)
      const clearSecond = manager.setProgressCallback(second)

      internals.updateState('model-a', 'downloading', 0.25)
      clearFirst()
      internals.updateState('model-a', 'extracting')
      clearSecond()
      internals.updateState('model-a', 'ready')

      expect(first).toHaveBeenCalledTimes(1)
      expect(first).toHaveBeenCalledWith({
        id: 'model-a',
        status: 'downloading',
        progress: 0.25,
        error: undefined
      })
      expect(second).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenNthCalledWith(1, {
        id: 'model-a',
        status: 'downloading',
        progress: 0.25,
        error: undefined
      })
      expect(second).toHaveBeenNthCalledWith(2, {
        id: 'model-a',
        status: 'extracting',
        progress: 0.95,
        error: undefined
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
