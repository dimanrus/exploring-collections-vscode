import type { ColumnDescriptor, ColumnKind } from '../src/model/types';
import type { FilterExpression, ParsedFilter } from '../src/filter/expression';
import { parseFilter, quoteString } from '../src/filter/expression';
import { clear, el, icon } from './dom';

/**
 * The whole collection filter builder.
 *
 * The viewer's own controls (search, per column filters, sorting) only ever see
 * the rows that were fetched. This builder instead produces a condition that is
 * applied to the whole collection: the extension translates it into the debugger's
 * own language when it can (`.Where`, `Seq.filter`, `Array.filter`, a list
 * comprehension), so a truncated collection can be searched beyond its window.
 */

export type FilterOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'startsWith'
  | 'endsWith'
  | 'regex'
  | 'empty'
  | 'notEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'isTrue'
  | 'isFalse'
  | 'isNull'
  | 'isNotNull';

export type FilterCombinator = 'and' | 'or';

/** One row of the builder. */
export interface FilterCondition {
  columnKey: string;
  operator: FilterOperator;
  value: string;
  /** Upper bound of a range. */
  value2: string;
}

export const FILTER_PARAMETER = 'x';

const TEXT_OPERATORS: readonly FilterOperator[] = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'regex',
  'empty',
  'notEmpty'
];

const NUMBER_OPERATORS: readonly FilterOperator[] = [
  'equals',
  'notEquals',
  'gt',
  'gte',
  'lt',
  'lte',
  'between'
];

const BOOLEAN_OPERATORS: readonly FilterOperator[] = ['isTrue', 'isFalse'];

const NULL_OPERATORS: readonly FilterOperator[] = ['isNull', 'isNotNull'];

/** Operators that make sense for a column of the given kind. */
export function operatorsForKind(kind: ColumnKind): FilterOperator[] {
  const common = kind === 'string' ? [] : NULL_OPERATORS;
  if (kind === 'number' || kind === 'date') {
    return [...NUMBER_OPERATORS, ...common];
  }
  if (kind === 'boolean') {
    return [...BOOLEAN_OPERATORS, ...common];
  }
  if (kind === 'object' || kind === 'array' || kind === 'unknown') {
    return [...NULL_OPERATORS];
  }
  return [...TEXT_OPERATORS, ...common];
}

export function defaultOperatorFor(kind: ColumnKind): FilterOperator {
  switch (kind) {
    case 'number':
    case 'date':
      return 'gte';
    case 'boolean':
      return 'isTrue';
    case 'object':
    case 'array':
    case 'unknown':
      return 'isNotNull';
    default:
      return 'contains';
  }
}

/** Operators that need no value at all. */
export function isValueLess(operator: FilterOperator): boolean {
  return (
    operator === 'empty' ||
    operator === 'notEmpty' ||
    operator === 'isNull' ||
    operator === 'isNotNull' ||
    operator === 'isTrue' ||
    operator === 'isFalse'
  );
}

/** Operators that take two values. */
export function isRange(operator: FilterOperator): boolean {
  return operator === 'between';
}

/** Columns the builder can work with, in table order. */
export function filterableColumns(columns: readonly ColumnDescriptor[]): ColumnDescriptor[] {
  return columns.filter((column) => column.key !== '#');
}

export function defaultColumnKey(columns: readonly ColumnDescriptor[]): string {
  const usable = filterableColumns(columns);
  const numeric = usable.find((column) => column.kind === 'number');
  return (usable[0] ?? numeric)?.key ?? '';
}

/**
 * A fresh condition. `afterKey` makes the next row start on the following column,
 * so adding conditions does not keep proposing the same one.
 */
export function createCondition(
  columns: readonly ColumnDescriptor[],
  afterKey?: string
): FilterCondition {
  const usable = filterableColumns(columns);
  const previous = afterKey === undefined ? -1 : usable.findIndex((column) => column.key === afterKey);
  const column = usable[(previous + 1) % Math.max(1, usable.length)] ?? usable[0];
  const kind = column?.kind ?? 'string';
  return {
    columnKey: column?.key ?? '',
    operator: defaultOperatorFor(kind),
    value: '',
    value2: ''
  };
}

/** True when the condition is complete enough to be turned into an expression. */
export function isConditionComplete(condition: FilterCondition): boolean {
  if (condition.columnKey.length === 0) {
    return false;
  }
  if (isValueLess(condition.operator)) {
    return true;
  }
  if (isRange(condition.operator)) {
    return condition.value.trim().length > 0 && condition.value2.trim().length > 0;
  }
  return condition.value.trim().length > 0;
}

