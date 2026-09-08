// PreToolUse(Workflow): два гейта над одним TS-AST скрипта воркфлоу (порт hooks/workflow-friction-gate.sh и
// Workflow-ветки hooks/model-gate.sh). Измерено 24.08: секция «Трение» у workflow-агентов 25% против 100% у
// Agent-субагентов — контракт работает только там, где его требует промпт. Каждый статический вызов agent()
// обязан доказуемо требовать «Трение»/friction в первом аргументе (литерал, const-идентификатор, статичная часть
// шаблона, конкатенация литералов) либо передавать schema с полем properties.friction; что не доказано — deny.
// Свойство model в opts (в т.ч. через переменную, shorthand, spread) — deny: субагент наследует модель родителя.
// Комментарии и слова вроде frictionless не участвуют: разбор по AST, не по тексту (К1). Regex здесь — только по
// естественному тексту prompt'а (слово «трение»/«friction» целиком). Нет TypeScript / не разобран / scriptPath не
// читается → unknown. Kill-switch читает роутер: CLAUDE_SKIP_FRICTION_GATE и CLAUDE_SKIP_MODEL_GATE.
import { readFileSync } from 'node:fs';
import { register } from './registry.ts';
import { loadTypescript, parseSource, lineOf, type TsModule } from '../parsers/ts.ts';
import type { Gate, GateContext, Verdict } from '../types.ts';
import type * as TS from 'typescript';

export const NAME = 'workflow-friction-gate';
export const MODEL_NAME = 'workflow-model-gate';

const FRICTION_WORD = /(?<![\p{L}\p{N}_-])(?:трение|friction)(?![\p{L}\p{N}_-])/iu;
const MAX_RESOLVE_DEPTH = 8;

export interface AgentCall {
  line: number;
  promptProven: boolean;      // статичный текст найден и содержит слово
  promptStatic: boolean;      // первый аргумент вообще сводится к тексту
  schema: 'none' | 'friction' | 'unproven';
  model: boolean;
}

type Script = { text: string; near: string | null } | { skip: true } | { unknown: string };

function scriptOf(ctx: GateContext): Script {
  const p = ctx.payload;
  if (!('tool_name' in p) || p.tool_name !== 'Workflow') return { skip: true };
  const input = (p.tool_input ?? {}) as Record<string, unknown>;
  if (typeof input.script === 'string' && input.script.length) return { text: input.script, near: p.cwd || null };
  if (typeof input.scriptPath === 'string' && input.scriptPath) {
    try { return { text: readFileSync(input.scriptPath, 'utf8'), near: input.scriptPath }; }
    catch (e) { return { unknown: `scriptPath не читается: ${(e as Error).message.split('\n')[0]}` }; }
  }
  return { skip: true };
}

class Resolver {
  private readonly decls = new Map<string, TS.Expression | null>();
  private readonly ts: TsModule;
  constructor(ts: TsModule, sf: TS.SourceFile) {
    this.ts = ts;
    const visit = (n: TS.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
        const name = n.name.text;
        // Два объявления одного имени — неоднозначно, не доказуемо.
        this.decls.set(name, this.decls.has(name) ? null : (n.initializer ?? null));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }

  private unwrap(e: TS.Expression, depth: number): TS.Expression | null {
    const ts = this.ts;
    let cur: TS.Expression | null = e;
    for (let i = 0; cur && i < MAX_RESOLVE_DEPTH - depth; i++) {
      if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur) || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(cur))) cur = (cur as TS.ParenthesizedExpression).expression;
      else if (ts.isIdentifier(cur)) cur = this.decls.get(cur.text) ?? null;
      else return cur;
    }
    return null;
  }

  /** Статичный текст выражения; interpolated=true, если часть текста динамическая. null — не сводится к тексту. */
  text(e: TS.Expression, depth = 0): { value: string; interpolated: boolean } | null {
    const ts = this.ts; const node = this.unwrap(e, depth);
    if (!node || depth > MAX_RESOLVE_DEPTH) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { value: node.text, interpolated: false };
    if (ts.isTemplateExpression(node)) return { value: [node.head.text, ...node.templateSpans.map((s) => ` ${s.literal.text}`)].join(''), interpolated: true };
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.text(node.left, depth + 1); const r = this.text(node.right, depth + 1);
      if (!l || !r) return null;
      return { value: `${l.value}${r.value}`, interpolated: l.interpolated || r.interpolated };
    }
    return null;
  }

  object(e: TS.Expression, depth = 0): TS.ObjectLiteralExpression | null {
    const node = this.unwrap(e, depth);
    return node && this.ts.isObjectLiteralExpression(node) ? node : null;
  }

  /** Свойство объекта по имени с раскрытием spread-ов через переменные. null — не найдено (или объект недоказуем). */
  property(obj: TS.ObjectLiteralExpression, name: string, depth = 0): TS.ObjectLiteralElementLike | null {
    const ts = this.ts;
    if (depth > MAX_RESOLVE_DEPTH) return null;
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        const inner = this.object(p.expression, depth + 1);
        const found = inner ? this.property(inner, name, depth + 1) : null;
        if (found) return found;
        continue;
      }
      const n = p.name;
      if (!n) continue;
      if ((ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === name) return p;
    }
    return null;
  }

  valueOf(p: TS.ObjectLiteralElementLike): TS.Expression | null {
    const ts = this.ts;
    if (ts.isPropertyAssignment(p)) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p)) return p.name;
    return null;
  }
}

