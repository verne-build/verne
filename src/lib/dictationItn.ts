// Lightweight inverse text normalization for dictation.
//
// This module intentionally handles the STT-specific forms that generic
// words-to-number libraries usually miss:
// - digit sequences: "one two seven" -> 127
// - shorthand hundreds: "three fifty" -> 350
// - dotted identifiers/IPs split across final segments: "one two seven dot" -> 127.
// - spoken zero variants inside numbers: "one oh one" -> 101

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0,
  oh: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const SCALES: Record<string, number> = {
  thousand: 1000,
  million: 1_000_000,
  billion: 1_000_000_000,
};

const CONNECTOR_WORDS = new Set(["and"]);
const DECIMAL_WORDS = new Set(["point"]);

const NUMBER_WORDS = [
  ...Object.keys(SMALL_NUMBERS),
  ...Object.keys(TENS),
  "hundred",
  ...Object.keys(SCALES),
];

// Longest-first so "fourteen" is matched before "four".
const NUMBER_WORD_ALT = NUMBER_WORDS.slice().sort((a, b) => b.length - a.length).join("|");

// A number run starts with a number word, then continues with more number
// words, optionally joined by "and" or "point". "dot" is handled after number
// runs so developer terms like "node dot js" stay available to the dictionary.
const NUMBER_RUN_RE = new RegExp(
  `\\b(?:${NUMBER_WORD_ALT})(?:[\\s-]+(?:(?:and|point)[\\s-]+)?(?:${NUMBER_WORD_ALT}))*\\b`,
  "gi",
);

type NumberToken =
  | { kind: "small"; word: string; value: number }
  | { kind: "tens"; word: string; value: number }
  | { kind: "hundred"; word: "hundred" }
  | { kind: "scale"; word: string; value: number }
  | { kind: "connector"; word: "and" }
  | { kind: "decimal"; word: "point" };

function tokenizeNumberRun(phrase: string): NumberToken[] {
  return phrase
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word): NumberToken | null => {
      if (word in SMALL_NUMBERS) return { kind: "small", word, value: SMALL_NUMBERS[word] };
      if (word in TENS) return { kind: "tens", word, value: TENS[word] };
      if (word === "hundred") return { kind: "hundred", word };
      if (word in SCALES) return { kind: "scale", word, value: SCALES[word] };
      if (CONNECTOR_WORDS.has(word)) return { kind: "connector", word: "and" };
      if (DECIMAL_WORDS.has(word)) return { kind: "decimal", word: "point" };
      return null;
    })
    .filter((token): token is NumberToken => token !== null);
}

function hasScaleToken(tokens: NumberToken[]): boolean {
  return tokens.some((token) => token.kind === "hundred" || token.kind === "scale");
}

function stripConnectors(tokens: NumberToken[]): NumberToken[] {
  return tokens.filter((token) => token.kind !== "connector");
}

function parseCardinalInteger(tokens: NumberToken[]): number {
  let result = 0;
  let current = 0;

  for (const token of tokens) {
    if (token.kind === "connector") continue;
    if (token.kind === "small" || token.kind === "tens") {
      current += token.value;
    } else if (token.kind === "hundred") {
      current = (current || 1) * 100;
    } else if (token.kind === "scale") {
      result += (current || 1) * token.value;
      current = 0;
    }
  }

  return result + current;
}

// Scale-free parse: group into <100 chunks and concatenate their digits.
function parseDigitSequence(tokens: NumberToken[]): string {
  const chunks: number[] = [];
  let value: number | null = null;
  let hasTens = false;
  let hasOnes = false;

  const flush = (): void => {
    if (value !== null) chunks.push(value);
    value = null;
    hasTens = false;
    hasOnes = false;
  };

  for (const token of tokens) {
    if (token.kind === "connector") continue;
    if (token.kind === "tens") {
      flush();
      value = token.value;
      hasTens = true;
    } else if (token.kind === "small") {
      if (value === null) {
        value = token.value;
        hasOnes = true;
      } else if (hasTens && !hasOnes && token.value >= 1 && token.value <= 9) {
        value += token.value;
        hasOnes = true;
      } else {
        flush();
        value = token.value;
        hasOnes = true;
      }
    }
  }

  flush();
  return chunks.map(String).join("");
}

function findHundredShorthandSplit(tokens: NumberToken[]): number {
  if (tokens.some((token) => token.kind === "scale")) return -1;
  const hundredIdx = tokens.findIndex((token) => token.kind === "hundred");
  if (hundredIdx === -1) return -1;
  const zeroIdx = tokens.findIndex(
    (token, idx) => idx > hundredIdx && token.kind === "small" && token.value === 0,
  );
  return zeroIdx === -1 ? -1 : zeroIdx;
}

function parseIntegerPart(tokens: NumberToken[]): string {
  const clean = stripConnectors(tokens);
  if (!clean.length) return "0";
  if (!hasScaleToken(clean)) return parseDigitSequence(clean);

  const sequenceSplit = findHundredShorthandSplit(clean);
  if (sequenceSplit !== -1) {
    return `${parseCardinalInteger(clean.slice(0, sequenceSplit))}${parseDigitSequence(clean.slice(sequenceSplit))}`;
  }

  return String(parseCardinalInteger(clean));
}

function parseNumberRun(phrase: string): string {
  const tokens = tokenizeNumberRun(phrase);
  if (tokens.length === 1 && tokens[0].kind === "small" && tokens[0].word === "oh") {
    return phrase;
  }

  const decimalIdx = tokens.findIndex((token) => token.kind === "decimal");
  if (decimalIdx !== -1) {
    const intStr = parseIntegerPart(tokens.slice(0, decimalIdx));
    const frac = parseDigitSequence(tokens.slice(decimalIdx + 1));
    return frac ? `${intStr}.${frac}` : intStr;
  }

  return parseIntegerPart(tokens);
}

function isFollowedByDottedIdentifier(match: string, offset: number, whole: string): boolean {
  return /^\.[A-Za-z]/.test(whole.slice(offset + match.length));
}

function normalizeSpokenDotSeparators(text: string): string {
  return text
    .replace(/(\d)\s+dot\s+(?=\d)/gi, "$1.")
    .replace(/(\d)\s+dot\s*$/i, "$1.");
}

export function inverseNormalizeDictationNumbers(text: string): string {
  const withNumberRuns = text.replace(NUMBER_RUN_RE, (match, offset, whole) => {
    if (isFollowedByDottedIdentifier(match, offset, whole)) return match;
    return parseNumberRun(match);
  });

  return normalizeSpokenDotSeparators(withNumberRuns);
}
