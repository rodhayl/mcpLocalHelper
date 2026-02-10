// Utility functions
export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseJSON(input: string): unknown {
  return JSON.parse(input);
}
