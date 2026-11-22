import { Router } from 'express';
import {
  createOrderBody,
  idParam,
  orderTokenHeader,
  parse,
  productListQuery,
  uuidParam,
} from '../schemas/index.js';
import type { OrderService } from '../services/orderService.js';
import type { ProductService } from '../services/productService.js';

/** Öffentliche Shop-API. Jeder Handler validiert zuerst (Fail Fast), dann erst DB-Zugriff. */
export function shopRouter(products: ProductService, orders: OrderService): Router {
  const r = Router();

  r.get('/products', async (req, res) => {
    const query = parse(productListQuery, req.query);
    res.json({ products: await products.listPublic(query) });
  });

  r.get('/products/:id', async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ product: await products.getPublic(id) });
  });

  r.post('/orders', async (req, res) => {
    const input = parse(createOrderBody, req.body);
    const { order, trackingToken } = await orders.create(input);
    // Fachliches Event – bewusst ohne Name/Adresse/Telefon (Datenminimierung im Log).
    res.locals.log.info(
      {
        event: 'order.created',
        orderId: order.id,
        itemCount: order.items.length,
        totalCents: order.totalCents,
      },
      'order created',
    );
    res.status(201).json({ order, trackingToken });
  });

  // Token im Header statt in der URL: landet so nicht in Browser-History, Proxy- oder Access-Logs.
  r.get('/orders/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const token = parse(orderTokenHeader, req.get('x-order-token'));
    res.json({ order: await orders.getForCustomer(id, token) });
  });

  return r;
}
