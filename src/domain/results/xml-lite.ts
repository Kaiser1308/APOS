/** A just-enough XML reader for JUnit reports: elements, attributes, text, CDATA, comments, entities. */
export type XmlElement = { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string };

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

const NAME = /^[A-Za-z_][\w.:-]*/;

/** Parses one document and returns its root element; throws an Error with a short reason when malformed. */
export function parseXml(source: string): XmlElement {
  const input = source.replace(/^﻿/, '');
  let pos = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const fail = (reason: string): never => {
    throw new Error(`${reason} at offset ${pos}`);
  };
  const addText = (text: string) => {
    const top = stack.at(-1);
    if (top) top.text += text;
    else if (text.trim()) fail('text outside the root element');
  };
  while (pos < input.length) {
    const lt = input.indexOf('<', pos);
    if (lt === -1) {
      addText(decodeEntities(input.slice(pos)));
      pos = input.length;
      break;
    }
    if (lt > pos) addText(decodeEntities(input.slice(pos, lt)));
    pos = lt;
    if (input.startsWith('<!--', pos)) {
      const end = input.indexOf('-->', pos + 4);
      if (end === -1) fail('unterminated comment');
      pos = end + 3;
    } else if (input.startsWith('<![CDATA[', pos)) {
      const end = input.indexOf(']]>', pos + 9);
      if (end === -1) fail('unterminated CDATA');
      addText(input.slice(pos + 9, end));
      pos = end + 3;
    } else if (input.startsWith('<?', pos)) {
      const end = input.indexOf('?>', pos + 2);
      if (end === -1) fail('unterminated processing instruction');
      pos = end + 2;
    } else if (input.startsWith('<!', pos)) {
      const end = input.indexOf('>', pos + 2);
      if (end === -1) fail('unterminated declaration');
      pos = end + 1;
    } else if (input.startsWith('</', pos)) {
      const end = input.indexOf('>', pos);
      if (end === -1) fail('unterminated closing tag');
      const name = input.slice(pos + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name)
        fail(`closing tag </${name}> does not match ${open ? `<${open.name}>` : 'anything'}`);
      pos = end + 1;
    } else {
      pos += 1;
      const name = NAME.exec(input.slice(pos))?.[0];
      if (!name) return fail('bad tag name');
      pos += name.length;
      const element: XmlElement = { name, attrs: {}, children: [], text: '' };
      for (;;) {
        while (/\s/.test(input[pos] ?? '')) pos += 1;
        if (pos >= input.length) fail('unterminated tag');
        if (input[pos] === '>' || input.startsWith('/>', pos)) break;
        const attr = NAME.exec(input.slice(pos))?.[0];
        if (!attr) return fail('bad attribute');
        pos += attr.length;
        while (/\s/.test(input[pos] ?? '')) pos += 1;
        if (input[pos] !== '=') fail(`attribute ${attr} has no value`);
        pos += 1;
        while (/\s/.test(input[pos] ?? '')) pos += 1;
        const quote = input[pos];
        if (quote !== '"' && quote !== "'") fail(`attribute ${attr} is not quoted`);
        const close = input.indexOf(quote!, pos + 1);
        if (close === -1) fail('unterminated attribute value');
        element.attrs[attr] = decodeEntities(input.slice(pos + 1, close));
        pos = close + 1;
      }
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root) fail('more than one root element');
      else root = element;
      if (input.startsWith('/>', pos)) pos += 2;
      else {
        pos += 1;
        stack.push(element);
      }
    }
  }
  if (stack.length) fail(`<${stack.at(-1)!.name}> is never closed`);
  if (!root) throw new Error('no root element');
  return root;
}
