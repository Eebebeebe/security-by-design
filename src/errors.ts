/**
 * Explizite Fehlerklassen. Jede kennt ihren HTTP-Status, einen stabilen Fehlercode
 * und eine Meldung, die gefahrlos an den Client gehen darf.
 * Alles, was KEIN AppError ist, gilt als unerwartet -> generische 500, Details nur ins Log.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly publicMessage: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(publicMessage);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(issues: { path: string; message: string }[]) {
    super(400, 'VALIDATION_FAILED', 'Die Anfrage ist ungültig.', { issues });
  }
}

export class NotFoundError extends AppError {
  constructor(what = 'Ressource') {
    super(404, 'NOT_FOUND', `${what} nicht gefunden.`);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Anmeldung erforderlich.') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Aktion nicht erlaubt.') {
    super(403, 'FORBIDDEN', message);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(409, code, message, details);
  }
}

export class OutOfStockError extends ConflictError {
  constructor(productIds: number[]) {
    super('OUT_OF_STOCK', 'Nicht genügend Bestand für mindestens ein Produkt.', { productIds });
  }
}
