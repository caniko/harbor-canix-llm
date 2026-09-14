// Fixed capture target, never an agent-supplied command. No environment is persisted.
process.stdout.write("\0harbor-canix-llm-v1\0" + JSON.stringify(process.env) + "\0");
