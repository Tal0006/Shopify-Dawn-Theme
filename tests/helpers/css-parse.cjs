// Minimal CSS parser for build/test tooling (no dependencies). Returns a tree of
// {type: 'rule', selector, body, start, end} and {type: 'at', name, prelude, children|body, start, end},
// with source offsets so callers can cut or keep exact source text. Comments and strings are respected.
function parse(css, from = 0, to = css.length) {
  const nodes = [];
  let i = from, start = from;
  const skipWs = () => {
    for (;;) {
      while (i < to && /\s/.test(css[i])) i++;
      if (css.startsWith('/*', i)) { const e = css.indexOf('*/', i + 2); i = e < 0 ? to : e + 2; continue; }
      break;
    }
  };
  // Index of the matching close brace for the open brace at `open`.
  const matchBrace = open => {
    let depth = 0;
    for (let j = open; j < to; j++) {
      const c = css[j];
      if (c === '"' || c === "'") { j++; while (j < to && css[j] !== c) { if (css[j] === '\\') j++; j++; } continue; }
      if (c === '/' && css[j + 1] === '*') { const e = css.indexOf('*/', j + 2); j = e < 0 ? to : e + 1; continue; }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return j;
    }
    throw new Error('Unbalanced braces at ' + open);
  };
  // Next top-level occurrence of any char in `chars`, skipping strings, comments and brackets.
  const scanTo = chars => {
    let paren = 0;
    for (let j = i; j < to; j++) {
      const c = css[j];
      if (c === '"' || c === "'") { j++; while (j < to && css[j] !== c) { if (css[j] === '\\') j++; j++; } continue; }
      if (c === '/' && css[j + 1] === '*') { const e = css.indexOf('*/', j + 2); j = e < 0 ? to : e + 1; continue; }
      if (c === '(' || c === '[') paren++;
      else if (c === ')' || c === ']') paren--;
      else if (!paren && chars.includes(c)) return j;
    }
    return to;
  };
  for (;;) {
    skipWs();
    if (i >= to) break;
    start = i;
    if (css[i] === '@') {
      const stop = scanTo('{;');
      const head = css.slice(i, stop).trim();
      const name = head.match(/^@([\w-]+)/)[1].toLowerCase();
      const prelude = head.slice(name.length + 1).trim();
      if (stop >= to || css[stop] === ';') { nodes.push({type: 'at', name, prelude, start, end: stop + 1}); i = stop + 1; continue; }
      const close = matchBrace(stop);
      const node = {type: 'at', name, prelude, start, end: close + 1, bodyStart: stop + 1, bodyEnd: close};
      if (['media', 'supports', 'layer', 'container', 'document'].includes(name)) node.children = parse(css, stop + 1, close);
      else node.body = css.slice(stop + 1, close);
      nodes.push(node);
      i = close + 1;
      continue;
    }
    const open = scanTo('{');
    if (open >= to) break;
    const close = matchBrace(open);
    nodes.push({type: 'rule', selector: css.slice(i, open).trim(), body: css.slice(open + 1, close), start, end: close + 1});
    i = close + 1;
  }
  return nodes;
}

// Splits a selector list on top-level commas.
function splitSelectors(list) {
  const out = []; let depth = 0, cur = '';
  for (let j = 0; j < list.length; j++) {
    const c = list[j];
    if (c === '"' || c === "'") { const e = list.indexOf(c, j + 1); cur += list.slice(j, e + 1); j = e; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (c === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

module.exports = {parse, splitSelectors};