/** A number literal for the condition, when the column is numeric. */
function numericLiteral(value: string): string | undefined {
  const cleaned = value.trim().replace(/,/g, '').replace(/[fFdDmMlLuU]+$/, '');
  if (cleaned.length === 0) {
    return undefined;
  }
  const asNumber = Number(cleaned);
  return Number.isFinite(asNumber) ? String(asNumber) : undefined;
}

/** The value part of an expression, quoted unless the column is numeric. */
function valueLiteral(kind: ColumnKind, value: string): string {
  if (kind === 'number' || kind === 'date') {
    const numeric = numericLiteral(value);
    if (numeric !== undefined) {
      return numeric;
    }
  }
  if (kind === 'boolean') {
    return value.trim().toLowerCase() === 'true' ? 'true' : 'false';
  }
  return quoteString(value);
}

/**
 * Turns one condition into a filter expression, or `undefined` while it is still
 * incomplete.
 */
export function buildConditionText(
  column: ColumnDescriptor | undefined,
  condition: FilterCondition
): string | undefined {
  if (!column || !isConditionComplete(condition)) {
    return undefined;
  }
  const target = `${FILTER_PARAMETER}.${column.key}`;
  const kind = column.kind;
  const first = valueLiteral(kind, condition.value);
  const second = valueLiteral(kind, condition.value2);

  switch (condition.operator) {
    case 'contains':
      return `contains(${target}, ${first})`;
    case 'notContains':
      return `!contains(${target}, ${first})`;
    case 'equals':
      return `${target} == ${first}`;
    case 'notEquals':
      return `${target} != ${first}`;
    case 'startsWith':
      return `startswith(${target}, ${first})`;
    case 'endsWith':
      return `endswith(${target}, ${first})`;
    case 'regex':
      return `matches(${target}, ${first})`;
    case 'empty':
      return `isempty(${target})`;
    case 'notEmpty':
      return `!isempty(${target})`;
    case 'gt':
      return `${target} > ${first}`;
    case 'gte':
      return `${target} >= ${first}`;
    case 'lt':
      return `${target} < ${first}`;
    case 'lte':
      return `${target} <= ${first}`;
    case 'between':
      return `${target} >= ${first} && ${target} <= ${second}`;
    case 'isTrue':
      return `${target} == true`;
    case 'isFalse':
      return `${target} == false`;
    case 'isNull':
      return `isnull(${target})`;
    case 'isNotNull':
      return `isnotnull(${target})`;
    default:
      return undefined;
  }
}

/** Builds the filter text of every complete condition. */
export function buildFilterText(
  conditions: readonly FilterCondition[],
  combinator: FilterCombinator,
  columns: readonly ColumnDescriptor[]
): string {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const parts: string[] = [];
  for (const condition of conditions) {
    const text = buildConditionText(byKey.get(condition.columnKey), condition);
    if (text) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return '';
  }
  // A range is two comparisons that must stay together, so it is wrapped.
  const wrapped = parts.map((part) => (part.includes(' && ') ? `(${part})` : part));
  return wrapped.join(combinator === 'and' ? ' && ' : ' || ');
}

