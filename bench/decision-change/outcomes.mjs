// Measurement limits are retained, but never converted to product successes
// or capability failures. Cost records remain the authoritative spending log.
export function applyFlushOutcome(row, result, phase) {
  if (!result) return;
  (row.flushes ||= []).push({ phase, ...result });
  if (result.ok) return;
  row.success = false;
  const accounting = result.accounting || {};
  if (result.isBudgetLimited || accounting.refusals?.length || accounting.records?.some(record => record.capped)) {
    row.budgetLimited = true;
    row.notMeasured = 'Native observer was constrained by the benchmark budget; outcome is ineligible for product comparison';
    row.failure = 'observer-budget-limited';
  } else if (accounting.records?.some(record => record.status === 'unknown')) {
    row.accountingIneligible = true;
    row.notMeasured = 'Native observer accounting is uncertain; paid work halted';
    row.failure = 'observer-accounting-uncertain';
  } else if (result.isSetupFailure) {
    row.setupFailure = true;
    row.notMeasured = 'Native dependency readiness failed or degraded; this is an ineligible setup diagnostic, not a product capability result';
    row.failure = 'native-dependency-setup-failure';
  } else if (!row.failure) row.failure = `product-capture-not-ready:${phase}`;
}

export function finalizeOutcome(row) {
  if (row.stages?.some(stage => stage.budgetLimited)) {
    row.budgetLimited = true;
    row.notMeasured = 'Foreground model reached its benchmark monetary cap; outcome is ineligible for product comparison';
    row.failure = 'foreground-budget-limited';
  }
  if (row.cost?.uncertain || row.stages?.some(stage => stage.unpricedModel)) {
    row.accountingIneligible = true;
    row.notMeasured = 'Cost accounting is uncertain or an unpriced model appeared; comparison is ineligible and spending halted';
  }
  if (row.notMeasured || row.accountingIneligible || row.budgetLimited) row.success = false;
  row.outcomeCategory = row.accountingIneligible ? 'accounting-ineligible' : row.budgetLimited ? 'budget-limited'
    : row.notMeasured ? (/budget/i.test(`${row.failure} ${row.notMeasured}`) ? 'budget-not-measured'
      : row.exposureUnverified ? 'exposure-unverified' : 'setup-not-measured')
      : row.stages?.some(stage => stage.timedOut) ? 'stalled' : row.success ? 'pass' : 'measured-failure';
  return row;
}
