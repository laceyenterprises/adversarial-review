const PROGRESS_TIMEOUT_REASON_PREFIX = 'no output for';
// Distinct prefix so a first-output kill is never mistaken for the rolling
// no-output kill. 'no first output for' does not start with 'no output for',
// so the two startsWith() checks stay unambiguous.
const FIRST_OUTPUT_TIMEOUT_REASON_PREFIX = 'no first output for';

export {
  PROGRESS_TIMEOUT_REASON_PREFIX,
  FIRST_OUTPUT_TIMEOUT_REASON_PREFIX,
};
