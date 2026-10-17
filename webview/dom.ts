/**
 * Tiny DOM helpers. The webview deliberately avoids a UI framework: the bundle
 * stays small, there is no build-time framework magic and no runtime CSS
 * injection that would conflict with the strict content security policy.
 */

export type Child = Node | string | null | undefined | false;

export interface ElementAttributes {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  role?: string;
  tabIndex?: number;
  disabled?: boolean;
  checked?: boolean;
  /** `name` groups radios, and is also used by form elements in general. */
  name?: string;
  selected?: boolean;
  draggable?: boolean;
  hidden?: boolean;
  colSpan?: number;
  span?: number;
  ariaLabel?: string;
  /** `for` on a label, spelled out because `for` is a reserved word. */
  htmlFor?: string;
  style?: string;
  dataset?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: ElementAttributes = {},
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttributes(node, attributes);
  append(node, children);
  return node;
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number> = {},
  children: Child[] = []
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

function applyAttributes(node: HTMLElement, attributes: ElementAttributes): void {
  if (attributes.class) {
    node.className = attributes.class;
  }
  if (attributes.id) {
    node.id = attributes.id;
  }
  if (attributes.title !== undefined) {
    node.title = attributes.title;
  }
  if (attributes.type && 'type' in node) {
    (node as HTMLInputElement).type = attributes.type;
  }
  if (attributes.value !== undefined && 'value' in node) {
    (node as HTMLInputElement).value = attributes.value;
  }
  if (attributes.placeholder && 'placeholder' in node) {
    (node as HTMLInputElement).placeholder = attributes.placeholder;
  }
  if (attributes.role) {
    node.setAttribute('role', attributes.role);
  }
  if (attributes.tabIndex !== undefined) {
    node.tabIndex = attributes.tabIndex;
  }
  if (attributes.disabled !== undefined && 'disabled' in node) {
    (node as HTMLButtonElement).disabled = attributes.disabled;
  }
  if (attributes.checked !== undefined && 'checked' in node) {
    (node as HTMLInputElement).checked = attributes.checked;
  }
  if (attributes.name !== undefined) {
    node.setAttribute('name', attributes.name);
  }
  if (attributes.selected !== undefined && 'selected' in node) {
    (node as HTMLOptionElement).selected = attributes.selected;
  }
  if (attributes.draggable !== undefined) {
    node.draggable = attributes.draggable;
  }
  if (attributes.hidden) {
    node.hidden = true;
  }
  if (attributes.colSpan !== undefined && 'colSpan' in node) {
    (node as HTMLTableCellElement).colSpan = attributes.colSpan;
  }
  if (attributes.span !== undefined && 'span' in node) {
    (node as HTMLTableColElement).span = attributes.span;
  }
  if (attributes.ariaLabel) {
    node.setAttribute('aria-label', attributes.ariaLabel);
  }
  if (attributes.htmlFor && node instanceof HTMLLabelElement) {
    node.htmlFor = attributes.htmlFor;
  }
  if (attributes.style) {
    node.setAttribute('style', attributes.style);
  }
  if (attributes.dataset) {
    for (const [key, value] of Object.entries(attributes.dataset)) {
      node.dataset[key] = value;
    }
  }
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export type IconName =
  | 'refresh'
  | 'filter'
  | 'search'
  | 'table'
  | 'export'
  | 'chart'
  | 'settings'
  | 'close'
  | 'chevronRight'
  | 'chevronDown'
  | 'sortAsc'
  | 'sortDesc'
  | 'columns'
  | 'pin'
  | 'copy'
  | 'info'
  | 'warning'
  | 'error'
  | 'check'
  | 'funnel'
  | 'panel';

const ICON_PATHS: Record<IconName, string> = {
  refresh: 'M8 2.5a5.5 5.5 0 1 0 5.2 3.7l-1.4.5A4 4 0 1 1 8 4v1.8L10.8 3 8 .2V2.5z',
  filter: 'M1.5 2h13l-5 6v5.2l-3 1.3V8L1.5 2z',
  search: 'M10.3 9.2a4.1 4.1 0 1 0-1.1 1.1l3.2 3.2 1.1-1.1-3.2-3.2zM7.1 9.6a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z',
  table:
    'M1.5 2.5h13v11h-13v-11zm1.5 1.5v2h4V4H3zm5.5 0v2h4V4H8.5zM3 7.5v2h4v-2H3zm5.5 0v2h4v-2H8.5zM3 11v1.5h4V11H3zm5.5 0v1.5h4V11H8.5z',
  export: 'M8 1.5l3.5 3.5h-2.4v4.3H6.9V5H4.5L8 1.5zM2 11h2v2h8v-2h2v3.5H2V11z',
  chart: 'M2 13.5V2h1.5v10H14v1.5H2zm3-2.5V7h1.6v4H5zm3.2 0V4.5h1.6v6.5H8.2zm3.2 0V6h1.6v5h-1.6z',
  settings:
    'M8 5.2A2.8 2.8 0 1 0 8 10.8 2.8 2.8 0 0 0 8 5.2zm0 1.5a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6zM7 1.2h2l.3 1.7.9.4 1.5-.9 1.4 1.4-.9 1.5.4.9 1.7.3v2l-1.7.3-.4.9.9 1.5-1.4 1.4-1.5-.9-.9.4-.3 1.7H7l-.3-1.7-.9-.4-1.5.9-1.4-1.4.9-1.5-.4-.9L1.7 9V7l1.7-.3.4-.9-.9-1.5 1.4-1.4 1.5.9.9-.4L7 1.2z',
  close:
    'M3.4 2.3l4.6 4.6 4.6-4.6 1.1 1.1L9.1 8l4.6 4.6-1.1 1.1L8 9.1l-4.6 4.6-1.1-1.1L6.9 8 2.3 3.4l1.1-1.1z',
  chevronRight: 'M6 3.5L10.5 8 6 12.5 4.9 11.4 8.3 8 4.9 4.6 6 3.5z',
  chevronDown: 'M3.5 6L8 10.5 12.5 6l-1.1-1.1L8 8.3 4.6 4.9 3.5 6z',
  sortAsc: 'M8 3l4 5H4l4-5z',
  sortDesc: 'M8 13L4 8h8l-4 5z',
  columns: 'M1.5 2.5h13v11h-13v-11zm1.5 1.5v8h3V4H3zm4.5 0v8h6V4H7.5z',
  pin: 'M9.5 1.5l5 5-1.4 1.4-.9-.2-2.4 2.4.2 2.2-1.1 1.1-3-3-2.9 2.9-1-1 2.9-2.9-3-3L2.9 5l2.2.2 2.4-2.4-.2-.9L9.5 1.5z',
  copy: 'M5.5 1.5h8v8h-1.5V3H5.5V1.5zM2.5 4.5h8v10h-8v-10zm1.5 1.5v7h5v-7H4z',
  info: 'M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5zM7.2 6.5h1.6v5H7.2v-5zm0-2.5h1.6v1.6H7.2V4z',
  warning: 'M8 1.5l6.5 12h-13l6.5-12zm-.8 4.5v4h1.6V6H7.2zm0 5v1.5h1.6V11H7.2z',
  error: 'M8 1.5A6.5 6.5 0 1 0 8 14.5 6.5 6.5 0 0 0 8 1.5zM7.2 4h1.6v5.5H7.2V4zm0 6.5h1.6V12H7.2v-1.5z',
  check: 'M6.2 11.4L2.6 7.8l1.1-1.1 2.5 2.5 5.9-5.9 1.1 1.1-7 7z',
  funnel: 'M2.5 3h11l-4.2 4.8v4.4l-2.6 1.2V7.8L2.5 3z',
  panel:
    'M2.6 1.5h10.8c.6 0 1.1.5 1.1 1.1v10.8c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1V2.6c0-.6.5-1.1 1.1-1.1zm.4 1.5v10h6.5V3H3zm8 0v10h2.5V3H11z',
};

/** Creates an inline SVG icon from the bundled path set. */
export function icon(name: IconName, size = 16): SVGElement {
  const node = svg('svg', {
    class: 'icon',
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': 'true',
    focusable: 'false'
  });
  node.appendChild(svg('path', { d: ICON_PATHS[name], fill: 'currentColor' }));
  return node;
}

/** Formats an integer with thousands separators. */
export function formatCount(value: number): string {
  return value.toLocaleString();
}
