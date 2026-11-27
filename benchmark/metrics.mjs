const fraction = (count, denominator) => ({ count, denominator, rate: denominator ? count / denominator : null });

export function summarize(rows) {
  const faults = rows.filter(row => row.truth === 'fault');
  const clean = rows.filter(row => row.truth === 'clean');
  const byFamily = {};
  for (const family of new Set(faults.map(row => row.family))) {
    const population = faults.filter(row => row.family === family);
    byFamily[family] = fraction(population.filter(row => row.actualVerdict === 'red').length, population.length);
  }
  return {
    falseGreen: fraction(faults.filter(row => row.actualVerdict === 'green').length, faults.length),
    falseRed: fraction(clean.filter(row => row.actualVerdict === 'red').length, clean.length),
    unverifiable: fraction(rows.filter(row => row.actualVerdict === 'unverifiable').length, rows.length),
    needsHuman: fraction(rows.filter(row => row.actualVerdict === 'needs-human').length, rows.length),
    knownLimitations: rows.filter(row => row.truth === 'limitation').length,
    byFamily,
  };
}

export function metricRows(summary) {
  const totals = ['falseGreen', 'falseRed', 'unverifiable', 'needsHuman'].map(metric => ({
    metric,
    family: '',
    ...summary[metric],
  }));
  return [
    ...totals,
    { metric: 'knownLimitations', family: '', count: summary.knownLimitations, denominator: null, rate: null },
    ...Object.entries(summary.byFamily).map(([family, value]) => ({ metric: 'detection', family, ...value })),
  ];
}
