import { inverseNormalizeDictationNumbers } from "./dictationItn";

export function convertSpokenNumbers(text: string): string {
  return inverseNormalizeDictationNumbers(text);
}
