import { TranslationError } from './translation';

export interface BudgetSetting { enabled: boolean; limit: number }
export interface BudgetSettings { deepseek: BudgetSetting; ollama: BudgetSetting }
export interface BudgetSnapshot { enabled: boolean; limit: number; used: number; inFlight: number }
export interface TabBudget extends BudgetSnapshot { documentId: string; configuredLimit: number }

export function parseBudgetSettings(raw: unknown): BudgetSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<BudgetSettings> : {};
  const parse = (setting?: BudgetSetting): BudgetSetting => ({
    enabled: typeof setting?.enabled === 'boolean' ? setting.enabled : true,
    limit: Number.isSafeInteger(setting?.limit) && setting!.limit > 0 ? setting!.limit : 30_000
  });
  return { deepseek: parse(value.deepseek), ollama: parse(value.ollama) };
}

export function validateBudgetSettings(raw: unknown): BudgetSettings {
  if (!raw || typeof raw !== 'object') throw new TranslationError('页面预算设置无效', 'config');
  for (const provider of ['deepseek', 'ollama'] as const) {
    const setting = (raw as BudgetSettings)[provider];
    if (!setting || typeof setting.enabled !== 'boolean' || !Number.isSafeInteger(setting.limit) || setting.limit <= 0) {
      throw new TranslationError('页面预算必须填写正整数 token 上限', 'config');
    }
  }
  return parseBudgetSettings(raw);
}

export function currentBudget(raw: Partial<TabBudget> | undefined, documentId: string, setting: BudgetSetting): TabBudget {
  if (raw?.documentId !== documentId || !Number.isSafeInteger(raw.used) || raw.used! < 0 ||
      !Number.isSafeInteger(raw.inFlight) || raw.inFlight! < 0 || !Number.isSafeInteger(raw.limit) || raw.limit! <= 0) {
    return { documentId, used: 0, inFlight: 0, limit: setting.limit, enabled: setting.enabled, configuredLimit: setting.limit };
  }
  const previousEnabled = raw.enabled ?? true;
  const previousLimit = raw.configuredLimit ?? 30_000;
  return {
    documentId, used: raw.used!, inFlight: raw.inFlight!, enabled: setting.enabled, configuredLimit: setting.limit,
    limit: previousEnabled !== setting.enabled || previousLimit !== setting.limit ? setting.limit : raw.limit!
  };
}

export function snapshot(budget: TabBudget): BudgetSnapshot {
  return { enabled: budget.enabled, limit: budget.limit, used: budget.used, inFlight: budget.inFlight };
}
