// Routes /api requests to the in-memory MockDb, validating bodies with the shared contracts like the Worker.
import {
  ArchiveRequest,
  AssignRequest,
  CategorizeRequest,
  CategoryUpsert,
  CSRF_HEADER,
  GroupUpsert,
  LinkExchange,
  LinkTokenRequest,
  MatchRequest,
  MergePayees,
  MoveRequest,
  NewTxnRequest,
  NoteRequest,
  OwedAction,
  PendingCheckAction,
  RenameAccount,
  RenamePayee,
  SetAssignedRequest,
  SettingsPatch,
  SetupStart,
  StartingBalances,
  TargetRequest,
  TransferPick,
  TxnPatch,
  UsageBatch,
  ImportCsvRequest,
  RuleBody,
  type MutationResult,
} from '@ledgerline/contracts';
import type { z } from 'zod';
import { MockDb, MockHttpError, type Scenario, type Txn } from './db';

export interface MockResponse {
  status: number;
  body: unknown;
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success)
    throw new MockHttpError(400, 'bad_request', r.error.issues[0]?.message ?? 'Invalid request');
  return r.data;
}

export class MockServer {
  db: MockDb;
  /** Every mutation request's headers, for tests that check the CSRF header. */
  lastMutationHeaders: Record<string, string> | null = null;

  constructor(scenario: Scenario = 'default') {
    this.db = new MockDb(scenario);
  }

  reset(scenario: Scenario = 'default') {
    this.db = new MockDb(scenario);
  }

  private ok(): MutationResult {
    return { ok: true, rta: this.db.rta, rtaUpdating: false };
  }

  handle(method: string, url: string, headers: Record<string, string>, body: unknown): MockResponse {
    try {
      const u = new URL(url, 'http://mock.local');
      const path = u.pathname.replace(/\/+$/, '');
      const p = path.split('/').slice(2).map(decodeURIComponent); // drop '' and 'api'
      const mutation = method !== 'GET';
      if (this.db.scenario === 'resting' && p[0] !== 'session' && p[0] !== 'auth')
        throw new MockHttpError(503, 'resting', 'Resting until the daily limit resets');
      if (mutation) {
        this.lastMutationHeaders = headers;
        if (headers[CSRF_HEADER] !== '1' || !(headers['content-type'] ?? '').startsWith('application/json'))
          throw new MockHttpError(403, 'csrf', 'Missing CSRF header');
        if (this.db.writeState === 'readonly' && p[0] !== 'usage' && p[0] !== 'notes')
          throw new MockHttpError(503, 'read_only', 'Writes are paused until the daily limit resets');
      }
      const r = this.route(method, p, u.searchParams, body ?? {});
      return { status: r === null ? 204 : 200, body: r };
    } catch (e) {
      if (e instanceof MockHttpError)
        return { status: e.status, body: { error: e.code, message: e.message } };
      return { status: 500, body: { error: 'internal', message: e instanceof Error ? e.message : 'error' } };
    }
  }