/** Reads a condition back out of an expression, when it has a known shape. */
function conditionFromExpression(
  expression: FilterExpression,
  columnKey: string,
  byKey: Map<string, ColumnDescriptor>
): FilterCondition | undefined {
  const column = byKey.get(columnKey);
  if (!column) {
    return undefined;
  }
  if (expression.kind === 'binary') {
    const operator = expression.operator;
    const left = expression.left;
    const right = expression.right;
    // `x.Col >= 5 && x.Col <= 10` is the range the builder produces.
    if (
      operator === '&&' &&
      left.kind === 'binary' &&
      right.kind === 'binary' &&
      left.left.kind === 'member' &&
      right.left.kind === 'member' &&
      left.right.kind === 'literal' &&
      right.right.kind === 'literal'
    ) {
      const low = left.operator === '>=' ? left.right.value : undefined;
      const high = right.operator === '<=' ? right.right.value : undefined;
      if (low !== undefined && high !== undefined) {
        return {
          columnKey,
          operator: 'between',
          value: String(low),
          value2: String(high)
        };
      }
    }
    if (right.kind !== 'literal') {
      return undefined;
    }
    const literal = String(right.value ?? '');
    switch (operator) {
      case '==':
        return { columnKey, operator: 'equals', value: literal, value2: '' };
      case '!=':
        return { columnKey, operator: 'notEquals', value: literal, value2: '' };
      case '>':
        return { columnKey, operator: 'gt', value: literal, value2: '' };
      case '>=':
        return { columnKey, operator: 'gte', value: literal, value2: '' };
      case '<':
        return { columnKey, operator: 'lt', value: literal, value2: '' };
      case '<=':
        return { columnKey, operator: 'lte', value: literal, value2: '' };
      default:
        return undefined;
    }
  }

  const negated = expression.kind === 'unary';
  const inner = negated ? (expression as { operand: FilterExpression }).operand : expression;
  if (inner.kind !== 'call' || inner.args.length === 0) {
    return undefined;
  }
  const name = inner.callee.kind === 'identifier' ? inner.callee.name.toLowerCase() : '';
  const argument = inner.args.length > 1 ? inner.args[1] : undefined;
  const literal = argument && argument.kind === 'literal' ? String(argument.value ?? '') : '';

  const negative = (): FilterCondition => ({
    columnKey,
    operator: negated ? 'notEmpty' : 'empty',
    value: '',
    value2: ''
  });
  switch (name) {
    case 'contains':
      return { columnKey, operator: negated ? 'notContains' : 'contains', value: literal, value2: '' };
    case 'startswith':
      return { columnKey, operator: 'startsWith', value: literal, value2: '' };
    case 'endswith':
      return { columnKey, operator: 'endsWith', value: literal, value2: '' };
    case 'matches':
      return { columnKey, operator: 'regex', value: literal, value2: '' };
    case 'isempty':
      return negative();
    case 'isnull':
      return {
        columnKey,
        operator: negated ? 'isNotNull' : 'isNull',
        value: '',
        value2: ''
      };
    case 'isnotnull':
      return { columnKey, operator: 'isNotNull', value: '', value2: '' };
    default:
      return undefined;
  }
}

function memberPathOf(expression: FilterExpression): string | undefined {
  if (expression.kind === 'member') {
    const object = expression.object;
    if (object.kind === 'identifier' && object.name === FILTER_PARAMETER) {
      return expression.name;
    }
    const prefix = memberPathOf(object);
    return prefix ? `${prefix}.${expression.name}` : undefined;
  }
  if (expression.kind === 'identifier' && expression.name === FILTER_PARAMETER) {
    return '';
  }
  return undefined;
}

export interface ParsedConditions {
  conditions: FilterCondition[];
  combinator: FilterCombinator;
}

/**
 * Reads an existing condition back into the builder, so a filter typed earlier
 * can be edited instead of replaced. Returns `undefined` for anything the builder
 * cannot represent, for example `len(x.Tags) > 2`.
 */
export function conditionsFromText(
  text: string,
  columns: readonly ColumnDescriptor[]
): ParsedConditions | undefined {
  if (text.trim().length === 0) {
    return { conditions: [], combinator: 'and' };
  }
  let parsed: ParsedFilter;
  try {
    parsed = parseFilter(text);
  } catch {
    return undefined;
  }

  const body = parsed.expression.kind === 'lambda' ? parsed.expression.body : parsed.expression;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const conditions: FilterCondition[] = [];
  const combinators = new Set<FilterCombinator>();

  const visit = (expression: FilterExpression): boolean => {
    if (expression.kind === 'binary' && (expression.operator === '&&' || expression.operator === '||')) {
      // A range is `a && b` over the same column, which belongs to one condition.
      const whole = wholeCondition(expression);
      if (whole) {
        conditions.push(whole);
        return true;
      }
      combinators.add(expression.operator === '&&' ? 'and' : 'or');
      return visit(expression.left) && visit(expression.right);
    }
    const single = wholeCondition(expression);
    if (single) {
      conditions.push(single);
      return true;
    }
    return false;
  };

  const wholeCondition = (expression: FilterExpression): FilterCondition | undefined => {
    const key = columnKeyOf(expression);
    return key === undefined ? undefined : conditionFromExpression(expression, key, byKey);
  };

  const columnKeyOf = (expression: FilterExpression): string | undefined => {
    if (expression.kind === 'binary') {
      if (expression.operator === '&&' || expression.operator === '||') {
        // A range compares the same column twice, anything else is a new condition.
        const left = columnKeyOf(expression.left);
        const right = columnKeyOf(expression.right);
        return left !== undefined && left === right ? left : undefined;
      }
      const path = memberPathOf(expression.left);
      return path === undefined || path.length === 0 ? undefined : path;
    }
    if (expression.kind === 'unary') {
      return columnKeyOf(expression.operand);
    }
    if (expression.kind === 'call') {
      const first = expression.args[0];
      const path = first ? memberPathOf(first) : undefined;
      return path === undefined || path.length === 0 ? undefined : path;
    }
    return undefined;
  };

  if (!visit(body)) {
    return undefined;
  }
  if (combinators.size > 1) {
    return undefined;
  }
  return {
    conditions,
    combinator: combinators.has('or') ? 'or' : 'and'
  };
}

