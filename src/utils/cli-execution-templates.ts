export type CliOutputFormat = 'json' | 'text';

export function buildWorkspaceConstrainedPrompt(
  prompt: string,
  workspace: string,
  outputFormat: CliOutputFormat
): string {
  const outputInstructions =
    outputFormat === 'json'
      ? `
## OUTPUT FORMAT
Always output your response as JSON with the following structure:
{
  "success": true/false,
  "content": "Your response text",
  "files_modified": ["list of file paths you created or modified"],
  "tools_used": ["bash", "glob", "write", "edit", "grep", "view"],
  "error": "error message if any"
}`
      : `
## OUTPUT FORMAT
Output your response directly without JSON wrapping for this CLI tool.`;

  return `
## WORKSPACE CONSTRAINT
You MUST only modify files within the directory: ${workspace}
Do NOT access or modify any files outside this directory.

## TASK
${prompt}
${outputInstructions}
    `.trim();
}

export function buildCliCommandArgs(
  command: string,
  argsTemplate: string[],
  model: string,
  prompt: string
): { command: string; args: string[] } {
  const args = argsTemplate.map((arg) => {
    if (arg === '{prompt}') {
      return prompt;
    }
    if (arg === '{model}') {
      return model;
    }
    return arg;
  });

  return { command, args };
}
