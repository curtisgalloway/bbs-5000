// SPDX-FileCopyrightText: 2026 Curtis Galloway
// SPDX-License-Identifier: Apache-2.0

/**
 * A tiny JSONC reader: removes `//` and `/* *\/` comments (and trailing
 * commas) outside strings, then parses. Enough for `wrangler.jsonc`; it exists
 * so the generated deploy config is built from the checked-in one and cannot
 * drift from it.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated block comment in JSONC");
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // A comma directly before `}` or `]` (outside strings; strings were copied whole above,
  // so scan again with the same string rule).
  let clean = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k] as string;
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(k, j + 1);
      k = j;
    } else if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j] as string)) j++;
      if (out[j] !== "}" && out[j] !== "]") clean += c;
    } else {
      clean += c;
    }
  }
  return clean;
}

export function parseJsonc(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stripJsonc(text));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSONC config is not an object");
  }
  return value as Record<string, unknown>;
}
