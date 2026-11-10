import type { ModelRecord } from './types';

const THINKING_DISABLED_MODELS = /\bqwen[-_ ]?3(?:[._-]?8)?[-_ ]?(?:27|28)b\b/i;

export function defaultThinkingMode(model: Pick<ModelRecord, 'id' | 'display_name'> | null | undefined): boolean {
  if (!model) return true;
  return !THINKING_DISABLED_MODELS.test(model.id + ' ' + model.display_name);
}