  private route(method: string, p: string[], q: URLSearchParams, body: unknown): unknown {
    const db = this.db;
    const [a, b, c, d] = p;
    const key = `${method} ${a ?? ''}${b !== undefined ? '/' + (isParam(a, b) ? ':x' : b) : ''}${c !== undefined ? '/' + (isParam2(a, c) ? ':y' : c) : ''}${d !== undefined ? '/' + d : ''}`;
    switch (key) {
      case 'GET session':
        return db.session();
      case 'GET badges': {
        const a = db.accounts();
        return {
          activity: db.activity('attention', '').attentionCount,
          accounts: a.repairs.length + a.failures.length,
          rta: db.rta,
          rtaUpdating: false,
        };
      }
      case 'GET budget/:x':
        return db.budget(b!);
      case 'GET budget/:x/assign':
        return db.assignView(b!);
      case 'POST budget/assign': {
        const r = parse(AssignRequest, body);
        for (const it of r.items) db.addAssigned(it.categoryId, it.amount);
        return this.ok();
      }
      case 'POST budget/set': {
        const r = parse(SetAssignedRequest, body);
        const cat = db.catById(r.categoryId);
        if (!cat) throw new MockHttpError(404, 'not_found', 'No such category');
        db.addAssigned(r.categoryId, r.assigned - cat.assigned);
        return this.ok();
      }
      case 'POST budget/move': {
        const r = parse(MoveRequest, body);
        db.move(r.from, r.to, r.amount);
        return this.ok();
      }
      case 'GET categories/:x/sheet':
        return db.categorySheet(b!, q.get('month') ?? db.currentMonth);
      case 'PUT categories/:x/target': {
        const r = parse(TargetRequest, body);
        db.setTarget(b!, r.target);
        return this.ok();
      }
      case 'GET activity': {
        const f = q.get('filter');
        return db.activity(f === 'attention' || f === 'pending' ? f : 'all', q.get('q') ?? '');
      }
      case 'GET transactions/:x':
        return db.txnSheet(b!);
      case 'PATCH transactions/:x': {
        const r = parse(TxnPatch, body);
        const x = db.txn(b!);
        if (r.categoryId !== undefined || r.toRta) db.categorize([x.key], r.categoryId ?? null, r.toRta);
        if (r.memo !== undefined) x.memo = r.memo;
        if (r.wontClear !== undefined) x.wontClear = r.wontClear;
        if (r.payeeName) x.payee = r.payeeName;
        if (r.budgetMonth !== undefined) x.budgetMonth = r.budgetMonth ?? undefined;
        // Estimates (bank pending) and amounts (added by you) are signed like the transaction.
        const next =
          r.amount ??
          (r.estimatedAmount !== undefined && r.estimatedAmount !== null ? r.estimatedAmount : null);
        if (next !== null) {
          const diff = next - x.amount;
          const cat = x.categoryId ? db.catById(x.categoryId) : undefined;
          if (cat) {
            cat.available += diff;
            cat.spent -= diff;
          }
          x.amount = next;
          if (r.amount === undefined) x.estimate = Math.abs(next);
        }
        if (r.split) {
          if (x.categoryId) db.categorize([x.key], null);
          x.split = r.split
            .filter((s) => s.categoryId)
            .map((s) => ({ categoryId: s.categoryId!, amount: s.amount }));
          for (const s of x.split) {
            const cat = db.catById(s.categoryId);
            if (cat) {
              cat.available += s.amount;
              cat.spent -= s.amount;
            }
          }
          x.label = 'Split · ' + x.split.map((s) => db.catName(s.categoryId)).join(' · ');
          if (x.section === 'needs') x.section = 'posted';
        }
        return this.ok();
      }
      case 'POST transactions/categorize': {
        const r = parse(CategorizeRequest, body);
        db.categorize(r.keys, r.categoryId, r.toRta);
        return this.ok();
      }
      case 'POST transactions': {
        const r = parse(NewTxnRequest, body);
        const k = db.newId('t');
        const x: Txn = {
          key: k,
          payee: r.payee,
          rawName: 'Added by you',
          accountId: r.accountId,
          date: r.date,
          amount: r.amount,
          status: r.kind === 'pending' ? 'pending' : 'upcoming',
          wontClear: false,
          categoryId: null,
          label: r.repeats === 'never' ? null : r.repeats,
          badge: r.kind === 'pending' ? 'Added by you' : null,
          badgeKind: r.kind === 'pending' ? 'mine' : null,
          sub: r.kind === 'pending' ? 'added by you' : null,
          sheet: 'txn',
          kind: r.kind === 'pending' ? 'manual' : 'upcoming',
          section: r.kind === 'pending' ? 'pending' : 'upcoming',
        };
        db.txns.push(x);
        if ((r.categoryId || r.toRta) && r.kind === 'pending') db.categorize([k], r.categoryId, r.toRta);
        else x.categoryId = r.categoryId;
        return this.ok();
      }
      case 'POST transactions/:x/review': {
        const x = db.txn(b!);
        if (x.section === 'check' && x.checkAction === 'dismiss') {
          x.section = x.status === 'pending' ? 'pending' : 'posted';
          x.badge = null;
          x.badgeKind = null;
          x.sub = null;
        }
        return this.ok();
      }
      case 'POST transactions/:x/pending': {
        const r = parse(PendingCheckAction, body);
        const x = db.txn(b!);
        // As on the server, only an entry you added has an expected row to keep waiting on or delete.
        if (x.kind !== 'manual' && x.kind !== 'upcoming')
          throw new MockHttpError(404, 'not_found', 'expected transaction');
        if (r.action === 'delete') {
          if (x.categoryId) db.categorize([x.key], null);
          x.hidden = true;
          if (x.key === 'check') db.checkDeleted = true;
        } else {
          x.section = x.status === 'pending' ? 'pending' : 'posted';
          x.badge = x.status === 'pending' ? 'Added by you' : null;
          x.badgeKind = x.status === 'pending' ? 'mine' : null;
          x.sub = x.status === 'pending' ? 'added by you' : null;
          if (x.key === 'check') x.hidden = false;
        }
        return this.ok();
      }
      case 'DELETE transactions/:x': {
        const x = db.txn(b!);
        if (x.categoryId) db.categorize([x.key], null);
        x.hidden = true;
        return this.ok();
      }
      case 'GET match/:x':
        return db.matchView(b!);
      case 'POST match': {
        const r = parse(MatchRequest, body);
        const x = db.txn(r.inflowKey);
        const matched = r.items.reduce((s, it) => s + it.amount, 0);
        if (matched > x.amount) throw new MockHttpError(400, 'too_much', 'More than the deposit');
        for (const it of r.items) {
          const o = db.owed.find((y) => y.id === it.itemId);
          if (!o) continue;
          o.amount -= it.amount;
          o.matched += it.amount;
          if (o.amount <= 0) o.status = 'paid_back';
        }
        const rest = x.amount - matched;
        db.rta += matched + (r.rest === 'income' ? rest : 0);
        if (rest > 0 && r.rest !== 'income') {
          x.amount = rest;
          x.badge = 'Waiting to match';
        } else {
          x.section = 'posted';
          x.label = 'Ready to Assign';
          x.badge = matched > 0 ? 'Paid back' : 'Income';
          x.badgeKind = 'match';
          x.sub = matched > 0 ? 'paid back' : 'income';
          x.sheet = 'txn';
          x.kind = matched > 0 ? 'paidBack' : 'income';
        }
        return this.ok();
      }
      case 'POST match/:x/unlink': {
        const x = db.txn(b!);
        const rent = db.owed.find((o) => o.id === 'rent');
        if (x.key === 'zelle' && rent) {
          rent.amount += 100000;
          rent.matched -= 100000;
          rent.status = 'open';
        }
        db.rta -= x.amount;
        x.section = 'match';
        x.label = 'not in Ready to Assign';
        x.badge = 'Waiting to match';
        x.badgeKind = 'match';
        x.sub = 'held';
        x.sheet = 'match';
        return this.ok();
      }
      case 'POST transfers/:x/pick': {
        const r = parse(TransferPick, body);
        const x = db.txn(b!);
        if (r.otherKey === null) {
          db.rta += 40000;
          for (const k of ['marcus-200', 'ally-200']) db.txn(k).label = 'Ready to Assign · income';
          x.section = 'needs';
          x.sheet = 'txn';
          x.badge = null;
          x.badgeKind = null;
          x.label = null;
          x.sub = null;
        } else {
          db.rta += 20000;
          x.section = 'posted';
          x.sheet = 'txn';
          x.badge = 'Transfer';
          x.badgeKind = 'rule';
          x.label = r.otherKey === 'marcus-200' ? 'to Marcus Savings' : 'to Ally Savings';
          x.sub = 'transfer';
          const other = db.txn(r.otherKey);
          other.label = 'Transfer from Everyday Checking';
          other.badge = 'Transfer';
          other.kind = 'transfer';
          const income = db.txn(r.otherKey === 'marcus-200' ? 'ally-200' : 'marcus-200');
          income.label = 'Ready to Assign · income';
        }
        return this.ok();
      }
      case 'POST transfers/:x/unpair': {
        const x = db.txn(b!);
        x.section = 'needs';
        x.badge = null;
        x.badgeKind = null;
        x.label = null;
        x.kind = 'posted';
        return this.ok();
      }
      case 'GET owed':
        return db.owedView();
      case 'POST owed/:x': {
        const r = parse(OwedAction, body);
        const o = db.owed.find((y) => y.id === b);
        if (!o) throw new MockHttpError(404, 'not_found', 'No such item');
        if (r.action === 'snooze') {
          o.status = 'open';
          o.expectBy = r.expectBy ?? '2026-11-30';
        } else {
          const cat = db.catById(o.categoryId);
          if (cat) {
            cat.available -= o.amount;
            cat.spent += o.amount;
          }
          db.rta += o.amount;
          o.status = r.action === 'close' ? 'closed' : 'canceled';
        }
        return this.ok();
      }
      case 'GET accounts':
        return db.accounts();
      case 'POST accounts/:x/name': {
        db.accountNames.set(b!, parse(RenameAccount, body).name);
        return this.ok();
      }
      case 'GET accounts/:x/register': {
        const show = q.get('show');
        return db.register(b!, show === 'pending' || show === 'needs' || show === 'transfers' ? show : 'all');
      }
      case 'GET reports':
        return db.reports(q.get('month') ?? db.currentMonth);
      case 'GET settings/categories':
        return db.categoriesView();
      case 'POST settings/categories': {
        const r = parse(CategoryUpsert, body);
        const g = (r.groupId ?? 'g-everyday').replace('g-', '') as 'bills' | 'everyday' | 'savings';
        if (r.id) {
          const c = db.catById(r.id);
          if (!c) throw new MockHttpError(404, 'not_found', 'No such category');
          c.name = r.name;
          c.group = g;
          c.kind = r.kind;
          return { ok: true, id: c.id };
        }
        const id = db.newId('c');
        db.cats.push({
          id,
          name: r.name,
          group: ['bills', 'everyday', 'savings'].includes(g) ? g : 'everyday',
          kind: r.kind,
          assigned: 0,
          spent: 0,
          available: 0,
          refill: null,
          bill: g === 'bills',
          invest: r.kind === 'saving',
          noTarget: true,
          reached: false,
          need: null,
          added: 0,
          goal: null,
          baseDetail: 'No target yet',
          overNote: null,
          carry: null,
          target: { type: 'none' },
          targetText: 'No target',
          archived: false,
        });
        return { ok: true, id };
      }
      case 'POST settings/groups': {
        parse(GroupUpsert, body);
        return { ok: true, id: db.newId('g') };
      }
      case 'POST settings/categories/:y/archive': {
        const r = parse(ArchiveRequest, body);
        const cat = db.catById(c!);
        if (!cat) throw new MockHttpError(404, 'not_found', 'No such category');
        if (r.archived && cat.available !== 0) {
          db.rta += cat.available;
          cat.assigned -= cat.available;
          cat.available = 0;
        }
        cat.archived = r.archived;
        cat.archivedMeta = 'Archived today';
        return this.ok();
      }
      case 'POST settings/categories/reorder':
      case 'POST settings/groups/reorder':
        return { ok: true };
      case 'POST settings/categories/:y/remove': {
        const cat = db.catById(c!);
        if (!cat) throw new MockHttpError(404, 'not_found', 'No such category');
        if (cat.available !== 0) {
          db.rta += cat.available;
          cat.assigned -= cat.available;
          cat.available = 0;
        }
        cat.archived = true;
        cat.archivedMeta = 'Archived today';
        return { ok: true, outcome: 'archived' };
      }
      case 'POST settings/groups/:y/remove':
        throw new MockHttpError(409, 'not_empty', 'Move or remove the categories in this group first.');
      case 'GET settings/rules':
        return db.rulesView();
      case 'POST settings/rules': {
        const r = parse(RuleBody, body);
        if (r.id) {
          const existing = db.rules.find((x) => x.id === r.id);
          if (existing) {
            existing.body = { ...r, id: r.id };
            return { ok: true, id: r.id };
          }
        }
        const id = db.newId('r');
        const payee = r.conditions.all.find((x) => x.field === 'payee');
        const act = r.actions.find((x) => x.type === 'set_category');
        db.rules.push({
          id,
          body: { ...r, id },
          summary: `${payee && 'value' in payee ? `Payee is ${payee.value}` : r.name} → ${act && act.type === 'set_category' ? (db.catName(act.categoryId) ?? '') : 'Review'}`,
          matches90d: 1,
        });
        return { ok: true, id };
      }
      case 'POST settings/rules/preview': {
        const r = parse(RuleBody, body);
        const payee = r.conditions.all.find((x) => x.field === 'payee');
        const val = payee && 'value' in payee ? String(payee.value).toLowerCase() : '';
        const matches = db.txns
          .filter((x) => val && x.payee.toLowerCase().includes(val))
          .map((x) => db.row(x));
        return { matches, uncategorizedMatches: matches.filter((m) => m.categoryLabel === null).length };
      }
      case 'POST settings/rules/:y/apply':
        return this.ok();
      case 'DELETE settings/rules/:y': {
        db.rules = db.rules.filter((x) => x.id !== c);
        return { ok: true };
      }
      case 'GET settings/payees':
        return db.payeesView();
      case 'POST settings/payees/merge': {
        parse(MergePayees, body);
        db.merged = true;
        return { ok: true };
      }
      case 'POST settings/payees/:y': {
        parse(RenamePayee, body);
        return { ok: true };
      }
      // Sign-in (decisions.md D-27): the mock is always signed in with one passkey.
      case 'GET auth/status':
        return { signedIn: true, hasPasskey: true, setupOpen: false };
      case 'GET settings/security':
        return {
          passkeys: [
            {
              id: 'pk_mock',
              name: 'iPhone',
              createdAt: '2026-10-31T18:00:00Z',
              lastUsedAt: '2026-11-14T08:00:00Z',
            },
          ],
          sessions: mockSignIns.length,
          otherSessions: mockSignIns.filter((x) => !x.current).length,
          signIns: mockSignIns,
        };
      case 'POST settings/security/device-link':
        return { url: `${location.origin}/add-device#mock-token`, expiresAt: '2026-11-14T20:10:00Z' };
      case 'POST settings/security/sign-out':
        return { ok: true };
      case 'POST settings/security/sign-out-others':
        mockSignIns = mockSignIns.filter((x) => x.current);
        return { ok: true };
      case 'POST settings/security/sign-out-session':
        mockSignIns = mockSignIns.filter((x) => x.current || x.id !== (body as { id?: string }).id);
        return { ok: true };
      case 'GET settings/connections':
        return db.connectionsView();
      case 'POST settings/connections/link-token': {
        const r = parse(LinkTokenRequest, body);
        return { linkToken: `link-sandbox-mock-${r.mode}` };
      }
      case 'POST settings/connections/exchange': {
        parse(LinkExchange, body);
        db.linked += 1;
        return { ok: true, connectionId: db.newId('c'), accounts: [] };
      }
      case 'POST settings/connections/refresh':
        db.refreshedAt = (db.refreshedAt ?? Date.UTC(2026, 10, 14, 17, 42)) + 60_000;
        return { ok: true, started: 2 };
      case 'POST settings/connections/:y/refresh': {
        if (c === 'c-ally') db.allyRepaired = true;
        if (c === 'c-chase') db.syncFailed = false;
        return { ok: true };
      }
      case 'POST setup/start': {
        parse(SetupStart, body);
        db.setupStep = 'link';
        return { ok: true };
      }
      case 'POST setup/starting-balances': {
        parse(StartingBalances, body);
        db.setupStep = 'done';
        return this.ok();
      }
      case 'PATCH settings': {
        const r = parse(SettingsPatch, body);
        if (r.tracking !== undefined) db.tracking = r.tracking;
        if (r.noteButton !== undefined) db.noteButton = r.noteButton;
        return { ok: true };
      }
      case 'POST import/csv': {
        parse(ImportCsvRequest, body);
        return { imported: 4812, skipped: 214, history: 4812 };
      }
      case 'POST usage': {
        const r = parse(UsageBatch, body);
        db.usageEvents.push(...r.events);
        return null;
      }
      case 'POST notes': {
        db.notes.push(parse(NoteRequest, body));
        return { ok: true };
      }
      default:
        throw new MockHttpError(404, 'not_found', `No mock for ${method} /api/${p.join('/')}`);
    }
  }
}

