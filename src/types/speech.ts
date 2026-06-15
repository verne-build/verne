// Renderer-side mirror of electron/main/speech/speech-types.ts (the catalog and
// model-state shapes the speech IPC returns). Kept standalone so the renderer
// tsconfig doesn't reach across into the main-process source tree.

export type SpeechModelType = "transducer" | "paraformer" | "whisper";
export type ModelingUnit = "bpe" | "cjkchar" | "cjkchar+bpe";

export interface SpeechModelManifest {
  id: string;
  label: string;
  description: string;
  type: SpeechModelType;
  language: string;
  sizeBytes: number;
  downloadUrl: string;
  archiveSha256: string;
  archiveFormat: "tar.bz2";
  files: string[];
  sampleRate: number;
  streaming: boolean;
  modelingUnit?: ModelingUnit;
  recommended?: boolean;
}

export type SpeechModelStatus =
  | "not-downloaded"
  | "downloading"
  | "extracting"
  | "ready"
  | "error";

export interface SpeechModelState {
  id: string;
  status: SpeechModelStatus;
  progress?: number;
  error?: string;
}
