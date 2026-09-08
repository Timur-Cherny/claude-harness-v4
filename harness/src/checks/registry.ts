// Реестр проверок — владелец списка (К5). Проверка без записи здесь не запускается.
import type { Checker } from './types.ts';

export const CHECKERS: Checker[] = [];

export function registerChecker(c: Checker): void {
  if (CHECKERS.some((x) => x.name === c.name)) throw new Error(`проверка ${c.name} зарегистрирована дважды`);
  CHECKERS.push(c);
}
