export function parseProjectTaskInput(input: string): { projectKey: string | null; text: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/^@([a-z0-9][a-z0-9_-]{1,48})\s+([\s\S]+)$/i);

  if (!match) {
    return { projectKey: null, text: trimmed };
  }

  return {
    projectKey: match[1].toLowerCase(),
    text: match[2].trim()
  };
}
