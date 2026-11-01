// Work-arounds for contract schemas that can't be used as written (see apps/web/CONTRACT_NOTES.md).
//
// RuleCondition in @ledgerline/contracts is a z.discriminatedUnion('field', …) with two members whose
// discriminator is 'amount' (equals and between). Zod 4 throws "Duplicate discriminator value" the first time
// such a union parses anything, so RuleBody and RulesView can't parse. These schemas accept the same shapes
// with a plain union, and the result is typed as the contract type.
import type { RuleBody, RulesView } from '@ledgerline/contracts';
import { z } from 'zod';

const cents = z.number().int();
const id = z.string().min(1).max(80);

const Condition = z.union([
  z.object({ field: z.literal('payee'), op: z.enum(['is', 'contains']), value: z.string().max(120) }),
  z.object({
    field: z.literal('description'),
    op: z.enum(['contains', 'matches']),
    value: z.string().max(200),
  }),
  z.object({ field: z.literal('account'), op: z.literal('is'), value: id }),
  z.object({ field: z.literal('amount'), op: z.literal('equals'), value: cents }),
  z.object({ field: z.literal('amount'), op: z.literal('between'), min: cents, max: cents }),
  z.object({ field: z.literal('direction'), op: z.literal('is'), value: z.enum(['in', 'out']) }),
  z.object({ field: z.literal('provider_category'), op: z.literal('is'), value: z.string().max(80) }),
  z.object({
    field: z.literal('day_of_month'),
    op: z.literal('between'),
    min: z.number().int(),
    max: z.number().int(),
  }),
]);

// Actions have unique discriminators, so the contract's union works; it's restated loosely to keep this file
// independent of the broken one.
const Action = z.looseObject({ type: z.string() });

const RuleBodyShape = z.object({
  id: id.optional(),
  name: z.string().min(1).max(80),
  conditions: z.object({ all: z.array(Condition), any: z.array(z.array(Condition)).optional() }),
  actions: z.array(Action).min(1),
  applyToPending: z.boolean(),
  stopAfter: z.boolean(),
  enabled: z.boolean(),
});

export const RuleBodyLenient = RuleBodyShape as unknown as z.ZodType<RuleBody>;

export const RulesViewLenient = z.object({
  rules: z.array(RuleBodyShape.extend({ id, summary: z.string(), matches90d: z.number().int() })),
}) as unknown as z.ZodType<RulesView>;
