/**
 * Minimal YAML subset parser (no dependencies). Supported:
 *  - block mappings (`key: value`) and block sequences (`- item`), nested by indentation (spaces only)
 *  - sequences of mappings (`- id: x\n  name: y`)
 *  - flow sequences of scalars (`[a, "b c", 3]`) and flow mappings of scalars (`{ env: KEY }`)
 *  - scalars: plain, 'single' / "double" quoted, numbers, true/false, null/~
 *  - `#` comments (outside quotes), blank lines
 * Not supported (throws or treats as plain text): anchors, tags, multi-line block scalars (| >), multi-docs.
 * Config files are small and hand-written; this is enough and keeps the core dependency-free.
 */

export type YamlValue = null | boolean | number | string | YamlValue[] | { [k: string]: YamlValue };

interface Line { indent: number; text: string; no: number }

function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"') { cur += s[++i] ?? ''; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Find the `: ` separator of a mapping entry outside quotes; -1 if none */
function mapColon(s: string): number {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && i === 0) { q = c; continue; }
    if (c === ':' && (i === s.length - 1 || s[i + 1] === ' ')) return i;
  }
  return -1;
}

export function parseScalar(raw: string): YamlValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) return splitFlow(s.slice(1, -1)).map(parseScalar);
  if (s.startsWith('{') && s.endsWith('}')) {
    const o: Record<string, YamlValue> = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = mapColon(part);
      if (i < 0) throw new Error(`YAML: bad flow mapping entry: ${part}`);
      o[unquote(part.slice(0, i).trim())] = parseScalar(part.slice(i + 1));
    }
    return o;
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return JSON.parse(s.replace(/\t/g, '\\t')) as string;
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function unquote(k: string): string {
  const v = parseScalar(k);
  return typeof v === 'string' ? v : String(v);
}

export function parseYaml(src: string): YamlValue {
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((l, i) => {
    if (/^\s*#/.test(l) || !l.trim()) return;
    if (/^\t/.test(l)) throw new Error(`YAML line ${i + 1}: tabs are not allowed for indentation`);
    const text = stripComment(l).trimEnd();
    if (!text.trim()) return;
    lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), no: i + 1 });
  });
  let pos = 0;

  function parseBlock(): YamlValue {
    if (pos >= lines.length) return null;
    const first = lines[pos];
    if (first.text.startsWith('- ') || first.text === '-') return parseSeq(first.indent);
    return parseMap(first.indent);
  }

  function parseSeq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const ln = lines[pos];
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trim();
      if (!rest) {
        pos++;
        out.push(pos < lines.length && lines[pos].indent > indent ? parseBlock() : null);
        continue;
      }
      if (mapColon(rest) > 0 && !rest.startsWith('[') && !rest.startsWith('{')) {
        // "- key: value" starts an inline mapping whose further keys are indented to the key column
        const childIndent = indent + (ln.text.length - rest.length);
        lines[pos] = { indent: childIndent, text: rest, no: ln.no };
        out.push(parseMap(childIndent));
        continue;
      }
      pos++;
      out.push(parseScalar(rest));
    }
    return out;
  }

  function parseMap(indent: number): Record<string, YamlValue> {
    const out: Record<string, YamlValue> = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const ln = lines[pos];
      if (ln.text.startsWith('- ')) break;
      const i = mapColon(ln.text);
      if (i <= 0) throw new Error(`YAML line ${ln.no}: expected "key: value", got: ${ln.text}`);
      const key = unquote(ln.text.slice(0, i).trim());
      const rest = ln.text.slice(i + 1).trim();
      pos++;
      if (rest) out[key] = parseScalar(rest);
      else if (pos < lines.length && lines[pos].indent > indent) out[key] = parseBlock();
      else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) out[key] = parseSeq(indent);
      else out[key] = null;
    }
    if (pos < lines.length && lines[pos].indent > indent) throw new Error(`YAML line ${lines[pos].no}: unexpected indentation`);
    return out;
  }

  const v = parseBlock();
  if (pos < lines.length) throw new Error(`YAML line ${lines[pos].no}: could not parse: ${lines[pos].text}`);
  return v;
}
