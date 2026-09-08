// Порядок импорта = порядок реестра. Гейт добавляется здесь и только здесь: модуль,
// который регистрируется, но сюда не попал, роутер не видит, а тесты этого не замечают —
// они импортируют свой модуль напрямую. Держит test/meta/registry.test.ts (reachability).
import '../checks/index.ts';
// pre-* — до вызова инструмента
import './model-gate.ts';
import './workflow.ts';
import './commit-msg.ts';
import './pre-push.ts';
import './pg-session.ts';
import './resource.ts';
import './memory-frontmatter.ts';
import './migration-name.ts';
// post/stop — сверка дерева и её дренаж
import './sweep-gates.ts';
// сессионные модули и телеметрия
import '../session/index.ts';
// Гейт живёт в scripts/ (там же его CLI): модуль сам себя не регистрирует, регистрация — здесь.
import { register as registerGate } from './registry.ts';
import { PREFILTER_GATE } from '../../scripts/friction-prefilter.ts';
registerGate(PREFILTER_GATE);
import '../friction.ts';
import '../telemetry.ts';
