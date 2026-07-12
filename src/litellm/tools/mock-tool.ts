/**
 * ================================================
 * Mock Tool Templates
 * ================================================
 *
 * These are reference templates for adding new tools.
 * Copy one, rename the class, fill in the blanks.
 *
 * ── To add a new tool ──
 * 1. Copy the relevant template below into a new file in this directory
 *    (or define it anywhere — tools are self-contained).
 * 2. Rename the class and set `name`, `description`, `parameters`.
 * 3. Implement `execute()`.
 * 4. Register it:
 *      client.tools.register(new MyTool());
 *    Or register ad-hoc without a class:
 *      client.tools.registerAdHoc('my_tool', 'desc', params, handler);
 *
 * That's it — tools are isolated, no other files to touch.
 */

import { BaseTool, objectParam, stringParam, numberParam } from './tool-interface';

/* ═══════════════════════════════════════════════════════════
 * Template A: Simple Tool
 *
 * A minimal tool with required string + optional number params.
 * This tool is referenced by MyToolMethod in mock-method.ts.
 * ═══════════════════════════════════════════════════════════ */

export class WeatherTool extends BaseTool {
  /** Unique tool name — the LLM sees this */
  readonly name = 'get_weather';

  /** Description — helps the LLM decide when to call this tool */
  readonly description = 'Get current weather for a city';

  /** JSON Schema for parameters — the LLM will fill these */
  readonly parameters = objectParam(
    {
      city: stringParam('City name (e.g. "Berlin", "Tokyo")'),
      units: {
        type: 'string',
        enum: ['celsius', 'fahrenheit'],
        description: 'Temperature unit (default: celsius)',
      },
    },
    ['city'], // only city is required; units is optional
  );

  async execute(args: Record<string, unknown>): Promise<string> {
    const city = String(args.city);
    const units = (args.units as string) ?? 'celsius';
    // Replace with real API call
    return JSON.stringify({ city, temperature: 22, units, condition: 'sunny' });
  }
}

/* ═══════════════════════════════════════════════════════════
 * Template B: Database / Stateful Tool
 *
 * A tool that depends on external state (DB connection, API client, etc.).
 * Pass dependencies through the constructor.
 * ═══════════════════════════════════════════════════════════ */

export class DatabaseQueryTool extends BaseTool {
  readonly name = 'query_database';
  readonly description = 'Run a read-only SQL query against the database';
  readonly parameters = objectParam(
    {
      sql: stringParam('SQL SELECT query to execute'),
      limit: numberParam('Maximum rows to return (default: 10)'),
    },
    ['sql'],
  );

  constructor(private readonly db: { query: (sql: string, limit: number) => Promise<unknown[]> }) {
    super();
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const sql = String(args.sql);
    const limit = typeof args.limit === 'number' ? args.limit : 10;

    if (!sql.trim().toLowerCase().startsWith('select')) {
      return JSON.stringify({ error: 'Only SELECT queries are allowed' });
    }

    // Replace with real DB query
    const rows = await this.db.query(sql, limit);
    return JSON.stringify({ rows, count: rows.length });
  }
}

/* ═══════════════════════════════════════════════════════════
 * Template C: Ad-hoc Tool (no class needed)
 *
 * For quick tools that don't need a class, use registerAdHoc.
 * Best for prototyping or one-off tools.
 * ═══════════════════════════════════════════════════════════ */

export function createAdHocTools() {
  // Returns a tool definition ready for registration — no class needed.
  // Register with: client.tools.registerAdHoc('calculator', '...', params, handler);
  return {
    name: 'calculator',
    description: 'Evaluate a mathematical expression',
    parameters: objectParam({ expression: stringParam('Math expression (e.g. "2 + 3 * 4")') }, [
      'expression',
    ]),
    handler: (args: Record<string, unknown>): string => {
      try {
        // ⚠️ eval is dangerous — replace with a proper math parser in production
        const result = eval(String(args.expression));
        return JSON.stringify({ expression: args.expression, result });
      } catch {
        return JSON.stringify({ error: 'Invalid expression' });
      }
    },
  };
}
