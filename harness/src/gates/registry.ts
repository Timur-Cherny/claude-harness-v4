// Реестр гейтов — единственный владелец (К5): гейт без записи здесь не вызывается.
// Каждый гейт обязан иметь фикстуры deny[]/allow[]/unknown[] и kill-switch — держит test/meta/registry.test.ts.
import type { Gate } from '../types.ts';

export const GATES: Gate[] = [];

export function register(gate: Gate): void {
  if (GATES.some((g) => g.name === gate.name)) throw new Error(`гейт ${gate.name} зарегистрирован дважды`);
  GATES.push(gate);
}
