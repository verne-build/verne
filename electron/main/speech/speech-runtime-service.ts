import { ModelManager } from "./model-manager";
import { SttService } from "./stt-service";

let modelManager: ModelManager | null = null;
let sttService: SttService | null = null;

export function getSpeechModelManager(): ModelManager {
  if (!modelManager) modelManager = new ModelManager();
  return modelManager;
}

export function getSpeechSttService(): SttService {
  if (!sttService) sttService = new SttService(getSpeechModelManager());
  return sttService;
}
