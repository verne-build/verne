import { describe, expect, it } from 'vitest'
import {
  attachSpokenDotToPreviousNumber,
  formatFinalTranscriptSegment,
  isDuplicateFinalTranscriptSegment,
} from './dictationFinalSegments'

describe('formatFinalTranscriptSegment', () => {
  it('adds a boundary between word-like streaming final segments', () => {
    expect(formatFinalTranscriptSegment('world', 'hello')).toBe(' world')
  })

  it('adds a boundary after sentence and phrase punctuation', () => {
    expect(formatFinalTranscriptSegment('World', 'Hello.')).toBe(' World')
    expect(formatFinalTranscriptSegment('world', 'hello,')).toBe(' world')
  })

  it('does not add a boundary before punctuation', () => {
    expect(formatFinalTranscriptSegment('.', 'hello')).toBe('.')
  })

  it('does not add a boundary around CJK final segments', () => {
    expect(formatFinalTranscriptSegment('世界', '你好')).toBe('世界')
  })

  it('does not add a boundary inside dotted number segments', () => {
    expect(formatFinalTranscriptSegment('127', '127.')).toBe('127')
  })

  it('detects repeated final transcripts with whitespace differences', () => {
    expect(isDuplicateFinalTranscriptSegment('hello world', 'hello world')).toBe(true)
    expect(isDuplicateFinalTranscriptSegment(' hello   world ', 'hello world')).toBe(true)
    expect(isDuplicateFinalTranscriptSegment('hello again', 'hello world')).toBe(false)
  })

  it('attaches spoken dot segments after an inserted number', () => {
    expect(attachSpokenDotToPreviousNumber('dot 127', '127')).toBe('.127')
    expect(attachSpokenDotToPreviousNumber('point 127', '127')).toBe('.127')
    expect(attachSpokenDotToPreviousNumber('dot 127', 'hello')).toBe('dot 127')
  })
})
