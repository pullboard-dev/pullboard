/** Return Chrome's evaluated value, refusing exceptions so a failed preview cannot look successful. */
export function evaluationValue(response) {
  if (response.exceptionDetails) throw new Error(`Chrome evaluation failed: ${response.exceptionDetails.text}`);
  return response.result?.value;
}
