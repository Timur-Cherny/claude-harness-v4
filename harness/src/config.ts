// Привязка к площадке жила прямо в исходниках: имя защищённой ветки, имена репозиториев, где действует
// конвенция work-doc, и абсолютный путь вольта под $HOME. Из-за этого контур нельзя было поставить на
// другую машину, не раздав вместе с ним состав чужой организации, а обобщить его — только форком.
//
// INVARIANT: сайт-специфика живёт в конфиге, а не в коде. Конфига нет — контур работает с дженерик-дефолтами
// и молчит там, где поведение бессмысленно без настройки (напоминание о work-doc). Отсутствие конфига — это
// не ошибка и не unknown: это обычная новая машина.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkDocsConfig {
  /** Regex по пути cwd: в каких репозиториях напоминание вообще уместно. */
  cwd: string;
  /** Текст напоминания целиком — конвенция площадки, а не контура. */
  text: string;
}

export interface HarnessConfig {
  /** Ветки, прямой push в которые разрешён только с release/*|hotfix/*. */
  protectedBranches: string[];
  /** Напоминание о work-doc; отсутствует — гейт молчит. */
  workDocs?: WorkDocsConfig;
  /** Путь вольта относительно $HOME, когда явного env нет; отсутствует — дефолтного вольта нет. */
  vaultRel?: string;
}

const DEFAULTS: HarnessConfig = { protectedBranches: ['main'] };

// Процесс живёт один хук, но decide() зовут пачкой в тестах: кэш по разрешённому пути, не глобальный флаг.
const cache = new Map<string, HarnessConfig>();

/** Путь конфига: явный CLAUDE_HARNESS_CONFIG важнее, иначе ~/.claude/harness.config.json. */
export function configPath(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_HARNESS_CONFIG) return env.CLAUDE_HARNESS_CONFIG;
  return env.HOME ? join(env.HOME, '.claude', 'harness.config.json') : null;
}

/**
 * Конфиг площадки. Нет файла, битый JSON, не тот тип поля — молча дефолт: конфиг описывает удобство,
 * и падать из-за него на каждом событии дороже, чем работать обобщённо.
 */
export function loadConfig(env: NodeJS.ProcessEnv): HarnessConfig {
  const path = configPath(env);
  if (!path) return DEFAULTS;
  const hit = cache.get(path);
  if (hit) return hit;
  let cfg: HarnessConfig = DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<HarnessConfig>;
    const branches = Array.isArray(raw.protectedBranches) ? raw.protectedBranches.filter((b) => typeof b === 'string' && b) : null;
    const wd = raw.workDocs;
    cfg = {
      protectedBranches: branches?.length ? branches : DEFAULTS.protectedBranches,
      workDocs: wd && typeof wd.cwd === 'string' && wd.cwd && typeof wd.text === 'string' && wd.text ? { cwd: wd.cwd, text: wd.text } : undefined,
      vaultRel: typeof raw.vaultRel === 'string' && raw.vaultRel ? raw.vaultRel : undefined,
    };
  } catch {
    cfg = DEFAULTS;
  }
  cache.set(path, cfg);
  return cfg;
}

/** Только для тестов: сбросить память о прочитанных конфигах. */
export function resetConfigCache(): void {
  cache.clear();
}
