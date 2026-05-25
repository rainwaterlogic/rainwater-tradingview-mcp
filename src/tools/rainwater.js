import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/rainwater.js';

export function registerRainwaterTools(server) {
  server.tool('rainwater_chart_digest', 'Rainwater compact chart context: one fast call for symbol, quote, OHLC summary, study values, Pine levels/zones/labels, and token/speed estimates.', {
    bars: z.coerce.number().optional().describe('Bars to summarize, max 500, default 120. Returns summary plus last 3 bars, not the full series.'),
    study_filter: z.string().optional().describe('Substring to match visible study names. Use this to target Rainwater/OR/session indicators and save tokens.'),
    max_items: z.coerce.number().optional().describe('Max levels, labels, zones, and values per section. Default 8, max 50.'),
    include_drawings: z.coerce.boolean().optional().describe('Include Pine drawing outputs: levels, labels, zones. Default true.'),
    include_tables: z.coerce.boolean().optional().describe('Include Pine table text. Default false because tables can be token-heavy.'),
    include_studies: z.coerce.boolean().optional().describe('Include visible study values from the data window. Default true.'),
  }, async (args) => {
    try { return jsonResult(await core.getChartDigest(args)); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
