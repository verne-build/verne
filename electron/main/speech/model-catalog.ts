import type { SpeechModelManifest } from './speech-types'

export const SPEECH_MODEL_CATALOG: SpeechModelManifest[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet TDT v3',
    description:
      'Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.',
    type: 'transducer',
    language: 'multilingual',
    sizeBytes: 180_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2',
    archiveSha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: false,
    modelingUnit: 'bpe'
  },
  {
    id: 'parakeet-tdt-0.6b-v2-int8',
    label: 'Parakeet TDT v2',
    description:
      'English only. Faster than v3 with similar accuracy. Punctuation and capitalization.',
    type: 'transducer',
    language: 'en',
    sizeBytes: 170_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    archiveSha256: '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: false,
    modelingUnit: 'bpe'
  },
  {
    id: 'paraformer-bilingual-zh-en',
    label: 'Paraformer Bilingual',
    description:
      'Chinese (Mandarin + dialects) + English. Strong on accented and regional Chinese.',
    type: 'paraformer',
    language: 'zh-en',
    sizeBytes: 115_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2',
    archiveSha256: '5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f',
    archiveFormat: 'tar.bz2',
    files: ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt'],
    sampleRate: 16000,
    streaming: true
  },
  {
    id: 'whisper-tiny',
    label: 'Whisper Tiny',
    description: '90+ languages. Lower accuracy than Parakeet but broadest language coverage.',
    type: 'whisper',
    language: 'multilingual',
    sizeBytes: 116_000_000,
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.tar.bz2',
    archiveSha256: 'c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1',
    archiveFormat: 'tar.bz2',
    files: ['tiny-encoder.onnx', 'tiny-decoder.onnx', 'tiny-tokens.txt'],
    sampleRate: 16000,
    streaming: false
  }
]

export function getCatalogModel(id: string): SpeechModelManifest | undefined {
  return SPEECH_MODEL_CATALOG.find((m) => m.id === id)
}
