/**
 * Rainwater-specific compact chart context helpers.
 */
import { performance } from 'node:perf_hooks';
import { evaluate } from '../connection.js';

const DEFAULT_BAR_COUNT = 120;
const MAX_BAR_COUNT = 500;
const DEFAULT_MAX_ITEMS = 8;
const MAX_ITEMS = 50;

function clampInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil((text || '').length / 4);
}

export function summarizeBars(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return null;
  }

  const highs = bars.map(b => b.high).filter(Number.isFinite);
  const lows = bars.map(b => b.low).filter(Number.isFinite);
  const volumes = bars.map(b => b.volume || 0).filter(Number.isFinite);
  const first = bars[0];
  const last = bars[bars.length - 1];
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const range = high - low;
  const change = last.close - first.open;

  return {
    count: bars.length,
    from: first.time,
    to: last.time,
    open: first.open,
    close: last.close,
    high,
    low,
    range: Math.round(range * 100) / 100,
    change: Math.round(change * 100) / 100,
    change_pct: Math.round((change / first.open) * 10000) / 100,
    avg_volume: Math.round(volumes.reduce((sum, v) => sum + v, 0) / volumes.length),
    last_bars: bars.slice(-3),
  };
}

export function addUsageMetrics(result, elapsedMs) {
  const base = {
    ...result,
    usage: {
      elapsed_ms: Math.round(elapsedMs),
      output_bytes: 0,
      estimated_tokens: 0,
      replaces_calls: result.drawings ? 7 : 4,
      note: 'Estimate uses roughly 4 characters per token; actual model billing may differ.',
    },
  };
  const text = JSON.stringify(base);
  base.usage.output_bytes = Buffer.byteLength(text, 'utf8');
  base.usage.estimated_tokens = estimateTokens(text);
  return base;
}

