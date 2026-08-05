import ts from 'typescript';

type FixtureElement = {
  id?: string;
  className?: string;
  tag: string;
};

const ELEMENT_TAGS: Record<string, string> = {
  HTMLAnchorElement: 'a',
  HTMLAudioElement: 'audio',
  HTMLButtonElement: 'button',
  HTMLCanvasElement: 'canvas',
  HTMLFormElement: 'form',
  HTMLImageElement: 'img',
  HTMLInputElement: 'input',
  HTMLMeterElement: 'meter',
  HTMLOutputElement: 'output',
  HTMLProgressElement: 'progress',
  HTMLSelectElement: 'select',
  HTMLTextAreaElement: 'textarea',
  HTMLVideoElement: 'video',
};

const VOID_TAGS = new Set(['img', 'input']);

/**
 * Builds the smallest useful DOM for importing browser-oriented examples.
 * The inspector does not try to reproduce application markup; it only
 * materializes statically requested elements so top-level wiring can run.
 */
export function createInspectionDocumentHtml(
  fileName: string,
  sourceText: string,
): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const elements = new Map<string, FixtureElement>();
  elements.set('tag:canvas', { tag: 'canvas' });

  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
      return;
    }
    const receiver = node.expression.expression;
    if (!ts.isIdentifier(receiver) || receiver.text !== 'document') return;
    const argument = node.arguments[0];
    if (!argument || !ts.isStringLiteralLike(argument)) return;

    if (node.expression.name.text === 'getElementById') {
      const id = argument.text;
      if (!id) return;
      elements.set(`id:${id}`, {
        id,
        tag: expectedElementTag(node) ?? 'div',
      });
      return;
    }

    if (node.expression.name.text !== 'querySelector') return;
    const selector = argument.text.trim();
    if (selector === 'canvas') {
      elements.set('tag:canvas', { tag: 'canvas' });
      return;
    }
    const idMatch = /^(?:([a-z][\w-]*)\s*)?#([A-Za-z_][\w:.-]*)$/i.exec(selector);
    if (idMatch) {
      const id = idMatch[2]!;
      elements.set(`id:${id}`, {
        id,
        tag: idMatch[1]?.toLowerCase() ?? expectedElementTag(node) ?? 'div',
      });
      return;
    }
    const classMatch = /^\.([A-Za-z_][\w-]*)$/.exec(selector);
    if (classMatch) {
      const className = classMatch[1]!;
      elements.set(`class:${className}`, {
        className,
        tag: expectedElementTag(node) ?? 'div',
      });
    }
  });

  if ([...elements.values()].some((element) => element.tag === 'canvas' && element.id)) {
    elements.delete('tag:canvas');
  }
  return [...elements.values()].map(renderFixtureElement).join('');
}

function expectedElementTag(node: ts.CallExpression): string | undefined {
  const genericType = node.typeArguments?.[0];
  const genericTag = genericType && tagFromType(genericType);
  if (genericTag) return genericTag;

  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)) {
      const tag = tagFromType(parent.type);
      if (tag) return tag;
    }
    if (ts.isVariableDeclaration(parent)) {
      return parent.type ? tagFromType(parent.type) : undefined;
    }
    if (
      ts.isExpressionStatement(parent) ||
      ts.isStatement(parent) ||
      ts.isSourceFile(parent)
    ) {
      break;
    }
    current = parent;
  }
  return undefined;
}

function tagFromType(type: ts.TypeNode): string | undefined {
  const text = type.getText().replace(/\s+/g, '');
  return ELEMENT_TAGS[text] ?? (text === 'HTMLElement' ? 'div' : undefined);
}

function renderFixtureElement(element: FixtureElement): string {
  const attributes = [
    element.id ? `id="${escapeAttribute(element.id)}"` : undefined,
    element.className ? `class="${escapeAttribute(element.className)}"` : undefined,
    element.tag === 'canvas'
      ? 'width="64" height="64" data-typegpu-inspector-fixture'
      : undefined,
    element.tag === 'button' ? 'type="button"' : undefined,
  ].filter((attribute): attribute is string => Boolean(attribute));
  const opening = `<${element.tag}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`;
  return VOID_TAGS.has(element.tag) ? opening : `${opening}</${element.tag}>`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) {
    return ts.ScriptKind.TSX;
  }
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
