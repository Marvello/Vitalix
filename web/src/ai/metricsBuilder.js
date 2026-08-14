export function calculateDeltas(todayMetrics, yesterdayMetrics) {
  const deltas = {};
  for (const key in todayMetrics) {
    if (typeof todayMetrics[key] === 'number' && typeof yesterdayMetrics[key] === 'number') {
      deltas[key] = todayMetrics[key] - yesterdayMetrics[key];
    }
  }
  return deltas;
}

export function calculateBaseline(pastDaysList) {
  if (!pastDaysList || pastDaysList.length === 0) return {};
  const sums = {};
  const counts = {};

  pastDaysList.forEach((dayData) => {
    for (const key in dayData) {
      if (typeof dayData[key] === 'number') {
        sums[key] = (sums[key] || 0) + dayData[key];
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  });

  const baseline = {};
  for (const key in sums) {
    baseline[key] = Math.round((sums[key] / counts[key]) * 10) / 10;
  }
  return baseline;
}