/** Strings the builder needs, resolved by the host. */
export interface FilterBuilderStrings {
  title: string;
  addCondition: string;
  removeCondition: string;
  column: string;
  operator: string;
  value: string;
  valueTo: string;
  matchAll: string;
  matchAny: string;
  apply: string;
  clear: string;
  cancel: string;
  wholeCollection: string;
  partialHint: string;
  operators: Record<FilterOperator, string>;
}

export interface FilterBuilderCallbacks {
  onApply(text: string): void;
}

/** Opens the builder popover next to the button that triggered it. */
export function renderFilterBuilder(options: {
  columns: readonly ColumnDescriptor[];
  parsed: ParsedConditions | undefined;
  strings: FilterBuilderStrings;
  callbacks: FilterBuilderCallbacks;
  openPopover(anchor: HTMLElement, content: HTMLElement, width?: number): void;
  closePopovers(): void;
  anchor: HTMLElement;
}): void {
  const { columns, strings, callbacks } = options;
  const usable = filterableColumns(columns);
  const draft = {
    conditions: (options.parsed?.conditions ?? []).map((condition) => ({ ...condition })),
    combinator: options.parsed?.combinator ?? 'and'
  };
  if (draft.conditions.length === 0) {
    draft.conditions.push(createCondition(columns));
  }

  const content = el('div', { class: 'popover-body filter-builder' });
  content.appendChild(el('div', { class: 'popover-title' }, [strings.title]));
  content.appendChild(
    el('div', { class: 'filter-builder-hint' }, [
      icon('info', 12),
      el('span', {}, [strings.wholeCollection])
    ])
  );
  if (strings.partialHint.length > 0) {
    // Said out loud when the previous run could not reach beyond the fetched rows.
    content.appendChild(
      el('div', { class: 'filter-builder-hint is-warning' }, [
        icon('warning', 12),
        el('span', {}, [strings.partialHint])
      ])
    );
  }

  const list = el('div', { class: 'filter-rows' });
  content.appendChild(list);

  // Mutated in place: rebuilding the footer on every keystroke would steal the
  // focus from the field being typed in.
  let previewNode: HTMLElement | undefined;
  let applyButton: HTMLButtonElement | undefined;
  const refreshPreview = (): void => {
    const text = buildFilterText(draft.conditions, draft.combinator, columns);
    if (previewNode) {
      previewNode.textContent = text;
      previewNode.title = text;
      // Nothing to preview until the condition is complete; an empty code box
      // looks like a disabled input, so it stays out of the way instead.
      previewNode.hidden = text.length === 0;
    }
    if (applyButton) {
      applyButton.disabled = text.length === 0;
    }
  };

  const renderRows = (): void => {
    clear(list);
    draft.conditions.forEach((condition, index) => {
      list.appendChild(renderRow(condition, index));
    });
    renderFooter();
  };

  const renderRow = (condition: FilterCondition, index: number): HTMLElement => {
    const row = el('div', { class: 'filter-row' });
    const column = usable.find((candidate) => candidate.key === condition.columnKey);
    const kind = column?.kind ?? 'string';

    const columnSelect = el('select', {
      class: 'filter-select',
      title: strings.column,
      ariaLabel: strings.column
    });
    for (const candidate of usable) {
      columnSelect.appendChild(
        el('option', { value: candidate.key, selected: candidate.key === condition.columnKey }, [
          candidate.title
        ])
      );
    }
    columnSelect.addEventListener('change', () => {
      condition.columnKey = columnSelect.value;
      const next = usable.find((candidate) => candidate.key === condition.columnKey);
      const allowed = operatorsForKind(next?.kind ?? 'string');
      if (!allowed.includes(condition.operator)) {
        condition.operator = defaultOperatorFor(next?.kind ?? 'string');
      }
      renderRows();
    });
    row.appendChild(columnSelect);

    const operatorSelect = el('select', {
      class: 'filter-select',
      title: strings.operator,
      ariaLabel: strings.operator
    });
    for (const operator of operatorsForKind(kind)) {
      operatorSelect.appendChild(
        el('option', { value: operator, selected: operator === condition.operator }, [
          strings.operators[operator]
        ])
      );
    }
    operatorSelect.addEventListener('change', () => {
      condition.operator = operatorSelect.value as FilterOperator;
      renderRows();
    });
    row.appendChild(operatorSelect);

    if (!isValueLess(condition.operator)) {
      const valueInput = el('input', {
        class: 'filter-value',
        type: 'text',
        value: condition.value,
        placeholder: strings.value,
        ariaLabel: strings.value
      });
      valueInput.addEventListener('input', () => {
        condition.value = valueInput.value;
        valueInput.classList.toggle('is-invalid', !isConditionComplete(condition));
        refreshPreview();
      });
      row.appendChild(valueInput);

      if (isRange(condition.operator)) {
        const secondInput = el('input', {
          class: 'filter-value',
          type: 'text',
          value: condition.value2,
          placeholder: strings.valueTo,
          ariaLabel: strings.valueTo
        });
        secondInput.addEventListener('input', () => {
          condition.value2 = secondInput.value;
          secondInput.classList.toggle('is-invalid', !isConditionComplete(condition));
          refreshPreview();
        });
        row.appendChild(secondInput);
      }
    }

    const remove = el('button', {
      class: 'icon-button',
      type: 'button',
      title: strings.removeCondition,
      ariaLabel: strings.removeCondition
    });
    remove.appendChild(icon('close', 12));
    remove.disabled = draft.conditions.length <= 1;
    remove.addEventListener('click', () => {
      draft.conditions.splice(index, 1);
      renderRows();
    });
    row.appendChild(remove);

    return row;
  };

  const footer = el('div', { class: 'filter-builder-footer' });
  const renderFooter = (): void => {
    clear(footer);

    const combinator = el('div', { class: 'radio-row' });
    const group = 'ec-filter-combinator';
    const all = el('input', { type: 'radio', name: group, checked: draft.combinator === 'and' });
    const any = el('input', { type: 'radio', name: group, checked: draft.combinator === 'or' });
    all.addEventListener('change', () => {
      draft.combinator = 'and';
      refreshPreview();
    });
    any.addEventListener('change', () => {
      draft.combinator = 'or';
      refreshPreview();
    });
    combinator.appendChild(el('label', {}, [all, el('span', {}, [strings.matchAll])]));
    combinator.appendChild(el('label', {}, [any, el('span', {}, [strings.matchAny])]));
    footer.appendChild(combinator);

    const add = el('button', { class: 'link-button', type: 'button' }, [`+ ${strings.addCondition}`]);
    add.addEventListener('click', () => {
      const previous = draft.conditions[draft.conditions.length - 1];
      draft.conditions.push(createCondition(columns, previous?.columnKey));
      renderRows();
    });
    footer.appendChild(add);

    previewNode = el('code', { class: 'filter-preview', hidden: true });
    footer.appendChild(previewNode);

    const buttons = el('div', { class: 'popover-buttons' });
    const clearButton = el('button', { class: 'secondary-button', type: 'button' }, [strings.clear]);
    clearButton.addEventListener('click', () => {
      options.closePopovers();
      callbacks.onApply('');
    });
    const cancel = el('button', { class: 'secondary-button', type: 'button' }, [strings.cancel]);
    cancel.addEventListener('click', () => options.closePopovers());
    applyButton = el('button', { class: 'primary-button', type: 'button' }, [strings.apply]);
    applyButton.addEventListener('click', () => {
      const text = buildFilterText(draft.conditions, draft.combinator, columns);
      options.closePopovers();
      callbacks.onApply(text);
    });
    buttons.appendChild(clearButton);
    buttons.appendChild(cancel);
    buttons.appendChild(applyButton);
    footer.appendChild(buttons);
    refreshPreview();
  };

  content.appendChild(footer);
  renderRows();
  options.openPopover(options.anchor, content, 420);
}
