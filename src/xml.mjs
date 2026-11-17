// Minimal, dependency-free XML parser for the local ISOXML profile.
// It deliberately supports only elements, attributes and text: no DOCTYPE,
// no internal/external entities, no DTD-driven substitution.

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*\b[^>]*?>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decode(value, location) {
  return value.replace(/&(#x?[0-9a-f]+|[A-Za-z]+);/g, (match, name) => {
    if (name === 'amp') return '&';
    if (name === 'lt') return '<';
    if (name === 'gt') return '>';
    if (name === 'quot') return '"';
    if (name === 'apos') return "'";
    if (/^#\d+$/.test(name)) return String.fromCodePoint(Number(name.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(name)) return String.fromCodePoint(parseInt(name.slice(2), 16));
    throw new Error(`undeclared entity ${match} at ${location}`);
  });
}

function makeNode(name, attributes = {}) {
  return { name, attributes, children: [], text: '' };
}

export function parseXml(raw, origin = 'document') {
  if (typeof raw !== 'string') throw new Error(`xml input for ${origin} must be text`);
  if (/<!(DOCTYPE|ENTITY)/i.test(raw)) {
    throw new Error(`external definitions not supported in ${origin}`);
  }
  const documentRoot = makeNode('#document');
  const stack = [documentRoot];
  let last = 0;
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(raw)) !== null) {
    const text = raw.slice(last, match.index);
    if (text.trim()) stack[stack.length - 1].text += decode(text, origin);
    last = TOKEN.lastIndex;
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    const closing = token[1] === '/';
    const body = closing ? token.slice(2, -1) : token.slice(1, -1);
    const selfClosing = !closing && body.endsWith('/');
    const nameEnd = body.search(/[\s/>]/);
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
    if (closing) {
      const opener = stack.pop();
      if (!opener || opener.name !== name) {
        throw new Error(`unmatched closing tag ${name} in ${origin}`);
      }
      continue;
    }
    const node = makeNode(name);
    const attributeText = nameEnd === -1 ? '' : body.slice(nameEnd + 1, selfClosing ? -1 : undefined);
    let attribute;
    ATTRIBUTE.lastIndex = 0;
    while ((attribute = ATTRIBUTE.exec(attributeText)) !== null) {
      node.attributes[attribute[1]] = decode(attribute[2] ?? attribute[3] ?? '', `${origin}@${name}`);
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  const tail = raw.slice(last);
  if (tail.trim()) throw new Error(`content outside the root element in ${origin}`);
  if (stack.length !== 1) {
    throw new Error(`unclosed element ${stack[stack.length - 1].name} in ${origin}`);
  }
  const elements = documentRoot.children;
  if (elements.length !== 1) throw new Error(`expected one root element in ${origin}`);
  return elements[0];
}

export function children(node, name) {
  return node.children.filter(child => child.name === name);
}

export function child(node, name) {
  return node.children.find(child => child.name === name) ?? null;
}