export async function getChartDigest({
  bars,
  study_filter,
  max_items,
  include_drawings,
  include_tables,
  include_studies,
} = {}) {
  const startedAt = performance.now();
  const params = {
    bars: clampInt(bars, DEFAULT_BAR_COUNT, MAX_BAR_COUNT),
    studyFilter: study_filter || '',
    maxItems: clampInt(max_items, DEFAULT_MAX_ITEMS, MAX_ITEMS),
    includeDrawings: include_drawings !== false,
    includeTables: include_tables === true,
    includeStudies: include_studies !== false,
  };

  const raw = await evaluate(`
    (function(params) {
      function round(value, places) {
        if (typeof value !== 'number' || !isFinite(value)) return value;
        var pow = Math.pow(10, places || 2);
        return Math.round(value * pow) / pow;
      }

      function compactText(value, maxLen) {
        var text = value == null ? '' : String(value).replace(/\\s+/g, ' ').trim();
        if (text.length > maxLen) return text.slice(0, maxLen - 3) + '...';
        return text;
      }

      function studyName(source) {
        try {
          var meta = source.metaInfo && source.metaInfo();
          return meta ? compactText(meta.description || meta.shortDescription || '', 80) : '';
        } catch(e) {
          return '';
        }
      }

      function wantedStudy(name) {
        return !params.studyFilter || name.indexOf(params.studyFilter) !== -1;
      }

      function summarizeBars(bars) {
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - params.bars + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({
            time: v[0],
            open: v[1],
            high: v[2],
            low: v[3],
            close: v[4],
            volume: v[5] || 0
          });
        }
        if (result.length === 0) return null;
        var first = result[0];
        var last = result[result.length - 1];
        var high = -Infinity;
        var low = Infinity;
        var volume = 0;
        for (var bi = 0; bi < result.length; bi++) {
          high = Math.max(high, result[bi].high);
          low = Math.min(low, result[bi].low);
          volume += result[bi].volume || 0;
        }
        var change = last.close - first.open;
        return {
          count: result.length,
          total_available: typeof bars.size === 'function' ? bars.size() : null,
          from: first.time,
          to: last.time,
          open: first.open,
          close: last.close,
          high: high,
          low: low,
          range: round(high - low, 2),
          change: round(change, 2),
          change_pct: round((change / first.open) * 100, 2),
          avg_volume: Math.round(volume / result.length),
          last_bars: result.slice(-3)
        };
      }

      function collectStudyValues(sources) {
        var studies = [];
        for (var si = 0; si < sources.length; si++) {
          var source = sources[si];
          if (!source.metaInfo) continue;
          var name = studyName(source);
          if (!name || !wantedStudy(name)) continue;
          var values = {};
          try {
            var dataWindow = source.dataWindowView && source.dataWindowView();
            var items = dataWindow && dataWindow.items && dataWindow.items();
            if (items) {
              for (var i = 0; i < items.length && Object.keys(values).length < params.maxItems; i++) {
                var item = items[i];
                if (item && item._title && item._value && item._value !== '∅') {
                  values[compactText(item._title, 30)] = compactText(item._value, 50);
                }
              }
            }
          } catch(e) {}
          if (Object.keys(values).length > 0) studies.push({ name: name, values: values });
        }
        return studies;
      }

      function primitiveItems(source, collectionName, mapKey) {
        var items = [];
        try {
          var graphics = source._graphics;
          var pc = graphics && graphics._primitivesCollection;
          var outer = pc && pc[collectionName];
          var inner = outer && outer.get(mapKey);
          var collection = inner && (inner.get ? inner.get(false) : inner);
          if (!collection && collectionName === 'dwgtablecells') {
            collection = outer && outer.get && outer.get('tableCells');
          }
          var byId = collection && collection._primitivesDataById;
          if (byId && byId.size > 0) {
            byId.forEach(function(raw, id) { items.push({ id: id, raw: raw }); });
          }
        } catch(e) {}
        return items;
      }

      function collectDrawings(sources) {
        var drawings = { levels: [], zones: [], labels: [] };
        if (params.includeTables) drawings.tables = [];

        for (var si = 0; si < sources.length; si++) {
          var source = sources[si];
          if (!source.metaInfo) continue;
          var name = studyName(source);
          if (!name || !wantedStudy(name)) continue;

          var levelSeen = {};
          var lines = primitiveItems(source, 'dwglines', 'lines');
          var levels = [];
          for (var li = 0; li < lines.length; li++) {
            var line = lines[li].raw;
            if (line.y1 != null && line.y1 === line.y2) {
              var price = round(line.y1, 2);
              if (!levelSeen[price]) {
                levelSeen[price] = true;
                levels.push(price);
              }
            }
          }
          if (levels.length > 0) {
            levels.sort(function(a, b) { return b - a; });
            drawings.levels.push({ name: name, prices: levels.slice(0, params.maxItems), total: levels.length });
          }

          var zoneSeen = {};
          var boxes = primitiveItems(source, 'dwgboxes', 'boxes');
          var zones = [];
          for (var zi = 0; zi < boxes.length; zi++) {
            var box = boxes[zi].raw;
            if (box.y1 != null && box.y2 != null) {
              var high = round(Math.max(box.y1, box.y2), 2);
              var low = round(Math.min(box.y1, box.y2), 2);
              var key = high + ':' + low;
              if (!zoneSeen[key]) {
                zoneSeen[key] = true;
                zones.push({ high: high, low: low });
              }
            }
          }
          if (zones.length > 0) {
            zones.sort(function(a, b) { return b.high - a.high; });
            drawings.zones.push({ name: name, zones: zones.slice(0, params.maxItems), total: zones.length });
          }

          var labels = primitiveItems(source, 'dwglabels', 'labels')
            .map(function(item) {
              var label = item.raw;
              return { text: compactText(label.t || '', 80), price: label.y != null ? round(label.y, 2) : null };
            })
            .filter(function(label) { return label.text || label.price != null; });
          if (labels.length > 0) {
            drawings.labels.push({ name: name, labels: labels.slice(-params.maxItems), total: labels.length });
          }

          if (params.includeTables) {
            var rowsByTable = {};
            var cells = primitiveItems(source, 'dwgtablecells', 'tableCells');
            for (var ci = 0; ci < cells.length; ci++) {
              var cell = cells[ci].raw;
              var tableId = cell.tid || 0;
              if (!rowsByTable[tableId]) rowsByTable[tableId] = {};
              if (!rowsByTable[tableId][cell.row]) rowsByTable[tableId][cell.row] = {};
              rowsByTable[tableId][cell.row][cell.col] = compactText(cell.t || '', 40);
            }
            var tableIds = Object.keys(rowsByTable);
            if (tableIds.length > 0) {
              var tables = tableIds.slice(0, params.maxItems).map(function(tableId) {
                var rows = rowsByTable[tableId];
                return Object.keys(rows).map(Number).sort(function(a, b) { return a - b; }).slice(0, params.maxItems).map(function(rowNum) {
                  var cols = rows[rowNum];
                  return Object.keys(cols).map(Number).sort(function(a, b) { return a - b; }).map(function(colNum) {
                    return cols[colNum];
                  }).filter(Boolean).join(' | ');
                }).filter(Boolean);
              });
              drawings.tables.push({ name: name, tables: tables });
            }
          }
        }

        return drawings;
      }

      var started = Date.now();
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var widget = chart._chartWidget;
      var model = widget.model();
      var sources = model.model().dataSources();
      var bars = model.mainSeries().bars();
      var symbolInfo = {};
      try { symbolInfo = chart.symbolExt() || {}; } catch(e) {}
      var allStudies = [];
      try {
        allStudies = chart.getAllStudies().map(function(study) {
          return { id: study.id, name: compactText(study.name || study.title || 'unknown', 80) };
        });
      } catch(e) {}
      var barSummary = summarizeBars(bars);
      var quote = barSummary ? {
        symbol: chart.symbol(),
        last: barSummary.close,
        open: barSummary.last_bars[barSummary.last_bars.length - 1].open,
        high: barSummary.last_bars[barSummary.last_bars.length - 1].high,
        low: barSummary.last_bars[barSummary.last_bars.length - 1].low,
        volume: barSummary.last_bars[barSummary.last_bars.length - 1].volume,
        time: barSummary.to
      } : { symbol: chart.symbol() };
      if (symbolInfo.description) quote.description = compactText(symbolInfo.description, 80);
      if (symbolInfo.exchange) quote.exchange = symbolInfo.exchange;
      if (symbolInfo.type) quote.type = symbolInfo.type;

      var result = {
        success: true,
        tool: 'rainwater_chart_digest',
        params: params,
        chart: {
          symbol: chart.symbol(),
          resolution: chart.resolution(),
          chart_type: chart.chartType(),
          studies: allStudies
        },
        quote: quote,
        bars: barSummary
      };
      if (params.includeStudies) result.study_values = collectStudyValues(sources);
      if (params.includeDrawings) result.drawings = collectDrawings(sources);
      result.browser_elapsed_ms = Date.now() - started;
      return result;
    })(${JSON.stringify(params)})
  `);

  if (!raw || raw.success !== true) {
    throw new Error('Could not build Rainwater chart digest. The chart may still be loading.');
  }

  return addUsageMetrics(raw, performance.now() - startedAt);
}
