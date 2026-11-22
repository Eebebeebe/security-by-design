import { z } from 'zod';
import { ValidationError } from '../errors.js';

/**
 * Alle Eingaben von außen werden hier beschrieben (Allowlist-Prinzip):
 *  - strictObject: unbekannte Felder => Fehler (verhindert Mass Assignment, z.B. "price" im Bestellkörper)
 *  - harte Längen- und Wertebereiche (DoS, DB-Constraints)
 *  - Regex nur mit festen Quantoren (kein ReDoS)
 * Die Handler rufen parse() als ALLERERSTES auf (Fail Fast) – vor jedem DB-Zugriff.
 */

const id = z.coerce.number().int().positive().max(2_147_483_647);
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    // Steuerzeichen raus (Log-Injection / kaputte Ausgaben), Unicode-Buchstaben erlaubt.
    .regex(/^[^\p{Cc}]*$/u, 'Steuerzeichen sind nicht erlaubt');

export const categorySchema = z.enum(['pizza', 'drink', 'dessert']);
export const orderStatusSchema = z.enum([
  'received',
  'baking',
  'delivering',
  'delivered',
  'cancelled',
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

// ---------- öffentlich ----------
export const productListQuery = z.strictObject({
  category: categorySchema.optional(),
  q: text(1, 50).optional(),
});

export const idParam = z.strictObject({ id });
export const uuidParam = z.strictObject({ id: z.uuid() });

export const orderTokenHeader = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Ungültiges Token-Format');

export const createOrderBody = z.strictObject({
  items: z
    .array(
      z.strictObject({
        productId: id,
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .min(1)
    .max(20)
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: 'Jedes Produkt darf nur einmal vorkommen',
    }),
  customer: z.strictObject({
    name: text(2, 80),
    street: text(3, 120),
    zip: z.string().regex(/^\d{5}$/, 'PLZ muss 5 Ziffern haben'),
    city: text(2, 80),
    phone: z.string().regex(/^\+?[0-9 ]{6,20}$/, 'Ungültige Telefonnummer'),
  }),
});
export type CreateOrderInput = z.infer<typeof createOrderBody>;

// ---------- admin ----------
export const loginBody = z.strictObject({
  username: z.string().min(1).max(40),
  password: z.string().min(1).max(200),
});

const priceCents = z.number().int().min(1).max(100_000);

export const createProductBody = z.strictObject({
  name: text(2, 80),
  description: text(0, 500).default(''),
  category: categorySchema,
  priceCents,
  stock: z.number().int().min(0).max(100_000).default(0),
  active: z.boolean().default(true),
});
export type CreateProductInput = z.infer<typeof createProductBody>;

export const updateProductBody = z
  .strictObject({
    name: text(2, 80),
    description: text(0, 500),
    category: categorySchema,
    priceCents,
    active: z.boolean(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, { message: 'Mindestens ein Feld angeben' });
export type UpdateProductInput = z.infer<typeof updateProductBody>;

export const stockBody = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('set'), value: z.number().int().min(0).max(100_000) }),
  z.strictObject({ mode: z.literal('adjust'), value: z.number().int().min(-100_000).max(100_000) }),
]);
export type StockInput = z.infer<typeof stockBody>;

export const orderStatusBody = z.strictObject({ status: orderStatusSchema });

export const adminOrdersQuery = z.strictObject({
  status: orderStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Parst Eingaben oder wirft einen ValidationError ohne die Eingabewerte zu spiegeln. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
