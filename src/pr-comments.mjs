function buildRemediationOutcomeCommentBody(job) {
  const stopCode = job?.remediationPlan?.stop?.code || null;
  const riskClass = job?.riskClass || 'medium';
  const roundBudget = Number(
    job?.remediationPlan?.stop?.maxRounds
      || job?.remediationPlan?.maxRounds
      || job?.recommendedFollowUpAction?.maxRounds
      || 1
  );
  const currentRound = Number(job?.remediationPlan?.currentRound || 0);

  if (stopCode === 'round-budget-exhausted') {
    return [
      '**Outcome:** stopped (`round-budget-exhausted`)',
      '',
      `This PR exhausted the ${riskClass} risk-class remediation budget (${roundBudget} round${roundBudget === 1 ? '' : 's'}).`,
      `Completed remediation rounds: ${currentRound}.`,
      'Operator next step: review the completed remediation rounds and either merge as-is or reopen the underlying spec and justify a higher risk class before requesting more remediation.',
    ].join('\n');
  }

  if (stopCode === 'max-rounds-reached') {
    return [
      '**Outcome:** stopped (`max-rounds-reached`)',
      '',
      `This remediation loop reached its configured max rounds cap (${currentRound}/${roundBudget}).`,
      'Operator next step: review the prior rounds and decide whether the PR is ready for manual handling.',
    ].join('\n');
  }

  return [
    `**Outcome:** ${job?.status || 'unknown'}`,
    '',
    job?.remediationPlan?.stop?.reason || 'No remediation outcome details were recorded.',
  ].join('\n');
}

export {
  buildRemediationOutcomeCommentBody,
};