/** Second path segment is an id for these resources. */
function isParam(a: string | undefined, b: string): boolean {
  if (a === 'budget') return b !== 'assign' && b !== 'set' && b !== 'move';
  if (a === 'transactions') return b !== 'categorize';
  if (a === 'match' || a === 'categories' || a === 'owed' || a === 'accounts' || a === 'transfers')
    return true;
  return false;
}

/** Settings → Sign-in in the mock: this phone and a laptop. */
let mockSignIns = [
  { id: 'si_phone', name: 'iPhone · Home Screen app', signedInAt: '2026-11-14T08:00:00Z', current: true },
  { id: 'si_mac', name: 'Mac · Safari', signedInAt: '2026-11-13T21:30:00Z', current: false },
  {
    id: 'si_ipad',
    name: 'iPad',
    signedInAt: '2026-11-12T19:00:00Z',
    current: false,
    saved: true,
    locked: true,
  },
];

/** Third path segment is an id under /settings/{categories,rules,payees,connections}. */
function isParam2(a: string | undefined, c: string): boolean {
  if (a !== 'settings') return false;
  return ![
    'merge',
    'preview',
    'export',
    'reorder',
    'link-token',
    'exchange',
    'device-link',
    'sign-out',
    'sign-out-others',
    'sign-out-session',
    'refresh',
  ].includes(c);
}
