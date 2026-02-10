/**
 * Robust JSON extraction and repair for LLM outputs.
 *
 * Many local/open LLMs occasionally:
 * - wrap JSON in markdown fences
 * - include <think> blocks
 * - omit commas / add trailing commas
 * - double-encode JSON as a JSON string
 * - emit invalid backslash escapes
 *
 * This helper extracts the first JSON object/array from text and applies small repairs
 * before parsing.
 */

export function extractJsonFromText(text: string): unknown {
  function escapeInvalidBackslashesInStrings(input: string): string {
    let out = '';
    let inString = false;
    let stringChar = '"';

    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (!inString) {
        if (ch === '"' || ch === "'") {
          inString = true;
          stringChar = ch;
        }
        out += ch;
        continue;
      }

      if (ch === stringChar) {
        const prev = i > 0 ? input[i - 1] : '';
        if (prev !== '\\') inString = false;
        out += ch;
        continue;
      }

      if (ch === '\\') {
        const next = i + 1 < input.length ? input[i + 1] : '';
        const isValidEscape = next && '"\\/bfnrtu'.includes(next);
        if (isValidEscape) {
          out += '\\' + next;
          i++;
        } else {
          out += '\\\\';
        }
        continue;
      }

      out += ch;
    }

    return out;
  }

  function repairJsonCandidate(candidate: string): string {
    let out = candidate.trim();

    // Strip any remaining markdown fences / think blocks.
    out = out
      .replace(/```json/gi, '```')
      .replace(/```/g, '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .trim();

    // Common LLM glitch: array items become ",{" instead of ,{
    out = out.replace(/,\s*"\s*\{/g, ', {');

    // Common LLM glitch: missing commas between array/object items: `}{` or `][`.
    // Insert commas only outside of strings.
    const insertMissingCommasOutsideStrings = (input: string): string => {
      let out = '';
      let inString = false;
      let stringChar = '"';
      let backslashRun = 0;

      for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        out += ch;

        if (inString) {
          if (ch === '\\') {
            backslashRun++;
            continue;
          }
          if (ch === stringChar && backslashRun % 2 === 0) {
            inString = false;
          }
          backslashRun = 0;
          continue;
        }

        if (ch === '"' || ch === "'") {
          inString = true;
          stringChar = ch;
          backslashRun = 0;
          continue;
        }

        if (ch === '}' || ch === ']') {
          let j = i + 1;
          while (j < input.length && /\s/.test(input[j])) j++;
          const next = j < input.length ? input[j] : '';
          if (next === '{' || next === '[') {
            out += ',';
          }
        }
      }
      return out;
    };

    out = insertMissingCommasOutsideStrings(out);

    // Common LLM glitch: trailing comma before close.
    out = out.replace(/,\s*([}\]])/g, '$1');

    // Common LLM glitch: stray quote after numbers/bools/null, e.g. 50" or 50\" before } or ,.
    // IMPORTANT: only apply this outside strings; otherwise it can corrupt valid JSON strings.
    const removeStrayQuotesAfterScalarsOutsideStrings = (input: string): string => {
      let out = '';
      let inString = false;
      let stringChar = '"';
      let backslashRun = 0;

      const isDelimiterOrEofAhead = (idx: number): boolean => {
        let j = idx;
        while (j < input.length && /\s/.test(input[j])) j++;
        const next = j < input.length ? input[j] : '';
        return next === '' || next === ',' || next === '}' || next === ']';
      };

      const isScalarToken = (token: string): boolean => {
        if (!token) return false;
        if (/^(?:true|false|null)$/i.test(token)) return true;
        return /^-?\d+(?:\.\d+)?$/.test(token);
      };

      for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inString) {
          out += ch;
          if (ch === '\\') {
            backslashRun++;
            continue;
          }
          if (ch === stringChar && backslashRun % 2 === 0) {
            inString = false;
          }
          backslashRun = 0;
          continue;
        }

        if (ch === '"' || ch === "'") {
          // If this quote is immediately followed by a delimiter/EOF, it cannot start a valid JSON string.
          // In that case, treat it as a potential stray quote after a scalar token and drop it.
          if (ch === '"' && isDelimiterOrEofAhead(i + 1)) {
            let k = i - 1;
            while (k >= 0 && /\s/.test(input[k])) k--;
            const hasBackslash = k >= 0 && input[k] === '\\';
            if (hasBackslash) {
              if (out.endsWith('\\')) out = out.slice(0, -1);
              k--;
              while (k >= 0 && /\s/.test(input[k])) k--;
            }

            let start = k;
            while (start >= 0 && /[A-Za-z0-9.-]/.test(input[start])) start--;
            const token = input.slice(start + 1, k + 1);
            if (isScalarToken(token)) {
              continue;
            }
          }

          inString = true;
          stringChar = ch;
          backslashRun = 0;
          out += ch;
          continue;
        }

        out += ch;
      }

      return out;
    };

    out = removeStrayQuotesAfterScalarsOutsideStrings(out);

    // Remove a trailing stray quote after a closer, e.g. `}"`
    const removeStrayQuotesAfterClosersOutsideStrings = (input: string): string => {
      let out = '';
      let inString = false;
      let stringChar = '"';
      let backslashRun = 0;

      const isDelimiterOrEofAhead = (idx: number): boolean => {
        let j = idx;
        while (j < input.length && /\s/.test(input[j])) j++;
        const next = j < input.length ? input[j] : '';
        return next === '' || next === ',' || next === '}' || next === ']';
      };

      for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (inString) {
          out += ch;
          if (ch === '\\') {
            backslashRun++;
            continue;
          }
          if (ch === stringChar && backslashRun % 2 === 0) {
            inString = false;
          }
          backslashRun = 0;
          continue;
        }

        if (ch === '"' || ch === "'") {
          if (ch === '"' && isDelimiterOrEofAhead(i + 1)) {
            let k = i - 1;
            while (k >= 0 && /\s/.test(input[k])) k--;
            const hasBackslash = k >= 0 && input[k] === '\\';
            if (hasBackslash) {
              if (out.endsWith('\\')) out = out.slice(0, -1);
              k--;
              while (k >= 0 && /\s/.test(input[k])) k--;
            }
            const prev = k >= 0 ? input[k] : '';
            if (prev === '}' || prev === ']') {
              continue;
            }
          }

          inString = true;
          stringChar = ch;
          backslashRun = 0;
          out += ch;
          continue;
        }

        out += ch;
      }

      return out;
    };

    out = removeStrayQuotesAfterClosersOutsideStrings(out);
    out = escapeInvalidBackslashesInStrings(out);
    return out.trim();
  }

  function parsePossiblyDoubleEncoded(candidate: string): unknown {
    let parsed: unknown = JSON.parse(repairJsonCandidate(candidate));

    // Some local models double-encode JSON and return it as a JSON string, e.g. "\"{...}\"".
    // Attempt to parse again if it looks like an object/array payload.
    for (let depth = 0; depth < 2; depth++) {
      if (typeof parsed !== 'string') break;
      const t = parsed
        .trim()
        .replace(/```json/gi, '```')
        .replace(/```/g, '')
        .trim();
      if (!(t.startsWith('{') || t.startsWith('['))) break;
      try {
        parsed = JSON.parse(repairJsonCandidate(t));
      } catch {
        break;
      }
    }

    return parsed;
  }

  const cleaned = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json/gi, '```')
    .replace(/```/g, '')
    .replace(/<\|[^|]*\|>/g, ' ')
    .replace(/<\|[^>]*\|>/g, ' ')
    .trim();

  // Try parse whole string first.
  try {
    return parsePossiblyDoubleEncoded(cleaned);
  } catch {
    // Try to find the first JSON object/array substring.
    const firstBrace = cleaned.indexOf('{');
    const firstBracket = cleaned.indexOf('[');
    const start =
      firstBrace === -1
        ? firstBracket
        : firstBracket === -1
          ? firstBrace
          : Math.min(firstBrace, firstBracket);
    if (start === -1) throw new Error('No JSON found in LLM response');

    const slice = cleaned.slice(start);

    // Heuristic: find last matching brace/bracket by scanning.
    let depth = 0;
    const stack: Array<'{' | '['> = [];
    let inString = false;
    let stringChar = '';
    for (let i = 0; i < slice.length; i++) {
      const ch = slice[i];
      const prev = i > 0 ? slice[i - 1] : '';
      if (inString) {
        if (ch === stringChar && prev !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '{' || ch === '[') {
        depth++;
        stack.push(ch as '{' | '[');
      }
      if (ch === '}' || ch === ']') {
        depth--;
        if (stack.length) stack.pop();
      }
      if (depth === 0) {
        const candidate = repairJsonCandidate(slice.slice(0, i + 1));
        return parsePossiblyDoubleEncoded(candidate);
      }
    }

    // If the model returned truncated JSON, attempt to close any open structures.
    if (depth > 0 && stack.length) {
      let candidate = slice;
      if (inString && stringChar) candidate += stringChar;
      for (let i = stack.length - 1; i >= 0; i--) {
        candidate += stack[i] === '{' ? '}' : ']';
      }
      return parsePossiblyDoubleEncoded(repairJsonCandidate(candidate));
    }

    throw new Error('Truncated JSON in LLM response');
  }
}