function isAgentCallee(ts: TsModule, e: TS.Expression): boolean {
  if (ts.isIdentifier(e)) return e.text === 'agent';
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'agent';
  return false;
}

export function analyzeAgentCalls(ts: TsModule, sf: TS.SourceFile): AgentCall[] {
  const res = new Resolver(ts, sf); const out: AgentCall[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n) && isAgentCallee(ts, n.expression)) {
      const [a0, a1] = n.arguments;
      const prompt = a0 ? res.text(a0) : null;
      let schema: AgentCall['schema'] = 'none'; let model = false;
      const opts = a1 ? res.object(a1) : null;
      if (opts) {
        const sp = res.property(opts, 'schema');
        if (sp) {
          const sv = res.valueOf(sp); const so = sv ? res.object(sv) : null;
          const props = so ? res.property(so, 'properties') : null;
          const pv = props ? res.valueOf(props) : null; const po = pv ? res.object(pv) : null;
          schema = po && res.property(po, 'friction') ? 'friction' : 'unproven';
        }
        model = res.property(opts, 'model') !== null;
      }
      out.push({ line: lineOf(sf, n.getStart(sf)), promptStatic: prompt !== null, promptProven: prompt !== null && FRICTION_WORD.test(prompt.value), schema, model });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

type Analysis = { calls: AgentCall[] } | { verdict: Verdict };

function analyze(ctx: GateContext, gate: string): Analysis {
  const s = scriptOf(ctx);
  if ('skip' in s) return { verdict: { kind: 'silent' } };
  if ('unknown' in s) return { verdict: { kind: 'unknown', reason: s.unknown, gate } };
  const loaded = loadTypescript(s.near, ctx.env);
  if (!loaded.ts) return { verdict: { kind: 'unknown', reason: loaded.missing_reason, gate } };
  const { sf, errors } = parseSource(loaded.ts, s.text, 'workflow-script.ts');
  if (errors.length) return { verdict: { kind: 'unknown', reason: `скрипт не разобран: ${errors.join('; ')}`, gate } };
  return { calls: analyzeAgentCalls(loaded.ts, sf) };
}

const FRICTION_ADVICE = 'скрипт спавнит агентов, но не каждый промпт требует секцию «Трение» — так workflow-агенты выпадают из контура (замер 24.08: 25% секций против 100% у Agent-субагентов). Текстовым агентам добавь в промпт хвост: «Заверши отчёт секцией ## Трение: с чем столкнулся · как обошёл · что осталось в коде (тест/констрейнт/хук — или честное \'ничего\')». Агентам со schema добавь в схему поле friction (type: string, то же содержание). Разовый обход: CLAUDE_SKIP_FRICTION_GATE=1.';

export function decideFriction(ctx: GateContext): Verdict {
  const a = analyze(ctx, NAME);
  if ('verdict' in a) return a.verdict;
  const bad = a.calls.filter((c) => !(c.promptProven || c.schema === 'friction'));
  if (!bad.length) return { kind: 'silent' };
  const lines = bad.map((c) => {
    if (!c.promptStatic && c.schema === 'none') return `L${c.line}: prompt динамический, контракт «Трение» не доказан`;
    if (c.schema === 'unproven') return `L${c.line}: schema без доказуемого поля properties.friction${c.promptStatic ? ' и prompt без «Трение»' : ''}`;
    return `L${c.line}: prompt не требует «Трение»`;
  });
  return { kind: 'deny', gate: NAME, reason: `${lines.join('; ')}. ${FRICTION_ADVICE}` };
}

export function decideModel(ctx: GateContext): Verdict {
  const a = analyze(ctx, MODEL_NAME);
  if ('verdict' in a) return a.verdict;
  const hits = a.calls.filter((c) => c.model);
  if (!hits.length) return { kind: 'silent' };
  return {
    kind: 'deny', gate: MODEL_NAME,
    reason: `явная модель субагента запрещена (${hits.map((c) => `L${c.line}: opts.model`).join('; ')}). Убери model — субагент обязан наследовать модель родителя. Если override действительно нужен, сначала измени сам контракт и его тест.`,
  };
}

const frictionGate: Gate = { name: NAME, events: ['pre-agent'], killSwitch: 'CLAUDE_SKIP_FRICTION_GATE', run: decideFriction };
const modelGate: Gate = { name: MODEL_NAME, events: ['pre-agent'], killSwitch: 'CLAUDE_SKIP_MODEL_GATE', run: decideModel };
register(frictionGate);
register(modelGate);
