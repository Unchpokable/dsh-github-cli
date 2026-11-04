/**
 * Shared renderers for operation-based tools.
 *
 * A plan is shown as a compact checklist; an applied result is shown as a
 * summary, key facts, warnings, and next steps. Domain renderers can call these
 * and append fields specific to their resource.
 */

import { countLabel } from '../result.js';

/** Render a plan without dumping its internal API payloads. */
export function renderPlan(plan) {
  const lines = [
    `${plan.summary}`,
    `risk: ${plan.risk}${plan.irreversible ? ' · irreversible' : ''}`,
  ];
  if (plan.repo) lines.push(`repo: ${plan.repo}`);
  if (Array.isArray(plan.effects) && plan.effects.length > 0) {
    lines.push('', 'effects:');
    for (const effect of plan.effects) lines.push(`- ${effect}`);
  }
  if (plan.confirm) lines.push('', `confirm: ${plan.confirm}`);
  if (Array.isArray(plan.warnings) && plan.warnings.length > 0) {
    lines.push('', 'warnings:');
    for (const warning of plan.warnings) lines.push(`- ${warning}`);
  }
  if (Array.isArray(plan.next) && plan.next.length > 0) {
    lines.push('', 'next:');
    for (const step of plan.next) lines.push(`- ${step.tool}: ${step.reason}`);
  }
  return lines.join('\n');
}

function renderNext(next) {
  if (!Array.isArray(next) || next.length === 0) return [];
  const lines = ['', 'next:'];
  for (const step of next) lines.push(`- ${step.tool}: ${step.reason}`);
  return lines;
}

/**
 * Render an applied operation. Domain-specific fields belong in `summary` and
 * `data`, so the common renderer stays stable.
 */
export function renderApplied(value) {
  const lines = [value.summary];
  if (value.repo) lines.push(`repo: ${value.repo}`);
  if (value.url) lines.push(value.url);

  const data = value.data;
  if (data && Array.isArray(data.items)) {
    const total = Number.isFinite(data.total) ? data.total : data.items.length;
    lines.push(`${countLabel(data.items.length, 'item')} shown${Number.isFinite(data.total) ? ` of ${total}` : ''}`);
    for (const item of data.items.slice(0, 50)) {
      if (typeof item === 'string') lines.push(`- ${item}`);
      else if (item && typeof item === 'object') {
        const label = item.full_name ?? item.name ?? item.path ?? item.login ?? item.number ?? item.id;
        const extra = item.html_url ?? item.url ?? '';
        lines.push(`- ${label}${extra ? ` — ${extra}` : ''}`);
      }
    }
    if (data.items.length > 50) lines.push(`- ... ${data.items.length - 50} more`);
  }

  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings) lines.push(`warning: ${warning}`);
  }
  lines.push(...renderNext(value.next));
  return lines.join('\n');
}

/** Render any operation result. */
export function renderValue(value) {
  if (value?.plan) return renderPlan(value.plan);
  return renderApplied(value);
}
